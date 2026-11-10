/**
 * F04-3 宠物等级帽（纯函数层，规范 §31）。
 *
 * 只测「服务端注入的帽如何改变战斗经验分配」，零 IO：
 *  - 帽由 createBattle 注入并随 battleView 只读下发；
 *  - 达到 / 超过帽的宠物**不降级、只冻结升级**（exp / level 都不动）；
 *  - 未超帽的宠物照常获得经验；
 *  - 不注入帽（Boss / 历史调用点）行为与旧版完全一致（回归保护）。
 *
 * HTTP 侧的「帽由服务端读 PlayerProgress 注入、客户端传 levelCap 无效」
 * 与整包 PUT 伪字段闸门由 e2e_f04.mjs 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, applyBattleAction, battleView } from '../src/game/battle.js';
import { emptyMods, THEME_TABLE } from '../src/game/content.js';
import type { Rng } from '../src/game/rules.js';
import { BASE_PLAYER_LEVEL, expGrantAllowed, levelCapOf } from '../src/game/playerLevel.js';

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function mon(id: string, level: number) {
  return {
    id, specId: 'spark_mouse', level, exp: 0, element: 'electric',
    maxHp: 200, hp: 200, atk: 300, def: 200, spAtk: 300, spDef: 200, spd: 200,
    status: 'none' as const, moveIds: ['tackle'],
    initStats: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    growthRates: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
  };
}

function battle(levelCap: number | null) {
  return createBattle({
    id: 'bt_f04', userId: 'u_f04',
    theme: 'grass', areaName: '测试草地', areaId: 'wild_starter',
    levelMin: 2, levelMax: 2,
    party: [mon('young', 3), mon('old', 9)],
    themes: THEME_TABLE, now: 1_000, rng: seeded(7), levelCap,
  });
}

/** 用 testOHKO 让一回合稳定击倒敌人，避免命中 RNG 让单测偶发。 */
function win(battle0: ReturnType<typeof battle>) {
  let cur = battle0;
  for (let i = 0; i < 6 && !cur.finished; i += 1) {
    cur = applyBattleAction(cur, { type: 'move', moveId: 'tackle' }, {
      inventory: { exp_share: 1 }, rng: seeded(100 + i), now: 2_000 + i * 1_000,
      testOHKO: true,
    });
  }
  return cur;
}

test('F04 帽由服务端注入，随只读视图下发；不注入时保持旧行为', () => {
  const withCap = battle(5);
  assert.equal(withCap.levelCap, 5);
  assert.equal(battleView(withCap).levelCap, 5);
  const without = battle(null);
  assert.equal(without.levelCap, null);
  assert.equal(battleView(without).levelCap, null);
  assert.deepEqual(emptyMods(), withCap.playerMods);
});

test('F04 超帽宠不降级、只冻结升级；未超帽宠照常获得经验', () => {
  const done = win(battle(5));
  assert.equal(done.finished, true);
  assert.equal(done.result, 'enemy_fainted');
  assert.ok(done.rewards && done.rewards.expGain > 0, '本场基础经验仍照常计算');

  const young = done.party.find((m) => m.id === 'young')!;
  const old = done.party.find((m) => m.id === 'old')!;
  assert.ok(young.exp > 0, 'Lv.3 < 帽 5 → 获得经验');
  assert.equal(old.exp, 0, 'Lv.9 > 帽 5 → 经验原样为 0');
  assert.equal(old.level, 9, '不回溯降级，等级仍是 9');
  assert.ok(done.log.some((l) => l.includes('等级帽')), '日志明确告知冻结');
});

test('F04 不注入帽时两只都获经验（Boss / 历史调用点零回归）', () => {
  const done = win(battle(null));
  assert.equal(done.finished, true);
  assert.ok(done.party.every((m) => m.exp > 0), '无帽 = 旧版行为，全员获得经验');
  assert.ok(!done.log.some((l) => l.includes('等级帽')));
});

test('F04 帽判定边界：等于帽即冻结，基础等级与帽同源', () => {
  assert.equal(BASE_PLAYER_LEVEL, 5);
  assert.equal(levelCapOf(5), 5);
  assert.equal(expGrantAllowed(4, 5), true);
  assert.equal(expGrantAllowed(5, 5), false, '达到帽即冻结');
  assert.equal(expGrantAllowed(50, 5), false, '高等级捕获怪也不获经验，但等级不被钳');
});
