// P2-1 实时通道客户端：建连 + 保活 + 断线重连 + 状态展示。
// P2-2：收到 session.state 权威快照后只做转发（派发全局事件），
// 真正的「应用快照 / 抑制回传」在 lib/session.ts，避免通道层直接改游戏状态。
import { useEffect, useState } from "react";
import { api, API_BASE, UNAUTHORIZED_EVENT, BANNED_EVENT, BAN_CODE } from "./api";
import { getToken, isTokenValid } from "./auth";
import {
  SESSION_STATE_EVENT, WILD_STATE_EVENT, ROOM_STATE_EVENT,
  type SessionStateMessage, type WildStateMessage, type RoomStateMessage,
} from "./sessionState";
import {
  SESSION_REPLACED_CODE, notifySessionReplaced,
} from "./sessionReplaced";

// 用数字常量而不是 WebSocket.OPEN：本模块会被 vitest 在 Node 环境里 import，
// 那里没有全局 WebSocket，顶层引用静态常量会直接抛错。
const CONNECTING = 0;
const OPEN = 1;

/** http(s) → ws(s)，固定拼 /ws；token 走 query（浏览器 WebSocket 不能自定义 header）。 */
export function wsUrl(base: string, token: string): string {
  const u = new URL(base);
  u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
  u.pathname = "/ws";
  u.search = "";
  u.hash = "";
  u.searchParams.set("token", token);
  return u.toString();
}

/** 指数退避 1s/2s/4s/8s/15s 封顶 + 最多 25% 抖动，避免多端同时重连打爆服务端。 */
export function reconnectDelayMs(attempt: number, random = 0): number {
  const n = Math.max(0, Math.floor(attempt));
  const base = Math.min(1000 * Math.pow(2, n), 15000);
  const jitter = 1 + Math.min(Math.max(random, 0), 1) * 0.25;
  return Math.round(base * jitter);
}

export type ServerEnvelope = { type: string; [key: string]: any };

/** 容错解析服务端消息；坏包一律忽略，不让异常打断连接状态机。 */
export function parseServerMessage(raw: string): ServerEnvelope | null {
  try {
    const v = JSON.parse(raw);
    if (!v || typeof v !== "object" || Array.isArray(v) || typeof v.type !== "string") return null;
    return v as ServerEnvelope;
  } catch {
    return null;
  }
}

/** P2-2：校验下行快照形状；不合法的一律不派发，避免脏数据写进 store。 */
export function isSessionStateMessage(m: ServerEnvelope | null): m is SessionStateMessage {
  return !!m
    && m.type === "session.state"
    && typeof m.slot === "number"
    && typeof m.revision === "number"
    && Number.isFinite(m.revision)
    && typeof m.data === "string"
    && typeof m.updatedAt === "number";
}

/** P4-1b：校验共享野怪快照形状；脏包不派发，避免把假的野怪塞进 UI。 */
export function isWildStateMessage(m: ServerEnvelope | null): m is WildStateMessage {
  return !!m
    && m.type === "wild.state"
    && typeof m.areaId === "string"
    && typeof m.revision === "number"
    && Number.isFinite(m.revision)
    && Array.isArray(m.monsters);
}

/**
 * P4-2b：校验房间全量快照形状。脏包一律不派发，避免把伪造的回合/座位塞进 UI。
 * 注意只校验「形状」，revision 的幂等判断在 lib/room.ts。
 */
export function isRoomStateMessage(m: ServerEnvelope | null): m is RoomStateMessage {
  if (!m || m.type !== "room.state" || !m.room || typeof m.room !== "object" || Array.isArray(m.room)) return false;
  const r = m.room as Record<string, any>;
  const modes = ["kernel", "pvp", "coop"];
  const statuses = ["forming", "active", "paused", "abandoned", "settled"];
  if (typeof r.roomId !== "string" || r.roomId.length === 0 || r.roomId.length > 96) return false;
  if (!modes.includes(r.mode) || !statuses.includes(r.status)) return false;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision) || r.revision < 0) return false;
  if (typeof r.turn !== "number" || typeof r.deadlineAt !== "number" || typeof r.updatedAt !== "number") return false;
  if (!Array.isArray(r.seats)) return false;
  for (const s of r.seats) {
    if (!s || typeof s !== "object" || typeof s.seat !== "number" || typeof s.label !== "string") return false;
    for (const k of ["online", "autopilot", "submitted", "self"]) if (typeof s[k] !== "boolean") return false;
  }
  return true;
}

export type WsPhase =
  | "idle"
  | "connecting"
  | "online"
  | "reconnecting"
  | "offline"
  | "unauthorized";

// —— 状态订阅（供 React UI 与自动化回归读取）——
const listeners = new Set<() => void>();
let phase: WsPhase = "idle";
let phaseInfo: string | undefined;
let attempts = 0;

function setPhase(p: WsPhase, info?: string) {
  phase = p;
  phaseInfo = info;
  for (const l of listeners) l();
}
export function getWsPhase(): WsPhase {
  return phase;
}
/** 只读诊断：不暴露 token / 消息内容，供 headless UI 冒烟确认连接状态。 */
export function getWsDiagnostics(): {
  phase: WsPhase;
  info?: string;
  attempts: number;
  connected: boolean;
} {
  return {
    phase,
    info: phaseInfo,
    attempts,
    connected: !!socket && socket.readyState === OPEN,
  };
}
export function subscribeWs(cb: () => void): () => void {
  listeners.add(cb);
  cb();
  return () => {
    listeners.delete(cb);
  };
}
export function useWsStatus(): { phase: WsPhase; info?: string } {
  const [state, setState] = useState(() => ({ phase: getWsPhase(), info: phaseInfo }));
  useEffect(() => subscribeWs(() => setState({ phase: getWsPhase(), info: phaseInfo })), []);
  return state;
}

// —— 连接状态（模块级单例，全局只有一条实时通道）——
let socket: WebSocket | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
let staleTimer: ReturnType<typeof setTimeout> | null = null;
let heartbeatMs = 30_000;
let lastMessageAt = 0;
let everOpened = false;
let started = false;
let stopped = true;
/**
 * P4-1a：被顶号时的 token。只要本地还是这枚 token，就拒绝再次建连——
 * 否则用户不点弹窗直接刷新页面，会重新握手把新设备踢下线，形成互相顶号死循环。
 * 重新登录会换一枚新 token（sv 不同），自然解除这个闸门。
 */
let replacedToken: string | null = null;

function clearTimers() {
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (heartbeatTimer) { clearInterval(heartbeatTimer); heartbeatTimer = null; }
  if (staleTimer) { clearTimeout(staleTimer); staleTimer = null; }
}

/** 解绑并关闭；把 handler 全部置空，避免关闭过程再次触发重连逻辑。 */
function detach(ws: WebSocket | null) {
  if (!ws) return;
  ws.onopen = null;
  ws.onmessage = null;
  ws.onerror = null;
  ws.onclose = null;
  try {
    if (ws.readyState === OPEN || ws.readyState === CONNECTING) ws.close();
  } catch {
    // 已断开
  }
}

/** 超过两个心跳周期没收到任何服务端消息 → 认为链路已死，主动断开触发重连。 */
function armStale() {
  if (staleTimer) clearTimeout(staleTimer);
  const limit = heartbeatMs * 2 + 5_000;
  staleTimer = setTimeout(() => {
    staleTimer = null;
    if (stopped || !socket) return;
    if (Date.now() - lastMessageAt >= limit) {
      try { socket.close(); } catch { /* 已断开 */ }
    } else {
      armStale();
    }
  }, limit);
}

function startHeartbeat() {
  if (heartbeatTimer) clearInterval(heartbeatTimer);
  heartbeatTimer = setInterval(() => {
    if (socket && socket.readyState === OPEN) {
      try { socket.send(JSON.stringify({ type: "ping", ts: Date.now() })); } catch { /* 已断开 */ }
    }
  }, Math.max(1_000, Math.floor(heartbeatMs / 2)));
  armStale();
}

function scheduleRetry() {
  if (stopped || retryTimer) return;
  attempts += 1;
  const delay = reconnectDelayMs(attempts - 1, Math.random());
  setPhase("reconnecting", `${Math.ceil(delay / 1000)} 秒后重连（第 ${attempts} 次）`);
  retryTimer = setTimeout(() => {
    retryTimer = null;
    connect();
  }, delay);
}

/**
 * 浏览器 WebSocket 拿不到握手失败的 HTTP 状态码，这里用一次轻量 REST 探测区分：
 * 401（登录过期）/ 403 封号 → 停止重连并交给全局弹窗；其余当作网络故障正常重连。
 */
async function handleHandshakeFailure() {
  const token = getToken();
  if (!token || !isTokenValid(token)) {
    setPhase("unauthorized", "请先登录");
    stopRealtime();
    return;
  }
  try {
    await api.me();
    scheduleRetry();
  } catch (e: any) {
    if (e?.code === SESSION_REPLACED_CODE) {
      replacedToken = getToken();
      setPhase("unauthorized", "账号已在其他设备登录");
      stopRealtime();
      notifySessionReplaced();
      return;
    }
    if (e?.code === BAN_CODE) {
      setPhase("unauthorized", "账号已被封号");
      stopRealtime();
      return;
    }
    if (e?.status === 401) {
      setPhase("unauthorized", "登录已过期");
      stopRealtime();
      return;
    }
    setPhase("offline", "实时通道不可达");
    scheduleRetry();
  }
}

function connect() {
  if (stopped) return;
  const token = getToken();
  if (!token || !isTokenValid(token)) {
    setPhase("unauthorized", "请先登录");
    return;
  }
  if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) return;

  setPhase(attempts === 0 ? "connecting" : "reconnecting", attempts > 0 ? `第 ${attempts} 次重连` : undefined);
  let ws: WebSocket;
  try {
    ws = new WebSocket(wsUrl(API_BASE, token));
  } catch {
    scheduleRetry();
    return;
  }
  socket = ws;
  everOpened = false;
  lastMessageAt = Date.now();

  ws.onopen = () => {
    everOpened = true;
    attempts = 0;
    lastMessageAt = Date.now();
    setPhase("online");
    startHeartbeat();
  };
  ws.onmessage = (ev) => {
    lastMessageAt = Date.now();
    armStale();
    const m = parseServerMessage(String(ev.data ?? ""));
    if (!m) return;
    if (m.type === "hello" && typeof m.heartbeatMs === "number") {
      // 心跳周期以服务端下发为准，钳制在 5s~120s 防止畸形配置
      heartbeatMs = Math.min(Math.max(m.heartbeatMs, 5_000), 120_000);
      startHeartbeat();
    } else if (isSessionStateMessage(m)) {
      // P2-2：只转发，不在这里改游戏状态；session.ts 负责幂等应用与抑制回传。
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(SESSION_STATE_EVENT, { detail: m }));
      }
    } else if (isWildStateMessage(m)) {
      // P4-1b：共享野怪状态也是全量快照，只转发，由 lib/wild.ts 维护视图。
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(WILD_STATE_EVENT, { detail: m }));
      }
    } else if (isRoomStateMessage(m)) {
      // P4-2b：房间快照按成员分别下发，只转发；幂等应用由 lib/room.ts 负责。
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(ROOM_STATE_EVENT, { detail: m }));
      }
    } else if (m.type === "error") {
      setPhase("online", m.reason);
    } else if (m.type === "bye" && m.code === SESSION_REPLACED_CODE) {
      // P4-1a 顶号：立刻停掉实时通道（不重连），弹窗由 App 的 SessionGate 统一展示。
      replacedToken = getToken();
      stopRealtime();
      notifySessionReplaced(m.reason);
      setPhase("unauthorized", m.reason ?? "账号已在其他设备登录");
    } else if (m.type === "bye" && m.code === BAN_CODE) {
      // 会话期被封：复用 P1-1b 的全局封号弹窗并强制登出，绝不继续重连
      window.dispatchEvent(
        new CustomEvent(BANNED_EVENT, { detail: { reason: m.reason ?? "你已被封号" } })
      );
      setPhase("unauthorized", m.reason);
      stopRealtime();
    }
  };
  ws.onerror = () => {
    // close 事件会紧随，重连统一在 onclose 里处理
  };
  ws.onclose = () => {
    clearTimers();
    if (ws === socket) socket = null;
    if (stopped) return;
    if (!everOpened) {
      void handleHandshakeFailure();
      return;
    }
    scheduleRetry();
  };
}

/** 网络恢复 / 页面重新可见时立刻重连，不等退避计时器。 */
function reconnectNow() {
  if (stopped) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  attempts = 0;
  if (socket && (socket.readyState === OPEN || socket.readyState === CONNECTING)) return;
  connect();
}

function onOnline() { if (!stopped) reconnectNow(); }
function onVisible() {
  if (!stopped && document.visibilityState === "visible") reconnectNow();
}
function onAuthLost() {
  stopRealtime();
  setPhase("unauthorized", "登录态已失效");
}

/**
 * 全局启动入口。App 会按路由变化重复调用（登录/登出后需要重新建连），
 * 因此实现成幂等：已在线时不会重复开连接，重复注册监听器也由 started 挡住。
 */
export function startRealtime(): void {
  const token = getToken();
  // P4-1a：还是被顶号那枚 token → 绝不重建连接（防互相顶号死循环）。
  if (replacedToken && token === replacedToken) {
    stopRealtime();
    setPhase("unauthorized", "账号已在其他设备登录");
    return;
  }
  if (!token || !isTokenValid(token)) {
    stopRealtime();
    setPhase("idle");
    return;
  }
  if (!started) {
    started = true;
    window.addEventListener("online", onOnline);
    document.addEventListener("visibilitychange", onVisible);
    window.addEventListener(UNAUTHORIZED_EVENT, onAuthLost);
    window.addEventListener(BANNED_EVENT, onAuthLost);
  }
  stopped = false;
  reconnectNow();
}

export function stopRealtime(): void {
  stopped = true;
  clearTimers();
  const ws = socket;
  socket = null;
  detach(ws);
  if (started) {
    window.removeEventListener("online", onOnline);
    document.removeEventListener("visibilitychange", onVisible);
    window.removeEventListener(UNAUTHORIZED_EVENT, onAuthLost);
    window.removeEventListener(BANNED_EVENT, onAuthLost);
    started = false;
  }
}
