/**
 * P4-2e 共斗 Boss / 副本接口。
 *
 * 权威模型（与排期文档 §4 P4-2e 对应，2026-11-08 杰哥拍板口径）：
 *  - **不新增状态域**：共斗态挂房间态（owner key = `roomId`），复用 P4-2b 的
 *    掉线 / 超时 / 托管 / 座位 / quota 三段式；`mode='coop'` 早就在内核里预留。
 *  - **Boss HP 是房间真值**：A/B 并发发意图时 `withRoomLock()` 串行，全员交齐才
 *    `advanceTurn` 一次，Boss HP 只减一次，随后广播 `room.state` 全量快照。
 *  - 战斗过程走 `room.action` / `POST /api/room/:roomId/action` 的既有意图通道，
 *    本模块只负责「建房 / 加入 / 结算写档」，不新开一套回合同步协议。
 *  - 结算：**每个成员档各一次 `commitState()`**，各自 CAS / revision 不互相覆盖；
 *    `coopSettled` 幂等。本阶段**不发奖励**（F09 / F14 待设计），只回写队伍 HP / 异常。
 *  - 客户端只发意图、只收全量快照；伪上报状态字段一律 400。
 *
 * 匹配（MVP）：房主 `POST /api/coop/create` 选 Boss 建房 → 队友 `POST /api/coop/:roomId/join`。
 * 不做随机匹配 / 跨服 / 动态难度（排期「明确不做」）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withRoomLock, withSlotLock, slotLockKey } from '../lib/slotLock';
import { createCoopState } from '../game/coop';
import { getBoss, bossDailyLimit, dayKeyOf } from '../game/boss';
import { rooms, wsRegistry } from './sessionBus';
import { publishRoom } from './room';
import { readSave } from './saveRead';
import { commitState } from './session';
import { digestOf, type AuthorityState } from '../lib/authority';
import { tokenDigest } from '../lib/roomAuth';

export const COOP_INPUT_FORBIDDEN_CODE = 'COOP_INPUT_FORBIDDEN';

const slotSchema = z.coerce.number().int().min(1).max(3).default(1);

const createSchema = z.object({
  bossId: z.string().min(1).max(64),
  slot: slotSchema,
}).strip();
const joinSchema = z.object({ slot: slotSchema }).strip();
const paramsSchema = z.object({ roomId: z.string().min(1).max(96) });

/**
 * 客户端不得上报的字段：Boss HP / 伤害 / 队伍 / 回合 / 结果 / 次数。
 * 与 Boss / 榜单 / 1v1 同一口径：不是静默忽略，而是明确 400。
 * 注意 `bossId` 与 `slot` 是合法入参，不能列进来。
 */
const FORBIDDEN_COOP_FIELDS = [
  'boss', 'hp', 'maxHp', 'damage', 'party', 'coop', 'result', 'winner', 'winnerUserId',
  'turn', 'log', 'quota', 'quotaLimit', 'revision', 'status', 'rewards', 'endReason',
] as const;

function forgedField(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return FORBIDDEN_COOP_FIELDS.find((k) => k in (obj as Record<string, unknown>));
}

type CoopApiResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; reason: string; status: number };

const fail = (code: string, reason: string, status = 400): CoopApiResult<never> => ({
  ok: false, code, reason, status,
});

function bearerOf(req: any): string {
  const raw = req?.headers?.authorization;
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

function connectionOf(userId: string): string | null {
  return wsRegistry.listForUser(userId)[0]?.id ?? null;
}

/** 读某账号某槽位的队伍（活体校验）。返回 null 表示无档 / 队伍不可用。 */
async function readParty(userId: string, slot: number) {
  const row = await readSave(userId, slot);
  if (!row) return null;
  let save: any;
  try {
    save = JSON.parse(row.raw);
  } catch {
    return null;
  }
  const party = Array.isArray(save?.party) ? save.party : [];
  if (party.length === 0) return null;
  if (!party.some((m: any) => m && typeof m.hp === 'number' && m.hp > 0)) return null;
  return { party, row };
}

/**
 * 房间 quota 的隔离键：账号 + 自然日 + Boss。
 * `userId` 是 cuid（25 字符），整键会超过房间内核 `validQuotaKey` 的 64 字符上限，
 * 故只取尾 8 字符作内存 Map 键 —— 它不是权威真值，只用于 quota 三段式的隔离，
 * 真值在房间态与落库存档里（P5-1 迁共享存储时统一改 key，F10）。
 */
function coopQuotaKey(userId: string, bossId: string, now: number): string {
  return `coop:${dayKeyOf(now)}:${bossId}:${userId.slice(-8)}`;
}

/**
 * 房主创建共斗房间：只校验 Boss 与队伍，此刻只有房主一人，
 * 共斗态留到全员 join 后生成（Boss HP 那时才成为房间真值）。
 */
export async function applyCoopCreate(params: {
  userId: string;
  digest: string;
  connectionId: string | null;
  slot: number;
  bossId: string;
  now?: number;
}): Promise<CoopApiResult<{ room: any }>> {
  const now = params.now ?? Date.now();
  const spec = getBoss(params.bossId);
  if (!spec) return fail('COOP_BOSS_UNKNOWN', '未知的共斗目标', 400);
  const party = await readParty(params.userId, params.slot);
  if (!party) return fail('COOP_NO_PARTY', '还没有可用队伍，无法共斗', 404);

  return withSlotLock(slotLockKey(params.userId, params.slot), async () => {
    const roomId = `coop_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    return withRoomLock(roomId, async () => {
      if (!params.digest || !params.connectionId) {
        return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线', 409);
      }
      const res = rooms.create({
        roomId,
        mode: 'coop',
        owner: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
        quotaKey: coopQuotaKey(params.userId, spec.bossId, now),
        quotaLimit: bossDailyLimit(spec),
        coopBossId: spec.bossId,
        now,
      });
      if ('code' in res) return fail(res.code, res.reason, 409);
      publishRoom(res.value);
      return { ok: true, value: { room: rooms.view(res.value, params.userId) } };
    });
  });
}

/** 队友加入：满员后按座位顺序读各自队伍，构造共斗态并挂到房间。 */
export async function applyCoopJoin(params: {
  roomId: string;
  userId: string;
  digest: string;
  connectionId: string | null;
  slot: number;
  now?: number;
}): Promise<CoopApiResult<{ room: any }>> {
  const now = params.now ?? Date.now();
  return withRoomLock(params.roomId, async () => {
    if (!params.digest || !params.connectionId) {
      return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线', 409);
    }
    const res = rooms.join({
      roomId: params.roomId,
      member: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
      now,
    });
    if ('code' in res) return fail(res.code, res.reason, 409);
    let room = res.value;

    if (room.status === 'active' && !room.coop) {
      const spec = getBoss(room.coopBossId);
      if (!spec) {
        rooms.abandon(room.roomId, now, 'boss_unavailable');
        publishRoom(room.roomId);
        return fail('COOP_BOSS_UNKNOWN', '房间选定的共斗目标已失效', 409);
      }
      const ordered = [...room.seats].sort((a, b) => a.seat - b.seat);
      const parties: { userId: string; party: any[] }[] = [];
      for (const seat of ordered) {
        // MVP 各成员都用槽位 1；共斗态按座位顺序建立，N 人通用。
        const p = await readParty(seat.userId, 1);
        if (!p) {
          rooms.abandon(room.roomId, now, 'party_unavailable');
          publishRoom(room.roomId);
          return fail('COOP_NO_PARTY', '一方没有可用队伍，无法共斗', 409);
        }
        parties.push({ userId: seat.userId, party: p.party });
      }
      const state = createCoopState({ spec, parties, rng: Math.random });
      if ('code' in state) {
        rooms.abandon(room.roomId, now, 'party_unavailable');
        publishRoom(room.roomId);
        return fail(state.code, state.reason, 409);
      }
      const attached = rooms.attachCoop(room.roomId, state.value, now);
      if ('code' in attached) return fail(attached.code, attached.reason, 409);
      room = attached.value;
    }
    publishRoom(room);
    return { ok: true, value: { room: rooms.view(room, params.userId) } };
  });
}

/**
 * 结算写各成员档：共斗分出胜负后，把战斗内的队伍 HP / 异常回写各自存档，
 * 每人一次 `commitState()`，revision 各自单调 +1、互不覆盖。
 *
 * **刻意不发奖励**（杰哥 2026-11-08 拍板「延续先例」）：不调
 * `game/settlement.ts::applySettlementToSave()`（那是普通战斗/Boss 的金钱经验首通结算），
 * 否则会绕过 F09 / F14 白送资源。幂等由 `room.coopSettled` 标记保证。
 */
export async function settleCoopRoom(roomId: string): Promise<void> {
  const room = rooms.get(roomId);
  if (!room?.coop || !room.coop.finished) return;
  for (const side of room.coop.sides) {
    const rec = await readSave(side.userId, 1);
    if (!rec) continue;
    await withSlotLock(slotLockKey(side.userId, 1), async () => {
      let save: any;
      try {
        save = JSON.parse(rec.raw);
      } catch {
        return;
      }
      save.party = side.party;
      save.lastSavedAt = new Date().toISOString();
      const raw = JSON.stringify(save);
      const authority: AuthorityState = {
        ...rec.authority,
        expected: digestOf(raw),
        revision: rec.authority.revision + 1,
        pending: null,
      };
      await commitState(side.userId, 1, {
        data: raw,
        schemaVersion: rec.schemaVersion,
        clientId: rec.clientId,
        authority,
        source: 'battle',
      });
    });
  }
}

export async function coopRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  fastify.post('/api/coop/create', guard, async (req: any, reply) => {
    const bad = forgedField(req.body);
    if (bad) {
      return reply.code(400).send({ error: '客户端不得上报共斗状态', code: COOP_INPUT_FORBIDDEN_CODE, fields: [bad] });
    }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '创建参数不合法', code: 'COOP_BAD_REQUEST' });

    const res = await applyCoopCreate({
      userId: req.user.userId,
      digest: tokenDigest(bearerOf(req)),
      connectionId: connectionOf(req.user.userId),
      slot: parsed.data.slot,
      bossId: parsed.data.bossId,
    });
    if ('code' in res) return reply.code(res.status).send({ error: res.reason, code: res.code });
    return reply.send({ ok: true, ...res.value });
  });

  fastify.post('/api/coop/:roomId/join', guard, async (req: any, reply) => {
    const bad = forgedField(req.body);
    if (bad) {
      return reply.code(400).send({ error: '客户端不得上报共斗状态', code: COOP_INPUT_FORBIDDEN_CODE, fields: [bad] });
    }
    const p = paramsSchema.safeParse(req.params);
    const b = joinSchema.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: '加入参数不合法', code: 'COOP_BAD_REQUEST' });

    const res = await applyCoopJoin({
      roomId: p.data.roomId,
      userId: req.user.userId,
      digest: tokenDigest(bearerOf(req)),
      connectionId: connectionOf(req.user.userId),
      slot: b.data.slot,
    });
    if ('code' in res) return reply.code(res.status).send({ error: res.reason, code: res.code });
    return reply.send({ ok: true, ...res.value });
  });
}
