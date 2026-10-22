import { describe, expect, it } from "vitest";
import { captureChance, effectiveness, createInstance, computeDamage } from "@/game/rules";
import { MONSTER_SPECS } from "@/game/data";

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
});

