/**
 * 服务端时钟钳制单测（P1-1b）。
 * 运行：cd backend && npx tsx --test tests/serverClock.test.ts
 *
 * 验收：改系统时间（未来时间戳）只是「不生效」，不拒绝、不封号；
 * 服务端把时间改写为自己的时钟，从而既不发放额外资源，也赢不了冲突策略。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { clampSaveTimestamps } from '../src/lib/serverClock.ts';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const SERVER_ISO = new Date(NOW).toISOString();

function save(overrides: Record<string, unknown> = {}) {
  return {
    version: '10',
    money: 100,
    party: [],
    inventory: {},
    lastSavedAt: '2026-11-05T09:59:00.000Z',
    ...overrides,
  };
}

test('正常过去时间：原样返回，不重新序列化', () => {
  const raw = JSON.stringify(save());
  const r = clampSaveTimestamps(raw, NOW);
  assert.equal(r.data, raw);
  assert.deepEqual(r.adjusted, []);
});

test('5 分钟内的正常时钟偏差：不钳制', () => {
  const raw = JSON.stringify(save({ lastSavedAt: '2026-11-05T10:04:00.000Z' }));
  assert.deepEqual(clampSaveTimestamps(raw, NOW).adjusted, []);
});

test('lastSavedAt 填 2099 年 → 改写为服务端时间', () => {
  const r = clampSaveTimestamps(JSON.stringify(save({ lastSavedAt: '2099-01-01T00:00:00.000Z' })), NOW);
  assert.deepEqual(r.adjusted, ['lastSavedAt']);
  assert.equal(JSON.parse(r.data).lastSavedAt, SERVER_ISO);
  assert.ok(Date.parse(JSON.parse(r.data).lastSavedAt) <= NOW);
});

test('idle.startedAt 填未来 → 改写为服务端时间（挂机 delta 归零，拿不到资源）', () => {
  const r = clampSaveTimestamps(JSON.stringify(save({
    idle: { areaId: 'a', areaName: 'A', level: 10, startedAt: '2099-01-01T00:00:00.000Z' },
  })), NOW);
  assert.deepEqual(r.adjusted, ['idle.startedAt']);
  assert.equal(JSON.parse(r.data).idle.startedAt, SERVER_ISO);
});

test('两个时间戳都填未来 → 两条都钳制', () => {
  const r = clampSaveTimestamps(JSON.stringify(save({
    lastSavedAt: '2099-01-01T00:00:00.000Z',
    idle: { areaId: 'a', areaName: 'A', level: 10, startedAt: '2099-01-01T00:00:00.000Z' },
  })), NOW);
  assert.deepEqual(r.adjusted.sort(), ['idle.startedAt', 'lastSavedAt']);
});

test('钳制只改时间戳，其他数值与字段原样保留', () => {
  const original = save({ lastSavedAt: '2099-01-01T00:00:00.000Z', money: 4321, collection: { a: { timesCaptured: 7 } } });
  const r = clampSaveTimestamps(JSON.stringify(original), NOW);
  const after = JSON.parse(r.data);
  assert.equal(after.money, 4321);
  assert.equal(after.collection.a.timesCaptured, 7);
  assert.equal(after.version, '10');
  assert.deepEqual(after.party, []);
});

test('非法 JSON → 原样返回，交给 saveValidator 拒绝', () => {
  const r = clampSaveTimestamps('{bad', NOW);
  assert.equal(r.data, '{bad');
  assert.deepEqual(r.adjusted, []);
});

test('顶层数组 / null → 原样返回', () => {
  assert.deepEqual(clampSaveTimestamps('[1,2]', NOW).adjusted, []);
  assert.deepEqual(clampSaveTimestamps('null', NOW).adjusted, []);
});

test('缺 lastSavedAt → 不报错、不钳制', () => {
  const raw = JSON.stringify({ version: '10', party: [], inventory: {} });
  assert.deepEqual(clampSaveTimestamps(raw, NOW).adjusted, []);
});

test('非法时间字符串 → 不钳制（只由 validator 记兼容告警）', () => {
  const raw = JSON.stringify(save({ lastSavedAt: 'not-a-date' }));
  assert.deepEqual(clampSaveTimestamps(raw, NOW).adjusted, []);
});

test('idle 不是对象时不崩溃', () => {
  const raw = JSON.stringify(save({ idle: 'oops' }));
  assert.deepEqual(clampSaveTimestamps(raw, NOW).adjusted, []);
});
