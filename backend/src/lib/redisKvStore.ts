/**
 * KV 存储的 Redis 实现（W8.0）。
 *
 * Key 由调用方给定（`gym:cd:*` / `battle:*` / `sess:rev:*`），本层不假设命名。
 * `prefix` 只在测试里非空，用来把测试键与常驻 :3001 的真值隔开——W7 同款做法。
 *
 * 安全约束：
 *  - `keys()` 用 SCAN 游标遍历，**不用 KEYS**（KEYS 在大库上会阻塞整个 Redis）；
 *  - `clear()` 只删本 prefix 管辖的键，拒绝无前缀全库清空（防测试误删生产真值）。
 */
import type Redis from 'ioredis';
import { ACQUIRE_SCRIPT, type AcquireResult, type KvStore } from './kvStore';

export type RedisKvStoreOptions = {
  client: Redis;
  /** 仅测试用；生产为空串。 */
  prefix?: string;
};

/** 单次 SCAN 的批量；1000 是「足够快又不长时间占住事件循环」的经验值。 */
const SCAN_BATCH = 1000;

export class RedisKvStore implements KvStore {
  private readonly client: Redis;
  private readonly prefix: string;

  constructor(opts: RedisKvStoreOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? '';
  }

  get kind(): string {
    return 'redis';
  }

  private k(key: string): string {
    return `${this.prefix}${key}`;
  }

  async get(key: string): Promise<string | null> {
    return this.client.get(this.k(key));
  }

  async set(key: string, value: string, ttlMs = 0): Promise<void> {
    if (ttlMs > 0) await this.client.psetex(this.k(key), ttlMs, value);
    else await this.client.set(this.k(key), value);
  }

  async acquire(key: string, value: string, ttlMs = 0): Promise<AcquireResult> {
    const raw = await this.client.eval(
      ACQUIRE_SCRIPT, 1, this.k(key), value, String(Math.floor(ttlMs)),
    ) as [number, string | null];
    const ok = Number(raw?.[0]) === 1;
    const current = raw?.[1] ?? null;
    return { ok, current };
  }

  async del(key: string): Promise<number> {
    return this.client.del(this.k(key));
  }

  async keys(prefix: string): Promise<string[]> {
    const match = `${this.k(prefix)}*`;
    const out: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(cursor, 'MATCH', match, 'COUNT', SCAN_BATCH);
      cursor = next;
      // 去掉本实例前缀，让调用方拿到的 key 与传入的命名空间一致。
      for (const full of batch) out.push(full.slice(this.prefix.length));
    } while (cursor !== '0');
    return out;
  }

  async pttl(key: string): Promise<number> {
    return this.client.pttl(this.k(key));
  }

  /**
   * 只清本 prefix 管辖的键。生产 prefix 为空串时**拒绝执行**，
   * 否则一次误调用就会清空共享真值（野怪池 / 房间 / 战斗全没）。
   */
  async clear(): Promise<void> {
    if (!this.prefix) {
      throw new Error('RedisKvStore.clear() 在生产前缀（空串）下被禁用：会清除共享真值');
    }
    const all = await this.keys('');
    if (all.length === 0) return;
    // 分批 DEL，避免一次传几千个 key 撑爆单条命令。
    for (let i = 0; i < all.length; i += SCAN_BATCH) {
      await this.client.del(...all.slice(i, i + SCAN_BATCH).map((k) => this.k(k)));
    }
  }
}
