/**
 * 会话新鲜度共享戳（W8.2）。
 *
 * 为什么会话不整体搬 Redis：`GameSessionState.data` 是**整份存档 JSON**，
 * 每次 `apply` 都写一份到 Redis 相当于给已有的一次 DB 写再翻一倍，
 * 而 DB 的 `Save` 表本来就已经是会话真值（`Save.revision` 列就是版本真值）。
 * 真正缺的不是数据，而是**「B 实例的内存副本是不是落后了」这个判断依据**。
 *
 * 做法：只共享一个整数——该账号当前最新 revision。
 *  - `commitState()` 提交成功后写戳；
 *  - 内存命中时比对戳：戳更大说明别的实例写过，丢弃内存副本回 DB 读。
 *
 * 降级策略：`store` 未装配（无 REDIS_URL 的单实例）或 Redis 读写失败，
 * 一律判定「不落后」——宁可偶尔读旧副本回退到 CAS 保护，也不能让读档路径依赖 Redis 可用性。
 */
import type { KvStore } from './kvStore';
import { SESSION_TTL_MS } from './gameSession';

/** 戳比会话本身多留 1 分钟：避免「会话还在、戳先没了」导致漏判。 */
export const SESSION_REV_TTL_MS = SESSION_TTL_MS + 60_000;

let store: KvStore | null = null;

/** 启动装配（`REDIS_URL` 已配置时注入）；传 null 关闭校验。 */
export function useSessionRevisionStore(next: KvStore | null): void {
  store = next;
}

/** 诊断用：是否已装配共享戳。 */
export function getSessionRevisionMode(): string {
  return store ? store.kind : 'off';
}

export function sessionRevisionKey(userId: string): string {
  return `sess:rev:${userId}`;
}

/** 提交成功后写戳；失败只吞掉错误（读档不能因为戳写失败而报错）。 */
export async function publishSessionRevision(userId: string, revision: number): Promise<void> {
  if (!store) return;
  try {
    await store.set(sessionRevisionKey(userId), String(revision), SESSION_REV_TTL_MS);
  } catch {
    /* 静默：戳只是优化，丢了最多多读一次 DB */
  }
}

/**
 * 内存副本是否落后于共享真值。
 * 未装配 / 无戳 / 读失败 → false（不落后），走原有「在线读内存」路径。
 */
export async function isSessionStale(userId: string, memRevision: number): Promise<boolean> {
  if (!store) return false;
  try {
    const raw = await store.get(sessionRevisionKey(userId));
    if (raw == null) return false;
    const n = Number(raw);
    return Number.isFinite(n) && n > memRevision;
  } catch {
    return false;
  }
}

/** 仅单测：清空装配状态。 */
export function resetSessionRevisionStoreForTest(): void {
  store = null;
}
