/**
 * P4（nonce 绑定座位）的确定性红测（无 IO，纯内存假存储）。
 *
 * 现状：`seenNonces` 是**全房间共用**的一维数组，座位 A 用过的 nonce
 * 会让座位 B 被判 INTENT_REPLAY。这是语义错误，不是概率问题。
 *
 * 本文件在**不改产品代码**的前提下先落盘：旧实现必须「P4-1 红、P4-2/P4-3 绿」。
 * 修法见 `.trae/documents/p4_nonce绑座位_设计与红测方案_2026-11-16.md`（方案 B）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, type RoomStorage } from '../src/lib/roomRegistry';
import type { RoomState } from '../src/lib/roomTypes';
import { sequenceIds } from './lib/deterministic';

const OWNER = { userId: 'u1', tokenDigest: 'd1', connectionId: 'c1' };
const GUEST = { userId: 'u2', tokenDigest: 'd2', connectionId: 'c2' };
const NOW = Date.UTC(2026, 10, 16, 9, 0, 0);

class FakeStorage implements RoomStorage {
  private readonly rooms = new Map<string, RoomState>();
  async get(roomId: string): Promise<RoomState | undefined> {
    const r = this.rooms.get(roomId);
    return r ? (JSON.parse(JSON.stringify(r)) as RoomState) : undefined;
  }
  async create(room: RoomState): Promise<boolean> {
    if (this.rooms.has(room.roomId)) return false;
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)) as RoomState);
    return true;
  }
  async set(room: RoomState): Promise<boolean> {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)) as RoomState);
    return true;
  }
  async writeBack(room: RoomState): Promise<boolean> {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)) as RoomState);
    return true;
  }
  async delete(roomId: string): Promise<void> { this.rooms.delete(roomId); }
  async all(): Promise<RoomState[]> {
    return Array.from(this.rooms.values()).map((r) => JSON.parse(JSON.stringify(r)) as RoomState);
  }
  async getQuota(): Promise<{ held: number; committed: number }> { return { held: 0, committed: 0 }; }
  async tryHoldQuota(): Promise<boolean> { return true; }
  async settleQuota(): Promise<boolean> { return true; }
  async dailyCommitted(): Promise<number> { return 0; }
  async quotaKeys(): Promise<string[]> { return []; }
}

function makeRoom(prefix: string) {
  const storage = new FakeStorage();
  const ids = sequenceIds(prefix);
  const reg = new RoomRegistry({ storage, idFactory: ids });
  return { storage, reg, roomId: ids() };
}

test('P4-1：不同座位用同一个 nonce 同回合提交，两路都应成功（旧实现必红）', async () => {
  const { reg, roomId } = makeRoom('p4same');
  assert.equal((await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW })).ok, true);
  assert.equal((await reg.join({ roomId, member: GUEST, now: NOW + 10 })).ok, true);

  const a = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'shared', now: NOW + 20,
  });
  const b = await reg.submitIntent({
    roomId, actorUserId: GUEST.userId, intent: 'move_1', nonce: 'shared', now: NOW + 30,
  });

  assert.equal(a.ok, true, `座位 0 首次提交应成功：${JSON.stringify(a)}`);
  assert.equal(b.ok, true,
    `座位 1 用相同 nonce 是它自己的首次提交，必须成功；实际 ${JSON.stringify(b)}`);
  assert.equal(b.ok && b.value.advanced, true, '两座交齐应推进回合');
});

test('P4-2：同座位同 nonce 重放仍判 INTENT_REPLAY（不得放宽）', async () => {
  const { reg, roomId } = makeRoom('p4replay');
  assert.equal((await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW })).ok, true);
  assert.equal((await reg.join({ roomId, member: GUEST, now: NOW + 10 })).ok, true);

  const first = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'mine', now: NOW + 20,
  });
  assert.equal(first.ok, true);
  const again = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'mine', now: NOW + 30,
  });
  assert.equal(again.ok, false);
  assert.equal(!again.ok && again.code, 'INTENT_REPLAY');
});

test('P4-3：被拒的 nonce 烧在本座位，下回合同座位重放仍 409（P3 不回退）', async () => {
  const { reg, roomId } = makeRoom('p4p3');
  assert.equal((await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW })).ok, true);
  assert.equal((await reg.join({ roomId, member: GUEST, now: NOW + 10 })).ok, true);

  const first = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'n1', now: NOW + 20,
  });
  assert.equal(first.ok, true);
  const late = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'late', now: NOW + 30,
  });
  assert.equal(!late.ok && late.code, 'TURN_ALREADY_SUBMITTED');

  const guestTurn = await reg.submitIntent({
    roomId, actorUserId: GUEST.userId, intent: 'move_1', nonce: 'g1', now: NOW + 40,
  });
  assert.equal(guestTurn.ok, true, '全员交齐推进回合');

  const replay = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'late', now: NOW + 50,
  });
  assert.equal(!replay.ok && replay.code, 'INTENT_REPLAY', '同座位跨回合重放必须判重放');
});
