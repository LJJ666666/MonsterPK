/**
 * §92 B 项（64 条 nonce 窗口淘汰）红测 —— 无 IO，纯内存。
 *
 * 缺陷（专家评审 §2.1/§3.1）：`seenNonces` 限长 64、超长 `shift()` 淘汰最早。
 * 同座位连续提交 65 个 nonce（第 1 个成功、其余被 TURN_ALREADY_SUBMITTED 拒但
 * nonce 都烧掉）后，最早的 nonce 已被挤掉 —— 重放它会被当成合法首提直接 200，
 * 旧意图落到新回合。「至多一次」只在 64 窗口内成立。
 *
 * 本文件先落盘：旧实现必须红（重放返回 200），修后必须绿（INTENT_REPLAY）。
 * 修法：nonce 真值迁独立唯一表（RoomNonceSeen，房间+座位+nonce 唯一），无淘汰窗口。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { RoomRegistry, InMemoryRoomStorage } from '../src/lib/roomRegistry';
import { sequenceIds } from './lib/deterministic';

const OWNER = { userId: 'u1', tokenDigest: 'd1', connectionId: 'c1' };
const GUEST = { userId: 'u2', tokenDigest: 'd2', connectionId: 'c2' };
const NOW = Date.UTC(2026, 10, 16, 10, 0, 0);

test('B-1：烧掉 65 个 nonce 后，最早的 nonce 重放必须仍判 INTENT_REPLAY（旧窗口实现必红）', async () => {
  const reg = new RoomRegistry({ storage: new InMemoryRoomStorage(), idFactory: sequenceIds('b1') });
  const roomId = 'b1-room';
  assert.equal((await reg.create({ roomId, mode: 'kernel', owner: OWNER, now: NOW })).ok, true);
  assert.equal((await reg.join({ roomId, member: GUEST, now: NOW + 10 })).ok, true);

  // 同回合连发 65 个不同 nonce：第 1 个成功，其余 64 个被拒（TURN_ALREADY_SUBMITTED）但 nonce 都要烧。
  const firstNonce = 'w000';
  for (let i = 0; i < 65; i++) {
    const res = await reg.submitIntent({
      roomId, actorUserId: OWNER.userId, intent: 'move_1', nonce: `w${String(i).padStart(3, '0')}`, now: NOW + 20 + i,
    });
    if (i === 0) assert.equal(res.ok, true, '首个 nonce 应成功提交');
    else assert.equal(!res.ok && res.code, 'TURN_ALREADY_SUBMITTED', `第 ${i + 1} 个应被拒但 nonce 已烧`);
  }
  // guest 提交 → 推进回合。
  const guest = await reg.submitIntent({
    roomId, actorUserId: GUEST.userId, intent: 'move_1', nonce: 'g0', now: NOW + 200,
  });
  assert.equal(guest.ok && guest.value.advanced, true, '应推进回合');

  // 重放最早（第 1 个）nonce：唯一表下永久判重；64 窗口下已被 shift 挤掉 → 旧实现 200。
  const replay = await reg.submitIntent({
    roomId, actorUserId: OWNER.userId, intent: 'move_2', nonce: firstNonce, now: NOW + 300,
  });
  assert.equal(!replay.ok && replay.code, 'INTENT_REPLAY',
    `跨窗口重放必须判重放，实际 ${JSON.stringify(replay)}`);
});
