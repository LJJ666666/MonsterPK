// P4-1b 共享野怪实例池：纯逻辑单测（捕获互斥 / 归属 / TTL / 公开视图）。
// W7.0：facade 与存储接口全 async 化，本文件同步加 await；断言逐条保留不改。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WildRegistry, WILD_PER_AREA, WILD_TTL_MS, WILD_CLAIM_TTL_MS,
  type WildAreaSpec,
} from '../src/lib/wildRegistry';
import { THEME_TABLE, MONSTER_SPECS } from '../src/game/content';

const SPEC: WildAreaSpec = { theme: 'grass', levelMin: 2, levelMax: 4 };
const NOW = 1_700_000_000_000;
const AREA = 'area_test';

/** 固定 RNG，保证生成可复现，不受全局 Math.random 影响。 */
function seeded(seed = 0.42): () => number {
  let x = seed;
  return () => {
    x = (x * 9301 + 49297) % 233280;
    return x / 233280;
  };
}

test('list：每个区域自动补足 3 只，字段完整且不含归属信息', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const snap = await r.list(AREA, SPEC, NOW);
  assert.equal(snap.monsters.length, WILD_PER_AREA);
  assert.ok(snap.revision > 0);
  for (const m of snap.monsters) {
    assert.equal(m.areaId, AREA);
    assert.equal(m.status, 'available');
    assert.equal(m.result, null);
    assert.ok(MONSTER_SPECS[m.speciesId], '种族必须来自内容表');
    assert.ok(THEME_TABLE[SPEC.theme].includes(m.speciesId));
    assert.ok(m.level >= 2 && m.level <= 60);
    assert.equal((m as any).claim, undefined, '公开视图不能泄露 userId / battleId');
    assert.equal((m as any).userId, undefined);
  }
});

test('捕获互斥：同一实例被两个账号同时 claim，只有第一个成功', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = (await r.list(AREA, SPEC, NOW)).monsters[0].id;
  const a = await r.claim(id, 'userA', 'battleA', NOW);
  const b = await r.claim(id, 'userB', 'battleB', NOW);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  if ('code' in b) assert.equal(b.code, 'WILD_CLAIMED');
  const view = await r.list(AREA, SPEC, NOW);
  assert.equal(view.monsters.find((m) => m.id === id)?.status, 'claimed');
});

test('claim 未知实例 / 已结算实例 / 单账号重复抢占，全部拒绝', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const monsters = (await r.list(AREA, SPEC, NOW)).monsters;
  const unknown = await r.claim('w_not_exist', 'u', 'b', NOW);
  assert.equal(unknown.ok, false);
  if ('code' in unknown) assert.equal(unknown.code, 'WILD_NOT_FOUND');

  assert.equal((await r.claim(monsters[0].id, 'u', 'b1', NOW)).ok, true);
  const cooldown = await r.claim(monsters[1].id, 'u', 'b2', NOW);
  assert.equal(cooldown.ok, false);
  if ('code' in cooldown) assert.equal(cooldown.code, 'WILD_ON_COOLDOWN');

  assert.equal(await r.resolve(monsters[0].id, 'u', 'b1', 'captured', NOW), true);
  const resolved = await r.claim(monsters[0].id, 'other', 'b3', NOW);
  assert.equal(resolved.ok, false);
  if ('code' in resolved) assert.equal(resolved.code, 'WILD_RESOLVED');
});

test('resolve 二键归属：别人不能结束我的野怪', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = (await r.list(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await r.claim(id, 'u1', 'bt1', NOW)).ok, true);
  assert.equal(await r.resolve(id, 'u2', 'bt1', 'captured', NOW), false, 'userId 不符');
  assert.equal(await r.resolve(id, 'u1', 'bt2', 'captured', NOW), false, 'battleId 不符');
  assert.equal(await r.resolve(id, 'u1', 'bt1', 'captured', NOW), true);
  const view = (await r.list(AREA, SPEC, NOW)).monsters.find((m) => m.id === id);
  assert.equal(view?.status, 'resolved');
  assert.equal(view?.result, 'captured');
});

test('release：放弃战斗把野怪放回池子，别人还能抢', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = (await r.list(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await r.claim(id, 'u1', 'bt1', NOW)).ok, true);
  assert.equal((await r.findByBattle('bt1'))?.id, id);
  const affected = await r.release('bt1', NOW);
  assert.deepEqual(affected, [AREA]);
  assert.equal(await r.findByBattle('bt1'), undefined);
  const view = await r.list(AREA, SPEC, NOW);
  assert.equal(view.monsters.find((m) => m.id === id)?.status, 'available');
  assert.equal((await r.claim(id, 'u2', 'bt2', NOW)).ok, true);
});

test('TTL：未抢占的野怪到期换新；抢占超时自动放回', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const before = (await r.list(AREA, SPEC, NOW)).monsters.map((m) => m.id);
  const after = (await r.list(AREA, SPEC, NOW + WILD_TTL_MS + 1)).monsters.map((m) => m.id);
  assert.equal(after.length, WILD_PER_AREA);
  assert.ok(after.some((id) => !before.includes(id)), '过期的实例必须被换掉');

  const r2 = new WildRegistry({ rng: seeded() });
  const id = (await r2.list(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await r2.claim(id, 'u', 'bt', NOW)).ok, true);
  await r2.ensure(AREA, SPEC, NOW + WILD_CLAIM_TTL_MS + 1);
  const view = await r2.list(AREA, SPEC, NOW + WILD_CLAIM_TTL_MS + 1);
  assert.equal(view.monsters.find((m) => m.id === id)?.status,
    'available', '断线挂机不能永久占坑');
});

test('resolve 后保留宽限期，过期才补新实例', async () => {
  const r = new WildRegistry({ rng: seeded(), graceMs: 10_000 });
  const id = (await r.list(AREA, SPEC, NOW)).monsters[0].id;
  assert.equal((await r.claim(id, 'u', 'bt', NOW)).ok, true);
  assert.equal(await r.resolve(id, 'u', 'bt', 'defeated', NOW), true);
  const during = (await r.list(AREA, SPEC, NOW + 5_000)).monsters.find((m) => m.id === id);
  assert.equal(during?.status, 'resolved', '其他客户端要能看到「已被击败」');
  assert.equal(during?.result, 'defeated');
  const after = (await r.list(AREA, SPEC, NOW + 11_000)).monsters.find((m) => m.id === id);
  assert.equal(after, undefined, '宽限期后移除并补新怪');
  assert.equal((await r.list(AREA, SPEC, NOW + 11_000)).monsters.length, WILD_PER_AREA);
});

test('revision 按区域独立：别处补怪不影响本区域版本，且不因纯读取而增长', async () => {
  const r = new WildRegistry({ rng: seeded() });
  const v0 = (await r.list(AREA, SPEC, NOW)).revision;
  const v1 = (await r.list(AREA, SPEC, NOW + 1)).revision;
  assert.equal(v1, v0, '列表没变化不该推新版本');
  await r.list('another_area', SPEC, NOW + 1);
  assert.equal(await r.revisionFor(AREA), v0, '别的区域补怪不能改本区域版本');
  assert.ok((await r.stats()).revision > 0, '全局累计变更数仍单调');

  const id = (await r.list(AREA, SPEC, NOW + 1)).monsters[0].id;
  await r.claim(id, 'u', 'bt', NOW + 1);
  assert.ok((await r.revisionFor(AREA)) > v1, '抢占要推进本区域版本');
  await r.resolve(id, 'u', 'bt', 'captured', NOW + 1);
  assert.ok((await r.revisionFor(AREA)) > v1 + 1);
});

test('RNG 注入可复现，clear 后状态归零', async () => {
  const a = new WildRegistry({ rng: seeded(0.7) });
  const b = new WildRegistry({ rng: seeded(0.7) });
  assert.deepEqual((await a.list(AREA, SPEC, NOW)).monsters, (await b.list(AREA, SPEC, NOW)).monsters);
  await a.clear();
  assert.deepEqual(await a.stats(), { active: 0, areas: 0, available: 0, claimed: 0, revision: 0 });
});

test('sweep 返回受影响区域，供心跳广播', async () => {
  const r = new WildRegistry({ rng: seeded() });
  await r.list('areaA', SPEC, NOW);
  await r.list('areaB', SPEC, NOW);
  assert.deepEqual(await r.sweep(NOW + 1), [], '没变化不广播');
  const areas = (await r.sweep(NOW + WILD_TTL_MS + 1)).sort();
  assert.deepEqual(areas, ['areaA', 'areaB']);
});
