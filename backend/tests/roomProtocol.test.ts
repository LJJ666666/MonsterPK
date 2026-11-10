import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseClientMessage, encodeServerMessage, WS_CAPABILITIES,
} from '../src/lib/wsProtocol';

/** P4-2b 协议层：上行白名单、字段裁剪、伪造 room.state 拒绝。 */

test('hello.capabilities 声明房间能力', () => {
  for (const cap of ['room.state', 'room.action', 'room.resync']) {
    assert.ok(WS_CAPABILITIES.includes(cap), `缺少 ${cap}`);
  }
});

test('room.action 合法意图被解析，多余字段（含伪状态）一律丢弃', () => {
  const r = parseClientMessage(JSON.stringify({
    type: 'room.action', roomId: 'r1', action: 'intent',
    intent: 'move_1', nonce: 'n1',
    status: 'settled', revision: 999, quota: { state: 'committed' }, turn: 99,
  }));
  assert.equal('message' in r, true);
  if (!('message' in r)) return;
  assert.deepEqual(r.message, {
    type: 'room.action', roomId: 'r1', action: 'intent', intent: 'move_1', nonce: 'n1',
  });
});

test('room.action 托管开关解析 targetSeat，不带 intent', () => {
  const r = parseClientMessage(JSON.stringify({
    type: 'room.action', roomId: 'r1', action: 'autopilot_on', targetSeat: 0, nonce: 'n2',
  }));
  assert.equal('message' in r, true);
  if (!('message' in r)) return;
  assert.equal(r.message.type, 'room.action');
  assert.equal(JSON.stringify(r.message).includes('move_1'), false);
  assert.equal((r.message as any).targetSeat, 0);
});

test('room.resync 只保留 roomId，携带的状态字段被忽略', () => {
  const r = parseClientMessage(JSON.stringify({
    type: 'room.resync', roomId: 'r1', data: 'fake-save', revision: 999,
  }));
  assert.equal('message' in r, true);
  if (!('message' in r)) return;
  assert.deepEqual(r.message, { type: 'room.resync', roomId: 'r1' });
  const bare = parseClientMessage(JSON.stringify({ type: 'room.resync' }));
  assert.equal('message' in bare, true);
  if ('message' in bare) assert.deepEqual(bare.message, { type: 'room.resync' });
});

test('伪造 room.state 上行 → UNKNOWN_TYPE（调用方据此关 1008）', () => {
  const r = parseClientMessage(JSON.stringify({
    type: 'room.state', room: { roomId: 'r1', status: 'settled', revision: 999 },
  }));
  assert.equal('code' in r, true);
  if ('code' in r) assert.equal(r.code, 'UNKNOWN_TYPE');
});

test('房间意图的形状校验：缺 nonce / 坏 action / 坏 roomId / 缺意图 / 缺座位', () => {
  const base = { type: 'room.action', roomId: 'r1', action: 'intent', intent: 'move_1', nonce: 'n1' };
  const bad = [
    { ...base, nonce: undefined },
    { ...base, action: 'settle' },
    { ...base, roomId: '../admin' },
    { ...base, intent: undefined },
    { ...base, nonce: 'bad nonce!' },
    { type: 'room.action', roomId: 'r1', action: 'autopilot_on', nonce: 'n1' },
  ];
  for (const payload of bad) {
    const r = parseClientMessage(JSON.stringify(payload));
    assert.equal('code' in r, true, `应拒绝 ${JSON.stringify(payload)}`);
    if ('code' in r) assert.equal(r.code, 'BAD_SHAPE');
  }
});

test('既有 ping / session.resync 不受房间协议影响', () => {
  const ping = parseClientMessage(JSON.stringify({ type: 'ping', ts: 1 }));
  assert.equal('message' in ping, true);
  const resync = parseClientMessage(JSON.stringify({ type: 'session.resync', foo: 2 }));
  assert.equal('message' in resync, true);
  if ('message' in resync) assert.deepEqual(resync.message, { type: 'session.resync' });
});

test('room.state 下行能编码为完整全量快照', () => {
  const encoded = encodeServerMessage({
    type: 'room.state',
    room: {
      roomId: 'r1', mode: 'kernel', status: 'active', revision: 3, turn: 2,
      deadlineAt: 10_000,
      seats: [{ seat: 0, label: '座位 1', online: true, autopilot: false, submitted: false, self: true }],
      lastAction: { seat: 0, intent: 'move_1', kind: 'timeout' },
      quota: { key: 'boss:daily', state: 'held' },
      endReason: null, updatedAt: 1_000,
    },
  });
  const parsed = JSON.parse(encoded);
  assert.equal(parsed.type, 'room.state');
  assert.equal(parsed.room.revision, 3);
  assert.equal(parsed.room.lastAction.kind, 'timeout');
});
