/**
 * P4-2b 房间内核：类型、常量与服务端配置。
 *
 * 零依赖纯模块，便于 node:test 直接 import；不含任何 IO / WebSocket / Prisma。
 * 房间是继 `userId:slot` / `battleId` / `areaId` 之后的**第四个状态域**，
 * owner key 为 `roomId`，写入一律经 `withRoomLock()` 串行。
 */

export type RoomMode = 'kernel' | 'pvp' | 'coop';
export const ROOM_MODES: readonly RoomMode[] = ['kernel', 'pvp', 'coop'];

/** forming → active → paused（有人掉线）→ abandoned | settled。paused 可回 active。 */
export type RoomStatus = 'forming' | 'active' | 'paused' | 'abandoned' | 'settled';
export type RoomQuotaState = 'held' | 'committed' | 'released';
/** 意图来源：客户端手动 / 托管代放 / 回合超时代放。三者都由服务端裁决后才写状态。 */
export type RoomIntentKind = 'manual' | 'autopilot' | 'timeout';

/** 注入式 RNG，与 game/rules.ts 保持同签名，便于 E2E / 单测复现。 */
export type Rng = () => number;

export type RoomConfig = {
  /** 回合内未交齐意图 → 服务端代放并推进。 */
  roundTimeoutMs: number;
  /** 成员掉线超过此时长，房内其他在线成员「可以」开启托管（不是自动托管）。 */
  autopilotOfferMs: number;
  /** 全员掉线超过此时长 → 解散、release 次数。 */
  allOfflineGraceMs: number;
  /** 房间闲置回收时长。 */
  ttlMs: number;
  maxSeats: number;
};

/** 从环境变量读整数并钳制，配置写错不至于把服务打爆。只在服务端调用。 */
function envInt(raw: string | undefined, fallback: number, min: number, max: number): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || raw === undefined || raw === '') return fallback;
  return Math.min(Math.max(Math.floor(n), min), max);
}

/**
 * 阈值按玩法分档 —— 客户端只能选 `mode`，**不能传毫秒数**，否则等于让客户端改共享世界规则。
 *
 * `kernel` 是「无玩法基准档」：用于房间内核自测与 CI 回归，天然是短阈值，
 * 这样 E2E 不必真等 20s/30s/60s；它不产出奖励、不写个人档、不影响真实玩法。
 * 这也是契约 §6「ROUND_TIMEOUT_MS 是否分玩法」待定项的第一版落法。
 */
export function roomConfigFor(mode: RoomMode, env: NodeJS.ProcessEnv = process.env): RoomConfig {
  if (mode === 'kernel') {
    return {
      roundTimeoutMs: envInt(env.ROOM_KERNEL_ROUND_MS, 1_200, 200, 60_000),
      autopilotOfferMs: envInt(env.ROOM_KERNEL_OFFER_MS, 1_800, 200, 60_000),
      allOfflineGraceMs: envInt(env.ROOM_KERNEL_GRACE_MS, 3_500, 500, 60_000),
      ttlMs: envInt(env.ROOM_KERNEL_TTL_MS, 10 * 60_000, 10_000, 3_600_000),
      maxSeats: 2,
    };
  }
  // pvp / coop 共用生产档；后续按玩法细分只改这里，房间状态机零改动。
  return {
    roundTimeoutMs: envInt(env.ROOM_ROUND_TIMEOUT_MS, 20_000, 1_000, 600_000),
    autopilotOfferMs: envInt(env.ROOM_AUTOPILOT_OFFER_MS, 30_000, 1_000, 600_000),
    allOfflineGraceMs: envInt(env.ROOM_ALL_OFFLINE_GRACE_MS, 60_000, 1_000, 600_000),
    ttlMs: envInt(env.ROOM_TTL_MS, 30 * 60_000, 10_000, 3_600_000),
    maxSeats: 2,
  };
}

export type RoomSeat = {
  seat: number;
  userId: string;
  /** token 的 sha256 摘要（不存明文）：只有同一 token 同一设备才能原位重连。 */
  tokenDigest: string;
  /** 当前绑定的 WS 连接；掉线置 null。重连时按「userId + tokenDigest」匹配座位。 */
  connectionId: string | null;
  online: boolean;
  disconnectedAt: number | null;
  autopilot: boolean;
};

export type RoomQuota = {
  key: string;
  state: RoomQuotaState;
};

export type RoomAction = {
  seat: number;
  intent: string;
  kind: RoomIntentKind;
  at: number;
};

export type RoomState = {
  roomId: string;
  mode: RoomMode;
  status: RoomStatus;
  /** 单调递增，每次状态变更 +1；客户端按 (roomId, revision) 幂等应用。 */
  revision: number;
  createdAt: number;
  updatedAt: number;
  seats: RoomSeat[];
  turn: number;
  /** 0 表示尚未开局（forming），不触发回合超时。 */
  deadlineAt: number;
  /** 本回合已提交意图的座位号。全员提交或超时后清空并推进 turn。 */
  submitted: number[];
  lastAction: RoomAction | null;
  quota: RoomQuota | null;
  /** 全员掉线的起始时刻；有人在线即为 null。 */
  allOfflineSince: number | null;
  /** 已消费的意图 nonce（限长），防重放。 */
  seenNonces: string[];
  endReason: string | null;
};

/** 下发视图：不含 tokenDigest / connectionId / 他人 userId / 次数余量。 */
export type RoomSeatView = {
  seat: number;
  label: string;
  online: boolean;
  autopilot: boolean;
  submitted: boolean;
  self: boolean;
};

export type RoomView = {
  roomId: string;
  mode: RoomMode;
  status: RoomStatus;
  revision: number;
  turn: number;
  deadlineAt: number;
  seats: RoomSeatView[];
  lastAction: { seat: number; intent: string; kind: RoomIntentKind } | null;
  quota: { key: string; state: RoomQuotaState } | null;
  endReason: string | null;
  updatedAt: number;
};

export type QuotaUsage = { held: number; committed: number };

/** 操作结果：strict:false 下判别联合不收窄，调用方一律用 `'code' in res` 取值（bug_log §18）。 */
export type RoomResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

/** 托管策略接口：后续 AI 直接替换实现，房间状态机零改动（台账 F07）。 */
export interface AutopilotPolicy {
  pick(context: { roomId: string; seat: number; turn: number }, rng: Rng): string | null;
}

/** b 阶段无玩法，用占位意图列表随机挑；d/e 接真实战斗时改为 pickUsableMove()。 */
export const KERNEL_INTENTS: readonly string[] = ['move_1', 'move_2', 'move_3', 'switch_1'];

export class RandomAutopilotPolicy implements AutopilotPolicy {
  constructor(private readonly intents: readonly string[] = KERNEL_INTENTS) {}
  pick(_ctx: { roomId: string; seat: number; turn: number }, rng: Rng): string | null {
    if (this.intents.length === 0) return null;
    const i = Math.min(this.intents.length - 1, Math.floor(rng() * this.intents.length));
    return this.intents[i] ?? null;
  }
}
