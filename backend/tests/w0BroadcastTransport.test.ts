/**
 * W0 广播接口化单测：两出口语义不变、死代码确已删除、注入点可用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { WsRegistry, type WsConnection, type WsLike } from '../src/lib/wsRegistry';
import { LocalBroadcastTransport } from '../src/lib/broadcastTransport';
import * as bus from '../src/modules/sessionBus';

function sinkSocket(sink: string[]): WsLike {
  return {
    readyState: 1,
    send: (d) => { sink.push(d); },
    close: () => undefined,
    terminate: () => undefined,
    ping: () => undefined,
  };
}

function conn(id: string, userId: string, sink: string[]): WsConnection {
  return {
    id, userId, socket: sinkSocket(sink),
    connectedAt: 0, lastSeenAt: 0, alive: true,
  };
}

test('LocalBroadcastTransport 的两出口分流与送达条数', () => {
  const reg = new WsRegistry();
  const a: string[] = [];
  const b: string[] = [];
  // 单账号默认上限是 1（顶号语义），这里显式放宽，才能覆盖「一个账号多条连接」的送达数。
  reg.add(conn('c1', 'u1', a), 10);
  reg.add(conn('c2', 'u1', a), 10);
  reg.add(conn('c3', 'u2', b), 10);
  const t = new LocalBroadcastTransport(reg);

  assert.equal(t.toUser('u1', 'to-u1'), 2);
  assert.deepEqual(a, ['to-u1', 'to-u1']);
  assert.deepEqual(b, []);

  // u1 的两条连接共用 sink a，toAll 会往 a 写两条、往 b 写一条。
  assert.equal(t.toAll('to-all'), 3);
  assert.deepEqual(a, ['to-u1', 'to-u1', 'to-all', 'to-all']);
  assert.deepEqual(b, ['to-all']);
});

test('broadcastToMany 死代码已从 WsRegistry 与 sessionBus 清除', () => {
  const reg = new WsRegistry();
  assert.equal(typeof (reg as any).broadcastToMany, 'undefined');
  assert.equal('broadcastToMany' in bus, false);
});

test('setBroadcastTransport 注入生效，reset 后回到本地实现', () => {
  const calls: string[] = [];
  bus.setBroadcastTransport({
    toUser: (u, d) => { calls.push(`user:${u}:${d}`); return 1; },
    toAll: (d) => { calls.push(`all:${d}`); return 1; },
  });
  assert.equal(bus.broadcastToUser('u1', 'x'), 1);
  assert.equal(bus.broadcastAll('y'), 1);
  assert.deepEqual(calls, ['user:u1:x', 'all:y']);

  bus.resetBroadcastTransportForTest();
  const sink: string[] = [];
  bus.wsRegistry.clear();
  bus.wsRegistry.add(conn('c-reset', 'u-reset', sink));
  assert.equal(bus.broadcastToUser('u-reset', 'local'), 1);
  assert.deepEqual(sink, ['local']);
  bus.wsRegistry.clear();
});
