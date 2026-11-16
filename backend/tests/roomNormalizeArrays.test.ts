/**
 * §92 A 项（normalizeRoom 补数组兜底）红测 —— 纯函数，无 IO。
 *
 * 缺陷：旧房间 data JSON 若缺 `seats` / `submitted` / `turnIntents` 数组
 * （序列化丢失、手写脏数据），registry 里的 `find` / `includes` / `push` 会
 * 直接 TypeError → 500。normalizeRoom 目前只补 contributions key 与两个
 * optional 布尔，不兜底数组。
 *
 * 另：B 项把 seenNonces 迁出房间 JSON 后，旧 data 里残留的 `seenNonces`
 * 字段应在 normalize 时剥掉，避免把废弃字段再写回。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoom } from '../src/lib/roomNormalize';
import type { RoomState } from '../src/lib/roomTypes';

/** 构造一个缺数组的「旧数据」房间（模拟序列化丢失）。 */
function legacyRoom(): RoomState {
  return {
    roomId: 'legacy-room',
    mode: 'kernel',
    status: 'active',
    revision: 1,
    createdAt: 1,
    updatedAt: 1,
    turn: 1,
    deadlineAt: 0,
    lastAction: null,
    quota: null,
    allOfflineSince: null,
    endReason: null,
    // seats / submitted / turnIntents 全缺；seenNonces 是 B 项迁走后的残留字段。
    ...({ seenNonces: ['0:n1'] } as object),
  } as unknown as RoomState;
}

test('A-1：缺 seats/submitted/turnIntents → normalize 后补空数组', () => {
  const room = normalizeRoom(legacyRoom());
  assert.ok(Array.isArray(room.seats), 'seats 必须是数组');
  assert.ok(Array.isArray(room.submitted), 'submitted 必须是数组');
  assert.ok(Array.isArray(room.turnIntents), 'turnIntents 必须是数组');
});

test('A-2：残留的 seenNonces 字段必须在 normalize 时剥掉（B 项迁走后的废弃字段）', () => {
  const room = normalizeRoom(legacyRoom());
  assert.equal('seenNonces' in room, false, 'seenNonces 已迁独立表，不得残留在房间 JSON');
});

test('A-3：齐全字段不受影响（零回归）', () => {
  const base = legacyRoom();
  (base as any).seats = [{ seat: 0, userId: 'u1', tokenDigest: 'd', connectionId: null, online: false, disconnectedAt: null, autopilot: false }];
  (base as any).submitted = [0];
  (base as any).turnIntents = [];
  delete (base as any).seenNonces;
  const room = normalizeRoom(base);
  assert.equal(room.seats.length, 1);
  assert.deepEqual(room.submitted, [0]);
});
