/**
 * P4-2c 单人 Boss 讨伐：内容表与纯逻辑。
 *
 * 口径（与排期文档 §4 P4-2c 对应）：
 *  - Boss 是**服务端内容表**定义的强化个体（既有幻兽种族 + 固定等级 + HP 倍率），
 *    客户端只能传 `bossId`，不能传等级 / 倍率 / 次数；
 *  - 伤害只认 `applyBattleAction()` 产生的敌方 HP 差，**不接受客户端上报**；
 *  - 每日次数上限由服务端配置，已用次数以 `BossDamageEvent` 的落库记录为真值，
 *    内存只记「在途 hold」，因此服务重启不会重置次数（房间 quota 的变体，见 `lib/bossQuota.ts`）；
 *  - 本文件零 IO：不 import prisma / fastify，时间与 RNG 全部注入。
 */
import { MONSTER_SPECS, type ServerMonster } from './content.js';
import { clamp, createInstance, type Rng } from './rules.js';

export type BossSpec = {
  bossId: string;
  /** 展示名（称号 + 种族名），客户端直接渲染。 */
  name: string;
  speciesId: string;
  level: number;
  /** HP 倍率：Boss 的硬度来自这里，不靠调高等级（等级会影响经验/捕获率公式）。 */
  hpMultiplier: number;
  /** 战斗主题（复用既有 EncounterTheme，仅影响 UI 配色）。 */
  theme: string;
  /** 每日挑战次数上限；可被服务端 env `BOSS_DAILY_LIMIT` 全局覆盖（只下调不放开）。 */
  dailyLimit: number;
  description: string;
  /**
   * 剧情解锁条件（台账 F09 占位）：MVP 不校验，字段先留好，
   * 后续接「首通某区域才开放」时不改协议、不改客户端。
   */
  unlockAreaId?: string;
};

/**
 * MVP 三只 Boss。种族取内容表里已存在的终阶幻兽，不新增幻兽（避免动 `data.ts` 与内容表同步）。
 * 数值刻意保守：原型阶段玩家队伍多在 Lv.10~20，硬度过高会让「打不过 = 没数据」。
 */
export const BOSSES: Record<string, BossSpec> = {
  boss_ember_behemoth: {
    bossId: 'boss_ember_behemoth',
    name: '烈焰巨兽 · 讨伐',
    speciesId: 'ember_behemoth',
    level: 12,
    hpMultiplier: 1.8,
    theme: 'volcano',
    dailyLimit: 3,
    description: '盘踞火山口的巨兽，皮糙肉厚，适合练手。',
  },
  boss_phantom_lord: {
    bossId: 'boss_phantom_lord',
    name: '幽冥领主 · 讨伐',
    speciesId: 'phantom_lord',
    level: 16,
    hpMultiplier: 2.2,
    theme: 'mansion',
    dailyLimit: 2,
    description: '废弃宅邸的主人，速度快、擅长消耗。',
  },
  boss_apex_dragon: {
    bossId: 'boss_apex_dragon',
    name: '霸主苍龙 · 讨伐',
    speciesId: 'apex_dragon',
    level: 22,
    hpMultiplier: 3,
    theme: 'cave',
    dailyLimit: 1,
    description: '深岩尽头的天空霸主，每天只给一次机会。',
  },
};

export const BOSS_IDS = Object.keys(BOSSES);

/** 解析 bossId；未知一律 null（路由回 400，不泄露有哪些 Boss）。 */
export function getBoss(bossId: unknown): BossSpec | null {
  if (typeof bossId !== 'string' || !bossId) return null;
  return Object.prototype.hasOwnProperty.call(BOSSES, bossId) ? BOSSES[bossId] : null;
}

/**
 * 每日次数：内容表给基准，env 只能**下调**（防止误配把次数放大成刷榜口子）。
 * 客户端永远拿不到这个函数，也传不进上限。
 */
export function bossDailyLimit(spec: BossSpec, env: NodeJS.ProcessEnv = process.env): number {
  const base = clamp(Math.floor(spec.dailyLimit) || 0, 0, 99);
  const raw = env.BOSS_DAILY_LIMIT;
  if (raw === undefined || raw === '') return base;
  const n = Number(raw);
  if (!Number.isFinite(n)) return base;
  return Math.min(base, clamp(Math.floor(n), 0, 99));
}

/**
 * 周期键：固定 UTC+8（`Asia/Shanghai`）自然日，`YYYY-MM-DD`。
 * 用固定偏移而不是 `toLocaleDateString`：后者依赖运行环境时区与 ICU，换机器会变。
 * 周期结算规则本身待设计（台账 F01），这里只保证「同一天同一键」可复现。
 */
export function dayKeyOf(nowMs: number, offsetMinutes = 480): string {
  const t = Number.isFinite(nowMs) ? nowMs : Date.now();
  const shifted = new Date(t + offsetMinutes * 60_000);
  const y = shifted.getUTCFullYear();
  const m = `${shifted.getUTCMonth() + 1}`.padStart(2, '0');
  const d = `${shifted.getUTCDate()}`.padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** 次数键：账号 + 日 + Boss。只作服务端内部键，不下发。 */
export function bossQuotaKey(userId: string, bossId: string, dayKey: string): string {
  return `boss:daily:${dayKey}:${bossId}:${userId}`;
}

/**
 * 造 Boss 敌人：种族与等级由内容表定，HP 按倍率放大（同时把 `maxHp` 抬高，
 * 否则治疗/百分比伤害会按原上限算，Boss 一被百分比技能打就破防）。
 * 其余六维保持该等级的原值 —— Boss 的威胁来自「打不完」，不是「一击秒人」。
 */
export function createBossEnemy(spec: BossSpec, rng: Rng): ServerMonster {
  const base = createInstance(spec.speciesId, spec.level, rng);
  const mult = Number.isFinite(spec.hpMultiplier) && spec.hpMultiplier > 0 ? spec.hpMultiplier : 1;
  const maxHp = Math.max(base.maxHp, Math.floor(base.maxHp * mult));
  return { ...base, maxHp, hp: maxHp, status: 'none' };
}

/** 只读视图：客户端据此渲染讨伐列表；数值型真值（倍率）不下发。 */
export function bossView(spec: BossSpec, dailyLimit: number) {
  return {
    bossId: spec.bossId,
    name: spec.name,
    speciesId: spec.speciesId,
    speciesName: MONSTER_SPECS[spec.speciesId]?.name ?? spec.speciesId,
    level: spec.level,
    theme: spec.theme,
    description: spec.description,
    dailyLimit,
    unlockAreaId: spec.unlockAreaId ?? null,
  };
}

/** 统计：health 用，纯常量。 */
export function bossStats() {
  return {
    bosses: BOSS_IDS.length,
    source: 'server_content',
    damageSource: 'server_battle',
  };
}
