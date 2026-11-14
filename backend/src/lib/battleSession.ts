/**
 * 活跃战斗注册表（P3-1 / W8.1 降为 facade）。
 *
 * 约束（与改造前完全一致，只是落到可注入存储上）：
 *  - 一个账号（单档）同时只允许一场战斗（新开覆盖旧的，避免并发刷奖励）；
 *  - `get()` 必须同时校验 userId + battleId，防止拿到别人的战斗；
 *  - 30 分钟无动作自动回收（断线挂机不会永久占内存 / Redis）。
 *
 * W8.1 变更：真值可落在共享存储上，`useRedisStorage()` 启动时切换。
 * 这解决的是「换实例不丢战斗」——玩家断线重连被路由到另一实例时，
 * `current(userId)` 仍能拿到那场战斗，而不是当成没有战斗重新开局。
 *
 * 全方法异步：接口不提供同步变体，避免「某处忘了 await」的静默 bug。
 */
import { MemoryBattleStorage } from './memoryBattleStorage';
import { BATTLE_TTL_MS, type BattleStats, type BattleStorage } from './battleStorage';
import { RedisBattleStorage } from './redisBattleStorage';
import type Redis from 'ioredis';

export { BATTLE_TTL_MS, BATTLE_PHYSICAL_TTL_FACTOR } from './battleStorage';
export type { BattleStats } from './battleStorage';
export { battleKey } from './memoryBattleStorage';

export class BattleRegistry {
  private storage: BattleStorage;

  constructor(opts: { storage?: BattleStorage } = {}) {
    this.storage = opts.storage ?? new MemoryBattleStorage();
  }

  /** 'memory' | 'redis'，health 诊断用。 */
  get kind(): string {
    return this.storage.kind;
  }

  /** 启动装配：`REDIS_URL` 已配置时换成共享实现（与 W7 `wilds.useRedisStorage` 同思路）。 */
  useRedisStorage(client: Redis, prefix = ''): void {
    this.storage = new RedisBattleStorage({ client, prefix });
  }

  size(): Promise<number> {
    return this.storage.size();
  }

  create(state: Parameters<BattleStorage['create']>[0]): ReturnType<BattleStorage['create']> {
    return this.storage.create(state);
  }

  get(userId: string, battleId: string): ReturnType<BattleStorage['get']> {
    return this.storage.get(userId, battleId);
  }

  current(userId: string): ReturnType<BattleStorage['current']> {
    return this.storage.current(userId);
  }

  update(state: Parameters<BattleStorage['update']>[0]): Promise<void> {
    return this.storage.update(state);
  }

  drop(userId: string): Promise<boolean> {
    return this.storage.drop(userId);
  }

  dropUser(userId: string): Promise<number> {
    return this.storage.dropUser(userId);
  }

  /** 兼容旧名：只要数量。新代码用 `sweepExpired()`（还要释放 Boss 名额）。 */
  async sweep(now: number, ttl = BATTLE_TTL_MS): Promise<number> {
    return (await this.storage.sweepExpired(now, ttl)).length;
  }

  sweepExpired(now: number, ttl = BATTLE_TTL_MS): ReturnType<BattleStorage['sweepExpired']> {
    return this.storage.sweepExpired(now, ttl);
  }

  stats(): Promise<BattleStats> {
    return this.storage.stats();
  }
}
