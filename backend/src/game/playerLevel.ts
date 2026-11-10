/**
 * F04 召唤师等级 / 宠物等级帽（纯函数层，规范 §31）。
 *
 * 现行口径（杰哥 2026-11-10 修订）：
 *  - 人物等级 = 基础等级 + **徽章等级加成总和**，不是打怪经验；
 *  - 等级帽 cap = playerLevel + PLAYER_LEVEL_CAP_BONUS（默认 0，N+5 只改常量/入参）；
 *  - 超帽**不降级、只冻结升级**（不再获得经验）；
 *  - 捕获到的高等级怪**不钳等级**，原样入队，只是之后获取不到经验；
 *  - 等级 / 徽章 / 成就真值都在服务端独立表，**不写存档 JSON**。
 *
 * 零 IO：不查库、不写档、不碰 revision；所有数字都由服务端传入的 id 列表派生，
 * 不采信客户端上报的 level / cap / bonus。
 */
import {
  BADGES, BADGE_BY_ID, ACHIEVEMENT_BY_ID,
  badgeLevelBonusOf, knownBadgeIds, knownAchievementIds,
  aggregateAchievementBonuses, statBonusText,
  type StatBonus,
} from './badges.js';

/** 新账号基础等级：对齐 `game/mutations.ts::createNewSave()` 御三家 Lv.5。 */
export const BASE_PLAYER_LEVEL = 5;
/** 等级帽相对人物等级的加成；未来改 N+5 只动这里（或由 modules 层注入）。 */
export const PLAYER_LEVEL_CAP_BONUS = 0;
/** 与 `saveValidator.LEVEL_MAX` 一致，防脏数据 / 溢出。 */
export const PLAYER_LEVEL_MAX = 1000;

export type BadgeView = {
  id: string;
  name: string;
  locationName: string;
  levelBonus: number;
  desc: string;
};
export type AchievementView = {
  id: string;
  name: string;
  desc: string;
  bonusText: string[];
};
/** `GET /api/player/progress` 与 WS 投影的唯一形状（客户端只读）。 */
export type PlayerProgressView = {
  level: number;
  cap: number;
  baseLevel: number;
  badgeBonus: number;
  badgeCount: number;
  badges: BadgeView[];
  achievements: AchievementView[];
  bonuses: StatBonus[];
  readonly: true;
};

function safeInt(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.trunc(v) : fallback;
}
function clamp(v: number, min: number, max: number): number {
  return Math.min(Math.max(v, min), max);
}

/** 把任意输入钳到合法等级区间 [1, PLAYER_LEVEL_MAX]，脏数据回落基础等级。 */
export function clampLevel(v: unknown, fallback = BASE_PLAYER_LEVEL): number {
  return clamp(safeInt(v, fallback), 1, PLAYER_LEVEL_MAX);
}

/** 人物等级 = 基础等级 + 徽章加成总和；未知 / 重复徽章 id 会被过滤。 */
export function playerLevelOf(badgeIds: readonly unknown[]): number {
  return clamp(BASE_PLAYER_LEVEL + badgeLevelBonusOf(badgeIds), 1, PLAYER_LEVEL_MAX);
}

/** 宠物等级帽。capBonus 由服务端配置注入，客户端无法影响。 */
export function levelCapOf(playerLevel: number, capBonus = PLAYER_LEVEL_CAP_BONUS): number {
  return clamp(clampLevel(playerLevel) + safeInt(capBonus, 0), 1, PLAYER_LEVEL_MAX);
}

/**
 * 冻结判定：宠物当前等级 **达到或超过** 帽时不再获得经验。
 * 注意是「冻结升级」而不是「钳等级」—— 超帽老宠 / 高等级捕获怪等级原样保留。
 */
export function isLevelFrozen(monsterLevel: unknown, cap: number): boolean {
  return clampLevel(monsterLevel) >= levelCapOf(cap, 0);
}

/** 是否允许给这只宠发经验（战斗结算调用；false 时不改 exp 也不改 level）。 */
export function expGrantAllowed(monsterLevel: unknown, cap: number): boolean {
  return !isLevelFrozen(monsterLevel, cap);
}

/**
 * 捕获入队时的等级处理：**不按帽钳制**，只做合法性钳制（1..LEVEL_MAX）。
 * 例：人物 5 级抓到 Lv.50 → 仍是 50，之后因超帽而获取不到经验。
 */
export function capturedLevelOf(rawLevel: unknown, cap?: number): number {
  void cap; // 显式声明：cap 参与判定但不参与等级写入，防止后人手滑加钳制
  // 只做合法性钳制；非数字脏数据回落基础等级（与 clampLevel 默认一致）。
  return clampLevel(rawLevel);
}

/**
 * 只读进度视图：徽章列表（含等级加成）、成就列表（含属性加成文案）、聚合加成。
 * `GET /api/player/progress` 直接下发本对象；UI 与 E2E 都按同一形状断言。
 */
export function buildPlayerProgress(
  badgeIds: readonly unknown[],
  achievementIds: readonly unknown[],
  capBonus = PLAYER_LEVEL_CAP_BONUS,
): PlayerProgressView {
  const ids = knownBadgeIds(badgeIds);
  const achIds = knownAchievementIds(achievementIds);
  const level = playerLevelOf(ids);
  return {
    level,
    cap: levelCapOf(level, capBonus),
    baseLevel: BASE_PLAYER_LEVEL,
    badgeBonus: badgeLevelBonusOf(ids),
    badgeCount: ids.length,
    badges: ids.map((id) => {
      const b = BADGE_BY_ID[id];
      return { id: b.id, name: b.name, locationName: b.locationName, levelBonus: b.levelBonus, desc: b.desc };
    }),
    achievements: achIds.map((id) => {
      const a = ACHIEVEMENT_BY_ID[id];
      return { id: a.id, name: a.name, desc: a.desc, bonusText: a.bonuses.map(statBonusText) };
    }),
    bonuses: aggregateAchievementBonuses(achIds),
    readonly: true,
  };
}

/** 全部徽章（含未获得）的展示清单，供弹窗显示「未获得」灰态。 */
export function allBadgeViews(): (BadgeView & { owned: boolean })[] {
  return BADGES.map((b) => ({
    id: b.id, name: b.name, locationName: b.locationName, levelBonus: b.levelBonus,
    desc: b.desc, owned: false,
  }));
}
