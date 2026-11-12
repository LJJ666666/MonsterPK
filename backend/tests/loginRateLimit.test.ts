import test from 'node:test';
import assert from 'node:assert/strict';
import { LoginRateLimiter } from '../src/lib/loginRateLimit';

const IP = '127.0.0.1';

test('窗口内前 5 次失败放行，第 6 次请求被挡并给出 Retry-After', () => {
  let now = 1_000;
  const limiter = new LoginRateLimiter({ windowMs: 60_000, maxFailures: 5, now: () => now });
  for (let i = 0; i < 5; i += 1) {
    assert.equal(limiter.check(IP, 'alice').allowed, true, `第 ${i + 1} 次失败前不应被挡`);
    limiter.recordFailure(IP, 'alice');
  }
  const decision = limiter.check(IP, 'alice');
  assert.equal(decision.allowed, false);
  assert.equal(decision.retryAfter, 60);
});

test('用户名大小写不影响同一账号的计数', () => {
  const limiter = new LoginRateLimiter({ windowMs: 60_000, maxFailures: 2, now: () => 5_000 });
  limiter.recordFailure(IP, 'Alice');
  limiter.recordFailure(IP, '  ALICE  ');
  assert.equal(limiter.check(IP, 'alice').allowed, false);
});

test('登录成功清空组合键，且不影响其它账号', () => {
  const limiter = new LoginRateLimiter({ windowMs: 60_000, maxFailures: 2, now: () => 5_000 });
  limiter.recordFailure(IP, 'alice');
  limiter.clear(IP, 'alice');
  assert.equal(limiter.check(IP, 'alice').allowed, true);
  limiter.recordFailure(IP, 'bob');
  limiter.recordFailure(IP, 'bob');
  assert.equal(limiter.check(IP, 'bob').allowed, false);
  assert.equal(limiter.check(IP, 'alice').allowed, true);
});

test('窗口过期后自动恢复，过期桶被清掉', () => {
  let now = 1_000;
  const limiter = new LoginRateLimiter({ windowMs: 1_000, maxFailures: 1, now: () => now });
  limiter.recordFailure(IP, 'alice');
  assert.equal(limiter.check(IP, 'alice').allowed, false);
  now += 1_001;
  assert.equal(limiter.check(IP, 'alice').allowed, true);
  assert.equal(limiter.size, 0);
});

test('纯 IP 兜底桶：同一来源横扫不同账号，累计超阈值也被挡', () => {
  const limiter = new LoginRateLimiter({
    windowMs: 60_000,
    maxFailures: 5,
    maxIpFailures: 6,
    now: () => 5_000,
  });
  for (let i = 0; i < 6; i += 1) limiter.recordFailure(IP, `victim_${i}`);
  // 全新组合键本来没失败过，仍被 IP 桶挡住。
  const decision = limiter.check(IP, 'fresh_account');
  assert.equal(decision.allowed, false);
  assert.ok(decision.retryAfter > 0);
  // 换个来源不受影响。
  assert.equal(limiter.check('10.0.0.9', 'fresh_account').allowed, true);
});

test('check 不消费配额，连续检查不会自我升级成限流', () => {
  const limiter = new LoginRateLimiter({ windowMs: 60_000, maxFailures: 2, now: () => 5_000 });
  for (let i = 0; i < 20; i += 1) assert.equal(limiter.check(IP, 'alice').allowed, true);
  assert.equal(limiter.size, 0);
});
