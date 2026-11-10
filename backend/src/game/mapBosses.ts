/**
 * F18-c 地图首领：内容表与纯逻辑（规范 §33.4，2026-11-10 杰哥拍板）。
 *
 * 产品口径：
 *  - 全新独立玩法层，与 P4-2c「每日 Boss（带伤害榜 + F14 双档奖励）」完全不共享：
 *    地图首领**不上任何榜单**，胜利只给「更好的资源」（稀有材料 / 特殊道具掉落）。
 *  - 按区域归属 + `locationId` 判定解锁：该城必须已在 `unlockedLocations`（持上一城徽章）。
 *  - 有每日次数上限（沿用每日 Boss 纪律，按账号 + 自然日，防刷）；次数真值记在
 *    `BossDamageEvent`（bossId=mapBossId）行数，内存只记在途 hold，进程重启不重置。
 *  - 禁捕获（MAPBOSS_UNCATCHABLE）、逃跑不上榜也不发奖。
 *
 * 本文件零 IO：不 import prisma / fastify / ws；时间（周期键）委托 period.ts 注入。
 * 与 `game/boss.ts` 同构但刻意分表：两者解锁 / 奖励 / 榜单口径不同，避免「复用普通分支」静默串味。
 */
import { MONSTER_SPECS, type ServerMonster } from './content.js';
import { clamp, createInstance, type Rng } from './rules.js';
import { periodKeyOf } from './period.js';
import { playRewardView, type PlayReward } from './playReward.js';

export type MapBossSpec = {
  /** 全局唯一 id；作为 `BossDamageEvent.bossId` 的计数键，故带 `mb_` 前缀与每日 Boss 区分。 */
  mapBossId: string;
  /** 展示名（称号 + 种族名），客户端直接渲染。 */
  name: string;
  /** 解锁门槛：该城必须已在 `unlockedLocations` 集合内（F18-a 线性解锁派生）。 */
  locationId: string;
  speciesId: string;
  level: number;
  /** HP 倍率：硬度来自这里，不靠调等级（等级影响经验/捕获率公式）。 */
  hpMultiplier: number;
  /** 战斗主题（复用既有 EncounterTheme，仅影响 UI 配色）。 */
  theme: string;
  /** 每日挑战次数上限；可被服务端 env `MAPBOSS_DAILY_LIMIT` 全局下调（不放开）。 */
  dailyLimit: number;
  description: string;
  /** 胜利掉落（稀有材料 / 特殊道具）。复用 F14 的 `PlayReward`，只增 money + inventory。 */
  drop: PlayReward;
};

/**
 * 每城一座地图首领（与 LOCATION_ORDER 的 7 城一一对应）。
 * 物种取内容表里已存在的幻兽，不新增（避免动 data.ts 与内容表同步）；
 * 数值保守：原型期玩家队伍 Lv.8~28，硬度过高会「打不过 = 没数据」。
 * drop 为暂定方案（杰哥 2026-11-10：先支撑，后续想到再补充），调数值只改本表。
 */
export const MAP_BOSSES: Record<string, MapBossSpec> = {
  mb_starter_guardian: {
    mapBossId: 'mb_starter_guardian',
    name: '萌芽守望者',
    locationId: 'town_starter',
    speciesId: 'sprout_owl',
    level: 8,
    hpMultiplier: 1.6,
    theme: 'forest',
    dailyLimit: 3,
    description: '盘踞新手镇外围的稀有头领，掉落草木精华与文柚果。',
    drop: { money: 50, items: { stone_leaf: 1, berry_sitrus: 1 } },
  },
  mb_pebble_warden: {
    mapBossId: 'mb_pebble_warden',
    name: '磐石守矿石',
    locationId: 'city_pebble',
    speciesId: 'rock_golem',
    level: 13,
    hpMultiplier: 1.8,
    theme: 'cave',
    dailyLimit: 3,
    description: '镇守矿洞深处的巨岩，掉落火之石与高级捕获器。',
    drop: { money: 60, items: { stone_fire: 1, capsule_prism: 1 } },
  },
  mb_leafy_tide: {
    mapBossId: 'mb_leafy_tide',
    name: '碧波林灵',
    locationId: 'town_leafy',
    speciesId: 'tide_newt',
    level: 16,
    hpMultiplier: 2.0,
    theme: 'lake',
    dailyLimit: 2,
    description: '林间湖泊的主宰，掉落水之石与文柚果。',
    drop: { money: 70, items: { stone_water: 1, berry_sitrus: 1 } },
  },
  mb_spring_ironwing: {
    mapBossId: 'mb_spring_ironwing',
    name: '铁翼春隼',
    locationId: 'city_spring',
    speciesId: 'iron_bird',
    level: 19,
    hpMultiplier: 2.0,
    theme: 'cave',
    dailyLimit: 2,
    description: '掠过春城的钢翼猛禽，掉落雷之石与特级捕获器。',
    drop: { money: 80, items: { stone_thunder: 1, capsule_ultra: 1 } },
  },
  mb_sun_emberlord: {
    mapBossId: 'mb_sun_emberlord',
    name: '炽炎日侯',
    locationId: 'town_sun',
    speciesId: 'ember_marmot',
    level: 22,
    hpMultiplier: 2.2,
    theme: 'volcano',
    dailyLimit: 2,
    description: '盘踞炎阳山口的火兽，掉落火之石与叶之石。',
    drop: { money: 90, items: { stone_fire: 1, stone_leaf: 1 } },
  },
  mb_shadow_phantom: {
    mapBossId: 'mb_shadow_phantom',
    name: '幽影夜主',
    locationId: 'city_shadow',
    speciesId: 'shadow_spirit',
    level: 25,
    hpMultiplier: 2.4,
    theme: 'mansion',
    dailyLimit: 1,
    description: '宅邸深处的暗影领主，掉落特级捕获器与木子果。',
    drop: { money: 100, items: { capsule_ultra: 1, berry_lum: 1 } },
  },
  mb_winter_frostbite: {
    mapBossId: 'mb_winter_frostbite',
    name: '霜寒霸主',
    locationId: 'town_winter',
    speciesId: 'frost_cub',
    level: 28,
    hpMultiplier: 2.6,
    theme: 'cave',
    dailyLimit: 1,
    description: '冰原尽头的远古霸主，掉落水之石、雷之石与大师捕获器。',
    drop: { money: 120, items: { stone_water: 1, stone_thunder: 1, capsule_master: 1 } },
  },
};

export const MAP_BOSS_IDS = Object.keys(MAP_BOSSES);

/** 解析 mapBossId；未知一律 null（路由回 400，不泄露有哪些首领）。 */
export function getMapBoss(mapBossId: unknown): MapBossSpec | null {
  if (typeof mapBossId !== 'string' || !mapBossId) return null;
  return Object.prototype.hasOwnProperty.call(MAP_BOSSES, mapBossId) ? MAP_BOSSES[mapBossId] : null;
}

/**
 * 每日次数：内容表给基准，env 只能**下调**（防止误配把次数放大成刷资源口子）。
 * 客户端永远拿不到这个函数，也传不进上限。
 */
export function mapBossDailyLimit(spec: MapBossSpec, env: NodeJS.ProcessEnv = process.env): number {
  const base = clamp(Math.floor(spec.dailyLimit) || 0, 0, 99);
  const raw = env.MAPBOSS_DAILY_LIMIT;
  if (raw === undefined || raw === '') return base;
  const n = Number(raw);
  if (!Number.isFinite(n)) return base;
  return Math.min(base, clamp(Math.floor(n), 0, 99));
}

/**
 * 周期键：固定 UTC+8 自然日 `YYYY-MM-DD`，与每日 Boss / 榜单周期完全一致
 * （委托 period.ts，换粒度只改那一处）。
 */
export function mapBossDayKey(nowMs: number, offsetMinutes = 480): string {
  return periodKeyOf(nowMs, offsetMinutes);
}

/** 次数键（内存在途闸用）：账号 + 日 + 地图首领。只作服务端内部键，不下发。 */
export function mapBossQuotaKey(userId: string, mapBossId: string, dayKey: string): string {
  return `mapboss:daily:${dayKey}:${mapBossId}:${userId}`;
}

/** 造地图首领敌人：种族与等级由内容表定，HP 按倍率放大（同 createBossEnemy 口径）。 */
export function createMapBossEnemy(spec: MapBossSpec, rng: Rng): ServerMonster {
  const base = createInstance(spec.speciesId, spec.level, rng);
  const mult = Number.isFinite(spec.hpMultiplier) && spec.hpMultiplier > 0 ? spec.hpMultiplier : 1;
  const maxHp = Math.max(base.maxHp, Math.floor(base.maxHp * mult));
  return { ...base, maxHp, hp: maxHp, status: 'none' };
}

/** 只读视图：客户端据此渲染首领列表；倍率 / 掉落数值真值不下发（drop 仅展示用）。 */
export function mapBossView(spec: MapBossSpec, dailyLimit: number, unlocked: boolean) {
  return {
    mapBossId: spec.mapBossId,
    name: spec.name,
    locationId: spec.locationId,
    speciesId: spec.speciesId,
    speciesName: MONSTER_SPECS[spec.speciesId]?.name ?? spec.speciesId,
    level: spec.level,
    theme: spec.theme,
    description: spec.description,
    dailyLimit,
    unlocked,
    drop: playRewardView(spec.drop),
  };
}
