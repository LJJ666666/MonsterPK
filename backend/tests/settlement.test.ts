/**
 * F12：`applySettlementToSave()` 纯函数回归测试。
 *
 * 这段逻辑原本是 `modules/battle.ts` 的私有函数，P4-2c 为了给单人 Boss 复用而抽出。
 * 抽出时**行为必须零变化**，所以这里按「写档规则清单」逐条钉住：
 * 队伍面板、金钱、道具消耗、图鉴、捕获入队、首通、全灭回满、脏档拒绝。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applySettlementToSave } from '../src/game/settlement.js';
import { BattleError, type BattleState } from '../src/game/battle.js';
import { emptyMods } from '../src/game/content.js';

function mon(id: string, level = 10, hp = 20, maxHp = 40) {
  return {
    id, specId: 'spark_mouse', level, exp: 0, element: 'electric',
    maxHp, hp, atk: 10, def: 10, spAtk: 10, spDef: 10, spd: 10,
    status: 'none' as const, moveIds: ['tackle'],
    initStats: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    growthRates: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
  };
}

function makeState(over: Partial<BattleState> = {}): BattleState {
  return {
    id: 'bt_test', userId: 'u1', slot: 1, theme: 'grass', areaName: '测试草地',
    areaId: null, levelMin: 1, levelMax: 3, turn: 2, log: [], playerActiveIndex: 0,
    playerMods: emptyMods(), enemyMods: emptyMods(),
    enemy: mon('enemy_1', 3, 0, 20), party: [mon('p1', 10, 5, 40)],
    ppByMonster: {}, consumed: {}, finished: true, result: 'enemy_fainted',
    rewards: null, captured: null, actions: 1, startedAt: 0, updatedAt: 0, damageDealt: 0,
    ...over,
  };
}

function baseSave(over: Record<string, unknown> = {}) {
  return JSON.stringify({
    version: '10', money: 100, inventory: { capsule_basic: 3 },
    party: [mon('p1', 10, 40, 40)], box: [], collection: {}, clearedAreas: {},
    locationId: 'town_starter', lastHealLocationId: 'town_starter',
    ...over,
  });
}

test('队伍面板以服务端战斗态为准，金钱按 rewards 增加', () => {
  const raw = applySettlementToSave(baseSave(), makeState({
    party: [mon('p1', 11, 30, 44)],
    rewards: { expGain: 40, moneyGain: 120 },
  }));
  const save = JSON.parse(raw);
  assert.equal(save.party[0].level, 11);
  assert.equal(save.party[0].hp, 30);
  assert.equal(save.money, 220);
});

test('道具消耗从背包扣减，且不会扣成负数', () => {
  const raw = applySettlementToSave(baseSave(), makeState({ consumed: { capsule_basic: 5 } }));
  assert.equal(JSON.parse(raw).inventory.capsule_basic, 0);
});

test('捕获成功：入队 + 图鉴次数 +1', () => {
  const captured = mon('cap_1', 3, 20, 20);
  const raw = applySettlementToSave(baseSave(), makeState({
    result: 'captured', captured, enemy: captured,
  }));
  const save = JSON.parse(raw);
  assert.equal(save.party.length, 2);
  assert.equal(save.party[1].id, 'cap_1');
  assert.equal(save.collection.spark_mouse.captured, true);
  assert.equal(save.collection.spark_mouse.timesCaptured, 1);
});

test('首通只在更高难度时覆盖', () => {
  const next = JSON.parse(applySettlementToSave(baseSave(), makeState({
    areaId: 'area_a', levelMax: 5, result: 'enemy_fainted',
  })));
  assert.equal(next.clearedAreas.area_a.level, 5);

  const prevSave = baseSave({ clearedAreas: { area_a: { name: '旧', level: 9, theme: 'grass' } } });
  const kept = JSON.parse(applySettlementToSave(prevSave, makeState({
    areaId: 'area_a', levelMax: 5, result: 'enemy_fainted',
  })));
  assert.equal(kept.clearedAreas.area_a.level, 9, '低难度不能覆盖首通记录');
});

test('全灭：回满并按 lastHealLocationId 送回', () => {
  const raw = applySettlementToSave(
    baseSave({ locationId: 'area_a', lastHealLocationId: 'town_starter' }),
    makeState({ result: 'player_fainted', party: [mon('p1', 10, 0, 40)] }),
  );
  const save = JSON.parse(raw);
  assert.equal(save.party[0].hp, 40);
  assert.equal(save.party[0].status, 'none');
  assert.equal(save.locationId, 'town_starter');
});

test('Boss 战（areaId=null / rewards=null）：只写队伍，不写首通与金钱', () => {
  const raw = applySettlementToSave(baseSave(), makeState({
    bossId: 'boss_ember_behemoth', areaName: '烈焰巨兽 · 讨伐',
    areaId: null, rewards: null, party: [mon('p1', 10, 8, 40)], damageDealt: 260,
  }));
  const save = JSON.parse(raw);
  assert.equal(save.money, 100);
  assert.deepEqual(save.clearedAreas, {});
  assert.equal(save.party[0].hp, 8);
  assert.equal(save.damageDealt, undefined, '伤害不写进个人档');
});

test('脏档拒绝：非法 JSON / 数组结构', () => {
  assert.throws(() => applySettlementToSave('{oops', makeState()),
    (e: unknown) => e instanceof BattleError && e.code === 'SAVE_UNREADABLE');
  assert.throws(() => applySettlementToSave('[]', makeState()),
    (e: unknown) => e instanceof BattleError && e.code === 'SAVE_UNREADABLE');
});

// ───────────────── F04-3：捕获高等级幻兽不按等级帽钳制 ─────────────────
test('F04：人物 5 级抓到 Lv.50 幻兽 → 原样 50 级入队（不降级、不钳到帽）', () => {
  const caught = mon('caught_high', 50, 200, 200);
  const raw = applySettlementToSave(baseSave(), makeState({
    result: 'captured', captured: caught,
  }));
  const next = JSON.parse(raw);
  assert.equal(next.party.length, 2);
  assert.equal(next.party[1].level, 50, '等级原样保留，地图锁才是门槛');
  assert.equal(next.party[1].id, 'caught_high');
  assert.equal(next.collection.spark_mouse.captured, true);
  assert.equal(next.collection.spark_mouse.timesCaptured, 1);
});
