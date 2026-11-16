/**
 * 学习装置个体开关单测（W2，2026-11-16）。
 *
 * 锁定杰哥拍板：
 *  1. 开关是「携带的宠物」(party) 的个体字段 expShareOn，仓库(box)不参与；
 *  2. 新 op `toggle_exp_share` 服务端权威：只改目标那一只，IOU 之外字段不变；
 *  3. 无该道具（inventory.exp_share<=0）不能开；关闭不需要道具；
 *  4. 伪造 payload（level/hp/inventory）一律无效。
 *
 * 红测先行：当前 MUTATION_OPS 无此 op，本文件应全红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { applyMutation, createNewSave, MutationError, type MutationOp } from '../src/game/mutations.js';
import { createInstance } from '../src/game/rules.js';

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}
const rng = seeded(20261116);

function baseSave() {
  const a = createInstance('spark_mouse', 5, rng);
  const b = createInstance('ember_marmot', 6, rng);
  const boxed = createInstance('tide_newt', 7, rng);
  return {
    version: '12.0.0', playerName: '测试', money: 0, steps: 0,
    locationId: 'town_starter', lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [a, b], box: [boxed],
    inventory: { exp_share: 1 },
    collection: {}, lastSavedAt: '2026-11-16T00:00:00.000Z',
  } as any;
}
function run(op: string, save: any, body: any) {
  return applyMutation(op as MutationOp, save, body);
}

test('W2-1 开开关：只改目标宠 expShareOn，其他宠/字段不变', () => {
  const save = baseSave();
  const targetId = save.party[0].id;
  const res = run('toggle_exp_share', save, { monsterId: targetId, on: true });
  assert.equal(res.save.party[0].expShareOn, true);
  assert.equal(res.save.party[1].expShareOn, undefined, '另一只不受影响');
  assert.equal(res.save.party[0].level, save.party[0].level, '等级不变');
  assert.equal(res.save.party[0].hp, save.party[0].hp, 'HP 不变');
  assert.deepEqual(save.party[0].expShareOn, undefined, '不改原对象（IOU 纯函数）');
});

test('W2-2 关开关不需要道具；开开关需要背包有学习装置', () => {
  const saveNoItem = baseSave();
  saveNoItem.inventory = {};
  const off = run('toggle_exp_share', saveNoItem, { monsterId: saveNoItem.party[0].id, on: false });
  assert.equal(off.save.party[0].expShareOn, false, '关不需要道具');
  assert.throws(
    () => run('toggle_exp_share', saveNoItem, { monsterId: saveNoItem.party[0].id, on: true }),
    (e: any) => e?.code === 'EXP_SHARE_NOT_OWNED',
    '开需要持有装置',
  );
});

test('W2-3 仓库(box)里的宠物不可开开关', () => {
  const save = baseSave();
  assert.throws(
    () => run('toggle_exp_share', save, { monsterId: save.box[0].id, on: true }),
    (e: any) => e?.code === 'MONSTER_NOT_FOUND',
  );
});

test('W2-4 伪造 payload（inventory/level/hp）不生效', () => {
  const save = baseSave();
  const res = run('toggle_exp_share', save, {
    monsterId: save.party[0].id, on: true,
    inventory: { exp_share: 999 }, level: 99, hp: 9999, money: 999999,
  });
  assert.equal(res.save.inventory.exp_share, 1, '背包不被客户端污染');
  assert.equal(res.save.money, 0, '金钱不被客户端污染');
  assert.equal(res.save.party[0].level, save.party[0].level, '等级不被客户端污染');
  assert.equal(res.save.party[0].hp, save.party[0].hp, 'HP 不被客户端污染');
});

test('W2-5 目标不存在 / on 非布尔 → 明确拒绝', () => {
  const save = baseSave();
  assert.throws(
    () => run('toggle_exp_share', save, { monsterId: 'ghost', on: true }),
    (e: any) => e?.code === 'MONSTER_NOT_FOUND',
  );
  assert.throws(
    () => run('toggle_exp_share', save, { monsterId: save.party[0].id, on: 'yes' }),
    (e: any) => e?.code === 'BAD_TOGGLE',
  );
});
