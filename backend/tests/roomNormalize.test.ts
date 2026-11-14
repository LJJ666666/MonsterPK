import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeRoom } from '../src/lib/roomNormalize';
import type { RoomState } from '../src/lib/roomTypes';

function baseRoom(over: Partial<RoomState> = {}): RoomState {
  return {
    roomId: 'r1',
    mode: 'coop',
    status: 'active',
    revision: 1,
    createdAt: 0,
    updatedAt: 0,
    hostId: 'u1',
    seats: [{ userId: 'u1', seat: 0 }, { userId: 'u2', seat: 1 }],
    pvp: null,
    coop: null,
    coopBossId: null,
    ...over,
  } as RoomState;
}

test('normalizeRoom：共斗 contributions 经 PG 往返后值正确且数字下标访问一致', () => {
  const room = baseRoom({
    // 模拟 PG JSON 往返后 contributions 的 key 变成 string（JSON 对象键只能是字符串）
    coop: {
      finished: false,
      result: null,
      sides: [],
      rooms: [
        {
          index: 0,
          state: 'active',
          enemies: [],
          enemyPP: [],
          enemyMods: [],
          occupantSeat: 0,
          // 关键：反序列化后 key 是 "0"/"1"
          contributions: { '0': 5, '1': 3 } as any,
          turn: 1,
          clearedBy: null,
          defeatedBySeat: null,
          log: [],
        } as any,
      ],
    } as any,
  });

  const got = normalizeRoom(room);
  const c = (got.coop as any).rooms[0].contributions;
  // 归一化后数值下标访问与字符串下标访问一致（JS coerce 兜底，类型诚实）
  assert.equal(c[0], 5);
  assert.equal(c[1], 3);
  assert.equal(c[0], c['0']);
  assert.equal(c[1], c['1']);
  // 对 seat 做严格比较 / 求和的消费者拿到的就是这些数值，不依赖 key 字面
  const sum = Object.keys(c).reduce((acc, k) => acc + (c as any)[Number(k)], 0);
  assert.equal(sum, 8);
});

test('normalizeRoom：顶层 optional 布尔缺失时补显式 false', () => {
  const room = baseRoom(); // 不带 pvpSettled / coopSettled
  const got = normalizeRoom(room);
  assert.equal(got.pvpSettled, false);
  assert.equal(got.coopSettled, false);
});

test('normalizeRoom：已有的 settled 标记不被覆盖', () => {
  const room = baseRoom({ pvpSettled: true, coopSettled: true } as any);
  const got = normalizeRoom(room);
  assert.equal(got.pvpSettled, true);
  assert.equal(got.coopSettled, true);
});

test('normalizeRoom：无 coop 的房间（pvp/普通）不被触碰 contributions', () => {
  const room = baseRoom({ mode: 'pvp', pvp: { finished: false } as any });
  const got = normalizeRoom(room);
  assert.equal(got.mode, 'pvp');
  assert.equal(got.pvpSettled, false);
  assert.equal(got.coopSettled, false);
  // 不应因无 coop 而抛错或产生多余字段
  assert.equal((got as any).coop, null);
});
