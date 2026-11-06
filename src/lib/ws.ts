// P2-1 实时通道客户端：只负责「建连 + 保活 + 断线重连 + 状态展示」。
// 刻意不承载任何游戏状态——业务消息与在线权威态留到 P2-2 的 GameSession，
// 避免现在就把客户端状态写进一条还没定型的协议里。
import { useEffect, useState } from "react";
import { api, API_BASE, UNAUTHORIZED_EVENT, BANNED_EVENT, BAN_CODE } from "./api";
import { getToken, isTokenValid } from "./auth";

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
    } else if (m.type === "error") {
      setPhase("online", m.reason);
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
  if (!token || !isTokenValid(token)) {
    // 未登录：确保没有残留连接，等登录后由路由变化再次触发
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
