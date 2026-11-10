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

describe("migrateSaveState（存档版本口径统一 / F17 单档化）", () => {
  it("最旧的 v1 单存档形状能逐级迁移到最新的单档 { save }，并写入 SAVE_VERSION", () => {
    const v1 = { save: oldSave() }; // 旧版只有 save 字段
    const out = migrateSaveState(v1, 1);
    expect(out.save).toBeTruthy();
    // 前序历史分支（v1~v10）补齐的结构字段
    expect(out.save.locationId).toBe("town_starter");
    expect(out.save.lastHealLocationId).toBe("town_starter");
    expect(Array.isArray(out.save.visitedLocationIds)).toBe(true);
    // 内部版本号已对齐到单一真源
    expect(out.save.version).toBe(SAVE_VERSION);
    expect(SAVE_VERSION).toBe(String(SCHEMA_VERSION));
    // F17：现行结构只有单档（不再有任何历史字段）
    expect(Object.keys(out)).toEqual(["save"]);
  });

  it("v10 三槽存档收敛为单档：保留当前选中槽，其余两档丢弃", () => {
    const v10 = {
      slot: 2,
      save1: oldSave({ playerName: "一号档" }),
      save2: oldSave({ playerName: "老玩家" }),
      save3: oldSave({ playerName: "三号档" }),
    };
    const out = migrateSaveState(v10, 10);
    expect(out.save).toBeTruthy();
    expect(out.save.playerName).toBe("老玩家"); // 选中第 2 档
    expect(out.save.version).toBe(SAVE_VERSION); // "0.1.0" -> 最新版本
    expect(Object.keys(out)).toEqual(["save"]);
  });

  it("已经是最新版(SCHEMA_VERSION)的单档迁移后保持幂等，版本号仍为 SAVE_VERSION", () => {
    const cur = { save: oldSave() };
    const out = migrateSaveState(cur, SCHEMA_VERSION);
    expect(out.save.version).toBe(SAVE_VERSION);
    expect(Object.keys(out)).toEqual(["save"]); // 结构不变，仍是单档
  });

  it("残缺的迁移输入不会因 stampVersion 而报错", () => {
    expect(() => migrateSaveState({ save: null }, 9)).not.toThrow();
    expect(() => migrateSaveState({}, SCHEMA_VERSION)).not.toThrow();
  });
});
