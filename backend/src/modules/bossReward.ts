/**
 * F14 Boss 双档奖励发放（服务端唯一写入口）。
 *
 * 权威口径（与 F02 `rankSettlement.ts::grantOne` 同范式）：
 *  - 账号锁串行 → **唯一键占位** → `readSave()` → `applyPlayReward()` → 同步
 *    `authority.expected = digestOf(新档)` → `commitState(source='action')` → 回填 revision。
 *    顺序不可颠倒：先写档再插记录，插入冲突时奖励已经进档会凭空多发一份。
 *  - 每场小包幂等键 = `battleId`（与 `BossDamageEvent` 同一场战斗唯一）；
 *    每日首讨大包幂等键 = `(userId, bossId, periodKey)`。
 *  - 只有 `enemy_fainted` 才发：逃跑已在 `settleBossRun` 提前返回，全灭不发安慰奖
 *    （杰哥 2026-11-09「按上表默认」，上表口径即只打赢发）。
 *  - 客户端没有任何领取 / 上报入口；发放失败只记日志、不阻断战斗结束响应，
 *    占位记录会被删除，下次同场结算可补发。
 *  - 不动 `SCHEMA_VERSION` / `EXPECTED_SAVE_VERSION` / 战斗公式 / 榜单。
 */
import { prisma } from '../lib/prisma';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { digestOf, type AuthorityState } from '../lib/authority';
import { readSave } from './saveRead';
import { commitState } from './session';
import {
  BOSS_FIRST_REWARD, BOSS_PER_RUN_REWARD, applyPlayReward, playRewardView,
  sumPlayRewards, perRunGrantKey, firstGrantKey, type PlayReward,
} from '../game/playReward';
// 键格式是规则不是 IO，真源在 game 层；这里 re-export 保持既有调用点不变。
export { perRunGrantKey, firstGrantKey } from '../game/playReward';

export type GrantState = 'granted' | 'skipped' | 'failed';

export type BossRewardResult = {
  eligible: boolean;
  reason: 'win' | 'not_win';
  perRun: GrantState;
  first: GrantState;
  /** 本次实际发放的合计（只读展示，不参与判定）；非获胜为 null。 */
  reward: ReturnType<typeof playRewardView> | null;
};

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}

/** 单笔发放；调用方已持有该账号的锁。 */
async function grantOne(p: {
  grantKey: string;
  tier: 'per_run' | 'first';
  userId: string;
  bossId: string;
  periodKey: string;
  battleId: string;
  reward: PlayReward;
  nowIso: string;
}): Promise<GrantState> {
  const { grantKey, userId } = p;
  const existing = await prisma.bossRewardGrant.findUnique({ where: { grantKey } });
  if (existing) return 'skipped';

  let recordId: number;
  try {
    const created = await prisma.bossRewardGrant.create({
      data: {
        userId: p.userId,
        bossId: p.bossId,
        periodKey: p.periodKey,
        tier: p.tier,
        grantKey,
        battleId: p.battleId,
        reward: JSON.stringify(playRewardView(p.reward)),
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
      await prisma.bossRewardGrant.delete({ where: { id: recordId } });
      return 'skipped';
    }
    const raw = applyPlayReward(row.raw, p.reward, p.nowIso);
    // 关键：发奖是服务端写入，必须同步权威摘要期望值，否则玩家下一次
    // 整包 PUT 会被判「金币高于服务端裁决值」而 400。
    const authority: AuthorityState = {
      ...row.authority,
      expected: digestOf(raw),
      revision: row.authority.revision + 1,
      pending: null,
    };
    const committed = await commitState(userId, {
      data: raw,
      schemaVersion: row.schemaVersion,
      clientId: row.clientId,
      authority,
      source: 'action',
    });
    await prisma.bossRewardGrant.update({
      where: { id: recordId },
      data: { revision: committed.revision },
    });
    return 'granted';
  } catch {
    await prisma.bossRewardGrant.delete({ where: { id: recordId } }).catch(() => undefined);
    return 'failed';
  }
}

/**
 * 结算一场 Boss 讨伐的两档奖励。调用方（`settleBossRun`）应 try/catch，
 * 发放异常只记日志、不阻断战斗结束响应。
 */
export async function grantBossRewards(params: {
  userId: string;
  bossId: string;
  periodKey: string;
  battleId: string;
  result: string;
  now?: number;
  /**
   * 调用方已持有 `slotLockKey(userId)` 时置 true（如 `/api/battle/action` 路由层）。
   * `withSlotLock` 是**单 key 链式队列、不可重入**，重入会自我死锁（见 slotLock.ts 头注释）。
   * 默认 false：独立调用（脚本 / 补发）时自己加锁，保证 read→commit 原子。
   */
  alreadyLocked?: boolean;
}): Promise<BossRewardResult> {
  const { userId, bossId, periodKey, battleId, result } = params;
  const base: BossRewardResult = {
    eligible: false, reason: 'not_win', perRun: 'skipped', first: 'skipped', reward: null,
  };
  if (result !== 'enemy_fainted') return base;

  const nowIso = new Date(params.now ?? Date.now()).toISOString();
  const run = async (): Promise<BossRewardResult> => {
    const common = { userId, bossId, periodKey, battleId, nowIso };
    const perRun = await grantOne({
      ...common,
      grantKey: perRunGrantKey(battleId),
      tier: 'per_run',
      reward: BOSS_PER_RUN_REWARD,
    });
    const first = await grantOne({
      ...common,
      grantKey: firstGrantKey(userId, bossId, periodKey),
      tier: 'first',
      reward: BOSS_FIRST_REWARD,
    });
    const granted: PlayReward[] = [];
    if (perRun === 'granted') granted.push(BOSS_PER_RUN_REWARD);
    if (first === 'granted') granted.push(BOSS_FIRST_REWARD);
    const out: BossRewardResult = {
      eligible: true,
      reason: 'win',
      perRun,
      first,
      reward: granted.length ? playRewardView(sumPlayRewards(granted)) : null,
    };
    return out;
  };
  return params.alreadyLocked ? run() : withSlotLock(slotLockKey(userId), run);
}
