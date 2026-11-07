// P4-1b 共享野怪实例池：纯逻辑单测（捕获互斥 / 归属 / TTL / 公开视图）。
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

test('list：每个区域自动补足 3 只，字段完整且不含归属信息', () => {
  const r = new WildRegistry({ rng: seeded() });
  const snap = r.list(AREA, SPEC, NOW);
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

test('捕获互斥：同一实例被两个账号同时 claim，只有第一个成功', () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = r.list(AREA, SPEC, NOW).monsters[0].id;
  const a = r.claim(id, 'userA', 1, 'battleA', NOW);
  const b = r.claim(id, 'userB', 1, 'battleB', NOW);
  assert.equal(a.ok, true);
  assert.equal(b.ok, false);
  if ('code' in b) assert.equal(b.code, 'WILD_CLAIMED');
  assert.equal(r.list(AREA, SPEC, NOW).monsters.find((m) => m.id === id)?.status, 'claimed');
});

test('claim 未知实例 / 已结算实例 / 同槽位重复抢占，全部拒绝', () => {
  const r = new WildRegistry({ rng: seeded() });
  const monsters = r.list(AREA, SPEC, NOW).monsters;
  const unknown = r.claim('w_not_exist', 'u', 1, 'b', NOW);
  assert.equal(unknown.ok, false);
  if ('code' in unknown) assert.equal(unknown.code, 'WILD_NOT_FOUND');

  assert.equal(r.claim(monsters[0].id, 'u', 1, 'b1', NOW).ok, true);
  const cooldown = r.claim(monsters[1].id, 'u', 1, 'b2', NOW);
  assert.equal(cooldown.ok, false);
  if ('code' in cooldown) assert.equal(cooldown.code, 'WILD_ON_COOLDOWN');

  assert.equal(r.resolve(monsters[0].id, 'u', 1, 'b1', 'captured', NOW), true);
  const resolved = r.claim(monsters[0].id, 'other', 1, 'b3', NOW);
  assert.equal(resolved.ok, false);
  if ('code' in resolved) assert.equal(resolved.code, 'WILD_RESOLVED');
});

test('resolve 三键归属：别人不能结束我的野怪', () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = r.list(AREA, SPEC, NOW).monsters[0].id;
  assert.equal(r.claim(id, 'u1', 1, 'bt1', NOW).ok, true);
  assert.equal(r.resolve(id, 'u2', 1, 'bt1', 'captured', NOW), false, 'userId 不符');
  assert.equal(r.resolve(id, 'u1', 2, 'bt1', 'captured', NOW), false, 'slot 不符');
  assert.equal(r.resolve(id, 'u1', 1, 'bt2', 'captured', NOW), false, 'battleId 不符');
  assert.equal(r.resolve(id, 'u1', 1, 'bt1', 'captured', NOW), true);
  const view = r.list(AREA, SPEC, NOW).monsters.find((m) => m.id === id);
  assert.equal(view?.status, 'resolved');
  assert.equal(view?.result, 'captured');
});

test('release：放弃战斗把野怪放回池子，别人还能抢', () => {
  const r = new WildRegistry({ rng: seeded() });
  const id = r.list(AREA, SPEC, NOW).monsters[0].id;
  assert.equal(r.claim(id, 'u1', 1, 'bt1', NOW).ok, true);
  assert.equal(r.findByBattle('bt1')?.id, id);
  const affected = r.release('bt1', NOW);
  assert.deepEqual(affected, [AREA]);
  assert.equal(r.findByBattle('bt1'), undefined);
  assert.equal(r.list(AREA, SPEC, NOW).monsters.find((m) => m.id === id)?.status, 'available');
  assert.equal(r.claim(id, 'u2', 1, 'bt2', NOW).ok, true);
});

test('TTL：未抢占的野怪到期换新；抢占超时自动放回', () => {
  const r = new WildRegistry({ rng: seeded() });
  const before = r.list(AREA, SPEC, NOW).monsters.map((m) => m.id);
  const after = r.list(AREA, SPEC, NOW + WILD_TTL_MS + 1).monsters.map((m) => m.id);
  assert.equal(after.length, WILD_PER_AREA);
  assert.ok(after.some((id) => !before.includes(id)), '过期的实例必须被换掉');

  const r2 = new WildRegistry({ rng: seeded() });
  const id = r2.list(AREA, SPEC, NOW).monsters[0].id;
  assert.equal(r2.claim(id, 'u', 1, 'bt', NOW).ok, true);
  r2.ensure(AREA, SPEC, NOW + WILD_CLAIM_TTL_MS + 1);
  assert.equal(r2.list(AREA, SPEC, NOW + WILD_CLAIM_TTL_MS + 1).monsters.find((m) => m.id === id)?.status,
    'available', '断线挂机不能永久占坑');
});

test('resolve 后保留宽限期，过期才补新实例', () => {
  const r = new WildRegistry({ rng: seeded(), graceMs: 10_000 });
  const id = r.list(AREA, SPEC, NOW).monsters[0].id;
  assert.equal(r.claim(id, 'u', 1, 'bt', NOW).ok, true);
  assert.equal(r.resolve(id, 'u', 1, 'bt', 'defeated', NOW), true);
  const during = r.list(AREA, SPEC, NOW + 5_000).monsters.find((m) => m.id === id);
  assert.equal(during?.status, 'resolved', '其他客户端要能看到「已被击败」');
  assert.equal(during?.result, 'defeated');
  const after = r.list(AREA, SPEC, NOW + 11_000).monsters.find((m) => m.id === id);
  assert.equal(after, undefined, '宽限期后移除并补新怪');
  assert.equal(r.list(AREA, SPEC, NOW + 11_000).monsters.length, WILD_PER_AREA);
});

test('revision 按区域独立：别处补怪不影响本区域版本，且不因纯读取而增长', () => {
  const r = new WildRegistry({ rng: seeded() });
  const v0 = r.list(AREA, SPEC, NOW).revision;
  const v1 = r.list(AREA, SPEC, NOW + 1).revision;
  assert.equal(v1, v0, '列表没变化不该推新版本');
  r.list('another_area', SPEC, NOW + 1);
  assert.equal(r.revisionFor(AREA), v0, '别的区域补怪不能改本区域版本');
  assert.ok(r.currentRevision > 0, '全局累计变更数仍单调');

  const id = r.list(AREA, SPEC, NOW + 1).monsters[0].id;
  r.claim(id, 'u', 1, 'bt', NOW + 1);
  assert.ok(r.revisionFor(AREA) > v1, '抢占要推进本区域版本');
  r.resolve(id, 'u', 1, 'bt', 'captured', NOW + 1);
  assert.ok(r.revisionFor(AREA) > v1 + 1);
});

test('RNG 注入可复现，clear 后状态归零', () => {
  const a = new WildRegistry({ rng: seeded(0.7) });
  const b = new WildRegistry({ rng: seeded(0.7) });
  assert.deepEqual(a.list(AREA, SPEC, NOW).monsters, b.list(AREA, SPEC, NOW).monsters);
  a.clear();
  assert.deepEqual(a.stats(), { active: 0, areas: 0, available: 0, claimed: 0, revision: 0 });
});

test('sweep 返回受影响区域，供心跳广播', () => {
  const r = new WildRegistry({ rng: seeded() });
  r.list('areaA', SPEC, NOW);
  r.list('areaB', SPEC, NOW);
  assert.deepEqual(r.sweep(NOW + 1), [], '没变化不广播');
  const areas = r.sweep(NOW + WILD_TTL_MS + 1).sort();
  assert.deepEqual(areas, ['areaA', 'areaB']);
});
