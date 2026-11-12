/**
 * 确定性单测模板（W0 / 设计定稿 §5.3）。
 *
 * W3 的「去掉锁必失败」、W4 的 leader 租约与 fencing、W6 的并发 CAS 与 TTL
 * 归还，都不能用 `Date.now()` + 真实定时器 —— 那会让用例随机器负载波动，
 * 偶尔绿偶尔红。统一从这里取可控时钟与可控 id，保证可复现。
 *
 * 约定：测试里**不调用** `Date.now()` / `setTimeout` 来推进时间，全部走
 * `clock.advance()`；需要真实让出事件循环时才用 `settle()`。
 */
export class DeterministicClock {
  private current: number;

  constructor(start = 0) {
    this.current = start;
  }

  now(): number {
    return this.current;
  }

  advance(ms: number): number {
    this.current += ms;
    return this.current;
  }

  set(ms: number): void {
    this.current = ms;
  }
}

/** 可预测的 id 序列，替代 crypto.randomUUID()，便于断言跨实例行为。 */
export function sequenceIds(prefix = 'id'): () => string {
  let n = 0;
  return () => `${prefix}-${++n}`;
}

/** 让出若干微任务 tick，用于等待 Promise 链尾清理（不推进虚拟时钟）。 */
export async function settle(times = 4): Promise<void> {
  for (let i = 0; i < times; i += 1) await Promise.resolve();
}
