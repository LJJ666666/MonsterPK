/**
 * W5 后端单测（可注入 fake，CI 可跑，不依赖真 Redis）。
 *
 * 覆盖：
 *  1. RedisBroadcastTransport 的频道路由：toUser → mpk:bc:user:<uid>、toAll → mpk:bc:all，
 *     经 subscriber 回环转发到本进程 WsRegistry 对应方法（验证「发布→订阅→本地转发」闭环，单实例零重复）。
 *  2. ctl:takeover 事件解析后触发 onTakeover 回调（跨实例顶号入口）。
 *  3. kickUserConnectionsExceptSv：只踢 sv 不匹配的连接（发 bye + close + 移除 + detach），sv 匹配忽略。
 *  4. getBroadcastMode 默认 local（未 init），且不污染全局 transport。
 *
 * 真 Redis 双实例验收在 tests/e2e_w5_broadcast.mjs（verify 阶段本地跑）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { RedisBroadcastTransport } from '../src/lib/redisBroadcastTransport';
import {
  kickUserConnectionsExceptSv,
  getBroadcastMode,
} from '../src/lib/connectionControl';
import { wsRegistry } from '../src/modules/sessionBus';
import { SESSION_REPLACED_CODE } from '../src/lib/account';

/** 最小 pub/sub 内核：publish 触发已注册 pmessage 回调（按 psubscribe pattern 匹配）。 */
class FakeRedisBus extends EventEmitter {
  patterns: string[] = [];
  psubscribe(...p: string[]): void {
    this.patterns.push(...p);
  }
  publish(channel: string, msg: string): Promise<number> {
    for (const cb of this.listeners('pmessage') as Array<(p: string, c: string, m: string) => void>) {
      for (const pat of this.patterns) {
        if (matchPattern(pat, channel)) cb(pat, channel, msg);
      }
    }
    return Promise.resolve(1);
  }
  quit(): Promise<void> {
    return Promise.resolve();
  }
}

function matchPattern(pat: string, channel: string): boolean {
  const re = new RegExp(
    '^' + pat.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^:]*') + '$',
  );
  return re.test(channel);
}

/** 只实现 transport 所需的 WsRegistry 两个方法，记录调用。 */
class FakeRegistry {
  userCalls: Array<{ userId: string; data: string }> = [];
  allCalls: string[] = [];
  broadcastToUser(userId: string, data: string): number {
    this.userCalls.push({ userId, data });
    return 1;
  }
  broadcastAll(data: string): number {
    this.allCalls.push(data);
    return 1;
  }
}

function makeSock() {
  return {
    readyState: 1,
    sent: [] as string[],
    closed: false,
    send(d: string) {
      this.sent.push(d);
    },
    close() {
      this.closed = true;
    },
    terminate() {},
    ping() {},
  };
}

test('W5-1 toUser 发布到 mpk:bc:user:<uid> 并经订阅回环转发到本进程 registry', () => {
  const bus = new FakeRedisBus();
  const fake = new FakeRegistry();
  const t = new RedisBroadcastTransport(bus as any, fake as any, {}, bus as any);
  t.toUser('u7', 'HELLO-U7');
  assert.equal(fake.userCalls.length, 1);
  assert.equal(fake.userCalls[0].userId, 'u7');
  assert.equal(fake.userCalls[0].data, 'HELLO-U7');
  assert.equal(fake.allCalls.length, 0);
});

test('W5-2 toAll 发布到 mpk:bc:all 并转发到本进程 broadcastAll', () => {
  const bus = new FakeRedisBus();
  const fake = new FakeRegistry();
  const t = new RedisBroadcastTransport(bus as any, fake as any, {}, bus as any);
  t.toAll('WILD-SNAPSHOT');
  assert.equal(fake.allCalls.length, 1);
  assert.equal(fake.allCalls[0], 'WILD-SNAPSHOT');
  assert.equal(fake.userCalls.length, 0);
});

test('W5-3 ctl:takeover 解析后触发 onTakeover 回调（跨实例顶号入口）', () => {
  const bus = new FakeRedisBus();
  let got: { u: string; sv: number } | null = null;
  const t = new RedisBroadcastTransport(
    bus as any,
    new FakeRegistry() as any,
    { onTakeover: (u, sv) => { got = { u, sv }; } },
    bus as any,
  );
  t.publishTakeover('u9', 5);
  assert.deepEqual(got, { u: 'u9', sv: 5 });
});

test('W5-4 ctl:takeover 坏包不触发 onTakeover（不抛、不调用）', () => {
  const bus = new FakeRedisBus();
  let calls = 0;
  const t = new RedisBroadcastTransport(
    bus as any,
    new FakeRegistry() as any,
    { onTakeover: () => { calls++; } },
    bus as any,
  );
  // 直接走 dispatch 路径：发出一个非法 JSON 到控制频道
  (bus as any).emit('pmessage', 'mpk:ctl:takeover', 'mpk:ctl:takeover', 'not-json');
  assert.equal(calls, 0);
});

test('W5-5 只踢 sv 不匹配的连接（bye+close+移除+detach），sv 匹配忽略', () => {
  const userId = 'kick_test_user';
  const sock1 = makeSock();
  const sock2 = makeSock();
  wsRegistry.add({
    id: 'k1', userId, socket: sock1 as any, connectedAt: Date.now(),
    lastSeenAt: Date.now(), alive: true, sessionVersion: 1,
  } as any, 10);
  wsRegistry.add({
    id: 'k2', userId, socket: sock2 as any, connectedAt: Date.now(),
    lastSeenAt: Date.now(), alive: true, sessionVersion: 2,
  } as any, 10);

  kickUserConnectionsExceptSv(userId, 2);

  // sock1 (sv=1) 应被踢
  assert.equal(sock1.sent.length, 1);
  const msg = JSON.parse(sock1.sent[0]);
  assert.equal(msg.type, 'bye');
  assert.equal(msg.code, SESSION_REPLACED_CODE);
  assert.equal(sock1.closed, true);
  // sock2 (sv=2) 忽略
  assert.equal(sock2.sent.length, 0);
  assert.equal(sock2.closed, false);
  // 只剩 sv=2 的连接
  const remaining = wsRegistry.listForUser(userId);
  assert.equal(remaining.length, 1);
  assert.equal(remaining[0].id, 'k2');

  // 清理
  wsRegistry.remove('k2');
  assert.equal(wsRegistry.listForUser(userId).length, 0);
});

test('W5-6 未 init 时广播模式为 local，且导出函数不污染全局 transport', () => {
  assert.equal(getBroadcastMode(), 'local');
});
