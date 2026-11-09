/**
 * F16 共斗六房副本通关奖励发放（服务端唯一写入口，规范 §30.7）。
 *
 * 权威口径（复用 §29.2 / F14 `bossReward.ts::grantOne` 范式）：
 *  - 槽位锁串行 → **唯一键占位** → `readSave()` → `applyPlayReward()` → 同步
 *    `authority.expected = digestOf(新档)` → `commitState(source='action')` → 回填 revision。
 *    顺序不可颠倒：先写档再插记录，插入冲突时奖励已经进档会凭空多发一份。
 *  - **只给通关且有实际贡献者发**：`result === 'win'` 且累计有效伤害 >=
 *    `COOP_MIN_CONTRIBUTION`（默认 > 0）。纯进房挂机 / 全程 idle 不发；刻意不要求
 *    「至少清 1 房」，否则与「一人全杀光都行」冲突。
 *  - **每日通关上限**（默认 3）：以 `CoopRewardGrant` 按 (userId, slot, periodKey)
 *    落库计数为真值，服务重启不重置；内存 quota 只记在途 hold。
 *  - 幂等键 `(roomId, userId, slot)`：同一场副本重复结算不双花。
 *  - ⚠️ **不要传 `alreadyLocked: true`**：`settleCoopRoom()` 由 `maybeSettleCoop()`
 *    在**房间锁** `room:<roomId>` 内调用，并不持有 `userId:slot` 槽位锁。
 *    本函数自己取槽位锁，否则并发写档无保护（§30.7 明确警告）。
 *  - 客户端没有任何领取 / 上报入口；发放失败只记日志、不阻断副本结束响应，
 *    占位记录会被删除，下次同场结算可补发。
 *  - 不动 `SCHEMA_VERSION` / `EXPECTED_SAVE_VERSION` / 战斗公式 / 四张派生榜 /
 *    Boss 伤害榜；共斗伤害不写 `BossDamageEvent`。
 */
import { prisma } from '../lib/prisma';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { digestOf, type AuthorityState } from '../lib/authority';
import { readSave } from './saveRead';
import { commitState } from './session';
import { periodKeyOf } from '../game/period';
import { COOP_DAILY_CLEAR_LIMIT, COOP_MIN_CONTRIBUTION } from '../game/coop';
import {
  COOP_CLEAR_REWARD, applyPlayReward, playRewardView, coopClearGrantKey,
} from '../game/playReward';

export type CoopGrantState = 'granted' | 'skipped' | 'failed';
export type CoopRewardReason =
  | 'win' | 'not_win' | 'no_contribution' | 'daily_limit' | 'already_granted';

export type CoopRewardResult = {
  eligible: boolean;
  reason: CoopRewardReason;
  state: CoopGrantState;
  /** 本次实际发放的合计（只读展示，不参与判定）。 */
  reward: ReturnType<typeof playRewardView> | null;
};

type GrantOutcome = { state: CoopGrantState; detail: 'ok' | 'already' | 'limit' | 'no_save' | 'failed' };

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/** 单笔发放；调用方已持有该账号该槽位的锁。 */
async function grantOne(p: {
  roomId: string;
  userId: string;
  slot: number;
  periodKey: string;
  contribution: number;
  nowIso: string;
}): Promise<GrantOutcome> {
  const grantKey = coopClearGrantKey(p.roomId, p.userId, p.slot);
  const existing = await prisma.coopRewardGrant.findUnique({ where: { grantKey } });
  if (existing) return { state: 'skipped', detail: 'already' };

  // 每日通关上限：落库记录是真值（同一场重复结算已由上一步跳过）。
  const used = await prisma.coopRewardGrant.count({
    where: { userId: p.userId, slot: p.slot, periodKey: p.periodKey },
  });
  if (used >= COOP_DAILY_CLEAR_LIMIT) return { state: 'skipped', detail: 'limit' };

  let recordId: number;
  try {
    const created = await prisma.coopRewardGrant.create({
      data: {
        roomId: p.roomId,
        userId: p.userId,
        slot: p.slot,
        periodKey: p.periodKey,
        contribution: Math.max(0, Math.floor(p.contribution)),
        grantKey,
        reward: JSON.stringify(playRewardView(COOP_CLEAR_REWARD)),
        revision: 0,
      },
    });
    recordId = created.id;
  } catch (e) {
    if (isUniqueViolation(e)) return { state: 'skipped', detail: 'already' };
    throw e;
  }

  try {
    const row = await readSave(p.userId, p.slot);
    if (!row) {
      await prisma.coopRewardGrant.delete({ where: { id: recordId } });
      return { state: 'skipped', detail: 'no_save' };
    }
    const raw = applyPlayReward(row.raw, COOP_CLEAR_REWARD, p.nowIso);
    // 关键：发奖是服务端写入，必须同步权威摘要期望值，否则玩家下一次
    // 整包 PUT 会被判「金币高于服务端裁决值」而 400。
    const authority: AuthorityState = {
      ...row.authority,
      expected: digestOf(raw),
      revision: row.authority.revision + 1,
      pending: null,
    };
    const committed = await commitState(p.userId, p.slot, {
      data: raw,
      schemaVersion: row.schemaVersion,
      clientId: row.clientId,
      authority,
      source: 'action',
    });
    await prisma.coopRewardGrant.update({
      where: { id: recordId },
      data: { revision: committed.revision },
    });
    return { state: 'granted', detail: 'ok' };
  } catch {
    await prisma.coopRewardGrant.delete({ where: { id: recordId } }).catch(() => undefined);
    return { state: 'failed', detail: 'failed' };
  }
}

/**
 * 结算一名成员的副本通关奖励。调用方应 try/catch，发放异常只记日志、
 * 不阻断副本结束响应。
 */
export async function grantCoopClearReward(params: {
  roomId: string;
  userId: string;
  slot: number;
  contribution: number;
  result: 'win' | 'lose' | null;
  now?: number;
}): Promise<CoopRewardResult> {
  const { roomId, userId, slot, contribution, result } = params;
  const base: CoopRewardResult = {
    eligible: false, reason: 'not_win', state: 'skipped', reward: null,
  };
  if (result !== 'win') return base;
  if (!Number.isFinite(contribution) || contribution < COOP_MIN_CONTRIBUTION) {
    return { ...base, reason: 'no_contribution' };
  }

  const nowMs = params.now ?? Date.now();
  const periodKey = periodKeyOf(nowMs);
  const nowIso = new Date(nowMs).toISOString();

  // ⚠️ 这里必须自己取槽位锁：调用链只持有房间锁，不持有 userId:slot 锁。
  return withSlotLock(slotLockKey(userId, slot), async () => {
    const out = await grantOne({ roomId, userId, slot, periodKey, contribution, nowIso });
    const reason: CoopRewardReason = out.detail === 'limit' ? 'daily_limit'
      : out.detail === 'already' ? 'already_granted'
        : 'win';
    return {
      eligible: true,
      reason,
      state: out.state,
      reward: out.state === 'granted' ? playRewardView(COOP_CLEAR_REWARD) : null,
    } satisfies CoopRewardResult;
  });
}
