/**
 * F16 共斗 6 房副本接口（2026-11-09 杰哥「按默认开工」）。
 *
 * 权威模型（后端规范 §30）：
 *  - **不新增状态域**：六房态挂房间态（owner key = `roomId`），复用 P4-2b 的
 *    掉线 / 超时 / 托管 / 座位 / quota 三段式；`mode='coop'` 沿用既有内核。
 *  - **每房敌人 HP 是房间真值**：`withRoomLock()` 串行，全员交齐才 `advanceTurn` 一次，
 *    一次推进内遍历所有 `fighting` 房间各结算一回合，随后广播 `room.state` 全量快照。
 *  - 战斗过程走 `room.action` / `POST /api/room/:roomId/action` 既有意图通道
 *    （`enter:<0..5>` / `move:` / `switch:` / `idle`），本模块只负责「建房 / 加入 / 结算写档」。
 *  - 结算：**每个成员档各一次 `commitState()`** 回写队伍 HP / 异常，各自 CAS / revision
 *    不互相覆盖；`result='win'` 时再按 §30.7 给**满足最低贡献门槛**者发通关奖励
 *    （每日 3 次上限 + `CoopRewardGrant` 唯一键防双花）。幂等由 `coopSettled` + 唯一键双保险。
 *  - 客户端只发意图、只收全量快照；伪上报房间状态 / 伤害 / 贡献 / 奖励一律 400。
 *  - 匹配（MVP）：房主 `POST /api/coop/create` 选目标建房 → 队友 `POST /api/coop/:roomId/join`。
 *    `bossId` 只用于「目标主题 + 只读展示 + 校验」，敌人内容由服务端 `THEME_TABLE` 定。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withRoomLock, withSlotLock, slotLockKey } from '../lib/slotLock';
import { createCoopState, contributionOf, COOP_DAILY_CLEAR_LIMIT } from '../game/coop';
import { getBoss } from '../game/boss';
import { periodKeyOf } from '../game/period';
import { rooms, wsRegistry } from './sessionBus';
import { publishRoom } from './room';
import { readSave } from './saveRead';
import { commitState } from './session';
import { grantCoopClearReward } from './coopReward';
import { digestOf, type AuthorityState } from '../lib/authority';
import { tokenDigest } from '../lib/roomAuth';

export const COOP_INPUT_FORBIDDEN_CODE = 'COOP_INPUT_FORBIDDEN';

const createSchema = z.object({
  bossId: z.string().min(1).max(64),
}).strip();
const joinSchema = z.object({}).strip();
const paramsSchema = z.object({ roomId: z.string().min(1).max(96) });

/**
 * 客户端不得上报的字段：房间状态 / 敌人 HP / 伤害 / 贡献 / 队伍 / 回合 / 结果 / 奖励。
 * 与 Boss / 榜单 / 1v1 同一口径：不是静默忽略，而是明确 400。
 * 注意 `bossId` 是合法入参，不能列进来。
 */
const FORBIDDEN_COOP_FIELDS = [
  'boss', 'bossHp', 'hp', 'maxHp', 'damage', 'party', 'coop', 'result', 'winner', 'winnerUserId',
  'turn', 'log', 'quota', 'quotaLimit', 'revision', 'status', 'rewards', 'endReason',
  'rooms', 'roomIndex', 'roomState', 'state', 'enemies', 'occupantSeat', 'cleared', 'total',
  'contribution', 'contributions', 'reward', 'seatRoom',
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

/** 读某账号单档的队伍（活体校验）。返回 null 表示无档 / 队伍不可用。 */
async function readParty(userId: string) {
  const row = await readSave(userId);
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
 * 房间 quota 的隔离键：账号 + UTC+8 自然日（§30.7 每日通关上限）。
 * `userId` 是 cuid（25 字符），整键会超过房间内核 `validQuotaKey` 的 64 字符上限，
 * 故只取尾 8 字符作内存 Map 键 —— 它不是权威真值，只用于 quota 三段式的隔离，
 * 真值在 `CoopRewardGrant` 落库记录里（P5-1 迁共享存储时统一改 key，F10）。
 */
function coopQuotaKey(userId: string, now: number): string {
  return `coop:${periodKeyOf(now)}:${userId.slice(-8)}`;
}

/**
 * 房主创建副本房间：只校验目标与队伍，此刻只有房主一人，
 * 六房态留到全员 join 后生成（每房敌人 HP 那时才成为房间真值）。
 */
export async function applyCoopCreate(params: {
  userId: string;
  digest: string;
  connectionId: string | null;
  bossId: string;
  now?: number;
}): Promise<CoopApiResult<{ room: any }>> {
  const now = params.now ?? Date.now();
  const spec = getBoss(params.bossId);
  if (!spec) return fail('COOP_BOSS_UNKNOWN', '未知的共斗目标', 400);
  const party = await readParty(params.userId);
  if (!party) return fail('COOP_NO_PARTY', '还没有可用队伍，无法共斗', 404);

  return withSlotLock(slotLockKey(params.userId), async () => {
    const roomId = `coop_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    return withRoomLock(roomId, async () => {
      if (!params.digest || !params.connectionId) {
        return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线', 409);
      }
      const res = rooms.create({
        roomId,
        mode: 'coop',
        owner: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
        quotaKey: coopQuotaKey(params.userId, now),
        quotaLimit: COOP_DAILY_CLEAR_LIMIT,
        coopBossId: spec.bossId,
        now,
      });
      if ('code' in res) return fail(res.code, res.reason, 409);
      publishRoom(res.value);
      return { ok: true, value: { room: rooms.view(res.value, params.userId) } };
    });
  });
}

/** 队友加入：满员后按座位顺序读各自队伍，构造六房副本态并挂到房间。 */
export async function applyCoopJoin(params: {
  roomId: string;
  userId: string;
  digest: string;
  connectionId: string | null;
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
        // 副本态按座位顺序建立，N 人通用。
        const p = await readParty(seat.userId);
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
 * 结算写各成员档：副本分出胜负后，把战斗内的队伍 HP / 异常回写各自存档，
 * 每人一次 `commitState()`，revision 各自单调 +1、互不覆盖。
 *
 * `result='win'` 时按 §30.7 追加通关奖励：
 *  - 只给 `contribution >= COOP_MIN_CONTRIBUTION` 的成员（纯挂机不发）；
 *  - 每日上限 + 唯一键防刷由 `grantCoopClearReward()` 保证；
 *  - ⚠️ 该调用链只持有**房间锁**，所以发奖函数自己取账号锁，
 *    绝不传 `alreadyLocked`（否则并发写档无保护，见 §30.7）。
 * 幂等由 `room.coopSettled` 标记 + `CoopRewardGrant` 唯一键双保险。
 */
export async function settleCoopRoom(roomId: string): Promise<void> {
  const room = rooms.get(roomId);
  const coop = room?.coop;
  if (!coop || !coop.finished) return;
  const result = coop.result;

  for (let seat = 0; seat < coop.sides.length; seat += 1) {
    const side = coop.sides[seat];

    // ① 回写队伍状态（每人一次账号锁 + commitState）。
    try {
      await withSlotLock(slotLockKey(side.userId), async () => {
        const rec = await readSave(side.userId);
        if (!rec) return;
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
        await commitState(side.userId, {
          data: raw,
          schemaVersion: rec.schemaVersion,
          clientId: rec.clientId,
          authority,
          source: 'battle',
        });
      });
    } catch (e) {
      console.warn(`[F16] 回写队伍状态失败 room=${roomId} seat=${seat}:`, e);
    }

    // ② 通关奖励（独立账号锁，失败只记日志、不阻断副本结束响应）。
    if (result === 'win') {
      try {
        await grantCoopClearReward({
          roomId,
          userId: side.userId,
          contribution: contributionOf(coop, seat),
          result,
        });
      } catch (e) {
        console.warn(`[F16] 通关奖励发放失败 room=${roomId} seat=${seat}:`, e);
      }
    }
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
    });
    if ('code' in res) return reply.code(res.status).send({ error: res.reason, code: res.code });
    return reply.send({ ok: true, ...res.value });
  });
}
