/**
 * 服务端战斗规则一致性单测（P3-1）。
 *
 * 这里做两件事：
 *  1. 公式对照：直接 import 前端 `src/game/rules.ts`，逐个比对 PP 推导、属性克制、
 *     伤害、捕获率。任何一侧改公式而另一侧没跟上，本文件立即失败——这是防「两套引擎分叉」的关键。
 *  2. 确定性：同一随机序列下服务端结果必须可复现，客户端无法通过时间/次数影响结果。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
// 前端（客户端）规则，作为对齐基准
import * as client from '../../src/game/rules.js';
// 服务端规则
import * as server from '../src/game/rules.js';
import { MOVE_SPECS, MONSTER_SPECS, ITEM_SPECS, THEME_TABLE } from '../src/game/content.js';
import { createBattle, applyBattleAction, computeRewards, BattleError } from '../src/game/battle.js';

/** 可复现的伪随机：线性同余，测试里处处用同一种子就能复现。 */
function seeded(seed: number): server.Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 把 Math.random 换成固定序列，用于比对仍在用 Math.random 的客户端规则。 */
function withFakeRandom<T>(seq: number[], fn: () => T): T {
  const original = Math.random;
  let i = 0;
  Math.random = () => seq[Math.min(i++, seq.length - 1)];
  try {
    return fn();
  } finally {
    Math.random = original;
  }
}

const SAMPLE_SPEC = 'spark_mouse';

function serverMonster(specId = SAMPLE_SPEC, level = 10) {
  const spec = MONSTER_SPECS[specId];
  const levelups = level - 1;
  return {
    id: `${specId}_${level}`,
    specId,
    level,
    exp: 0,
    element: spec.element,
    maxHp: spec.baseHp + 10 + levelups * 3,
    hp: spec.baseHp + 10 + levelups * 3,
    atk: spec.baseAtk + 2 + levelups,
    def: spec.baseDef + 2 + levelups,
    spAtk: spec.baseSpAtk + 2 + levelups,
    spDef: spec.baseSpDef + 2 + levelups,
    spd: spec.baseSpd + 2 + levelups,
    status: 'none' as const,
    moveIds: spec.learnset.filter((x) => x.level <= level).map((x) => x.moveId).slice(-4),
    initStats: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    growthRates: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
  };
}

test('PP 推导：294 个技能与服务端一致', () => {
  let n = 0;
  for (const moveId of Object.keys(MOVE_SPECS)) {
    const a = client.getMoveMaxPP(moveId as any);
    const b = server.getMoveMaxPP(moveId);
    assert.equal(a, b, `技能 ${moveId} 的 PP 不一致：前端 ${a} / 服务端 ${b}`);
    n += 1;
  }
  assert.ok(n > 250, `技能数量异常：${n}`);
});

test('属性克制：18×18 全表与前端一致', () => {
  const elements = Object.keys(MONSTER_SPECS).length > 0
    ? Array.from(new Set(Object.values(MONSTER_SPECS).map((m) => m.element)))
    : [];
  assert.ok(elements.length >= 10, '属性数量异常');
  for (const atk of elements) {
    for (const def of elements) {
      assert.equal(
        client.effectiveness(atk as any, def as any),
        server.effectiveness(atk, def),
        `${atk} → ${def} 克制倍率不一致`,
      );
    }
  }
});

test('伤害公式：同随机序列下与前端逐个数值相等', () => {
  const atk = serverMonster('spark_mouse', 12);
  const def = serverMonster('sprout_owl', 12);
  const seq = [0.42, 0.07, 0.91, 0.13, 0.66, 0.28];

  let i = 0;
  const rng: server.Rng = () => seq[i++ % seq.length];

  for (const moveId of (Object.keys(MOVE_SPECS) as string[]).slice(0, 60)) {
    const move = MOVE_SPECS[moveId];
    if (move.category === 'status') continue;
    i = 0;
    const a = withFakeRandom([...seq, ...seq], () => (client.computeDamage as any)(atk as any, def as any, moveId));
    i = 0;
    const b = server.computeDamage(atk as any, def as any, moveId, rng);
    assert.equal(b.dmg, a.dmg, `技能 ${moveId} 伤害不一致：前端 ${a.dmg} / 服务端 ${b.dmg}`);
    assert.equal(b.eff, a.eff, `技能 ${moveId} 克制倍率不一致`);
    assert.equal(b.isCrit, a.isCrit, `技能 ${moveId} 暴击判定不一致`);
  }
});

test('捕获率：与前端同公式（含异常状态与等级差）', () => {
  const enemy = serverMonster('sprout_owl', 8);
  for (const status of ['none', 'sleep', 'paralyze', 'burn'] as const) {
    const e = { ...enemy, status };
    for (const avg of [5, 8, 20]) {
      const a = client.captureChance(e as any, 0.3, 1.5, avg);
      const b = server.captureChance(e as any, 0.3, 1.5, avg);
      assert.ok(Math.abs(a - b) < 1e-9, `状态 ${status} / 均级 ${avg} 捕获率不一致：${a} / ${b}`);
    }
  }
});

test('奖励公式：与 P1-2 的 battle_reward 口径一致（该意图已下线，公式仍是同一个）', () => {
  const levels = [1, 5, 12, 30];
  for (const lv of levels) {
    const plain = computeRewards(lv, {});
    assert.equal(plain.expGain, 10 + lv * 6);
    assert.equal(plain.moneyGain, 50 + lv * 10);
    // 旧 battle_reward 意图用的是同一组常量：exp=10+lv*6，money=(50+lv*10)*(护符?2:1)。
    // 意图已在 2026-11-07 删除，这里保留常量对照，防止有人在 applySettlement 里另起一套公式。
    const withAmulet = computeRewards(lv, { amulet_coin: 1 });
    assert.equal(withAmulet.moneyGain, (50 + lv * 10) * 2);
    assert.equal(withAmulet.hasAmuletCoin, true);
    const withShare = computeRewards(lv, { exp_share: 1 });
    assert.equal(withShare.hasExpShare, true);
  }
});

test('遭遇生成：同一种子完全可复现，且选手来自主题表', () => {
  const theme = Object.keys(THEME_TABLE)[0];
  const a = createBattle({
    id: 'b1', userId: 'u1', theme, areaName: '测试区', areaId: null,
    levelMin: 5, levelMax: 8, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(12345),
  });
  const b = createBattle({
    id: 'b2', userId: 'u1', theme, areaName: '测试区', areaId: null,
    levelMin: 5, levelMax: 8, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(12345),
  });
  assert.equal(a.enemy.specId, b.enemy.specId);
  assert.equal(a.enemy.level, b.enemy.level);
  assert.equal(a.enemy.maxHp, b.enemy.maxHp);
  assert.equal(a.enemy.atk, b.enemy.atk);
  assert.equal(a.enemy.isShiny, b.enemy.isShiny);
  assert.ok(THEME_TABLE[theme].includes(a.enemy.specId));
  assert.ok(a.enemy.level >= 5 && a.enemy.level <= 10, `等级越界：${a.enemy.level}`);
});

test('技能动作：扣 PP、推进回合、敌方也行动', () => {
  const state = createBattle({
    id: 'b3', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(7),
  });
  const moveId = state.party[0].moveIds[0];
  const before = state.ppByMonster[state.party[0].id][moveId];

  const next = applyBattleAction(state, { type: 'move', moveId }, {
    inventory: {}, rng: seeded(99), now: 2,
  });

  assert.equal(next.ppByMonster[next.party[0].id][moveId], before - 1);
  assert.ok(next.turn >= state.turn, '回合数应推进');
  assert.ok(next.log.length > state.log.length, '应产生战斗日志');
  assert.equal(next.actions, 1);
});

test('技能校验：未掌握 / PP 耗尽都被服务端拒绝', () => {
  const state = createBattle({
    id: 'b4', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(11),
  });
  assert.throws(
    () => applyBattleAction(state, { type: 'move', moveId: '__not_a_move__' }, { inventory: {}, rng: seeded(1), now: 2 }),
    (err: any) => err instanceof BattleError && err.code === 'MOVE_UNKNOWN',
  );

  const player = state.party[0];
  const moveId = player.moveIds[0];
  const drained = { ...state, ppByMonster: { ...state.ppByMonster, [player.id]: { [moveId]: 0 } } };
  assert.throws(
    () => applyBattleAction(drained, { type: 'move', moveId }, { inventory: {}, rng: seeded(1), now: 2 }),
    (err: any) => err instanceof BattleError && err.code === 'PP_EXHAUSTED',
  );
});

test('道具：不足时拒绝，治疗扣次数并让敌方行动', () => {
  const state = createBattle({
    id: 'b5', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(21),
  });
  const healItem = (Object.values(ITEM_SPECS) as any[]).find((it) => it.kind === 'heal');
  assert.ok(healItem, '内容表里应存在治疗道具');

  assert.throws(
    () => applyBattleAction(state, { type: 'item', itemId: healItem.id }, { inventory: {}, rng: seeded(1), now: 2 }),
    (err: any) => err instanceof BattleError && err.code === 'ITEM_NOT_ENOUGH',
  );

  const hurt = {
    ...state,
    party: state.party.map((m) => ({ ...m, hp: 1 })),
  };
  const next = applyBattleAction(hurt, { type: 'item', itemId: healItem.id }, {
    inventory: { [healItem.id]: 3 }, rng: seeded(5), now: 3,
  });
  assert.equal(next.consumed[healItem.id], 1, '应记录一次消耗');
  assert.ok(next.party[0].hp > 1, '应恢复体力');
});

test('捕获：成功即结束并产出 captured，失败则敌方行动', () => {
  const theme = Object.keys(THEME_TABLE)[0];
  const base = createBattle({
    id: 'b6', userId: 'u1', theme, areaName: '测试区',
    areaId: null, levelMin: 2, levelMax: 2, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(31),
  });
  const ball = (Object.values(ITEM_SPECS) as any[]).find((it) => it.kind === 'capture');
  assert.ok(ball, '内容表里应存在捕获道具');

  // 把敌人打到 1 血，固定 rng=0 保证捕获判定成功
  const weak = { ...base, enemy: { ...base.enemy, hp: 1 } };
  const ok = applyBattleAction(weak, { type: 'capture', itemId: ball.id }, {
    inventory: { [ball.id]: 5 }, rng: () => 0, now: 2,
  });
  assert.equal(ok.finished, true);
  assert.equal(ok.result, 'captured');
  assert.ok(ok.captured, '应产出捕获的幻兽');
  assert.equal(ok.captured!.hp, ok.captured!.maxHp, '捕获后满血');
  assert.equal(ok.consumed[ball.id], 1);

  // rng=0.999 捕获必失败，敌方应行动
  const bad = applyBattleAction(weak, { type: 'capture', itemId: ball.id }, {
    inventory: { [ball.id]: 5 }, rng: () => 0.999, now: 3,
  });
  assert.equal(bad.finished, false);
  assert.ok(bad.turn >= 1);
});

test('逃跑：速度占优 + 随机成功 → fled 结束', () => {
  const state = createBattle({
    id: 'b7', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(41),
  });
  const fast = { ...state, party: state.party.map((m) => ({ ...m, spd: 999 })) };
  const next = applyBattleAction(fast, { type: 'flee' }, { inventory: {}, rng: () => 0.1, now: 2 });
  assert.equal(next.finished, true);
  assert.equal(next.result, 'fled');
  assert.equal(next.rewards, null, '逃跑没有奖励');
});

test('换人：切换出战索引并让敌方行动，不能换成倒地或同一个', () => {
  const party = [serverMonster('spark_mouse', 10), serverMonster('sprout_owl', 10)];
  const state = createBattle({
    id: 'b8', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party, themes: THEME_TABLE,
    now: 1, rng: seeded(51),
  });
  const next = applyBattleAction(state, { type: 'switch', partyIndex: 1 }, {
    inventory: {}, rng: seeded(52), now: 2,
  });
  assert.equal(next.playerActiveIndex, 1);
  assert.ok(next.log.some((l) => l.includes('你换上了')), '应有换人日志');

  assert.throws(
    () => applyBattleAction(next, { type: 'switch', partyIndex: 1 }, { inventory: {}, rng: seeded(1), now: 3 }),
    (err: any) => err instanceof BattleError && err.code === 'SAME_ACTIVE',
  );

  const fainted = { ...next, party: next.party.map((m, i) => (i === 0 ? { ...m, hp: 0 } : m)) };
  assert.throws(
    () => applyBattleAction(fainted, { type: 'switch', partyIndex: 0 }, { inventory: {}, rng: seeded(1), now: 4 }),
    (err: any) => err instanceof BattleError && err.code === 'MONSTER_FAINTED',
  );
});

test('击杀：结束并给出经验与金钱，经验落到出战幻兽', () => {
  const state = createBattle({
    id: 'b9', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 10, levelMax: 10, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(61),
  });
  const moveId = state.party[0].moveIds[0];
  const beforeExp = state.party[0].exp;
  const next = applyBattleAction(state, { type: 'move', moveId }, {
    inventory: {}, rng: seeded(62), now: 2, testOHKO: true,
  });
  assert.equal(next.finished, true);
  assert.equal(next.result, 'enemy_fainted');
  assert.ok(next.rewards && next.rewards.expGain > 0);
  assert.ok(next.rewards!.moneyGain > 0);
  assert.ok(next.party[0].exp > beforeExp || next.party[0].level > state.party[0].level, '应获得经验或升级');
});

test('战斗结束后再发动作被拒绝', () => {
  const state = createBattle({
    id: 'b10', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
    areaId: null, levelMin: 3, levelMax: 3, party: [serverMonster()], themes: THEME_TABLE,
    now: 1, rng: seeded(71),
  });
  const done = { ...state, finished: true, result: 'fled' as const };
  assert.throws(
    () => applyBattleAction(done, { type: 'flee' }, { inventory: {}, rng: seeded(1), now: 2 }),
    (err: any) => err instanceof BattleError && err.code === 'BATTLE_FINISHED',
  );
});

test('队伍为空 / 全灭时不允许开局', () => {
  assert.throws(
    () => createBattle({
      id: 'b11', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
      areaId: null, levelMin: 1, levelMax: 1, party: [], themes: THEME_TABLE, now: 1, rng: seeded(1),
    }),
    (err: any) => err instanceof BattleError && err.code === 'PARTY_EMPTY',
  );
  const fainted = [{ ...serverMonster(), hp: 0 }];
  assert.throws(
    () => createBattle({
      id: 'b12', userId: 'u1', theme: Object.keys(THEME_TABLE)[0], areaName: '测试区',
      areaId: null, levelMin: 1, levelMax: 1, party: fainted, themes: THEME_TABLE, now: 1, rng: seeded(1),
    }),
    (err: any) => err instanceof BattleError && err.code === 'PARTY_FAINTED',
  );
});
