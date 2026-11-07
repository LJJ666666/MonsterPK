/**
 * P2-1 实时通道单测（node:test）：协议纯函数 + 会话登记表。
 * 运行：cd backend && npm test
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WS_PROTOCOL_VERSION,
  WS_HEARTBEAT_MS,
  WS_DEAD_GRACE_MS,
  WS_MAX_CONNECTIONS_PER_USER,
  extractWsToken,
  isWsUpgradePath,
  isOriginAllowed,
  parseClientMessage,
  encodeServerMessage,
  buildRejectResponse,
  deadAfterMs,
} from '../src/lib/wsProtocol';
import { WsRegistry, type WsLike, type WsConnection } from '../src/lib/wsRegistry';

/** 假 socket：只实现实时通道需要的最小接口，记录所有下发内容。 */
function fakeSocket(readyState = 1) {
  const sent: string[] = [];
  const s: WsLike & { sent: string[]; closed: boolean; terminated: boolean } = {
    readyState,
    sent,
    closed: false,
    terminated: false,
    send: (d) => { sent.push(d); },
    close: () => { s.closed = true; },
    terminate: () => { s.terminated = true; },
    ping: () => {},
  };
  return s;
}

function conn(id: string, userId: string, now = 1_000): WsConnection & { socket: ReturnType<typeof fakeSocket> } {
  return {
    id,
    userId,
    socket: fakeSocket(),
    connectedAt: now,
    lastSeenAt: now,
    alive: true,
  };
}

// ——————————————— 握手：token / 路径 / Origin ———————————————

test('extractWsToken：从 query 取 token', () => {
  assert.equal(extractWsToken('/ws?token=abc.def.ghi'), 'abc.def.ghi');
  assert.equal(extractWsToken('http://localhost:3001/ws?token=xyz&a=1'), 'xyz');
});

test('extractWsToken：缺失 / 空值 / 超长 URL / 非法 URL 一律 null', () => {
  assert.equal(extractWsToken(undefined), null);
  assert.equal(extractWsToken('/ws'), null);
  assert.equal(extractWsToken('/ws?token='), null);
  assert.equal(extractWsToken('/ws?token=' + 'x'.repeat(5_000)), null);
  assert.equal(extractWsToken('http://[bad'), null);
});

test('isWsUpgradePath：只认精确的 /ws', () => {
  assert.equal(isWsUpgradePath('/ws'), true);
  assert.equal(isWsUpgradePath('/ws?token=abc'), true);
  assert.equal(isWsUpgradePath('/ws/'), false);
  assert.equal(isWsUpgradePath('/api/ws'), false);
  assert.equal(isWsUpgradePath(undefined), false);
});

test('isOriginAllowed：白名单命中才放行，不放行跨站劫持', () => {
  const allowed = 'http://localhost:5173,https://game.example.com';
  assert.equal(isOriginAllowed('http://localhost:5173', allowed), true);
  assert.equal(isOriginAllowed('https://game.example.com', allowed), true);
  assert.equal(isOriginAllowed('https://evil.example.com', allowed), false);
  assert.equal(isOriginAllowed(undefined, allowed), true, '非浏览器客户端可不带 Origin');
  assert.equal(isOriginAllowed('https://evil.example.com', undefined), true, '未配置白名单时不误伤');
});

// ——————————————— 消息协议 ———————————————

test('parseClientMessage：合法 ping（带 / 不带 ts）', () => {
  assert.deepEqual(parseClientMessage('{"type":"ping"}'), { ok: true, message: { type: 'ping' } });
  assert.deepEqual(parseClientMessage('{"type":"ping","ts":1234}'), {
    ok: true, message: { type: 'ping', ts: 1234 },
  });
  // 非法 ts 不应被透传（避免客户端注入任意数值）
  assert.deepEqual(parseClientMessage('{"type":"ping","ts":"oops"}'), {
    ok: true, message: { type: 'ping' },
  });
});

test('parseClientMessage：坏 JSON / 数组 / 超长 / 未知类型全部拒绝', () => {
  assert.equal(parseClientMessage('not json').ok, false);
  assert.equal(parseClientMessage('[1,2]').ok, false);
  assert.equal(parseClientMessage('null').ok, false);
  const tooLong = parseClientMessage('{"type":"ping","pad":"' + 'x'.repeat(5_000) + '"}');
  assert.equal(tooLong.ok, false);
  assert.equal(tooLong.ok === false && tooLong.code, 'MESSAGE_TOO_LARGE');
  const unknown = parseClientMessage('{"type":"set_money","money":999999}');
  assert.equal(unknown.ok, false);
  assert.equal(unknown.ok === false && unknown.code, 'UNKNOWN_TYPE');
});

test('parseClientMessage：超长判定按字节而非字符（中文也算 3 字节）', () => {
  const r = parseClientMessage('{"type":"ping","x":"' + '中'.repeat(100) + '"}', 100);
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, 'MESSAGE_TOO_LARGE');
});

test('encodeServerMessage：hello 结构完整、可被 JSON 解析', () => {
  const raw = encodeServerMessage({
    type: 'hello',
    protocol: WS_PROTOCOL_VERSION,
    connectionId: 'c1',
    userId: 'u1',
    serverTime: 42,
    heartbeatMs: WS_HEARTBEAT_MS,
  });
  const m = JSON.parse(raw);
  assert.equal(m.type, 'hello');
  assert.equal(m.protocol, 1);
  assert.equal(m.heartbeatMs, 30_000);
});

test('buildRejectResponse：手写 HTTP 响应含状态行 / 机器码 / 正确 Content-Length', () => {
  const body = { error: '你已被封号', code: 'ACCOUNT_BANNED' };
  const raw = buildRejectResponse(403, body);
  assert.ok(raw.startsWith('HTTP/1.1 403 Forbidden\r\n'));
  assert.ok(raw.includes('Content-Type: application/json; charset=utf-8'));
  assert.ok(raw.includes('Connection: close'));
  const payload = JSON.stringify(body);
  assert.ok(raw.includes(`Content-Length: ${Buffer.byteLength(payload, 'utf8')}`));
  assert.ok(raw.endsWith('\r\n\r\n' + payload));
});

test('deadAfterMs：两个心跳周期 + 宽限期', () => {
  assert.equal(deadAfterMs(WS_HEARTBEAT_MS), WS_HEARTBEAT_MS * 2 + WS_DEAD_GRACE_MS);
});

// ——————————————— 会话登记表 ———————————————

test('WsRegistry：登记 / 计数 / 按用户列出 / 注销', () => {
  const r = new WsRegistry();
  const a = conn('a', 'u1');
  const b = conn('b', 'u1');
  const c = conn('c', 'u2');
  // P4-1a：默认上限已改为 1（顶号）。这里测的是登记表本身，显式放宽到 3。
  assert.equal(r.add(a, 3), true);
  assert.equal(r.add(b, 3), true);
  assert.equal(r.add(c, 3), true);
  assert.equal(r.size, 3);
  assert.equal(r.userCount, 2);
  assert.equal(r.countForUser('u1'), 2);
  assert.deepEqual(r.listForUser('u1').map((x) => x.id), ['a', 'b']);
  assert.equal(r.remove('a'), true);
  assert.equal(r.countForUser('u1'), 1);
  assert.equal(r.remove('a'), false, '重复注销应返回 false');
  assert.equal(r.userCount, 2);
  assert.equal(r.remove('b'), true);
  assert.equal(r.userCount, 1, '最后一个连接注销后应清掉用户分组');
});

test('WsRegistry：单账号连接数上限，超限不改动登记表', () => {
  const r = new WsRegistry();
  for (let i = 0; i < WS_MAX_CONNECTIONS_PER_USER; i++) {
    assert.equal(r.add(conn(`c${i}`, 'u1')), true);
  }
  assert.equal(r.canAccept('u1'), false);
  assert.equal(r.add(conn('overflow', 'u1')), false);
  assert.equal(r.size, WS_MAX_CONNECTIONS_PER_USER);
  assert.equal(r.get('overflow'), undefined);
  assert.equal(r.canAccept('u2'), true, '上限按账号隔离，不影响别人');
});

test('WsRegistry：重复 id 不允许覆盖已有连接', () => {
  const r = new WsRegistry();
  assert.equal(r.add(conn('same', 'u1')), true);
  assert.equal(r.add(conn('same', 'u2')), false);
  assert.equal(r.size, 1);
});

test('WsRegistry：findStale 找出无 pong / 超时连接', () => {
  const r = new WsRegistry();
  const fresh = conn('fresh', 'u1', 10_000);
  const dead = conn('dead', 'u1', 0);
  dead.alive = false;
  const old = conn('old', 'u2', 0);
  old.lastSeenAt = 1;
  r.add(fresh, 3); r.add(dead, 3); r.add(old, 3);
  const stale = r.findStale(10_000, 1_000).map((c) => c.id).sort();
  assert.deepEqual(stale, ['dead', 'old']);
});

test('WsRegistry：broadcastToUser 只发给该用户的 OPEN 连接', () => {
  const r = new WsRegistry();
  const a = conn('a', 'u1');
  const b = conn('b', 'u1');
  const c = conn('c', 'u2');
  c.socket.readyState = 3; // CLOSED
  r.add(a, 3); r.add(b, 3); r.add(c, 3);
  assert.equal(r.broadcastToUser('u1', '{"type":"pong"}'), 2);
  assert.equal(a.socket.sent[0], '{"type":"pong"}');
  assert.equal(b.socket.sent[0], '{"type":"pong"}');
  assert.equal(c.socket.sent.length, 0);
  assert.equal(r.broadcastToUser('u2', 'x'), 0, 'CLOSED 连接不发送');
});

test('WsRegistry：clear 清空全部索引', () => {
  const r = new WsRegistry();
  r.add(conn('a', 'u1'));
  r.add(conn('b', 'u2'));
  r.clear();
  assert.equal(r.size, 0);
  assert.equal(r.userCount, 0);
  assert.deepEqual(r.all(), []);
});

// ——————————————— P4-1a 顶号 / P4-1b 全量广播 ———————————————

test('WsRegistry：takeover 原子顶号，旧连接全部返回且只剩新连接在线', () => {
  const r = new WsRegistry();
  const a = conn('a', 'u1');
  const b = conn('b', 'u1');
  const c = conn('c', 'u2');
  r.add(a, 3); r.add(b, 3); r.add(c, 3);
  const fresh = conn('fresh', 'u1');
  const evicted = r.takeover(fresh);
  assert.deepEqual(evicted.map((x) => x.id).sort(), ['a', 'b']);
  assert.equal(r.countForUser('u1'), 1, '顶号后同账号只能有一条连接');
  assert.equal(r.get('fresh')?.id, 'fresh');
  assert.equal(r.get('a'), undefined);
  assert.equal(r.size, 2, '其他账号的连接不受影响');
  assert.equal(r.broadcastToUser('u1', 'x'), 1);
  assert.equal(a.socket.sent.length, 0, '登记表不负责发 bye，由调用方处理');
});

test('WsRegistry：takeover 并发形状下不会双登记', () => {
  const r = new WsRegistry();
  const x = conn('x', 'u1');
  const y = conn('y', 'u1');
  // 模拟两个几乎同时到达的握手：两个 takeover 顺序执行，最终只有后者在线
  assert.equal(r.takeover(x).length, 0);
  const evicted = r.takeover(y);
  assert.deepEqual(evicted.map((c) => c.id), ['x']);
  assert.equal(r.countForUser('u1'), 1);
  assert.equal(r.size, 1);
});

test('WsRegistry：broadcastAll 跨账号全量送达，跳过非 OPEN 连接', () => {
  const r = new WsRegistry();
  const a = conn('a', 'u1');
  const b = conn('b', 'u2');
  const c = conn('c', 'u3');
  c.socket.readyState = 3;
  r.add(a); r.add(b); r.add(c);
  assert.equal(r.broadcastAll('{"type":"wild.state"}'), 2);
  assert.equal(a.socket.sent[0], '{"type":"wild.state"}');
  assert.equal(b.socket.sent[0], '{"type":"wild.state"}');
  assert.equal(c.socket.sent.length, 0);
});
