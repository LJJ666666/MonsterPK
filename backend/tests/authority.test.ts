/**
 * 服务端权威摘要单测（P1-2 底座）。
 * 运行：cd backend && npx tsx --test tests/authority.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  digestOf, compareDigest, parseAuthority, freshAuthority, serializeAuthority,
  advanceAuthority, checkFreshSave, checkPartyStateRegression,
} from '../src/lib/authority.ts';

function save(overrides: Record<string, unknown> = {}) {
  return {
    version: '10',
    playerName: 'tx',
    money: 100,
    steps: 0,
    party: [{
      id: 'm1', specId: 'ember_marmot', level: 5, exp: 0, element: 'fire',
      maxHp: 30, hp: 30, atk: 10, def: 10, spAtk: 10, spDef: 10, spd: 10,
      status: 'none', moveIds: ['tackle'], initStats: {}, growthRates: {},
    }],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { ember_marmot: { seen: true, captured: true, timesCaptured: 1 } },
    lastSavedAt: '2026-11-06T00:00:00.000Z',
    ...overrides,
  };
}
const raw = (o: Record<string, unknown> = {}) => JSON.stringify(save(o));

test('digestOf 提取全部裁决字段', () => {
  const d = digestOf(raw({ clearedAreas: { area_a: { level: 12 } }, idle: { areaId: 'area_a', level: 12, startedAt: 'x' } }));
  assert.equal(d.money, 100);
  assert.equal(d.inventory.capsule_basic, 6);
  assert.deepEqual(d.levelExp.m1, [5, 0]);
  assert.equal(d.rosterCount, 1);
  assert.equal(d.totalCaptured, 1);
  assert.deepEqual(d.clearedAreas, ['area_a']);
  assert.equal(d.idleAreaId, 'area_a');
});

test('digestOf 对坏 JSON 返回空摘要而不是抛异常', () => {
  const d = digestOf('not-json');
  assert.equal(d.money, 0);
  assert.equal(d.rosterCount, 0);
});

test('compareDigest：自造资源增量一律拦下', () => {
  const base = digestOf(raw());
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['改钱', { money: 500 }, 'AUTHORITY_MONEY_INCREASE'],
    ['加道具', { inventory: { capsule_basic: 7, potion_small: 3 } }, 'AUTHORITY_ITEM_INCREASE'],
    ['凭空造新道具', { inventory: { capsule_basic: 6, potion_small: 3, capsule_master: 99 } }, 'AUTHORITY_ITEM_INCREASE'],
    ['提等级', { party: [{ ...save().party[0], level: 99 }] }, 'AUTHORITY_MONSTER_INCREASE'],
    ['凭空多怪', { box: [{ id: 'fake', level: 5, exp: 0 }] }, 'AUTHORITY_ROSTER_INCREASE'],
    ['伪造捕获数', { collection: { ember_marmot: { timesCaptured: 9 } } }, 'AUTHORITY_CAPTURE_INCREASE'],
    ['伪造首通', { clearedAreas: { area_x: { level: 30 } } }, 'AUTHORITY_AREA_INCREASE'],
    ['绕过挂机接口塞派遣', { idle: { areaId: 'area_x', level: 30 } }, 'AUTHORITY_IDLE_FORGED'],
  ];
  for (const [name, patch, code] of cases) {
    const violations = compareDigest(digestOf(raw(patch)), base);
    assert.ok(violations.some((v) => v.code === code), `${name} 应被 ${code} 拦下`);
  }
});

test('compareDigest：合法消耗（只减不增）放行', () => {
  const base = digestOf(raw());
  const spent = digestOf(raw({
    money: 20,
    inventory: { capsule_basic: 5, potion_small: 2 },
  }));
  assert.deepEqual(compareDigest(spent, base), []);
  assert.deepEqual(compareDigest(base, base), []);
});

test('parseAuthority：老档无 authority / 坏数据都能自愈重建基线', () => {
  for (const bad of [null, '', '{broken', '{"foo":1}']) {
    const a = parseAuthority(bad, raw());
    assert.equal(a.revision, 0);
    assert.equal(a.pending, null);
    assert.equal(a.expected.money, 100);
  }
});

test('serialize / parse 往返保留一次性意图授权', () => {
  const a = freshAuthority(raw());
  a.pending = {
    nonce: 'nonce-0001', type: 'capture', createdAtMs: 1000,
    baseDigest: a.expected, allow: { exact: { money: 0 } }, result: { ok: true },
  };
  a.idleStartedAtMs = 1234;
  const restored = parseAuthority(serializeAuthority(a), raw());
  assert.equal(restored.pending?.nonce, 'nonce-0001');
  assert.equal(restored.pending?.allow.exact?.money, 0);
  assert.equal(restored.idleStartedAtMs, 1234);
});

test('advanceAuthority：结算后抬升期望值、递增 revision、清 pending', () => {
  const a = freshAuthority(raw());
  a.pending = { nonce: 'n', type: 'capture', createdAtMs: 0, baseDigest: a.expected, allow: {}, result: {} };
  const nextRaw = raw({ money: 150 });
  const next = advanceAuthority(a, nextRaw, { pending: null });
  assert.equal(next.expected.money, 150);
  assert.equal(next.revision, 1);
  assert.equal(next.pending, null);
});

test('checkFreshSave：只放行真正的初始档', () => {
  assert.equal(checkFreshSave(raw({ money: 0, collection: { x: { timesCaptured: 1 } } })).ok, true);
  assert.equal(checkFreshSave(raw({ money: 999999 })).ok, false, '伪造 rebase 加钱必须被拒');
  assert.equal(checkFreshSave(raw({ money: 0, inventory: { capsule_master: 99 } })).ok, false);
  assert.equal(checkFreshSave(raw({ money: 0, box: [{ id: 'x' }] })).ok, false);
  assert.equal(checkFreshSave(raw({ money: 0, party: [{ ...save().party[0], level: 99 }] })).ok, false);
  assert.equal(checkFreshSave(raw({ money: 0, clearedAreas: { a: { level: 30 } } })).ok, false);
  assert.equal(checkFreshSave('bad-json').ok, false);
});

// —— P3-2：HP / 异常状态回归校验 ——
// 资源摘要不含 HP，若不单独拦，客户端把血改满、把烧伤清掉都能通过普通整包 PUT。

test('checkPartyStateRegression：HP 增加被判违规', () => {
  const prev = raw();
  const next = JSON.stringify({ ...save(), party: [{ ...save().party[0], hp: 30 }] });
  const shrunk = JSON.stringify({ ...save(), party: [{ ...save().party[0], hp: 5 }] });
  assert.equal(checkPartyStateRegression(shrunk, next)?.code, 'AUTHORITY_HP_INCREASE');
  assert.equal(checkPartyStateRegression(shrunk, shrunk), null, 'HP 不变应放行');
  assert.equal(checkPartyStateRegression(prev, shrunk), null, 'HP 下降应放行');
});

test('checkPartyStateRegression：异常状态被清除判违规', () => {
  const burned = JSON.stringify({ ...save(), party: [{ ...save().party[0], status: 'burn' }] });
  const clean = JSON.stringify({ ...save(), party: [{ ...save().party[0], status: 'none' }] });
  const poisoned = JSON.stringify({ ...save(), party: [{ ...save().party[0], status: 'poison' }] });
  assert.equal(checkPartyStateRegression(burned, clean)?.code, 'AUTHORITY_STATUS_CLEARED');
  assert.equal(checkPartyStateRegression(burned, poisoned), null, '状态变化（未治愈）应放行');
  assert.equal(checkPartyStateRegression(clean, clean), null);
});

test('checkPartyStateRegression：没有前档 / 坏 JSON 直接放行（交给其它校验）', () => {
  assert.equal(checkPartyStateRegression(null, raw()), null);
  assert.equal(checkPartyStateRegression('bad-json', raw()), null);
  assert.equal(checkPartyStateRegression(raw(), 'bad-json'), null);
});

test('checkPartyStateRegression：新 id 不参与比较（捕获由持有数校验兜底）', () => {
  const next = JSON.stringify({ ...save(), party: [{ ...save().party[0], id: 'new1', hp: 30 }] });
  assert.equal(checkPartyStateRegression(raw(), next), null);
});
