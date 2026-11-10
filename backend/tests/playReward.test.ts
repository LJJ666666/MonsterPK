/**
 * F14 玩法奖励纯函数单测。
 * 运行：cd backend && npx tsx --test tests/playReward.test.ts
 *
 * 重点：奖励数值只在服务端、双档数值与每日上限口径、写档只增 money/inventory、
 * 绝不触碰队伍 / 等级 / 图鉴 / 首通、坏档拒绝、非法道具过滤、时钟注入可复现。
 * 幂等性属于 DB 唯一键 + 槽位锁的职责，本文件刻意测「纯函数本身重复调用会累加」，
 * 钉住「调用方必须去重」这一契约。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSS_FIRST_REWARD, BOSS_PER_RUN_REWARD, COOP_CLEAR_REWARD,
  applyPlayReward, playRewardView, sumPlayRewards, PlayRewardError,
  perRunGrantKey, firstGrantKey,
} from '../src/game/playReward.js';

const NOW = '2026-11-09T09:00:00.000Z';

function baseSave() {
  return {
    version: 10,
    money: 500,
    inventory: { potion_small: 2 },
    party: [{ id: 'm1', specId: 'spark_mouse', level: 12, hp: 40, maxHp: 40 }],
    box: [{ id: 'm2', specId: 'spark_mouse', level: 3 }],
    collection: { spark_mouse: { seen: true, captured: true, timesCaptured: 2 } },
    clearedAreas: { area_1: { name: '区域1', level: 5 } },
    locationId: 'town_1',
  };
}

const parse = (raw: string) => JSON.parse(raw);

test('F14 双档数值：首讨大包 100 + prism，每场小包 20 + potion', () => {
  assert.equal(BOSS_FIRST_REWARD.money, 100);
  assert.deepEqual(BOSS_FIRST_REWARD.items, { capsule_prism: 1 });
  assert.equal(BOSS_PER_RUN_REWARD.money, 20);
  assert.deepEqual(BOSS_PER_RUN_REWARD.items, { potion_small: 1 });
});

test('双档全天上限（每日 3 次）低于 F02 榜一 300，避免打日常比冲榜划算', () => {
  const dailyMax = BOSS_FIRST_REWARD.money + BOSS_PER_RUN_REWARD.money * 3;
  assert.equal(dailyMax, 160);
  assert.ok(dailyMax < 300);
});

test('F16 共斗通关奖励常量已集中（本轮只设计不发）', () => {
  assert.equal(COOP_CLEAR_REWARD.money, 40);
  assert.deepEqual(COOP_CLEAR_REWARD.items, { capsule_basic: 1 });
});

test('applyPlayReward 只增 money 与 inventory，叠加已有数量', () => {
  const next = parse(applyPlayReward(JSON.stringify(baseSave()), BOSS_PER_RUN_REWARD, NOW));
  assert.equal(next.money, 520);
  assert.equal(next.inventory.potion_small, 3);
});

test('首讨大包：新道具写入，原有道具不动，lastSavedAt 用注入时钟', () => {
  const next = parse(applyPlayReward(JSON.stringify(baseSave()), BOSS_FIRST_REWARD, NOW));
  assert.equal(next.money, 600);
  assert.equal(next.inventory.capsule_prism, 1);
  assert.equal(next.inventory.potion_small, 2);
  assert.equal(next.lastSavedAt, NOW);
});

test('绝不触碰队伍 / 等级 / 图鉴 / 首通 / 位置等其它真值', () => {
  const before = baseSave();
  const next = parse(applyPlayReward(JSON.stringify(before), sumPlayRewards([
    BOSS_FIRST_REWARD, BOSS_PER_RUN_REWARD,
  ]), NOW));
  assert.deepEqual(next.party, before.party);
  assert.deepEqual(next.box, before.box);
  assert.deepEqual(next.collection, before.collection);
  assert.deepEqual(next.clearedAreas, before.clearedAreas);
  assert.equal(next.locationId, before.locationId);
  assert.equal(next.version, before.version);
  assert.equal(next.money, 620);
});

test('坏档 / 非对象一律拒绝，不吞错发半份奖励', () => {
  assert.throws(
    () => applyPlayReward('{not json', BOSS_PER_RUN_REWARD, NOW),
    (e: unknown) => e instanceof PlayRewardError && e.code === 'SAVE_UNREADABLE',
  );
  for (const bad of ['null', '[]', '"string"', '42']) {
    assert.throws(
      () => applyPlayReward(bad, BOSS_PER_RUN_REWARD, NOW),
      (e: unknown) => e instanceof PlayRewardError && e.code === 'SAVE_UNREADABLE',
    );
  }
});

test('非法 itemId / 非正数 / 非数值道具被过滤，金钱仍照常发放', () => {
  const next = parse(applyPlayReward(JSON.stringify(baseSave()), {
    money: 30,
    items: { '../evil': 5, ok_item: 2, zero: 0, negative: -3, nan: NaN, text: '9' as any },
  }, NOW));
  assert.equal(next.money, 530);
  assert.equal(next.inventory.ok_item, 2);
  assert.equal('../evil' in next.inventory, false);
  assert.equal('zero' in next.inventory, false);
  assert.equal('negative' in next.inventory, false);
  assert.equal('nan' in next.inventory, false);
  assert.equal('text' in next.inventory, false);
});

test('playRewardView 只读展示：过滤非法项、money 向下取整不为负', () => {
  const view = playRewardView({ money: 20.9, items: { potion_small: 1.8, 'Bad-ID': 3 } });
  assert.deepEqual(view, { money: 20, items: [{ itemId: 'potion_small', count: 1 }] });
  assert.deepEqual(playRewardView({ money: -5, items: {} }), { money: 0, items: [] });
});

test('sumPlayRewards 合并多档，同道具累加', () => {
  const sum = sumPlayRewards([
    { money: 100, items: { capsule_prism: 1, potion_small: 1 } },
    { money: 20, items: { potion_small: 1 } },
  ]);
  assert.equal(sum.money, 120);
  assert.deepEqual(sum.items, { capsule_prism: 1, potion_small: 2 });
  assert.deepEqual(sumPlayRewards([]), { money: 0, items: {} });
});

test('纯函数本身不幂等：重复调用会再累加 → 调用方必须靠唯一键去重', () => {
  const once = applyPlayReward(JSON.stringify(baseSave()), BOSS_PER_RUN_REWARD, NOW);
  const twice = applyPlayReward(once, BOSS_PER_RUN_REWARD, NOW);
  assert.equal(parse(once).money, 520);
  assert.equal(parse(twice).money, 540);
  assert.equal(parse(twice).inventory.potion_small, 4);
});

test('perRunGrantKey 按 battleId 隔离，确定性可复现', () => {
  assert.equal(perRunGrantKey('bt_1'), 'boss:run:bt_1');
  assert.notEqual(perRunGrantKey('bt_1'), perRunGrantKey('bt_2'));
  assert.equal(perRunGrantKey('bt_1'), perRunGrantKey('bt_1'));
});

test('firstGrantKey 三个维度（账号/Boss/周期）任一变化都产生不同键', () => {
  const base = ['user_a', 'boss_ember_behemoth', '2026-11-09'];
  const k = firstGrantKey(...base);
  assert.equal(k, 'boss:first:2026-11-09:boss_ember_behemoth:user_a');
  assert.notEqual(k, firstGrantKey('user_b', 'boss_ember_behemoth', '2026-11-09'));
  assert.notEqual(k, firstGrantKey('user_a', 'boss_apex_dragon', '2026-11-09'));
  assert.notEqual(k, firstGrantKey('user_a', 'boss_ember_behemoth', '2026-11-10'));
  assert.equal(k, firstGrantKey(...base));
});

test('两档键前缀不同，不会互相占位', () => {
  assert.ok(perRunGrantKey('bt_1').startsWith('boss:run:'));
  assert.ok(firstGrantKey('u', 'b', 'p').startsWith('boss:first:'));
  assert.notEqual(perRunGrantKey('bt_1'), firstGrantKey('u', 'b', 'p'));
});
