/**
 * 共享野怪池的类型与常量（P4-1b 抽离，W7 存储可替换）。
 *
 * 单独成文件是为了打断循环依赖：`wildStorage` / `memoryWildStorage` /
 * `redisWildStorage` 三方都只依赖本文件，facade（`wildRegistry.ts`）再统一 re-export，
 * 现有 `import { ... } from '../lib/wildRegistry'` 全部零改动。
 */

/** 每个区域同时可见的野怪数。 */
export const WILD_PER_AREA = 3;
/** 未抢占的野怪存活时间（到期换新，避免列表永远不变）。 */
export const WILD_TTL_MS = 5 * 60_000;
/** 抢占后长时间不结算（掉线 / 战斗 TTL）自动放回池子。 */
export const WILD_CLAIM_TTL_MS = 30 * 60_000;
/** 结算后保留一小段时间，让其他客户端看得到「已被捕获 / 已逃走」。 */
export const WILD_RESOLVED_GRACE_MS = 10_000;

export type WildStatus = 'available' | 'claimed' | 'resolved';
export type WildResult = 'captured' | 'defeated' | 'fled' | null;
export type WildClaim = { userId: string; battleId: string; at: number };

export type WildInstance = {
  id: string;
  areaId: string;
  theme: string;
  speciesId: string;
  name: string;
  level: number;
  label: string;
  spawnedAt: number;
  expiresAt: number;
  status: WildStatus;
  result: WildResult;
  claim: WildClaim | null;
};

/** 对外公开视图：刻意不含 claim（userId / battleId）。 */
export type WildMonsterView = {
  id: string;
  areaId: string;
  speciesId: string;
  name: string;
  level: number;
  label: string;
  status: WildStatus;
  result: WildResult;
  expiresAt: number;
};

export type WildAreaSpec = {
  theme: string;
  levelMin: number;
  levelMax: number;
};

export type ClaimResult =
  | { ok: true; instance: WildInstance }
  | { ok: false; code: 'WILD_NOT_FOUND' | 'WILD_CLAIMED' | 'WILD_RESOLVED' | 'WILD_ON_COOLDOWN' };

export type WildStats = {
  active: number;
  areas: number;
  available: number;
  claimed: number;
  revision: number;
};

/** 公开视图投影：任何实现都走这一个函数，避免两套实现字段漂移。 */
export function toWildView(w: WildInstance): WildMonsterView {
  return {
    id: w.id, areaId: w.areaId, speciesId: w.speciesId, name: w.name,
    level: w.level, label: w.label, status: w.status, result: w.result,
    expiresAt: w.expiresAt,
  };
}

export function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number.isFinite(v) ? v : min), min), max);
}

/**
 * 内容工厂：由 facade 注入（RNG / seq / 内容表都留在 Node 侧）。
 * 存储实现只负责「存和取」，不负责生成 —— Lua 里查不到 `THEME_TABLE`。
 */
export type WildSpawner = (areaId: string, spec: WildAreaSpec, now: number) => WildInstance;
