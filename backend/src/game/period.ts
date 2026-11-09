/**
 * F01 榜单周期（纯逻辑，零 IO）。
 *
 * 单一真源：固定 UTC+8 自然日 `YYYY-MM-DD`。P4-2c 的 `dayKeyOf()` 从本文件派生，
 * 保证「Boss 每日次数」「Boss 伤害事件 periodKey」「榜单周期结算」三个口径完全一致。
 * 用固定偏移而不是 `toLocaleDateString`：后者依赖宿主机时区与 ICU，换机器会漂移
 * （跨机器开发的既有坑，见 bug_log §33）。
 *
 * 周期粒度当前固定为「日」，切分规则收敛在本文件；将来换周 / 赛季只需改
 * `periodKeyOf()` / `periodBounds()`，接口与前端零改动（P4-2a 已把读模型收口）。
 */
export const PERIOD_OFFSET_MINUTES = 480;
export const PERIOD_LENGTH_MS = 24 * 60 * 60 * 1000;
export const RANK_PERIOD_GRANULARITY = 'day' as const;

export type PeriodBounds = { startMs: number; endMs: number };
export type PeriodDate = { year: number; month: number; day: number };

/** 毫秒时间戳 → 周期键；非法时间回落到当前时间，保证永远返回合法键。 */
export function periodKeyOf(nowMs: number, offsetMinutes = PERIOD_OFFSET_MINUTES): string {
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const shifted = new Date(t + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = `${shifted.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${shifted.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 严格解析 `YYYY-MM-DD`；用 UTC 回读剔除 2026-02-30 这类不存在的日期。 */
export function parsePeriodKey(key: unknown): PeriodDate | null {
  if (typeof key !== 'string') return null;
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(key);
  if (!m) return null;
  const year = Number(m[1]);
  const month = Number(m[2]);
  const day = Number(m[3]);
  if (!Number.isInteger(year) || !Number.isInteger(month) || !Number.isInteger(day)) return null;
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) return null;
  return { year, month, day };
}

/** 周期在 UTC 绝对时间轴上的 [起, 止)；UTC+8 的 00:00 = 前一天 UTC 16:00。 */
export function periodBounds(key: unknown, offsetMinutes = PERIOD_OFFSET_MINUTES): PeriodBounds | null {
  const p = parsePeriodKey(key);
  if (!p) return null;
  const startMs = Date.UTC(p.year, p.month - 1, p.day) - offsetMinutes * 60_000;
  return { startMs, endMs: startMs + PERIOD_LENGTH_MS };
}

/** 只有已结束的周期才允许结算，进行中的周期禁止提前定榜 / 发奖。 */
export function isPeriodClosed(key: unknown, nowMs: number): boolean {
  const b = periodBounds(key);
  return !!b && Number.isFinite(nowMs) && nowMs >= b.endMs;
}

/** 最近一个已结束的周期键。 */
export function previousPeriodKey(nowMs: number): string {
  const b = periodBounds(periodKeyOf(nowMs));
  return b ? periodKeyOf(b.startMs - 1) : periodKeyOf(nowMs - PERIOD_LENGTH_MS);
}

/** 最近 N 个已结束周期（从近到远），供脚本批量补结算；上限 31 防误配。 */
export function recentClosedPeriodKeys(nowMs: number, count = 2): string[] {
  const n = Math.min(Math.max(Math.floor(count) || 1, 1), 31);
  const out: string[] = [];
  let cursor = nowMs;
  for (let i = 0; i < n; i++) {
    const key = previousPeriodKey(cursor);
    out.push(key);
    const b = periodBounds(key);
    cursor = b ? b.startMs : cursor - PERIOD_LENGTH_MS;
  }
  return out;
}
