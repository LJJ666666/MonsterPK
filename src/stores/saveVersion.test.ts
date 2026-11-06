import { describe, expect, it } from "vitest";
import { migrateSaveState, SAVE_VERSION, SCHEMA_VERSION } from "@/stores/saveVersion";

// 构造一个最小但结构合法的旧版存档（growthRates/initStats 占位即可，迁移分支不会触发重新生成）
function oldSave(over: any = {}) {
  return {
    version: "0.1.0",
    playerName: "旅行者",
    money: 0,
    steps: 0,
    party: [{ specId: "ember_marmot", level: 5, growthRates: {}, initStats: {} }],
    box: [],
    inventory: {},
    collection: { ember_marmot: { seen: true, captured: true, timesCaptured: 1, seenLocations: ["town_starter"] } },
    lastSavedAt: "2026-01-01",
    ...over,
  };
}

describe("migrateSaveState（存档版本口径统一）", () => {
  it("最旧的 v1 单存档形状能逐级迁移到最新版本，并写入 SAVE_VERSION", () => {
    const v1 = { save: oldSave() }; // 旧版只有 save 字段，没有 save1/2/3
    const out = migrateSaveState(v1, 1);
    expect(out.slot).toBe(1);
    expect(out.save1).toBeTruthy();
    expect(out.save2).toBeNull();
    expect(out.save3).toBeNull();
    // 前序分支补齐的结构字段
    expect(out.save1.locationId).toBe("town_starter");
    expect(out.save1.lastHealLocationId).toBe("town_starter");
    expect(Array.isArray(out.save1.visitedLocationIds)).toBe(true);
    // 内部版本号已对齐到单一真源
    expect(out.save1.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(String(SCHEMA_VERSION));
  });

  it("v9 存档只做版本号归一，不会破坏已有结构", () => {
    const v9 = {
      slot: 2,
      save1: null,
      save2: oldSave({ playerName: "老玩家" }),
      save3: null,
    };
    const out = migrateSaveState(v9, 9);
    expect(out.slot).toBe(2);
    expect(out.save2).toBeTruthy();
    expect(out.save2.version).toBe(SAVE_VERSION); // "0.1.0" -> 最新版本
    expect(out.save2.playerName).toBe("老玩家"); // 数据原样保留
  });

  it("已经是最新版(v10)的存档迁移后保持幂等，版本号仍为 SAVE_VERSION", () => {
    const cur = {
      slot: 1,
      save1: oldSave(),
      save2: null,
      save3: null,
    };
    const out = migrateSaveState(cur, SCHEMA_VERSION);
    expect(out.save1.version).toBe(SAVE_VERSION);
    expect(out.slot).toBe(1);
  });

  it("缺失的槽位不会因 stampVersion 而报错", () => {
    const partial = { slot: 1, save1: oldSave(), save2: null }; // 少了 save3
    expect(() => migrateSaveState(partial, 9)).not.toThrow();
  });
});
