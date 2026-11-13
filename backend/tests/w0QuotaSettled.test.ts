/**
 * W0 两项可修小 bug 的确定性单测：
 *  ① `coopQuotaKey` 去掉 `slice(-8)` 后不再碰撞，且仍满足 64 字符白名单；
 *  ② `pvpSettled` 显式初始化 + 显式写回，在「get() 返回副本」的存储下也不丢。
 *
 * ② 用自定义 CopyStorage 模拟 W6 换共享存储后的序列化语义：这是设计定稿 §3.6
 * 点名的障碍，W0 先把修复钉住，避免到 W6 再回头查「为什么结算重复触发」。
 * W6.1 起 RoomStorage 接口全异步（PG 行版本 CAS），CopyStorage 同步改为 async 实现，
 * 断言口径与原版一致（零行为变更）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coopQuotaKey } from '../src/modules/coop';
import { RoomRegistry, type RoomStorage } from '../src/lib/roomRegistry';
import type { RoomState } from '../src/lib/roomTypes';
import { DeterministicClock, sequenceIds } from './lib/deterministic';

const OWNER = { userId: 'u1', tokenDigest: 'digest', connectionId: 'c1' };
const NOW = Date.UTC(2026, 10, 12, 4, 0, 0);

test('coopQuotaKey 用完整 userId：尾 8 字符相同的两个账号不再碰撞', () => {
  const a = 'aaaaaaaaaaaaaaaaa12345678';
  const b = 'bbbbbbbbbbbbbbbbb12345678';
  const ka = coopQuotaKey(a, NOW);
  const kb = coopQuotaKey(b, NOW);

  assert.notEqual(ka, kb, '旧 slice(-8) 实现会让这两账号共用同一个 quota key');
  assert.ok(ka.endsWith(a), '不应再截断 userId');
  assert.ok(ka.length <= 64, `整键 ${ka.length} 字符，旧注释称会超 64 是误判`);
  assert.match(ka, /^[A-Za-z0-9_:\-]+$/, '仍满足 roomRegistry.validQuotaKey 白名单');
});

test('coopQuotaKey 同账号同日稳定、跨日变化', () => {
  const uid = 'cuid0123456789012345678';
  assert.equal(coopQuotaKey(uid, NOW), coopQuotaKey(uid, NOW));
  assert.notEqual(coopQuotaKey(uid, NOW), coopQuotaKey(uid, NOW + 24 * 3600_000));
});

/** W6 的共享存储语义：每次 get() 都返回反序列化副本，直接改字段不会生效。 */
class CopyStorage implements RoomStorage {
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
  /** W6.1 新增原语：同 revision 写回（单线程内存版不会冲突）。 */
  async writeBack(room: RoomState): Promise<boolean> {
    this.rooms.set(room.roomId, JSON.parse(JSON.stringify(room)) as RoomState);
    return true;
  }
  async delete(roomId: string): Promise<void> { this.rooms.delete(roomId); }
  async all(): Promise<RoomState[]> {
    return Array.from(this.rooms.values()).map((r) => JSON.parse(JSON.stringify(r)) as RoomState);
  }
  async getQuota(): Promise<{ held: number; committed: number }> { return { held: 0, committed: 0 }; }
  async setQuota(): Promise<void> { /* 本用例不涉及 quota */ }
  async quotaKeys(): Promise<string[]> { return []; }
}

test('create 显式初始化两个结算标记为 false', async () => {
  const ids = sequenceIds('room');
  const clock = new DeterministicClock(1_700_000_000_000);
  const reg = new RoomRegistry({ idFactory: ids });
  const roomId = ids();
  await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: clock.now() });

  const room = await reg.get(roomId);
  assert.ok(room);
  assert.equal(room.pvpSettled, false, '旧实现这里是 undefined');
  assert.equal(room.coopSettled, false);
});

test('副本语义下：旧写法丢标记，setSettledFlag 写回不丢且不 bump revision', async () => {
  const reg = new RoomRegistry({ storage: new CopyStorage(), idFactory: sequenceIds('r') });
  const roomId = 'r-copy';
  await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW });

  const stale = await reg.get(roomId);
  assert.ok(stale);
  // 复现 W0 前的写法：直接改 rooms.get() 返回的对象。
  stale.pvpSettled = true;
  assert.equal((await reg.get(roomId))!.pvpSettled, false, '副本语义下旧写法确实丢失');

  await reg.setSettledFlag(roomId, 'pvp', true);
  assert.equal((await reg.get(roomId))!.pvpSettled, true, '显式写回后标记可见');
  assert.equal((await reg.get(roomId))!.revision, 1, '写回不得 bump revision（零行为变更）');

  await reg.setSettledFlag(roomId, 'pvp', false);
  await reg.setSettledFlag(roomId, 'coop', true);
  assert.equal((await reg.get(roomId))!.pvpSettled, false);
  assert.equal((await reg.get(roomId))!.coopSettled, true);
  await assert.doesNotReject(() => reg.setSettledFlag('not-exist', 'pvp', true));
});
