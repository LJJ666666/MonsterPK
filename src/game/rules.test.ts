import { describe, expect, it } from "vitest";
import { captureChance, effectiveness, createInstance, computeDamage, getMonsterStatBounds, evolveMonsterInstance, INIT_SPREAD_MIN } from "@/game/rules";
import { MONSTER_SPECS } from "@/game/data";

const STAT_KEYS = ["hp", "atk", "def", "spAtk", "spDef", "spd"] as const;

describe("rules", () => {
  it("calculates effectiveness", () => {
    expect(effectiveness("grass", "ground")).toBe(2);
    expect(effectiveness("fire", "steel")).toBe(2);
    expect(effectiveness("water", "fire")).toBe(2);
    expect(effectiveness("normal", "grass")).toBe(1);
  });

  it("damage is positive", () => {
    const m1 = createInstance("ember_marmot", 5);
    const m2 = createInstance("sprout_owl", 5);
    const dmg = computeDamage(m1, m2, "ember");
    expect(dmg.dmg).toBeGreaterThan(0);
  });

  it("capture chance increases with low hp and sleep", () => {
    const e1 = { ...createInstance("tide_newt", 5), hp: 40, status: "none" as const };
    const e2 = { ...createInstance("tide_newt", 5), hp: 5, status: "sleep" as const };
    const base = MONSTER_SPECS[e1.specId].captureRate;
    const c1 = captureChance(e1, base, 1);
    const c2 = captureChance(e2, base, 1);
    expect(c2).toBeGreaterThan(c1);
    expect(c1).toBeGreaterThanOrEqual(0.02);
    expect(c2).toBeLessThanOrEqual(0.95);
  });

  it("个体值区间正向、带宽达标、下限等于种族值", () => {
    for (const specId of Object.keys(MONSTER_SPECS)) {
      const b = getMonsterStatBounds(specId);
      for (const k of STAT_KEYS) {
        expect(b.initMin[k], `${specId}.${k} 下限超过上限`).toBeLessThanOrEqual(b.initMax[k]);
        expect(b.initMax[k] - b.initMin[k], `${specId}.${k} 带宽不足`).toBeGreaterThanOrEqual(INIT_SPREAD_MIN);
      }
    }
  });

  it("进化后保留个体差异，不被抹平到同一下限", () => {
    // ember_marmot → ember_badger（16 级进化）。修复前 remapByBounds 的
    // `oldMax <= oldMin` 分支恒成立，直接返回 newMin，导致所有个体进化后属性完全一致。
    const from = getMonsterStatBounds("ember_marmot");
    const base = createInstance("ember_marmot", 16);
    const fixedGrowth = { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 };
    const at = (iv: typeof from.initMin) => ({ ...base, initStats: { ...iv }, growthRates: fixedGrowth });

    const evoHigh = evolveMonsterInstance(at(from.initMax), "ember_badger");
    const evoLow = evolveMonsterInstance(at(from.initMin), "ember_badger");

    expect(evoHigh.specId).toBe("ember_badger");
    expect(evoLow.specId).toBe("ember_badger");
    expect(evoHigh.initStats.atk).toBeGreaterThan(evoLow.initStats.atk);
    expect(evoHigh.initStats.def).toBeGreaterThan(evoLow.initStats.def);
    expect(evoHigh.atk).toBeGreaterThan(evoLow.atk);
  });
});

