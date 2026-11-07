/**
 * WebSocket 消息协议与握手校验（P2-1 建通道，P2-2 扩展业务消息）。
 *
 * 设计原则：全部是零依赖纯函数，便于 node:test 单测，不放任何业务逻辑。
 * P2-2 新增：
 *   - 下行 `session.state`：服务端权威态的全量快照（含 revision / data / online）；
 *   - 上行 `session.resync`：客户端只请求「重推快照」，**不允许携带任何状态数据**。
 * 客户端不能通过 WS 写状态，状态变更只能走 REST 的意图裁决 / 整包 PUT，
 * 由服务端校验后统一经 GameSession 写入。伪造 session.state 上行会被 UNKNOWN_TYPE 拒绝。
 *
 * 注意：4KB / 20 条每秒限制针对**上行**；下行快照是完整存档，不受 maxPayload 约束。
 */
import type {
  RoomIntentKind, RoomMode, RoomQuotaState, RoomStatus,
} from './roomTypes';

/** 握手路径。刻意独立于 /api/*，方便网关按路径分流 WebSocket 流量。 */
export const WS_PATH = '/ws';
/** 协议版本：P2-2 保持 1，用 hello.capabilities 声明新增能力，避免旧客户端被拒。 */
export const WS_PROTOCOL_VERSION = 1;
export const WS_CAPABILITIES = [
  'session.state', 'session.resync', 'battle.state', 'wild.state',
  // P4-2b：房间全量快照 + 上行意图（意图由服务端裁决，上行没有写状态入口）。
  'room.state', 'room.action', 'room.resync',
];

/** 服务端底层 ping 周期；连接超过两个周期无响应即判定死连接。 */
export const WS_HEARTBEAT_MS = 30_000;
export const WS_DEAD_GRACE_MS = 5_000;
/** 单条上行消息上限（字节）。ws 的 maxPayload 也会在更底层强制截断。 */
export const WS_MAX_MESSAGE_BYTES = 4_096;
/**
 * P4-1a：同一账号只允许 1 条在线连接。第 2 条握手不再被 429 拒绝，
 * 而是由 WsRegistry.takeover() 顶掉前一条（后来者赢，前者直接下线）。
 * 常量保留供单测与只读诊断使用，路由不再用 canAccept 拦人。
 */
export const WS_MAX_CONNECTIONS_PER_USER = 1;
/** 单连接速率限制：每秒最多消息数，超过直接关闭（1008）。 */
export const WS_RATE_WINDOW_MS = 1_000;
export const WS_RATE_MAX_MESSAGES = 20;

/** 握手阶段可用的 HTTP 状态文案（upgrade 尚未建立 WS，需要手写响应头）。 */
const STATUS_TEXT: Record<number, string> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
};

/**
 * 从 upgrade 请求的 URL query 中提取 token。
 * 浏览器原生 WebSocket 不允许自定义 header，所以 JWT 只能走 query（或 cookie）。
 * 这里对长度做限制，避免超长 URL 打进日志 / 验签库。
 */
export function extractWsToken(rawUrl: string | undefined, maxUrlLen = 4_096): string | null {
  if (!rawUrl || rawUrl.length > maxUrlLen) return null;
  try {
    const url = new URL(rawUrl, 'http://localhost');
    const token = url.searchParams.get('token');
    return token && token.length > 0 && token.length <= 2_048 ? token : null;
  } catch {
    return null;
  }
}

/** 路径必须精确等于 /ws；其余 upgrade 请求不归实时通道处理。 */
export function isWsUpgradePath(rawUrl: string | undefined): boolean {
  if (!rawUrl) return false;
  try {
    return new URL(rawUrl, 'http://localhost').pathname === WS_PATH;
  } catch {
    return false;
  }
}

/**
 * Origin 白名单校验：防跨站 WebSocket 劫持（CSWSH）。
 * 浏览器发起的 WS 一定带 Origin；非浏览器客户端（E2E 脚本 / 服务端间调用）可不带，予以放行。
 * allowedCsv 与 CORS_ORIGIN 共用一份配置，逗号分隔；未配置时放行（后端默认会配）。
 */
export function isOriginAllowed(
  origin: string | undefined | null,
  allowedCsv: string | undefined,
): boolean {
  if (!origin) return true;
  const allowed = (allowedCsv ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
  if (allowed.length === 0) return true;
  return allowed.includes(origin);
}

/** 客户端 → 服务端：控制消息。业务状态只能由服务端下发，上行没有写入口。 */
export type ClientMessage =
  | { type: 'ping'; ts?: number }
  | { type: 'session.resync'; slot?: number }
  /**
   * P4-2b 房间意图：只带「我要做什么」，绝不带房间状态 / 回合结果 / quota 次数。
   * nonce 必填且服务端去重，防网络重放；`room.state` 没有对应的上行类型。
   */
  | {
      type: 'room.action';
      roomId: string;
      action: 'intent' | 'autopilot_on' | 'autopilot_off';
      nonce: string;
      intent?: string;
      targetSeat?: number;
    }
  /** 只请求「重推我所在房间的快照」，不携带任何状态数据。 */
  | { type: 'room.resync'; roomId?: string };

/** 会话快照消息体（P2-2）。 */
export type SessionStatePayload = {
  type: 'session.state';
  slot: number;
  revision: number;
  data: string;
  updatedAt: number;
  schemaVersion: string;
  source: 'hydrate' | 'put' | 'intent' | 'battle' | 'action';
  online: number;
};

/**
 * 战斗回合快照（P3-1）。
 * 只下发「服务端已经推进完」的结果；上行没有对应的写入口，
 * 客户端要推进战斗必须走 POST /api/battle/action 让服务端裁决。
 */
export type BattleStatePayload = {
  type: 'battle.state';
  slot: number;
  battleId: string;
  turn: number;
  finished: boolean;
  result: 'captured' | 'enemy_fainted' | 'fled' | 'player_fainted' | null;
};

/**
 * P4-1b 共享野怪：区域野怪列表的全量快照（跨账号广播）。
 * 客户端只按 revision 幂等应用，上行没有对应的写入口；
 * 抢占必须走 POST /api/battle/start 带 wildId，由服务端原子 claim。
 */
export type WildStatePayload = {
  type: 'wild.state';
  areaId: string;
  revision: number;
  monsters: {
    id: string;
    areaId: string;
    speciesId: string;
    name: string;
    level: number;
    label: string;
    status: 'available' | 'claimed' | 'resolved';
    result: 'captured' | 'defeated' | 'fled' | null;
    expiresAt: number;
  }[];
};

/**
 * P4-2b 房间全量快照。按成员分别下发（`self` 随接收者变化），
 * revision 单调递增，客户端按 (roomId, revision) 幂等应用。
 * 上行没有 `room.state` 类型，伪造会命中 UNKNOWN_TYPE 并被关 1008。
 */
export type RoomStatePayload = {
  type: 'room.state';
  room: {
    roomId: string;
    mode: RoomMode;
    status: RoomStatus;
    revision: number;
    turn: number;
    deadlineAt: number;
    seats: {
      seat: number;
      label: string;
      online: boolean;
      autopilot: boolean;
      submitted: boolean;
      self: boolean;
    }[];
    lastAction: { seat: number; intent: string; kind: RoomIntentKind } | null;
    quota: { key: string; state: RoomQuotaState } | null;
    endReason: string | null;
    updatedAt: number;
  };
};

/** 服务端 → 客户端：控制消息 + 权威态快照。 */
export type ServerMessage =
  | {
      type: 'hello';
      protocol: number;
      connectionId: string;
      userId: string;
      serverTime: number;
      heartbeatMs: number;
      /** P2-2 能力声明；旧客户端忽略即可。 */
      capabilities?: string[];
    }
  | { type: 'pong'; serverTime: number; echo?: number }
  | { type: 'error'; code: string; reason: string }
  | { type: 'bye'; reason: string; code?: string }
  | SessionStatePayload
  | BattleStatePayload
  | WildStatePayload
  | RoomStatePayload;

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: string; reason: string };

const ROOM_ACTIONS = new Set(['intent', 'autopilot_on', 'autopilot_off']);
const ROOM_ID_PATTERN = /^[A-Za-z0-9_:\-]+$/;
const TOKEN_FIELD_PATTERN = /^[A-Za-z0-9_\-]+$/;

function validRoomId(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 96 && ROOM_ID_PATTERN.test(v) ? v : undefined;
}
function validTokenField(v: unknown): string | undefined {
  return typeof v === 'string' && v.length > 0 && v.length <= 64 && TOKEN_FIELD_PATTERN.test(v) ? v : undefined;
}

/** 解析并校验客户端消息：长度 → JSON → 形状 → 白名单类型，四层都拒绝未知输入。 */
export function parseClientMessage(
  raw: string | Buffer,
  maxBytes: number = WS_MAX_MESSAGE_BYTES,
): ParseResult {
  const text = typeof raw === 'string' ? raw : raw.toString('utf8');
  if (Buffer.byteLength(text, 'utf8') > maxBytes) {
    return { ok: false, code: 'MESSAGE_TOO_LARGE', reason: '消息过长' };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, code: 'BAD_JSON', reason: '消息不是合法 JSON' };
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, code: 'BAD_SHAPE', reason: '消息格式不正确' };
  }
  const obj = value as Record<string, unknown>;
  if (obj.type === 'ping') {
    const ts = typeof obj.ts === 'number' && Number.isFinite(obj.ts) ? obj.ts : undefined;
    return { ok: true, message: ts === undefined ? { type: 'ping' } : { type: 'ping', ts } };
  }
  if (obj.type === 'session.resync') {
    // 只接受「请求重推」，其它字段一律忽略（尤其不允许带 data 改状态）。
    const slot = typeof obj.slot === 'number' && Number.isInteger(obj.slot) && obj.slot >= 1 && obj.slot <= 3
      ? obj.slot
      : undefined;
    return { ok: true, message: slot === undefined ? { type: 'session.resync' } : { type: 'session.resync', slot } };
  }
  if (obj.type === 'room.resync') {
    // 只请求重推；带任何状态字段都忽略，不回显、不采信。
    const roomId = validRoomId(obj.roomId);
    return { ok: true, message: roomId === undefined ? { type: 'room.resync' } : { type: 'room.resync', roomId } };
  }
  if (obj.type === 'room.action') {
    const roomId = validRoomId(obj.roomId);
    const nonce = validTokenField(obj.nonce);
    if (roomId === undefined || nonce === undefined || !ROOM_ACTIONS.has(String(obj.action))) {
      return { ok: false, code: 'BAD_SHAPE', reason: '房间意图格式不正确' };
    }
    const action = obj.action as 'intent' | 'autopilot_on' | 'autopilot_off';
    const intent = validTokenField(obj.intent);
    if (action === 'intent' && intent === undefined) {
      return { ok: false, code: 'BAD_SHAPE', reason: '缺少回合意图' };
    }
    const targetSeat = typeof obj.targetSeat === 'number' && Number.isInteger(obj.targetSeat)
      && obj.targetSeat >= 0 && obj.targetSeat <= 7 ? obj.targetSeat : undefined;
    if (action !== 'intent' && targetSeat === undefined) {
      return { ok: false, code: 'BAD_SHAPE', reason: '缺少托管目标座位' };
    }
    // 与 session.resync 同口径：多余字段（含伪造的状态 / 次数 / 回合结果）一律丢弃。
    return {
      ok: true,
      message: {
        type: 'room.action', roomId, action, nonce,
        ...(action === 'intent' ? { intent } : { targetSeat }),
      },
    };
  }
  return {
    ok: false,
    code: 'UNKNOWN_TYPE',
    reason: `不支持的消息类型 ${String(obj.type ?? 'undefined')}`,
  };
}

export function encodeServerMessage(message: ServerMessage): string {
  return JSON.stringify(message);
}

/**
 * 握手被拒时写回的完整 HTTP 响应文本。
 * upgrade 阶段还没进入 WebSocket 协议，必须手写状态行 + 头 + body，
 * 这样客户端能拿到明确的 401 / 403 / 429 及机器码，而不是一个看不懂的断连。
 */
export function buildRejectResponse(status: number, body: unknown): string {
  const payload = JSON.stringify(body);
  return [
    `HTTP/1.1 ${status} ${STATUS_TEXT[status] ?? 'Error'}`,
    'Content-Type: application/json; charset=utf-8',
    'Connection: close',
    `Content-Length: ${Buffer.byteLength(payload, 'utf8')}`,
    '',
    payload,
  ].join('\r\n');
}

/** 死连接判定阈值：两个心跳周期 + 宽限期。 */
export function deadAfterMs(heartbeatMs: number): number {
  return heartbeatMs * 2 + WS_DEAD_GRACE_MS;
}
