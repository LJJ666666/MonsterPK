/**
 * P4-2a 战力纯函数单测。
 * 重点钉住三条边界：maxHp 而非 hp、装备加成不写回面板、公式不参与任何游戏判定。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  POWER_DISCLAIMER, effectiveStats, monsterPower, partyPower, bestMonsterPower,
} from '../src/game/power.ts';

const base = {
  id: 'm1', specId: 'sprout_owl', level: 9,
  maxHp: 72, hp: 72, atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90,
};

test('单宠战力 = 有效六维之和', () => {
  assert.equal(monsterPower(base), 72 + 78 + 66 + 88 + 74 + 90);
  assert.equal(monsterPower(base), 468);
});

test('必须用 maxHp：hp 掉血 / 回血都不改变战力', () => {
  const hurt = { ...base, hp: 1 };
  const healed = { ...base, hp: 72 };
  const dead = { ...base, hp: 0, status: 'fainted' };
  assert.equal(monsterPower(hurt), monsterPower(healed));
  assert.equal(monsterPower(dead), monsterPower(base));
  assert.equal(monsterPower({ ...base, maxHp: 100, hp: 1 }), 496);
});

test('effectiveStats 输出六维且不含 hp / level / spec 等其它字段', () => {
  const s = effectiveStats(base);
  assert.deepEqual(Object.keys(s).sort(), ['atk', 'def', 'maxHp', 'spAtk', 'spDef', 'spd']);
  assert.equal((s as any).hp, undefined);
  assert.equal((s as any).level, undefined);
  assert.deepEqual(s, { maxHp: 72, atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90 });
});

test('装备加成为服务端独立真值叠加，装备上线时战力函数零改动', () => {
  const bonus = { atk: 20, spd: 5 };
  assert.equal(monsterPower(base, bonus), 468 + 25);
  assert.deepEqual(effectiveStats(base, bonus), {
    maxHp: 72, atk: 98, def: 66, spAtk: 88, spDef: 74, spd: 95,
  });
});

test('装备加成绝不写回 MonsterInstance 面板', () => {
  const m = { ...base };
  const snapshot = JSON.stringify(m);
  effectiveStats(m, { atk: 20 });
  monsterPower(m, { atk: 20 });
  assert.equal(JSON.stringify(m), snapshot, '输入对象被就地修改会污染 digestOf / authority 摘要');
});

test('NaN / Infinity / 负数 / 字符串 / null 一律归零，脏档抬不了榜', () => {
  assert.equal(monsterPower(null), 0);
  assert.equal(monsterPower({ ...base, atk: NaN, def: Infinity, spd: -50, spAtk: '999' as any }),
    72 + 0 + 0 + 0 + 74 + 0);
  assert.equal(monsterPower(base, { atk: -100, spd: NaN } as any), 468);
  assert.equal(monsterPower({}), 0);
});

test('全队战力 = party 之和，空/非数组为 0', () => {
  const second = { ...base, id: 'm2', maxHp: 10, atk: 10, def: 10, spAtk: 10, spDef: 10, spd: 10 };
  assert.equal(partyPower([base, second]), 468 + 60);
  assert.equal(partyPower([]), 0);
  assert.equal(partyPower(null), 0);
  assert.equal(partyPower('oops' as any), 0);
  assert.equal(partyPower([base, null, undefined]), 468);
});

test('单宠榜取 party ∪ box 最高一只，box 不进全队战力', () => {
  const weak = { ...base, maxHp: 10, atk: 10, def: 10, spAtk: 10, spDef: 10, spd: 10 };
  const ace = { ...base, spd: 200 };
  assert.equal(bestMonsterPower([weak], [ace]), 468 - 90 + 200);
  assert.equal(partyPower([weak]), 60);
  assert.equal(bestMonsterPower([], []), 0);
  assert.equal(bestMonsterPower(null, [ace]), 468 - 90 + 200);
});

test('免责声明固定口径，战力函数不导出任何判定能力', async () => {
  assert.match(POWER_DISCLAIMER, /不代表实战强弱/);
  const mod = await import('../src/game/power.ts');
  assert.equal(typeof (mod as any).matchByPower, 'undefined');
  assert.equal(typeof (mod as any).damageByPower, 'undefined');
});
