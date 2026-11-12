/**
 * W3 分布式租约锁（P5-1 / F10 批次 B，设计定稿 §3.2）。
 *
 * 替换 W0 的 `InProcessLockProvider`，通过 `setLockProvider()` 注入 —— 6 个调用模块、
 * 「账号锁 → 子锁」顺序、`alreadyLocked` 旁路语义全部零改动（W0 接口化的收益）。
 *
 * 与单进程实现的语义差异（必须知道）：
 *  - 进程内实现是 Promise 链，**严格 FIFO**；Redis 锁只保证「同一 key 不同时执行」，
 *    不保证先到先得。正确性不依赖顺序：W2 的 `UPDATE ... WHERE revision=?` 是最后裁决。
 *  - 原来的重复取锁会自我死锁；这里用 `AsyncLocalStorage` 记当前调用链已持有的 key，
 *    命中即直接执行 fn，保留 `alreadyLocked` 的非重入旁路语义。
 *  - 锁有租约：`SET NX PX` + watchdog 续租，避免进程崩溃后 key 永久残留；
 *    `acquireTimeoutMs` 让「不同实例各持不同层级锁成环」最终报错而不是永久挂死
 *    （定稿 §1#7：锁顺序的真正风险，W6 统一层级前靠超时兜底）。
 *
 * 设计定稿明确的边界：**fencing token 不用于存档写**（revision 单调本身就是 fence），
 * 这里 token 只服务于安全续租与安全释放；存档写仍由 DB 条件更新兜底。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { LockProvider } from './lockProvider';
import type { RedisLockBackend } from './redisLockBackend';

/** 租约 TTL：定稿要求远大于房间 250ms tick，按 rank:settle / Boss 结算 P99 留足。 */
export const LOCK_TTL_MS = 30_000;
/** watchdog 续租间隔：TTL 的 1/3，网络抖动下仍有两次重试机会。 */
export const LOCK_RENEW_INTERVAL_MS = 10_000;
/** 抢锁最长等待：超时明确抛错，绝不静默放行。 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 30_000;

/**
 * 命名空间：把 W0 的裸 key 映射到 Redis key，避免与其它业务 key 冲突。
 * 调用侧 `slotLockKey()` / `roomLockKey()` 的返回值保持不变（单测断言钉住）。
 */
export function lockNamespaceOf(key: string): string {
  if (key.startsWith('room:')) return `lock:room:${key.slice('room:'.length)}`;
  if (key.startsWith('bossq:')) return `lock:bossq:${key.slice('bossq:'.length)}`;
  if (key.startsWith('mapbossq:')) return `lock:mapbossq:${key.slice('mapbossq:'.length)}`;
  if (key.startsWith('rank:settle:')) return `lock:rank:${key.slice('rank:settle:'.length)}`;
  return `lock:acct:${key}`;
}

export interface LockScheduler {
  setInterval(fn: () => void, ms: number): unknown;
  clearInterval(handle: unknown): void;
}

export interface RedisLockOptions {
  ttlMs?: number;
  renewIntervalMs?: number;
  acquireTimeoutMs?: number;
  /** 抢锁最大尝试次数：时钟回拨 / 虚拟时钟不前进时也不会无限轮询。 */
  maxAttempts?: number;
  retryMinMs?: number;
  retryMaxMs?: number;
  /** 注入调度器/时钟/随机器，让 watchdog 与重试在单测里完全确定性。 */
  scheduler?: LockScheduler;
  sleep?: (ms: number) => Promise<void>;
  now?: () => number;
  random?: () => number;
  onLeaseLost?: (key: string) => void;
}

const defaultScheduler: LockScheduler = {
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: (h) => clearInterval(h as ReturnType<typeof setInterval>),
};

export class LockAcquireTimeoutError extends Error {
  constructor(public readonly key: string) {
    super(`LOCK_ACQUIRE_TIMEOUT: ${key}`);
    this.name = 'LockAcquireTimeoutError';
  }
}

export class RedisLockProvider implements LockProvider {
  private readonly backend: RedisLockBackend;
  private readonly ttlMs: number;
  private readonly renewIntervalMs: number;
  private readonly acquireTimeoutMs: number;
  private readonly maxAttempts: number;
  private readonly retryMinMs: number;
  private readonly retryMaxMs: number;
  private readonly scheduler: LockScheduler;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly onLeaseLost: (key: string) => void;
  /** 当前异步调用链已持有的 W0 key（裸 key，不命名空间化）。 */
  private readonly held = new AsyncLocalStorage<Set<string>>();
  /** 本进程在途锁数，供 activeKeys() 诊断与单测清理断言。 */
  private readonly inflight = new Set<string>();

  constructor(backend: RedisLockBackend, options: RedisLockOptions = {}) {
    this.backend = backend;
    this.ttlMs = options.ttlMs ?? LOCK_TTL_MS;
    this.renewIntervalMs = options.renewIntervalMs ?? LOCK_RENEW_INTERVAL_MS;
    this.acquireTimeoutMs = options.acquireTimeoutMs ?? LOCK_ACQUIRE_TIMEOUT_MS;
    this.retryMinMs = options.retryMinMs ?? 8;
    // 时钟回拨 / 虚拟时钟不前进时也不能无限轮询；默认按超时与最小退避折算。
    this.maxAttempts = options.maxAttempts
      ?? Math.ceil(this.acquireTimeoutMs / Math.max(1, this.retryMinMs)) + 10;
    this.retryMaxMs = options.retryMaxMs ?? 40;
    this.scheduler = options.scheduler ?? defaultScheduler;
    this.sleep = options.sleep ?? ((ms) => new Promise<void>((r) => setTimeout(r, ms)));
    this.now = options.now ?? Date.now;
    this.random = options.random ?? Math.random;
    this.onLeaseLost =
      options.onLeaseLost ??
      ((key) => console.warn(`[W3] 租约已易主或丢失，DB 条件更新将兜底：${key}`));
  }

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const parent = this.held.getStore();
    // SET NX 非重入：同一调用链重复取同一把锁必须直接放行，否则自我死锁。
    if (parent?.has(key)) return fn();
    return this.acquireAndRun(key, fn, parent);
  }

  private async acquireAndRun<T>(
    key: string,
    fn: () => Promise<T>,
    parent: Set<string> | undefined,
  ): Promise<T> {
    const nsKey = lockNamespaceOf(key);
    const token = `${process.pid}:${randomUUID()}`;
    const deadline = this.now() + this.acquireTimeoutMs;
    let acquired = false;
    let attempts = 0;

    while (!acquired) {
      acquired = await this.backend.acquire(nsKey, token, this.ttlMs);
      if (acquired) break;
      attempts += 1;
      if (this.now() >= deadline || attempts >= this.maxAttempts) {
        throw new LockAcquireTimeoutError(key);
      }
      // 抖动退避，避免同 key 的多个等待者同步惊群。
      const span = Math.max(0, this.retryMaxMs - this.retryMinMs);
      await this.sleep(this.retryMinMs + Math.floor(this.random() * (span + 1)));
    }

    this.inflight.add(nsKey);
    let released = false;
    let renewTimer: unknown;
    const watchdog = () => {
      void this.backend
        .renew(nsKey, token, this.ttlMs)
        .then((ok) => {
          // fn 已结束/renew 在 release 之后返回都属正常，不必告警。
          if (!ok && !released) this.onLeaseLost(nsKey);
        })
        .catch((e) => {
          if (!released) console.warn(`[W3] watchdog 续租异常：${String(e?.message ?? e)}`);
        });
    };
    renewTimer = this.scheduler.setInterval(watchdog, this.renewIntervalMs);

    const childHeld = new Set(parent ?? []);
    childHeld.add(key);
    try {
      return await this.held.run(childHeld, fn);
    } finally {
      released = true;
      this.scheduler.clearInterval(renewTimer);
      try {
        await this.backend.release(nsKey, token);
      } catch (e) {
        // 释放失败不能吞掉业务结果；租约 TTL 会兜底自动过期。
        console.warn(`[W3] 释放锁异常（TTL 将兜底）：${String(e?.message ?? e)}`);
      }
      this.inflight.delete(nsKey);
    }
  }

  activeKeys(): number {
    return this.inflight.size;
  }

  clear(): void {
    this.inflight.clear();
  }
}
