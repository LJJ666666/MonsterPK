/**
 * W0 CAS 基线抽象单测：注入 reader 生效、可恢复默认；不实际读库。
 * W2 换 DB 列时只需 `setRevisionReader(...)`，调用点 save.ts / actions.ts 不动。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  setRevisionReader, getRevisionReader, readRevision,
  type RevisionBaseline,
} from '../src/lib/revisionSource';

const baseline: RevisionBaseline = {
  revision: 7,
  data: '{"locationId":"town_starter"}',
  schemaVersion: '11',
  clientId: 'client-1',
  updatedAt: 1_700_000_000_000,
};

test('注入的 reader 成为唯一基线来源，null 语义保留', async () => {
  const seen: string[] = [];
  setRevisionReader(async (uid) => {
    seen.push(uid);
    return uid === 'u1' ? baseline : null;
  });
  assert.equal(typeof getRevisionReader(), 'function');
  assert.deepEqual(await readRevision('u1'), baseline);
  assert.equal(await readRevision('nobody'), null);
  assert.deepEqual(seen, ['u1', 'nobody']);
});

test('传 null 恢复默认 currentState 实现（不触发 DB 查询）', () => {
  setRevisionReader(null);
  assert.equal(getRevisionReader(), null);
});
