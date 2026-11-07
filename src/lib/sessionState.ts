/**
 * P2-2 前端会话态共享状态（零依赖）。
 *
 * 单独成模块是为了避免循环导入：ws.ts / sync.ts / intents.ts / session.ts
 * 都要读写「已见 revision / 是否有意图在途」，彼此之间不互相 import。
 */
export const SESSION_STATE_EVENT = "mpk:session-state";
/** P4-1b 共享野怪：服务端全量广播的区域野怪列表。 */
export const WILD_STATE_EVENT = "mpk:wild-state";

export type SessionStateMessage = {
  type: "session.state";
  slot: number;
  revision: number;
  data: string;
  updatedAt: number;
  schemaVersion: string;
  source: "hydrate" | "put" | "intent" | "battle" | "action";
  online: number;
};

/** P4-1b：共享野怪的公开视图（不含归属 userId，避免泄露他人账号）。 */
export type WildMonsterView = {
  id: string;
  areaId: string;
  speciesId: string;
  name: string;
  level: number;
  label: string;
  status: "available" | "claimed" | "resolved";
  result: "captured" | "defeated" | "fled" | null;
  expiresAt: number;
};

export type WildStateMessage = {
  type: "wild.state";
  areaId: string;
  revision: number;
  monsters: WildMonsterView[];
};

/** 每个槽位最近一次「已被本地认可」的权威态版本号（-1 = 尚未建立基线）。 */
const lastSeen: Record<number, number> = {};
/** 正在进行的意图数量：发意图 → 提交裁决结果期间不能让远端快照覆盖本地。 */
let inFlight = 0;
/** 意图在途期间暂存的最后一份快照，意图结束后再判断是否应用。 */
let deferred: SessionStateMessage | null = null;

export function getLastSeenRevision(slot: number): number {
  return lastSeen[slot] ?? -1;
}

/**
 * P4：写入用的基线版本号，未知时返回 null。
 * 与 getLastSeenRevision 的区别：-1 是「不知道」，0 是「知道，且服务端还没有存档」，
 * 两者在 CAS 里语义完全不同（后者是新建存档的合法基线），不能混用。
 */
export function getWriteRevision(slot: number): number | null {
  const v = lastSeen[slot];
  return typeof v === "number" && v >= 0 ? v : null;
}

/** 本端 PUT 成功后也要记下 revision，否则自己的回显快照会被当成远端更新重复应用。 */
export function noteRevision(slot: number, revision: number): void {
  if (typeof revision !== "number" || !Number.isFinite(revision)) return;
  if (revision > getLastSeenRevision(slot)) lastSeen[slot] = revision;
}

/**
 * 强制覆盖本地记录的版本号（登录 / 换账号 / 冲突自愈后使用）。
 * 与 noteRevision 的「只增」不同：换账号时新账号的 revision 可能更小，
 * 只增策略会让本地一直带着旧账号的版本号去写，触发无谓的 409。
 */
export function setRevision(slot: number, revision: number): void {
  if (typeof revision !== "number" || !Number.isFinite(revision) || revision < 0) return;
  lastSeen[slot] = revision;
}

/** 登出时清空所有槽位的版本号，避免下一个账号继承。 */
export function forgetAllRevisions(): void {
  for (const k of Object.keys(lastSeen)) delete lastSeen[k as any];
}

/**
 * P4-1a 顶号：被顶设备进入「只读下线态」。
 * 一旦置位，api.request 会拒绝发出任何业务请求（含 GET），
 * 保证本地未上传的改动不会被偷偷同步上去 —— 杰哥定的口径是不合并、直接下线。
 * 重新登录（setToken）时复位。
 */
let suspended = false;
export function isSessionSuspended(): boolean {
  return suspended;
}
export function setSessionSuspended(value: boolean): void {
  suspended = value;
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
