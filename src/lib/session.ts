/**
 * P2-2 前端在线权威态接入：收服务端快照 → 幂等应用 → 抑制回传 → 供 UI 展示。
 *
 * 约束：
 *  - 只应用 revision 严格更新的快照；本端 PUT 成功后已记下 revision，
 *    所以自己的回显不会被重复应用（也不会触发自动同步回环）；
 *  - 意图在途（发意图 → commitIntent）期间的快照先暂存，结束后再补应用；
 *  - 应用快照会写 store，必须先调 suppressNextUpload() 再 importSaveJson()；
 *  - 本模块不持有游戏真值，P3 瘦终端化后仍可复用。
 */
import { useEffect, useState } from "react";
import { useGameStore } from "@/stores/useGameStore";
import { suppressNextUpload } from "./sync";
import {
  SESSION_STATE_EVENT, type SessionStateMessage,
  shouldApplySnapshot, noteRevision, isIntentInFlight, deferSnapshot,
} from "./sessionState";

export type SessionView = {
  slot: number;
  revision: number;
  online: number;
  updatedAt: number;
  source: string;
};

let view: SessionView | null = null;
const listeners = new Set<() => void>();

function setView(v: SessionView): void {
  view = v;
  for (const l of listeners) l();
}
export function getSessionView(): SessionView | null {
  return view;
}
export function subscribeSession(cb: () => void): () => void {
  listeners.add(cb);
  cb();
  return () => { listeners.delete(cb); };
}
/** Start 页展示「在线权威态 rev=N」；headless 冒烟也读这段文案。 */
export function useSessionStatus(): SessionView | null {
  const [state, setState] = useState<SessionView | null>(() => getSessionView());
  useEffect(() => subscribeSession(() => setState(getSessionView())), []);
  return state;
}

export type ApplyOutcome = "applied" | "ignored" | "deferred" | "invalid";

/** 处理一条下行快照。可直接调用，便于单测与意图结束后的补应用。 */
export function handleSessionState(m: SessionStateMessage): ApplyOutcome {
  if (!m || typeof m.slot !== "number" || typeof m.revision !== "number"
    || !Number.isFinite(m.revision) || typeof m.data !== "string") {
    return "invalid";
  }
  setView({
    slot: m.slot,
    revision: m.revision,
    online: typeof m.online === "number" ? m.online : 0,
    updatedAt: typeof m.updatedAt === "number" ? m.updatedAt : 0,
    source: typeof m.source === "string" ? m.source : "unknown",
  });
  if (isIntentInFlight()) {
    deferSnapshot(m);
    return "deferred";
  }
  return applySnapshot(m);
}

function applySnapshot(m: SessionStateMessage): ApplyOutcome {
  if (!shouldApplySnapshot(m)) return "ignored";
  // zustand.subscribe 同步触发；先抑制再写 store，否则会把远端快照又 PUT 回去。
  suppressNextUpload();
  // P3-1c：权威快照不是「换档」，不能打断正在进行的战斗。
  // 战斗态本来就不进存档，结算时快照到达恰恰是战斗结束的那一刻——
  // 若在这里清 battle，Arena 会直接从结算画面跳回「尚未开始遭遇」。
  const r = useGameStore.getState().importSaveJson(m.data, m.slot as 1 | 2 | 3, { keepBattle: true });
  if (!r.ok) return "invalid";
  noteRevision(m.slot, m.revision);
  return "applied";
}

/** 意图结束后补应用在途期间暂存的快照（可能已被本端提交追平而不应用）。 */
export function flushDeferredSnapshot(m: SessionStateMessage): ApplyOutcome {
  return handleSessionState(m);
}

let started = false;
/** 由 App 的全局组件挂载一次；重复调用幂等。 */
export function startSessionSync(): void {
  if (started || typeof window === "undefined") return;
  started = true;
  window.addEventListener(SESSION_STATE_EVENT, (e: Event) => {
    const detail = (e as CustomEvent<SessionStateMessage>).detail;
    if (detail) handleSessionState(detail);
  });
}
