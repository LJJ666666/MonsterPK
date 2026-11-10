/**
 * 玩法奖励表与写档纯函数（F14 Boss 双档 / F16 共斗通关，2026-11-09 杰哥拍板）。
 *
 * 口径：
 *  - 奖励数值是**服务端内容**，客户端拿不到也传不进来；调数值只改本文件常量，
 *    不动协议 / 存档 schema / 前端。
 *  - 发放只增 `money` 与 `inventory` 两项，绝不碰队伍 / 等级 / 图鉴 / 首通，
 *    与 F02 `applyRankReward` 完全同口径（避免奖励被判成「凭空变强」或污染战力榜）。
 *  - 本文件零 IO，可重复调用但会重复累加；幂等由调用方的 DB 唯一键 + 账号锁保证。
 *  - 刻意不改动已验收的 `rankReward.ts`：将来出现第三处发奖写档再抽公共层，
 *    两处口径必须保持一致（改动任一处要同步核对另一处）。
 *
 * 零 IO：不 import prisma / fastify / ws，时间注入便于 node:test 确定性。
 */

export type PlayReward = { money: number; items: Record<string, number> };

export class PlayRewardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'PlayRewardError';
    this.code = code;
  }
}

/**
 * F14 Boss 双档（杰哥 2026-11-09 口径：「每日首讨一份发大的，每场都发小的，
 * 但是每日有最大挑战次数」）。
 * 数值刻意低于 F02 榜一（300 金钱）：以每日 3 次的 Boss 计，全天上限
 * 100 + 20 × 3 = 160，避免「打日常比冲榜划算」。
 */
export const BOSS_FIRST_REWARD: PlayReward = {
  money: 100,
  items: { capsule_prism: 1 },
};

export const BOSS_PER_RUN_REWARD: PlayReward = {
  money: 20,
  items: { potion_small: 1 },
};

/** F16 共斗六房副本通关奖励（§30.8 默认）：只给满足最低贡献门槛的成员发（§30.7）。 */
export const COOP_CLEAR_REWARD: PlayReward = {
  money: 40,
  items: { capsule_basic: 1 },
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

const validItemId = (id: string): boolean => /^[a-z0-9_]{1,40}$/.test(id);

/** 只读展示（不暴露内部 tier 结构）；过滤非法 itemId 与非正数。 */
export function playRewardView(reward: PlayReward): {
  money: number;
  items: { itemId: string; count: number }[];
} {
  return {
    money: num(reward?.money),
    items: Object.entries(reward?.items ?? {})
      .filter(([id, n]) => validItemId(id) && typeof n === 'number' && Number.isFinite(n) && n > 0)
      .map(([itemId, count]) => ({ itemId, count: Math.floor(count) })),
  };
}

/**
 * 把奖励写进存档（纯函数，时钟注入便于单测确定性）。
 * 只增 money / inventory；非法 JSON / 非对象一律拒绝，绝不吞错后发半份奖励。
 */
export function applyPlayReward(raw: string, reward: PlayReward, nowIso = new Date().toISOString()): string {
  let save: any;
  try {
    save = JSON.parse(raw);
  } catch {
    throw new PlayRewardError('SAVE_UNREADABLE', '服务端存档不可用');
  }
  if (!save || typeof save !== 'object' || Array.isArray(save)) {
    throw new PlayRewardError('SAVE_UNREADABLE', '服务端存档结构异常');
  }
  const next: any = { ...save };
  next.money = num(next.money) + num(reward?.money);
  const inv: Record<string, number> = { ...(next.inventory ?? {}) };
  for (const [id, count] of Object.entries(reward?.items ?? {})) {
    if (!validItemId(id) || typeof count !== 'number' || !Number.isFinite(count) || count <= 0) continue;
    inv[id] = num(inv[id]) + Math.floor(count);
  }
  next.inventory = inv;
  next.lastSavedAt = nowIso;
  return JSON.stringify(next);
}

/** 合并多档奖励（回包「本次实发」展示用，不参与写档判定）。 */
export function sumPlayRewards(rewards: PlayReward[]): PlayReward {
  const out: PlayReward = { money: 0, items: {} };
  for (const r of rewards) {
    if (!r) continue;
    out.money += num(r.money);
    for (const [id, n] of Object.entries(r.items ?? {})) {
      if (!validItemId(id) || typeof n !== 'number' || !Number.isFinite(n) || n <= 0) continue;
      out.items[id] = num(out.items[id]) + Math.floor(n);
    }
  }
  return out;
}

/** 每场小包：`battleId` 全局唯一，重复结算同一场必然跳过。 */
export function perRunGrantKey(battleId: string): string {
  return `boss:run:${battleId}`;
}

/** 每日首讨大包：账号 + Boss + 周期；同日同 Boss 只有第一场胜利能占位。 */
export function firstGrantKey(userId: string, bossId: string, periodKey: string): string {
  return `boss:first:${periodKey}:${bossId}:${userId}`;
}

/**
 * F16 共斗通关：一场副本对同一账号只发一次。
 * `roomId` 本身就是房间全局唯一 id，重复结算同一副本必然撞唯一键（P2002 兜底）。
 */
export function coopClearGrantKey(roomId: string, userId: string): string {
  return `coop:clear:${roomId}:${userId}`;
}
