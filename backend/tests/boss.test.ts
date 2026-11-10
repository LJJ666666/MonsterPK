/**
 * P4-2c 单人 Boss 讨伐：内容表 / 日键 / 次数 / 伤害累计的单测。
 *
 * 这一层只测纯逻辑（零 IO）：Boss 定义合法性、次数钳制、UTC+8 日键、
 * Boss 敌人 HP 倍率、以及「伤害只来自服务端 HP 差」这条核心口径。
 * HTTP 层与榜单由 `e2e_p42c_boss.mjs` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BOSSES, BOSS_IDS, getBoss, bossDailyLimit, dayKeyOf, bossQuotaKey,
  createBossEnemy, bossView,
} from '../src/game/boss.js';
import { ITEM_SPECS, MOVE_SPECS, MONSTER_SPECS } from '../src/game/content.js';
import { createInstance, type Rng } from '../src/game/rules.js';
import { createBattle, applyBattleAction, BattleError } from '../src/game/battle.js';

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const THEMES: Record<string, string[]> = { grass: ['spark_mouse'] };

function partyOf(rng: Rng, specId = 'spark_mouse', level = 20) {
  return [createInstance(specId, level, rng)];
}

function startBossBattle(bossId = 'boss_ember_behemoth', level = 20) {
  const rng = seeded(7);
  return createBattle({
    id: `bt_${bossId}`,
    userId: 'u1',
    theme: 'grass',
    areaName: '测试草地',
    levelMin: 1,
    levelMax: 3,
    party: partyOf(rng, 'spark_mouse', level),
    themes: THEMES,
    now: 1_700_000_000_000,
    rng: seeded(11),
    boss: { spec: BOSSES[bossId] },
  });
}

// ───────────────────────── 内容表 ─────────────────────────

test('Boss 内容表：种族存在、等级与倍率合法、key 与 bossId 一致', () => {
  assert.ok(BOSS_IDS.length >= 3, '至少三只 Boss');
  for (const id of BOSS_IDS) {
    const b = BOSSES[id];
    assert.equal(b.bossId, id);
    assert.ok(MONSTER_SPECS[b.speciesId], `${id} 的种族 ${b.speciesId} 不在内容表里`);
    assert.ok(b.level >= 1 && b.level <= 60, `${id} 等级越界`);
    assert.ok(b.hpMultiplier > 1, `${id} 的 HP 倍率应大于 1`);
    assert.ok(b.dailyLimit >= 1, `${id} 每日次数应至少 1 次`);
    assert.ok(typeof b.name === 'string' && b.name.length > 0);
  }
});

test('getBoss：未知 / 非字符串 / 原型属性一律 null', () => {
  assert.equal(getBoss('nope'), null);
  assert.equal(getBoss(''), null);
  assert.equal(getBoss(123), null);
  assert.equal(getBoss('toString'), null, '不能把原型链属性当 Boss');
  assert.equal(getBoss('boss_ember_behemoth')?.bossId, 'boss_ember_behemoth');
});

test('bossView 不下发 HP 倍率', () => {
  const v = bossView(BOSSES.boss_ember_behemoth, 3) as Record<string, unknown>;
  assert.equal(v.bossId, 'boss_ember_behemoth');
  assert.equal(v.dailyLimit, 3);
  assert.equal('hpMultiplier' in v, false, '倍率属于服务端真值，不下发');
});

// ───────────────────────── 次数与日键 ─────────────────────────

test('bossDailyLimit：内容表为基准，env 只能下调', () => {
  const spec = BOSSES.boss_ember_behemoth; // 3
  assert.equal(bossDailyLimit(spec, {}), 3);
  assert.equal(bossDailyLimit(spec, { BOSS_DAILY_LIMIT: '2' }), 2);
  assert.equal(bossDailyLimit(spec, { BOSS_DAILY_LIMIT: '99' }), 3, '不能把次数放大');
  assert.equal(bossDailyLimit(spec, { BOSS_DAILY_LIMIT: 'abc' }), 3);
  assert.equal(bossDailyLimit(spec, { BOSS_DAILY_LIMIT: '-5' }), 0);
});

test('dayKeyOf：固定 UTC+8，跨日边界可复现', () => {
  // 2026-11-07T15:59:59Z = 北京时间 23:59:59
  assert.equal(dayKeyOf(Date.parse('2026-11-07T15:59:59Z')), '2026-11-07');
  // 2026-11-07T16:00:00Z = 北京时间次日 00:00
  assert.equal(dayKeyOf(Date.parse('2026-11-07T16:00:00Z')), '2026-11-08');
  assert.equal(dayKeyOf(Date.parse('2026-11-07T00:00:00Z')), '2026-11-07');
});

test('bossQuotaKey：同账号同日同 Boss 稳定，换日即换键', () => {
  const a = bossQuotaKey('u1', 'boss_x', '2026-11-07');
  assert.equal(a, bossQuotaKey('u1', 'boss_x', '2026-11-07'));
  assert.notEqual(a, bossQuotaKey('u1', 'boss_x', '2026-11-08'));
  assert.notEqual(a, bossQuotaKey('u2', 'boss_x', '2026-11-07'));
});

// ───────────────────────── Boss 敌人 ─────────────────────────

test('createBossEnemy：HP 按倍率放大，maxHp 一起抬高，其余面板不变', () => {
  const spec = BOSSES.boss_phantom_lord;
  const base = createInstance(spec.speciesId, spec.level, seeded(3));
  const boss = createBossEnemy(spec, seeded(3));
  assert.equal(boss.specId, spec.speciesId);
  assert.equal(boss.level, spec.level);
  assert.equal(boss.maxHp, Math.floor(base.maxHp * spec.hpMultiplier));
  assert.equal(boss.hp, boss.maxHp, '满血开场');
  assert.equal(boss.atk, base.atk, '不靠调攻击力制造难度');
  assert.equal(boss.spd, base.spd);
});

test('createBattle(boss)：区域名与主题取自 Boss，areaId 为空（不写首通）', () => {
  const spec = BOSSES.boss_apex_dragon;
  const s = startBossBattle(spec.bossId);
  assert.equal(s.bossId, spec.bossId);
  assert.equal(s.bossName, spec.name);
  assert.equal(s.areaName, spec.name);
  assert.equal(s.theme, spec.theme);
  assert.equal(s.areaId, null);
  assert.equal(s.damageDealt, 0);
  assert.equal(s.enemy.specId, spec.speciesId);
  assert.equal(s.enemy.level, spec.level);
  assert.equal(s.enemy.hp, s.enemy.maxHp, 'Boss 满血开场');
  assert.ok(s.enemy.maxHp > 0);
});

// ───────────────────────── 伤害与捕获 ─────────────────────────

test('damageDealt 只等于敌方 HP 差，且逐次单调不减', () => {
  const s = startBossBattle();
  const moveId = s.party[0].moveIds.find((id) => (MOVE_SPECS[id]?.power ?? 0) > 0)!;
  assert.ok(moveId, '队伍应有至少一个攻击技能');
  const ctx = { inventory: {}, rng: (() => 0) as Rng, now: 1_700_000_001_000 };
  const before = s.enemy.hp;
  const next = applyBattleAction(s, { type: 'move', moveId }, ctx);
  const dealt = Math.max(0, before - next.enemy.hp);
  assert.equal(next.damageDealt, dealt);
  assert.ok(next.damageDealt > 0, '固定 RNG 下应命中并造成伤害');
  assert.ok(next.damageDealt <= before, '累计伤害不会超过 Boss 初始血量');
});

test('普通战斗也累计 damageDealt，但不影响结算产物', () => {
  const rng = seeded(5);
  const s = createBattle({
    id: 'bt_plain', userId: 'u1', theme: 'grass', areaName: '草地',
    levelMin: 2, levelMax: 2, party: partyOf(rng, 'spark_mouse', 20), themes: THEMES,
    now: 1_700_000_000_000, rng: seeded(9),
  });
  assert.equal(s.bossId, null);
  const moveId = s.party[0].moveIds.find((id) => (MOVE_SPECS[id]?.power ?? 0) > 0)!;
  const next = applyBattleAction(s, { type: 'move', moveId }, {
    inventory: {}, rng: () => 0, now: 1_700_000_001_000,
  });
  assert.ok(next.damageDealt > 0, '普通战斗同样按 HP 差累计');
  assert.equal(next.bossId, null, '普通战斗不会被标成 Boss 战');
});

test('Boss 战禁止捕获，且不消耗道具', () => {
  const s = startBossBattle();
  const ballId = Object.keys(ITEM_SPECS).find((id) => (ITEM_SPECS as any)[id].kind === 'capture')!;
  assert.throws(
    () => applyBattleAction(s, { type: 'capture', itemId: ballId }, {
      inventory: { [ballId]: 5 }, rng: () => 0, now: 1_700_000_002_000,
    }),
    (err: unknown) => err instanceof BattleError && err.code === 'BOSS_UNCATCHABLE',
  );
  assert.deepEqual(s.consumed, {}, '被拒的捕获不能扣道具');
});
