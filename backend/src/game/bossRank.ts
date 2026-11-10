/**
 * P4-2c Boss 伤害榜（纯逻辑）。
 *
 * 输入是服务端 **append-only 伤害事件**（`BossDamageEvent`），不是客户端上报值。
 * 口径：
 *  - 召唤师 = 账号，一账号一档，按账号合并伤害事件（限次按账号计）；
 *  - 主排序 = 周期内累计伤害，次排序 = 单场最高，再按用户名稳定排序；
 *  - 逃跑与放弃不产生事件，所以不会出现在统计里。
 */
export type BossRunRow = {
  userId: string;
  username: string;
  damage: number;
  createdAt: number;
};

export type BossSummary = {
  /** 周期内累计伤害。 */
  total: number;
  /** 单场最高伤害。 */
  best: number;
  /** 有效挑战次数（= 事件行数）。 */
  attempts: number;
};

export type BossRankRow = {
  rank: number;
  username: string;
  damage: number;
  best: number;
  attempts: number;
  isMe: boolean;
};

const emptySummary = (): BossSummary => ({ total: 0, best: 0, attempts: 0 });

function safeDamage(v: unknown): number {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : 0;
  return Math.min(Math.max(n, 0), 1e12);
}

/** 单账号汇总；没有记录返回全 0（前端显示「今日未挑战」）。 */
export function summarizeRuns(rows: BossRunRow[], userId: string): BossSummary {
  const out = emptySummary();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || row.userId !== userId) continue;
    const d = safeDamage(row.damage);
    out.total += d;
    out.best = Math.max(out.best, d);
    out.attempts += 1;
  }
  return out;
}

/**
 * 全服榜：按账号聚合 → 排序 → 截断。
 * `limit` 由调用方钳制（1~50），`viewerUserId` 只用于标「我」，不参与排序。
 */
export function buildBossBoard(
  rows: BossRunRow[],
  limit = 20,
  viewerUserId?: string,
): BossRankRow[] {
  const byUser = new Map<string, { username: string; summary: BossSummary }>();
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row.userId !== 'string' || typeof row.username !== 'string') continue;
    const cur = byUser.get(row.userId);
    const d = safeDamage(row.damage);
    if (!cur) {
      byUser.set(row.userId, {
        username: row.username,
        summary: { total: d, best: d, attempts: 1 },
      });
      continue;
    }
    cur.summary.total += d;
    cur.summary.best = Math.max(cur.summary.best, d);
    cur.summary.attempts += 1;
  }

  const scored = Array.from(byUser.entries()).map(([userId, v]) => ({
    userId,
    username: v.username,
    damage: v.summary.total,
    best: v.summary.best,
    attempts: v.summary.attempts,
  }));
  scored.sort((a, b) => (
    b.damage - a.damage
    || b.best - a.best
    || a.username.localeCompare(b.username)
  ));

  const cap = Math.min(Math.max(Math.floor(limit) || 20, 1), 50);
  return scored.slice(0, cap).map((row, i) => ({
    rank: i + 1,
    username: row.username,
    damage: row.damage,
    best: row.best,
    attempts: row.attempts,
    isMe: !!viewerUserId && viewerUserId === row.userId,
  }));
}
