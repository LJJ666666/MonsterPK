import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RoomRegistry, InMemoryRoomStorage, type RoomStorage,
} from '../src/lib/roomRegistry';
import {
  RandomAutopilotPolicy, type RoomConfig, type Rng,
} from '../src/lib/roomTypes';

/** 假时钟：所有阈值都是纯数字，单测一次跳 60 秒不需要真等。 */
const CFG: RoomConfig = {
  roundTimeoutMs: 1_000,
  autopilotOfferMs: 1_500,
  allOfflineGraceMs: 3_000,
  ttlMs: 10_000,
  maxSeats: 2,
};
const rng: Rng = () => 0;

function make(opts: { storage?: RoomStorage; policy?: RandomAutopilotPolicy } = {}) {
  let seq = 0;
  return new RoomRegistry({
    storage: opts.storage ?? new InMemoryRoomStorage(),
    configFor: () => CFG,
    policy: opts.policy ?? new RandomAutopilotPolicy(['move_1', 'move_2', 'move_3']),
    idFactory: () => `room_${++seq}`,
  });
}

const A = { userId: 'u_a', tokenDigest: 'digest_a', connectionId: 'conn_a' };
const B = { userId: 'u_b', tokenDigest: 'digest_b', connectionId: 'conn_b' };

async function twoPlayers(reg: RoomRegistry, now = 1_000, quotaKey = 'boss:daily') {
  const c = (await reg.create({ mode: 'kernel', owner: A, quotaKey, quotaLimit: 1, now, roomId: 'r1' }));
  assert.equal('value' in c, true, 'create 应成功');
  const j = (await reg.join({ roomId: 'r1', member: B, now }));
  assert.equal('value' in j, true, 'join 应成功');
  const room = (await reg.get('r1'))!;
  return room;
}

test('create → join：状态机 forming→active，revision 单调递增', async () => {
  const reg = make();
  const c = (await reg.create({ mode: 'kernel', owner: A, now: 100, roomId: 'r1' }));
  assert.equal('value' in c, true);
  assert.equal((await reg.get('r1'))!.status, 'forming');
  assert.equal((await reg.get('r1'))!.deadlineAt, 0, 'forming 不该有回合超时');
  const j = (await reg.join({ roomId: 'r1', member: B, now: 200 }));
  assert.equal('value' in j, true);
  const room = (await reg.get('r1'))!;
  assert.equal(room.status, 'active');
  assert.equal(room.deadlineAt, 200 + CFG.roundTimeoutMs);
  assert.deepEqual(room.seats.map((s) => s.seat), [0, 1]);
  assert.ok(room.revision >= 2);
});

test('create 拒绝：重复房间 / 非法成员 / 非法次数键', async () => {
  const reg = make();
  (await reg.create({ mode: 'kernel', owner: A, now: 1, roomId: 'r1' }));
  const dup = (await reg.create({ mode: 'kernel', owner: A, now: 2, roomId: 'r1' }));
  assert.equal('code' in dup && dup.code, 'ROOM_EXISTS');
  const bad = (await reg.create({ mode: 'kernel', owner: { ...A, tokenDigest: '' }, now: 2 }));
  assert.equal('code' in bad && bad.code, 'ROOM_BAD_MEMBER');
  const badKey = (await reg.create({ mode: 'kernel', owner: A, quotaKey: 'bad key!', now: 2 }));
  assert.equal('code' in badKey && badKey.code, 'ROOM_BAD_QUOTA_KEY');
});

test('join 拒绝：满员 / 重复成员 / 已开局 / 房间不存在', async () => {
  const reg = make();
  (await twoPlayers(reg));
  const full = (await reg.join({ roomId: 'r1', member: { ...B, userId: 'u_c' }, now: 1_100 }));
  assert.equal('code' in full && full.code, 'ROOM_CLOSED');
  const reg2 = make();
  (await reg2.create({ mode: 'kernel', owner: A, now: 1, roomId: 'r1' }));
  const dup = (await reg2.join({ roomId: 'r1', member: { ...B, userId: 'u_a' }, now: 2 }));
  assert.equal('code' in dup && dup.code, 'ROOM_DUPLICATE_MEMBER');
  const none = (await reg2.join({ roomId: 'missing', member: B, now: 2 }));
  assert.equal('code' in none && none.code, 'ROOM_NOT_FOUND');
});

test('quota 三段式：hold 不消耗、commit 扣一次、release 不扣', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000, 'quota_commit'));
  assert.deepEqual((await reg.quotaUsage('quota_commit')), { held: 1, committed: 0 });
  const s = (await reg.settle('r1', 1_100));
  assert.equal('value' in s, true);
  assert.deepEqual((await reg.quotaUsage('quota_commit')), { held: 0, committed: 1 });
  // 幂等：重复 settle / 再 abandon 都不能倒扣
  (await reg.settle('r1', 1_200));
  (await reg.abandon('r1', 1_300, 'late'));
  assert.deepEqual((await reg.quotaUsage('quota_commit')), { held: 0, committed: 1 });

  const reg2 = make();
  (await twoPlayers(reg2, 1_000, 'quota_release'));
  (await reg2.abandon('r1', 1_100, 'manual'));
  assert.deepEqual((await reg2.quotaUsage('quota_release')), { held: 0, committed: 0 });
  assert.equal((await reg2.get('r1'))!.quota!.state, 'released');
});

test('quota 余量耗尽：第二个房间被拒，且不留脏 hold', async () => {
  const reg = make();
  (await reg.create({ mode: 'kernel', owner: A, quotaKey: 'q', quotaLimit: 1, now: 1, roomId: 'r1' }));
  const second = (await reg.create({ mode: 'kernel', owner: B, quotaKey: 'q', quotaLimit: 1, now: 2, roomId: 'r2' }));
  assert.equal('code' in second && second.code, 'ROOM_QUOTA_EXHAUSTED');
  assert.deepEqual((await reg.quotaUsage('q')), { held: 1, committed: 0 });
  assert.equal((await reg.get('r2')), undefined);
});

test('掉线保留座位与回合态；重连恢复、状态回 active、超时清零、托管撤销', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  const revBefore = (await reg.get('r1'))!.revision;
  const changed = (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  assert.deepEqual(changed, ['r1']);
  const room = (await reg.get('r1'))!;
  assert.equal(room.status, 'paused');
  assert.equal(room.seats[0].online, false);
  assert.equal(room.seats[0].connectionId, null);
  assert.equal(room.seats.length, 2, '座位必须保留');
  assert.equal(room.turn, 1, '回合态必须保留');
  assert.equal(room.allOfflineSince, null, '还有人在线，不启动全掉计时');
  assert.ok(room.revision > revBefore);

  (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: true, now: 4_000 }));
  assert.equal((await reg.get('r1'))!.seats[0].autopilot, true);
  const back = (await reg.reconnect('u_a', 'digest_a', 'conn_a2', 4_100));
  assert.deepEqual(back, ['r1']);
  const after = (await reg.get('r1'))!;
  assert.equal(after.status, 'active');
  assert.equal(after.seats[0].online, true);
  assert.equal(after.seats[0].autopilot, false);
  assert.equal(after.allOfflineSince, null);
  assert.equal(after.deadlineAt, 4_100 + CFG.roundTimeoutMs, '重连后超时计时清零');
});

test('换设备登录不算重连：tokenDigest 不同 → 座位不恢复、不转移', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  const changed = (await reg.reconnect('u_a', 'digest_from_new_device', 'conn_new', 1_200));
  assert.deepEqual(changed, []);
  const seat = (await reg.get('r1'))!.seats[0];
  assert.equal(seat.online, false);
  assert.equal(seat.connectionId, null);
});

test('旧连接 close 不能把新连接标掉线（connectionId 精确匹配）', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  (await reg.reconnect('u_a', 'digest_a', 'conn_a2', 1_200));
  const late = (await reg.markDisconnected('u_a', 'conn_a', 1_300));
  assert.deepEqual(late, [], '旧连接迟到的 close 不该命中');
  assert.equal((await reg.get('r1'))!.seats[0].online, true);
  assert.equal((await reg.get('r1'))!.seats[0].connectionId, 'conn_a2');
});

test('托管：太早拒绝 / 不能给自己 / 不能给在线成员 / 超窗后允许', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  const early = (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: true, now: 1_200 }));
  assert.equal('code' in early && early.code, 'AUTOPILOT_TOO_EARLY');
  const self = (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 1, enabled: true, now: 3_000 }));
  assert.equal('code' in self && self.code, 'AUTOPILOT_SELF');
  const onlineReg = make();
  (await twoPlayers(onlineReg, 1_000));
  const online = (await onlineReg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: true, now: 1_100 }));
  assert.equal('code' in online && online.code, 'AUTOPILOT_TARGET_ONLINE');
  const late = (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: true, now: 2_700 }));
  assert.equal('value' in late, true);
  assert.equal((await reg.get('r1'))!.seats[0].autopilot, true);
  const off = (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: false, now: 2_800 }));
  assert.equal('value' in off, true);
  assert.equal((await reg.get('r1'))!.seats[0].autopilot, false);
});

test('全员提交立即推进回合；nonce 重放与重复提交被拒', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  const a = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'move_1', nonce: 'n1', now: 1_100 }));
  assert.equal('value' in a, true);
  assert.equal('value' in a && a.value.advanced, false);
  const replay = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'move_2', nonce: 'n1', now: 1_150 }));
  assert.equal('code' in replay && replay.code, 'INTENT_REPLAY');
  const twice = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'move_2', nonce: 'n2', now: 1_150 }));
  assert.equal('code' in twice && twice.code, 'TURN_ALREADY_SUBMITTED');
  const b = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'move_3', nonce: 'n3', now: 1_200 }));
  assert.equal('value' in b && b.value.advanced, true);
  const room = (await reg.get('r1'))!;
  assert.equal(room.turn, 2);
  assert.deepEqual(room.submitted, []);
  assert.equal(room.deadlineAt, 1_200 + CFG.roundTimeoutMs);
});

test('回合超时：服务端注入 RNG 代放未提交座位并推进（确定性）', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  const report = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 1_000 + CFG.roundTimeoutMs, rng, report));
  assert.equal(report.timedOut, 2, '两个座位都被代放');
  assert.equal((await reg.get('r1'))!.turn, 2);
  assert.equal((await reg.get('r1'))!.lastAction!.kind, 'timeout');
  assert.equal((await reg.get('r1'))!.lastAction!.intent, 'move_1', 'RNG=0 恒定选第一个');
  assert.deepEqual(report.changedRoomIds, ['r1']);
});

test('托管座位在 tick 时提前代放，不拖到回合超时', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  // 第一回合先自然超时（生产档 OFFER 30s > ROUND 20s，托管是为后续回合准备的）。
  const first = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 2_000, rng, first));
  assert.equal((await reg.get('r1'))!.turn, 2);
  assert.equal((await reg.get('r1'))!.deadlineAt, 3_000);
  (await reg.offerAutopilot({ roomId: 'r1', actorUserId: 'u_b', targetSeat: 0, enabled: true, now: 2_700 }));
  const report = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 2_800, rng, report));
  assert.equal(report.autopiloted, 1);
  assert.equal(report.timedOut, 0, '还没到 deadline，不该触发随机代放');
  assert.ok((await reg.get('r1'))!.submitted.includes(0));
  assert.equal((await reg.get('r1'))!.turn, 2);
});

test('全员掉线超 grace → 解散、release 次数、不结算、不写伤害', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000, 'q_all_offline'));
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  assert.equal((await reg.get('r1'))!.allOfflineSince, null);
  (await reg.markDisconnected('u_b', 'conn_b', 1_200));
  assert.equal((await reg.get('r1'))!.allOfflineSince, 1_200);
  const report = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 1_200 + CFG.allOfflineGraceMs, rng, report));
  const room = (await reg.get('r1'))!;
  assert.equal(room.status, 'abandoned');
  assert.equal(room.endReason, 'all_offline');
  assert.equal(room.quota!.state, 'released');
  assert.deepEqual((await reg.quotaUsage('q_all_offline')), { held: 0, committed: 0 });
  assert.deepEqual(report.abandoned, ['r1']);
});

test('已解散房间过了 TTL 才删除，客户端仍能拉终态', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  (await reg.abandon('r1', 1_100, 'manual'));
  const report = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 1_100 + CFG.ttlMs - 1, rng, report));
  assert.ok((await reg.get('r1')), 'TTL 内保留终态');
  (await reg.tick('r1', 1_100 + CFG.ttlMs + 1, rng, report));
  assert.equal((await reg.get('r1')), undefined);
  assert.deepEqual(report.deleted, ['r1']);
});

test('forming 超时解散也 release 次数', async () => {
  const reg = make();
  (await reg.create({ mode: 'kernel', owner: A, quotaKey: 'q_form', quotaLimit: 1, now: 1_000, roomId: 'r1' }));
  const report = {
    changedRoomIds: [] as string[], timedOut: 0, autopiloted: 0,
    abandoned: [] as string[], deleted: [] as string[],
  };
  (await reg.tick('r1', 1_000 + CFG.ttlMs + 1, rng, report));
  assert.equal((await reg.get('r1'))!.status, 'abandoned');
  assert.equal((await reg.get('r1'))!.endReason, 'forming_timeout');
  assert.deepEqual((await reg.quotaUsage('q_form')), { held: 0, committed: 0 });
});

test('view 不泄露 tokenDigest / connectionId / 他人 userId，self 按接收者计算', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  const va = reg.view((await reg.get('r1'))!, 'u_a');
  const vb = reg.view((await reg.get('r1'))!, 'u_b');
  const raw = JSON.stringify(va);
  assert.ok(!raw.includes('digest_a') && !raw.includes('digest_b'));
  assert.ok(!raw.includes('conn_a') && !raw.includes('conn_b'));
  assert.ok(!raw.includes('u_a') && !raw.includes('u_b'));
  assert.equal(va.seats[0].self, true);
  assert.equal(va.seats[1].self, false);
  assert.equal(vb.seats[0].self, false);
  assert.equal(vb.seats[1].self, true);
});

test('越权：非成员提交意图 / 掉线成员提交 / 已结束房间操作', async () => {
  const reg = make();
  (await twoPlayers(reg, 1_000));
  const outsider = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_x', intent: 'move_1', nonce: 'x1', now: 1_100 }));
  assert.equal('code' in outsider && outsider.code, 'ROOM_FORBIDDEN');
  (await reg.markDisconnected('u_a', 'conn_a', 1_100));
  const offline = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_a', intent: 'move_1', nonce: 'x2', now: 1_200 }));
  assert.equal('code' in offline && offline.code, 'ROOM_SEAT_OFFLINE');
  (await reg.settle('r1', 1_300));
  const closed = (await reg.submitIntent({ roomId: 'r1', actorUserId: 'u_b', intent: 'move_1', nonce: 'x3', now: 1_400 }));
  assert.equal('code' in closed && closed.code, 'ROOM_CLOSED');
});

test('sweep 汇总所有房间的变化并广播一次（revision 不重复抬）', async () => {
  const reg = make();
  (await reg.create({ mode: 'kernel', owner: A, now: 1_000, roomId: 'r1' }));
  (await reg.join({ roomId: 'r1', member: B, now: 1_000 }));
  (await reg.create({ mode: 'kernel', owner: { ...A, userId: 'u_c', connectionId: 'conn_c' }, now: 1_000, roomId: 'r2' }));
  (await reg.join({ roomId: 'r2', member: { ...B, userId: 'u_d', connectionId: 'conn_d' }, now: 1_000 }));
  const before = (await reg.get('r1'))!.revision;
  const report = (await reg.sweep(1_000 + CFG.roundTimeoutMs, rng));
  assert.equal(report.changedRoomIds.length, 2);
  assert.equal(report.timedOut, 4);
  assert.equal((await reg.get('r1'))!.revision, before + 1, '一次 tick 只抬一次 revision');
});

test('view()：按接收者裁剪，seat 不泄露 tokenDigest / connectionId', async () => {
  const reg = make();
  const room = await twoPlayers(reg);
  const viewA = reg.view(room, 'u_a');
  assert.ok(viewA.seats.find((s) => s.self), '应有 self 席');
  const raw = JSON.stringify(viewA);
  assert.ok(!/digest_a/.test(raw), '不能泄露自身 tokenDigest');
  assert.ok(!/conn_a/.test(raw), '不能泄露自身 connectionId');
  assert.ok(!/digest_b/.test(raw), '不能泄露他人 tokenDigest');
  assert.ok(!/conn_b/.test(raw), '不能泄露他人 connectionId');
});
