import test from 'node:test';
import assert from 'node:assert/strict';
import {
  withRoomLock, roomLockKey, slotLockKey, clearSlotLocksForTest,
} from '../src/lib/slotLock';

/**
 * 房间锁的**确定性**证明（照 P4-0 `slotLock.test.ts` 的做法）。
 *
 * 为什么需要这个文件：E2E 的并发形状会被 undici / Prisma 队列 / Node 单线程串行化，
 * 「把锁改成直通，E2E 仍然全绿」在 P4-0 已经踩过一次（bug_log §26）。
 * 这里刻意让「读 usage → await → 判定 → 写」之间真的让出事件循环，
 * 去锁就必然超卖，加锁则只有一个成功，结论不依赖网络时序。
 *
 * 另一个要点：单进程内存态下 `RoomRegistry` 的方法是同步的、内部不会交错；
 * 锁真正保护的是**路由层跨 await 的组合**，以及 P5-1 换成异步共享存储 adapter 之后
 * 的「读 → 判定 → 写」。这也是契约 §5 要求可替换 storage 的原因。
 */

/** 模拟 quota hold 的临界区：读快照 → await → 判定余量 → 写。 */
async function holdWithLock(
  ledger: { held: number },
  roomId: string,
): Promise<boolean> {
  return withRoomLock(roomId, async () => {
    const snapshot = ledger.held;
    await Promise.resolve(); // 关键：真的让出事件循环，去锁时两个请求都读到 0
    if (snapshot >= 1) return false;
    ledger.held = snapshot + 1;
    return true;
  });
}

/** 同一临界区，但不加锁 —— 用来证明锁不是摆设。 */
async function holdWithoutLock(ledger: { held: number }): Promise<boolean> {
  const snapshot = ledger.held;
  await Promise.resolve();
  if (snapshot >= 1) return false;
  ledger.held = snapshot + 1;
  return true;
}

test('去锁确定性失败：两个并发 hold 会把 limit=1 冲破', async () => {
  clearSlotLocksForTest();
  const ledger = { held: 0 };
  const results = await Promise.all([
    holdWithoutLock(ledger),
    holdWithoutLock(ledger),
    holdWithoutLock(ledger),
  ]);
  assert.equal(results.filter(Boolean).length, 3, '无锁时应全部超卖');
  assert.equal(ledger.held, 1, '且计数被覆盖，看不出超卖');
});

test('withRoomLock 串行：同样三个并发 hold 只有一个成功', async () => {
  clearSlotLocksForTest();
  const ledger = { held: 0 };
  const results = await Promise.all([
    holdWithLock(ledger, 'r1'),
    holdWithLock(ledger, 'r1'),
    holdWithLock(ledger, 'r1'),
  ]);
  assert.deepEqual(results, [true, false, false]);
  assert.equal(ledger.held, 1);
});

test('不同 roomId 不互相阻塞，各自独立排队', async () => {
  clearSlotLocksForTest();
  const a = { held: 0 };
  const b = { held: 0 };
  const results = await Promise.all([
    holdWithLock(a, 'room_a'),
    holdWithLock(b, 'room_b'),
  ]);
  assert.deepEqual(results, [true, true]);
});

test('前一个任务抛错不会阻断队列里的后续任务', async () => {
  clearSlotLocksForTest();
  const first = withRoomLock('r1', async () => { throw new Error('boom'); });
  const second = withRoomLock('r1', async () => 42);
  await assert.rejects(first, /boom/);
  assert.equal(await second, 42);
});

test('roomLockKey 与 slotLockKey 命名空间不冲突', () => {
  assert.equal(roomLockKey('r1'), 'room:r1');
  assert.notEqual(roomLockKey('r1'), slotLockKey('r1', 1));
});
