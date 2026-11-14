/**
 * KV 存储的内存实现（W8.0）。
 *
 * 用途：无 `REDIS_URL` 的单实例开发与单测基线。语义与 Redis 实现逐条对齐：
 *  - TTL 到期后用「惰性判定」视为不存在（不需要定时器）；
 *  - `acquire` 在 Node 单线程下天然原子（无 await 打断）；
 *  - `keys` 遍历时顺带清理过期项，避免长跑进程泄漏（原 `gyms.ts` 的 Map 就没有清理）。
 */
import type { AcquireResult, KvStore } from './kvStore';

type Entry = { value: string; expireAt: number };

export class MemoryKvStore implements KvStore {
  /** 单测注入时钟，便于确定性验证 TTL。 */
  private readonly now: () => number;
  private readonly map = new Map<string, Entry>();

  constructor(opts: { now?: () => number } = {}) {
    this.now = opts.now ?? Date.now;
  }

  get kind(): string {
    return 'memory';
  }

  private alive(key: string): Entry | null {
    const e = this.map.get(key);
    if (!e) return null;
    if (e.expireAt > 0 && e.expireAt <= this.now()) {
      this.map.delete(key);
      return null;
    }
    return e;
  }

  async get(key: string): Promise<string | null> {
    return this.alive(key)?.value ?? null;
  }

  async set(key: string, value: string, ttlMs = 0): Promise<void> {
    this.map.set(key, { value, expireAt: ttlMs > 0 ? this.now() + ttlMs : 0 });
  }

  async acquire(key: string, value: string, ttlMs = 0): Promise<AcquireResult> {
    const cur = this.alive(key);
    if (cur) return { ok: false, current: cur.value };
    this.map.set(key, { value, expireAt: ttlMs > 0 ? this.now() + ttlMs : 0 });
    return { ok: true, current: value };
  }

  async del(key: string): Promise<number> {
    return this.map.delete(key) ? 1 : 0;
  }

  async keys(prefix: string): Promise<string[]> {
    const out: string[] = [];
    for (const key of [...this.map.keys()]) {
      if (!this.alive(key)) continue;
      if (key.startsWith(prefix)) out.push(key);
    }
    return out;
  }

  async pttl(key: string): Promise<number> {
    const e = this.alive(key);
    if (!e) return -2;
    if (e.expireAt <= 0) return -1;
    return Math.max(0, e.expireAt - this.now());
  }

  async clear(): Promise<void> {
    this.map.clear();
  }
}
