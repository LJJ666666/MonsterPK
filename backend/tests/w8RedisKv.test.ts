/**
 * W8 共享 KV：真 Redis 单测。
 *
 * 为什么必须连真 Redis：三处原子性都在 Redis 语义里——
 *  - 馆主 CD 靠 `PSETEX` 的 TTL 与 `acquire` 的「不存在才写」；
 *  - 战斗态靠 Lua 的「覆盖旧战斗 + 删旧索引」不可分割；
 *  - 会话版本戳靠「戳比会话多留 1 分钟」的 TTL 关系。
 * 用 JS 替身模拟等于把实现重写一遍，验不出真问题。
 *
 * CI 可能没有 Redis：连不上时整组 `skip`（不判失败），本地/验收机有 Redis 时全量跑。
 * 跨进程语义（两个进程抢同一个 CD）由 `e2e_w8_shared.mjs` 覆盖，本文件用**两个 storage/client
 * 实例共享同一 Redis** 模拟「两次请求打到不同实例」。
 *
 * key 前缀带随机串，绝不污染常驻 :3001 的 `gym:cd:*` / `battle:*` / `sess:rev:*`。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { RedisKvStore } from '../src/lib/redisKvStore';
import { RedisBattleStorage } from '../src/lib/redisBattleStorage';
import type { BattleState } from '../src/game/battle';
import {
  acquireGymCooldown, gymCooldownUntil, isGymOnCooldown,
  resetGymCooldownStoreForTest, setGymCooldownStore, GYM_COOLDOWN_MS,
} from '../src/game/gyms';
import {
  isSessionStale, publishSessionRevision, resetSessionRevisionStoreForTest,
  sessionRevisionKey, useSessionRevisionStore,
} from '../src/lib/sessionRevision';

const PREFIX = `w8t:${Date.now().toString(36)}:${Math.floor(Math.random() * 1e6).toString(36)}:`;
const NOW = 1_700_000_000_000;

let client: Redis | null = null;
let reachable = false;

/** 模拟「另一个进程」：独立 store 实例，共享同一 Redis。 */
function kv(): RedisKvStore {
  if (!client) throw new Error('redis not ready');
  return new RedisKvStore({ client, prefix: PREFIX });
}

/**
 * 战斗存储：每个用例传自己的 tag 做命名空间。
 * `stats()` 统计的是整个 prefix 下的活跃战斗，共用一个 prefix 会让用例互相污染计数。
 */
function battleStorage(tag = 'default'): RedisBattleStorage {
  if (!client) throw new Error('redis not ready');
  return new RedisBattleStorage({ client, prefix: `${PREFIX}${tag}:` });
}

function fakeBattle(over: Partial<BattleState> = {}): BattleState {
  return {
    id: 'bt_1',
    userId: 'user_a',
    theme: 'grassland',
    areaName: '测试草原',
    areaId: null,
    levelMin: 1,
    levelMax: 3,
    turn: 1,
    log: [],
    playerActiveIndex: 0,
    playerMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemyMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemy: {} as any,
    party: [],
    ppByMonster: {},
    consumed: {},
    finished: false,
    result: null,
    rewards: null,
    captured: null,
    actions: 0,
    startedAt: NOW,
    updatedAt: NOW,
    ...over,
  } as BattleState;
}

before(async () => {
  const url = process.env.REDIS_URL ?? 'redis://127.0.0.1:6379';
  const c = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  try {
    await c.connect();
    await c.ping();
    client = c;
    reachable = true;
  } catch {
    try { c.disconnect(); } catch { /* noop */ }
    client = null;
    reachable = false;
  }
});

after(async () => {
  resetGymCooldownStoreForTest();
  resetSessionRevisionStoreForTest();
  if (client) {
    try {
      const keys: string[] = [];
      let cursor = '0';
      do {
        const [next, batch] = await client.scan(cursor, 'MATCH', `${PREFIX}*`, 'COUNT', 500);
        cursor = next;
        keys.push(...batch);
      } while (cursor !== '0');
      if (keys.length > 0) await client.del(...keys);
    } finally {
      await client.quit().catch(() => {});
    }
  }
});

// —————————————————————— KV 基础原语 ——————————————————————

test('KV：set / get / del 与 TTL 过期', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = kv();
  await s.set('k1', 'v1');
  assert.equal(await s.get('k1'), 'v1');
  assert.equal(await s.del('k1'), 1);
  assert.equal(await s.get('k1'), null);
  assert.equal(await s.del('k1'), 0, '删不存在的键返回 0');

  await s.set('k2', 'v2', 150);
  assert.equal(await s.get('k2'), 'v2');
  assert.ok((await s.pttl('k2')) > 0, '有 TTL 的键 pttl 应为正数');
  await new Promise((r) => setTimeout(r, 260));
  assert.equal(await s.get('k2'), null, 'TTL 到期后应视为不存在');
});

test('KV：acquire 是「不存在才写」，第二次返回旧值不覆盖', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = kv();
  const first = await s.acquire('aq', 'first', 60_000);
  assert.equal(first.ok, true);
  assert.equal(first.current, 'first');

  const second = await s.acquire('aq', 'second', 60_000);
  assert.equal(second.ok, false);
  assert.equal(second.current, 'first', '失败时必须返回已存在的值（用于算剩余冷却）');
  assert.equal(await s.get('aq'), 'first', '不能被第二次覆盖');
});

test('KV：keys 按前缀列出且不含已过期键', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = kv();
  await s.set('p:a', '1', 60_000);
  await s.set('p:b', '2', 60_000);
  await s.set('p:gone', '3', 100);
  await s.set('q:c', '4', 60_000);
  await new Promise((r) => setTimeout(r, 200));
  const keys = (await s.keys('p:')).sort();
  assert.deepEqual(keys, ['p:a', 'p:b']);
});

test('KV：生产前缀（空串）下 clear 被拒绝', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = new RedisKvStore({ client: client!, prefix: '' });
  await assert.rejects(() => s.clear(), /生产前缀/);
});

// —————————————————————— 馆主 CD（W8.0）——————————————————————

test('馆主 CD：同一账号同一演武堂只有一次能占到（跨实例）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const a = kv();
  const b = kv(); // 另一「进程」
  setGymCooldownStore(a);
  const first = await acquireGymCooldown('u_cd', 'town_starter', NOW);
  assert.equal(first.ok, true);
  assert.equal(first.until, NOW + GYM_COOLDOWN_MS);

  // 换实例再开：必须被拒，且拿到既有到期时间（前端据此倒计时）
  setGymCooldownStore(b);
  const second = await acquireGymCooldown('u_cd', 'town_starter', NOW + 1_000);
  assert.equal(second.ok, false, '冷却期内另一个实例不能再占到');
  assert.equal(second.until, first.until, '返回的应是既有到期时间，不是新窗口');

  // 不同演武堂互不影响
  const other = await acquireGymCooldown('u_cd', 'city_pebble', NOW);
  assert.equal(other.ok, true, '不同 locationId 是不同 CD 键');
});

test('馆主 CD：TTL 到期后可重新占（模拟 20min 过去）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  // 用一个很短的冷却窗口，避免真等 20 分钟。
  setGymCooldownStore(kv());
  const short = 150;
  const first = await acquireGymCooldown('u_ttl', 'town_leafy', NOW, short);
  assert.equal(first.ok, true);
  assert.equal(await isGymOnCooldown('u_ttl', 'town_leafy', NOW), true);
  await new Promise((r) => setTimeout(r, 260));
  // 键已被 Redis 自动删除 → 到期时间读到 0
  assert.equal(await gymCooldownUntil('u_ttl', 'town_leafy'), 0, 'TTL 到期后读不到冷却');
  const again = await acquireGymCooldown('u_ttl', 'town_leafy', NOW, short);
  assert.equal(again.ok, true, 'CD 过期后允许再开');
});

// —————————————————————— 战斗态（W8.1）——————————————————————

test('战斗：A 实例创建，B 实例能读到（换实例不丢战斗）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const a = battleStorage('cross');
  const b = battleStorage('cross'); // 模拟玩家重连到另一实例
  await a.create(fakeBattle({ id: 'bt_cross', userId: 'u_cross' }));

  const seen = await b.current('u_cross');
  assert.ok(seen, 'B 实例必须能看到 A 实例开的战斗');
  assert.equal(seen!.id, 'bt_cross');
  assert.equal((await b.get('u_cross', 'bt_cross'))?.id, 'bt_cross');
});

test('战斗：归属校验与「未登记不插入」', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = battleStorage('own');
  await s.create(fakeBattle({ id: 'bt_own', userId: 'u_own' }));
  assert.equal(await s.get('u_other', 'bt_own'), undefined, '别人的 userId 拿不到');
  assert.equal(await s.get('u_own', 'bt_nope'), undefined, 'battleId 不符拿不到');

  await s.update(fakeBattle({ id: 'bt_ghost', userId: 'u_own', turn: 5 }));
  assert.equal(await s.get('u_own', 'bt_ghost'), undefined, 'update 不能凭空插入');
  assert.equal((await s.stats()).active, 1);
});

test('战斗：同账号再开局原子覆盖旧战斗（旧 battleId 立即失效）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = battleStorage('over');
  await s.create(fakeBattle({ id: 'bt_old', userId: 'u_over' }));
  await s.create(fakeBattle({ id: 'bt_new', userId: 'u_over' }));
  assert.equal((await s.current('u_over'))?.id, 'bt_new');
  assert.equal(await s.get('u_over', 'bt_old'), undefined, '旧战斗应被丢弃');
  assert.equal((await s.stats()).active, 1, '同账号只留一场');
});

test('战斗：update 推进状态并续期索引', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = battleStorage('upd');
  await s.create(fakeBattle({ id: 'bt_upd', userId: 'u_upd' }));
  await s.update(fakeBattle({ id: 'bt_upd', userId: 'u_upd', turn: 9 }));
  const got = await s.current('u_upd');
  assert.equal(got?.turn, 9);
  assert.ok((await client!.pttl(`${PREFIX}upd:battle:user:u_upd`)) > 0, '索引应随 update 续期');
});

test('战斗：sweepExpired 返回超时战斗态（Boss 名额释放依赖它）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = battleStorage('sweep');
  await s.create(fakeBattle({ id: 'bt_fresh', userId: 'u_fresh', updatedAt: NOW }));
  await s.create(fakeBattle({
    id: 'bt_stale', userId: 'u_stale',
    updatedAt: NOW - 40 * 60_000, bossQuotaToken: 'tok_stale',
  }));

  const expired = await s.sweepExpired(NOW);
  assert.equal(expired.length, 1, '只有超时的那场被回收');
  assert.equal(expired[0].id, 'bt_stale');
  assert.equal(expired[0].bossQuotaToken, 'tok_stale', '必须带回 token 才能释放名额');
  assert.equal((await s.current('u_fresh'))?.id, 'bt_fresh');
  assert.equal(await s.current('u_stale'), undefined);
  assert.equal((await s.stats()).active, 1);
});

test('战斗：drop / dropUser 清理干净（含索引）', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const s = battleStorage('drop');
  await s.create(fakeBattle({ id: 'bt_drop', userId: 'u_drop' }));
  assert.equal(await s.drop('u_drop'), true);
  assert.equal(await s.drop('u_drop'), false, '重复 drop 是 no-op');
  assert.equal(await s.current('u_drop'), undefined);
  assert.equal(await client!.get(`${PREFIX}drop:battle:user:u_drop`), null);
  assert.equal(await s.dropUser('u_none'), 0);
});

// —————————————————————— 会话版本戳（W8.2）——————————————————————

test('会话戳：别的实例写了更高版本时内存副本被判为落后', async (t) => {
  if (!reachable) return t.skip('无 Redis，跳过');
  const a = kv();
  const b = kv(); // 另一实例
  useSessionRevisionStore(a);

  // 本实例内存态 revision = 5，但共享真值已是 7（别的实例提交过两次）
  await publishSessionRevision('u_sess', 7);
  assert.equal(await a.get(sessionRevisionKey('u_sess')), '7');

  useSessionRevisionStore(b);
  assert.equal(await isSessionStale('u_sess', 5), true, '落后必须判定为 true');
  assert.equal(await isSessionStale('u_sess', 7), false, '同版本不算落后');
  assert.equal(await isSessionStale('u_sess', 9), false, '内存更新时不算落后');
  assert.equal(await isSessionStale('u_none', 1), false, '没有戳时一律不判落后');
});

test('会话戳：未装配 store 时永远不判落后（单实例降级）', async () => {
  resetSessionRevisionStoreForTest();
  assert.equal(await isSessionStale('u_any', 0), false);
  await publishSessionRevision('u_any', 99); // 不应抛错
});
