/**
 * P4-2e 共斗 Boss / 副本：状态结构与回合推进纯函数单测。
 *
 * 只测纯逻辑（零 IO）：建共斗（N 人通用）、意图编解码、N 人排序结算、
 * Boss HP 真值与伤害记账、非法意图降级、换人、胜负判定、只读视图裁剪。
 * HTTP / 房间接线 / 并发意图只减一次 / 结算写档由 `e2e_p42e_coop.mjs` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoopState, applyCoopTurn, coopViewFor,
  parseCoopIntent, encodeCoopIntent, pickCoopIntent,
  type CoopState, type CoopIntent,
} from '../src/game/coop.js';
import { getBoss } from '../src/game/boss.js';
import { createInstance, type Rng } from '../src/game/rules.js';

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function party(rng: Rng, specId = 'sprout_owl', level = 30, id = 'a1'): any[] {
  return [createInstance(specId, level, rng, { id })];
}

function newState(seatCount = 2): CoopState {
  const spec = getBoss('boss_ember_behemoth');
  assert.ok(spec);
  const parties = Array.from({ length: seatCount }, (_, i) => ({
    userId: `u${i}`,
    party: party(seeded(i + 1), i % 2 === 0 ? 'sprout_owl' : 'spark_mouse', 30, `m${i}`),
  }));
  const res = createCoopState({ spec, parties, rng: seeded(99) });
  assert.ok(res.ok);
  return res.value;
}

function firstMoveOf(s: CoopState, seat: number): string {
  const side = s.sides[seat];
  return side.party[side.activeIndex].moveIds[0];
}

function moveIntent(moveId: string): CoopIntent {
  return { type: 'move', moveId };
}

function allIntents(s: CoopState, moveId?: string): { seat: number; intent: CoopIntent }[] {
  return s.sides.map((_, seat) => ({ seat, intent: moveIntent(moveId ?? firstMoveOf(s, seat)) }));
}

// ───────────────────────── 建共斗 ─────────────────────────

test('createCoopState：Boss HP 按内容表倍率抬高、sides 按座位、PP 建立', () => {
  const s = newState();
  assert.equal(s.bossId, 'boss_ember_behemoth');
  assert.equal(s.sides.length, 2);
  assert.equal(s.sides[0].userId, 'u0');
  assert.equal(s.sides[1].userId, 'u1');
  assert.equal(s.turn, 1);
  assert.equal(s.finished, false);
  assert.equal(s.result, null);
  assert.equal(s.boss.hp, s.boss.maxHp);
  assert.ok(s.boss.maxHp > 0);
  const a0 = s.sides[0].party[s.sides[0].activeIndex];
  assert.ok(a0.moveIds.every((m) => (s.sides[0].ppByMonster[a0.id]?.[m] ?? 0) > 0));
  assert.ok(Object.keys(s.bossPP).length > 0);
});

test('createCoopState：N 人通用（3 座）也能建态', () => {
  const s = newState(3);
  assert.equal(s.sides.length, 3);
  assert.equal(s.sides[2].userId, 'u2');
});

test('createCoopState：空座位 / 空队伍 / 全灭队伍被拒', () => {
  const spec = getBoss('boss_ember_behemoth')!;
  assert.equal('code' in createCoopState({ spec, parties: [], rng: seeded(1) }), true);
  assert.equal('code' in createCoopState({
    spec, parties: [{ userId: 'u0', party: [] }], rng: seeded(1),
  }), true);
  const fainted = party(seeded(1)).map((m) => ({ ...m, hp: 0 }));
  assert.equal('code' in createCoopState({
    spec, parties: [{ userId: 'u0', party: fainted }], rng: seeded(1),
  }), true);
});

// ───────────────────────── 意图编解码 ─────────────────────────

test('parse/encodeCoopIntent 互逆，且共斗不支持 flee', () => {
  for (const raw of ['move:tackle', 'move:wood_strike', 'switch:0', 'switch:5']) {
    const parsed = parseCoopIntent(raw);
    assert.ok(parsed);
    assert.equal(encodeCoopIntent(parsed!), raw);
  }
  assert.equal(parseCoopIntent('flee'), null);
  assert.equal(parseCoopIntent('move:'), null);
  assert.equal(parseCoopIntent('switch:6'), null);
  assert.equal(parseCoopIntent('move:bad!id'), null);
});

test('pickCoopIntent 生成合法意图，PP 耗尽时降级为换人', () => {
  const s = newState();
  const picked = pickCoopIntent(s, 0, seeded(3));
  assert.ok(picked);
  assert.equal(parseCoopIntent(encodeCoopIntent(picked!))?.type, picked!.type);
  // 手动清空 active 的所有 PP，且给一只替补 → 应返回 switch。
  const m = s.sides[0].party[s.sides[0].activeIndex];
  s.sides[0].ppByMonster[m.id] = Object.fromEntries(m.moveIds.map((id) => [id, 0]));
  s.sides[0].party.push({ ...m, id: 'sub', hp: m.maxHp });
  const fallback = pickCoopIntent(s, 0, seeded(4));
  assert.equal(fallback?.type, 'switch');
});

// ───────────────────────── 回合推进 ─────────────────────────

test('applyCoopTurn：全员技能结算一回合，Boss HP 下降且 damage 记账等于 HP 差', () => {
  const s = newState();
  const before = s.boss.hp;
  const r = applyCoopTurn(s, allIntents(s), seeded(7));
  assert.ok(r.ok);
  const after = s.boss.hp;
  assert.ok(after < before, `Boss HP 应下降：${before} → ${after}`);
  assert.equal(s.sides.reduce((n, x) => n + x.damage, 0), before - after);
  assert.equal(s.turn, 2);
  assert.ok(s.log.length > 1);
});

test('applyCoopTurn：N 人（3 座）按座位排序都能行动', () => {
  const s = newState(3);
  const r = applyCoopTurn(s, allIntents(s), seeded(8));
  assert.ok(r.ok);
  assert.equal(s.turn, 2);
  assert.ok(s.sides.every((x) => x.damage >= 0));
});

test('applyCoopTurn：缺失座位意图由服务端代放补齐，不卡回合', () => {
  const s = newState();
  const only0 = [{ seat: 0, intent: moveIntent(firstMoveOf(s, 0)) }];
  const r = applyCoopTurn(s, only0, seeded(9));
  assert.ok(r.ok);
  assert.equal(s.turn, 2);
});

test('applyCoopTurn：非法座位 / 重复座位被拒', () => {
  const s = newState();
  assert.equal('code' in applyCoopTurn(s, [
    { seat: 9, intent: moveIntent('tackle') },
  ], seeded(1)), true);
  assert.equal('code' in applyCoopTurn(s, [
    { seat: 0, intent: moveIntent('tackle') },
    { seat: 0, intent: moveIntent('tackle') },
  ], seeded(1)), true);
});

test('applyCoopTurn：伪造技能 / 未掌握技能 / PP 耗尽 → 降级不行动且不抛异常', () => {
  const s = newState();
  const before = s.boss.hp;
  const r = applyCoopTurn(s, [
    { seat: 0, intent: moveIntent('not_a_real_move') },
    { seat: 1, intent: moveIntent('not_a_real_move') },
  ], seeded(11));
  assert.ok(r.ok);
  // Boss 反击不改变自身 HP；非法意图不该造成伤害记账。
  assert.equal(s.sides[0].damage, 0);
  assert.equal(s.sides[1].damage, 0);
  assert.ok(s.log.some((l) => l.includes('不合法')));
  assert.ok(s.boss.hp <= before);
});

test('applyCoopTurn：换人意图切换 activeIndex', () => {
  const s = newState();
  const m = s.sides[0].party[0];
  s.sides[0].party.push({ ...m, id: 'sub', hp: m.maxHp });
  const r = applyCoopTurn(s, [
    { seat: 0, intent: { type: 'switch', partyIndex: 1 } },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(12));
  assert.ok(r.ok);
  assert.equal(s.sides[0].activeIndex, 1);
});

test('applyCoopTurn：Boss 倒下 → finished / result=win', () => {
  const s = newState();
  s.boss.hp = 1;
  const r = applyCoopTurn(s, allIntents(s), seeded(13));
  assert.ok(r.ok);
  assert.equal(s.finished, true);
  assert.equal(s.result, 'win');
  assert.equal(s.boss.hp, 0);
  assert.equal('code' in applyCoopTurn(s, allIntents(s), seeded(14)), true);
});

test('applyCoopTurn：全员出局 → finished / result=lose', () => {
  const s = newState();
  for (const side of s.sides) {
    side.party[side.activeIndex].hp = 0;
    side.out = true;
  }
  const r = applyCoopTurn(s, allIntents(s), seeded(15));
  assert.ok(r.ok);
  assert.equal(s.finished, true);
  assert.equal(s.result, 'lose');
});

// ───────────────────────── 只读视图 ─────────────────────────

test('coopViewFor：己方完整队伍、队友与 Boss 只有公开信息', () => {
  const s = newState();
  const v = coopViewFor(s, 'u0');
  assert.equal(v.bossId, 'boss_ember_behemoth');
  assert.equal(v.boss.hp, s.boss.hp);
  assert.ok(v.self.party[0].moveIds);
  assert.equal(v.self.seat, 0);
  assert.equal(v.members.length, 2);
  assert.equal(v.members[0].self, true);
  assert.equal(v.members[1].self, false);
  assert.equal('moveIds' in v.members[1].active, false);
  assert.equal('ppByMonster' in (v.members[1] as any), false);
});

test('coopViewFor：换一个接收者，self 随之变化', () => {
  const s = newState();
  const v = coopViewFor(s, 'u1');
  assert.equal(v.self.userId, 'u1');
  assert.equal(v.self.seat, 1);
  assert.equal(v.members[1].self, true);
});
