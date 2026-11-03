import type { ItemId } from "@/game/types";

/** 离线挂机的累积上限（分钟）。超过部分不再产出。 */
export const IDLE_CAP_MINUTES = 8 * 60;

/** 每累计这么多分钟，进行一次捕获器掉落判定。 */
const CAPSULE_ROLL_MINUTES = 20;

/** 单次判定掉落捕获器的概率。整体期望偏低，挂机只是补贴。 */
const CAPSULE_DROP_CHANCE = 0.15;

/** 每分钟金币 = IDLE_MONEY_BASE + 区域难度 × IDLE_MONEY_PER_LEVEL */
const IDLE_MONEY_BASE = 1.5;
const IDLE_MONEY_PER_LEVEL = 0.15;

/**
 * 捕获器掉落池。区域难度越高，越高级的捕获器才会进入池子，
 * 因此「推图推得越远，挂机才能掉更好的球」。
 */
function capsulePool(level: number): Array<{ id: ItemId; weight: number }> {
  const pool: Array<{ id: ItemId; weight: number }> = [{ id: "capsule_basic", weight: 100 }];
  if (level >= 10) pool.push({ id: "capsule_prism", weight: 28 });
  if (level >= 20) pool.push({ id: "capsule_ultra", weight: 14 });
  return pool;
}

function pickCapsule(level: number): ItemId {
  const pool = capsulePool(level);
  const total = pool.reduce((sum, x) => sum + x.weight, 0);
  let r = Math.random() * total;
  for (const entry of pool) {
    r -= entry.weight;
    if (r <= 0) return entry.id;
  }
  return pool[0].id;
}

/** 把开始时间换算成有效挂机分钟数（已按上限截断，且不为负）。 */
export function idleElapsedMinutes(startedAt: string, now = Date.now()) {
  const start = new Date(startedAt).getTime();
  if (!Number.isFinite(start)) return 0;
  const raw = Math.floor((now - start) / 60000);
  return Math.max(0, Math.min(IDLE_CAP_MINUTES, raw));
}

/** 展示用：该难度下每小时的金币产出。 */
export function idleMoneyPerHour(level: number) {
  return Math.floor(60 * (IDLE_MONEY_BASE + level * IDLE_MONEY_PER_LEVEL));
}

/** 结算（或预览）指定分钟数的金币产出。 */
export function idleMoneyFor(level: number, minutes: number) {
  const effective = Math.max(0, Math.min(IDLE_CAP_MINUTES, minutes));
  return Math.floor(effective * (IDLE_MONEY_BASE + level * IDLE_MONEY_PER_LEVEL));
}

/** 展示用：指定分钟数内的捕获器期望掉落数。 */
export function idleCapsuleExpectation(minutes: number) {
  const effective = Math.max(0, Math.min(IDLE_CAP_MINUTES, minutes));
  return (effective / CAPSULE_ROLL_MINUTES) * CAPSULE_DROP_CHANCE;
}

/** 展示用：该难度下每小时的捕获器期望掉落数。 */
export function idleCapsulesPerHour() {
  return (60 / CAPSULE_ROLL_MINUTES) * CAPSULE_DROP_CHANCE;
}

/** 结算一次挂机产出。 */
export function settleIdle(level: number, minutes: number) {
  const effective = Math.max(0, Math.min(IDLE_CAP_MINUTES, minutes));
  const money = idleMoneyFor(level, effective);

  const capsules: Partial<Record<ItemId, number>> = {};
  const rolls = Math.floor(effective / CAPSULE_ROLL_MINUTES);
  for (let i = 0; i < rolls; i++) {
    if (Math.random() >= CAPSULE_DROP_CHANCE) continue;
    const id = pickCapsule(level);
    capsules[id] = (capsules[id] ?? 0) + 1;
  }

  return { money, capsules };
}
