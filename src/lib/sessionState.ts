/**
 * P2-2 前端会话态共享状态（零依赖）。
 *
 * 单独成模块是为了避免循环导入：ws.ts / sync.ts / intents.ts / session.ts
 * 都要读写「已见 revision / 是否有意图在途」，彼此之间不互相 import。
 */
export const SESSION_STATE_EVENT = "mpk:session-state";

export type SessionStateMessage = {
  type: "session.state";
  slot: number;
  revision: number;
  data: string;
  updatedAt: number;
  schemaVersion: string;
  source: "hydrate" | "put" | "intent";
  online: number;
};

/** 每个槽位最近一次「已被本地认可」的权威态版本号。 */
const lastSeen: Record<number, number> = {};
/** 正在进行的意图数量：发意图 → 提交裁决结果期间不能让远端快照覆盖本地。 */
let inFlight = 0;
/** 意图在途期间暂存的最后一份快照，意图结束后再判断是否应用。 */
let deferred: SessionStateMessage | null = null;

export function getLastSeenRevision(slot: number): number {
  return lastSeen[slot] ?? -1;
}

/** 本端 PUT 成功后也要记下 revision，否则自己的回显快照会被当成远端更新重复应用。 */
export function noteRevision(slot: number, revision: number): void {
  if (typeof revision !== "number" || !Number.isFinite(revision)) return;
  if (revision > getLastSeenRevision(slot)) lastSeen[slot] = revision;
}

export function shouldApplySnapshot(m: SessionStateMessage): boolean {
  return inFlight === 0 && m.revision > getLastSeenRevision(m.slot);
}

export function beginIntent(): void {
  inFlight += 1;
}

/** 意图结束；返回在途期间暂存、需要补应用的最新快照。 */
export function endIntent(): SessionStateMessage | null {
  inFlight = Math.max(0, inFlight - 1);
  if (inFlight === 0 && deferred) {
    const d = deferred;
    deferred = null;
    return d;
  }
  return null;
}

export function isIntentInFlight(): boolean {
  return inFlight > 0;
}

export function deferSnapshot(m: SessionStateMessage): void {
  deferred = m;
}

/** 仅用于单测复位，不在业务路径调用。 */
export function resetSessionStateForTest(): void {
  for (const k of Object.keys(lastSeen)) delete lastSeen[k as any];
  inFlight = 0;
  deferred = null;
}
