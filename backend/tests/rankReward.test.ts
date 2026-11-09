/**
 * F02 榜单奖励纯函数单测。
 * 运行：cd backend && npx tsx --test tests/rankReward.test.ts
 *
 * 重点：奖励表只在服务端、名次边界、Boss 榜倍率、写档只增 money/inventory、
 * 时钟注入可复现、坏档拒绝；绝不触碰队伍 / 等级等其它真值。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  SETTLE_BOARDS, parseBoardKey, rewardFor, rewardView, applyRankReward,
  rankBoardKey, bossBoardKey, boardLabel, REWARD_MAX_RANK, BOSS_REWARD_MULTIPLIER,
  RankRewardError,
} from '../src/game/rankReward.js';
import { RANK_TYPES } from '../src/game/rank.js';
import { BOSS_IDS } from '../src/game/boss.js';

test('SETTLE_BOARDS：四张派生榜 + 三张 Boss 伤害榜，无重复', () => {
  assert.equal(SETTLE_BOARDS.length, RANK_TYPES.length + BOSS_IDS.length);
  assert.equal(new Set(SETTLE_BOARDS).size, SETTLE_BOARDS.length);
  assert.equal(SETTLE_BOARDS[0], 'rank:monster_power');
  assert.ok(SETTLE_BOARDS.includes(bossBoardKey(BOSS_IDS[0])));
});

test('parseBoardKey：未知榜 / 未知 Boss / 伪造键一律 null', () => {
  assert.deepEqual(parseBoardKey('rank:progress'), { kind: 'rank', type: 'progress', id: 'progress' });
  assert.deepEqual(parseBoardKey(bossBoardKey(BOSS_IDS[0])), { kind: 'boss', type: null, id: BOSS_IDS[0] });
  for (const bad of ['rank:hacked', 'boss:hacked', 'other:x', '', 123, null, 'x'.repeat(100)]) {
    assert.equal(parseBoardKey(bad), null, `应拒绝 ${String(bad)}`);
  }
  assert.ok(boardLabel('rank:progress').includes('推图'));
});

test('rewardFor：只奖前 N 名，Boss 榜金钱翻倍', () => {
  assert.equal(REWARD_MAX_RANK, 10);
  assert.ok(rewardFor('rank:progress', 1)!.money > rewardFor('rank:progress', 2)!.money);
  assert.ok(rewardFor('rank:progress', 2)!.money > rewardFor('rank:progress', 4)!.money);
  assert.equal(
    rewardFor(bossBoardKey(BOSS_IDS[0]), 1)!.money,
    rewardFor('rank:progress', 1)!.money * BOSS_REWARD_MULTIPLIER,
  );
  for (const bad of [0, 11, -1, 1.5, NaN]) assert.equal(rewardFor('rank:progress', bad), null);
  assert.equal(rewardFor('rank:hacked', 1), null);
});

test('rewardView：过滤非法道具 id 与非正数，结构只读', () => {
  const v = rewardView({ money: 300.9, items: { capsule_prism: 1, 'BAD ID': 5, zero: 0 } });
  assert.equal(v.money, 300);
  assert.deepEqual(v.items, [{ itemId: 'capsule_prism', count: 1 }]);
});

test('applyRankReward：只增 money / inventory，队伍与等级不变，时钟可注入', () => {
  const before = {
    version: 10, money: 100, inventory: { capsule_basic: 2, potion_small: 1 },
    party: [{ id: 'm1', level: 7, maxHp: 100 }], clearedAreas: { a: { level: 3 } },
  };
  const raw = JSON.stringify(before);
  const reward = { money: 300, items: { capsule_prism: 1, potion_small: 2 } };
  const out = JSON.parse(applyRankReward(raw, reward, '2026-11-09T00:00:00.000Z'));
  assert.equal(out.money, 400);
  assert.equal(out.inventory.capsule_basic, 2);
  assert.equal(out.inventory.potion_small, 3);
  assert.equal(out.inventory.capsule_prism, 1);
  assert.deepEqual(out.party, before.party);
  assert.deepEqual(out.clearedAreas, before.clearedAreas);
  assert.equal(out.lastSavedAt, '2026-11-09T00:00:00.000Z');
  // 原档不被修改（纯函数）
  assert.equal(JSON.parse(raw).money, 100);
  // 同一输入 + 同一时钟 = 完全一致
  assert.equal(
    applyRankReward(raw, reward, '2026-11-09T00:00:00.000Z'),
    applyRankReward(raw, reward, '2026-11-09T00:00:00.000Z'),
  );
});

test('applyRankReward：坏档拒绝，负数 / 非法 id 不产生增量', () => {
  assert.throws(
    () => applyRankReward('{bad json', { money: 1, items: {} }),
    (e: unknown) => e instanceof RankRewardError && e.code === 'SAVE_UNREADABLE',
  );
  assert.throws(() => applyRankReward('[]', { money: 1, items: {} }));
  const out = JSON.parse(applyRankReward(
    JSON.stringify({ money: 10, inventory: {} }),
    { money: -500, items: { 'bad id': 9, valid: -3, ok: 2 } as any },
    'fixed',
  ));
  assert.equal(out.money, 10);
  assert.equal(out.inventory.ok, 2);
  assert.equal(out.inventory['bad id'], undefined);
});
