/**
 * GameSession 在线权威态单测（P2-2）。
 * 纯逻辑测试，不连库、不起 WS 服务；覆盖 W2 的 revision 只读缓存、hydrate、生命周期、
 * 快照构造，以及「上行不能写状态」的协议约束。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  GameSessionRegistry, buildSnapshot, isSessionExpired,
  SESSION_TTL_MS, sessionKey, type AuthorityState,
} from '../src/lib/gameSession.js';
import { parseClientMessage, WS_CAPABILITIES } from '../src/lib/wsProtocol.js';

function auth(revision = 0): AuthorityState {
  return {
    expected: {
      money: 100, inventory: {}, levelExp: {}, rosterCount: 1,
      totalCaptured: 1, clearedAreas: [], idleAreaId: null,
    },
    idleStartedAtMs: null,
    idleAreaId: null,
    idleLevel: null,
    revision,
    pending: null,
  };
}

function record(revision = 0) {
  return {
    data: '{"version":"10","party":[],"inventory":{}}',
    schemaVersion: '10',
    clientId: 'dev-1',
    authority: auth(revision),
    updatedAt: 1_700_000_000_000,
  };
}

test('sessionKey：按 userId 隔离（账号单档）', () => {
  assert.equal(sessionKey('u1'), 'u1');
  assert.notEqual(sessionKey('u1'), sessionKey('u2'));
});

test('hydrate：无 DB 记录不建会话；有记录时建立且重复 hydrate 命中内存', () => {
  const r = new GameSessionRegistry();
  assert.equal(r.hydrate('u1', null), null);
  assert.equal(r.size, 0);
  const s = r.hydrate('u1', record(7));
  assert.ok(s);
  assert.equal(s.authority.revision, 7);
  assert.equal(s.data, record().data);
  assert.equal(r.size, 1);
  const again = r.hydrate('u1', record(99));
  assert.equal(again, s, '在线期间内存即权威，不能被旧 DB 记录覆盖');
  assert.equal(again!.authority.revision, 7);
});

test('apply：W2 起 revision 由 DB 列给定，内存缓存不自行 +1', () => {
  const r = new GameSessionRegistry();
  r.hydrate('u1', record(2));
  const a = r.apply('u1', {
    data: '{"version":"10","money":100}', schemaVersion: '10', clientId: 'c1',
    authority: auth(2), source: 'put',
  }, 1_000);
  assert.equal(a.authority.revision, 2);
  assert.equal(a.source, 'put');
  const b = r.apply('u1', {
    data: '{"version":"10","money":80}', schemaVersion: '10', clientId: 'c1',
    authority: auth(3), source: 'intent',
  }, 2_000);
  assert.equal(b.authority.revision, 3);
  assert.equal(b.data, '{"version":"10","money":80}');
  assert.equal(b.updatedAt, 2_000);
});

test('apply：未 hydrate 过的账号也能由首次写入创建会话（版本原样保留）', () => {
  const r = new GameSessionRegistry();
  const s = r.apply('u9', {
    data: '{}', schemaVersion: '10', clientId: null, authority: auth(0), source: 'put',
  });
  assert.equal(s.userId, 'u9');
  assert.equal(s.authority.revision, 0);
});

test('attach / detach：连接登记到该账号会话，断线后逐一摘除', () => {
  const r = new GameSessionRegistry();
  r.hydrate('u1', record());
  r.hydrate('u2', record());
  r.attach('u1', 'conn-a');
  r.attach('u1', 'conn-b');
  assert.equal(r.get('u1')!.connections.size, 2);
  assert.equal(r.get('u2')!.connections.size, 0);
  r.detach('conn-a');
  assert.equal(r.get('u1')!.connections.size, 1);
  r.detach('conn-b');
  assert.equal(r.get('u1')!.connections.size, 0);
});

test('apply 保留既有连接登记（写入不会把在线连接弄丢）', () => {
  const r = new GameSessionRegistry();
  r.hydrate('u1', record());
  r.attach('u1', 'conn-a');
  const s = r.apply('u1', {
    data: '{}', schemaVersion: '10', clientId: null, authority: auth(5), source: 'put',
  });
  assert.equal(s.connections.size, 1);
  assert.ok(s.connections.has('conn-a'));
});

test('isSessionExpired：有连接永不回收，无连接超 TTL 才回收', () => {
  const r = new GameSessionRegistry();
  const s = r.hydrate('u1', record())!;
  s.lastActiveAt = 1_000;
  s.connections.add('conn-a');
  assert.equal(isSessionExpired(s, 1_000 + SESSION_TTL_MS * 2), false);
  s.connections.clear();
  assert.equal(isSessionExpired(s, 1_000 + SESSION_TTL_MS + 1), true);
  assert.equal(isSessionExpired(s, 1_000 + SESSION_TTL_MS - 1), false);
});

test('sweep / dropUser / stats：生命周期与在线统计', () => {
  const r = new GameSessionRegistry();
  r.hydrate('u1', record());
  r.hydrate('u2', record());
  r.attach('u1', 'c1');
  r.attach('u1', 'c2');
  r.attach('u2', 'c3');
  let st = r.stats();
  assert.deepEqual(st, { users: 2, slots: 2, online: 2, connections: 3 });
  assert.equal(r.sweep(Date.now()), 0, '有连接的会话不能被回收');
  assert.equal(r.dropUser('u1'), 1);
  st = r.stats();
  assert.deepEqual(st, { users: 1, slots: 1, online: 1, connections: 1 });
  r.detach('c3');
  r.get('u2')!.lastActiveAt = 0;
  assert.equal(r.sweep(SESSION_TTL_MS + 1), 1);
  assert.equal(r.size, 0);
});

test('listForUser：账号单档至多一个会话，不含其它账号', () => {
  const r = new GameSessionRegistry();
  r.hydrate('u1', record());
  r.hydrate('u2', record());
  assert.deepEqual(r.listForUser('u1').map((s) => s.userId), ['u1']);
  assert.deepEqual(r.listForUser('nobody'), []);
});

test('buildSnapshot：字段完整、revision 取自权威摘要、online 为连接数', () => {
  const r = new GameSessionRegistry();
  const s = r.hydrate('u1', record(4))!;
  r.attach('u1', 'c1');
  r.attach('u1', 'c2');
  const snap = buildSnapshot(s);
  assert.equal(snap.type, 'session.state');
  assert.equal(snap.revision, 4);
  assert.equal(snap.data, record().data);
  assert.equal(snap.schemaVersion, '10');
  assert.equal(snap.updatedAt, record().updatedAt);
  assert.equal(snap.online, 2);
  assert.equal(typeof JSON.parse(JSON.stringify(snap)).type, 'string');
});

test('协议：hello 能力声明包含 session.state / session.resync', () => {
  assert.ok(WS_CAPABILITIES.includes('session.state'));
  assert.ok(WS_CAPABILITIES.includes('session.resync'));
});

test('协议：session.resync 只作为「请求重推」被接受，附带字段被忽略', () => {
  const ok = parseClientMessage('{"type":"session.resync","foo":2}');
  assert.equal('code' in ok, false);
  assert.deepEqual(ok.ok ? ok.message : null, { type: 'session.resync' });
  const bad = parseClientMessage('{"type":"session.resync","foo":9,"data":"hacked"}');
  assert.equal('code' in bad, false);
  assert.deepEqual(bad.ok ? bad.message : null, { type: 'session.resync' }, '附带 data 也不会被采信');
});

test('协议：客户端伪造 session.state 上行一律 UNKNOWN_TYPE（不能写服务端状态）', () => {
  const forged = parseClientMessage('{"type":"session.state","foo":1,"revision":999,"data":"{\\"money\\":9999999}"}');
  assert.equal('code' in forged, true);
  assert.equal(forged.ok ? '' : forged.code, 'UNKNOWN_TYPE');
  assert.equal(forged.ok ? '' : forged.reason.includes('session.state'), true);
});

test('协议：P2-1 的 ping / 坏包行为不回归', () => {
  const ping = parseClientMessage('{"type":"ping","ts":123}');
  assert.deepEqual(ping.ok ? ping.message : null, { type: 'ping', ts: 123 });
  const bad = parseClientMessage('not json');
  assert.equal(bad.ok ? '' : bad.code, 'BAD_JSON');
  const arr = parseClientMessage('[]');
  assert.equal(arr.ok ? '' : arr.code, 'BAD_SHAPE');
});
