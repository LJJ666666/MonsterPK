/**
 * F04 徽章 / 成就内容数据与加成纯函数（2026-11-10 修订口径，规范 §31）。
 *
 * 零 IO：不查库、不写档、不碰 revision。输入是服务端已落库的 id 列表，
 * 输出是只读派生值；客户端上报的任何 id 都不会进这里（modules 层负责过滤）。
 *
 * 七个徽章对齐 `src/game/data.ts::LOCATIONS` 的七个城镇，badgeId ↔ locationId
 * 映射为未来「演武堂挑战胜利发徽章」预留。改城镇名 / 加城镇时两边同步。
 */
export type BadgeSpec = {
  id: string;
  /** 徽章名，弹窗每行格式 `赤焰徽章 丨 5`。 */
  name: string;
  locationId: string;
  locationName: string;
  /** 等级加成，默认每枚 +5。 */
  levelBonus: number;
  desc: string;
};

export const BADGES: readonly BadgeSpec[] = [
  { id: 'badge_sprout', name: '青苗徽章', locationId: 'town_starter', locationName: '初心镇', levelBonus: 5, desc: '初心镇演武堂的证明，草木初生。' },
  { id: 'badge_stone', name: '磐石徽章', locationId: 'city_pebble', locationName: '坚石市', levelBonus: 5, desc: '坚石市演武堂的证明，稳如山岳。' },
  { id: 'badge_leaf', name: '翠羽徽章', locationId: 'town_leafy', locationName: '绿叶镇', levelBonus: 5, desc: '绿叶镇演武堂的证明，林间疾风。' },
  { id: 'badge_spring', name: '流泉徽章', locationId: 'city_spring', locationName: '涌泉市', levelBonus: 5, desc: '涌泉市演武堂的证明，流水不绝。' },
  { id: 'badge_flame', name: '赤焰徽章', locationId: 'town_sun', locationName: '烈阳镇', levelBonus: 5, desc: '烈阳镇演武堂的证明，赤焰不熄。' },
  { id: 'badge_shadow', name: '幽玄徽章', locationId: 'city_shadow', locationName: '幽影市', levelBonus: 5, desc: '幽影市演武堂的证明，幽玄难测。' },
  { id: 'badge_frost', name: '霜华徽章', locationId: 'town_winter', locationName: '凛冬镇', levelBonus: 5, desc: '凛冬镇演武堂的证明，霜华凛冽。' },
] as const;

export const BADGE_BY_ID: Readonly<Record<string, BadgeSpec>> = Object.freeze(
  Object.fromEntries(BADGES.map((b) => [b.id, b])),
);
export const BADGE_BY_LOCATION: Readonly<Record<string, BadgeSpec>> = Object.freeze(
  Object.fromEntries(BADGES.map((b) => [b.locationId, b])),
);

/** 过滤未知 / 重复 id：DB 唯一键已保证不重复，这里再兜一层脏数据。 */
export function knownBadgeIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || seen.has(id) || !BADGE_BY_ID[id]) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** 徽章等级加成总和（弹窗顶部「总等级加成」真值）。 */
export function badgeLevelBonusOf(ids: readonly unknown[]): number {
  return knownBadgeIds(ids).reduce((sum, id) => sum + BADGE_BY_ID[id].levelBonus, 0);
}

/** 某城镇首通对应的徽章 id；未知城镇返回 null（不抛异常）。 */
export function badgeIdForLocation(locationId: string): string | null {
  return BADGE_BY_LOCATION[locationId]?.id ?? null;
}

/**
 * 野区 areaId → 所属城镇徽章 id（V1 首通过渡口径，规范 §31.9）。
 * 内容表由调用方注入（服务端 `game/content.ts::LOCATIONS`），保持本文件零 IO / 零依赖，
 * 单测可直接塞假 LOCATIONS，不需要生成表。
 */
export function badgeIdForWildArea(
  areaId: string,
  locations: Record<string, { wildAreas?: readonly { id: string }[] }>,
): string | null {
  if (!areaId || typeof areaId !== 'string') return null;
  for (const [locationId, loc] of Object.entries(locations ?? {})) {
    if ((loc?.wildAreas ?? []).some((a) => a?.id === areaId)) {
      return badgeIdForLocation(locationId);
    }
  }
  return null;
}

// ——— 成就：只给属性加成，不给等级加成 ———

export type StatKey = 'hp' | 'atk' | 'def' | 'spAtk' | 'spDef' | 'spd';
export type StatBonus = {
  /** all = 全体幻兽；element = 仅该属性幻兽。 */
  scope: 'all' | 'element';
  element?: string;
  stat: StatKey;
  amount: number;
};
export type AchievementSpec = {
  id: string;
  name: string;
  desc: string;
  bonuses: readonly StatBonus[];
};

export const ACHIEVEMENTS: readonly AchievementSpec[] = [
  { id: 'ach_first_catch', name: '初入兽域', desc: '第一次收服幻兽。', bonuses: [{ scope: 'all', stat: 'atk', amount: 1 }] },
  { id: 'ach_veteran', name: '百战之姿', desc: '身经百战的旅行者。', bonuses: [{ scope: 'all', stat: 'atk', amount: 5 }] },
  { id: 'ach_dex_10', name: '图鉴初成', desc: '图鉴小有所成。', bonuses: [{ scope: 'all', stat: 'spd', amount: 1 }] },
  { id: 'ach_flame_runner', name: '炎行千里', desc: '与火属性伙伴同行千里。', bonuses: [{ scope: 'element', element: 'fire', stat: 'spd', amount: 1 }] },
  { id: 'ach_gym_first', name: '破阵者', desc: '首次攻破演武堂。', bonuses: [{ scope: 'all', stat: 'def', amount: 2 }] },
] as const;

export const ACHIEVEMENT_BY_ID: Readonly<Record<string, AchievementSpec>> = Object.freeze(
  Object.fromEntries(ACHIEVEMENTS.map((a) => [a.id, a])),
);

export function knownAchievementIds(ids: readonly unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    if (typeof id !== 'string' || seen.has(id) || !ACHIEVEMENT_BY_ID[id]) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/**
 * 聚合成就属性加成：同 (scope, element, stat) 合并求和，输出稳定按
 * scope → element → stat 排序，便于 UI 与单测复现。
 * V1 只做只读展示 + 纯函数计算；战斗数值接入随 F06 统一走 effectiveStats（§31.8）。
 */
export function aggregateAchievementBonuses(ids: readonly unknown[]): StatBonus[] {
  const merged = new Map<string, StatBonus>();
  for (const id of knownAchievementIds(ids)) {
    for (const b of ACHIEVEMENT_BY_ID[id].bonuses) {
      const element = b.scope === 'element' ? (b.element ?? '') : '';
      const key = `${b.scope}|${element}|${b.stat}`;
      const prev = merged.get(key);
      if (prev) prev.amount += b.amount;
      else merged.set(key, { scope: b.scope, ...(b.scope === 'element' ? { element: b.element } : {}), stat: b.stat, amount: b.amount });
    }
  }
  return [...merged.values()].sort((a, b) => (
    a.scope.localeCompare(b.scope)
    || (a.element ?? '').localeCompare(b.element ?? '')
    || a.stat.localeCompare(b.stat)
  ));
}

const STAT_LABEL: Record<StatKey, string> = {
  hp: 'HP', atk: '物攻', def: '物防', spAtk: '特攻', spDef: '特防', spd: '速度',
};
const ELEMENT_LABEL: Record<string, string> = {
  fire: '火', water: '水', grass: '草', electric: '电', ice: '冰', fighting: '格斗',
  poison: '毒', ground: '地面', flying: '飞行', psychic: '超能', bug: '虫',
  rock: '岩石', ghost: '幽灵', dragon: '龙', dark: '恶', steel: '钢', fairy: '妖精',
  normal: '一般',
};

/** UI 文案，如「全体物攻 +5」/「火属性速度 +1」。 */
export function statBonusText(b: StatBonus): string {
  const scope = b.scope === 'element'
    ? `${ELEMENT_LABEL[b.element ?? ''] ?? (b.element ?? '未知')}属性`
    : '全体';
  return `${scope}${STAT_LABEL[b.stat]} +${b.amount}`;
}
