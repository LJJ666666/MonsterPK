// P4-1a 顶号：会话代次纯函数与协议常量单测。
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  checkSessionVersion, SESSION_REPLACED_CODE, BAN_CODE,
} from '../src/lib/account';
import { WS_MAX_CONNECTIONS_PER_USER } from '../src/lib/wsProtocol';

test('会话代次匹配 → 放行', () => {
  assert.deepEqual(checkSessionVersion(3, 3), { ok: true });
  assert.deepEqual(checkSessionVersion(0, 0), { ok: true });
});

test('会话代次落后 / 超前 → SESSION_REPLACED，中文原因说明是别处登录', () => {
  const r = checkSessionVersion(1, 2);
  assert.ok('code' in r);
  if ('code' in r) {
    assert.equal(r.code, SESSION_REPLACED_CODE);
    assert.match(r.reason, /其他设备/);
  }
  const newer = checkSessionVersion(5, 2);
  assert.ok('code' in newer, '客户端不可能比服务端新，一律拒绝');
});

test('老 token 没有 sv / sv 不是整数 → 要求重新登录，不算顶号弹窗文案', () => {
  for (const sv of [undefined, null, '2', 2.5, NaN, {}, true]) {
    const r = checkSessionVersion(sv, 2);
    assert.ok('code' in r, `sv=${String(sv)} 应被拒绝`);
    if ('code' in r) {
      assert.equal(r.code, SESSION_REPLACED_CODE);
      assert.match(r.reason, /重新登录/);
    }
  }
});

test('顶号与封号机器码不能混淆', () => {
  assert.notEqual(SESSION_REPLACED_CODE, BAN_CODE);
  assert.equal(SESSION_REPLACED_CODE, 'SESSION_REPLACED');
});

test('P4-1a 协议：单账号只允许一条在线连接', () => {
  assert.equal(WS_MAX_CONNECTIONS_PER_USER, 1);
});
