/**
 * 共享野怪实例池（P4-1b；W7 起存储可替换）。
 *
 * 本文件是 **facade**：只做两件事
 *  1. 内容生成 —— 种族 / 等级 / 稀有度 / label 全靠服务端 RNG 与内容表算，
 *     由 `spawner` 闭包持有 `rng` 与 `seq`（Lua 里查不到 `THEME_TABLE`，生成必须在 Node 侧）；
 *  2. 参数收敛 —— 把 perArea / ttlMs / claimTtlMs / graceMs 连同 spawner 一起交给 storage。
 *
 * 状态真值在 `WildStorage`：未配 Redis 时是进程内 Map（`MemoryWildStorage`），
 * 配了 `REDIS_URL` 时是 Redis + Lua（`RedisWildStorage`）。W7 之前只有内存实现，
 * 因此「同一 wildId 只有一个人抢到」靠 Node 单线程；W7 之后由 Lua 原子性保证，
 * 跨实例同样成立。
 *
 * 全部方法 async：调用方统一 `await`，两套实现签名一致。
 */
import { MONSTER_SPECS, THEME_TABLE } from '../game/content';
import { MemoryWildStorage } from './memoryWildStorage';
import { RedisWildStorage } from './redisWildStorage';
import { clampInt, WILD_CLAIM_TTL_MS, WILD_PER_AREA, WILD_RESOLVED_GRACE_MS, WILD_TTL_MS }
  from './wildTypes';
import type {
  ClaimResult, WildAreaSpec, WildInstance, WildResult, WildSpawner, WildStats,
} from './wildTypes';
import type { WildListSnapshot, WildStorage, WildStorageOptions } from './wildStorage';
import type Redis from 'ioredis';

// 既有 import 路径（`../lib/wildRegistry`）保持不变。
export {
  WILD_PER_AREA, WILD_TTL_MS, WILD_CLAIM_TTL_MS, WILD_RESOLVED_GRACE_MS,
} from './wildTypes';
export type {
  WildStatus, WildResult, WildClaim, WildInstance, WildMonsterView,
  WildAreaSpec, ClaimResult, WildStats,
} from './wildTypes';
export type { WildStorage, WildStorageKind, WildListSnapshot } from './wildStorage';

export type WildRegistryOptions = {
  perArea?: number;
  ttlMs?: number;
  claimTtlMs?: number;
  graceMs?: number;
  rng?: () => number;
  /** 注入存储实现；缺省为进程内内存实现（单实例 / 单测）。 */
  storage?: WildStorage;
};

/**
 * 内容工厂：与原 `spawn()` 的调用顺序逐字对齐（species → level → rare → elite → id），
 * 保证同 seed 的两实例产出完全相同，单测的 RNG 可复现断言才站得住。
 */
function createSpawner(rng: () => number, ttlMs: number): WildSpawner {
  let seq = 0;
  return (areaId: string, spec: WildAreaSpec, now: number): WildInstance => {
    const table = THEME_TABLE[spec.theme] ?? [];
    const speciesId = table.length > 0
      ? table[Math.floor(rng() * table.length)]
      : Object.keys(MONSTER_SPECS)[0];
    const lvMin = Math.min(spec.levelMin, spec.levelMax);
    const lvMax = Math.max(spec.levelMin, spec.levelMax);
    const level = clampInt(lvMin + rng() * (lvMax - lvMin + 1), 1, 60);
    const rare = rng() < 0.08;
    const elite = !rare && rng() < 0.12;
    const name = MONSTER_SPECS[speciesId]?.name ?? speciesId;
    return {
      id: `w_${now.toString(36)}_${(seq++).toString(36)}_${Math.floor(rng() * 1e6).toString(36)}`,
      areaId,
      theme: spec.theme,
      speciesId,
      name,
      level: clampInt(level + (elite ? 2 : 0) + (rare ? 3 : 0), 1, 60),
      label: `${rare ? '稀有' : elite ? '精英' : '野生'} ${name}`,
      spawnedAt: now,
      expiresAt: now + ttlMs,
      status: 'available',
      result: null,
      claim: null,
    };
  };
}

export class WildRegistry {
  private storage: WildStorage;
  private readonly storageOpts: WildStorageOptions;

  constructor(opts: WildRegistryOptions = {}) {
    const ttlMs = opts.ttlMs ?? WILD_TTL_MS;
    this.storageOpts = {
      perArea: opts.perArea ?? WILD_PER_AREA,
      ttlMs,
      claimTtlMs: opts.claimTtlMs ?? WILD_CLAIM_TTL_MS,
      graceMs: opts.graceMs ?? WILD_RESOLVED_GRACE_MS,
      spawner: createSpawner(opts.rng ?? Math.random, ttlMs),
    };
    this.storage = opts.storage ?? new MemoryWildStorage(this.storageOpts);
  }

  /**
   * W7：启动时装 Redis 共享存储（与 `setBroadcastTransport` 同思路——
   * 模块加载期拿不到 Redis 连接，由 index.ts 在 lock provider 就绪后调用）。
   * 只应在心跳启动前调用一次，切换后不再回退。
   */
  useRedisStorage(client: Redis, prefix?: string): void {
    this.storage = new RedisWildStorage({ ...this.storageOpts, client, prefix });
  }

  /** 'memory' | 'redis'，health 诊断用。 */
  get kind(): string {
    return this.storage.kind;
  }

  setAreaSpec(areaId: string, spec: WildAreaSpec): Promise<void> {
    return this.storage.setAreaSpec(areaId, spec);
  }

  getAreaSpec(areaId: string): Promise<WildAreaSpec | null> {
    return this.storage.getAreaSpec(areaId);
  }

  revisionFor(areaId: string): Promise<number> {
    return this.storage.revisionFor(areaId);
  }

  /** 公开列表：自动 ensure 后返回全量快照。 */
  list(areaId: string, spec: WildAreaSpec, now: number): Promise<WildListSnapshot> {
    return this.storage.listArea(areaId, spec, now);
  }

  /** 只做清理与补足，不读列表（心跳 / 单测用）。 */
  ensure(areaId: string, spec: WildAreaSpec, now: number): Promise<boolean> {
    return this.storage.ensure(areaId, spec, now);
  }

  claim(wildId: string, userId: string, battleId: string, now: number): Promise<ClaimResult> {
    return this.storage.claim(wildId, userId, battleId, now);
  }

  resolve(
    wildId: string,
    userId: string,
    battleId: string,
    result: Exclude<WildResult, null>,
    now: number,
  ): Promise<boolean> {
    return this.storage.resolve(wildId, userId, battleId, result, now);
  }

  release(battleId: string, now: number): Promise<string[]> {
    return this.storage.release(battleId, now);
  }

  findByBattle(battleId: string): Promise<WildInstance | undefined> {
    return this.storage.findByBattle(battleId);
  }

  sweep(now: number): Promise<string[]> {
    return this.storage.sweep(now);
  }

  stats(): Promise<WildStats> {
    return this.storage.stats();
  }

  clear(): Promise<void> {
    return this.storage.clear();
  }
}
