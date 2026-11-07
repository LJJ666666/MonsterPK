/**
 * 服务端裁决与增量核对单测（P1-2 a/b/c/d + P1-3 玩法修复）。
 * 运行：cd backend && npx tsx --test tests/settlements.test.ts
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { digestOf, freshAuthority, type AuthorityState } from '../src/lib/authority.ts';
import {
  settleIdleServer, decideIntent, checkIntentDelta,
  ITEM_PRICES, INTENT_TYPES, type DecisionContext,
} from '../src/lib/settlements.ts';

const NOW = Date.parse('2026-11-06T06:00:00.000Z');

function save(overrides: Record<string, unknown> = {}) {
  return {
    version: '10',
    money: 5000,
    steps: 0,
    party: [{
      id: 'm1', specId: 'ember_marmot', level: 10, exp: 0, element: 'fire',
      maxHp: 60, hp: 60, atk: 20, def: 20, spAtk: 20, spDef: 20, spd: 20,
      status: 'none', moveIds: ['tackle'], initStats: {}, growthRates: {},
    }],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { ember_marmot: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: { area_a: { name: '初始草原', level: 12, theme: 'grass', clearedAt: 'x' } },
    lastSavedAt: new Date(NOW).toISOString(),
    ...overrides,
  };
}
const raw = (o: Record<string, unknown> = {}) => JSON.stringify(save(o));

function ctx(overrides: Partial<DecisionContext> = {}): DecisionContext {
  const dbSaveRaw = raw();
  return {
    nowMs: NOW,
    rng: () => 0,
    dbSaveRaw,
    authority: freshAuthority(dbSaveRaw),
    isAdmin: false,
    nonce: 'nonce-0001',
    ...overrides,
  };
}

/** 在基线摘要上构造「客户端提交的结算后摘要」。 */
function delta(base: ReturnType<typeof digestOf>, patch: Partial<ReturnType<typeof digestOf>> = {}) {
  return { ...base, ...patch };
}

// 捕获率公式已随 `capture` 意图下线迁到 game/rules.ts，
// 对应单测在 numericRules.test.ts 的「捕获率公式」一节。

// —— a 挂机：服务端时钟 + 服务端 RNG ——
test('settleIdleServer：8 小时封顶、RNG 可注入', () => {
  const capped = settleIdleServer(12, 600, () => 0);
  assert.equal(capped.effective, 480);
  assert.equal(capped.money, Math.floor(480 * (1.5 + 12 * 0.15)));
  assert.ok(Object.keys(capped.capsules).length > 0, 'rng=0 必掉球');
  const none = settleIdleServer(12, 600, () => 0.99);
  assert.deepEqual(none.capsules, {}, 'rng=0.99 不掉球');
});

test('idle_start：区域难度只认服务端存档，不采信客户端上报', () => {
  const r = decideIntent('idle_start', { areaId: 'area_a', level: 999 }, ctx());
  assert.equal(r.ok, true);
  assert.equal(r.pending?.idleStart?.level, 12);
  assert.equal(r.pending?.idleStart?.startedAtMs, NOW);
  assert.equal(r.pending?.allow.idle, 'start');
  assert.equal(decideIntent('idle_start', { areaId: 'not_cleared' }, ctx()).ok, false);
});

test('idle_claim：按服务端时钟结算，客户端时间前调/后调都不进入计算', () => {
  let authority: AuthorityState = freshAuthority(raw());
  authority.idleStartedAtMs = NOW - 60 * 60000;
  authority.idleLevel = 12;
  authority.idleAreaId = 'area_a';
  const r = decideIntent('idle_claim', { clientStartedAt: '1999-01-01T00:00:00.000Z' }, ctx({ authority, rng: () => 0.99 }));
  assert.equal(r.ok, true);
  assert.equal(r.pending?.result?.minutes, 60);
  assert.equal(r.pending?.allow.exact?.money, Math.floor(60 * (1.5 + 12 * 0.15)));
  assert.equal(decideIntent('idle_claim', {}, ctx()).ok, false, '无派遣不能领取');
});

test('idle_start 的提交：增量核对要求存档写入同一个区域与难度', () => {
  const c = ctx();
  const p = decideIntent('idle_start', { areaId: 'area_a' }, c).pending!;
  const good = delta(p.baseDigest, { idleAreaId: 'area_a' });
  assert.deepEqual(checkIntentDelta(p.baseDigest, good, p), []);
  const forged = delta(p.baseDigest, { idleAreaId: 'area_evil' });
  assert.ok(checkIntentDelta(p.baseDigest, forged, p).some((v) => v.code === 'DELTA_IDLE'));
});

// —— b 捕获与战斗奖励已下线（2026-11-07）——
// 两者原先都采信客户端上报的过程数据（baseRate / enemyLevel），战斗上移后
// 等于零成本刷资源。奖励与捕获现在只由 game/battle.ts 的真实战斗结算产生。
test('capture / battle_reward 意图已下线，直接调用一律拒绝', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['capture', { itemId: 'capsule_basic', enemyLevel: 10, enemyHp: 5, enemyMaxHp: 100, baseRate: 0.45 }],
    ['battle_reward', { enemyLevel: 30, areaId: 'area_a', monsterIds: ['m1'] }],
  ];
  for (const [type, payload] of cases) {
    const r: any = decideIntent(type as any, payload, ctx({ rng: () => 0 }));
    assert.equal(r.ok, false, `${type} 不该再被接受`);
    assert.equal(r.pending, undefined, `${type} 不该再产出授权`);
    assert.match(String(r.reason), /未知的操作类型/);
  }
});

test('capture / battle_reward 不在意图白名单里（防止有人重新加回去）', () => {
  assert.equal(INTENT_TYPES.includes('capture' as any), false);
  assert.equal(INTENT_TYPES.includes('battle_reward' as any), false);
});

test('shop_buy：价格取服务端表，客户端改价无效；金币不足拒绝', () => {
  const r = decideIntent('shop_buy', { itemId: 'capsule_prism', amount: 2, price: 1 }, ctx());
  assert.equal(r.pending?.result?.cost, ITEM_PRICES.capsule_prism * 2);
  assert.equal(r.pending?.allow.exact?.money, -ITEM_PRICES.capsule_prism * 2);
  assert.equal(r.pending?.allow.exact?.inventory?.capsule_prism, 2);
  assert.equal(decideIntent('shop_buy', { itemId: 'capsule_master', amount: 99 }, ctx()).ok, false);
  assert.equal(decideIntent('shop_buy', { itemId: 'not_an_item', amount: 1 }, ctx()).ok, false);
});

test('shop_buy 提交：少扣钱（白嫖）会被精确增量核对拒绝', () => {
  const p = decideIntent('shop_buy', { itemId: 'capsule_prism', amount: 2 }, ctx()).pending!;
  const base = p.baseDigest;
  const free = delta(base, {
    money: base.money, // 没扣钱
    inventory: { ...base.inventory, capsule_prism: (base.inventory.capsule_prism ?? 0) + 2 },
  });
  assert.ok(checkIntentDelta(base, free, p).some((v) => v.code === 'DELTA_MONEY'));
  const good = delta(base, {
    money: base.money - ITEM_PRICES.capsule_prism * 2,
    inventory: { ...base.inventory, capsule_prism: (base.inventory.capsule_prism ?? 0) + 2 },
  });
  assert.deepEqual(checkIntentDelta(base, good, p), []);
});

// —— d 管理员授权与通用边界 ——
test('admin_test：普通账号拒绝，管理员走服务端授权重建基线', () => {
  assert.equal(decideIntent('admin_test', {}, ctx()).ok, false);
  const p = decideIntent('admin_test', {}, ctx({ isAdmin: true })).pending!;
  assert.equal(p.allow.rebase, true);
  const base = p.baseDigest;
  const anything = delta(base, { money: 999999 });
  assert.deepEqual(checkIntentDelta(base, anything, p), [], '管理员授权后跳过增量核对');
});

test('checkIntentDelta：多 1 金币也拒绝，未授权的资源增量一律拒绝', () => {
  const p = decideIntent('idle_cancel', {}, ctx({
    authority: (() => { const a = freshAuthority(raw()); a.idleAreaId = 'area_a'; return a; })(),
  })).pending!;
  const base = p.baseDigest;
  assert.deepEqual(checkIntentDelta(base, delta(base), p), []);
  assert.ok(checkIntentDelta(base, delta(base, { money: base.money + 1 }), p).some((v) => v.code === 'DELTA_MONEY'));
  assert.ok(checkIntentDelta(base, delta(base, {
    inventory: { ...base.inventory, capsule_master: 1 },
  }), p).some((v) => v.code === 'DELTA_ITEM'));
});

test('增量核对：新增幻兽 id 不应被等级/经验上限误拦', () => {
  // capture 意图已下线（真实捕获只走服务端战斗结算），但这条核对语义仍要守住：
  // allow.max.levelExp 里没列出的新 id 不能被当成「超上限」拦掉，
  // 否则服务端结算出来的新幻兽会在校验处被打回。
  const base = digestOf(raw());
  const p: any = {
    nonce: 'n-new-roster', type: 'capture', createdAtMs: 0, baseDigest: base,
    allow: {
      exact: { money: 0, inventory: { capsule_basic: -1 }, rosterCount: 1, totalCaptured: 1 },
      max: { levelExp: {} },
    },
    result: {},
  };
  const good = delta(base, {
    inventory: { ...base.inventory, capsule_basic: base.inventory.capsule_basic - 1 },
    rosterCount: base.rosterCount + 1,
    totalCaptured: base.totalCaptured + 1,
    levelExp: { ...base.levelExp, captured_new: [5, 12] },
  });
  assert.deepEqual(checkIntentDelta(base, good, p), [], '合法的捕获成功必须放行');
});
