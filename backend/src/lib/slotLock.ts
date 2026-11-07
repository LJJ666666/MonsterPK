/**
 * 槽位级串行化（P4 前置）。
 *
 * 为什么需要：CAS 的正确性依赖「读当前版本 → 比对 → 写」这三步不可分割。
 * Node 是单线程，但 `await prisma.save.findUnique()` 会让出事件循环 ——
 * 两个并发 PUT 完全可能都读到 rev=5、都通过校验、然后都写，最后一条覆盖前一条，
 * 版本号却只涨了一次（monotonicAuthority 按进程内序 +1）。这就是典型的 TOCTOU。
 *
 * 做法：按 `userId:slot` 串行排队，把「校验 + 写」整体关进临界区。
 * 单进程部署下这就足够了；将来多实例部署要换成 DB 层的条件更新或分布式锁
 * （SQLite → Postgres 时可在事务里 `UPDATE ... WHERE revision = ?` 拿到行锁）。
 *
 * 注意：**只锁路由层**，`commitState()` 本身不再取锁，否则同一次请求会自我死锁。
 */
const chains = new Map<string, Promise<unknown>>();

export function slotLockKey(userId: string, slot: number): string {
  return `${userId}:${slot}`;
}

/**
 * 在槽位临界区内执行 fn。
 * 前一个任务失败不能阻断后续任务，所以 then 的两个回调都指向 fn 的调用。
 */
export function withSlotLock<T>(key: string, fn: () => Promise<T>): Promise<T> {
  const prev = chains.get(key) ?? Promise.resolve();
  const run = prev.then(fn, fn);
  // 队列尾巴只用于排队，不承载结果；失败已在 run 上体现，这里吞掉避免 unhandled rejection。
  const tail = run.then(
    () => undefined,
    () => undefined,
  );
  chains.set(key, tail);
  // 队尾跑完且没有新任务排队时清理，避免 Map 随账号数无限增长。
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key);
  });
  return run;
}

/** 仅用于单测：清空排队状态。 */
export function clearSlotLocksForTest(): void {
  chains.clear();
}

/** 仅用于诊断：当前有多少个槽位存在排队链。 */
export function activeSlotLocks(): number {
  return chains.size;
}
