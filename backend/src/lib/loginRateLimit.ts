/**
 * 登录失败限流（A5）。
 *
 * 设计取舍：
 * - **只计失败**，登录成功立即清掉该账号记录。正常玩家、以及 verify 里 25 组
 *   E2E 的高频注册 / 登录完全不消耗配额，不会被误挡。
 * - 双维度：`IP + 用户名` 组合键防针对单账号的撞库；纯 IP 键是兜底，防同一
 *   来源横扫大量账号。两者阈值差一个数量级，避免正常批量测试误触发 IP 桶。
 * - **可重建的单进程临时态**：丢了只是让攻击者多试几次，不影响任何玩家权益，
 *   也不写 DB。P5-1 迁共享存储时把计数改到 Redis（带 TTL）即可，接口不用变。
 */
export type RateLimitDecision = { allowed: boolean; retryAfter: number };

type Bucket = { failures: number; windowStart: number };

export type LoginRateLimiterOptions = {
  /** 计数窗口长度（毫秒），默认 60s */
  windowMs?: number;
  /** 组合键窗口内允许的失败次数，默认 5 */
  maxFailures?: number;
  /** 纯 IP 键窗口内允许的失败次数，默认 60 */
  maxIpFailures?: number;
  /** 注入时钟，便于单测 */
  now?: () => number;
};

export class LoginRateLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly windowMs: number;
  private readonly maxFailures: number;
  private readonly maxIpFailures: number;
  private readonly now: () => number;

  constructor(opts: LoginRateLimiterOptions = {}) {
    this.windowMs = Math.max(1, opts.windowMs ?? 60_000);
    this.maxFailures = Math.max(1, opts.maxFailures ?? 5);
    this.maxIpFailures = Math.max(1, opts.maxIpFailures ?? 60);
    this.now = opts.now ?? (() => Date.now());
  }

  static comboKey(ip: string, username: string): string {
    return `combo:${ip}|${username.trim().toLowerCase()}`;
  }

  static ipKey(ip: string): string {
    return `ip:${ip}`;
  }

  /** 返回该键还需等待的秒数；0 表示未超限。顺手清掉过期桶。 */
  private remaining(key: string, limit: number, now: number): number {
    const bucket = this.buckets.get(key);
    if (!bucket) return 0;
    const age = now - bucket.windowStart;
    if (age >= this.windowMs) {
      this.buckets.delete(key);
      return 0;
    }
    if (bucket.failures < limit) return 0;
    return Math.max(1, Math.ceil((this.windowMs - age) / 1000));
  }

  /** 请求前检查，不消费配额；只有 recordFailure() 才计入。 */
  check(ip: string, username: string): RateLimitDecision {
    const now = this.now();
    const retryAfter = Math.max(
      this.remaining(LoginRateLimiter.comboKey(ip, username), this.maxFailures, now),
      this.remaining(LoginRateLimiter.ipKey(ip), this.maxIpFailures, now),
    );
    return { allowed: retryAfter === 0, retryAfter };
  }

  private bump(key: string, now: number): void {
    const bucket = this.buckets.get(key);
    if (!bucket || now - bucket.windowStart >= this.windowMs) {
      this.buckets.set(key, { failures: 1, windowStart: now });
    } else {
      bucket.failures += 1;
    }
  }

  recordFailure(ip: string, username: string): void {
    const now = this.now();
    this.bump(LoginRateLimiter.comboKey(ip, username), now);
    this.bump(LoginRateLimiter.ipKey(ip), now);
  }

  /** 登录成功清空组合键；纯 IP 兜底桶保留，成功登录不该洗掉撞库痕迹。 */
  clear(ip: string, username: string): void {
    this.buckets.delete(LoginRateLimiter.comboKey(ip, username));
  }

  /** 仅供单测 / 运行期观察，不暴露任何玩家真值。 */
  get size(): number {
    return this.buckets.size;
  }
}

export const loginRateLimiter = new LoginRateLimiter();
