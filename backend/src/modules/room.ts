/**
 * P4-2b 房间内核：REST 路由 + WS 意图共用的服务层。
 *
 * 权威模型：房间是第四个状态域，owner key = `roomId`，所有写经 `withRoomUnit()` 串行；
 * 客户端只发意图（REST 或 WS `room.action`）、只收 `room.state` 全量快照。
 * **WS 上行绝不写状态**：意图经服务端裁决后由 RoomRegistry 写入，房间态不落个人档。
 *
 * 与 P4-1 顶号的边界：座位记 token 的 sha256 指纹，只有同一 token 同一设备能原位重连；
 * 换设备登录签出新 token（sv 递增）→ 指纹不同 → 座位保持掉线，不转移。
 *
 * b 阶段刻意无玩法：不算伤害、不写个人档、不发奖励、不做匹配，也没有玩法 UI。
 */
import type { FastifyInstance } from 'fastify';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { rooms, wsRegistry, broadcastToUser } from './sessionBus';
import { encodeServerMessage } from '../lib/wsProtocol';
import { withRoomUnit, onRoomCommit } from '../lib/roomUnitOfWork';
import { getSweepLeader, type SweepContext } from '../lib/sweepLeader';
import { tokenDigest } from '../lib/roomAuth';
import type { TickReport } from '../lib/roomRegistry';
import { parseCoopIntent } from '../game/coop';
import type {
  RoomMode, RoomResult, RoomState, RoomView,
} from '../lib/roomTypes';

/** 限次余量由服务端配置决定，客户端只能给隔离键，不能给上限。 */
function quotaLimit(): number {
  const n = Number(process.env.ROOM_QUOTA_LIMIT ?? 3);
  if (!Number.isFinite(n)) return 3;
  return Math.min(Math.max(Math.floor(n), 1), 99);
}

/** 只取同一账号当前唯一在线 WS 连接（P4-1 顶号后单账号最多 1 条）。 */
function connectionOf(userId: string): string | null {
  return wsRegistry.listForUser(userId)[0]?.id ?? null;
}

function bearerOf(req: any): string {
  const raw = req?.headers?.authorization;
  return typeof raw === 'string' && raw.startsWith('Bearer ') ? raw.slice(7) : '';
}

/** 房间状态真值字段一律不准出现在请求体里；不是「忽略」，而是明确 400。 */
const FORBIDDEN_ROOM_FIELDS = [
  'roomId', 'status', 'revision', 'turn', 'deadlineAt', 'seats', 'submitted',
  'quota', 'quotaLimit', 'allOfflineSince', 'tokenDigest', 'connectionId',
  'endReason', 'createdAt', 'updatedAt', 'lastAction',
] as const;

function forbiddenField(body: unknown): string | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  return FORBIDDEN_ROOM_FIELDS.find((k) => k in (body as Record<string, unknown>));
}

const STATUS_BY_CODE: Record<string, number> = {
  ROOM_NOT_FOUND: 404,
  ROOM_SEAT_NOT_FOUND: 404,
  ROOM_FORBIDDEN: 403,
  ROOM_SEAT_OFFLINE: 403,
  ROOM_WS_REQUIRED: 409,
  ROOM_CLOSED: 409,
  ROOM_FULL: 409,
  ROOM_EXISTS: 409,
  ROOM_DUPLICATE_MEMBER: 409,
  ROOM_QUOTA_EXHAUSTED: 429,
  INTENT_REPLAY: 409,
  TURN_ALREADY_SUBMITTED: 409,
  AUTOPILOT_TOO_EARLY: 409,
  AUTOPILOT_SELF: 400,
  AUTOPILOT_TARGET_ONLINE: 400,
};

function statusFor(code: string): number {
  return STATUS_BY_CODE[code] ?? 400;
}

/** 按成员分别生成视图（self 随接收者变化），逐个账号广播。 */
export async function publishRoom(roomOrId: string | RoomState): Promise<number> {
  const room = typeof roomOrId === 'string' ? await rooms.get(roomOrId) : roomOrId;
  if (!room) return 0;
  // W6.2：视图先按接收者算好，真正发送挂到工作单元的 after-commit 钩子。
  // 事务回滚时客户端不会收到基于未提交状态的快照；非事务上下文立即发送。
  const messages = room.seats.map((seat) => ({
    userId: seat.userId,
    payload: encodeServerMessage({ type: 'room.state', room: rooms.view(room, seat.userId) }),
  }));
  onRoomCommit(() => {
    for (const m of messages) broadcastToUser(m.userId, m.payload);
  });
  // 返回「本次将投递的成员数」（实际发送在提交后，不阻塞事务）。
  return messages.length;
}

const emptyReport = (): TickReport => ({
  changedRoomIds: [], timedOut: 0, autopiloted: 0, abandoned: [], deleted: [],
});

function mergeReport(into: TickReport, from: TickReport): void {
  into.changedRoomIds.push(...from.changedRoomIds);
  into.abandoned.push(...from.abandoned);
  into.deleted.push(...from.deleted);
  into.timedOut += from.timedOut;
  into.autopiloted += from.autopiloted;
}

/**
 * W4 房间推进核心（调用方必须已持 `withRoomUnit`）。
 *
 * 幂等门 `idem:room:<roomId>:<revision>` 是**短期 claim + 用完释放**：
 * 两个实例在同一 revision 上并发 tick 只有 1 个能推进；推进完 revision 就变了，
 * 下一次 250ms tick 用新键正常推进，不会把回合饿死。W6 会用 PG 行版本 CAS 替换。
 * 结算标记另用长期 `idem:settle:*` 保证胜负只触发一次写档；广播只在提交成功后发。
 */
async function tickRoomCore(
  roomId: string,
  now: number,
  ctx: SweepContext | null | undefined,
): Promise<TickReport> {
  const report = emptyReport();
  const activeCtx = ctx === undefined ? getSweepLeader().lightContext() : ctx;
  const revision = (await rooms.get(roomId))?.revision ?? 0;
  const roomKey = `room:${roomId}:${revision}`;
  const token = activeCtx ? await activeCtx.claim(roomKey, 5_000) : null;
  if (activeCtx && !token) return report;
  try {
    if (activeCtx && !(await activeCtx.guard())) return report;
    await rooms.tick(roomId, now, Math.random, report);
    if (report.changedRoomIds.includes(roomId) || report.abandoned.includes(roomId)) {
      // W6.2：结算写档 / 发奖与上面的 room + quota 写入在同一个事务内 await 完成，
      // 任何一步抛错 → 整个工作单元回滚 → settled 标记与 quota 一起撤销，可重试。
      await maybeSettlePvp(roomId, activeCtx);
      await maybeSettleCoop(roomId, activeCtx);
      await publishRoom(roomId); // 提交成功才发
    }
    return report;
  } finally {
    if (activeCtx && token) await activeCtx.releaseClaim(roomKey, token);
  }
}

/** 惰性推进：REST 读也触发一次服务端计时，E2E / 客户端不必纯等定时器。 */
export async function tickRoom(
  roomId: string,
  now = Date.now(),
  ctx?: SweepContext | null,
): Promise<TickReport> {
  try {
    return await withRoomUnit(roomId, () => tickRoomCore(roomId, now, ctx));
  } catch (e) {
    // 事务已整体回滚（room / quota / 存档 / 奖励），惰性读不因此 500。
    console.warn(`[W6.2] 房间工作单元回滚 room=${roomId}:`, e);
    return emptyReport();
  }
}

/** 定时扫描：超时 / 托管 / 全员掉线 / TTL 全在服务端推进，客户端无法触发时间。 */
export async function sweepRooms(
  now = Date.now(),
  ctx?: SweepContext | null,
): Promise<TickReport> {
  const merged = emptyReport();
  // W4：逐房套 `withRoomUnit`（房间锁 + 同一事务边界），不再无锁遍历快照。
  for (const roomId of await rooms.roomIds()) {
    mergeReport(merged, await tickRoom(roomId, now, ctx));
  }
  return merged;
}

/**
 * P4-2d：房间刚分出胜负（pvp 结束 → settled）时，触发写双方档。
 * W6.2：改为事务内 `await` 结算（原 fire-and-forget 让写档 / 发奖落在事务之外，
 * 无法与 room + quota 共用原子边界）。失败必须冒泡 → 工作单元整体回滚 settled
 * 标记与 quota，Redis 长期 claim 一并释放，下次 tick 可以重试。
 */
async function maybeSettlePvp(roomId: string, ctx: SweepContext | null): Promise<void> {
  const room = await rooms.get(roomId);
  if (!room || !room.pvp || !room.pvp.finished || room.pvpSettled) return;
  const key = `settle:pvp:${roomId}`;
  const token = ctx ? await ctx.claim(key) : null;
  // 别的实例已领走结算：本地也置位，避免重复触发（发奖真值由 DB 唯一键裁决）。
  await rooms.setSettledFlag(roomId, 'pvp', true);
  if (ctx && !token) return;
  try {
    const m = await import('./pvp');
    await m.settlePvpRoom(roomId);
  } catch (e) {
    if (ctx && token) await ctx.releaseClaim(key, token);
    throw e;
  }
}

/**
 * F16：副本分出胜负（coop 结束 → settled）时，触发写各成员档与通关奖励。
 * 与 pvp 同款动态 import 规避循环依赖；幂等靠 room.coopSettled + 共享 CAS 门。
 */
async function maybeSettleCoop(roomId: string, ctx: SweepContext | null): Promise<void> {
  const room = await rooms.get(roomId);
  if (!room || !room.coop || !room.coop.finished || room.coopSettled) return;
  const key = `settle:coop:${roomId}`;
  const token = ctx ? await ctx.claim(key) : null;
  await rooms.setSettledFlag(roomId, 'coop', true);
  if (ctx && !token) return;
  try {
    const m = await import('./coop');
    await m.settleCoopRoom(roomId);
  } catch (e) {
    if (ctx && token) await ctx.releaseClaim(key, token);
    throw e;
  }
}

export function roomStats() {
  return rooms.stats();
}

type ViewResult = RoomResult<RoomView>;

function fail(code: string, reason: string): ViewResult {
  return { ok: false, code, reason };
}

/** 成员校验：非成员一律按 404 处理，不泄露房间是否存在。 */
async function memberView(roomId: string, userId: string): Promise<ViewResult> {
  const room = await rooms.get(roomId);
  if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
  if (!room.seats.some((s) => s.userId === userId)) {
    return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
  }
  return { ok: true, value: rooms.view(room, userId) };
}

// ───────────────────── REST 与 WS 共用的服务层 ─────────────────────

export async function applyRoomCreate(params: {
  userId: string;
  digest: string;
  connectionId: string | null;
  mode: RoomMode;
  quotaKey?: string;
  now?: number;
}): Promise<ViewResult> {
  const now = params.now ?? Date.now();
  const roomId = randomUUID();
  return withRoomUnit(roomId, async () => {
    if (!params.digest || !params.connectionId) {
      return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线');
    }
    const res = await rooms.create({
      roomId,
      mode: params.mode,
      owner: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
      quotaKey: params.quotaKey,
      quotaLimit: quotaLimit(),
      now,
    });
    if ('code' in res) return fail(res.code, res.reason);
    await publishRoom(res.value);
    return { ok: true, value: rooms.view(res.value, params.userId) };
  });
}

export async function applyRoomJoin(params: {
  roomId: string;
  userId: string;
  digest: string;
  connectionId: string | null;
  now?: number;
}): Promise<ViewResult> {
  const now = params.now ?? Date.now();
  return withRoomUnit(params.roomId, async () => {
    if (!params.digest || !params.connectionId) {
      return fail('ROOM_WS_REQUIRED', '进入房间需要实时通道在线');
    }
    const res = await rooms.join({
      roomId: params.roomId,
      member: { userId: params.userId, tokenDigest: params.digest, connectionId: params.connectionId },
      now,
    });
    if ('code' in res) return fail(res.code, res.reason);
    await publishRoom(res.value);
    return { ok: true, value: rooms.view(res.value, params.userId) };
  });
}

/** 回合意图：REST 与 WS `room.action{action:'intent'}` 都走这里。 */
export async function applyRoomIntent(params: {
  roomId: string;
  userId: string;
  intent: string;
  nonce: string;
  now?: number;
}): Promise<ViewResult> {
  return withRoomUnit(params.roomId, async () => {
    // P4-2e：共斗只接受 move:/switch:；flee 等语义非法意图在入口明确 400，
    // 不靠「代放补齐」静默吞掉（房间内核 autoSubmit 的 'skip' 占位不走这里）。
    const cur = await rooms.get(params.roomId);
    if (cur?.mode === 'coop' && !parseCoopIntent(params.intent)) {
      return { ok: false, code: 'COOP_INTENT_INVALID', reason: '共斗意图不合法（只支持 enter: / move: / switch: / idle）' };
    }
    const res = await rooms.submitIntent({
      roomId: params.roomId,
      actorUserId: params.userId,
      intent: params.intent,
      nonce: params.nonce,
      now: params.now ?? Date.now(),
    });
    if ('code' in res) return fail(res.code, res.reason);
    await maybeSettlePvp(params.roomId, getSweepLeader().lightContext());
    await maybeSettleCoop(params.roomId, getSweepLeader().lightContext());
    await publishRoom(res.value.room);
    return { ok: true, value: rooms.view(res.value.room, params.userId) };
  });
}

/** 托管开关：REST 与 WS `room.action{action:'autopilot_*'}` 都走这里。 */
export async function applyRoomAutopilot(params: {
  roomId: string;
  userId: string;
  targetSeat: number;
  enabled: boolean;
  nonce?: string;
  now?: number;
}): Promise<ViewResult> {
  return withRoomUnit(params.roomId, async () => {
    const res = await rooms.offerAutopilot({
      roomId: params.roomId,
      actorUserId: params.userId,
      targetSeat: params.targetSeat,
      enabled: params.enabled,
      nonce: params.nonce,
      now: params.now ?? Date.now(),
    });
    if ('code' in res) return fail(res.code, res.reason);
    await publishRoom(res.value);
    return { ok: true, value: rooms.view(res.value, params.userId) };
  });
}

/** 正常结算：quota commit。b 阶段无真实结算产物，只验证次数与终态。 */
export async function applyRoomSettle(params: {
  roomId: string; userId: string; now?: number;
}): Promise<ViewResult> {
  return withRoomUnit(params.roomId, async () => {
    const gate = await memberView(params.roomId, params.userId);
    if ('code' in gate) return gate;
    const res = await rooms.settle(params.roomId, params.now ?? Date.now());
    if ('code' in res) return fail(res.code, res.reason);
    await publishRoom(res.value);
    return { ok: true, value: rooms.view(res.value, params.userId) };
  });
}

/** 主动放弃：quota release。 */
export async function applyRoomAbandon(params: {
  roomId: string; userId: string; now?: number;
}): Promise<ViewResult> {
  return withRoomUnit(params.roomId, async () => {
    const gate = await memberView(params.roomId, params.userId);
    if ('code' in gate) return gate;
    const res = await rooms.abandon(params.roomId, params.now ?? Date.now(), 'manual');
    if ('code' in res) return fail(res.code, res.reason);
    await publishRoom(res.value);
    return { ok: true, value: rooms.view(res.value, params.userId) };
  });
}

/** WS 掉线 / 重连后的广播接线，由 realtime.ts 调用。 */
export async function publishRooms(roomIds: string[]): Promise<number> {
  let sent = 0;
  for (const id of new Set(roomIds)) sent += await publishRoom(id);
  return sent;
}

// ───────────────────── REST 路由 ─────────────────────

const createSchema = z.object({
  mode: z.enum(['kernel', 'pvp', 'coop']).default('kernel'),
  quotaKey: z.string().min(1).max(64).regex(/^[A-Za-z0-9_:\-]+$/).optional(),
}).strip();

const joinSchema = z.object({}).strip();
const intentSchema = z.object({
  // P4-2d：pvp 意图带冒号（move:tackle / switch:1 / flee）。
  intent: z.string().min(1).max(64).regex(/^[A-Za-z0-9_:\-]+$/),
  nonce: z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-]+$/),
}).strip();
const autopilotSchema = z.object({
  targetSeat: z.number().int().min(0).max(7),
  enabled: z.boolean(),
  nonce: z.string().min(1).max(64).regex(/^[A-Za-z0-9_\-]+$/).optional(),
}).strip();
const paramsSchema = z.object({ roomId: z.string().min(1).max(96) });

function replyResult(reply: any, res: ViewResult) {
  if ('code' in res) {
    return reply.code(statusFor(res.code)).send({ error: res.reason, code: res.code });
  }
  return reply.send({ ok: true, room: res.value });
}

function invalid(reply: any, detail: string): unknown {
  return reply.code(400).send({ error: detail, code: 'ROOM_BAD_REQUEST' });
}

export async function roomRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  /** 我所在的房间列表（resync 兜底）。 */
  fastify.get('/api/room', guard, async (req: any, reply) => {
    const list = (await rooms.listForUser(req.user.userId))
      .map((r) => rooms.view(r, req.user.userId));
    return reply.send({ ok: true, rooms: list });
  });

  /** 只读次数聚合：只有 held / committed，不含账号信息。 */
  fastify.get('/api/room/quota/:key', guard, async (req: any, reply) => {
    const key = String(req.params?.key ?? '');
    if (!/^[A-Za-z0-9_:\-]{1,64}$/.test(key)) return invalid(reply, '次数键不合法');
    return reply.send({ ok: true, key, usage: await rooms.quotaUsage(key) });
  });

  fastify.post('/api/room/create', guard, async (req: any, reply) => {
    const bad = forbiddenField(req.body);
    if (bad) return reply.code(400).send({ error: '客户端不得上报房间状态', code: 'ROOM_INPUT_FORBIDDEN' });
    const parsed = createSchema.safeParse(req.body ?? {});
    if (!parsed.success) return invalid(reply, '创建参数不合法');
    const digest = tokenDigest(bearerOf(req));
    return replyResult(reply, await applyRoomCreate({
      userId: req.user.userId,
      digest,
      connectionId: connectionOf(req.user.userId),
      mode: parsed.data.mode,
      quotaKey: parsed.data.quotaKey,
    }));
  });

  fastify.post('/api/room/:roomId/join', guard, async (req: any, reply) => {
    const bad = forbiddenField(req.body);
    if (bad) return reply.code(400).send({ error: '客户端不得上报房间状态', code: 'ROOM_INPUT_FORBIDDEN' });
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return invalid(reply, '房间标识不合法');
    joinSchema.safeParse(req.body ?? {});
    return replyResult(reply, await applyRoomJoin({
      roomId: p.data.roomId,
      userId: req.user.userId,
      digest: tokenDigest(bearerOf(req)),
      connectionId: connectionOf(req.user.userId),
    }));
  });

  fastify.get('/api/room/:roomId', guard, async (req: any, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return invalid(reply, '房间标识不合法');
    const gate = await memberView(p.data.roomId, req.user.userId);
    if ('code' in gate) return replyResult(reply, gate);
    // 惰性推进：读一次也让服务端按真实时间处理超时与全掉解散。
    // W4：tickRoom 内部已套 withRoomUnit，这里不再嵌套（进程内锁非重入会自锁）。
    await tickRoom(p.data.roomId);
    return replyResult(reply, await memberView(p.data.roomId, req.user.userId));
  });

  fastify.post('/api/room/:roomId/action', guard, async (req: any, reply) => {
    const bad = forbiddenField(req.body);
    if (bad) return reply.code(400).send({ error: '客户端不得上报房间状态', code: 'ROOM_INPUT_FORBIDDEN' });
    const p = paramsSchema.safeParse(req.params);
    const b = intentSchema.safeParse(req.body ?? {});
    if (!p.success || !b.success) return invalid(reply, '回合意图不合法');
    return replyResult(reply, await applyRoomIntent({
      roomId: p.data.roomId,
      userId: req.user.userId,
      intent: b.data.intent,
      nonce: b.data.nonce,
    }));
  });

  fastify.post('/api/room/:roomId/autopilot', guard, async (req: any, reply) => {
    const bad = forbiddenField(req.body);
    if (bad) return reply.code(400).send({ error: '客户端不得上报房间状态', code: 'ROOM_INPUT_FORBIDDEN' });
    const p = paramsSchema.safeParse(req.params);
    const b = autopilotSchema.safeParse(req.body ?? {});
    if (!p.success || !b.success) return invalid(reply, '托管参数不合法');
    return replyResult(reply, await applyRoomAutopilot({
      roomId: p.data.roomId,
      userId: req.user.userId,
      targetSeat: b.data.targetSeat,
      enabled: b.data.enabled,
      nonce: b.data.nonce,
    }));
  });

  fastify.post('/api/room/:roomId/settle', guard, async (req: any, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return invalid(reply, '房间标识不合法');
    return replyResult(reply, await applyRoomSettle({ roomId: p.data.roomId, userId: req.user.userId }));
  });

  fastify.post('/api/room/:roomId/abandon', guard, async (req: any, reply) => {
    const p = paramsSchema.safeParse(req.params);
    if (!p.success) return invalid(reply, '房间标识不合法');
    return replyResult(reply, await applyRoomAbandon({ roomId: p.data.roomId, userId: req.user.userId }));
  });
}
