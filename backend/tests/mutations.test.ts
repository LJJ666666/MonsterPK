/**
 * 服务端存档写操作单测（P3-2）。
 *
 * 覆盖治疗 / 战斗外道具 / 进化 / 学招 / 队伍整理 / 移动六类操作的全部拒绝分支，
 * 并用前端 `rules.ts::evolveMonsterInstance` 做交叉对照——进化个体值从此由服务端算，
 * 但玩家看到的数值必须和内容表一致，不能两套算法分叉。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as client from '../../src/game/rules.js';
import { ITEM_SPECS, LOCATIONS, MONSTER_SPECS } from '../src/game/content.js';
import { applyMutation, createNewSave, MutationError, type MutationOp } from '../src/game/mutations.js';
import { checkFreshSave } from '../src/lib/authority.js';
import { createInstance } from '../src/game/rules.js';

/** 可复现随机源（与其它后端测试同一种子写法）。 */
function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const rng = seeded(20261107);

function baseSave(overrides: Record<string, any> = {}) {
  const mon = createInstance('spark_mouse', 5, rng);
  return {
    version: '10.0.0',
    playerName: '测试',
    money: 1000,
    steps: 0,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [mon],
    box: [],
    inventory: {
      potion_small: 2,
      heal_antidote: 1,
      stone_thunder: 1,
      capsule_basic: 3,
    },
    collection: {},
    lastSavedAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn();
  } catch (e) {
    assert.ok(e instanceof MutationError, `应抛 MutationError，实际：${String(e)}`);
    assert.equal(e.code, code);
    return;
  }
  assert.fail(`应抛出 ${code}，但没有抛错`);
}

function run(op: MutationOp, save: any, body: Record<string, any> = {}) {
  return applyMutation(op, save, body);
}

// —— 治疗点 ——

test('治疗：有恢复中心的据点才能回满', () => {
  const save = baseSave();
  save.party[0].hp = 3;
  save.party[0].status = 'burn';
  const res = run('heal', save);
  assert.equal(res.save.party[0].hp, res.save.party[0].maxHp);
  assert.equal(res.save.party[0].status, 'none');
  assert.equal(res.save.lastHealLocationId, 'town_starter');
});

test('治疗：没有恢复中心的野外被拒', () => {
  const save = baseSave({ locationId: 'wild_starter' });
  expectCode(() => run('heal', save), 'NO_HEAL_CENTER');
});

test('治疗：未知地点被拒', () => {
  const save = baseSave({ locationId: 'nowhere' });
  expectCode(() => run('heal', save), 'NO_HEAL_CENTER');
});

test('治疗：不修改调用方传入的对象（纯函数）', () => {
  const save = baseSave();
  save.party[0].hp = 1;
  run('heal', save);
  assert.equal(save.party[0].hp, 1, '原存档不应被就地改写');
});

// —— 战斗外道具 ——

test('道具：回复药按内容表数值回血并扣 1', () => {
  const save = baseSave();
  save.party[0].hp = 1;
  const heal = (ITEM_SPECS.potion_small as any).heal;
  const res = run('use_item', save, { itemId: 'potion_small', monsterId: save.party[0].id });
  assert.equal(res.save.party[0].hp, Math.min(save.party[0].maxHp, 1 + heal));
  assert.equal(res.save.inventory.potion_small, 1);
});

test('道具：回复不会超过最大 HP', () => {
  const save = baseSave();
  save.party[0].hp = save.party[0].maxHp - 1;
  const res = run('use_item', save, { itemId: 'potion_small', monsterId: save.party[0].id });
  assert.equal(res.save.party[0].hp, save.party[0].maxHp);
});

test('道具：倒下的幻兽不能吃药', () => {
  const save = baseSave();
  save.party[0].hp = 0;
  expectCode(() => run('use_item', save, { itemId: 'potion_small', monsterId: save.party[0].id }), 'MONSTER_FAINTED');
});

test('道具：数量不足被拒', () => {
  const save = baseSave();
  save.inventory.potion_small = 0;
  expectCode(
    () => run('use_item', save, { itemId: 'potion_small', monsterId: save.party[0].id }),
    'ITEM_NOT_ENOUGH',
  );
});

test('道具：未知道具被拒', () => {
  const save = baseSave();
  expectCode(() => run('use_item', save, { itemId: 'nope', monsterId: save.party[0].id }), 'ITEM_UNKNOWN');
});

test('道具：解异常药只在状态匹配时消耗', () => {
  const save = baseSave();
  save.party[0].status = 'burn';
  expectCode(
    () => run('use_item', save, { itemId: 'heal_antidote', monsterId: save.party[0].id }),
    'STATUS_NOT_MATCH',
  );
  save.party[0].status = 'poison';
  const res = run('use_item', save, { itemId: 'heal_antidote', monsterId: save.party[0].id });
  assert.equal(res.save.party[0].status, 'none');
  assert.equal(res.save.inventory.heal_antidote, 0);
});

test('道具：进化石按内容表条件进化并扣石头', () => {
  const save = baseSave();
  const before = save.party[0];
  const res = run('use_item', save, { itemId: 'stone_thunder', monsterId: before.id });
  assert.equal(res.save.party[0].specId, 'thunder_rat');
  assert.equal(res.save.inventory.stone_thunder, 0);
  assert.equal(res.save.collection.thunder_rat.captured, true);
  assert.equal(res.save.collection.thunder_rat.timesCaptured, 0, '进化不增加捕获次数');
});

test('道具：不适用的进化石被拒且不扣道具', () => {
  const save = baseSave();
  save.inventory.stone_fire = 1;
  expectCode(
    () => run('use_item', save, { itemId: 'stone_fire', monsterId: save.party[0].id }),
    'EVOLUTION_NOT_APPLICABLE',
  );
});

test('道具：可以对箱子里的幻兽使用', () => {
  const save = baseSave();
  const boxed = createInstance('ember_marmot', 5, rng);
  boxed.hp = 1;
  save.box.push(boxed);
  const res = run('use_item', save, { itemId: 'potion_small', monsterId: boxed.id });
  assert.ok(res.save.box[0].hp > 1);
  assert.equal(res.save.inventory.potion_small, 1);
});

test('道具：找不到目标被拒', () => {
  const save = baseSave();
  expectCode(() => run('use_item', save, { itemId: 'potion_small', monsterId: 'ghost' }), 'MONSTER_NOT_FOUND');
});

// —— 待进化 ——

test('进化：没有待进化时被拒', () => {
  const save = baseSave();
  expectCode(() => run('evolve', save, { monsterId: save.party[0].id, accept: true }), 'NO_PENDING_EVOLUTION');
});

test('进化：接受后换成目标种族，拒绝只清除标记', () => {
  const save = baseSave();
  save.party[0].pendingEvolution = { targetId: 'thunder_rat', condition: { type: 'level', level: 16 } };

  const refused = run('evolve', save, { monsterId: save.party[0].id, accept: false });
  assert.equal(refused.save.party[0].specId, 'spark_mouse');
  assert.equal(refused.save.party[0].pendingEvolution, undefined);

  const accepted = run('evolve', save, { monsterId: save.party[0].id, accept: true });
  assert.equal(accepted.save.party[0].specId, 'thunder_rat');
});

test('进化：目标不在图鉴配置里时被拒（防伪造 targetId）', () => {
  const save = baseSave();
  save.party[0].pendingEvolution = { targetId: 'titan_golem', condition: { type: 'level', level: 16 } };
  expectCode(() => run('evolve', save, { monsterId: save.party[0].id, accept: true }), 'EVOLUTION_TARGET_INVALID');
});

test('进化：服务端结果与前端 evolveMonsterInstance 逐项一致', () => {
  const save = baseSave();
  save.party[0].pendingEvolution = { targetId: 'thunder_rat', condition: { type: 'level', level: 16 } };
  const server = run('evolve', save, { monsterId: save.party[0].id, accept: true }).save.party[0];
  const clientSide = client.evolveMonsterInstance(save.party[0] as any, 'thunder_rat');
  for (const key of ['maxHp', 'atk', 'def', 'spAtk', 'spDef', 'spd', 'hp'] as const) {
    assert.equal(server[key], (clientSide as any)[key], `${key} 不一致`);
  }
  assert.deepEqual(server.initStats, (clientSide as any).initStats);
  assert.deepEqual(server.growthRates, (clientSide as any).growthRates);
  assert.deepEqual(server.moveIds, (clientSide as any).moveIds);
});

// —— 学招 ——

test('学招：只能学待学列表里的技能', () => {
  const save = baseSave();
  expectCode(
    () => run('learn_move', save, { monsterId: save.party[0].id, newMoveId: 'hyper_beam', oldMoveId: null }),
    'MOVE_NOT_PENDING',
  );
});

test('学招：栏位未满时直接学会', () => {
  const save = baseSave();
  save.party[0].moveIds = ['tackle'];
  save.party[0].pendingMoves = ['ice_beam'];
  const res = run('learn_move', save, { monsterId: save.party[0].id, newMoveId: 'ice_beam', oldMoveId: null });
  assert.deepEqual(res.save.party[0].moveIds, ['tackle', 'ice_beam']);
  assert.deepEqual(res.save.party[0].pendingMoves, []);
});

test('学招：栏位已满且未指定替换时被拒', () => {
  const save = baseSave();
  save.party[0].moveIds = ['tackle', 'growl', 'slash', 'quick_attack'];
  save.party[0].pendingMoves = ['ice_beam'];
  expectCode(
    () => run('learn_move', save, { monsterId: save.party[0].id, newMoveId: 'ice_beam', oldMoveId: null }),
    'MOVE_SLOTS_FULL',
  );
});

test('学招：替换不存在的技能被拒', () => {
  const save = baseSave();
  save.party[0].moveIds = ['tackle', 'growl', 'slash', 'quick_attack'];
  save.party[0].pendingMoves = ['ice_beam'];
  expectCode(
    () => run('learn_move', save, { monsterId: save.party[0].id, newMoveId: 'ice_beam', oldMoveId: 'hyper_beam' }),
    'MOVE_NOT_KNOWN',
  );
});

test('学招：替换后原技能消失、待学列表清空', () => {
  const save = baseSave();
  save.party[0].moveIds = ['tackle', 'growl', 'slash', 'quick_attack'];
  save.party[0].pendingMoves = ['ice_beam'];
  const res = run('learn_move', save, { monsterId: save.party[0].id, newMoveId: 'ice_beam', oldMoveId: 'growl' });
  assert.deepEqual(res.save.party[0].moveIds, ['tackle', 'ice_beam', 'slash', 'quick_attack']);
  assert.deepEqual(res.save.party[0].pendingMoves, []);
});

// —— 队伍整理 ——

test('队伍：最后一只不能下放', () => {
  const save = baseSave();
  expectCode(() => run('move_to_box', save, { partyIndex: 0 }), 'PARTY_TOO_SMALL');
});

test('队伍：下放与上调都在服务端完成', () => {
  const save = baseSave();
  const second = createInstance('ember_marmot', 5, rng);
  save.party.push(second);
  const boxed = run('move_to_box', save, { partyIndex: 1 });
  assert.equal(boxed.save.party.length, 1);
  assert.equal(boxed.save.box.length, 1);
  const back = run('move_to_party', boxed.save, { boxIndex: 0 });
  assert.equal(back.save.party.length, 2);
  assert.equal(back.save.box.length, 0);
});

test('队伍：满 6 只时不能再上调', () => {
  const save = baseSave();
  for (let i = 0; i < 5; i++) save.party.push(createInstance('ember_marmot', 5, rng));
  save.box.push(createInstance('ember_marmot', 5, rng));
  expectCode(() => run('move_to_party', save, { boxIndex: 0 }), 'PARTY_FULL');
});

test('放生：可以从队伍或箱子移除，但队伍不能清空', () => {
  const save = baseSave();
  const second = createInstance('ember_marmot', 5, rng);
  save.box.push(second);
  const res = run('release', save, { monsterId: second.id });
  assert.equal(res.save.box.length, 0);
  expectCode(() => run('release', save, { monsterId: save.party[0].id }), 'PARTY_TOO_SMALL');
});

// —— 移动 ——

test('移动：未知地点被拒', () => {
  const save = baseSave();
  expectCode(() => run('travel', save, { locationId: 'atlantis' }), 'LOCATION_UNKNOWN');
});

test('移动：合法地点会写入访问记录，且能接上治疗', () => {
  const city = Object.keys(LOCATIONS).find((id) => id !== 'town_starter' && (LOCATIONS as any)[id].hasCenter);
  assert.ok(city, '内容表里应至少还有一个带恢复中心的地点');
  const moved = run('travel', baseSave(), { locationId: city });
  assert.equal(moved.save.locationId, city);
  assert.ok(moved.save.visitedLocationIds.includes(city));
  moved.save.party[0].hp = 1;
  const healed = run('heal', moved.save);
  assert.equal(healed.save.party[0].hp, healed.save.party[0].maxHp);
});

test('未知操作被拒', () => {
  expectCode(() => run('nope' as MutationOp, baseSave()), 'OP_UNKNOWN');
});

test('内容表覆盖：道具/地点/幻兽都能在服务端查到', () => {
  assert.equal(ITEM_SPECS.stone_thunder.kind, 'evolution');
  assert.equal(MONSTER_SPECS.thunder_rat.id, 'thunder_rat');
  assert.ok(Object.keys(LOCATIONS).length >= 5);
});

// —— 新档生成（P3-2b）——

test('新建档：生成的档能通过服务端自己的新档校验', () => {
  const save = createNewSave(
    { playerName: '杰哥', starterSpecId: 'sprout_owl' },
    { rng: seeded(7), schemaVersion: '10', nowIso: new Date(0).toISOString() },
  );
  assert.equal(save.party.length, 1);
  assert.equal(save.party[0].level, 5);
  assert.equal(save.party[0].specId, 'sprout_owl');
  assert.equal(save.money, 0);
  assert.deepEqual(save.visitedLocationIds, ['town_starter']);
  const fresh = checkFreshSave(JSON.stringify(save));
  assert.equal(fresh.ok, true, fresh.reason);
});

test('新建档：初始背包来自内容表，其余道具为 0', () => {
  const save = createNewSave(
    { playerName: 'tx', starterSpecId: 'ember_marmot' },
    { rng: seeded(8), schemaVersion: '10', nowIso: new Date(0).toISOString() },
  );
  assert.equal(save.inventory.capsule_basic, 6);
  assert.equal(save.inventory.capsule_prism, 1);
  assert.equal(save.inventory.potion_small, 3);
  assert.equal(save.inventory.capsule_master, 0);
  assert.equal(Object.keys(save.inventory).length, Object.keys(ITEM_SPECS).length);
});

test('新建档：名字与初始幻兽都要校验', () => {
  const ctx = { rng: seeded(9), schemaVersion: '10', nowIso: new Date(0).toISOString() };
  expectCode(() => createNewSave({ playerName: '', starterSpecId: 'sprout_owl' }, ctx), 'NAME_INVALID');
  expectCode(() => createNewSave({ playerName: '一二三四五六七八九十一二三' }, ctx), 'NAME_INVALID');
  expectCode(() => createNewSave({ playerName: 'x', starterSpecId: 'thunder_rat' }, ctx), 'STARTER_INVALID');
  expectCode(() => createNewSave({ playerName: 'x', starterSpecId: '' }, ctx), 'STARTER_INVALID');
});

test('新建档：同一随机种子下个体值可复现（服务端权威）', () => {
  const ctx = () => ({ rng: seeded(42), schemaVersion: '10', nowIso: new Date(0).toISOString() });
  const a = createNewSave({ playerName: 'x', starterSpecId: 'tide_newt' }, ctx());
  const b = createNewSave({ playerName: 'x', starterSpecId: 'tide_newt' }, ctx());
  assert.deepEqual(a.party[0].initStats, b.party[0].initStats);
  assert.deepEqual(a.party[0].growthRates, b.party[0].growthRates);
});
