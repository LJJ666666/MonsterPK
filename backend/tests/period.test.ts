/**
 * F01 榜单周期纯函数单测。
 * 运行：cd backend && npx tsx --test tests/period.test.ts
 *
 * 重点：固定 UTC+8 不依赖宿主机时区、与 P4-2c `dayKeyOf()` 完全同源、
 * 半开区间边界、跨月 / 跨年 / 闰年、已结束判定与批量补结算键。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  periodKeyOf, parsePeriodKey, periodBounds, isPeriodClosed,
  previousPeriodKey, recentClosedPeriodKeys,
  PERIOD_OFFSET_MINUTES, PERIOD_LENGTH_MS,
} from '../src/game/period.js';
import { dayKeyOf } from '../src/game/boss.js';

test('periodKeyOf：固定 UTC+8，UTC 16:00 就是次日 00:00', () => {
  assert.equal(periodKeyOf(Date.UTC(2026, 10, 8, 16, 0, 0)), '2026-11-09');
  assert.equal(periodKeyOf(Date.UTC(2026, 10, 8, 15, 59, 59)), '2026-11-08');
  assert.equal(periodKeyOf(Date.UTC(2026, 0, 1, 0, 0, 0)), '2026-01-01');
  assert.equal(PERIOD_OFFSET_MINUTES, 480);
});

test('periodKeyOf：与 Boss 每日次数的 dayKeyOf 完全同源（含自定义偏移）', () => {
  const stamps = [
    Date.UTC(2026, 0, 1, 0, 0, 0),
    Date.UTC(2026, 1, 28, 23, 59, 59),
    Date.UTC(2024, 1, 29, 16, 0, 0), // 闰日
    Date.UTC(2026, 10, 8, 16, 0, 0),
    Date.UTC(2026, 11, 31, 15, 59, 59),
  ];
  for (const t of stamps) assert.equal(dayKeyOf(t), periodKeyOf(t), `t=${t}`);
  assert.equal(dayKeyOf(stamps[3], 0), periodKeyOf(stamps[3], 0));
});

test('parsePeriodKey：只接受真实存在的 YYYY-MM-DD', () => {
  assert.deepEqual(parsePeriodKey('2026-11-09'), { year: 2026, month: 11, day: 9 });
  assert.deepEqual(parsePeriodKey('2024-02-29'), { year: 2024, month: 2, day: 29 });
  for (const bad of [
    '2026-02-30', '2026-13-01', '2026-00-10', '2026-1-1',
    '2026/11/09', 'not-a-date', '', 20261109, null, undefined, {},
  ]) {
    assert.equal(parsePeriodKey(bad), null, `应拒绝 ${String(bad)}`);
  }
});

test('periodBounds：UTC+8 的 00:00 = 前一天 UTC 16:00，半开区间', () => {
  const b = periodBounds('2026-11-09');
  assert.ok(b);
  assert.equal(b!.startMs, Date.UTC(2026, 10, 8, 16, 0, 0));
  assert.equal(b!.endMs, b!.startMs + PERIOD_LENGTH_MS);
  assert.equal(periodBounds('2026-02-30'), null);
});

test('isPeriodClosed：边界严格，进行中的周期不得结算', () => {
  const b = periodBounds('2026-11-09')!;
  assert.equal(isPeriodClosed('2026-11-09', b.startMs), false);
  assert.equal(isPeriodClosed('2026-11-09', b.endMs - 1), false);
  assert.equal(isPeriodClosed('2026-11-09', b.endMs), true);
  assert.equal(isPeriodClosed('2026-11-09', b.endMs + 1), true);
  assert.equal(isPeriodClosed('坏键', b.endMs + 1), false);
});

test('previousPeriodKey：跨月 / 跨年 / 闰年都正确', () => {
  const at = (key: string) => periodBounds(key)!.startMs; // 周期刚开始 → 最近已结束的是前一天
  assert.equal(previousPeriodKey(at('2026-11-09')), '2026-11-08');
  assert.equal(previousPeriodKey(at('2026-11-01')), '2026-10-31');
  assert.equal(previousPeriodKey(at('2027-01-01')), '2026-12-31');
  assert.equal(previousPeriodKey(at('2024-03-01')), '2024-02-29');
});

test('recentClosedPeriodKeys：倒序、无重复、上限 31', () => {
  const now = periodBounds('2026-11-09')!.endMs;
  assert.deepEqual(recentClosedPeriodKeys(now, 3), ['2026-11-09', '2026-11-08', '2026-11-07']);
  assert.equal(new Set(recentClosedPeriodKeys(now, 40)).size, 31);
  assert.deepEqual(recentClosedPeriodKeys(now, 1), ['2026-11-09']);
});

test('periodKeyOf：非法时间回落当前时间且仍产出合法键', () => {
  assert.ok(parsePeriodKey(periodKeyOf(NaN)));
  assert.ok(parsePeriodKey(periodKeyOf(Infinity)));
});
