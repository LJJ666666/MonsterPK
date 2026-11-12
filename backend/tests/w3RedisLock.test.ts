/**
 * W3 分布式租约锁确定性单测（设计定稿 §3.2 / §5.3）。
 *
 * CI 不提供 Redis，所以这里注入内存后端 + 虚拟时钟 + 手动 watchdog，
 * 用 barrier 强制任务在临界区交汇，证明「去掉锁必失败」；真 Redis 的
 * SET NX PX / Lua 语义由 e2e_w3_lock.mjs 覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { RedisLockBackend } from '../src/lib/redisLockBackend';
import { RENEW_SCRIPT, RELEASE_SCRIPT } from '../src/lib/redisLockBackend';
import {
  RedisLockProvider, lockNamespaceOf, LOCK_TTL_MS, LOCK_RENEW_INTERVAL_MS,
} from '../src/lib/redisLockProvider';
import { DeterministicClock, settle } from './lib/deterministic';

/** 内存版 Redis：语义与 SET NX PX + token 比对 Lua 一致，TTL 由虚拟时钟推进。 */
class FakeBackend implements RedisLockBackend {
  private readonly store = new Map<string, { token: string; expiresAt: number }>();
  public alwaysHeld = false;

  constructor(private readonly clock: DeterministicClock) {}

  private live(key: string) {
    const e = this.store.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.clock.now()) {
      this.store.delete(key);
      return null;
    }
    return e;
  }

  async acquire(key: string, token: string, ttlMs: number) {
    if (this.alwaysHeld || this.live(key)) return false;
    this.store.set(key, { token, expiresAt: this.clock.now() + ttlMs });
    return true;
  }

  async renew(key: string, token: string, ttlMs: number) {
    const e = this.live(key);
    if (!e || e.token !== token) return false;
    e.expiresAt = this.clock.now() + ttlMs;
    return true;
  }

  async release(key: string, token: string) {
    const e = this.live(key);
    if (!e || e.token !== token) return false;
    this.store.delete(key);
    return true;
  }

  peek(key: string) { return this.live(key)?.token ?? null; }
  pttl(key: string) {
    const e = this.live(key);
    return e ? e.expiresAt - this.clock.now() : -2;
  }
  forceSet(key: string, token: string, ttlMs: number) {
    this.store.set(key, { token, expiresAt: this.clock.now() + ttlMs });
  }
  drop(key: string) { this.store.delete(key); }
}

function makeHarness(overrides: Record<string, unknown> = {}) {
  const clock = new DeterministicClock(1_000);
  const backend = new FakeBackend(clock);
  const lost: string[] = [];
  const timers: Array<() => void> = [];
  const scheduler = {
    setInterval: (fn: () => void) => { timers.push(fn); return timers.length; },
    clearInterval: (h: unknown) => { timers[Number(h) - 1] = () => undefined; },
  };
  const provider = new RedisLockProvider(backend, {
    ttlMs: 300,
    renewIntervalMs: 100,
    acquireTimeoutMs: 600,
    retryMinMs: 10,
    retryMaxMs: 10,
    scheduler,
    // 虚拟时钟只在用例里显式 advance；并发抢锁若让 sleep 推进共享时钟，
    // 会把 TTL 与 deadline 一起推爆，那是夹具问题不是产品行为。
    // maxAttempts 兜底保证时钟不前进时也能确定性退出。
    sleep: async () => { await settle(2); },
    now: () => clock.now(),
    random: () => 0.5,
    onLeaseLost: (key: string) => lost.push(key),
    ...overrides,
  });
  return {
    provider, backend, clock, lost,
    tickWatchdog: () => timers.forEach((f) => f()),
  };
}

/** 统计日志中同时处于临界区的最大并发数：1 = 串行，>1 = 交错。 */
function maxConcurrent(log: string[]): number {
  let inside = 0;
  let max = 0;
  for (const e of log) {
    if (e.endsWith(':in')) { inside += 1; max = Math.max(max, inside); }
    else inside -= 1;
  }
  return max;
}

/** 所有人先读完旧值再一起写，没有锁时必然丢失更新。 */
function barrier(n: number) {
  let count = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return async () => {
    count += 1;
    if (count === n) release();
    await gate;
  };
}

test('命名空间映射：五类 W0 裸 key 各有独立前缀且不改调用侧返回值', () => {
  assert.equal(lockNamespaceOf('u1'), 'lock:acct:u1');
  assert.equal(lockNamespaceOf('room:r1'), 'lock:room:r1');
  assert.equal(lockNamespaceOf('bossq:u1'), 'lock:bossq:u1');
  assert.equal(lockNamespaceOf('mapbossq:u1'), 'lock:mapbossq:u1');
  assert.equal(lockNamespaceOf('rank:settle:2026-11-12'), 'lock:rank:2026-11-12');
  assert.ok(LOCK_TTL_MS > 250, 'TTL 必须远大于房间 250ms tick');
  assert.ok(LOCK_RENEW_INTERVAL_MS < LOCK_TTL_MS);
});

test('同 key 并发：带租约锁临界区不交错；去掉锁必然交错（§5.3 反证）', async () => {
  const { provider } = makeHarness();
  const locked: string[] = [];
  const job = (tag: string) => provider.run('u1', async () => {
    locked.push(`${tag}:in`);
    await settle(3);
    locked.push(`${tag}:out`);
  });
  await Promise.all([job('A'), job('B')]);
  assert.equal(locked.length, 4);
  assert.equal(maxConcurrent(locked), 1, '带锁时不允许两个任务同时在临界区');

  const unlocked: string[] = [];
  const raw = (tag: string) => (async () => {
    unlocked.push(`${tag}:in`);
    await settle(3);
    unlocked.push(`${tag}:out`);
  })();
  await Promise.all([raw('A'), raw('B')]);
  assert.equal(maxConcurrent(unlocked), 2, '去掉锁必须出现交错，否则反证无效');
});

test('读-改-写：带锁 20 次无丢失；去锁 + barrier 必定丢失更新', async () => {
  const { provider } = makeHarness();
  let value = 0;
  const bump = () => provider.run('u2', async () => {
    const seen = value;
    await settle(2);
    value = seen + 1;
  });
  await Promise.all(Array.from({ length: 20 }, bump));
  assert.equal(value, 20, '带锁不得丢失更新');

  let free = 0;
  const gate = barrier(20);
  await Promise.all(Array.from({ length: 20 }, () => (async () => {
    const seen = free;
    await gate();
    free = seen + 1;
  })()));
  assert.equal(free, 1, '无锁且强制交汇时必须丢失更新（反证）');
  assert.notEqual(value, free);
});

test('AsyncLocalStorage 重入旁路：嵌套同 key 不死锁，嵌套不同 key 正常取锁', async () => {
  const { provider, backend } = makeHarness();
  const inner = await provider.run('u1', async () => provider.run('u1', async () => 42));
  assert.equal(inner, 42, 'SET NX 非重入，同调用链重复取同一 key 必须 bypass');

  const seen: string[] = [];
  const outer = await provider.run('u3', async () => provider.run('room:r1', async () => {
    seen.push(backend.peek('lock:acct:u3') ?? '');
    seen.push(backend.peek('lock:room:r1') ?? '');
    return 7;
  }));
  assert.equal(outer, 7);
  assert.equal(seen.length, 2);
  assert.ok(seen.every((t) => t.length > 0), '外层账号锁与内层房间锁应同时持有');
});

test('watchdog 续租：临界区超过 TTL 仍持有锁，且不会续别人的锁', async () => {
  const { provider, backend, clock, tickWatchdog, lost } = makeHarness();
  await provider.run('u4', async () => {
    clock.advance(250); // ttl=300，即将过期
    assert.ok(backend.pttl('lock:acct:u4') <= 50);
    tickWatchdog();
    await settle(4);
    assert.ok(backend.pttl('lock:acct:u4') > 250, 'watchdog 应把 TTL 重置');

    // 锁易主后，续租必须失败并告警
    backend.drop('lock:acct:u4');
    backend.forceSet('lock:acct:u4', 'other:token', 300);
    tickWatchdog();
    await settle(4);
    assert.equal(backend.peek('lock:acct:u4'), 'other:token');
  });
  assert.ok(lost.length >= 1, '续租检测到易主必须回调 onLeaseLost');
  assert.equal(backend.peek('lock:acct:u4'), 'other:token', '迟到释放不得删掉新租约');
});

test('前一个任务 reject 不阻断后续；返回值与异常各自传递；inflight 归零', async () => {
  const { provider } = makeHarness();
  await assert.rejects(provider.run('u5', async () => { throw new Error('boom'); }), /boom/);
  assert.equal(await provider.run('u5', async () => 42), 42);
  await settle(4);
  assert.equal(provider.activeKeys(), 0);
  provider.clear();
  assert.equal(provider.activeKeys(), 0);
});

test('抢锁超时明确抛错，绝不静默放行', async () => {
  const { provider, backend } = makeHarness({ acquireTimeoutMs: 60 });
  backend.alwaysHeld = true;
  await assert.rejects(provider.run('u6', async () => 1), /LOCK_ACQUIRE_TIMEOUT/);
  assert.equal(provider.activeKeys(), 0);
});

test('生产 Lua 脚本必须带 token 比对（安全续租 / 安全释放）', () => {
  assert.match(RENEW_SCRIPT, /redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/);
  assert.match(RENEW_SCRIPT, /pexpire/);
  assert.match(RELEASE_SCRIPT, /redis\.call\('get', KEYS\[1\]\) == ARGV\[1\]/);
  assert.match(RELEASE_SCRIPT, /redis\.call\('del'/);
});
