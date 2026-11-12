/**
 * 锁提供者抽象（W0 / P5-1 批次 A）。
 *
 * 目的：W3 要换成 Redis `SET NX PX` 租约锁，但 6 个调用模块、账号锁 → 子锁的
 * 顺序、`alreadyLocked` 非重入旁路都不该跟着改一遍。W0 先把「怎么排队列」
 * 从 `slotLock.ts` 抽成接口，调用点与行为完全不变，后续只替换实现。
 *
 * 契约（与 W0 前的 `chains: Map` 实现逐条对齐）：
 *  1. 同一 key 严格串行：后一个 fn 必须等前一个 Promise 结束才开始；
 *  2. 前一个任务 reject 不阻断后续任务（两个 then 回调都指向 fn）；
 *  3. 队列尾巴吞掉结果，避免 unhandled rejection；
 *  4. 队尾跑完且没有新任务排队时清理该 key，Map 不随账号数无限增长。
 *
 * W3 的 Redis 实现必须保留这四条，尤其是 `alreadyLocked` 旁路 —— 若把
 * `SET NX` 实现成轮询等待，同一次请求内重复取锁会自我死锁（bug_log §36）。
 */
export interface LockProvider {
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** 仅诊断：当前有多少个 key 存在排队链。 */
  activeKeys(): number;
  /** 仅单测：清空排队状态。 */
  clear(): void;
}

/** 单实例时期的进程内实现：按 key 串 Promise 链（W0 前逐字等价）。 */
export class InProcessLockProvider implements LockProvider {
  private readonly chains = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve();
    const run = prev.then(fn, fn);
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    this.chains.set(key, tail);
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key);
    });
    return run;
  }

  activeKeys(): number {
    return this.chains.size;
  }

  clear(): void {
    this.chains.clear();
  }
}
