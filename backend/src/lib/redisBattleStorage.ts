/**
 * 活跃战斗存储的 Redis 实现（W8.1）。
 *
 * Key 布局（`p` = 测试前缀，生产为空串）：
 *  - `battle:<battleId>`        STRING 战斗态的 JSON 全量（TTL = 2× 逻辑超时）
 *  - `battle:user:<userId>`     STRING userId → battleId（账号单档索引）
 *  - `battle:ids`               SET    全部活跃 battleId（sweep / stats 遍历用）
 *
 * 为什么物理 TTL 是 2 倍：见 `battleStorage.ts::BATTLE_PHYSICAL_TTL_FACTOR`——
 * `sweepExpired()` 需要返回超时战斗的**完整状态**来释放 Boss 在途名额，
 * 键若在逻辑超时点就被 Redis 删掉，sweep 只能看到「不存在」，名额就漏了。
 *
 * 原子性：
 *  - `create` 用 Lua 保证「覆盖旧战斗 + 删旧索引 + 写新索引」不可分割，
 *    否则两个实例同时开局会留下两场战斗（旧的那场再也不会被 current 命中，永久占用）。
 *  - `update` 用 Lua 保证「存在才写」且同步续期索引，避免索引先于战斗态过期。
 *  - 其余读写由调用方的账号锁（`withSlotLock` → W3 Redis 租约锁）串行兜底。
 */
import type Redis from 'ioredis';
import type { BattleState } from '../game/battle.js';
import {
  BATTLE_PHYSICAL_TTL_FACTOR, BATTLE_TTL_MS,
  type BattleStats, type BattleStorage,
} from './battleStorage.js';

/** 登记战斗：同账号旧战斗原子作废，再写新战斗与索引。 */
export const CREATE_SCRIPT = `
local p = ARGV[1]
local bid = ARGV[2]
local uid = ARGV[3]
local json = ARGV[4]
local px = ARGV[5]
local prev = redis.call('GET', p..'battle:user:'..uid)
if prev and prev ~= bid then
  redis.call('DEL', p..'battle:'..prev)
  redis.call('SREM', p..'battle:ids', prev)
end
redis.call('PSETEX', p..'battle:'..bid, px, json)
redis.call('PSETEX', p..'battle:user:'..uid, px, bid)
redis.call('SADD', p..'battle:ids', bid)
return 1
`;

/** 推进战斗：**存在才写**（不凭空插入），并给账号索引续期。 */
export const UPDATE_SCRIPT = `
local p = ARGV[1]
if redis.call('EXISTS', KEYS[1]) == 0 then return 0 end
redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[3])
if redis.call('EXISTS', p..'battle:user:'..ARGV[4]) == 1 then
  redis.call('PEXPIRE', p..'battle:user:'..ARGV[4], ARGV[2])
end
return 1
`;

export type RedisBattleStorageOptions = {
  client: Redis;
  /** 仅测试用；生产为空串。 */
  prefix?: string;
  /** 逻辑超时（默认 30min），可注入以便单测构造超时战斗。 */
  ttlMs?: number;
};

export class RedisBattleStorage implements BattleStorage {
  private readonly client: Redis;
  private readonly prefix: string;
  private readonly ttlMs: number;

  constructor(opts: RedisBattleStorageOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? '';
    this.ttlMs = opts.ttlMs ?? BATTLE_TTL_MS;
  }

  get kind(): string {
    return 'redis';
  }

  private k(name: string): string {
    return `${this.prefix}${name}`;
  }

  /** 物理 TTL：留出 sweep 的观察窗口。 */
  private physicalTtl(): number {
    return this.ttlMs * BATTLE_PHYSICAL_TTL_FACTOR;
  }

  async create(state: BattleState): Promise<BattleState> {
    await this.client.eval(
      CREATE_SCRIPT, 0,
      this.prefix, state.id, state.userId,
      JSON.stringify(state), String(this.physicalTtl()),
    );
    return state;
  }

  async get(userId: string, battleId: string): Promise<BattleState | undefined> {
    const raw = await this.client.get(this.k(`battle:${battleId}`));
    if (!raw) return undefined;
    const state = this.parse(raw);
    // 归属校验与内存实现一致：别人的 battleId 即使泄漏也拿不到状态。
    if (!state || state.userId !== userId) return undefined;
    return state;
  }

  async current(userId: string): Promise<BattleState | undefined> {
    const battleId = await this.client.get(this.k(`battle:user:${userId}`));
    if (!battleId) return undefined;
    return this.get(userId, battleId);
  }

  async update(state: BattleState): Promise<void> {
    await this.client.eval(
      UPDATE_SCRIPT, 1, this.k(`battle:${state.id}`),
      this.prefix, String(this.physicalTtl()), JSON.stringify(state), state.userId,
    );
  }

  async drop(userId: string): Promise<boolean> {
    const battleId = await this.client.get(this.k(`battle:user:${userId}`));
    if (!battleId) return false;
    await this.client
      .multi()
      .del(this.k(`battle:${battleId}`))
      .del(this.k(`battle:user:${userId}`))
      .srem(this.k('battle:ids'), battleId)
      .exec();
    return true;
  }

  /** 账号单档：等价于 drop，但保留「返回清理数量」的接口语义。 */
  async dropUser(userId: string): Promise<number> {
    return (await this.drop(userId)) ? 1 : 0;
  }

  async sweepExpired(now: number, ttl = this.ttlMs): Promise<BattleState[]> {
    const ids = await this.client.smembers(this.k('battle:ids'));
    const cleaned: BattleState[] = [];
    for (const battleId of ids) {
      const raw = await this.client.get(this.k(`battle:${battleId}`));
      if (!raw) {
        // 物理 TTL 已过期（sweep 长时间没跑）：内容拿不回来了，只能清索引。
        await this.client.srem(this.k('battle:ids'), battleId);
        continue;
      }
      const state = this.parse(raw);
      if (!state) {
        await this.client.srem(this.k('battle:ids'), battleId);
        continue;
      }
      if (now - state.updatedAt <= ttl) continue;
      const ownerKey = this.k(`battle:user:${state.userId}`);
      await this.client.del(this.k(`battle:${battleId}`));
      await this.client.srem(this.k('battle:ids'), battleId);
      // 只有索引仍指向这场战斗时才删，避免把账号新开的战斗索引抹掉（ABA）。
      if ((await this.client.get(ownerKey)) === battleId) await this.client.del(ownerKey);
      cleaned.push(state);
    }
    return cleaned;
  }

  async stats(): Promise<BattleStats> {
    const ids = await this.client.smembers(this.k('battle:ids'));
    const users = new Set<string>();
    let active = 0;
    for (const battleId of ids) {
      const raw = await this.client.get(this.k(`battle:${battleId}`));
      if (!raw) continue;
      const state = this.parse(raw);
      if (!state) continue;
      active += 1;
      users.add(state.userId);
    }
    return { active, users: users.size };
  }

  async size(): Promise<number> {
    return (await this.stats()).active;
  }

  /** 存档/战斗态解析失败时视为不存在（脏数据不该让整个 sweep 崩掉）。 */
  private parse(raw: string): BattleState | null {
    try {
      const v = JSON.parse(raw) as BattleState;
      return v && typeof v.id === 'string' && typeof v.userId === 'string' ? v : null;
    } catch {
      return null;
    }
  }
}
