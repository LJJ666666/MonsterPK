/**
 * §88 P1 / P3 的确定性回归（无 IO，纯内存假存储）。
 *
 * P1（配额重复计数）：`finishQuota` 原来在 `retryCas` 的重试块**里面**执行 ——
 *   CAS 冲突 → 整段重跑 → `settleQuota` 再扣一次。修法是把计数拆成
 *   `markQuota`（只改内存态，随 room 走 CAS）+ `applyQuota`（bump 成功后落计数）。
 *   本用例让 `set()` 第一次返回 false 制造 CAS 冲突，断言「commit 只发生一次」。
 *
 * P3（被拒不烧 nonce）：`submitIntent` 原来先判 `TURN_ALREADY_SUBMITTED` 再 push nonce，
 *   而且 `loadAndMutate` 只在 `res.ok` 时落库 —— 于是被判重的那条 nonce 下回合重放
 *   会被当成合法首提。修法：先烧 nonce + `persistEvenIfFailed` 落库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, type RoomStorage } from '../src/lib/roomRegistry';
import type { RoomState } from '../src/lib/roomTypes';
import { sequenceIds } from './lib/deterministic';

const OWNER = { userId: 'u1', tokenDigest: 'digest', connectionId: 'c1' };
const GUEST = { userId: 'u2', tokenDigest: 'digest2', connectionId: 'c2' };
const NOW = Date.UTC(2026, 10, 16, 8, 0, 0);

type SettleCall = { key: string; commit: boolean; limit: number };

/** 可注入 CAS 冲突、并记录 settleQuota 调用的内存存储。 */
class FakeStorage implements RoomStorage {
  private readonly rooms = new Map<string, RoomState>();
  /** 接下来的 N 次 set() 直接返回 false（模拟 revision CAS 冲突）。 */
  failSetTimes = 0;
  readonly settleCalls: SettleCall[] = [];

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
    if (this.failSetTimes > 0) {
      this.failSetTimes -= 1;
      return false; // CAS 冲突：不落库
    }
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
  async getQuota(): Promise<{ held: number; committed: number }> { return { held: 1, committed: 0 }; }
  async tryHoldQuota(): Promise<boolean> { return true; }
  async settleQuota(key: string, commit: boolean, limit: number): Promise<boolean> {
    this.settleCalls.push({ key, commit, limit });
    return true;
  }
  async dailyCommitted(): Promise<number> { return 0; }
  async quotaKeys(): Promise<string[]> { return []; }
  /** §92 B：nonce 唯一表内存版（键 `${seat}:${nonce}`），行为与 InMemoryRoomStorage 一致。 */
  private readonly nonces = new Map<string, Set<string>>();
  async registerNonce(roomId: string, seat: number, nonce: string): Promise<boolean> {
    let set = this.nonces.get(roomId);
    if (!set) { set = new Set(); this.nonces.set(roomId, set); }
    const key = `${seat}:${nonce}`;
    if (set.has(key)) return false;
    set.add(key);
    return true;
  }
  async hasNonce(roomId: string, seat: number, nonce: string): Promise<boolean> {
    return this.nonces.get(roomId)?.has(`${seat}:${nonce}`) ?? false;
  }
}

test('P1：CAS 冲突重跑不会把 quota 计数加两次（commit 只发生一次）', async () => {
  const storage = new FakeStorage();
  const ids = sequenceIds('p1');
  const reg = new RoomRegistry({ storage, idFactory: ids });
  const roomId = ids();
  // 建房时就占一个 hold（quotaKey 传了 → room.quota.state = 'held'）。
  const created = await reg.create({
    roomId, mode: 'kernel', owner: OWNER, quotaKey: 'p1_q', quotaLimit: 3, now: NOW,
  });
  assert.equal(created.ok, true, '建房应成功');

  // 第一次 bump 制造 CAS 冲突：旧实现会在冲突前就把 settleQuota 执行一次，
  // 重跑后又执行一次 → 计数翻倍。
  storage.failSetTimes = 1;
  const res = await reg.settle(roomId, NOW + 1_000);
  assert.equal(res.ok, true, '重试后应结算成功');

  const commits = storage.settleCalls.filter((c) => c.commit);
  assert.equal(commits.length, 1, `commit 必须恰好一次，实际 ${commits.length} 次：${JSON.stringify(storage.settleCalls)}`);
  assert.equal(commits[0].key, 'p1_q');

  const room = await storage.get(roomId);
  assert.equal(room?.status, 'settled');
  assert.equal(room?.quota?.state, 'committed', 'quota 状态必须随房间一起落库');
});

test('P1：放弃房间（release）同样只扣一次', async () => {
  const storage = new FakeStorage();
  const ids = sequenceIds('p1b');
  const reg = new RoomRegistry({ storage, idFactory: ids });
  const roomId = ids();
  await reg.create({ roomId, mode: 'kernel', owner: OWNER, quotaKey: 'p1b_q', quotaLimit: 3, now: NOW });

  storage.failSetTimes = 1;
  const res = await reg.abandon(roomId, NOW + 1_000, 'manual');
  assert.equal(res.ok, true);

  const releases = storage.settleCalls.filter((c) => !c.commit);
  assert.equal(releases.length, 1, `release 必须恰好一次，实际 ${releases.length} 次`);
  const room = await storage.get(roomId);
  assert.equal(room?.status, 'abandoned');
  assert.equal(room?.quota?.state, 'released');
});

test('P3：被判 TURN_ALREADY_SUBMITTED 的 nonce 也必须落库（否则下回合重放会被接受）', async () => {
  const storage = new FakeStorage();
  const ids = sequenceIds('p3');
  const reg = new RoomRegistry({ storage, idFactory: ids });
  const roomId = ids();
  await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW });
  const joined = await reg.join({ roomId, member: GUEST, now: NOW + 10 });
  assert.equal(joined.ok, true, '第二位加入后应开局');

  const first = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'n_first', now: NOW + 20,
  });
  assert.equal(first.ok, true, '同回合首次提交应成功');

  const dup = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'n_late', now: NOW + 30,
  });
  assert.equal(dup.ok, false);
  assert.equal(!dup.ok && dup.code, 'TURN_ALREADY_SUBMITTED');

  // §92 B：nonce 真值迁 RoomNonceSeen 唯一表（房间+座位作用域），不再住房间 JSON。
  assert.ok(await storage.hasNonce(roomId, 0, 'n_late'),
    '被拒的 nonce 必须已落库（房间+座位作用域唯一表）');

  // 下回合重放同一个 nonce：必须判重放，而不是当成新回合的合法首提。
  const guestTurn = await reg.submitIntent({
    roomId, actorUserId: GUEST.userId, intent: 'move_1', nonce: 'n_guest', now: NOW + 40,
  });
  assert.equal(guestTurn.ok, true, '全员交齐应推进回合');
  const replay = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: 'n_late', now: NOW + 50,
  });
  assert.equal(replay.ok, false);
  assert.equal(!replay.ok && replay.code, 'INTENT_REPLAY', '跨回合重放必须判重放');
});
