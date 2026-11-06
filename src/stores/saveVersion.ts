// 存档版本与迁移（单一真源）。
//
// 重要约定（新增/修改任何持久化字段时必须遵守）：
//   1. 递增下方 SCHEMA_VERSION（数字）；
//   2. 在 migrateSaveState 里补一个对应的版本分支，把旧存档补齐到新结构；
//   3. persist 的 version 与 SaveData.version 都由 SCHEMA_VERSION 派生，
//      禁止各自单独改——这是此前 SAVE_VERSION 与 persist version 脱钩的根因。
//
// 迁移采用「逐级累积 if」写法：fromVersion 会一路走到最新版本，
// 每个分支只处理它负责的增量，且把 version 变量往上推。
import { createInstance } from "@/game/rules";

/** 存档结构版本号（唯一真源，数字）。persist.version 与 SaveData.version 均由此派生。 */
export const SCHEMA_VERSION = 10;

/** 写入 SaveData 内部的版本字段（字符串，便于 importSaveJson 做 typeof 校验）。 */
export const SAVE_VERSION = String(SCHEMA_VERSION);

/** 把每个非空槽位的内部 version 字段对齐到 SAVE_VERSION（幂等，可作为兜底）。 */
function stampVersion(state: any): void {
  for (const slotKey of ["save1", "save2", "save3"]) {
    const save = state?.[slotKey];
    if (save && typeof save === "object") save.version = SAVE_VERSION;
  }
}

/**
 * 旧存档迁移：persist 每次重启用时调用，按 fromVersion 逐级补齐结构。
 * 入参/返回形状与 persist 的 partialize 一致：{ save1, save2, save3, slot }。
 */
export function migrateSaveState(persistedState: any, fromVersion: number): any {
  let state = persistedState;
  let version = fromVersion;

  if (version === 1) {
    // 单存档 → 三槽位
    state = { slot: 1, save1: state.save, save2: null, save3: null };
    version = 2;
  }
  if (version === 2) {
    // 补 locationId
    if (state.save1) state.save1.locationId = "town_starter";
    if (state.save2) state.save2.locationId = "town_starter";
    if (state.save3) state.save3.locationId = "town_starter";
    version = 3;
  }
  if (version === 3) {
    // 补 lastHealLocationId
    if (state.save1) state.save1.lastHealLocationId = state.save1.locationId;
    if (state.save2) state.save2.lastHealLocationId = state.save2.locationId;
    if (state.save3) state.save3.lastHealLocationId = state.save3.locationId;
    version = 4;
  }
  if (version === 4) {
    // 旧地名映射 + 补 visitedLocationIds
    const migrateLocation = (save: any) => {
      if (!save) return;
      if (save.locationId === "route_1") save.locationId = "town_starter";
      if (save.locationId === "cave_echo") save.locationId = "city_pebble";
      if (save.lastHealLocationId === "route_1") save.lastHealLocationId = "town_starter";
      if (save.lastHealLocationId === "cave_echo") save.lastHealLocationId = "city_pebble";
      if (!save.visitedLocationIds) save.visitedLocationIds = [save.locationId];
      save.visitedLocationIds = save.visitedLocationIds.map((id: string) => {
        if (id === "route_1") return "town_starter";
        if (id === "cave_echo") return "city_pebble";
        return id;
      });
    };
    migrateLocation(state.save1);
    migrateLocation(state.save2);
    migrateLocation(state.save3);
    version = 5;
  }
  if (version === 5) {
    // 补个体值/成长率（缺失则用 createInstance 重新生成）
    const migrateGrowth = (save: any) => {
      if (!save) return;
      const fixMonster = (m: any) => {
        if (!m.growthRates || !m.initStats) {
          const fresh = createInstance(m.specId, m.level);
          m.initStats = fresh.initStats;
          m.growthRates = fresh.growthRates;
          m.maxHp = fresh.maxHp;
          m.hp = m.hp > m.maxHp ? fresh.maxHp : m.hp;
          m.atk = fresh.atk;
          m.def = fresh.def;
          m.spAtk = fresh.spAtk;
          m.spDef = fresh.spDef;
          m.spd = fresh.spd;
        }
        return m;
      };
      if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
      if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
    };
    migrateGrowth(state.save1);
    migrateGrowth(state.save2);
    migrateGrowth(state.save3);
    version = 6;
  }
  if (version === 6) {
    // 去重 moveIds（第一遍）
    const dedupeMoves = (save: any) => {
      if (!save) return;
      const fixMonster = (m: any) => {
        if (m.moveIds && Array.isArray(m.moveIds)) m.moveIds = Array.from(new Set(m.moveIds));
        return m;
      };
      if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
      if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
    };
    dedupeMoves(state.save1);
    dedupeMoves(state.save2);
    dedupeMoves(state.save3);
    version = 7;
  }
  if (version === 7) {
    // 去重 moveIds（第二遍，历史遗留补强）
    const dedupeMoves = (save: any) => {
      if (!save) return;
      const fixMonster = (m: any) => {
        if (m.moveIds && Array.isArray(m.moveIds)) m.moveIds = Array.from(new Set(m.moveIds));
        return m;
      };
      if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
      if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
    };
    dedupeMoves(state.save1);
    dedupeMoves(state.save2);
    dedupeMoves(state.save3);
    version = 8;
  }
  if (version === 8) {
    // 补 collection.seenLocations
    const initSeenLocations = (save: any) => {
      if (!save || !save.collection) return;
      Object.values(save.collection).forEach((entry: any) => {
        if (entry.seen && !entry.seenLocations) entry.seenLocations = [];
      });
      if (save.party && save.party.length > 0 && save.collection[save.party[0].specId]) {
        save.collection[save.party[0].specId].seenLocations = ["town_starter"];
      }
    };
    initSeenLocations(state.save1);
    initSeenLocations(state.save2);
    initSeenLocations(state.save3);
    version = 9;
  }
  if (version === 9) {
    // 归一化：把内部 version 字段对齐到 SAVE_VERSION（前序分支已补齐结构，此处仅统一版本号）。
    stampVersion(state);
    version = 10;
  }

  // 兜底：确保最终存档内部版本号与 SAVE_VERSION 一致。
  stampVersion(state);
  return state;
}
