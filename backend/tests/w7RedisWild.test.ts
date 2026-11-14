/**
 * W7.2 Redis 野怪存储：真 Redis 单测（Lua 语义）。
 *
 * 为什么必须连真 Redis：本实现的原子性全在 Lua 里（claim 判状态 + 判在途 + 写两索引、
 * ensure 清过期 + 归还 + 补足），用 JS 替身模拟 Lua 等于重写一遍实现、验不出真问题。
 *
 * CI 可能没有 Redis：连不上时整组 `skip`（不判失败），本地/验收机有 Redis 时全量跑。
 * 跨实例语义（两个进程抢同一只）由 `e2e_w7_wild.mjs` 覆盖，本文件用两个 storage 实例
 * 共享同一 client 模拟「两次请求打到不同实例」。
 *
 * key 前缀带随机串，绝不污染常驻 :3001 的 `wild:*`。
 */
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import Redis from 'ioredis';
import { RedisWildStorage } from '../src/lib/redisWildStorage';
import { WILD_CLAIM_TTL_MS, WILD_PER_AREA, WILD_TTL_MS, type WildAreaSpec }
  from '../src/lib/wildTypes';
import { THEME_TABLE, MONSTER_SPECS } from '../src/game/content';

const SPEC: WildAreaSpec = { theme: 'grass', levelMin: 2, levelMax: 4 };
const AREA = 'w7test_area';
const NOW = 1_700_000_000_000;
const PREFIX = `w7t:${Date.now().toString(36)}:${Math.floor(Math.random() * 1e6).toString(36)}:`;

let client: Redis | null = null;
let reachable = false;
let seq = 0;

/** 与 facade 同构的内容工厂（顺序无关紧要，测试只要字段合法）。 */
function spawner(areaId: string, spec: WildAreaSpec, now: number) {
  const table = THEME_TABLE[spec.theme] ?? [];
  const speciesId = table[Math.floor(Math.random() * table.length)] ?? Object.keys(MONSTER_SPECS)[0];
  return {
    id: `w_${now.toString(36)}_${(seq++).toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`,
    areaId,
    theme: spec.theme,
    speciesId,
    name: MONSTER_SPECS[speciesId]?.name ?? speciesId,
    level: spec.levelMin,
    label: `野生 ${MONSTER_SPECS[speciesId]?.name ?? speciesId}`,
    spawnedAt: now,
    expiresAt: now + WILD_TTL_MS,
    status: 'available' as const,
    result: null,
    claim: null,
  };
}

function makeStorage(over: Partial<{ perArea: number; claimTtlMs: number; ttlMs: number; graceMs: number }> = {}) {
  if (!client) throw new Error('redis not ready');
  return new RedisWildStorage({
    client,
    prefix: PREFIX,
    perArea: over.perArea ?? WILD_PER_AREA,
    ttlMs: over.ttlMs ?? WILD_TTL_MS,
    claimTtlMs: over.claimTtlMs ?? WILD_CLAIM_TTL_MS,
    graceMs: over.graceMs ?? 10_000,
    spawner,
  });
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

test('W7 Redis：同 wildId 并发 10 路 claim 只有 1 个成功', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const id = (await s.listArea(AREA, SPEC, NOW)).monsters[0].id;

  const results = await Promise.all(
    Array.from({ length: 10 }, (_, i) => s.claim(id, `u${i}`, `b${i}`, NOW)),
  );
  const ok = results.filter((r) => r.ok);
  assert.equal(ok.length, 1, 'Lua 必须让并发 claim 只有 1 个成功');
  const failed = results.filter((r) => !r.ok) as Array<{ ok: false; code: string }>;
  assert.equal(failed.length, 9);
  for (const f of failed) assert.ok(['WILD_CLAIMED', 'WILD_ON_COOLDOWN'].includes(f.code));

  const view = await s.listArea(AREA, SPEC, NOW);
  assert.equal(view.monsters.find((m) => m.id === id)?.status, 'claimed');
});

test('W7 Redis：同账号已有在途野怪时，第二只拒绝 WILD_ON_COOLDOWN', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const ms = (await s.listArea(AREA, SPEC, NOW)).monsters;
  assert.equal((await s.claim(ms[0].id, 'uA', 'bA1', NOW)).ok, true);
  const second = await s.claim(ms[1].id, 'uA', 'bA2', NOW);
  assert.equal(second.ok, false);
  if ('code' in second) assert.equal(second.code, 'WILD_ON_COOLDOWN');
  // 别的账号不受影响
  assert.equal((await s.claim(ms[1].id, 'uB', 'bB1', NOW)).ok, true);
});

test('W7 Redis：每区恒 3 只，且两个实例并发 ensure 不会超量', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const a = makeStorage();
  const b = makeStorage();
  await a.clear();
  // 并发 ensure：ENSURE + APPEND 两段脚本都带 SCARD 校验，最多补到 perArea
  await Promise.all([a.ensure(AREA, SPEC, NOW), b.ensure(AREA, SPEC, NOW), a.ensure(AREA, SPEC, NOW)]);
  const snap = await a.listArea(AREA, SPEC, NOW);
  assert.equal(snap.monsters.length, WILD_PER_AREA);
  const again = await b.listArea(AREA, SPEC, NOW);
  assert.equal(again.monsters.length, WILD_PER_AREA);
  // 两个实例看到同一批实例（共享真值）
  assert.deepEqual(
    again.monsters.map((m) => m.id).sort(),
    snap.monsters.map((m) => m.id).sort(),
  );
});

test('W7 Redis：claim 超时由 ensure 归还，回到 available 且清掉在途索引', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage({ claimTtlMs: 50 });
  await s.clear();
  const id = (await s.listArea(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await s.claim(id, 'uB', 'bB', NOW)).ok, true);
  // 未超时：仍是 claimed
  await s.ensure(AREA, SPEC, NOW + 10);
  assert.equal((await s.listArea(AREA, SPEC, NOW + 10)).monsters.find((m) => m.id === id)?.status, 'claimed');
  // 超过 claimTtl：归还
  await s.ensure(AREA, SPEC, NOW + 100);
  const view = await s.listArea(AREA, SPEC, NOW + 100);
  assert.equal(view.monsters.find((m) => m.id === id)?.status, 'available');
  assert.equal(await s.findByBattle('bB'), undefined, '在途索引必须清掉');
  // 归还后别人能抢
  assert.equal((await s.claim(id, 'uC', 'bC', NOW + 120)).ok, true);
});

test('W7 Redis：resolve 双键归属校验，别人不能结束我的野怪', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const id = (await s.listArea(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await s.claim(id, 'u1', 'bt1', NOW)).ok, true);
  assert.equal(await s.resolve(id, 'u2', 'bt1', 'captured', NOW), false, 'userId 不符');
  assert.equal(await s.resolve(id, 'u1', 'bt2', 'captured', NOW), false, 'battleId 不符');
  assert.equal(await s.resolve(id, 'u1', 'bt1', 'captured', NOW), true);
  const view = await s.listArea(AREA, SPEC, NOW + 100);
  const m = view.monsters.find((x) => x.id === id);
  assert.equal(m?.status, 'resolved');
  assert.equal(m?.result, 'captured');
  assert.equal(await s.findByBattle('bt1'), undefined);
});

test('W7 Redis：release 按 battleId 归还，别人还能抢', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const id = (await s.listArea(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await s.claim(id, 'u1', 'bt1', NOW)).ok, true);
  assert.equal((await s.findByBattle('bt1'))?.id, id);
  assert.deepEqual(await s.release('bt1', NOW), [AREA]);
  assert.equal(await s.findByBattle('bt1'), undefined);
  assert.deepEqual(await s.release('bt1', NOW), [], '重复释放幂等');
  const view = await s.listArea(AREA, SPEC, NOW);
  assert.equal(view.monsters.find((m) => m.id === id)?.status, 'available');
  assert.equal((await s.claim(id, 'u2', 'bt2', NOW)).ok, true);
});

test('W7 Redis：resolved 宽限期内保留，过期后移除并补满', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage({ graceMs: 1_000 });
  await s.clear();
  const id = (await s.listArea(AREA, SPEC, NOW)).monsters[0].id;
  await s.claim(id, 'u', 'bt', NOW);
  await s.resolve(id, 'u', 'bt', 'defeated', NOW);
  const during = await s.listArea(AREA, SPEC, NOW + 500);
  assert.equal(during.monsters.find((m) => m.id === id)?.status, 'resolved');
  const later = await s.listArea(AREA, SPEC, NOW + 2_000);
  assert.equal(later.monsters.find((m) => m.id === id), undefined);
  assert.equal(later.monsters.length, WILD_PER_AREA);
});

test('W7 Redis：revision 按区域独立，纯读取不推进', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const v0 = (await s.listArea(AREA, SPEC, NOW)).revision;
  await s.listArea(AREA, SPEC, NOW + 1);
  assert.equal(await s.revisionFor(AREA), v0, '列表无变化不该推新版本');
  await s.listArea('w7test_other', SPEC, NOW + 1);
  assert.equal(await s.revisionFor(AREA), v0, '别的区域不影响本区域');
  const id = (await s.listArea(AREA, SPEC, NOW + 1)).monsters[0].id;
  await s.claim(id, 'u', 'bt', NOW + 1);
  assert.ok((await s.revisionFor(AREA)) > v0, '抢占要推进本区域版本');
  assert.ok((await s.stats()).revision > 0, '全局累计数单调');
});

test('W7 Redis：stats 反映真实实例数与状态分布', async (t) => {
  if (!reachable) return t.skip('无可用 Redis（CI）');
  const s = makeStorage();
  await s.clear();
  const ms = (await s.listArea(AREA, SPEC, NOW)).monsters;
  await s.claim(ms[0].id, 'u', 'bt', NOW);
  const st = await s.stats();
  assert.equal(st.active, WILD_PER_AREA);
  assert.equal(st.areas, 1);
  assert.equal(st.claimed, 1);
  assert.equal(st.available, WILD_PER_AREA - 1);
});
