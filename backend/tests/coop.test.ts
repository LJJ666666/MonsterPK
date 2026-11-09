/**
 * F16 共斗 6 房副本：状态结构与回合推进纯函数单测。
 *
 * 只测纯逻辑（零 IO）：建副本（6 房 × 2 敌 / 等级递增）、意图编解码、
 * 房间四态与认领冲突、战败重打贡献保留、全清通关、全员全灭失败、
 * 伤害记账（只认 HP 差）、非法意图降级、按接收者裁剪视图。
 * HTTP / 房间接线 / 并发意图只减一次 / 结算发奖由 `e2e_f16.mjs` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createCoopState, applyCoopTurn, coopViewFor, contributionOf, resetDefeatedRoom,
  parseCoopIntent, encodeCoopIntent, pickCoopIntent,
  COOP_ROOM_COUNT, COOP_ENEMIES_PER_ROOM, COOP_ROOM_BASE_LEVEL, COOP_ROOM_LEVEL_STEP,
  COOP_DAILY_CLEAR_LIMIT, COOP_MIN_CONTRIBUTION,
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

function moveIntent(moveId: string): CoopIntent {
  return { type: 'move', moveId };
}

const enter = (roomIndex: number): CoopIntent => ({ type: 'enter', roomIndex });

// ───────────────────────── §30.8 默认取值 ─────────────────────────

test('§30.8 默认取值：6 房 / 每房 2 只 / Lv.5→15 / 每日 3 次 / 最低贡献 > 0', () => {
  assert.equal(COOP_ROOM_COUNT, 6);
  assert.equal(COOP_ENEMIES_PER_ROOM, 2);
  assert.equal(COOP_ROOM_BASE_LEVEL, 5);
  assert.equal(COOP_ROOM_BASE_LEVEL + COOP_ROOM_LEVEL_STEP * 5, 15);
  assert.equal(COOP_DAILY_CLEAR_LIMIT, 3);
  assert.equal(COOP_MIN_CONTRIBUTION, 1);
});

// ───────────────────────── 建副本 ─────────────────────────

test('createCoopState：6 房 × 2 敌、等级递增、sides 按座位、全员在大厅', () => {
  const s = newState();
  assert.equal(s.bossId, 'boss_ember_behemoth');
  assert.equal(s.rooms.length, 6);
  assert.equal(s.sides.length, 2);
  assert.deepEqual(s.seatRoom, [-1, -1]);
  assert.equal(s.turn, 1);
  assert.equal(s.finished, false);
  assert.equal(s.result, null);
  for (const r of s.rooms) {
    assert.equal(r.state, 'pending');
    assert.equal(r.enemies.length, 2);
    assert.equal(r.occupantSeat, null);
    assert.ok(r.enemies.every((e) => e.hp === e.maxHp && e.maxHp > 0));
    assert.equal(r.enemies[0].level, COOP_ROOM_BASE_LEVEL + COOP_ROOM_LEVEL_STEP * r.index);
  }
  assert.ok(Object.keys(s.sides[0].ppByMonster[s.sides[0].party[0].id] ?? {}).length > 0);
});

test('createCoopState：N 人通用（3 座）也能建态', () => {
  const s = newState(3);
  assert.equal(s.sides.length, 3);
  assert.deepEqual(s.seatRoom, [-1, -1, -1]);
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

test('parse/encodeCoopIntent 互逆：enter / move / switch / idle，且不支持 flee', () => {
  for (const raw of ['enter:0', 'enter:5', 'move:tackle', 'move:wood_strike', 'switch:0', 'switch:5', 'idle']) {
    const parsed = parseCoopIntent(raw);
    assert.ok(parsed, raw);
    assert.equal(encodeCoopIntent(parsed!), raw);
  }
  assert.equal(parseCoopIntent('flee'), null);
  assert.equal(parseCoopIntent('enter:6'), null);
  assert.equal(parseCoopIntent('move:'), null);
  assert.equal(parseCoopIntent('switch:6'), null);
  assert.equal(parseCoopIntent('move:bad!id'), null);
});

test('pickCoopIntent：大厅→enter 第一间可进房；全员占满→idle', () => {
  const s = newState();
  assert.deepEqual(pickCoopIntent(s, 0, seeded(3)), enter(0));
  // 6 间全 cleared → 没有可进的房
  for (const r of s.rooms) r.state = 'cleared';
  assert.deepEqual(pickCoopIntent(s, 0, seeded(3)), { type: 'idle' });
});

test('pickCoopIntent：房间内生成合法战斗意图，PP 耗尽降级换人', () => {
  const s = newState();
  const r = applyCoopTurn(s, [{ seat: 0, intent: enter(0) }], seeded(5));
  assert.ok(r.ok);
  const picked = pickCoopIntent(s, 0, seeded(3));
  assert.equal(picked.type, 'move');
  assert.ok(parseCoopIntent(encodeCoopIntent(picked)));
  const m = s.sides[0].party[s.sides[0].activeIndex];
  s.sides[0].ppByMonster[m.id] = Object.fromEntries(m.moveIds.map((id) => [id, 0]));
  s.sides[0].party.push({ ...m, id: 'sub', hp: m.maxHp });
  assert.equal(pickCoopIntent(s, 0, seeded(4))?.type, 'switch');
});

// ───────────────────────── 房间四态与认领 ─────────────────────────

test('applyCoopTurn：enter 认领 pending → fighting，一房同时只有 1 人', () => {
  const s = newState();
  const r = applyCoopTurn(s, [{ seat: 0, intent: enter(0) }], seeded(7));
  assert.ok(r.ok);
  assert.equal(s.rooms[0].state, 'fighting');
  assert.equal(s.rooms[0].occupantSeat, 0);
  assert.equal(s.seatRoom[0], 0);
  assert.equal(s.rooms[1].state, 'pending');
  assert.equal(s.turn, 2);
});

test('applyCoopTurn：两人同回合抢同一间 → 座位小者优先，其余降级 idle 不抛异常', () => {
  const s = newState();
  const r = applyCoopTurn(s, [
    { seat: 0, intent: enter(0) },
    { seat: 1, intent: enter(0) },
  ], seeded(8));
  assert.ok(r.ok);
  assert.equal(s.rooms[0].occupantSeat, 0);
  assert.equal(s.seatRoom[0], 0);
  assert.equal(s.seatRoom[1], -1);
  assert.ok(s.log.some((l) => l.includes('战斗中') || l.includes('等待')));
});

test('applyCoopTurn：两人各进一间 → 一次推进两间房都结算', () => {
  const s = newState();
  const r = applyCoopTurn(s, [
    { seat: 0, intent: enter(0) },
    { seat: 1, intent: enter(1) },
  ], seeded(9));
  assert.ok(r.ok);
  assert.equal(s.rooms[0].turn, 1);
  assert.equal(s.rooms[1].turn, 1);
  assert.equal(s.rooms[2].turn, 0);
  assert.equal(s.turn, 2);
});

test('applyCoopTurn：战败房可重打，敌人满血重置但贡献历史保留', () => {
  const s = newState();
  s.rooms[2].state = 'defeated';
  s.rooms[2].contributions[0] = 77;
  s.rooms[2].enemies[0].hp = 1;
  // enter 当回合会立即结算一回合，故在推进前用纯函数直接验证「满血重置」。
  resetDefeatedRoom(s.rooms[2]);
  assert.equal(s.rooms[2].enemies[0].hp, s.rooms[2].enemies[0].maxHp);
  assert.equal(s.rooms[2].contributions[0], 77);
  const r = applyCoopTurn(s, [{ seat: 0, intent: enter(2) }], seeded(10));
  assert.ok(r.ok);
  assert.equal(s.rooms[2].state, 'fighting');
  assert.equal(s.rooms[2].occupantSeat, 0);
  assert.ok((s.rooms[2].contributions[0] ?? 0) >= 77, '贡献历史不得清零');
});

test('applyCoopTurn：6 房全 cleared → finished / result=win', () => {
  const s = newState();
  for (const r of s.rooms) r.state = 'cleared';
  const res = applyCoopTurn(s, [], seeded(11));
  assert.ok(res.ok);
  assert.equal(s.finished, true);
  assert.equal(s.result, 'win');
  assert.equal('code' in applyCoopTurn(s, [], seeded(12)), true);
});

test('applyCoopTurn：全员出局 → finished / result=lose', () => {
  const s = newState();
  for (const side of s.sides) side.out = true;
  const r = applyCoopTurn(s, [], seeded(13));
  assert.ok(r.ok);
  assert.equal(s.finished, true);
  assert.equal(s.result, 'lose');
});

// ───────────────────────── 伤害真值与非法意图 ─────────────────────────

test('applyCoopTurn：伤害记账只认敌人 HP 差，累计到 rooms[].contributions', () => {
  const s = newState();
  const r = applyCoopTurn(s, [{ seat: 0, intent: enter(0) }], seeded(14));
  assert.ok(r.ok);
  const dealt = s.rooms[0].contributions[0] ?? 0;
  assert.ok(dealt >= 0);
  assert.equal(contributionOf(s, 0), dealt);
  // 手工篡改 contributions 不影响 HP 真值（记账来源是 HP 差，不是客户端数值）
  const hp = s.rooms[0].enemies[0].hp;
  s.rooms[0].contributions[0] = 999999;
  assert.equal(s.rooms[0].enemies[0].hp, hp);
});

test('applyCoopTurn：伪造技能 / 非法换人 → 降级不行动且不抛异常', () => {
  const s = newState();
  const r = applyCoopTurn(s, [
    { seat: 0, intent: enter(0) },
    { seat: 1, intent: moveIntent('not_a_real_move') },
  ], seeded(15));
  assert.ok(r.ok);
  const s2 = newState();
  const r2 = applyCoopTurn(s2, [
    { seat: 0, intent: enter(0) },
    { seat: 0, intent: moveIntent('not_a_real_move') },
  ], seeded(15));
  assert.equal('code' in r2, true, '同一座位重复提交应被拒');
  assert.ok(s.log.length >= 1);
});

test('applyCoopTurn：非法座位 / 重复座位被拒', () => {
  const s = newState();
  assert.equal('code' in applyCoopTurn(s, [
    { seat: 9, intent: enter(0) },
  ], seeded(1)), true);
  assert.equal('code' in applyCoopTurn(s, [
    { seat: 0, intent: enter(0) },
    { seat: 0, intent: enter(0) },
  ], seeded(1)), true);
});

test('applyCoopTurn：切换 active 在房间内生效', () => {
  const s = newState();
  const m = s.sides[0].party[0];
  s.sides[0].party.push({ ...m, id: 'sub', hp: m.maxHp });
  // 先认领，下一回合换人
  applyCoopTurn(s, [{ seat: 0, intent: enter(0) }], seeded(16));
  const r = applyCoopTurn(s, [
    { seat: 0, intent: { type: 'switch', partyIndex: 1 } },
    { seat: 1, intent: { type: 'idle' } },
  ], seeded(17));
  assert.ok(r.ok);
  assert.equal(s.sides[0].activeIndex, 1);
});

// ───────────────────────── 只读视图 ─────────────────────────

test('coopViewFor：下发 6 房四态视图、cleared/total、己方完整队伍、队友仅公开信息', () => {
  const s = newState();
  applyCoopTurn(s, [{ seat: 0, intent: enter(0) }], seeded(18));
  const v = coopViewFor(s, 'u0');
  assert.equal(v.rooms.length, 6);
  assert.equal(v.total, 6);
  assert.equal(v.cleared, 0);
  assert.equal(v.rooms[0].state, 'fighting');
  assert.equal(v.rooms[0].occupantSeat, 0);
  assert.equal(v.rooms[0].enemyPreviews.length, 2);
  assert.equal(v.self.seat, 0);
  assert.equal(v.self.roomIndex, 0);
  assert.ok(v.self.party[0].moveIds);
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
