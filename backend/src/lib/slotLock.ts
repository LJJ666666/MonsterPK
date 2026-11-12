/**
 * 账号级串行化（P4 前置，F17 起一账号一档）。
 *
 * 为什么需要：CAS 的正确性依赖「读当前版本 → 比对 → 写」这三步不可分割。
 * Node 是单线程，但 `await prisma.save.findUnique()` 会让出事件循环 ——
 * 两个并发 PUT 完全可能都读到 rev=5、都通过校验、然后都写，最后一条覆盖前一条，
 * 版本号却只涨了一次（旧版由进程内序 +1）。这就是典型的 TOCTOU；W2 起
 * 版本号由 Save.revision 列的条件更新裁决，锁不再是版本递增的保证。
 *
 * 做法：按 `userId` 串行排队，把「校验 + 写」整体关进临界区。
 * 单进程部署下这就足够了；W3 会换成 Redis 租约锁（改 `setLockProvider` 注入实现即可），
 * 最终由 DB 条件更新兜底（W1 已切 Postgres，W2 落地 `UPDATE ... WHERE revision = ?`）。
 *
 * 注意：**只锁路由层**，`commitState()` 本身不再取锁，否则同一次请求会自我死锁。
 *
 * W0：队列实现已抽到 `lib/lockProvider.ts`，本文件只保留 key 规则与薄封装，
 * 全部导出名与调用顺序不变（零行为变更）。
 */
import { InProcessLockProvider, type LockProvider } from './lockProvider';

let provider: LockProvider = new InProcessLockProvider();

/** W3 注入 Redis 租约锁；调用点与锁顺序零改动。 */
export function setLockProvider(next: LockProvider): void {
  provider = next;
}

export function getLockProvider(): LockProvider {
  return provider;
}

/** 仅单测：恢复进程内默认实现，避免注入污染其它用例。 */
export function resetLockProviderForTest(): void {
  provider = new InProcessLockProvider();
}

/** 账号锁 key：一账号一档，直接以 userId 排队（历史名保留）。 */
export function slotLockKey(userId: string): string {
  return userId;
}

/**
 * P4-2b：房间状态的串行化键。与账号锁共用同一条队列实现，
 * 只是 key 加 `room:` 前缀 —— 锁本身零改动，满足契约「薄封装」的要求。
 * 房间 owner key 是 `roomId`，一个房间的所有写操作必须排在同一条链上。
 */
export function roomLockKey(roomId: string): string {
  return `room:${roomId}`;
}

export function withRoomLock<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  return withSlotLock(roomLockKey(roomId), fn);
}

/** 在账号临界区内执行 fn（委托给当前 LockProvider）。 */
export function withSlotLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return provider.run(key, fn);
}

/** 仅用于单测：清空排队状态。 */
export function clearSlotLocksForTest(): void {
  provider.clear();
}

/** 仅用于诊断：当前有多少个账号存在排队链。 */
export function activeSlotLocks(): number {
  return provider.activeKeys();
}
