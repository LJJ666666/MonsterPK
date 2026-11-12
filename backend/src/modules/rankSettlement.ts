/**
 * F01 榜单周期结算 + F02 榜单奖励发放（服务端唯一写入口）。
 *
 * 权威口径：
 *  - **只有已结束的周期能结算**：进行中的周期提前定榜会让人刷名次 / 刷奖励。
 *  - **快照幂等可重跑**：(periodKey, boardKey) 唯一键，重跑不覆盖首次快照；
 *    奖励逐条按 (periodKey, boardKey, userId) 唯一键补发，中途失败可续跑。
 *  - **发奖只由服务端写档**：走 readSave → applyRankReward → 同步 authority.expected
 *    → commitState，客户端没有任何「领取」入口，也没有任何奖励数值上报口。
 *  - **不新增权威源**：四张派生榜仍从 Save 落库真值派生；Boss 伤害榜仍只认
 *    append-only 事件；封号 / 管理员沿用 P4-2a、P4-2c 的排除口径。
 *
 * ⚠️ MVP 边界（写进台账，别夸大）：四张派生榜按**结算时刻**的落库真值定格，
 * 因 Save 表只存当前版本、没有历史快照；因此生产应在周期结束点准时跑结算脚本。
 * Boss 伤害榜按 `BossDamageEvent.periodKey` 精确归档，补跑也不失真。
 */
import { prisma } from '../lib/prisma';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { digestOf, type AuthorityState } from '../lib/authority';
import { parsePeriodKey, isPeriodClosed } from '../game/period';
import {
  SETTLE_BOARDS, parseBoardKey, rewardFor, applyRankReward, rewardView,
  boardLabel, REWARD_MAX_RANK, type RankReward,
} from '../game/rankReward';
import { buildBoard, RANK_META, type RankRow } from '../game/rank';
import { buildBossBoard, type BossRankRow, type BossRunRow } from '../game/bossRank';
import { loadRankSources } from './rank';
import { readSave } from './saveRead';
import { commitState } from './session';

/** 快照最多保留前 50 名，与既有榜单 limit 上限一致。 */
export const SNAPSHOT_LIMIT = 50;

export type RewardCandidate = {
  rank: number;
  username: string;
  value: number;
  userId: string;
};

type BoardSnapshot = {
  boardKey: string;
  label: string;
  entries: RankRow[] | BossRankRow[];
  eligible: number;
  skipped: number;
  candidates: RewardCandidate[];
};

export type SettleResult = {
  ok: boolean;
  periodKey: string;
  code?: string;
  reason?: string;
  boards: number;
  snapshotsCreated: number;
  rewardsGranted: number;
  rewardsSkipped: number;
  rewardsFailed: number;
  settledAt: string;
};

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/**
 * 生成一张榜的结算快照。
 * `RankRow` / `BossRankRow` 都是**不含 userId 的公开视图**（P4-2a E2E 钉过口径），
 * 因此额外用 username 反查内部 userId 作为发奖候选，绝不把 userId 写进快照。
 */
async function snapshotOf(boardKey: string, periodKey: string): Promise<BoardSnapshot> {
  const parsed = parseBoardKey(boardKey);
  if (!parsed) throw new Error(`UNKNOWN_BOARD:${boardKey}`);

  if (parsed.kind === 'rank') {
    const { sources, eligible, skipped } = await loadRankSources();
    const entries = buildBoard(parsed.type, sources, SNAPSHOT_LIMIT);
    const idOf = new Map(sources.map((s) => [s.username, s.userId]));
    const candidates: RewardCandidate[] = entries.map((e) => ({
      rank: e.rank,
      username: e.username,
      value: e.value,
      userId: idOf.get(e.username) ?? '',
    }));
    return { boardKey, label: RANK_META[parsed.type].label, entries, eligible, skipped, candidates };
  }

  const events = await prisma.bossDamageEvent.findMany({
    where: { bossId: parsed.id, periodKey },
    select: { userId: true, damage: true, createdAt: true },
  });
  const ids = Array.from(new Set(events.map((e) => e.userId)));
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, bannedAt: null, role: { not: 'admin' } },
        select: { id: true, username: true },
      })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  const idByUsername = new Map(users.map((u) => [u.username, u.id]));
  const rows: BossRunRow[] = events
    .filter((e) => nameOf.has(e.userId))
    .map((e) => ({
      userId: e.userId,
      username: nameOf.get(e.userId)!,
      damage: e.damage,
      createdAt: e.createdAt.getTime(),
    }));
  const entries = buildBossBoard(rows, SNAPSHOT_LIMIT);
  const candidates: RewardCandidate[] = entries.map((e) => ({
    rank: e.rank,
    username: e.username,
    value: e.damage,
    userId: idByUsername.get(e.username) ?? '',
  }));
  return {
    boardKey, label: boardLabel(boardKey), entries,
    eligible: users.length, skipped: events.length - rows.length, candidates,
  };
}

/**
 * 单笔奖励发放（账号锁串行）。
 * 顺序：唯一键占位 → 读档 → 写档 → 回填 revision；任一步失败删除占位以便重跑补发。
 * 不能「先写档再插记录」：那样插入失败（重复）时奖励已经进档，会凭空多给一份。
 */
async function grantOne(params: {
  periodKey: string;
  boardKey: string;
  candidate: RewardCandidate;
  reward: RankReward;
}): Promise<'granted' | 'skipped' | 'failed'> {
  const { periodKey, boardKey, candidate, reward } = params;
  const { userId, rank } = candidate;
  return withSlotLock(slotLockKey(userId), async () => {
    const key = { periodKey, boardKey, userId };
    const existing = await prisma.rankReward.findUnique({
      where: { periodKey_boardKey_userId: key },
    });
    if (existing) return 'skipped';

    let recordId: number;
    try {
      const created = await prisma.rankReward.create({
        data: {
          ...key, rank,
          reward: JSON.stringify(rewardView(reward)),
          revision: 0,
        },
      });
      recordId = created.id;
    } catch (e) {
      if (isUniqueViolation(e)) return 'skipped';
      throw e;
    }

    try {
      const row = await readSave(userId);
      if (!row) {
        await prisma.rankReward.delete({ where: { id: recordId } });
        return 'skipped';
      }
      const raw = applyRankReward(row.raw, reward, new Date().toISOString());
      // 关键：发奖是服务端写入，必须同步权威摘要期望值，
      // 否则玩家下一次整包 PUT 会被判「金币高于服务端裁决值」而 400。
      const authority: AuthorityState = {
        ...row.authority,
        expected: digestOf(raw),
        pending: null,
      };
      const committed = await commitState(userId, {
        data: raw,
        schemaVersion: row.schemaVersion,
        clientId: row.clientId,
        authority,
        source: 'action',
      });
      await prisma.rankReward.update({
        where: { id: recordId },
        data: { revision: committed.revision },
      });
      return 'granted';
    } catch {
      await prisma.rankReward.delete({ where: { id: recordId } }).catch(() => undefined);
      return 'failed';
    }
  });
}

/**
 * 结算一个已结束周期。整体加结算锁，避免两个并发任务同时算同一期。
 * 重跑安全：快照不覆盖、奖励按唯一键跳过，只补发缺失项。
 */
export async function settlePeriod(periodKey: string, opts: {
  now?: number;
  grantRewards?: boolean;
} = {}): Promise<SettleResult> {
  const now = opts.now ?? Date.now();
  const nowIso = new Date(now).toISOString();
  const base: SettleResult = {
    ok: false, periodKey, boards: 0, snapshotsCreated: 0,
    rewardsGranted: 0, rewardsSkipped: 0, rewardsFailed: 0, settledAt: nowIso,
  };
  if (!parsePeriodKey(periodKey)) {
    return { ...base, code: 'RANK_PERIOD_INVALID', reason: '周期键格式应为 YYYY-MM-DD' };
  }
  if (!isPeriodClosed(periodKey, now)) {
    return { ...base, code: 'RANK_PERIOD_OPEN', reason: '当前周期尚未结束，不能提前结算' };
  }

  return withSlotLock(`rank:settle:${periodKey}`, async () => {
    const out: SettleResult = { ...base, ok: true, boards: SETTLE_BOARDS.length };
    for (const boardKey of SETTLE_BOARDS) {
      const snap = await snapshotOf(boardKey, periodKey);

      // 快照：已存在则保持首次结果，重跑不覆盖（定格语义）。
      try {
        await prisma.rankPeriodSnapshot.create({
          data: {
            periodKey, boardKey,
            entries: JSON.stringify(snap.entries),
            eligible: snap.eligible,
            skipped: snap.skipped,
          },
        });
        out.snapshotsCreated += 1;
      } catch (e) {
        if (!isUniqueViolation(e)) throw e;
      }

      if (opts.grantRewards === false) continue;
      for (const c of snap.candidates) {
        // 空榜 / 零分行不发奖；只奖励有效成绩的前 N 名。
        if (!c.userId || c.rank < 1 || c.rank > REWARD_MAX_RANK || c.value <= 0) continue;
        const reward = rewardFor(boardKey, c.rank);
        if (!reward) continue;
        const r = await grantOne({ periodKey, boardKey, candidate: c, reward });
        if (r === 'granted') out.rewardsGranted += 1;
        else if (r === 'skipped') out.rewardsSkipped += 1;
        else out.rewardsFailed += 1;
      }
    }
    return out;
  });
}

/** 已结算周期清单（只读），最新在前。 */
export async function listSettledPeriods(limit = 31) {
  const rows = await prisma.rankPeriodSnapshot.findMany({
    distinct: ['periodKey'],
    select: { periodKey: true, settledAt: true },
    orderBy: { periodKey: 'desc' },
    take: Math.min(Math.max(Math.floor(limit) || 31, 1), 31),
  });
  return rows.map((r) => ({ periodKey: r.periodKey, settledAt: r.settledAt.toISOString() }));
}

/** 某周期全部榜单快照（只读）。viewerUsername 只用于重标 isMe，不参与排序。 */
export async function loadPeriodBoards(periodKey: string, viewerUsername?: string) {
  const rows = await prisma.rankPeriodSnapshot.findMany({
    where: { periodKey },
    orderBy: { boardKey: 'asc' },
  });
  if (!rows.length) return null;
  const boards = rows.map((r) => {
    let entries: unknown[];
    try {
      const parsed = JSON.parse(r.entries);
      entries = Array.isArray(parsed) ? parsed : [];
    } catch {
      entries = [];
    }
    const marked = entries.map((e) => (
      e && typeof e === 'object' && viewerUsername
        ? { ...(e as Record<string, unknown>), isMe: (e as Record<string, unknown>).username === viewerUsername }
        : e
    ));
    return {
      boardKey: r.boardKey,
      label: boardLabel(r.boardKey),
      eligible: r.eligible,
      skipped: r.skipped,
      settledAt: r.settledAt.toISOString(),
      entries: marked,
    };
  });
  return { ok: true, periodKey, readonly: true, boards };
}

/** 我的获奖记录（只读，绝不提供领取 / 重发入口）。 */
export async function loadMyRewards(userId: string, limit = 50) {
  const rows = await prisma.rankReward.findMany({
    where: { userId },
    orderBy: { grantedAt: 'desc' },
    take: Math.min(Math.max(Math.floor(limit) || 50, 1), 50),
  });
  return {
    ok: true,
    readonly: true,
    entries: rows.map((r) => ({
      periodKey: r.periodKey,
      boardKey: r.boardKey,
      label: boardLabel(r.boardKey),
      rank: r.rank,
      reward: (() => { try { return JSON.parse(r.reward); } catch { return { money: 0, items: [] }; } })(),
      revision: r.revision,
      grantedAt: r.grantedAt.toISOString(),
    })),
  };
}
