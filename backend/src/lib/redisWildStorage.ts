/**
 * 野怪池 Redis 实现（W7.2）。
 *
 * 设计依据：定稿 §3.6「野怪目标设计」——全量 key + Lua 原子化。
 *
 * Key 布局（单实例 Redis；Cluster 需给带 areaId 的组合键加 hash tag）：
 *  - `wild:inst:<wildId>`      HASH   实例全量字段（status/result/claim* 全在这里）
 *  - `wild:area:<areaId>`      SET    该区域当前实例 id（**唯一数量真值**，恒 ≤ target）
 *  - `wild:user:<userId>`      STRING 该账号在途的 wildId（"同账号只允许一场"索引）
 *  - `wild:battle:<battleId>`  STRING battleId → wildId（结算 / 放弃定位）
 *  - `wild:rev:<areaId>`       STRING 区域版本（客户端幂等应用）
 *  - `wild:rev:global`         STRING 全局累计变更数（health）
 *  - `wild:areas`              SET    已登记区域（sweep 遍历用）
 *  - `wild:spec:<areaId>`      HASH   theme/levelMin/levelMax
 *
 * 为什么内容生成不在 Lua 里：种族来自 `THEME_TABLE`、稀有度走 RNG，Lua 查不到内容表。
 * 因此 Node 侧预生成候选，`APPEND_SCRIPT` 只做「SCARD < target 才写入」的原子追加，
 * 两个实例并发 sweep 也最多补到 target（定稿要求的「补怪与 claim 同脚本/区域锁」等价实现）。
 *
 * 与内存实现的语义等价性由 `tests/w7RedisWild.test.ts` 逐断言覆盖。
 */
import type Redis from 'ioredis';
import {
  toWildView,
  type ClaimResult, type WildAreaSpec, type WildInstance, type WildResult,
  type WildStats, type WildStatus,
} from './wildTypes';
import type { WildListSnapshot, WildStorage, WildStorageOptions } from './wildStorage';

/** claim：判状态 + 判同账号在途 + 置 claimed + 写两索引 + 推进版本。返回 {code[, ...fields]}。 */
export const CLAIM_SCRIPT = `
local p = ARGV[1]
local instKey = KEYS[1]
local uid = ARGV[2]
local bid = ARGV[3]
local now = ARGV[4]
local e = redis.call('HGETALL', instKey)
if #e == 0 then return {-1} end
local f = {}
for i = 1, #e, 2 do f[e[i]] = e[i+1] end
if f['status'] == 'resolved' then return {-3} end
if f['status'] ~= 'available' then return {-2} end
if redis.call('EXISTS', p..'wild:user:'..uid) == 1 then return {-4} end
redis.call('HSET', instKey, 'status', 'claimed', 'claimUserId', uid, 'claimBattleId', bid, 'claimAt', now)
redis.call('SET', p..'wild:user:'..uid, f['id'])
redis.call('SET', p..'wild:battle:'..bid, f['id'])
redis.call('INCR', p..'wild:rev:'..f['areaId'])
redis.call('INCR', p..'wild:rev:global')
local after = redis.call('HGETALL', instKey)
local out = {1}
for i = 1, #after do out[#out + 1] = after[i] end
return out
`;

/** resolve：校验 (userId, battleId) 双键归属后置 resolved 并清在途索引。 */
export const RESOLVE_SCRIPT = `
local p = ARGV[1]
local instKey = KEYS[1]
local uid = ARGV[2]
local bid = ARGV[3]
local res = ARGV[4]
local now = tonumber(ARGV[5])
local grace = tonumber(ARGV[6])
local e = redis.call('HGETALL', instKey)
if #e == 0 then return {-1} end
local f = {}
for i = 1, #e, 2 do f[e[i]] = e[i+1] end
if f['status'] ~= 'claimed' then return {-2} end
if f['claimUserId'] ~= uid or f['claimBattleId'] ~= bid then return {-3} end
redis.call('HSET', instKey, 'status', 'resolved', 'result', res, 'expiresAt', tostring(now + grace))
redis.call('HDEL', instKey, 'claimUserId', 'claimBattleId', 'claimAt')
redis.call('DEL', p..'wild:user:'..uid)
redis.call('DEL', p..'wild:battle:'..bid)
redis.call('INCR', p..'wild:rev:'..f['areaId'])
redis.call('INCR', p..'wild:rev:global')
return {1, f['areaId']}
`;

/** release：按 battleId 归还（校验 battle 索引仍指向同一只且仍 claimed）。 */
export const RELEASE_SCRIPT = `
local p = ARGV[1]
local battleKey = KEYS[1]
local now = tonumber(ARGV[2])
local ttl = tonumber(ARGV[3])
local bid = ARGV[4]
local wid = redis.call('GET', battleKey)
if not wid then return {0} end
local instKey = p..'wild:inst:'..wid
local e = redis.call('HGETALL', instKey)
if #e == 0 then redis.call('DEL', battleKey); return {0} end
local f = {}
for i = 1, #e, 2 do f[e[i]] = e[i+1] end
if f['status'] ~= 'claimed' or f['claimBattleId'] ~= bid then return {0} end
redis.call('HSET', instKey, 'status', 'available', 'result', '', 'expiresAt', tostring(now + ttl))
redis.call('HDEL', instKey, 'claimUserId', 'claimBattleId', 'claimAt')
if f['claimUserId'] and f['claimUserId'] ~= '' then redis.call('DEL', p..'wild:user:'..f['claimUserId']) end
redis.call('DEL', battleKey)
redis.call('INCR', p..'wild:rev:'..f['areaId'])
redis.call('INCR', p..'wild:rev:global')
return {1, f['areaId']}
`;

/**
 * ensure 前半段：登记 spec + 清过期 resolved/available + claimed 超时归还 + 算缺口。
 * 原子执行，返回 {gap, changed}。缺口由 APPEND_SCRIPT 原子补齐。
 */
export const ENSURE_SCRIPT = `
local p = ARGV[1]
local areaId = ARGV[2]
local now = tonumber(ARGV[3])
local ttl = tonumber(ARGV[4])
local claimTtl = tonumber(ARGV[5])
local target = tonumber(ARGV[6])
local areaKey = p..'wild:area:'..areaId
redis.call('SADD', p..'wild:areas', areaId)
redis.call('HSET', p..'wild:spec:'..areaId, 'theme', ARGV[7], 'levelMin', ARGV[8], 'levelMax', ARGV[9])
local ids = redis.call('SMEMBERS', areaKey)
local changed = 0
for _, id in ipairs(ids) do
  local instKey = p..'wild:inst:'..id
  local st = redis.call('HGET', instKey, 'status')
  if not st then
    redis.call('SREM', areaKey, id)
    changed = 1
  else
    local exp = tonumber(redis.call('HGET', instKey, 'expiresAt') or '0')
    if (st == 'available' or st == 'resolved') and now >= exp then
      redis.call('SREM', areaKey, id)
      redis.call('DEL', instKey)
      changed = 1
    elseif st == 'claimed' then
      local at = tonumber(redis.call('HGET', instKey, 'claimAt') or '0')
      if now - at >= claimTtl then
        local cid = redis.call('HGET', instKey, 'claimUserId')
        local cbid = redis.call('HGET', instKey, 'claimBattleId')
        if cid and cid ~= '' then redis.call('DEL', p..'wild:user:'..cid) end
        if cbid and cbid ~= '' then redis.call('DEL', p..'wild:battle:'..cbid) end
        redis.call('HSET', instKey, 'status', 'available', 'result', '', 'expiresAt', tostring(now + ttl))
        redis.call('HDEL', instKey, 'claimUserId', 'claimBattleId', 'claimAt')
        changed = 1
      end
    end
  end
end
local count = redis.call('SCARD', areaKey)
local gap = target - count
if gap < 0 then gap = 0 end
if changed == 1 then
  redis.call('INCR', p..'wild:rev:'..areaId)
  redis.call('INCR', p..'wild:rev:global')
end
return {gap, changed}
`;

/**
 * 补怪：按候选顺序写入，每只都先 `SCARD < target` 才落库。
 * 候选由 Node 侧预生成（RNG / 内容表在 Node），ARGV[4..] 每 8 个字段一组：
 * id / theme / speciesId / name / level / label / spawnedAt / expiresAt。
 */
export const APPEND_SCRIPT = `
local p = ARGV[1]
local areaId = ARGV[2]
local target = tonumber(ARGV[3])
local areaKey = p..'wild:area:'..areaId
local added = 0
local i = 4
while i + 7 <= #ARGV do
  if redis.call('SCARD', areaKey) >= target then break end
  local id = ARGV[i]
  local instKey = p..'wild:inst:'..id
  redis.call('HSET', instKey,
    'id', id, 'areaId', areaId,
    'theme', ARGV[i + 1], 'speciesId', ARGV[i + 2], 'name', ARGV[i + 3],
    'level', ARGV[i + 4], 'label', ARGV[i + 5],
    'spawnedAt', ARGV[i + 6], 'expiresAt', ARGV[i + 7],
    'status', 'available', 'result', '')
  redis.call('SADD', areaKey, id)
  added = added + 1
  i = i + 8
end
if added > 0 then
  redis.call('SADD', p..'wild:areas', areaId)
  redis.call('INCR', p..'wild:rev:'..areaId)
  redis.call('INCR', p..'wild:rev:global')
end
return added
`;

/** Lua 返回的扁平 [k,v,k,v...] → 对象。 */
function flatToHash(arr: unknown[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i + 1 < arr.length; i += 2) {
    const k = String(arr[i]);
    out[k] = arr[i + 1] === null || arr[i + 1] === undefined ? '' : String(arr[i + 1]);
  }
  return out;
}

/** HASH → WildInstance；缺 id 视为不存在。 */
function fromHash(h: Record<string, string>): WildInstance | null {
  if (!h || !h.id) return null;
  const claim = h.claimUserId
    ? { userId: h.claimUserId, battleId: h.claimBattleId ?? '', at: Number(h.claimAt) || 0 }
    : null;
  return {
    id: h.id,
    areaId: h.areaId,
    theme: h.theme,
    speciesId: h.speciesId,
    name: h.name,
    level: Number(h.level) || 1,
    label: h.label ?? h.name,
    spawnedAt: Number(h.spawnedAt) || 0,
    expiresAt: Number(h.expiresAt) || 0,
    status: (h.status as WildStatus) || 'available',
    result: (h.result ? (h.result as WildResult) : null),
    claim,
  };
}

export type RedisWildStorageOptions = WildStorageOptions & {
  client: Redis;
  /** key 前缀，测试用独立命名空间避免污染常驻实例。 */
  prefix?: string;
};

export class RedisWildStorage implements WildStorage {
  readonly kind = 'redis' as const;

  private readonly client: Redis;
  private readonly prefix: string;
  private readonly perArea: number;
  private readonly ttlMs: number;
  private readonly claimTtlMs: number;
  private readonly graceMs: number;
  private readonly spawner: WildStorageOptions['spawner'];

  constructor(opts: RedisWildStorageOptions) {
    this.client = opts.client;
    this.prefix = opts.prefix ?? '';
    this.perArea = opts.perArea ?? 3;
    this.ttlMs = opts.ttlMs ?? 5 * 60_000;
    this.claimTtlMs = opts.claimTtlMs ?? 30 * 60_000;
    this.graceMs = opts.graceMs ?? 10_000;
    this.spawner = opts.spawner;
  }

  // 所有 key 统一走这里，prefix 只在测试里非空。
  private k(name: string): string {
    return `${this.prefix}${name}`;
  }

  async setAreaSpec(areaId: string, spec: WildAreaSpec): Promise<void> {
    await this.client
      .multi()
      .sadd(this.k('wild:areas'), areaId)
      .hset(this.k(`wild:spec:${areaId}`), {
        theme: spec.theme,
        levelMin: String(spec.levelMin),
        levelMax: String(spec.levelMax),
      })
      .exec();
  }

  async getAreaSpec(areaId: string): Promise<WildAreaSpec | null> {
    const h = await this.client.hgetall(this.k(`wild:spec:${areaId}`));
    if (!h || !h.theme) return null;
    return {
      theme: h.theme,
      levelMin: Number(h.levelMin) || 1,
      levelMax: Number(h.levelMax) || 1,
    };
  }

  async revisionFor(areaId: string): Promise<number> {
    const v = await this.client.get(this.k(`wild:rev:${areaId}`));
    return Number(v) || 0;
  }

  /** 清理 + 补足；两段都在 Redis 侧原子，跨实例并发不会超量。 */
  async ensure(areaId: string, spec: WildAreaSpec, now: number): Promise<boolean> {
    const prep = await this.client.eval(
      ENSURE_SCRIPT, 1, this.k(`wild:area:${areaId}`),
      this.prefix, areaId, String(now), String(this.ttlMs), String(this.claimTtlMs), String(this.perArea),
      spec.theme, String(spec.levelMin), String(spec.levelMax),
    ) as [number, number];
    const gap = Number(prep?.[0]) || 0;
    const changed = Number(prep?.[1]) === 1;
    if (gap <= 0) return changed;

    // 预生成 gap 个候选（多生成无害，脚本会按缺口截断）。
    const args: string[] = [];
    for (let i = 0; i < gap; i += 1) {
      const inst = this.spawner(areaId, spec, now);
      args.push(
        inst.id, inst.theme, inst.speciesId, inst.name, String(inst.level),
        inst.label, String(inst.spawnedAt), String(inst.expiresAt),
      );
    }
    const added = Number(await this.client.eval(
      APPEND_SCRIPT, 1, this.k(`wild:area:${areaId}`),
      this.prefix, areaId, String(this.perArea), ...args,
    )) || 0;
    return changed || added > 0;
  }

  async listArea(areaId: string, spec: WildAreaSpec, now: number): Promise<WildListSnapshot> {
    await this.ensure(areaId, spec, now);
    const ids = await this.client.smembers(this.k(`wild:area:${areaId}`));
    const monsters = [];
    if (ids.length > 0) {
      const pipe = this.client.pipeline();
      for (const id of ids) pipe.hgetall(this.k(`wild:inst:${id}`));
      const rows = await pipe.exec();
      for (const row of rows ?? []) {
        const [, value] = row as [Error | null, Record<string, string> | null];
        const inst = value ? fromHash(value) : null;
        if (inst) monsters.push(toWildView(inst));
      }
    }
    monsters.sort((a, b) => a.id.localeCompare(b.id));
    const revision = Number(await this.client.get(this.k(`wild:rev:${areaId}`))) || 0;
    return { revision, monsters };
  }

  async claim(wildId: string, userId: string, battleId: string, now: number): Promise<ClaimResult> {
    const raw = await this.client.eval(
      CLAIM_SCRIPT, 1, this.k(`wild:inst:${wildId}`),
      this.prefix, userId, battleId, String(now),
    ) as unknown[];
    const code = Number(raw?.[0]);
    if (code === -1) return { ok: false, code: 'WILD_NOT_FOUND' };
    if (code === -3) return { ok: false, code: 'WILD_RESOLVED' };
    if (code === -4) return { ok: false, code: 'WILD_ON_COOLDOWN' };
    if (code !== 1) return { ok: false, code: 'WILD_CLAIMED' };
    const inst = fromHash(flatToHash(Array.from(raw).slice(1)));
    if (!inst) return { ok: false, code: 'WILD_NOT_FOUND' };
    return { ok: true, instance: inst };
  }

  async resolve(
    wildId: string,
    userId: string,
    battleId: string,
    result: Exclude<WildResult, null>,
    now: number,
  ): Promise<boolean> {
    const raw = await this.client.eval(
      RESOLVE_SCRIPT, 1, this.k(`wild:inst:${wildId}`),
      this.prefix, userId, battleId, result, String(now), String(this.graceMs),
    ) as unknown[];
    return Number(raw?.[0]) === 1;
  }

  async release(battleId: string, now: number): Promise<string[]> {
    const raw = await this.client.eval(
      RELEASE_SCRIPT, 1, this.k(`wild:battle:${battleId}`),
      this.prefix, String(now), String(this.ttlMs), battleId,
    ) as unknown[];
    if (Number(raw?.[0]) !== 1) return [];
    const areaId = raw?.[1] ? String(raw[1]) : '';
    return areaId ? [areaId] : [];
  }

  async findByBattle(battleId: string): Promise<WildInstance | undefined> {
    const wildId = await this.client.get(this.k(`wild:battle:${battleId}`));
    if (!wildId) return undefined;
    const h = await this.client.hgetall(this.k(`wild:inst:${wildId}`));
    const inst = fromHash(h ?? {});
    // 索引可能残留（resolve 后已删，这里兜底校验仍归属该战斗）。
    if (!inst || inst.status !== 'claimed' || inst.claim?.battleId !== battleId) return undefined;
    return inst;
  }

  async sweep(now: number): Promise<string[]> {
    const areaIds = await this.client.smembers(this.k('wild:areas'));
    const changed: string[] = [];
    for (const areaId of areaIds) {
      const spec = await this.getAreaSpec(areaId);
      if (!spec) continue;
      if (await this.ensure(areaId, spec, now)) changed.push(areaId);
    }
    return changed;
  }

  async stats(): Promise<WildStats> {
    const areaIds = await this.client.smembers(this.k('wild:areas'));
    const pipe = this.client.pipeline();
    for (const areaId of areaIds) pipe.smembers(this.k(`wild:area:${areaId}`));
    const rows = await pipe.exec();
    const allIds: string[] = [];
    for (const row of rows ?? []) {
      const [, value] = row as [Error | null, string[] | null];
      if (Array.isArray(value)) allIds.push(...value);
    }
    let available = 0;
    let claimed = 0;
    if (allIds.length > 0) {
      const p2 = this.client.pipeline();
      for (const id of allIds) p2.hget(this.k(`wild:inst:${id}`), 'status');
      const st = await p2.exec();
      for (const row of st ?? []) {
        const [, value] = row as [Error | null, string | null];
        if (value === 'available') available += 1;
        else if (value === 'claimed') claimed += 1;
      }
    }
    const revision = Number(await this.client.get(this.k('wild:rev:global'))) || 0;
    return {
      active: allIds.length,
      areas: areaIds.length,
      available,
      claimed,
      revision,
    };
  }

  /** 仅测试：清掉本前缀下的所有野怪 key。 */
  async clear(): Promise<void> {
    const keys: string[] = [];
    let cursor = '0';
    do {
      const [next, batch] = await this.client.scan(
        cursor, 'MATCH', `${this.prefix}wild:*`, 'COUNT', 500,
      );
      cursor = next;
      keys.push(...batch);
    } while (cursor !== '0');
    if (keys.length > 0) await this.client.del(...keys);
  }
}
