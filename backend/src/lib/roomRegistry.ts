/**
 * P4-2b 房间内核：纯逻辑状态机 + 可替换存储适配器。
 *
 * 设计约束（契约 §5 / 三条不变式）：
 *  - **零 IO**：不 import ws / fastify；时间、RNG、配置、ID 全部注入，单测可用假时钟推进 60 秒。
 *    Prisma / 网络只在 `RoomStorage` 实现里（W6.1 起 `PgRoomStorage`），本文件只认接口。
 *  - **可替换 storage**：所有读写只经 `RoomStorage` 接口；默认内存实现，P5-1 多实例换共享存储
 *    而不改状态机（这是 F10 硬门槛的预留口）。
 *  - **单实例内无交错**：Node 单线程下一个方法调用内部不会交错；跨 await 的「读→判定→写」
 *    由路由层的 `withRoomLock()` 串行（W3 起为 Redis 租约锁）。
 *  - **load-once / set-once**：一次逻辑操作只 `get` 一次、只 `set` 一次（末尾 `bump`）。
 *    子方法（`settleRoom`/`abandonRoom`/`advanceTurn`/`finishQuota`/`autoSubmit`）都改「传入的
 *    room 对象」而不再各自 `get`，避免 clone-on-get 后各自 CAS 互相踩（W6.1 行版本 CAS 前提）。
 *  - 客户端只发意图、只收 `RoomView` 全量快照；这里没有任何「按客户端上报的状态写字段」的路径。
 */
import { randomUUID } from 'node:crypto';
import {
  type AutopilotPolicy, type QuotaUsage, type Rng, type RoomConfig, type RoomMode,
  type RoomResult, type RoomSeat, type RoomState, type RoomView, type RoomSeatView,
  RandomAutopilotPolicy, roomConfigFor,
} from './roomTypes';
import {
  applyPvpTurn, encodePvpIntent, parsePvpIntent, pickPvpIntent, pvpViewFor, type PvpState,
} from '../game/pvp';
import {
  applyCoopTurn, encodeCoopIntent, parseCoopIntent, pickCoopIntent, coopViewFor, type CoopState,
} from '../game/coop';

/** 可替换存储：换 Redis / Postgres 时实现这 8 个语义的适配即可。set/create 返回是否成功（CAS）。 */
export interface RoomStorage {
  get(roomId: string): Promise<RoomState | undefined>;
  /** 插入新房；已存在返回 false（并发建房冲突）。 */
  create(room: RoomState): Promise<boolean>;
  /** 条件更新：CAS 成功返回 true，冲突（revision 已变）返回 false。 */
  set(room: RoomState): Promise<boolean>;
  /**
   * 同 revision 条件写回：不改 revision、只覆盖 data（where revision = room.revision）。
   * 供 `setSettledFlag` 这类 W0 钉住「不 bump revision」的写回使用；冲突返回 false。
   */
  writeBack(room: RoomState): Promise<boolean>;
  delete(roomId: string): Promise<void>;
  all(): Promise<RoomState[]>;
  getQuota(key: string): Promise<QuotaUsage>;
  setQuota(key: string, usage: QuotaUsage): Promise<void>;
  quotaKeys(): Promise<string[]>;
}

const emptyUsage = (): QuotaUsage => ({ held: 0, committed: 0 });

/** 深拷贝，避免 `get` 返回的副本被改后绕开 `set` 静默污染存储（§3.6 序列化障碍之一）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

export class InMemoryRoomStorage implements RoomStorage {
  private readonly rooms = new Map<string, RoomState>();
  private readonly quotas = new Map<string, QuotaUsage>();

  async get(roomId: string): Promise<RoomState | undefined> {
    const r = this.rooms.get(roomId);
    return r ? clone(r) : undefined;
  }
  async create(room: RoomState): Promise<boolean> {
    if (this.rooms.has(room.roomId)) return false;
    this.rooms.set(room.roomId, clone(room));
    return true;
  }
  async set(room: RoomState): Promise<boolean> {
    this.rooms.set(room.roomId, clone(room));
    return true;
  }
  async writeBack(room: RoomState): Promise<boolean> {
    this.rooms.set(room.roomId, clone(room));
    return true;
  }
  async delete(roomId: string): Promise<void> { this.rooms.delete(roomId); }
  async all(): Promise<RoomState[]> { return Array.from(this.rooms.values()).map(clone); }
  async getQuota(key: string): Promise<QuotaUsage> {
    return this.quotas.get(key) ? clone(this.quotas.get(key)!) : emptyUsage();
  }
  async setQuota(key: string, usage: QuotaUsage): Promise<void> {
    this.quotas.set(key, clone(usage));
  }
  async quotaKeys(): Promise<string[]> { return Array.from(this.quotas.keys()); }
}

/** tick 的产出，供调用方广播与记录日志。 */
export type TickReport = {
  changedRoomIds: string[];
  timedOut: number;
  autopiloted: number;
  abandoned: string[];
  deleted: string[];
};

export type RoomRegistryOptions = {
  storage?: RoomStorage;
  configFor?: (mode: RoomMode) => RoomConfig;
  policy?: AutopilotPolicy;
  idFactory?: () => string;
};

type Member = { userId: string; tokenDigest: string; connectionId: string | null };

const ok = <T>(value: T): RoomResult<T> => ({ ok: true, value });
const fail = <T>(code: string, reason: string): RoomResult<T> => ({ ok: false, code, reason });

/** CAS 冲突：同一 revision 被并发改了两次，后写者放弃（由路由层锁或重试兜底）。 */
class RoomCasConflictError extends Error {
  constructor(roomId: string) {
    super(`ROOM_CAS_CONFLICT:${roomId}`);
    this.name = 'RoomCasConflictError';
  }
}

const MAX_SEEN_NONCES = 64;
const ROOM_ID_MAX_LEN = 96;
const INTENT_MAX_LEN = 64;

function validIntent(intent: unknown): intent is string {
  return typeof intent === 'string' && intent.length > 0 && intent.length <= INTENT_MAX_LEN
    && /^[A-Za-z0-9_:\-]+$/.test(intent);
}

/** quota key 允许冒号分段（如 `boss:daily:2026-11-07`），但仍是纯字符、限长，只作内存 Map 键。 */
function validQuotaKey(key: unknown): key is string {
  return typeof key === 'string' && key.length > 0 && key.length <= INTENT_MAX_LEN
    && /^[A-Za-z0-9_:\-]+$/.test(key);
}

export class RoomRegistry {
  private readonly storage: RoomStorage;
  private readonly configFor: (mode: RoomMode) => RoomConfig;
  private readonly policy: AutopilotPolicy;
  private readonly idFactory: () => string;

  constructor(opts: RoomRegistryOptions = {}) {
    this.storage = opts.storage ?? new InMemoryRoomStorage();
    this.configFor = opts.configFor ?? ((mode) => roomConfigFor(mode));
    this.policy = opts.policy ?? new RandomAutopilotPolicy();
    this.idFactory = opts.idFactory ?? (() => randomUUID());
  }

  config(mode: RoomMode): RoomConfig { return this.configFor(mode); }

  async get(roomId: string): Promise<RoomState | undefined> { return this.storage.get(roomId); }

  /** W4：sweepRooms 要逐房套 `withRoomLock`，先取 id 快照（不暴露内部 storage）。 */
  async roomIds(): Promise<string[]> { return (await this.storage.all()).map((r) => r.roomId); }

  /**
   * W0：结算幂等标记的显式写回（统一走 CAS）。
   * 旧代码直接改 `rooms.get()` 返回对象的字段，靠「同一引用」隐式生效；
   * W6 换共享存储后 `get()` 会返回反序列化副本，那种写法会静默丢失
   * （设计定稿 §3.6 序列化三障碍之一）。统一走这里，后续只改本方法为异步。
   */
  async setSettledFlag(roomId: string, kind: 'pvp' | 'coop', value: boolean, now = Date.now()): Promise<void> {
    // W0 钉住的口径：结算标记写回不得 bump revision（零行为变更）。
    // W6.1：CAS 存储下用同 revision 条件写回（writeBack），冲突则重读重试（有限次，防自旋）。
    for (let attempt = 0; attempt < 5; attempt++) {
      const room = await this.storage.get(roomId);
      if (!room) return;
      const cur = kind === 'pvp' ? room.pvpSettled : room.coopSettled;
      if (cur === value) return; // 已是目标值：无变更不写，与原行为一致。
      if (kind === 'pvp') room.pvpSettled = value;
      else room.coopSettled = value;
      if (await this.storage.writeBack(room)) return;
    }
  }

  /**
   * P4-2d：把 1v1 战斗态挂到房间上（双方 join 完成后由路由层调用）。
   * 只接受「房间已 active 且尚无 pvp 态」的状态；挂上后 bump 一次让客户端拿到新快照。
   */
  async attachPvp(roomId: string, pvp: PvpState, now: number): Promise<RoomResult<RoomState>> {
    return this.retryCas(async () => {
      const room = await this.storage.get(roomId);
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.pvp) return fail('PVP_ALREADY_STARTED', '对战已经开始');
      if (room.status !== 'active') return fail('ROOM_CLOSED', '房间尚未开局');
      room.pvp = pvp;
      // 双方交齐的回合从这刻开始计时。
      room.deadlineAt = now + this.configFor(room.mode).roundTimeoutMs;
      await this.bump(room, now);
      return ok(room);
    });
  }

  /**
   * P4-2e / F16：把共斗（六房副本）态挂到房间上（全员 join 完成后由路由层调用）。
   * 只接受「房间已 active、mode=coop 且尚无 coop 态」；挂上后 bump 一次让客户端拿到新快照。
   */
  async attachCoop(roomId: string, coop: CoopState, now: number): Promise<RoomResult<RoomState>> {
    return this.retryCas(async () => {
      const room = await this.storage.get(roomId);
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.coop) return fail('COOP_ALREADY_STARTED', '共斗已经开始');
      if (room.mode !== 'coop') return fail('COOP_BAD_MODE', '该房间不是共斗房间');
      if (room.status !== 'active') return fail('ROOM_CLOSED', '房间尚未开局');
      room.coop = coop;
      room.deadlineAt = now + this.configFor(room.mode).roundTimeoutMs;
      await this.bump(room, now);
      return ok(room);
    });
  }

  /** 找该用户所在的所有房间（resync / 广播用）。 */
  async listForUser(userId: string): Promise<RoomState[]> {
    return (await this.storage.all()).filter((r) => r.seats.some((s) => s.userId === userId));
  }

  async quotaUsage(key: string): Promise<QuotaUsage> { return this.storage.getQuota(key); }

  async stats() {
    const all = await this.storage.all();
    const byStatus: Record<string, number> = {};
    for (const r of all) byStatus[r.status] = (byStatus[r.status] ?? 0) + 1;
    return {
      rooms: all.length,
      byStatus,
      quotaKeys: (await this.storage.quotaKeys()).length,
      seats: all.reduce((n, r) => n + r.seats.length, 0),
    };
  }

  /** 生成公开视图；`self` 按接收者计算，因此广播要按成员分别生成。 */
  view(room: RoomState, viewerUserId: string): RoomView {
    const seats: RoomSeatView[] = room.seats.map((s) => ({
      seat: s.seat,
      label: `座位 ${s.seat + 1}`,
      online: s.online,
      autopilot: s.autopilot,
      submitted: room.submitted.includes(s.seat),
      self: s.userId === viewerUserId,
    }));
    return {
      roomId: room.roomId,
      mode: room.mode,
      status: room.status,
      revision: room.revision,
      turn: room.turn,
      deadlineAt: room.deadlineAt,
      seats,
      lastAction: room.lastAction
        ? { seat: room.lastAction.seat, intent: room.lastAction.intent, kind: room.lastAction.kind }
        : null,
      quota: room.quota ? { key: room.quota.key, state: room.quota.state } : null,
      endReason: room.endReason,
      updatedAt: room.updatedAt,
      // P4-2d：按接收者裁剪 1v1 战斗视图（仅 pvp 房间有值）。
      pvp: room.pvp ? pvpViewFor(room.pvp, viewerUserId) : null,
      // F16：按接收者裁剪六房副本视图（仅 coop 房间有值）。
      coop: room.coop ? coopViewFor(room.coop, viewerUserId) : null,
    };
  }

  /** 写回一次变更：revision +1 并经 CAS 落库；冲突抛错（路由层锁/重试兜底）。 */
  private async bump(room: RoomState, now: number): Promise<void> {
    room.revision += 1;
    room.updatedAt = now;
    const okStored = await this.storage.set(room);
    if (!okStored) throw new RoomCasConflictError(room.roomId);
  }

  /** quota hold：只校验余量并占一个名额，**不消耗次数**。 */
  private async holdQuota(key: string, limit: number): Promise<boolean> {
    const usage = await this.storage.getQuota(key);
    if (usage.held + usage.committed >= limit) return false;
    usage.held += 1;
    await this.storage.setQuota(key, usage);
    return true;
  }

  /** commit / release 都幂等；已 committed 的房间再 abandon 不会倒扣。改传入 room，不写 room 行。 */
  private async finishQuota(room: RoomState, commit: boolean): Promise<void> {
    const q = room.quota;
    if (!q || q.state !== 'held') return;
    const usage = await this.storage.getQuota(q.key);
    usage.held = Math.max(0, usage.held - 1);
    if (commit) usage.committed += 1;
    await this.storage.setQuota(q.key, usage);
    q.state = commit ? 'committed' : 'released';
  }

  async create(params: {
    mode: RoomMode;
    owner: Member;
    quotaKey?: string;
    /** 由服务端从配置读，绝不接受客户端传值。 */
    quotaLimit?: number;
    now: number;
    roomId?: string;
    /** P4-2d：1v1 战斗态（仅 pvp 模式由路由层生成后传入）。 */
    pvp?: PvpState;
    /** P4-2e：建房时选定的 Boss id（服务端内容表校验过），join 满员时据此构造共斗态。 */
    coopBossId?: string;
  }): Promise<RoomResult<RoomState>> {
    if (!params.owner?.userId || !params.owner.tokenDigest) {
      return fail('ROOM_BAD_MEMBER', '成员身份不完整');
    }
    const roomId = params.roomId ?? this.idFactory();
    if (typeof roomId !== 'string' || roomId.length === 0 || roomId.length > ROOM_ID_MAX_LEN) {
      return fail('ROOM_BAD_ID', '房间标识不合法');
    }
    if (await this.storage.get(roomId)) return fail('ROOM_EXISTS', '房间已存在');
    const cfg = this.configFor(params.mode);
    const key = params.quotaKey;
    if (key !== undefined && !validQuotaKey(key)) {
      return fail('ROOM_BAD_QUOTA_KEY', '次数键不合法');
    }
    if (key !== undefined && !(await this.holdQuota(key, params.quotaLimit ?? 3))) {
      return fail('ROOM_QUOTA_EXHAUSTED', '本周期挑战次数已用完');
    }
    const seat: RoomSeat = {
      seat: 0,
      userId: params.owner.userId,
      tokenDigest: params.owner.tokenDigest,
      connectionId: params.owner.connectionId,
      online: params.owner.connectionId !== null,
      disconnectedAt: params.owner.connectionId === null ? params.now : null,
      autopilot: false,
    };
    const room: RoomState = {
      roomId,
      mode: params.mode,
      status: 'forming',
      revision: 1,
      createdAt: params.now,
      updatedAt: params.now,
      seats: [seat],
      turn: 1,
      deadlineAt: 0,
      submitted: [],
      turnIntents: [],
      lastAction: null,
      quota: key === undefined ? null : { key, state: 'held' },
      allOfflineSince: seat.online ? null : params.now,
      seenNonces: [],
      endReason: null,
      pvp: params.pvp ?? null,
      coop: null,
      // W0：与 coopSettled 对称地显式初始化。旧代码只靠 `undefined` 兜幂等判定，
      // 一旦 W6 序列化/反序列化（optional 字段丢失）就会重新变成 undefined，
      // 结算可能重复触发。显式布尔是 §3.6 的三处序列化修复之一。
      pvpSettled: false,
      coopSettled: false,
      coopBossId: params.coopBossId ?? null,
    };
    // 满 1 人即开局的场景（单人 Boss 预留）：b 阶段固定 2 人，故 forming。
    if (cfg.maxSeats <= 1) this.start(room, params.now, cfg);
    const created = await this.storage.create(room);
    if (!created) {
      // 并发建房命中唯一约束：释放刚才占的 quota，返回已存在。
      if (room.quota) await this.releaseHeldQuota(room.quota.key);
      return fail('ROOM_EXISTS', '房间已存在');
    }
    return ok(room);
  }

  /** 建房冲突回滚时释放刚占的 hold（不扣 committed）。 */
  private async releaseHeldQuota(key: string): Promise<void> {
    const usage = await this.storage.getQuota(key);
    if (usage.held <= 0) return;
    usage.held -= 1;
    await this.storage.setQuota(key, usage);
  }

  private start(room: RoomState, now: number, cfg: RoomConfig): void {
    room.status = 'active';
    room.deadlineAt = now + cfg.roundTimeoutMs;
    room.allOfflineSince = room.seats.every((s) => !s.online) ? now : null;
  }

  join(params: { roomId: string; member: Member; now: number }): Promise<RoomResult<RoomState>> {
    return this.loadAndMutate(params.roomId, async (room) => {
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.status !== 'forming') return fail('ROOM_CLOSED', '房间已开局');
      if (!params.member?.userId || !params.member.tokenDigest) {
        return fail('ROOM_BAD_MEMBER', '成员身份不完整');
      }
      const cfg = this.configFor(room.mode);
      if (room.seats.length >= cfg.maxSeats) return fail('ROOM_FULL', '房间已满');
      if (room.seats.some((s) => s.userId === params.member.userId)) {
        return fail('ROOM_DUPLICATE_MEMBER', '不能重复加入房间');
      }
      room.seats.push({
        seat: room.seats.length,
        userId: params.member.userId,
        tokenDigest: params.member.tokenDigest,
        connectionId: params.member.connectionId,
        online: params.member.connectionId !== null,
        disconnectedAt: params.member.connectionId === null ? params.now : null,
        autopilot: false,
      });
      if (room.seats.length >= cfg.maxSeats) this.start(room, params.now, cfg);
      else if (room.seats.every((s) => !s.online)) room.allOfflineSince = params.now;
      else room.allOfflineSince = null;
      return ok(room);
    }, params.now);
  }

  /**
   * WS 断开：按 (userId, connectionId) 精确匹配座位。
   * 精确匹配是关键 —— 新连接先建好、旧连接随后 close 时，不能把新连接标成掉线。
   * 顶号踢掉的旧连接也走这里，表现就是「成员掉线」，座位保留等待同一 token 重连。
   */
  markDisconnected(userId: string, connectionId: string, now: number): Promise<string[]> {
    return this.withUserRooms(userId, (rooms) => {
      const changed: string[] = [];
      for (const room of rooms) {
        if (room.status === 'abandoned' || room.status === 'settled') continue;
        const seat = room.seats.find((s) => s.userId === userId && s.connectionId === connectionId);
        if (!seat) continue;
        seat.online = false;
        seat.connectionId = null;
        seat.disconnectedAt = now;
        if (room.status === 'active') room.status = 'paused';
        if (room.seats.every((s) => !s.online) && room.allOfflineSince === null) {
          room.allOfflineSince = now;
        }
        changed.push(room.roomId);
      }
      return changed;
    }, now);
  }

  /**
   * 重连：必须 (userId, tokenDigest) 同时匹配才恢复座位。
   * 换设备登录 → sessionVersion 递增 → JWT `sv` 变化 → tokenDigest 不同 → **不匹配**，
   * 座位保持 disconnected，不会把新连接塞进旧房间（契约 §4 与 P4-1 顶号的边界）。
   */
  reconnect(userId: string, tokenDigest: string, connectionId: string, now: number): Promise<string[]> {
    return this.withUserRooms(userId, (rooms) => {
      const changed: string[] = [];
      for (const room of rooms) {
        if (room.status === 'abandoned' || room.status === 'settled') continue;
        const seat = room.seats.find(
          (s) => s.userId === userId && s.tokenDigest === tokenDigest && !s.online,
        );
        if (!seat) continue;
        seat.online = true;
        seat.connectionId = connectionId;
        seat.disconnectedAt = null;
        seat.autopilot = false; // 本人回来了，托管自动撤销
        room.allOfflineSince = null;
        if (room.status === 'paused') room.status = 'active';
        // 契约「超时计时清零」：重连后重新给一整个回合窗口。
        if (room.deadlineAt > 0) room.deadlineAt = now + this.configFor(room.mode).roundTimeoutMs;
        changed.push(room.roomId);
      }
      return changed;
    }, now);
  }

  /**
   * 开启 / 关闭托管：只能由**在线**成员给**掉线且已超过 offer 窗口**的队友开，
   * 不能给自己开，也不能给在线队友开。是否开启是「可选」，不是自动接管。
   */
  offerAutopilot(params: {
    roomId: string;
    actorUserId: string;
    targetSeat: number;
    enabled: boolean;
    now: number;
    /** WS 上行必带；与回合意图共用 seenNonces 去重。 */
    nonce?: string;
  }): Promise<RoomResult<RoomState>> {
    return this.loadAndMutate(params.roomId, async (room) => {
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.status !== 'active' && room.status !== 'paused') {
        return fail('ROOM_CLOSED', '房间已结束');
      }
      const actor = room.seats.find((s) => s.userId === params.actorUserId);
      if (!actor || !actor.online) return fail('ROOM_FORBIDDEN', '只有在线成员可以操作托管');
      const target = room.seats.find((s) => s.seat === params.targetSeat);
      if (!target) return fail('ROOM_SEAT_NOT_FOUND', '目标座位不存在');
      if (target.userId === params.actorUserId) return fail('AUTOPILOT_SELF', '不能托管自己');
      if (target.online) return fail('AUTOPILOT_TARGET_ONLINE', '目标成员在线，无需托管');
      if (params.enabled) {
        const since = target.disconnectedAt ?? params.now;
        if (params.now - since < this.configFor(room.mode).autopilotOfferMs) {
          return fail('AUTOPILOT_TOO_EARLY', '队友仍在重连窗口内，暂不能托管');
        }
      }
      // 无变化（已是目标状态）直接返回，不抬 revision（与原行为一致）。
      if (target.autopilot === params.enabled) return ok(room);
      if (params.nonce !== undefined) {
        if (!validIntent(params.nonce)) return fail('ROOM_BAD_NONCE', '意图编号不合法');
        if (room.seenNonces.includes(params.nonce)) return fail('INTENT_REPLAY', '该意图已提交');
        room.seenNonces.push(params.nonce);
        if (room.seenNonces.length > MAX_SEEN_NONCES) room.seenNonces.shift();
      }
      target.autopilot = params.enabled;
      return ok(room);
    }, params.now);
  }

  /** 提交一个回合意图；nonce 去重。全员提交 → 立即推进回合。 */
  submitIntent(params: {
    roomId: string;
    actorUserId: string;
    intent: string;
    nonce: string;
    now: number;
  }): Promise<RoomResult<{ room: RoomState; advanced: boolean }>> {
    return this.loadAndMutate(params.roomId, async (room) => {
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.status !== 'active' && room.status !== 'paused') {
        return fail('ROOM_CLOSED', '房间已结束');
      }
      const seat = room.seats.find((s) => s.userId === params.actorUserId);
      if (!seat) return fail('ROOM_FORBIDDEN', '你不在该房间');
      if (!seat.online) return fail('ROOM_SEAT_OFFLINE', '当前成员已掉线');
      if (!validIntent(params.intent)) return fail('ROOM_BAD_INTENT', '意图不合法');
      if (!validIntent(params.nonce)) return fail('ROOM_BAD_NONCE', '意图编号不合法');
      if (room.seenNonces.includes(params.nonce)) return fail('INTENT_REPLAY', '该意图已提交');
      if (room.submitted.includes(seat.seat)) {
        return fail('TURN_ALREADY_SUBMITTED', '本回合已提交过意图');
      }
      room.seenNonces.push(params.nonce);
      if (room.seenNonces.length > MAX_SEEN_NONCES) room.seenNonces.shift();
      room.submitted.push(seat.seat);
      room.turnIntents.push({ seat: seat.seat, intent: params.intent });
      room.lastAction = { seat: seat.seat, intent: params.intent, kind: 'manual', at: params.now };
      let advanced = false;
      if (room.submitted.length >= room.seats.length) {
        await this.advanceTurn(room, params.now, this.configFor(room.mode));
        advanced = true;
      }
      return ok({ room, advanced });
    }, params.now);
  }

  /**
   * 推进回合：清空本回合提交，turn+1。
   * P4-2d：若房间带 1v1 战斗态，先按双方意图结算一回合（可能分出胜负 → settled）。
   * 改传入 room，不写 room 行；quota 走 finishQuota（独立写）。
   */
  private async advanceTurn(room: RoomState, now: number, cfg: RoomConfig): Promise<void> {
    if (room.pvp && !room.pvp.finished) {
      const rng = Math.random;
      const actions = room.turnIntents
        .map((t) => ({ seat: t.seat, intent: parsePvpIntent(t.intent) }))
        .filter((a): a is { seat: number; intent: NonNullable<ReturnType<typeof parsePvpIntent>> } => a.intent !== null);
      // 有意图才能推进；超时代放的座位已在 tick 里补过意图。
      if (actions.length > 0) {
        const res = applyPvpTurn(room.pvp, actions, rng);
        if ('value' in res) {
          room.pvp = res.value;
          if (res.value.finished) {
            room.status = 'settled';
            room.endReason = 'pvp_finished';
            room.deadlineAt = 0;
            await this.finishQuota(room, true);
          }
        }
      }
    }
    // F16：共斗一次推进内遍历所有 fighting 房间各结算一回合（每房 HP 是房间真值，只减一次）。
    if (room.coop && !room.coop.finished) {
      const rng = Math.random;
      const actions = room.turnIntents
        .map((t) => ({ seat: t.seat, intent: parseCoopIntent(t.intent) }))
        .filter((a): a is { seat: number; intent: NonNullable<ReturnType<typeof parseCoopIntent>> } => a.intent !== null);
      // 缺失 / 非法意图由 applyCoopTurn 内部用 pickCoopIntent 代放补齐，不炸房间推进。
      const res = applyCoopTurn(room.coop, actions, rng);
      if ('value' in res) {
        room.coop = res.value;
        if (res.value.finished) {
          room.status = 'settled';
          room.endReason = 'coop_finished';
          room.deadlineAt = 0;
          await this.finishQuota(room, true);
        }
      }
    }
    room.turn += 1;
    room.submitted = [];
    room.turnIntents = [];
    room.deadlineAt = now + cfg.roundTimeoutMs;
  }

  /** 正常结算：quota `hold → commit`，次数只有到这里才真的扣。改 room，finishQuota 独立写。 */
  private settleRoom(room: RoomState, now: number): void {
    if (room.status === 'settled' || room.status === 'abandoned') return;
    room.status = 'settled';
    room.endReason = 'settled';
    room.deadlineAt = 0;
  }

  /** 主动放弃 / 全员掉线 / forming 超时：quota `hold → release`，不扣次数、不结算。 */
  private abandonRoom(room: RoomState, now: number, reason: string): void {
    if (room.status === 'abandoned' || room.status === 'settled') return;
    room.status = 'abandoned';
    room.endReason = reason;
    room.deadlineAt = 0;
  }

  async settle(roomId: string, now: number): Promise<RoomResult<RoomState>> {
    return this.loadAndMutate(roomId, async (room) => {
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.status === 'settled') return ok(room);
      if (room.status === 'abandoned') return fail('ROOM_CLOSED', '房间已解散');
      this.settleRoom(room, now);
      if (room.quota && room.quota.state === 'held') await this.finishQuota(room, true);
      return ok(room);
    }, now);
  }

  async abandon(roomId: string, now: number, reason: string): Promise<RoomResult<RoomState>> {
    return this.loadAndMutate(roomId, async (room) => {
      if (!room) return fail('ROOM_NOT_FOUND', '房间不存在或已解散');
      if (room.status === 'abandoned') return ok(room);
      if (room.status === 'settled') return fail('ROOM_CLOSED', '房间已结算');
      this.abandonRoom(room, now, reason);
      if (room.quota && room.quota.state === 'held') await this.finishQuota(room, false);
      return ok(room);
    }, now);
  }

  /** 服务端代放：托管座位走 `autopilot`，超时未交的座位走 `timeout`。改传入 room。 */
  private autoSubmit(
    room: RoomState,
    seat: RoomSeat,
    kind: 'autopilot' | 'timeout',
    now: number,
    rng: Rng,
    report: TickReport,
  ): void {
    let intent: string | null;
    // F16：共斗代放按座位所在房间生成合法意图（大厅 → enter:<i>，房内 → move:/switch:，出局 → idle）。
    if (room.coop && !room.coop.finished) {
      const picked = pickCoopIntent(room.coop, seat.seat, rng);
      intent = picked === null ? 'skip' : encodeCoopIntent(picked);
    } else if (room.pvp && !room.pvp.finished) {
      // P4-2d：pvp 房间代放要生成合法战斗意图（从有 PP 的技能里随机挑 / 逃跑）。
      const picked = pickPvpIntent(room.pvp, seat.seat, rng);
      intent = picked === null ? null : encodePvpIntent(picked);
    } else {
      intent = this.policy.pick({ roomId: room.roomId, seat: seat.seat, turn: room.turn }, rng);
    }
    if (!intent) return;
    room.submitted.push(seat.seat);
    room.turnIntents.push({ seat: seat.seat, intent });
    room.lastAction = { seat: seat.seat, intent, kind, at: now };
    if (kind === 'autopilot') report.autopiloted += 1;
    else report.timedOut += 1;
  }

  /**
   * 推进一个房间的时间线。纯逻辑、注入 now / rng，单测可用假时钟一次跳 60 秒。
   * 顺序有讲究：先判「全员掉线解散」与「forming 超时」，再推进回合，避免已解散房间还被代放。
   * load-once：本方法只 get 一次、只 set 一次（末尾 bump）。
   */
  async tick(roomId: string, now: number, rng: Rng, report: TickReport): Promise<void> {
    // CAS 冲突（如 WS 掉线标记并发写）整段重跑。report 的 deleted/abandoned/changedRoomIds
    // 都在 bump 成功后才 push，重跑不重复；timedOut/autopiloted 计数在极小概率冲突下会多计一次，
    // 仅影响日志口径，房间态与 quota 由 CAS + finishQuota 幂等保证精确。
    await this.retryCas(() => this.tickOnce(roomId, now, rng, report));
  }

  private async tickOnce(roomId: string, now: number, rng: Rng, report: TickReport): Promise<void> {
    const room = await this.storage.get(roomId);
    if (!room) return;
    const cfg = this.configFor(room.mode);
    if (room.status === 'abandoned' || room.status === 'settled') {
      if (now - room.updatedAt > cfg.ttlMs) {
        await this.storage.delete(roomId);
        report.deleted.push(roomId);
      }
      return;
    }
    if (room.status === 'forming' && now - room.createdAt > cfg.ttlMs) {
      this.abandonRoom(room, now, 'forming_timeout');
      if (room.quota && room.quota.state === 'held') await this.finishQuota(room, false);
      await this.bump(room, now);
      report.abandoned.push(roomId);
      report.changedRoomIds.push(roomId);
      return;
    }
    if (room.allOfflineSince !== null && now - room.allOfflineSince >= cfg.allOfflineGraceMs) {
      this.abandonRoom(room, now, 'all_offline');
      if (room.quota && room.quota.state === 'held') await this.finishQuota(room, false);
      await this.bump(room, now);
      report.abandoned.push(roomId);
      report.changedRoomIds.push(roomId);
      return;
    }
    if (room.status !== 'active' && room.status !== 'paused') return;

    let changed = false;
    // 1) 已开启托管的掉线座位：回合一开始就代放，不必等 20s 超时。
    for (const seat of room.seats) {
      if (!seat.autopilot || seat.online || room.submitted.includes(seat.seat)) continue;
      this.autoSubmit(room, seat, 'autopilot', now, rng, report);
      changed = true;
    }
    // 2) 全员交齐 → 立即推进。
    if (room.submitted.length >= room.seats.length) {
      await this.advanceTurn(room, now, cfg);
      changed = true;
    } else if (room.deadlineAt > 0 && now >= room.deadlineAt) {
      // 3) 回合超时 → 服务端用注入 RNG 代放所有未提交座位，正常推进回合。
      for (const seat of room.seats) {
        if (room.submitted.includes(seat.seat)) continue;
        this.autoSubmit(room, seat, 'timeout', now, rng, report);
      }
      await this.advanceTurn(room, now, cfg);
      changed = true;
    }
    if (changed) {
      await this.bump(room, now);
      report.changedRoomIds.push(roomId);
    }
  }

  /** 定时扫描所有房间；调用方负责给 changedRoomIds 广播 room.state。 */
  async sweep(now: number, rng: Rng): Promise<TickReport> {
    const report: TickReport = {
      changedRoomIds: [], timedOut: 0, autopiloted: 0, abandoned: [], deleted: [],
    };
    for (const room of await this.storage.all()) {
      await this.tick(room.roomId, now, rng, report);
    }
    return report;
  }

  // ───────────────────── 事务边界辅助：load-once / set-once ─────────────────────

  /**
   * CAS 冲突整段重试：op 是完整的 load→mutate→bump，冲突意味着有并发写者先落库
   * （如 WS 掉线标记未持本房间锁），重跑一遍以最新状态重新应用；最多 5 次，
   * 耗尽后原样抛出（由路由层转 409 或调用方兜底日志）。
   */
  private async retryCas<T>(op: () => Promise<T>, attempts = 5): Promise<T> {
    let last: unknown;
    for (let i = 0; i < attempts; i++) {
      try { return await op(); } catch (e) {
        if (!(e instanceof RoomCasConflictError)) throw e;
        last = e;
      }
    }
    throw last;
  }

  /**
   * 包裹单次房间操作：load 一次 → fn(room) 改对象（不写）→ 仅当 fn 返回 ok 且房间确有变更时 bump 一次。
   * 路由层已持 `withRoomLock(roomId)` 串行，故本方法内 load→set 不会被同实例其它持锁写打断；
   * 但 WS 掉线/重连标记未持房间锁，冲突时整段重跑（乐观并发，效果等价于串行）。
   * fn 内部已自行处理 quota 写（finishQuota）；bump 只写 room 行。
   */
  private loadAndMutate<T>(
    roomId: string,
    fn: (room: RoomState | undefined) => Promise<RoomResult<T>>,
    now: number,
  ): Promise<RoomResult<T>> {
    return this.retryCas(async () => {
      const room = await this.storage.get(roomId);
      const before = room ? JSON.stringify(room) : null;
      const res = await fn(room);
      if (res.ok) {
        // fn 直接改传入的 room 对象（load-once / set-once）；按 room 序列化判定是否真有变更。
        // 注意：用 room 而非 res.value —— submitIntent 返回 { room, advanced }，res.value 不是 RoomState。
        const after = room ? JSON.stringify(room) : null;
        // 无实际变更（如托管已是目标状态）则不抬 revision，与原行为一致。
        if (room && before !== after) await this.bump(room, now);
      }
      return res;
    });
  }

  /**
   * 包裹「按用户遍历其所有房间」的操作（markDisconnected / reconnect）。
   * load 一次该用户全部房间 → fn 改对象 → 逐个 bump 写回（每个房间一次 CAS）。
   * 本路径不持房间锁（跨多房间），CAS 冲突时整段重跑（乐观并发）。
   */
  private withUserRooms(
    userId: string,
    fn: (rooms: RoomState[]) => string[],
    now: number,
  ): Promise<string[]> {
    return this.retryCas(async () => {
      const rooms = (await this.storage.all()).filter((r) => r.seats.some((s) => s.userId === userId));
      const changed = fn(rooms);
      for (const room of rooms) {
        if (changed.includes(room.roomId)) await this.bump(room, now);
      }
      return changed;
    });
  }
}
