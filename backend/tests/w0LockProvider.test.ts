/**
 * W0 锁接口化单测：证明抽出去的 InProcessLockProvider 与 W0 前 `chains: Map`
 * 的四条契约逐条等价，且注入点能被 W3 直接替换。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { InProcessLockProvider } from '../src/lib/lockProvider';
import {
  withSlotLock, slotLockKey, roomLockKey, setLockProvider,
  resetLockProviderForTest, activeSlotLocks, clearSlotLocksForTest,
} from '../src/lib/slotLock';
import { DeterministicClock, settle } from './lib/deterministic';

test('同 key 严格串行（确定性时钟记录进/出，不依赖调度运气）', async () => {
  const p = new InProcessLockProvider();
  const clock = new DeterministicClock(1_000);
  const log: string[] = [];
  const job = (tag: string, ms: number) => p.run('acct:u1', async () => {
    log.push(`${tag}:in@${clock.now()}`);
    await Promise.resolve();
    clock.advance(ms);
    log.push(`${tag}:out@${clock.now()}`);
    return tag;
  });

  const [a, b] = await Promise.all([job('A', 10), job('B', 5)]);
  assert.deepEqual([a, b], ['A', 'B']);
  assert.deepEqual(log, ['A:in@1000', 'A:out@1010', 'B:in@1010', 'B:out@1015']);
});

test('不同 key 不互相阻塞', async () => {
  const p = new InProcessLockProvider();
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  const first = p.run('k1', async () => { await gate; return 1; });
  const second = p.run('k2', async () => 2);
  assert.equal(await second, 2, 'k2 不该等 k1');
  release();
  assert.equal(await first, 1);
});

test('前一个任务 reject 不阻断后续任务（then 双回调语义保留）', async () => {
  const p = new InProcessLockProvider();
  await assert.rejects(
    p.run('k', async () => { throw new Error('boom'); }),
    /boom/,
  );
  assert.equal(await p.run('k', async () => 42), 42);
});

test('队尾跑完且无新任务时清理 key（Map 不随账号数增长）', async () => {
  const p = new InProcessLockProvider();
  await p.run('k', async () => 1);
  await settle();
  assert.equal(p.activeKeys(), 0);
  p.clear();
  assert.equal(p.activeKeys(), 0);
});

test('setLockProvider 注入生效，reset 后恢复进程内实现', async () => {
  const calls: string[] = [];
  setLockProvider({
    run: async (_key, fn) => { calls.push('mock'); return fn(); },
    activeKeys: () => 0,
    clear: () => undefined,
  });
  assert.equal(await withSlotLock('k', async () => 7), 7);
  assert.deepEqual(calls, ['mock']);

  resetLockProviderForTest();
  clearSlotLocksForTest();
  assert.equal(await withSlotLock('k', async () => 8), 8);
  await settle();
  assert.equal(activeSlotLocks(), 0);
});

test('key 规则与 W0 前一致（账号裸 userId / 房间 room: 前缀）', () => {
  assert.equal(slotLockKey('u1'), 'u1');
  assert.equal(roomLockKey('r1'), 'room:r1');
  assert.notEqual(slotLockKey('r1'), roomLockKey('r1'));
});
