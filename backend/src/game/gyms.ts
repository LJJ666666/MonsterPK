/**
 * F18-b 演武堂内容表 + 馆主休息冷却（2026-11-11）。
 *
 * 设计要点：
 *  - 7 座演武堂对齐 `game/badges.ts::BADGE_BY_LOCATION` 的 7 个城镇；
 *    胜利经 `modules/playerProgress.grantBadge` 发 `gym:<locationId>` 徽章（唯一写入口，幂等）。
 *  - 无次数限制，但有「馆主休息」20 分钟冷却：同一玩家同一演武堂，
 *    开局后冷却期内不能再开（防刷经验 / 金钱）。
 *  - 冷却存内存 Map，单进程有效——与 WildRegistry / 房间 quota 同口径（§5「野怪/房间/锁均单进程内存态」）。
 *    P5-1 多实例部署前统一迁共享存储。
 */

export interface GymSpec {
  /** 对应城镇 locationId，也是徽章 source 的 key。 */
  locationId: string;
  /** 馆主名（展示用）。 */
  leaderName: string;
  /** 王牌幻兽种 id（必须在 `MONSTER_SPECS` 中存在，否则 `createInstance` 抛错）。 */
  aceSpeciesId: string;
  /** 王牌等级（1~30，钳制见 `game/battle.ts::createInstance`）。 */
  aceLevel: number;
  /** 馆主休息冷却毫秒（默认 20 分钟）。 */
  cooldownMs: number;
}

export const GYM_COOLDOWN_MS = 20 * 60 * 1000;

export const GYMS: readonly GymSpec[] = [
  { locationId: 'town_starter', leaderName: '木之导师 青岚', aceSpeciesId: 'sprout_owl', aceLevel: 8, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'city_pebble', leaderName: '磐石馆主 岩岳', aceSpeciesId: 'rock_golem', aceLevel: 12, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'town_leafy', leaderName: '疾风馆主 翠翎', aceSpeciesId: 'iron_bird', aceLevel: 16, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'city_spring', leaderName: '流泉馆主 涟心', aceSpeciesId: 'tide_newt', aceLevel: 20, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'town_sun', leaderName: '赤焰馆主 焰心', aceSpeciesId: 'ember_marmot', aceLevel: 24, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'city_shadow', leaderName: '幽玄馆主 夜魅', aceSpeciesId: 'shadow_spirit', aceLevel: 28, cooldownMs: GYM_COOLDOWN_MS },
  { locationId: 'town_winter', leaderName: '霜华馆主 凛雪', aceSpeciesId: 'frost_cub', aceLevel: 30, cooldownMs: GYM_COOLDOWN_MS },
] as const;

export const GYM_BY_LOCATION: Readonly<Record<string, GymSpec>> = Object.freeze(
  Object.fromEntries(GYMS.map((g) => [g.locationId, g])),
);

export function getGym(locationId: string): GymSpec | null {
  return GYM_BY_LOCATION[locationId] ?? null;
}

// —— 馆主休息冷却（单进程内存；P5-1 迁共享存储）——
const cooldowns = new Map<string, number>(); // key: `${userId}:${locationId}` -> cooldownUntil(ms)

export function gymCooldownKey(userId: string, locationId: string): string {
  return `${userId}:${locationId}`;
}

export function gymCooldownUntil(userId: string, locationId: string): number {
  return cooldowns.get(gymCooldownKey(userId, locationId)) ?? 0;
}

export function isGymOnCooldown(userId: string, locationId: string, now: number): boolean {
  return gymCooldownUntil(userId, locationId) > now;
}

export function setGymCooldown(userId: string, locationId: string, now: number, ms = GYM_COOLDOWN_MS): void {
  cooldowns.set(gymCooldownKey(userId, locationId), now + ms);
}
