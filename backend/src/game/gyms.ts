/**
 * F18-b 演武堂内容表 + 馆主休息冷却（2026-11-11 / W8.0 迁共享 KV）。
 *
 * 设计要点：
 *  - 7 座演武堂对齐 `game/badges.ts::BADGE_BY_LOCATION` 的 7 个城镇；
 *    胜利经 `modules/playerProgress.grantBadge` 发 `gym:<locationId>` 徽章（唯一写入口，幂等）。
 *  - 无次数限制，但有「馆主休息」20 分钟冷却：同一玩家同一演武堂，
 *    开局后冷却期内不能再开（防刷经验 / 金钱）。
 *  - **W8.0：冷却从进程内 Map 迁到共享 KV（`KvStore`）**，键 `gym:cd:<userId>:<locationId>`。
 *    原实现「先判冷却 → 再置冷却」是两个独立步骤，多实例下两边都能判过、各开一场，
 *    20min CD 形同虚设。现在合并为一次**原子 acquire**（Redis 侧 Lua），
 *    跨实例只有一个实例能占到，这才是「CD 不可绕过」的真实含义。
 *  - 值的语义：存「到期时间戳（毫秒）」，TTL 同步设为冷却时长；
 *    Redis 到期自动删除，`get` 返回 null 即「不在冷却」，不需要额外清理任务。
 */
import { MemoryKvStore } from '../lib/memoryKvStore';
import type { KvStore } from '../lib/kvStore';

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

// —— 馆主休息冷却（W8.0：共享 KV，跨实例不可绕过）——
let cooldownStore: KvStore = new MemoryKvStore();

/** 启动时注入 Redis 实现（与 `useRedisStorage` / `setBroadcastTransport` 同思路）。 */
export function setGymCooldownStore(next: KvStore): void {
  cooldownStore = next;
}

/** 诊断用：'memory' | 'redis'。 */
export function getGymCooldownStoreKind(): string {
  return cooldownStore.kind;
}

/** 仅单测：恢复内存实现，避免跨用例污染。 */
export function resetGymCooldownStoreForTest(): void {
  cooldownStore = new MemoryKvStore();
}

export function gymCooldownKey(userId: string, locationId: string): string {
  return `gym:cd:${userId}:${locationId}`;
}

/** 冷却到期时间（毫秒）；0 = 不在冷却（键已过期或从未设置）。 */
export async function gymCooldownUntil(userId: string, locationId: string): Promise<number> {
  const raw = await cooldownStore.get(gymCooldownKey(userId, locationId));
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export async function isGymOnCooldown(userId: string, locationId: string, now: number): Promise<boolean> {
  return (await gymCooldownUntil(userId, locationId)) > now;
}

/**
 * 原子占冷却：**这是 CD 的唯一裁决点**。
 * 返回 `{ ok: true, until }` 表示占到（可以开战）；
 * 返回 `{ ok: false, until }` 表示已在冷却，`until` 是既有到期时间（用于算 retryAfterMs）。
 *
 * 为什么必须原子：多实例下「判 → 置」分开时，A/B 两实例都能判到「未冷却」，
 * 于是同一次冷却窗口被开了两场。Redis 侧由 `ACQUIRE_SCRIPT` 保证只有一个赢。
 */
export async function acquireGymCooldown(
  userId: string,
  locationId: string,
  now: number,
  ms = GYM_COOLDOWN_MS,
): Promise<{ ok: boolean; until: number }> {
  const until = now + ms;
  const res = await cooldownStore.acquire(gymCooldownKey(userId, locationId), String(until), ms);
  const n = Number(res.current);
  const existing = Number.isFinite(n) && n > 0 ? n : until;
  return { ok: res.ok, until: res.ok ? until : existing };
}
