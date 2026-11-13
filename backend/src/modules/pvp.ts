/**
 * P4-2d 玩家对战 1v1 接口。
 *
 * 权威模型（与排期文档 §4 P4-2d 对应）：
 *  - 1v1 **不新增权威源**：战斗态挂房间态（owner key = `roomId`），
 *    复用 P4-2b 房间内核的掉线 / 超时 / 托管 / 座位。
 *  - 战斗过程：双方各提交真实意图（`move:<moveId>` / `switch:<idx>` / `flee`），
 *    走房间内核的 `submitIntent`（双方交齐 → `advanceTurn` → `applyPvpTurn` 结算一回合）。
 *  - 结算：一方全灭 / 逃跑 → 房间 settled，写双方档各一次 `commitState()`，
 *    各自 CAS 与 revision（不互相覆盖）。MVP 只回写队伍 HP（对战不产经验金钱捕获）。
 *  - 客户端只发意图、只收 `room.state` 全量快照（含按接收者裁剪的 pvp 视图）。
 *
 * 匹配（MVP）：房主 `POST /api/pvp/create` 建房 → 对手 `POST /api/pvp/:roomId/join`。
 * 不做随机匹配 / 排位（排期「明确不做」）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { withRoomLock, withSlotLock, slotLockKey } from '../lib/slotLock';
import { createPvpState } from '../game/pvp';
import { rooms } from './sessionBus';
import { publishRoom } from './room';
import { readSave } from './saveRead';
import { commitState } from './session';
import { digestOf, type AuthorityState } from '../lib/authority';
import { tokenDigest } from '../lib/roomAuth';
import { wsRegistry } from './sessionBus';

export const PVP_INPUT_FORBIDDEN_CODE = 'PVP_INPUT_FORBIDDEN';

const createSchema = z.object({}).strip();
const joinSchema = z.object({}).strip();
const paramsSchema = z.object({ roomId: z.string().min(1).max(96) });

/**
 * 客户端不得上报的字段：胜负、HP、PP、队伍、回合、次数。
 * 与 Boss / 榜单同一口径：不是静默忽略，而是明确 400。
 */
const FORBIDDEN_PVP_FIELDS = [
  'winner', 'winnerUserId', 'fled', 'hp', 'maxHp', 'pp', 'party', 'pvp',
  'damage', 'turn', 'result', 'log', 'quota', 'quotaLimit',
] as const;

function forgedField(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return FORBIDDEN_PVP_FIELDS.find((k) => k in (obj as Record<string, unknown>));
}

type PvpResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; reason: string; status: number };

const fail = (code: string, reason: string, status = 400): PvpResult<never> => ({
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
 * 房主创建 1v1 房间。此刻只有房主队伍，pvp 态留到对手 join 后生成。
 * 不传 quotaKey（1v1 不限次）。
 */
export async function applyPvpCreate(params: {
  userId: string;
  digest: string;
  connectionId: string | null;
  now?: number;
}): Promise<PvpResult<{ room: any }>> {
  const now = params.now ?? Date.now();
  const party = await readParty(params.userId);
  if (!party) return fail('PVP_NO_PARTY', '还没有可用队伍，无法对战', 404);

  return withSlotLock(slotLockKey(params.userId), async () => {
    const roomId = `pvp_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    return withRoomLock(roomId, async () => {
      if (!params.digest || !params.connectionId) {
        return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线', 409);
      }
      const res = await rooms.create({
        roomId,
        mode: 'pvp',
        owner: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
        now,
      });
      if ('code' in res) return fail(res.code, res.reason, 409);
      await publishRoom(res.value);
      return { ok: true, value: { room: rooms.view(res.value, params.userId) } };
    });
  });
}

/**
 * 对手加入：join 成功后读双方队伍生成 pvp 态并挂到房间，双方交齐即开局。
 */
export async function applyPvpJoin(params: {
  roomId: string;
  userId: string;
  digest: string;
  connectionId: string | null;
  now?: number;
}): Promise<PvpResult<{ room: any }>> {
  const now = params.now ?? Date.now();
  return withRoomLock(params.roomId, async () => {
    if (!params.digest || !params.connectionId) {
      return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线', 409);
    }
    const res = await rooms.join({
      roomId: params.roomId,
      member: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
      now,
    });
    if ('code' in res) return fail(res.code, res.reason, 409);
    let room = res.value;

    // 满员开局：读双方队伍生成 pvp 态。
    if (room.status === 'active' && !room.pvp) {
      const a = room.seats.find((s) => s.seat === 0);
      const b = room.seats.find((s) => s.seat === 1);
      if (a && b) {
        const partyA = await readParty(a.userId);
        const partyB = await readParty(b.userId);
        if (!partyA || !partyB) {
          await rooms.abandon(room.roomId, now, 'party_unavailable');
          await publishRoom(room.roomId);
          return fail('PVP_NO_PARTY', '一方没有可用队伍，无法对战', 409);
        }
        const state = createPvpState({
          sideA: { userId: a.userId, party: partyA.party },
          sideB: { userId: b.userId, party: partyB.party },
          now,
        });
        if ('code' in state) {
          await rooms.abandon(room.roomId, now, 'party_unavailable');
          await publishRoom(room.roomId);
          return fail(state.code, state.reason, 409);
        }
        const attached = await rooms.attachPvp(room.roomId, state.value, now);
        if ('code' in attached) {
          return fail(attached.code, attached.reason, 409);
        }
        room = attached.value;
      }
    }
    await publishRoom(room);
    return { ok: true, value: { room: rooms.view(room, params.userId) } };
  });
}

/**
 * 结算写双方档：pvp 分出胜负后，把战斗内的队伍 HP / 异常回写双方存档，
 * 各一次 `commitState()`，revision 各自单调 +1、互不覆盖。
 *
 * 幂等：由调用方保证只在「从 active → settled」的这一次触发；
 * 这里再按 `finished` 判断，重复调用也不重复结算（队伍已回写后 HP 不再变化）。
 */
export async function settlePvpRoom(roomId: string): Promise<void> {
  const room = await rooms.get(roomId);
  if (!room?.pvp || !room.pvp.finished) return;
  const pvp = room.pvp;

  for (const side of pvp.sides) {
    const rec = await readSave(side.userId);
    if (!rec) continue;
    await withSlotLock(slotLockKey(side.userId), async () => {
      let save: any;
      try {
        save = JSON.parse(rec.raw);
      } catch {
        return;
      }
      // 只回写队伍（战斗内 HP / 异常 / 等级不变，MVP 不产经验）。
      save.party = side.party;
      save.lastSavedAt = new Date().toISOString();
      const raw = JSON.stringify(save);
      const authority: AuthorityState = {
        ...rec.authority,
        expected: digestOf(raw),
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
  }
}

export async function pvpRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  fastify.post('/api/pvp/create', guard, async (req: any, reply) => {
    const bad = forgedField(req.body);
    if (bad) {
      return reply.code(400).send({ error: '客户端不得上报对战状态', code: PVP_INPUT_FORBIDDEN_CODE, fields: [bad] });
    }
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '创建参数不合法', code: 'PVP_BAD_REQUEST' });

    const res = await applyPvpCreate({
      userId: req.user.userId,
      digest: tokenDigest(bearerOf(req)),
      connectionId: connectionOf(req.user.userId),
    });
    if ('code' in res) return reply.code(res.status).send({ error: res.reason, code: res.code });
    return reply.send({ ok: true, ...res.value });
  });

  fastify.post('/api/pvp/:roomId/join', guard, async (req: any, reply) => {
    const bad = forgedField(req.body);
    if (bad) {
      return reply.code(400).send({ error: '客户端不得上报对战状态', code: PVP_INPUT_FORBIDDEN_CODE, fields: [bad] });
    }
    const p = paramsSchema.safeParse(req.params);
    const b = joinSchema.safeParse(req.body ?? {});
    if (!p.success || !b.success) return reply.code(400).send({ error: '加入参数不合法', code: 'PVP_BAD_REQUEST' });

    const res = await applyPvpJoin({
      roomId: p.data.roomId,
      userId: req.user.userId,
      digest: tokenDigest(bearerOf(req)),
      connectionId: connectionOf(req.user.userId),
    });
    if ('code' in res) return reply.code(res.status).send({ error: res.reason, code: res.code });
    return reply.send({ ok: true, ...res.value });
  });
}
