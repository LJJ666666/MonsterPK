/**
 * WebSocket 消息协议与握手校验（P2-1）。
 *
 * 设计原则：全部是零依赖纯函数，便于 node:test 单测，不放任何业务逻辑。
 * P2-1 只负责「建通道 + 鉴权 + 保活」，游戏状态广播留到 P2-2 的 GameSession。
 * 因此协议里目前只有 hello / ping / pong / error / bye 五种控制消息，
 * 业务消息类型将在 P2-2 按领域扩展，避免现在就设计一套用不上的假协议。
 */

/** 握手路径。刻意独立于 /api/*，方便网关按路径分流 WebSocket 流量。 */
export const WS_PATH = '/ws';
/** 协议版本：客户端收到 hello 后据此判断是否兼容，后续升级用它做协商。 */
export const WS_PROTOCOL_VERSION = 1;

/** 服务端底层 ping 周期；连接超过两个周期无响应即判定死连接。 */
export const WS_HEARTBEAT_MS = 30_000;
export const WS_DEAD_GRACE_MS = 5_000;
/** 单条消息上限（字节）。ws 的 maxPayload 也会在更底层强制截断。 */
export const WS_MAX_MESSAGE_BYTES = 4_096;
/** 同一账号允许的同时在线连接数，防止单账号耗尽服务端连接表。 */
export const WS_MAX_CONNECTIONS_PER_USER = 3;
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

/** 客户端 → 服务端：目前只接受 ping（业务意图在 P2-2 才接入）。 */
export type ClientMessage = { type: 'ping'; ts?: number };

/** 服务端 → 客户端：控制消息集合。 */
export type ServerMessage =
  | {
      type: 'hello';
      protocol: number;
      connectionId: string;
      userId: string;
      serverTime: number;
      heartbeatMs: number;
    }
  | { type: 'pong'; serverTime: number; echo?: number }
  | { type: 'error'; code: string; reason: string }
  | { type: 'bye'; reason: string; code?: string };

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; code: string; reason: string };

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
