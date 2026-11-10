/**
 * F18-a 地图锁：服务端权威的城镇线性解锁（规范 §33）。
 *
 * - 门槛 = 持有「上一相邻城镇」徽章（BadgeGrant 真值派生，不来自客户端）。
 * - 纯函数、零 IO：输入是服务端已落库的徽章 id 列表，输出已解锁城镇集合。
 * - 客户端不上报、不决定解锁；`travel` mutation 与 PUT 防作弊都调这里，单一真源。
 * - 与演武堂（F18-b）解耦：只认 BadgeGrant 是否有该城徽章，不关心徽章来自
 *   首通（V1 `cleared:` 口径）还是演武堂胜利（F18-b `gym:` 口径）。
 */
import { badgeIdForLocation } from './badges';

/** 城镇线性解锁顺序，与 `src/game/data.ts::LOCATIONS` 的 7 城一致（按野区等级梯度排列）。 */
export const LOCATION_ORDER = [
  'town_starter', 'city_pebble', 'town_leafy', 'city_spring',
  'town_sun', 'city_shadow', 'town_winter',
] as const;

/** 解锁某城所需徽章 id；首城（town_starter）返回 null（默认已解锁）；未知城返回 null（视为锁定）。 */
export function requiredBadgeFor(locationId: string): string | null {
  const idx = (LOCATION_ORDER as readonly string[]).indexOf(locationId);
  if (idx <= 0) return null;
  const prevLoc = LOCATION_ORDER[idx - 1];
  return badgeIdForLocation(prevLoc);
}

/**
 * 基于持有徽章集合派生已解锁城镇集合。线性解锁：上一城未解锁则后续全锁。
 * 首城恒解锁；若某城所需徽章已在手，则该城与之后所有城全部解锁。
 */
export function unlockedLocations(ownedBadgeIds: readonly string[]): Set<string> {
  const owned = new Set(ownedBadgeIds);
  const unlocked = new Set<string>();
  for (const loc of LOCATION_ORDER) {
    const req = requiredBadgeFor(loc);
    if (req === null || owned.has(req)) unlocked.add(loc);
    else break;
  }
  return unlocked;
}

export function isLocationUnlocked(locationId: string, ownedBadgeIds: readonly string[]): boolean {
  return unlockedLocations(ownedBadgeIds).has(locationId);
}
