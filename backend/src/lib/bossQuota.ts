/**
 * P4-2c Boss 每日次数的「在途闸」——W6.4 升级为 token 租约模型。
 *
 * 与 `RoomRegistry` 的 quota 三段式（hold → commit → release）语义一致，但有一处关键差异：
 * **已用次数的真值在数据库**（`BossDamageEvent` 行数），内存只记「已经开始但还没结算」的 hold。
 *
 * W6.4 改造要点：
 *  - hold 改为返回 `{ ok, token }`：成功时 token 是唯一租约标识；
 *  - release / commit 按 token 幂等：迟到释放 / 重复释放 / 已被 reap 的租约都是 no-op，
 *    绝不会误扣「同名 key 上的新租约」（防 ABA 超卖）；
 *  - 租约带 TTL（≥30min），过期由 sweep 的 `reapExpired` 回收，避免开局后进程长期挂起导致名额泄漏；
 *  - 补齐所有 release 分支（battle.ts / mapBoss.ts / realtime.ts 共 8 处）。
 *
 * 并发：`hold()` 等全部是同步 Map 操作，Node 单线程下不会交错；跨槽位的「读 DB 已用次数 → hold」
 * 由路由层用 `withSlotLock('bossq:<userId>')` 串行（锁顺序统一为 账号锁 → bossq 锁，无死锁）。
 */
import { randomUUID } from 'node:crypto';

/** 租约 TTL：30min，≥ 战斗 TTL（BATTLE_TTL_MS）。两者都靠 token 幂等释放，不会重复回收。 */
const LEASE_TTL_MS = 30 * 60 * 1000;

export type QuotaUsage = { held: number; committed: number };

type Lease = { key: string; expireAt: number };

export class BossQuotaLedger {
  /** token → 租约记录。 */
  private readonly leases = new Map<string, Lease>();
  /** key → 在途租约数量（不含已入库的 committed）。 */
  private readonly counts = new Map<string, number>();
  /** 租约 TTL（默认 30min），可注入以便单测确定性回收。 */
  private readonly leaseTtlMs: number;

  constructor(leaseTtlMs: number = LEASE_TTL_MS) {
    this.leaseTtlMs = leaseTtlMs;
  }

  /**
   * 占一个在途名额。`used` 由调用方从 DB 读出（同一周期同一 Boss 的已结算次数）。
   * 返回 `{ ok, token }`：成功时 ok=true 且 token 为唯一租约标识（结算/放弃时凭它释放）；
   * 已满（不抛异常，由路由层映射成 429）时 ok=false、token=null。
   */
  hold(key: string, used: number, limit: number): { ok: boolean; token: string | null } {
    const inflight = this.counts.get(key) ?? 0;
    const committed = Number.isFinite(used) ? Math.max(0, Math.floor(used)) : 0;
    const cap = Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 0;
    if (committed + inflight >= cap) return { ok: false, token: null };
    const token = randomUUID();
    this.leases.set(token, { key, expireAt: Date.now() + this.leaseTtlMs });
    this.counts.set(key, inflight + 1);
    return { ok: true, token };
  }

  /** 正常结算：在途名额转为「已用」——已用由 DB 事件体现，这里只释放 hold。 */
  commit(token: string): void {
    this.release(token);
  }

  /**
   * 逃跑 / 放弃 / TTL 回收 / 开局失败：释放在途名额，不扣次数。
   * 按 token 幂等：token 不存在 / 已释放 / 已过期都视为 no-op，
   * 不会误扣同名 key 上的新租约（ABA 防护的核心）。
   */
  release(token: string): void {
    const lease = this.leases.get(token);
    if (!lease) return; // 已释放 / 已过期 / 未知 token —— 防 ABA 的关键
    this.leases.delete(token);
    const cur = this.counts.get(lease.key) ?? 0;
    if (cur <= 1) this.counts.delete(lease.key);
    else this.counts.set(lease.key, cur - 1);
  }

  /** 当前 key 的在途租约数量（只读视图用）。 */
  heldOf(key: string): number {
    return this.counts.get(key) ?? 0;
  }

  /** 回收到期租约，返回本次回收数量（供 sweep 日志 / 健康排查）。 */
  reapExpired(now: number): number {
    let reaped = 0;
    for (const [token, lease] of this.leases) {
      if (lease.expireAt <= now) {
        this.leases.delete(token);
        const cur = this.counts.get(lease.key) ?? 0;
        if (cur <= 1) this.counts.delete(lease.key);
        else this.counts.set(lease.key, cur - 1);
        reaped++;
      }
    }
    return reaped;
  }

  /** 只读视图（health / 排查用），不含账号信息。 */
  usageOf(key: string, used = 0): QuotaUsage {
    return { held: this.heldOf(key), committed: Math.max(0, Math.floor(used)) };
  }

  stats() {
    let held = 0;
    for (const n of this.counts.values()) held += n;
    // 租约总数与在途计数之差 = 已过期但尚未被 reap 的残留（健康观察用）。
    return { keys: this.counts.size, held, leases: this.leases.size, expired: this.leases.size - held };
  }
}
