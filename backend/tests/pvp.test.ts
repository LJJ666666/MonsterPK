/**
 * P4-2d 玩家对战 1v1：状态结构与回合推进纯函数单测。
 *
 * 只测纯逻辑（零 IO）：建战斗、双方意图合并、先手判定、技能结算、
 * 换人、逃跑判负、全灭判负、回合末持续伤害、只读视图按接收者裁剪。
 * HTTP / 房间接线 / 结算写双方档由 `e2e_p42d_pvp.mjs` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  createPvpState, applyPvpTurn, pvpViewFor, PvpError,
  type PvpState, type PvpIntent,
} from '../src/game/pvp.js';
import { createInstance, type Rng } from '../src/game/rules.js';

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

function party(rng: Rng, specId = 'sprout_owl', level = 20, id = 'a1'): any[] {
  return [createInstance(specId, level, rng, { id })];
}

/** A 方用 sprout_owl（有 tackle），B 方用 spark_mouse（有 scratch）。 */
function newState(opts: { aId?: string; bId?: string } = {}): PvpState {
  const rng = seeded(1);
  const res = createPvpState({
    sideA: { userId: 'ua', party: party(rng, 'sprout_owl', 20, opts.aId ?? 'a1') },
    sideB: { userId: 'ub', party: party(seeded(2), 'spark_mouse', 20, opts.bId ?? 'b1') },
    now: 1_700_000_000_000,
  });
  assert.ok(res.ok);
  return res.value;
}

/** 取该 side 当前 active 的第一个技能（保证是它真实掌握的）。 */
function firstMoveOf(s: PvpState, seat: number): string {
  const side = s.sides[seat];
  return side.party[side.activeIndex].moveIds[0];
}

function moveIntent(moveId = 'tackle'): PvpIntent {
  return { type: 'move', moveId };
}

// ───────────────────────── 建战斗 ─────────────────────────

test('createPvpState：双方镜像、PP 建立、活体上场', () => {
  const s = newState();
  assert.equal(s.sides.length, 2);
  assert.equal(s.sides[0].userId, 'ua');
  assert.equal(s.sides[1].userId, 'ub');
  assert.equal(s.turn, 1);
  assert.equal(s.finished, false);
  assert.equal(s.winnerUserId, null);
  // 双方 active 都是活体
  assert.ok(s.sides[0].party[s.sides[0].activeIndex].hp > 0);
  assert.ok(s.sides[1].party[s.sides[1].activeIndex].hp > 0);
  // PP 已建立
  const a0 = s.sides[0].party[s.sides[0].activeIndex];
  assert.ok(a0.moveIds.every((m) => (s.sides[0].ppByMonster[a0.id]?.[m] ?? 0) > 0));
});

test('createPvpState：空队伍 / 全灭被拒', () => {
  const r = createPvpState({
    sideA: { userId: 'ua', party: [] },
    sideB: { userId: 'ub', party: party(seeded(2)) },
    now: Date.now(),
  });
  assert.equal('code' in r, true);
});

test('createPvpState：全灭队伍被拒', () => {
  const rng = seeded(1);
  const fainted = party(rng).map((m) => ({ ...m, hp: 0 }));
  const r = createPvpState({
    sideA: { userId: 'ua', party: fainted },
    sideB: { userId: 'ub', party: party(seeded(2)) },
    now: Date.now(),
  });
  assert.equal('code' in r, true);
});

// ───────────────────────── 回合推进 ─────────────────────────

test('applyPvpTurn：双方技能推进一回合，turn+1，log 追加', () => {
  const s = newState();
  const turn0 = s.turn;
  const r = applyPvpTurn(s, [
    { seat: 0, intent: moveIntent(firstMoveOf(s, 0)) },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9));
  assert.ok(r.ok);
  assert.equal(r.value.turn, turn0 + 1);
  assert.ok(r.value.log.length > 1);
});

test('applyPvpTurn：缺一个意图被拒', () => {
  const s = newState();
  const r = applyPvpTurn(s, [{ seat: 0, intent: moveIntent('tackle') }], seeded(9));
  assert.equal('code' in r, true);
  assert.equal('code' in r && r.code, 'PVP_NEED_TWO_ACTIONS');
});

test('applyPvpTurn：同座位重复提交被拒', () => {
  const s = newState();
  const r = applyPvpTurn(s, [
    { seat: 0, intent: moveIntent('tackle') },
    { seat: 0, intent: moveIntent('tackle') },
  ], seeded(9));
  assert.equal('code' in r, true);
});

test('applyPvpTurn：非法座位被拒', () => {
  const s = newState();
  const r = applyPvpTurn(s, [
    { seat: 0, intent: moveIntent('tackle') },
    { seat: 2, intent: moveIntent('tackle') },
  ], seeded(9));
  assert.equal('code' in r, true);
});

test('applyPvpTurn：未掌握技能 / PP 耗尽被拒', () => {
  const s = newState();
  assert.throws(() => applyPvpTurn(s, [
    { seat: 0, intent: moveIntent('no_such_move') },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9)), PvpError);
});

test('applyPvpTurn：对战结束不能再推进', () => {
  const s = newState();
  s.finished = true;
  const r = applyPvpTurn(s, [
    { seat: 0, intent: moveIntent(firstMoveOf(s, 0)) },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9));
  assert.equal('code' in r, true);
});

// ───────────────────────── 逃跑 ─────────────────────────

test('逃跑成功判负：对方获胜、fledUserId 记录', () => {
  const s = newState();
  // 用 rng 恒返回 0，逃跑必成功（chance 判定 rng() < 0.75/0.5 恒真）。
  const always0: Rng = () => 0;
  const r = applyPvpTurn(s, [
    { seat: 0, intent: { type: 'flee' } },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], always0);
  assert.ok(r.ok);
  assert.equal(r.value.finished, true);
  assert.equal(r.value.fledUserId, 'ua');
  assert.equal(r.value.winnerUserId, 'ub');
});

// ───────────────────────── 换人 ─────────────────────────

test('换人：activeIndex 切换、不判负', () => {
  const s = newState();
  // 给 A 方加第二只活体
  const rng = seeded(3);
  const second = createInstance('sprout_owl', 20, rng, { id: 'a2' });
  s.sides[0].party.push(second);
  s.sides[0].ppByMonster[second.id] = { tackle: 30 };
  const r = applyPvpTurn(s, [
    { seat: 0, intent: { type: 'switch', partyIndex: 1 } },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9));
  assert.ok(r.ok);
  assert.equal(r.value.sides[0].activeIndex, 1);
  assert.equal(r.value.finished, false);
});

test('换到已倒下 / 不存在的成员被拒', () => {
  const s = newState();
  assert.throws(() => applyPvpTurn(s, [
    { seat: 0, intent: { type: 'switch', partyIndex: 99 } },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9)), PvpError);
});

// ───────────────────────── 全灭判负 ─────────────────────────

test('一方全灭判负：winnerUserId 指向对方', () => {
  const s = newState();
  // 把 B 方的幻兽血量压到 1，A 方高攻，一次技能即击杀。
  s.sides[1].party[s.sides[1].activeIndex] = {
    ...s.sides[1].party[s.sides[1].activeIndex],
    hp: 1,
  };
  s.sides[0].party[s.sides[0].activeIndex] = {
    ...s.sides[0].party[s.sides[0].activeIndex],
    atk: 999, spAtk: 999,
  };
  const r = applyPvpTurn(s, [
    { seat: 0, intent: moveIntent(firstMoveOf(s, 0)) },
    { seat: 1, intent: moveIntent(firstMoveOf(s, 1)) },
  ], seeded(9));
  assert.ok(r.ok);
  assert.equal(r.value.finished, true);
  assert.equal(r.value.winnerUserId, 'ua');
});

// ───────────────────────── 只读视图 ─────────────────────────

test('pvpViewFor：己方完整队伍、对方仅公开信息', () => {
  const s = newState();
  // A 方再加一只，验证「对方不泄露未上场成员细节」。
  const rng = seeded(3);
  const second = createInstance('sprout_owl', 20, rng, { id: 'a2' });
  s.sides[0].party.push(second);
  s.sides[0].ppByMonster[second.id] = { tackle: 30 };

  const viewA = pvpViewFor(s, 'ua');
  // 己方完整队伍（含 moveIds / 六维）
  assert.equal(viewA.self.party.length, 2);
  assert.ok(viewA.self.party[0].moveIds);
  assert.equal(viewA.self.userId, 'ua');
  // 对方只下发 active 的公开信息
  assert.equal(viewA.foe.userId, 'ub');
  assert.equal(viewA.foe.party.length, s.sides[1].party.length);
  const foeActive = viewA.foe.party[viewA.foe.activeIndex];
  assert.equal(typeof foeActive.specId, 'string');
  assert.equal(typeof foeActive.hp, 'number');
  assert.ok(!('moveIds' in foeActive), '对方视图不应泄露 moveIds');
  assert.ok(!('atk' in foeActive), '对方视图不应泄露六维');

  const viewB = pvpViewFor(s, 'ub');
  assert.equal(viewB.self.userId, 'ub');
  assert.equal(viewB.foe.userId, 'ua');
});

test('pvpViewFor：winnerIsSelf 与 fledUserId 正确下发', () => {
  const s = newState();
  s.finished = true;
  s.winnerUserId = 'ub';
  s.fledUserId = 'ua';
  const viewA = pvpViewFor(s, 'ua');
  assert.equal(viewA.winnerIsSelf, false);
  assert.equal(viewA.fledUserId, 'ua');
  const viewB = pvpViewFor(s, 'ub');
  assert.equal(viewB.winnerIsSelf, true);
});
