/**
 * 学习装置经验重分配单测（W3，2026-11-16）。
 *
 * 锁定杰哥拍板的新公式（E = 本次基础经验，active = 出战击杀者，S = 开了开关且存活的携带宠）：
 *   |S| == 0  → active 获 E（全额、无衰减）
 *   |S| >  0  → active 获 floor(E/2)，另 floor((E - floor(E/2))/2) 由 S 中每只均摊
 *   active 若也在 S 中，则两者叠加（例 E=100、5 只全开 → active 55，其余各 5）
 * 另锁：护符金币删除后不再有金钱 ×2。
 *
 * 红测先行：当前 battle.ts 还是旧公式（hasExpShare 按背包持有），本文件应全红。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createBattle, applyBattleAction, computeRewards } from '../src/game/battle.js';
import { THEME_TABLE } from '../src/game/content.js';
import type { Rng } from '../src/game/rules.js';
import { expGrantAllowed } from '../src/game/playerLevel.js';

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function mon(id: string, on: boolean) {
  return {
    id, specId: 'spark_mouse', level: 5, exp: 0, element: 'electric' as const,
    maxHp: 200, hp: 200, atk: 300, def: 200, spAtk: 300, spDef: 200, spd: 200,
    status: 'none' as const, moveIds: ['tackle'], expShareOn: on,
    initStats: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
    growthRates: { hp: 1, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 },
  };
}

/** switches[0] 是出战击杀者；用 testOHKO 稳定击倒（ enemy Lv.2 → expGain = 22）。 */
function win(switches: boolean[], cap: number | null = null, buyItem = true) {
  const party = switches.map((on, i) => mon(`p${i}`, on));
  let cur = createBattle({
    id: 'bt_exp', userId: 'u_exp', theme: 'grass', areaName: '测试草地', areaId: 'wild_starter',
    levelMin: 2, levelMax: 2, party, themes: THEME_TABLE, now: 1000, rng: seeded(7), levelCap: cap,
  });
  for (let i = 0; i < 6 && !cur.finished; i += 1) {
    cur = applyBattleAction(cur, { type: 'move', moveId: 'tackle' }, {
      inventory: buyItem ? { exp_share: 1 } : {}, rng: seeded(100 + i), now: 2000 + i * 1000, testOHKO: true,
    });
  }
  return cur;
}
/** 从战斗结果读基础经验真值（避免对生成等级做假设）。 */

test('W3-1 无人开开关 → 出战击杀者获全额经验（无衰减）', () => {
  const done = win([false, false, false]);
  assert.equal(done.finished, true);
  assert.equal(done.result, 'enemy_fainted');
  const E = done.rewards!.expGain;
  assert.equal(done.party[0].exp, E, `击杀者应拿全额 ${E}`);
  assert.equal(done.party[1].exp, 0, '未开的拿 0');
});

test('W3-2 全开（含击杀者）→ 击杀者 11+2=13，其余各 2（E=22）', () => {
  const done = win([true, true, true]);
  const E = done.rewards!.expGain;
  const half = Math.floor(E / 2);
  const pool = Math.floor((E - half) / 2);
  assert.equal(done.party[0].exp, half + Math.floor(pool / 3), `击杀者 ${half}+${Math.floor(pool / 3)}`);
  assert.equal(done.party[1].exp, Math.floor(pool / 3));
  assert.equal(done.party[2].exp, Math.floor(pool / 3));
});

test('W3-3 击杀者没开、其余 2 只开 → 击杀者 E/2，2 只各均摊', () => {
  const done = win([false, true, true]);
  const E = done.rewards!.expGain;
  const half = Math.floor(E / 2);
  const pool = Math.floor((E - half) / 2);
  assert.equal(done.party[0].exp, half);
  assert.equal(done.party[1].exp, Math.floor(pool / 2));
  assert.equal(done.party[2].exp, Math.floor(pool / 2));
});

test('W3-4 等级帽：超帽的宠物即使开开关也不获经验', () => {
  const done = win([true, true], 5); // cap=5，所有 Lv.5 已到帽
  assert.equal(done.party[0].exp, 0);
  assert.equal(done.party[1].exp, 0);
  assert.equal(expGrantAllowed(5, 5), false);
});

test('W3-5 护符金币已删除：computeRewards 不再有翻倍字段', () => {
  const r = computeRewards(5, { amulet_coin: 1 }) as any;
  assert.ok(!('hasAmuletCoin' in r), 'computeRewards 不应再返回 hasAmuletCoin');
  assert.equal(r.moneyGain, 50 + 5 * 10, '金钱为基础值，不翻倍');
});
