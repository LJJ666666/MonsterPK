/**
 * 账号级串行化单测（P4 前置，F17 起一账号一档）。
 *
 * 为什么必须单独测这把锁：E2E 里「同版本并发两条 PUT」在本机跑出来始终只有一条成功，
 * 看起来像 CAS 已经够了 —— 但那依赖运行时调度（undici 连接复用、Prisma 队列、
 * 内存会话命中的先后）。换个部署形态（多实例、连接池、HTTP/2）就可能变成两条都过校验、
 * 后写覆盖前写。这里用确定性单测把「临界区不交错」这个不变量钉住，不依赖调度运气。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { withSlotLock, slotLockKey, clearSlotLocksForTest, activeSlotLocks } from '../src/lib/slotLock';

/** 让出几个事件循环 tick，制造「任务中途 await」的真实交错机会。 */
const yieldTicks = () => new Promise<void>((r) => setTimeout(r, 0));

test('同一 key：临界区不交错（进-出成对，不出现 A 进 B 进 A 出）', async () => {
  clearSlotLocksForTest();
  const key = slotLockKey('u1');
  const log: string[] = [];

  const job = (tag: string) =>
    withSlotLock(key, async () => {
      log.push(`${tag}:in`);
      await yieldTicks();
      await yieldTicks();
      log.push(`${tag}:out`);
    });

  await Promise.all([job('a'), job('b'), job('c')]);

  // 严格串行：每个任务的 out 紧跟它自己的 in，然后才轮到下一个 in
  assert.deepEqual(log, ['a:in', 'a:out', 'b:in', 'b:out', 'c:in', 'c:out']);
});

test('同一 key：共享计数器无丢失更新（读-改-写跨 await 也不丢）', async () => {
  clearSlotLocksForTest();
  const key = slotLockKey('u2');
  let value = 0;

  const bump = () =>
    withSlotLock(key, async () => {
      const seen = value; // 读
      await yieldTicks(); // 中间让出：没有锁时这里就能读到别人的旧值
      value = seen + 1; // 写
    });

  await Promise.all(Array.from({ length: 20 }, bump));
  assert.equal(value, 20);
});

test('不同账号：互不阻塞（不同 key 可并行）', async () => {
  clearSlotLocksForTest();
  const order: string[] = [];

  const slow = withSlotLock(slotLockKey('u3'), async () => {
    order.push('slow:in');
    await new Promise<void>((r) => setTimeout(r, 30));
    order.push('slow:out');
  });
  const fast = withSlotLock(slotLockKey('u4'), async () => {
    order.push('fast:in');
    await yieldTicks();
    order.push('fast:out');
  });

  await Promise.all([slow, fast]);
  // fast 不必等 slow：它的 in 出现在 slow:out 之前
  assert.ok(order.indexOf('fast:out') < order.indexOf('slow:out'), order.join(','));
});

test('前一个任务失败不阻断后续任务，且返回值 / 异常各自正确传递', async () => {
  clearSlotLocksForTest();
  const key = slotLockKey('u5');
  const ran: string[] = [];

  const bad = withSlotLock(key, async () => {
    ran.push('bad');
    await yieldTicks();
    throw new Error('boom');
  });
  const good = withSlotLock(key, async () => {
    ran.push('good');
    return 42;
  });

  await assert.rejects(bad, /boom/);
  assert.equal(await good, 42);
  assert.deepEqual(ran, ['bad', 'good']);
});

test('队尾排空后清理队列（不随账号数增长）', async () => {
  clearSlotLocksForTest();
  assert.equal(activeSlotLocks(), 0);

  await withSlotLock(slotLockKey('u6'), async () => {
    await yieldTicks();
  });
  // 清理挂在队尾的 then 上，多等一个 tick
  await yieldTicks();
  assert.equal(activeSlotLocks(), 0);
});
