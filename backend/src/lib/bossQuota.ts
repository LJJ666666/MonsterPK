/**
 * P4-2c Boss 每日次数的「在途闸」。
 *
 * 与 `RoomRegistry` 的 quota 三段式（hold → commit → release）语义一致，但有一处关键差异：
 * **已用次数的真值在数据库**（`BossDamageEvent` 行数），内存只记「已经开始但还没结算」的 hold。
 *
 * 为什么不能像房间那样把 committed 放内存：
 *  - 房间是 30 分钟生命周期的临时态，进程重启后房间本来就不存在，内存计数够用；
 *  - Boss 次数是**按自然日**的账号级配额，进程重启不能把次数重置（否则重启即刷榜）。
 *
 * 并发：`hold()` 是同步 Map 操作，Node 单线程下不会交错；跨槽位的「读 DB 已用次数 → hold」
 * 由路由层用 `withSlotLock('bossq:<userId>')` 串行（锁顺序统一为 槽位锁 → bossq 锁，无死锁）。
 */
export type QuotaUsage = { held: number; committed: number };

export class BossQuotaLedger {
  /** key → 在途数量（不含已入库的 committed）。 */
  private readonly held = new Map<string, number>();

  /**
   * 占一个在途名额。`used` 由调用方从 DB 读出（同一周期同一 Boss 的已结算次数）。
   * 返回 false 表示已满 —— **不抛异常**，由路由层映射成 429。
   */
  hold(key: string, used: number, limit: number): boolean {
    const inflight = this.held.get(key) ?? 0;
    const committed = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (committed + inflight >= cap) return false;
    this.held.set(key, inflight + 1);
    return true;
  }

  /** 正常结算：在途名额转为「已用」——已用由 DB 事件体现，这里只释放 hold。 */
  commit(key: string): void {
    this.release(key);
  }

  /** 逃跑 / 放弃 / TTL 回收 / 开局失败：释放在途名额，不扣次数。 */
  release(key: string): void {
    const cur = this.held.get(key) ?? 0;
    if (cur <= 1) this.held.delete(key);
    else this.held.set(key, cur - 1);
  }

  heldOf(key: string): number {
    return this.held.get(key) ?? 0;
  }

  /** 只读视图（health / 排查用），不含账号信息。 */
  usageOf(key: string, used = 0): QuotaUsage {
    return { held: this.heldOf(key), committed: Math.max(0, Math.floor(used)) };
  }

  stats() {
    let held = 0;
    for (const n of this.held.values()) held += n;
    return { keys: this.held.size, held };
  }
}
