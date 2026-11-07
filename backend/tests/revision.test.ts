/**
 * P4 写入版本校验（CAS）单测。
 * 运行：cd backend && npx tsx --test tests/revision.test.ts
 *
 * 这一层是多人同玩的地基：客户端写入必须声明「基于第几版」，
 * 版本不符一律拒绝，把 last-write-wins 收敛成 server-wins。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { checkWriteRevision, isValidRevision, type RevisionFailure } from '../src/lib/revision.ts';

/** strict:false 下判别联合不会自动收窄（bug_log §18），统一走这个助手取失败字段。 */
function fail(current: number, provided: unknown): RevisionFailure {
  const r = checkWriteRevision(current, provided);
  assert.equal(r.ok, false, '期望被判为失败');
  return r as RevisionFailure;
}

test('isValidRevision 只接受非负整数', () => {
  assert.equal(isValidRevision(0), true);
  assert.equal(isValidRevision(7), true);
  assert.equal(isValidRevision(-1), false);
  assert.equal(isValidRevision(1.5), false);
  assert.equal(isValidRevision(Number.NaN), false);
  assert.equal(isValidRevision(Number.POSITIVE_INFINITY), false);
  assert.equal(isValidRevision('3'), false);
  assert.equal(isValidRevision(null), false);
  assert.equal(isValidRevision(undefined), false);
});

test('缺省 revision → REVISION_REQUIRED（不默认成 0）', () => {
  // 关键设计：新建存档时客户端「确实」基于 0，但那必须是显式声明的 0。
  // 把缺省当 0 会让老客户端与服务端空档混淆，掩盖真正的并发问题。
  for (const provided of [undefined, null]) {
    const r = fail(0, provided);
    assert.equal(r.code, 'REVISION_REQUIRED');
    assert.match(r.reason, /revision/);
  }
});

test('非法 revision → REVISION_REQUIRED', () => {
  for (const provided of ['1', 1.2, -1, Number.NaN]) {
    const r = fail(3, provided);
    assert.equal(r.code, 'REVISION_REQUIRED');
  }
});

test('版本一致 → 放行', () => {
  assert.deepEqual(checkWriteRevision(0, 0), { ok: true });
  assert.deepEqual(checkWriteRevision(5, 5), { ok: true });
  assert.deepEqual(checkWriteRevision(123, 123), { ok: true });
});

test('版本落后 → REVISION_CONFLICT 且带回服务端当前版本', () => {
  const r = fail(6, 5);
  assert.equal(r.code, 'REVISION_CONFLICT');
  assert.equal(r.current, 6);
  assert.match(r.reason, /6/);
  assert.match(r.reason, /5/);
});

test('版本超前（客户端比服务端新）同样拒绝', () => {
  // 超前说明服务端状态被回滚过或客户端记错了，继续放行会造出「版本空洞」。
  const r = fail(2, 9);
  assert.equal(r.code, 'REVISION_CONFLICT');
  assert.equal(r.current, 2);
});

test('并发场景：两个客户端基于同一版，第二个必被拒', () => {
  const base = 4;
  assert.equal(checkWriteRevision(base, base).ok, true);           // A 先写成功（服务端变成 5）
  const second = fail(base + 1, base);                             // B 后到
  assert.equal(second.code, 'REVISION_CONFLICT');
  assert.equal(second.current, base + 1);                          // B 拿到最新版，重放即可
  assert.equal(checkWriteRevision(base + 1, second.current).ok, true); // 重放成功
});

test('新建存档：0 / 0 放行，0 / 1 视为冲突', () => {
  // 服务端还没有存档时 current = 0，客户端首次写入必须显式带 revision: 0。
  assert.equal(checkWriteRevision(0, 0).ok, true);
  assert.equal(fail(0, 1).code, 'REVISION_CONFLICT');
});
