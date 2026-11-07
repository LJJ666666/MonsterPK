/**
 * 数值规则矩阵测试（2026-11-07）。
 *
 * 与 `battleEngine.test.ts` 的分工：
 *  - battleEngine.test.ts：**公式对照**——服务端每个数值必须等于前端 rules.ts 的结果，
 *    防「两套引擎悄悄分叉」；
 *  - 本文件：**不变量与边界**——不依赖具体数值，只验证游戏规则必须成立的数学性质：
 *    伤害恒为正整数、克制倍率单调、等级/攻击单调、捕获率钳制、经验曲线单调、
 *    能力值落在合法区间。这类断言不会因为平衡性调参（改 power / baseRate）而失效。
 *
 * 纯函数级，不连库、不起服务，毫秒级完成。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import * as rules from '../src/game/rules.js';
import { MOVE_SPECS, MONSTER_SPECS, ITEM_SPECS } from '../src/game/content.js';

/** 固定序列 RNG：同一条用例内保证「只有被研究的变量在变」。 */
function seq(values: number[]): rules.Rng {
  let i = 0;
  return () => values[Math.min(i++, values.length - 1)];
}
/** 恒定随机值（0 = 最小值，0.99 = 最大值）。 */
const fixed = (v: number): rules.Rng => () => v;

type Monster = ReturnType<typeof makeMonster>;

function makeMonster(over: Partial<Record<string, unknown>> = {}): {
  id: string; specId: string; level: number; exp: number; element: string;
  maxHp: number; hp: number; atk: number; def: number; spAtk: number; spDef: number; spd: number;
  status: string; moveIds: string[]; initStats: Record<string, number>; growthRates: Record<string, number>;
} {
  return {
    id: 'm1', specId: 'sprout_owl', level: 20, exp: 0, element: 'grass',
    maxHp: 100, hp: 100, atk: 80, def: 70, spAtk: 80, spDef: 70, spd: 60,
    status: 'none', moveIds: ['tackle'],
    initStats: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    growthRates: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    ...over,
  };
}

/** 在内容表里按条件取一个技能 id，避免硬编码 id 随内容调整失效。 */
function pickMove(pred: (m: any) => boolean): string {
  const hit = Object.entries(MOVE_SPECS).find(([, m]) => pred(m));
  assert.ok(hit, '内容表里应存在满足条件的技能');
  return hit![0];
}
const PHYS = pickMove((m) => m.category === 'physical' && m.power > 0);
const SPECIAL = pickMove((m) => m.category === 'special' && m.power > 0);
const STATUS = pickMove((m) => m.category === 'status');

// ───────────────────────── 伤害：不变量 ─────────────────────────

test('伤害恒为正整数：0 倍克制也不为 0（保底 1）', () => {
  // normal 打 ghost 是 0 倍；用非本系普通技能，确保不被 STAB 抬高
  const atk = makeMonster({ element: 'water', atk: 1, level: 1 });
  const def = makeMonster({ element: 'ghost', def: 9999, spDef: 9999 });
  const normalMove = pickMove((m) => m.element === 'normal' && m.category === 'physical' && m.power > 0);
  const r = rules.computeDamage(atk as any, def as any, normalMove, fixed(0));
  assert.ok(Number.isInteger(r.dmg), `伤害必须是整数，实际 ${r.dmg}`);
  assert.ok(r.dmg >= 1, `伤害下限应为 1，实际 ${r.dmg}`);
  assert.equal(r.eff, 0, 'normal 打 ghost 的克制倍率应为 0');
});

test('伤害恒为正整数：随机序列极值下仍是整数', () => {
  for (const rngValue of [0, 0.25, 0.5, 0.75, 0.9999]) {
    for (const moveId of [PHYS, SPECIAL]) {
      const r = rules.computeDamage(makeMonster() as any, makeMonster({ element: 'water' }) as any, moveId, fixed(rngValue));
      assert.ok(Number.isInteger(r.dmg) && r.dmg >= 1, `${moveId} rng=${rngValue} → ${r.dmg}`);
      assert.ok(Number.isFinite(r.dmg), '伤害不能是 NaN / Infinity');
    }
  }
});

test('克制倍率单调：2 倍 > 1 倍 > 0.5 倍（同随机、同数值、只换防御方属性）', () => {
  const moveId = pickMove((m) => m.element === 'fire' && m.category === 'physical' && m.power > 0);
  const atk = makeMonster({ element: 'fire', atk: 100 }); // 本系，STAB 固定
  const dmgOf = (defElement: string) =>
    rules.computeDamage(atk as any, makeMonster({ element: defElement, def: 100 }) as any, moveId, fixed(0.5)).dmg;

  const strong = dmgOf('grass'); // 2x
  const neutral = dmgOf('normal'); // 1x
  const weak = dmgOf('water'); // 0.5x
  assert.ok(strong > neutral, `2x(${strong}) 应大于 1x(${neutral})`);
  assert.ok(neutral > weak, `1x(${neutral}) 应大于 0.5x(${weak})`);
});

test('等级单调：等级越高伤害越高', () => {
  const moveId = PHYS;
  let prev = 0;
  for (const level of [1, 5, 10, 25, 50, 100]) {
    const dmg = rules.computeDamage(
      makeMonster({ level }) as any, makeMonster({ element: 'water' }) as any, moveId, fixed(0.5),
    ).dmg;
    assert.ok(dmg > prev, `level=${level} 伤害 ${dmg} 应大于上一档 ${prev}`);
    prev = dmg;
  }
});

test('攻击单调：攻击越高伤害越高；防御单调：防御越高伤害越低', () => {
  const moveId = pickMove((m) => m.category === 'physical' && m.power > 0);
  const atkDmg = (atk: number) =>
    rules.computeDamage(makeMonster({ atk }) as any, makeMonster({ def: 80 }) as any, moveId, fixed(0.5)).dmg;
  const defDmg = (def: number) =>
    rules.computeDamage(makeMonster({ atk: 80 }) as any, makeMonster({ def }) as any, moveId, fixed(0.5)).dmg;

  assert.ok(atkDmg(200) > atkDmg(100), '攻击 200 应打出更高伤害');
  assert.ok(atkDmg(100) > atkDmg(20), '攻击 100 应高于 20');
  assert.ok(defDmg(200) < defDmg(100), '防御 200 应承受更低伤害');
  assert.ok(defDmg(100) < defDmg(20), '防御 100 应低于 20');
});

test('暴击恰为 1.5 倍（其余条件完全相同）', () => {
  // 选普通暴击率的技能（critChance=1 的技能无法构造「非暴击」对照组）
  const moveId = pickMove((m) => m.category === 'physical' && m.power > 0 && (m.critChance ?? 0.05) < 0.5);
  const atk = makeMonster({ atk: 100 });
  const def = makeMonster({ element: 'water', def: 100 });
  const crit = rules.computeDamage(atk as any, def as any, moveId, seq([0.5, 0])); // 随机 0 必中暴击
  const normal = rules.computeDamage(atk as any, def as any, moveId, seq([0.5, 0.9999]));
  assert.equal(crit.isCrit, true);
  assert.equal(normal.isCrit, false);
  // 暴击倍率作用在 floor 之前，允许 ±1 的取整误差
  const expected = Math.floor(normal.dmg * 1.5);
  assert.ok(Math.abs(crit.dmg - expected) <= 1, `暴击 ${crit.dmg} 应约为 ${expected}（非暴击 ${normal.dmg}）`);
});

test('变化技能不造成伤害', () => {
  const r = rules.computeDamage(makeMonster() as any, makeMonster() as any, STATUS, fixed(0.5));
  assert.equal(r.dmg, 0, '变化技能伤害应为 0');
  assert.equal(r.isCrit, false);
});

test('烧伤使物理伤害减半，特殊伤害不受影响', () => {
  const atk = makeMonster({ atk: 120 });
  const def = makeMonster({ element: 'water' });
  const physMove = pickMove((m) => m.category === 'physical' && m.power > 0);
  const specMove = pickMove((m) => m.category === 'special' && m.power > 0);

  const physNormal = rules.computeDamage(atk as any, def as any, physMove, seq([0.5, 0.9999])).dmg;
  const physBurn = rules.computeDamage({ ...atk, status: 'burn' } as any, def as any, physMove, seq([0.5, 0.9999])).dmg;
  assert.ok(physBurn < physNormal, `烧伤物理 ${physBurn} 应低于正常 ${physNormal}`);

  const specNormal = rules.computeDamage(atk as any, def as any, specMove, seq([0.5, 0.9999])).dmg;
  const specBurn = rules.computeDamage({ ...atk, status: 'burn' } as any, def as any, specMove, seq([0.5, 0.9999])).dmg;
  assert.equal(specBurn, specNormal, '烧伤不应影响特殊伤害');
});

test('能力等级：攻击 +2 提升伤害，-2 降低伤害', () => {
  const moveId = pickMove((m) => m.category === 'physical' && m.power > 0);
  const atk = makeMonster({ atk: 100 });
  const def = makeMonster({ element: 'water', def: 100 });
  const zero = { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 };
  const up = { ...zero, atk: 2 };
  const down = { ...zero, atk: -2 };

  const base = rules.computeDamage(atk as any, def as any, moveId, fixed(0.5), zero as any).dmg;
  const boosted = rules.computeDamage(atk as any, def as any, moveId, fixed(0.5), up as any).dmg;
  const reduced = rules.computeDamage(atk as any, def as any, moveId, fixed(0.5), down as any).dmg;
  assert.ok(boosted > base, `+2 攻击(${boosted}) 应高于基准(${base})`);
  assert.ok(reduced < base, `-2 攻击(${reduced}) 应低于基准(${base})`);
});

// ───────────────────────── PP 与技能表 ─────────────────────────

test('全部 294 个技能的 PP 都是 1~64 的整数', () => {
  const entries = Object.keys(MOVE_SPECS);
  assert.ok(entries.length >= 200, `技能表数量异常：${entries.length}`);
  for (const id of entries) {
    const pp = rules.getMoveMaxPP(id);
    assert.ok(Number.isInteger(pp) && pp >= 1 && pp <= 64, `${id} 的 PP=${pp} 不在合法区间`);
  }
});

test('initBattlePP 为每只幻兽的每个技能建条目，且不超过上限', () => {
  const m = makeMonster({ moveIds: [PHYS, SPECIAL, STATUS] });
  const pp = rules.initBattlePP([m as any]);
  const table = pp[m.id];
  assert.ok(table, '应为幻兽建立 PP 表');
  for (const id of m.moveIds) {
    assert.equal(table[id], rules.getMoveMaxPP(id), `${id} 初始 PP 应等于上限`);
  }
});

test('pickUsableMove：PP 为 0 的技能不会被选中', () => {
  const m = makeMonster({ moveIds: [PHYS, SPECIAL] });
  const ppAllZero = { [m.id]: { [PHYS]: 0, [SPECIAL]: 0 } };
  assert.equal(rules.pickUsableMove(m as any, ppAllZero[m.id], fixed(0.5)), null, 'PP 全空应返回 null');

  const ppOnlySpecial = { [m.id]: { [PHYS]: 0, [SPECIAL]: 3 } };
  for (let i = 0; i < 20; i += 1) {
    assert.equal(rules.pickUsableMove(m as any, ppOnlySpecial[m.id], fixed(i / 20)), SPECIAL, '只应选还有 PP 的技能');
  }
});

// ───────────────────────── 捕获率 ─────────────────────────

test('捕获率：满血时为基础率的 1/3（HP 系数公式决定）', () => {
  const enemy = makeMonster({ maxHp: 100, hp: 100, status: 'none' });
  const chance = rules.captureChance(enemy as any, 0.3, 1);
  // hpFactor = (3*maxHp - 2*hp) / (3*maxHp)，满血即 1/3
  assert.ok(Math.abs(chance - 0.1) < 1e-9, `满血应为 0.3/3=0.1，实际 ${chance}`);
});

test('捕获率：残血显著提高，且钳制在 0.95 以内', () => {
  const full = rules.captureChance(makeMonster({ maxHp: 100, hp: 100 }) as any, 0.3, 1);
  const low = rules.captureChance(makeMonster({ maxHp: 100, hp: 1 }) as any, 0.3, 1);
  assert.ok(low > full, `残血 ${low} 应高于满血 ${full}`);
  assert.ok(low <= 0.95, `捕获率不得超过 0.95，实际 ${low}`);

  const master = rules.captureChance(makeMonster({ maxHp: 100, hp: 1 }) as any, 0.3, 255);
  assert.equal(master, 0.95, '大师球应吃到 0.95 上限');
});

test('捕获率：不低于 0.02 下限', () => {
  const chance = rules.captureChance(makeMonster({ maxHp: 100, hp: 100 }) as any, 0.0001, 1);
  assert.equal(chance, 0.02, `极低基础率应被钳到 0.02，实际 ${chance}`);
});

test('捕获率：异常状态提高成功率（sleep/freeze 最高）', () => {
  const base = rules.captureChance(makeMonster({ status: 'none' }) as any, 0.2, 1);
  const para = rules.captureChance(makeMonster({ status: 'paralyze' }) as any, 0.2, 1);
  const sleep = rules.captureChance(makeMonster({ status: 'sleep' }) as any, 0.2, 1);
  assert.ok(para >= base, '麻痹不应降低捕获率');
  assert.ok(sleep > base, `睡眠 ${sleep} 应高于无状态 ${base}`);
  assert.ok(sleep > para, '睡眠加成应高于麻痹');
});

// ───────────────────────── 经验与升级 ─────────────────────────

test('升级经验曲线严格单调递增', () => {
  let prev = 0;
  for (let level = 1; level <= 100; level += 1) {
    const need = rules.requiredExpForNextLevel(level);
    assert.ok(Number.isInteger(need) && need > 0, `level=${level} 的需求经验应为正整数`);
    assert.ok(need > prev, `level=${level} 的需求(${need}) 应大于前一级(${prev})`);
    prev = need;
  }
});

test('升一级：等级 +1、经验扣减、maxHp 提升', () => {
  const before = makeMonster({ level: 10, exp: rules.requiredExpForNextLevel(10) });
  const after = rules.levelUp(before as any);
  assert.equal(after.level, 11, '等级应 +1');
  assert.ok(after.maxHp > before.maxHp, `maxHp 应提升：${before.maxHp} -> ${after.maxHp}`);
  assert.ok(after.exp >= 0, '剩余经验不应为负');
});

test('gainExp 一次只升一级且升级后经验归零（当前规则：溢出经验不累计）', () => {
  const m = makeMonster({ level: 1, exp: 0 });
  const big = rules.requiredExpForNextLevel(1) + rules.requiredExpForNextLevel(2) + rules.requiredExpForNextLevel(3);
  const r = rules.gainExp(m as any, big);
  assert.equal(r.leveled, true, '给足经验应触发升级');
  // levelUp 内部把 exp 置 0（前后端一致），因此 while 循环第二圈必然退出：
  // 「一次战斗最多升一级、溢出经验丢弃」是当前既定规则，不是浮点误差。
  // 若后续调整为累计经验，本用例会失败，属于**预期内的规则变更信号**。
  assert.equal(r.monster.level, 2, `当前规则应只升到 2 级，实际 ${r.monster.level}`);
  assert.equal(r.monster.exp, 0, `升级后经验应归零，实际 ${r.monster.exp}`);
});

test('gainExp：未达到阈值时不升级，经验正常累计', () => {
  const m = makeMonster({ level: 5, exp: 0 });
  const r = rules.gainExp(m as any, 5);
  assert.equal(r.monster.level, 5);
  assert.equal(r.monster.exp, 5, '未升级时经验应累加');
  assert.equal(r.leveled, false);
});

test('gainExp 给 0 经验不升级', () => {
  const m = makeMonster({ level: 5, exp: 0 });
  const r = rules.gainExp(m as any, 0);
  assert.equal(r.monster.level, 5);
  assert.equal(r.leveled, false);
});

// ───────────────────────── 能力值与实例 ─────────────────────────

test('getMonsterStatBounds 区间正向、带宽达标、下限归位种族值', () => {
  const STATS = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'spd'] as const;
  const BASE_KEY = {
    hp: 'baseHp', atk: 'baseAtk', def: 'baseDef',
    spAtk: 'baseSpAtk', spDef: 'baseSpDef', spd: 'baseSpd',
  } as const;
  const reversed: string[] = [];
  const tooNarrow: string[] = [];
  const notBase: string[] = [];

  for (const specId of Object.keys(MONSTER_SPECS)) {
    const spec = MONSTER_SPECS[specId] as any;
    const b = rules.getMonsterStatBounds(specId);
    for (const stat of STATS) {
      // 结构合法性：必须是有限正数，否则 createInstance 会生成 NaN 幻兽
      assert.ok(Number.isFinite(b.initMin[stat]) && b.initMin[stat] > 0, `${specId}.initMin.${stat} 非法：${b.initMin[stat]}`);
      assert.ok(Number.isFinite(b.initMax[stat]) && b.initMax[stat] > 0, `${specId}.initMax.${stat} 非法：${b.initMax[stat]}`);
      assert.ok(Number.isFinite(b.gMin[stat]) && b.gMin[stat] >= 0, `${specId}.gMin.${stat} 非法：${b.gMin[stat]}`);
      assert.ok(Number.isFinite(b.gMax[stat]) && b.gMax[stat] >= 0, `${specId}.gMax.${stat} 非法：${b.gMax[stat]}`);

      if (b.initMin[stat] > b.initMax[stat]) reversed.push(`${specId}.${stat}=${b.initMin[stat]}>${b.initMax[stat]}`);
      if (b.initMax[stat] - b.initMin[stat] < rules.INIT_SPREAD_MIN) {
        tooNarrow.push(`${specId}.${stat} 宽 ${b.initMax[stat] - b.initMin[stat]}`);
      }
      // 1 级下限必须等于种族值：这是「种族值是平均个体基准」的契约，
      // 一旦有人再往 initMin 上叠魔法偏移，区间会重新顶翻。
      if (b.initMin[stat] !== spec[BASE_KEY[stat]]) {
        notBase.push(`${specId}.${stat}=${b.initMin[stat]}≠${spec[BASE_KEY[stat]]}`);
      }
    }
  }

  assert.deepEqual(reversed, [], `存在 initMin > initMax 的区间：${reversed.slice(0, 5).join(', ')}`);
  assert.deepEqual(tooNarrow, [], `个体带宽低于 ${rules.INIT_SPREAD_MIN}：${tooNarrow.slice(0, 5).join(', ')}`);
  assert.deepEqual(notBase, [], `initMin 未等于种族值：${notBase.slice(0, 5).join(', ')}`);
});

test('forceInitMax 生成的六维等于该种族上限（防止上限失效再次回归）', () => {
  const STATS = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'spd'] as const;
  for (const specId of ['sprout_owl', 'spark_mouse', 'ember_marmot', 'rock_golem']) {
    const bounds = rules.getMonsterStatBounds(specId);
    const inst = rules.createInstance(specId, 1, seq([0.5]), { forceInitMax: true }) as any;
    for (const stat of STATS) {
      // hp 在 1 级时 maxHp 即 initStats.hp
      const actual = stat === 'hp' ? inst.maxHp : inst[stat];
      assert.equal(actual, bounds.initMax[stat], `${specId}.${stat} forceInitMax 应为 ${bounds.initMax[stat]}，实际 ${actual}`);
      assert.equal(inst.initStats[stat], bounds.initMax[stat], `${specId}.initStats.${stat} 未取上限`);
    }
  }
});

test('createInstance 生成的幻兽落在该种族的合法区间内', () => {
  const rng = seq([0.1, 0.3, 0.5, 0.7, 0.9, 0.2, 0.4]);
  for (const specId of ['sprout_owl', 'spark_mouse', 'ember_marmot']) {
    for (const level of [1, 10, 30]) {
      const inst = rules.createInstance(specId, level, rng) as any;
      assert.equal(inst.level, level);
      assert.ok(inst.hp === inst.maxHp, '新实例应满血');
      assert.ok(inst.maxHp > 0 && Number.isInteger(inst.maxHp), `maxHp=${inst.maxHp} 非法`);
      for (const k of ['atk', 'def', 'spAtk', 'spDef', 'spd']) {
        assert.ok(inst[k] > 0 && Number.isInteger(inst[k]), `${specId} L${level}.${k}=${inst[k]} 非法`);
      }
      assert.ok(Array.isArray(inst.moveIds) && inst.moveIds.length > 0, '新实例应至少掌握一个技能');
      assert.ok(inst.moveIds.every((id: string) => !!MOVE_SPECS[id]), '技能 id 必须在内容表内');
    }
  }
});

// ───────────────────────── 速度与行动顺序 ─────────────────────────

test('速度：麻痹减半；能力等级提升速度', () => {
  const m = makeMonster({ spd: 100 });
  assert.equal(rules.getSpeed(m as any), 100);
  assert.equal(rules.getSpeed({ ...m, status: 'paralyze' } as any), 50, '麻痹应使速度减半');
  const boosted = rules.getSpeed(m as any, { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 2 } as any);
  assert.ok(boosted > 100, `+2 速度等级应提速，实际 ${boosted}`);
});

test('findFirstAliveIndex 跳过倒地单位，全灭返回 -1', () => {
  const dead = makeMonster({ hp: 0 });
  const alive = makeMonster({ hp: 10 });
  assert.equal(rules.findFirstAliveIndex([dead as any, dead as any, alive as any]), 2);
  assert.equal(rules.findFirstAliveIndex([dead as any, dead as any]), -1);
  assert.equal(rules.findFirstAliveIndex([]), -1);
});

test('applyDamage 不会让 HP 变为负数', () => {
  const target = makeMonster({ hp: 30 });
  assert.equal((rules.applyDamage(target as any, 9999) as any).hp, 0);
  assert.equal((rules.applyDamage(target as any, 0) as any).hp, 30, '0 伤害不改变 HP');
});

// ───────────────────────── 状态异常 ─────────────────────────

test('canMove：睡眠/冰冻在随机未通过时无法行动', () => {
  const sleep = makeMonster({ status: 'sleep' });
  const blocked = rules.canMove(sleep as any, [], fixed(0.99));
  assert.equal(blocked.ok, false, '睡眠且随机未通过时不应行动');
  assert.equal(blocked.nextStatus, 'sleep', '睡眠未解除应保持状态');

  const frozen = makeMonster({ status: 'freeze' });
  assert.equal(rules.canMove(frozen as any, [], fixed(0.99)).ok, false, '冰冻未通过时不应行动');

  const normal = makeMonster({ status: 'none' });
  assert.equal(rules.canMove(normal as any, [], fixed(0.99)).ok, true, '无状态应可行动');
});

test('canMove：麻痹有概率无法行动，但不会是 100%', () => {
  const para = makeMonster({ status: 'paralyze' });
  const okCount = [0.1, 0.5, 0.9].filter((v) => rules.canMove(para as any, [], fixed(v)).ok).length;
  assert.ok(okCount > 0, '麻痹不应完全无法行动');
});

// ───────────────────────── 内容表完整性 ─────────────────────────

test('每个道具的 ID 与类型合法，捕获道具都有倍率', () => {
  const KINDS = ['capture', 'heal', 'status_heal', 'evolution', 'key_item'];
  for (const [id, item] of Object.entries(ITEM_SPECS)) {
    assert.equal(typeof id, 'string');
    assert.ok(typeof (item as any).name === 'string' && (item as any).name.length > 0, `${id} 缺少名称`);
    assert.ok(KINDS.includes((item as any).kind), `${id} 的 kind=${(item as any).kind} 非法`);
    if ((item as any).kind === 'capture') {
      assert.ok(typeof (item as any).modifier === 'number' && (item as any).modifier > 0, `${id} 捕获道具倍率非法`);
    }
    if ((item as any).kind === 'heal') {
      assert.ok((item as any).heal > 0, `${id} 治疗道具缺少治疗量`);
    }
    if ((item as any).kind === 'status_heal') {
      assert.ok(Array.isArray((item as any).cures) && (item as any).cures.length > 0, `${id} 缺少可治疗状态`);
    }
  }
});

test('每个幻兽都有合法属性、基础六维与可学技能', () => {
  for (const [specId, spec] of Object.entries(MONSTER_SPECS)) {
    const s = spec as any;
    assert.ok(s.element, `${specId} 缺少属性`);
    assert.ok(s.baseHp > 0 && s.baseAtk > 0 && s.baseDef > 0, `${specId} 基础六维非法`);
    assert.ok(Array.isArray(s.learnset) && s.learnset.length > 0, `${specId} 缺少可学技能`);
    for (const entry of s.learnset) {
      assert.ok(MOVE_SPECS[entry.moveId], `${specId} 的 ${entry.moveId} 不在技能表内`);
      assert.ok(entry.level >= 1, `${specId}.${entry.moveId} 的学习等级非法`);
    }
    if (s.captureRate !== undefined) {
      assert.ok(s.captureRate > 0 && s.captureRate <= 1, `${specId} 捕获基础率应在 (0,1]`);
    }
  }
});
