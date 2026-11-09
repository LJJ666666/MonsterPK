/**
 * F02 榜单奖励（纯逻辑，零 IO）。
 *
 * 奖励表是服务端内容的一部分：客户端拿不到也传不进来，只有 F01 的结算任务能调用。
 * 杰哥口径「名次 / 奖励内容待定」，这里先给一档**保守且集中配置**的默认值，
 * 数值全在服务端常量里，后续调数值不改协议、不改存档 schema、不改前端。
 *
 * 发放口径（台账 F02）：结算后由服务端写档，经 commitState()，客户端不得上报领取；
 * 防重复领取靠 RankReward 的 (periodKey, boardKey, userId, slot) 唯一键。
 */
import { RANK_TYPES, RANK_META, type RankType } from './rank.js';
import { BOSSES, BOSS_IDS } from './boss.js';

export type RankReward = { money: number; items: Record<string, number> };

export class RankRewardError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'RankRewardError';
    this.code = code;
  }
}

/** 只给前 N 名发奖；名次从 1 开始，空榜 / 零分行由结算层自行跳过。 */
export const REWARD_MAX_RANK = 10;

/** 单张榜的奖励档位（money 为基准值，Boss 榜按倍率放大）。 */
const REWARD_TIERS: readonly { rank: number; money: number; items: Record<string, number> }[] = [
  { rank: 1, money: 300, items: { capsule_prism: 1 } },
  { rank: 2, money: 200, items: { potion_small: 2 } },
  { rank: 3, money: 150, items: { potion_small: 2 } },
];

const CONSOLATION: { money: number; items: Record<string, number> } = {
  money: 80, items: { capsule_basic: 2 },
};

/** Boss 伤害榜奖励倍率：与单人 Boss / 共斗「刻意不发奖励」的战斗结算无关。 */
export const BOSS_REWARD_MULTIPLIER = 2;

export const RANK_BOARD_PREFIX = 'rank:';
export const BOSS_BOARD_PREFIX = 'boss:';

export function rankBoardKey(type: RankType): string { return `${RANK_BOARD_PREFIX}${type}`; }
export function bossBoardKey(bossId: string): string { return `${BOSS_BOARD_PREFIX}${bossId}`; }

export type ParsedBoardKey =
  | { kind: 'rank'; type: RankType; id: string }
  | { kind: 'boss'; type: null; id: string };

/** 解析榜单键；未知类型 / 未知 Boss 一律 null，绝不把客户端字符串拼进查询。 */
export function parseBoardKey(key: unknown): ParsedBoardKey | null {
  if (typeof key !== 'string' || key.length > 80) return null;
  if (key.startsWith(RANK_BOARD_PREFIX)) {
    const type = key.slice(RANK_BOARD_PREFIX.length);
    return (RANK_TYPES as readonly string[]).includes(type)
      ? { kind: 'rank', type: type as RankType, id: type }
      : null;
  }
  if (key.startsWith(BOSS_BOARD_PREFIX)) {
    const id = key.slice(BOSS_BOARD_PREFIX.length);
    return Object.prototype.hasOwnProperty.call(BOSSES, id)
      ? { kind: 'boss', type: null, id }
      : null;
  }
  return null;
}

/** 本期需要结算的全部榜单键：四张派生榜 + 三张 Boss 伤害榜。 */
export const SETTLE_BOARDS: readonly string[] = [
  ...RANK_TYPES.map(rankBoardKey),
  ...BOSS_IDS.map(bossBoardKey),
];

/** 榜单展示名（只读视图用，不参与判定）。 */
export function boardLabel(key: string): string {
  const p = parseBoardKey(key);
  if (!p) return key;
  return p.kind === 'rank' ? RANK_META[p.type].label : `${BOSSES[p.id].name} · 伤害榜`;
}

/** 按名次取奖励；越界 / 未知榜返回 null。 */
export function rewardFor(boardKey: string, rank: number): RankReward | null {
  const parsed = parseBoardKey(boardKey);
  if (!parsed || !Number.isInteger(rank) || rank < 1 || rank > REWARD_MAX_RANK) return null;
  const base = REWARD_TIERS.find((t) => t.rank === rank) ?? CONSOLATION;
  const mult = parsed.kind === 'boss' ? BOSS_REWARD_MULTIPLIER : 1;
  return { money: base.money * mult, items: { ...base.items } };
}

/** 奖励的只读展示（不暴露内部 tier 结构）。 */
export function rewardView(reward: RankReward): { money: number; items: { itemId: string; count: number }[] } {
  return {
    money: Math.max(0, Math.floor(reward.money)),
    items: Object.entries(reward.items)
      .filter(([id, n]) => /^[a-z0-9_]{1,40}$/.test(id) && Number.isFinite(n) && n > 0)
      .map(([itemId, count]) => ({ itemId, count: Math.floor(count) })),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/**
 * 把奖励写进存档（纯函数，时钟注入便于单测确定性）。
 * 只增 money 与 inventory 两项，绝不碰队伍 / 等级 / 首通等其它真值，
 * 避免奖励发放被误判成「凭空变强」或污染战力榜。
 */
export function applyRankReward(raw: string, reward: RankReward, nowIso = new Date().toISOString()): string {
  let save: any;
  try {
    save = JSON.parse(raw);
  } catch {
    throw new RankRewardError('SAVE_UNREADABLE', '服务端存档不可用');
  }
  if (!save || typeof save !== 'object' || Array.isArray(save)) {
    throw new RankRewardError('SAVE_UNREADABLE', '服务端存档结构异常');
  }
  const next: any = { ...save };
  next.money = num(next.money) + num(reward?.money);
  const inv: Record<string, number> = { ...(next.inventory ?? {}) };
  for (const [id, count] of Object.entries(reward?.items ?? {})) {
    if (!/^[a-z0-9_]{1,40}$/.test(id) || !Number.isFinite(count) || count <= 0) continue;
    inv[id] = num(inv[id]) + Math.floor(count);
  }
  next.inventory = inv;
  next.lastSavedAt = nowIso;
  return JSON.stringify(next);
}
