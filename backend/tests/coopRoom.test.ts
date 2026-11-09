/**
 * F16：房间内核对六房副本意图的路由与代放单测（零 IO）。
 *
 * 验证规范 §30.5「房间内核零大改」：保留「全员交齐 / 超时 → 一次 advanceTurn」模型，
 * enter:/idle 走既有 `room.action` 字符串通道，一次推进内所有 fighting 房间都被结算；
 * 超时代放按座位所在房间生成合法意图（大厅 → enter:<i>），不炸房间推进。
 * 伪上报 / flee 的 400 由 REST+WS 层 `modules/room.ts` 覆盖（e2e_f16）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, InMemoryRoomStorage } from '../src/lib/roomRegistry';
import type { RoomConfig, Rng } from '../src/lib/roomTypes';
import { createCoopState, parseCoopIntent, COOP_ROOM_COUNT } from '../src/game/coop';
import { getBoss } from '../src/game/boss';
import { createInstance } from '../src/game/rules';

const CFG: RoomConfig = {
  roundTimeoutMs: 1_000,
  autopilotOfferMs: 1_500,
  allOfflineGraceMs: 3_000,
  ttlMs: 10_000,
  maxSeats: 2,
};

function seeded(seed: number): Rng {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

const A = { userId: 'u_a', tokenDigest: 'digest_a', connectionId: 'conn_a' };
const B = { userId: 'u_b', tokenDigest: 'digest_b', connectionId: 'conn_b' };

function makeCoop() {
  const reg = new RoomRegistry({
    storage: new InMemoryRoomStorage(),
    configFor: () => CFG,
    idFactory: () => 'r1',
  });
  const spec = getBoss('boss_ember_behemoth')!;
  const parties = [
    { userId: 'u_a', party: [createInstance('sprout_owl', 30, seeded(1), { id: 'a1' })] },
    { userId: 'u_b', party: [createInstance('spark_mouse', 30, seeded(2), { id: 'b1' })] },
  ];
  const state = createCoopState({ spec, parties, rng: seeded(9) });
  assert.ok(state.ok);
  assert.ok('value' in reg.create({ mode: 'coop', owner: A, now: 1_000, roomId: 'r1' }));
  assert.ok('value' in reg.join({ roomId: 'r1', member: B, now: 1_000 }));
  assert.ok('value' in reg.attachCoop('r1', state.value, 1_000));
  return reg;
}

function report() {
  return {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
}

test('F16 意图通道：enter / idle 走既有 room.action 字符串，flee 解析为 null', () => {
  assert.deepEqual(parseCoopIntent('enter:0'), { type: 'enter', roomIndex: 0 });
  assert.deepEqual(parseCoopIntent(`enter:${COOP_ROOM_COUNT - 1}`), { type: 'enter', roomIndex: 5 });
  assert.deepEqual(parseCoopIntent('idle'), { type: 'idle' });
  assert.equal(parseCoopIntent('flee'), null);
  assert.equal(parseCoopIntent('enter:6'), null);
});

test('F16 房间内核：全员交齐 enter 只推进一回合，一房只放 1 人', () => {
  const reg = makeCoop();
  const a = reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'enter:0', nonce: 'n1', now: 1_100 });
  assert.ok('value' in a && a.value.advanced === false);
  const b = reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'enter:0', nonce: 'n2', now: 1_200 });
  assert.ok('value' in b && b.value.advanced === true);
  const room = reg.get('r1')!;
  assert.equal(room.turn, 2);
  assert.equal(room.coop!.turn, 2);
  assert.equal(room.coop!.rooms[0].state, 'fighting');
  assert.equal(room.coop!.rooms[0].occupantSeat, 0, '座位号小者优先');
  assert.equal(room.coop!.seatRoom[1], -1, '另一个成员降级为 idle，仍在大厅');
  assert.equal(room.coop!.rooms[1].state, 'pending');
});

test('F16 房间内核：两人各进一间，一次推进内两间 fighting 房都结算', () => {
  const reg = makeCoop();
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'enter:0', nonce: 'n1', now: 1_100 });
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'enter:1', nonce: 'n2', now: 1_200 });
  const room = reg.get('r1')!;
  assert.equal(room.coop!.rooms[0].state, 'fighting');
  assert.equal(room.coop!.rooms[1].state, 'fighting');
  assert.equal(room.coop!.rooms[0].turn, 1);
  assert.equal(room.coop!.rooms[1].turn, 1);
  assert.equal(room.coop!.rooms[2].turn, 0);
  assert.equal(room.turn, 2, '一次 advanceTurn，不是两次');
});

test('F16 超时代放：大厅座位自动 enter，不生成随机占位意图、不炸推进', () => {
  const reg = makeCoop();
  const rep = report();
  reg.tick('r1', 1_000 + CFG.roundTimeoutMs, seeded(3), rep);
  assert.equal(rep.timedOut, 2, '两个座位都被代放');
  const room = reg.get('r1')!;
  assert.equal(room.turn, 2);
  assert.equal(room.coop!.rooms.filter((r) => r.state === 'fighting').length, 1);
  assert.equal(room.coop!.rooms[0].occupantSeat, 0);
  assert.ok(room.coop!.log.some((l) => l.includes('进入第')));
  assert.equal(room.lastAction!.kind, 'timeout');
});

test('F16 全员 idle：回合照常推进，不认领任何房间也不抛异常', () => {
  const reg = makeCoop();
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'idle', nonce: 'n1', now: 1_100 });
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'idle', nonce: 'n2', now: 1_200 });
  const room = reg.get('r1')!;
  assert.equal(room.turn, 2);
  assert.equal(room.coop!.finished, false);
  assert.ok(room.coop!.rooms.every((r) => r.state === 'pending'));
});

test('F16 视图：房间四态对全体可见，仍不泄露队友队伍与技能 PP', () => {
  const reg = makeCoop();
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'enter:0', nonce: 'n1', now: 1_100 });
  reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'enter:1', nonce: 'n2', now: 1_200 });
  const va = reg.view(reg.get('r1')!, 'u_a');
  assert.equal(va.coop!.rooms.length, COOP_ROOM_COUNT);
  assert.equal(va.coop!.total, COOP_ROOM_COUNT);
  assert.equal(va.coop!.rooms[0].state, 'fighting');
  assert.ok(va.coop!.self.party[0].moveIds);
  assert.equal('ppByMonster' in (va.coop!.members[1] as any), false);
  const raw = JSON.stringify(va);
  assert.ok(!raw.includes('digest_a') && !raw.includes('conn_a'));
});
