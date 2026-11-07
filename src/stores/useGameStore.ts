import { create } from "zustand";
import { persist, StateStorage, createJSONStorage } from "zustand/middleware";
import { ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS, STARTERS } from "@/game/data";
import type { BattleState, EncounterTheme, ItemId, MonsterInstance, SaveData, LocationId, MoveId, StatModifiers } from "@/game/types";
import { applyDamage, attemptCapture, computeDamage, createInstance, gainExp, evolveMonsterInstance, getStatMultiplier, getAccuracyMultiplier, applyStatChanges, getSpeed, canMove, roll, uuid, getMonsterStatBounds, getMoveMaxPP } from "@/game/rules";
import { generateEncounter } from "@/game/gen";
import { idleElapsedMinutes } from "@/game/idle";
import { SCHEMA_VERSION, SAVE_VERSION, migrateSaveState } from "@/stores/saveVersion";
import { markRebase } from "@/lib/rebase";
import type { IntentResult } from "@/lib/intents";
import { battleApi, canUseServerBattle, toBattleState, toFailure, type ActionInput } from "@/lib/battleApi";

/**
 * P1-2：关键随机与经济结算统一走服务端裁决。
 * 用动态 import 调用 intents.ts，避免 useGameStore 与 intents 形成顶层循环导入（TDZ）。
 * apply 回调拿到服务端结果后直接改 store，随后由 runIntent 立即带 nonce 提交权威结果。
 */
async function intent(
  type: string,
  payload: Record<string, unknown>,
  apply: (result: IntentResult, save: SaveData, slot: number) => void,
): Promise<IntentResult | null> {
  const { runIntent } = await import("@/lib/intents");
  return runIntent(type, payload, apply);
}

/**
 * P3-1c：服务端战斗动作的统一出口。
 *
 * 客户端在这里只做三件事：置 pending（防连点）、转发意图、把服务端返回的状态映射成
 * 前端 BattleState。**没有任何数值计算**——伤害、命中、敌方选招、捕获、奖励全在服务端。
 *
 * 结算（finished）时服务端已经把结果写进存档并广播 `session.state`；
 * 这里额外用一次 GET 兜底，避免 WS 未连接时本地存档停留在战前状态。
 */
async function runServerBattleAction(
  set: (partial: any) => void,
  get: () => GameState,
  action: ActionInput,
): Promise<void> {
  const state = get();
  const battle = state.battle;
  if (!battle?.serverId || battle.finished || battle.pending) return;

  const battleId = battle.serverId;
  const slot = state.slot;
  set({ battle: { ...battle, pending: true } });

  try {
    const { view, settled } = await battleApi.action(slot, battleId, action);
    set({ battle: toBattleState(view) });
    if (settled) await refreshSaveFromServer(slot);
  } catch (e) {
    const f = toFailure(e);
    const cur = get().battle;
    // 期间可能已经开了新一场战斗，别把日志写到别的战斗上
    if (!cur || cur.serverId !== battleId) return;
    if (f.code === "BATTLE_NOT_FOUND") {
      set({
        battle: pushLog(
          { ...cur, pending: false, finished: true },
          ["这场战斗在服务端已经不存在（可能超时或已在别处结束），请重新开局。"],
        ),
      });
      return;
    }
    // 网络失败 / 业务拒绝都只回滚 pending：战斗真值仍在服务端，本地不做任何「补偿计算」，
    // 否则就变成了客户端自己推算战果，正是 P3 要根除的东西。
    set({ battle: pushLog({ ...cur, pending: false }, [`操作未生效：${f.message}`]) });
  }
}

/** 结算后主动拉一次存档（WS 快照的 HTTP 兜底）。失败静默：下一场开局仍以服务端为准。 */
async function refreshSaveFromServer(slot: number): Promise<void> {
  try {
    const [{ api }, { suppressNextUpload }] = await Promise.all([
      import("@/lib/api"),
      import("@/lib/sync"),
    ]);
    const cloud = await api.getSave(slot);
    if (!cloud?.data) return;
    suppressNextUpload();
    useGameStore.getState().importSaveJson(cloud.data, slot as 1 | 2 | 3, { keepBattle: true });
  } catch {
    /* 拉不到就等 WS 快照 */
  }
}

type GameState = {
  slot: 1 | 2 | 3;
  save1: SaveData | null;
  save2: SaveData | null;
  save3: SaveData | null;
  battle: BattleState | null;
  
  setSlot: (slot: 1 | 2 | 3) => void;
  leaveBattle: () => void;
  newGame: (playerName: string, starterSpecId: (typeof STARTERS)[number]) => void;
  resetSave: (slotToReset?: 1 | 2 | 3) => void;
  travelTo: (locationId: LocationId) => void;
  importSaveJson: (
    json: string,
    targetSlot?: 1 | 2 | 3,
    opts?: { keepBattle?: boolean },
  ) => { ok: true } | { ok: false; reason: string };
  exportSaveJson: (targetSlot?: 1 | 2 | 3) => { ok: true; json: string } | { ok: false; reason: string };
  
  startEncounter: (theme: EncounterTheme, areaName: string, levelMin: number, levelMax: number, areaId?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  useMove: (moveId: MoveId) => Promise<void>;
  useItem: (itemId: ItemId) => Promise<void>;
  switchTo: (partyIndex: number) => void;
  flee: () => void;
  /** P3-1c：刷新/断线重连后取回服务端仍存活的战斗（战斗态不进存档）。 */
  resumeBattle: () => Promise<void>;
  healAll: () => void;
  useItemOutsideBattle: (itemId: ItemId, partyIndex: number) => void;
  buyItem: (itemId: ItemId, amount: number) => Promise<void>;

  /** 派遣挂机到某个已首通区域（服务端时钟裁决）。 */
  startIdle: (areaId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 领取挂机收益并结束本次派遣（收益由服务端按服务端时钟结算）。 */
  claimIdle: () => Promise<{ money: number; capsules: Partial<Record<ItemId, number>> } | null>;
  /** 放弃本次挂机派遣，不结算收益。 */
  cancelIdle: () => Promise<void>;

  movePartyToBox: (partyIndex: number) => void;
  moveBoxToParty: (boxIndex: number) => void;
  releaseMonster: (id: string) => void;
  resolvePendingMove: (monsterId: string, oldMoveId: MoveId | null, newMoveId: MoveId) => void;
  resolvePendingEvolution: (monsterId: string, accept: boolean) => void;

  // 测试功能
  testOHKO: boolean;
  testMaxStats: boolean;
  testShiny: boolean;
  toggleTestOHKO: () => void;
  toggleTestMaxStats: () => void;
  toggleTestShiny: () => void;
  addGold: (amount: number) => Promise<void>;
  addMasterBalls: (amount: number) => Promise<void>;
};

function nowIso() {
  return new Date().toISOString();
}

function defaultInventory(): Record<ItemId, number> {
  const inv: Partial<Record<ItemId, number>> = {};
  for (const id of Object.keys(ITEM_SPECS) as ItemId[]) {
    inv[id] = 0;
  }
  inv.capsule_basic = 6;
  inv.capsule_prism = 1;
  inv.potion_small = 3;
  return inv as Record<ItemId, number>;
}

function averagePartyLevel(party: MonsterInstance[]) {
  if (party.length === 0) return 1;
  const s = party.reduce((acc, m) => acc + m.level, 0);
  return Math.max(1, Math.round(s / party.length));
}

function pushLog(battle: BattleState, lines: string[]) {
  const log = [...battle.log, ...lines].slice(-60);
  return { ...battle, log };
}

/** 为参战的所有幻兽建立本场战斗的 PP 表（每场战斗都补满）。 */
function initPP(monsters: MonsterInstance[]): Record<string, Record<MoveId, number>> {
  const table: Record<string, Record<MoveId, number>> = {};
  for (const m of monsters) {
    const pp: Record<MoveId, number> = {};
    for (const id of m.moveIds) pp[id] = getMoveMaxPP(id);
    table[m.id] = pp;
  }
  return table;
}

/** 从可用技能里随机挑一个；PP 全部耗尽时返回 null。 */
function pickUsableMove(monster: MonsterInstance, pp: Record<MoveId, number> | undefined) {
  const usable = monster.moveIds.filter((id) => (pp?.[id] ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable[Math.floor(Math.random() * usable.length)];
}

/** 战斗获胜后把该区域记为已首通，解锁挂机收益。 */
function markAreaCleared(save: SaveData, battle: BattleState): SaveData {
  const areaId = battle.areaId;
  if (!areaId) return save;
  const prev = save.clearedAreas?.[areaId];
  if (prev && prev.level >= battle.levelMax) return save;
  return {
    ...save,
    clearedAreas: {
      ...(save.clearedAreas ?? {}),
      [areaId]: {
        name: battle.areaName,
        level: battle.levelMax,
        theme: battle.theme,
        clearedAt: nowIso(),
      },
    },
  };
}

function alive(mon: MonsterInstance) {
  return mon.hp > 0;
}

function findFirstAliveIndex(party: MonsterInstance[]) {
  const idx = party.findIndex((m) => m.hp > 0);
  return idx === -1 ? 0 : idx;
}

function consumeItem(inv: Record<ItemId, number>, itemId: ItemId) {
  const qty = inv[itemId] ?? 0;
  if (qty <= 0) return { ok: false as const, inv };
  return { ok: true as const, inv: { ...inv, [itemId]: qty - 1 } };
}

/**
 * 本地降级战斗的开局（P3-1c 之前的唯一路径，服务端不可达时才会走到）。
 *
 * 为什么保留：后端挂掉/断网时至少还能打，不至于整个游戏不可玩。
 * 为什么安全：本地战斗的奖励仍走 `battle_reward` 意图由服务端裁决，
 * 所以降级 ≠ 可以改数据；改档照样会在提交时被拒。
 *
 * 与 P3-1c 之前的行为完全一致：顺带把该幻兽标进图鉴「已见」。
 * 服务端路径不需要这段——服务端在结算时统一写 collection。
 */
function beginLocalEncounter(
  set: (partial: any) => void,
  get: () => GameState,
  theme: EncounterTheme,
  areaName: string,
  levelMin: number,
  levelMax: number,
  areaId?: string,
): { ok: true } | { ok: false; reason: string } {
  const state = get();
  const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
  if (!save) return { ok: false, reason: "请先创建或导入存档" };

  const playerActiveIndex = findFirstAliveIndex(save.party);
  const level = Math.floor(Math.random() * (levelMax - levelMin + 1)) + levelMin;
  const { enemy, label } = generateEncounter(theme, level);

  if (state.testShiny) enemy.isShiny = true;
  if (state.testMaxStats) {
    const bounds = getMonsterStatBounds(enemy.specId);
    enemy.initStats = bounds.initMax;
    enemy.growthRates = bounds.gMax;
    const levelups = Math.max(0, enemy.level - 1);
    enemy.maxHp = enemy.initStats.hp + enemy.growthRates.hp * levelups;
    enemy.hp = enemy.maxHp;
    enemy.atk = enemy.initStats.atk + enemy.growthRates.atk * levelups;
    enemy.def = enemy.initStats.def + enemy.growthRates.def * levelups;
    enemy.spAtk = enemy.initStats.spAtk + enemy.growthRates.spAtk * levelups;
    enemy.spDef = enemy.initStats.spDef + enemy.growthRates.spDef * levelups;
    enemy.spd = enemy.initStats.spd + enemy.growthRates.spd * levelups;
  }

  const prevSeenLocations = save.collection[enemy.specId]?.seenLocations ?? [];
  const seenLocations = prevSeenLocations.includes(save.locationId)
    ? prevSeenLocations
    : [...prevSeenLocations, save.locationId];

  const collection = {
    ...save.collection,
    [enemy.specId]: {
      seen: true,
      captured: save.collection[enemy.specId]?.captured ?? false,
      timesCaptured: save.collection[enemy.specId]?.timesCaptured ?? 0,
      seenLocations,
    },
  };
  const battle: BattleState = {
    theme,
    areaName,
    areaId,
    levelMin,
    levelMax,
    turn: 1,
    log: [`遭遇：${label}`, "（本地模式：未连上服务端，战斗结果仍需服务端裁决才会计入存档）"],
    playerActiveIndex,
    playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemyStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemy,
    ppByMonster: initPP([...save.party, enemy]),
    finished: false,
  };
  set({ [`save${state.slot}`]: { ...save, collection, lastSavedAt: nowIso() }, battle } as any);
  return { ok: true };
}

const customStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/save');
      if (res.ok) {
        const text = await res.text();
        return text || null;
      }
    } catch (e) {
      console.warn('Failed to fetch remote save, falling back to local', e);
    }
    return localStorage.getItem(name);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    localStorage.setItem(name, value);
    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
    } catch (e) {
      console.warn('Failed to sync save to server', e);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    localStorage.removeItem(name);
  },
};

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      slot: 1,
      save1: null,
      save2: null,
      save3: null,
      battle: null,
      
      setSlot: (slot) => set({ slot }),
      leaveBattle: () => {
        const state = get();
        // P3-1c：战斗没打完就离开 = 放弃这场（不结算奖励）。
        // 必须显式告诉服务端，否则那场战斗会在服务端挂到 30min TTL 才回收，
        // 期间再开局会被当成「已有战斗」而行为异常。
        const current = state.battle;
        if (current?.serverId && !current.finished) {
          const slot = state.slot;
          void battleApi.abandon(slot, current.serverId).catch(() => {
            /* 已超时/已结束都无所谓，服务端会自己回收 */
          });
        }
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (state.battle?.result === "player_fainted" && save) {
          // 全灭惩罚：回到最近的恢复点，并恢复所有队伍状态
          const party = save.party.map((m) => ({ ...m, hp: m.maxHp, status: "none" as const }));
          set({ 
            battle: null,
            [`save${state.slot}`]: { 
              ...save, 
              party, 
              locationId: save.lastHealLocationId, 
              lastSavedAt: nowIso() 
            } 
          } as any);
        } else {
          set({ battle: null });
        }
      },

      newGame: (playerName, starterSpecId) => {
        const { slot } = get();
        const starter = createInstance(starterSpecId, 5);
        // 强制去重，防止因为旧版代码缓存等不可控因素导致的初始重复技能
        if (starter.moveIds) {
          starter.moveIds = Array.from(new Set(starter.moveIds));
        }
        
        const save: SaveData = {
          version: SAVE_VERSION,
          playerName,
          money: 0,
          steps: 0,
          locationId: "town_starter",
          lastHealLocationId: "town_starter",
          visitedLocationIds: ["town_starter"],
          party: [starter],
          box: [],
          inventory: defaultInventory(),
          collection: {
            [starterSpecId]: { seen: true, captured: true, timesCaptured: 1, seenLocations: ["town_starter"] },
          },
          lastSavedAt: nowIso(),
        };
        set({ [`save${slot}`]: save, battle: null } as any);
        // P1-2-d：新档必须重建服务端权威基线，否则旧基线会把初始化资源判成「凭空增加」。
        markRebase();
      },

      resetSave: (slotToReset) => {
        const s = slotToReset ?? get().slot;
        set({ [`save${s}`]: null, battle: null } as any);
      },

      travelTo: (locationId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const visited = save.visitedLocationIds?.includes(locationId)
          ? save.visitedLocationIds
          : [...(save.visitedLocationIds ?? []), locationId];
        set({ [`save${state.slot}`]: { ...save, locationId, visitedLocationIds: visited, lastSavedAt: nowIso() } } as any);
      },

      importSaveJson: (json, targetSlot, opts) => {
        const s = targetSlot ?? get().slot;
        try {
          const parsed = JSON.parse(json) as SaveData;
          if (!parsed || typeof parsed !== "object") return { ok: false, reason: "存档格式不正确" };
          if (typeof parsed.version !== "string") return { ok: false, reason: "缺少版本信息" };
          if (!Array.isArray(parsed.party)) return { ok: false, reason: "队伍字段不正确" };
          if (!parsed.inventory) return { ok: false, reason: "背包字段不正确" };
          const locationId = (parsed.locationId ?? "town_starter") as LocationId;
          const lastHealLocationId = (parsed.lastHealLocationId ?? locationId) as LocationId;
          const visitedLocationIds = (parsed.visitedLocationIds ?? [locationId]) as LocationId[];
          set({
            [`save${s}`]: { ...parsed, locationId, lastHealLocationId, visitedLocationIds, lastSavedAt: nowIso() },
            // P3-1c：战斗态不进存档，也不该被存档快照打断。
            //  - 导入/恢复存档（换档语义）→ 必须清战斗，否则会把旧战斗套到新档上；
            //  - 服务端权威快照（结算广播 / 别的设备写入）→ 保留战斗，
            //    因为结算时 UI 还要靠 battle 展示「对手倒下 / 捕获成功」，
            //    一旦清空 Arena 会直接跳回「尚未开始遭遇」。
            ...(opts?.keepBattle ? {} : { battle: null }),
          } as any);
          return { ok: true };
        } catch {
          return { ok: false, reason: "JSON 解析失败" };
        }
      },

      exportSaveJson: (targetSlot) => {
        const state = get();
        const s = targetSlot ?? state.slot;
        const save = state[`save${s}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "没有可导出的存档" };
        return { ok: true, json: JSON.stringify({ ...save, lastSavedAt: nowIso() }, null, 2) };
      },

      startEncounter: async (theme, areaName, levelMin, levelMax, areaId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "请先创建或导入存档" };
        if (save.party.length === 0) return { ok: false, reason: "队伍为空" };

        // P3-1c：主路径走服务端。敌人、队伍副本、每回合判定全部由服务端生成，
        // 客户端只拿到一份不可信也无所谓的展示态（改它不影响结算）。
        //
        // 只在「网络层不通」时降级到本地战斗；业务拒绝（队伍全灭 / 区域没怪 / 存档异常）
        // 必须如实报错——否则会出现「服务端说打不了，客户端却自己开了一场」的诡异状态，
        // 而且那场本地战斗的奖励在提交时也会被服务端拒掉。
        if (canUseServerBattle()) {
          try {
            const view = await battleApi.start({
              slot: state.slot,
              theme,
              areaName,
              areaId,
              levelMin,
              levelMax,
              testFlags: {
                testShiny: state.testShiny,
                testMaxStats: state.testMaxStats,
                testOHKO: state.testOHKO,
              },
            });
            set({ battle: toBattleState(view) } as any);
            return { ok: true };
          } catch (e) {
            const f = toFailure(e);
            if (!f.transient) return { ok: false, reason: f.message };
            // transient：后端不可达 → 继续走下面的本地降级
          }
        }

        return beginLocalEncounter(set, get, theme, areaName, levelMin, levelMax, areaId);
      },

      resumeBattle: async () => {
        const state = get();
        // 本地已有战斗（进行中或正在展示结果）就不覆盖它
        if (state.battle || !canUseServerBattle()) return;
        const slot = state.slot;
        try {
          const view = await battleApi.current(slot);
          if (!view) return;
          const now = get();
          // 请求期间可能切了槽位 / 开了新战斗，别把别人的战斗盖上去
          if (now.battle || now.slot !== slot) return;
          set({ battle: toBattleState(view) } as any);
        } catch {
          /* 取不到就当作没有战斗：下一场开局会重新创建 */
        }
      },

      switchTo: (partyIndex) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!battle || battle.finished) return;

        // P3-1c：服务端战斗只发意图。换人会让敌方获得一次行动，这段判定在服务端跑。
        if (battle.serverId) {
          void runServerBattleAction(set, get, { type: "switch", partyIndex });
          return;
        }

        if (!save) return;
        const next = save.party[partyIndex];
        if (!next || next.hp <= 0) return;
        if (partyIndex === battle.playerActiveIndex) return;
        let b = pushLog(
          { 
            ...battle, 
            playerActiveIndex: partyIndex,
            playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 }
          }, 
          [`你换上了 ${MONSTER_SPECS[next.specId].name}`]
        );
        const res = runEnemyTurn(save, b);
        set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
      },

      flee: () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!battle || battle.finished) return;

        // P3-1c：逃跑成功率（速度差决定 75% / 50%）由服务端掷骰。
        if (battle.serverId) {
          void runServerBattleAction(set, get, { type: "flee" });
          return;
        }

        if (!save) return;
        const player = save.party[battle.playerActiveIndex];
        const enemy = battle.enemy;
        const chance = player.spd >= enemy.spd ? 0.75 : 0.5;
        if (roll(chance)) {
          set({ battle: { ...battle, finished: true, result: "fled" as const, log: [...battle.log, "你成功撤离了训练场。"] } });
          return;
        }
        const res = runEnemyTurn(save, pushLog(battle, ["撤离失败！对方抓住了破绽。"]));
        set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
      },

      useItem: async (itemId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!battle || battle.finished) return;

        // P3-1c：道具消耗、回复量、捕获成败全部由服务端裁决。
        // 这里按道具类型分流：capture 走捕获判定，其余（heal / status_heal）走道具使用。
        if (battle.serverId) {
          const kind = ITEM_SPECS[itemId]?.kind;
          await runServerBattleAction(
            set,
            get,
            kind === "capture" ? { type: "capture", itemId } : { type: "item", itemId },
          );
          return;
        }

        if (!save) return;
        const item = ITEM_SPECS[itemId];
        const consumed = consumeItem(save.inventory, itemId);
        if (!consumed.ok) {
          set({ battle: pushLog(battle, ["道具不足。"]) });
          return;
        }

        if (item.kind === "heal") {
          const idx = battle.playerActiveIndex;
          const cur = save.party[idx];
          const healed = Math.min(cur.maxHp, cur.hp + (item.heal ?? 0));
          const party = save.party.slice();
          party[idx] = { ...cur, hp: healed };
          const nextSave = { ...save, inventory: consumed.inv, party, lastSavedAt: nowIso() };
          let b = pushLog(battle, [`使用了 ${item.name}。`]);
          const res = runEnemyTurn(nextSave, b);
          set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
          return;
        }

        // P1-2-b：捕获成败、成功率、摇晃次数全部由服务端裁决（RNG 在服务端）。
        // 客户端只上报野怪快照并渲染结果；伪造「成功」会在增量核对处被拒。
        // P1-3：捕获率已计入稀有度与等级差，公式在后端 settlements.ts。
        await intent("capture", {
          itemId,
          enemySpecId: battle.enemy.specId,
          enemyLevel: battle.enemy.level,
          enemyHp: battle.enemy.hp,
          enemyMaxHp: battle.enemy.maxHp,
          enemyStatus: battle.enemy.status,
          baseRate: MONSTER_SPECS[battle.enemy.specId].captureRate,
          areaId: battle.areaId ?? null,
        }, (result, curSave, slot) => {
          const consumedNow = consumeItem(curSave.inventory, itemId);
          if (!consumedNow.ok) return;
          const chance = Number(result.chance ?? 0);
          const shakes = Number(result.shakes ?? 1);
          const head = `抛出了 ${item.name}…（成功率 ${Math.round(chance * 100)}%）`;
          if (result.ok) {
            const enemyName = MONSTER_SPECS[battle.enemy.specId].name;
            const captured: MonsterInstance = { ...battle.enemy, id: uuid(), hp: battle.enemy.maxHp, status: "none" as const };
            const party = curSave.party.length < 6 ? [...curSave.party, captured] : curSave.party;
            const box = curSave.party.length < 6 ? curSave.box : [...curSave.box, captured];
            const collection = {
              ...curSave.collection,
              [captured.specId]: {
                seen: true,
                captured: true,
                timesCaptured: (curSave.collection[captured.specId]?.timesCaptured ?? 0) + 1,
              },
            };
            const nextSave = markAreaCleared(
              { ...curSave, inventory: consumedNow.inv, party, box, collection, lastSavedAt: nowIso() },
              battle
            );
            set({
              [`save${slot}`]: nextSave,
              battle: pushLog({ ...battle, finished: true, result: "captured" as const }, [head, `摇晃 x${shakes}… 捕获成功！${enemyName} 已加入。`]),
            } as any);
          } else {
            const nextSave = { ...curSave, inventory: consumedNow.inv, lastSavedAt: nowIso() };
            const turn = runEnemyTurn(nextSave, pushLog(battle, [head, `摇晃 x${shakes}… 失败！`]));
            set({ [`save${slot}`]: turn.save, battle: turn.battle } as any);
          }
        });
      },

      useMove: async (moveId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        let battle = state.battle;
        if (!battle || battle.finished) return;

        // P3-1c：服务端战斗 → 只发「我要用这招」。
        // PP 够不够、打多少、谁先手、敌方选什么招，全部由服务端判定，
        // 本地连预判都不做（预判失败会让 UI 闪一下错误结果，比不预判更差）。
        if (battle.serverId) {
          await runServerBattleAction(set, get, { type: "move", moveId });
          return;
        }

        if (!save) return;

        let player = save.party[battle.playerActiveIndex];
        if (!player) return;

        // PP 校验与扣减：PP 只存在于本场战斗，战斗结束即丢弃
        const playerPP = battle.ppByMonster?.[player.id] ?? {};
        const remainingPP = playerPP[moveId] ?? 0;
        if (remainingPP <= 0) {
          set({ battle: pushLog(battle, [`${MOVE_SPECS[moveId].name} 的 PP 已耗尽，无法使用。`]) });
          return;
        }
        let ppByMonster: Record<string, Record<MoveId, number>> = {
          ...battle.ppByMonster,
          [player.id]: { ...playerPP, [moveId]: remainingPP - 1 },
        };

        let enemy = battle.enemy;
        let playerMods = { ...battle.playerStatMods };
        let enemyMods = { ...battle.enemyStatMods };
        let logs: string[] = [];

        const enemyMoveId = pickUsableMove(enemy, battle.ppByMonster?.[enemy.id]);

        // Speed check
        const playerSpd = getSpeed(player, playerMods);
        const enemySpd = getSpeed(enemy, enemyMods);
        const playerPriority = MOVE_SPECS[moveId].priority ?? 0;
        const enemyPriority = enemyMoveId ? (MOVE_SPECS[enemyMoveId].priority ?? 0) : 0;

        let playerGoesFirst = false;
        if (playerPriority > enemyPriority) {
          playerGoesFirst = true;
        } else if (playerPriority < enemyPriority) {
          playerGoesFirst = false;
        } else {
          playerGoesFirst = playerSpd > enemySpd || (playerSpd === enemySpd && roll(0.5));
        }

        let playerFlinched = false;
        let enemyFlinched = false;

        const runPlayerAction = () => {
          if (!alive(player) || !alive(enemy)) return;
          if (playerFlinched) {
            logs.push(`${MONSTER_SPECS[player.specId].name} 畏缩了，无法行动！`);
            return;
          }
          const { ok, nextStatus } = canMove(player, logs);
          player.status = nextStatus;
          if (ok) {
            const res = executeMoveAction(player, enemy, playerMods, enemyMods, moveId, state.testOHKO);
            player = res.nextAttacker;
            enemy = res.nextDefender;
            playerMods = res.nextAttackerMods;
            enemyMods = res.nextDefenderMods;
            if (res.flinch) enemyFlinched = true;
            logs.push(...res.logs);
          }
        };

        const runEnemyAction = () => {
          if (!alive(player) || !alive(enemy)) return;
          if (enemyFlinched) {
            logs.push(`${MONSTER_SPECS[enemy.specId].name} 畏缩了，无法行动！`);
            return;
          }
          if (!enemyMoveId) {
            logs.push(`${MONSTER_SPECS[enemy.specId].name} 已无可用技能，只能干瞪眼。`);
            return;
          }
          const enemyPP = ppByMonster[enemy.id] ?? {};
          ppByMonster = { ...ppByMonster, [enemy.id]: { ...enemyPP, [enemyMoveId]: Math.max(0, (enemyPP[enemyMoveId] ?? 0) - 1) } };
          const { ok, nextStatus } = canMove(enemy, logs);
          enemy.status = nextStatus;
          if (ok) {
            const res = executeMoveAction(enemy, player, enemyMods, playerMods, enemyMoveId);
            enemy = res.nextAttacker;
            player = res.nextDefender;
            enemyMods = res.nextAttackerMods;
            playerMods = res.nextDefenderMods;
            if (res.flinch) playerFlinched = true;
            logs.push(...res.logs);
          }
        };

        if (playerGoesFirst) {
          runPlayerAction();
          runEnemyAction();
        } else {
          runEnemyAction();
          runPlayerAction();
        }

        let nextParty = save.party.slice();
        nextParty[battle.playerActiveIndex] = player;

        // End of turn
        const endTurnRes = processEndOfTurn(nextParty, battle.playerActiveIndex, enemy, battle);
        nextParty = endTurnRes.nextParty;
        enemy = endTurnRes.nextEnemy;
        logs.push(...endTurnRes.logs);
        player = nextParty[battle.playerActiveIndex];

        battle = pushLog({ ...battle, playerStatMods: playerMods, enemyStatMods: enemyMods, enemy, ppByMonster }, logs);

        // Check faints
        if (!alive(enemy)) {
          // P1-2-c：战斗奖励由服务端按敌人等级裁决，本地伪造 money+500 不能落库。
          // P1-3：amulet_coin 让金钱翻倍、exp_share 让全队分享经验，是否生效由服务端判定。
          await intent("battle_reward", {
            enemyLevel: enemy.level,
            areaId: battle.areaId ?? null,
            monsterIds: nextParty.map((m) => m.id),
          }, (result, curSave, slot) => {
            const expGain = Number(result.expGain ?? 0);
            const moneyGain = Number(result.moneyGain ?? 0);
            const party = nextParty.slice();
            let leveled = false;
            if (result.hasExpShare) {
              for (let i = 0; i < party.length; i++) {
                if (!alive(party[i])) continue;
                const r = gainExp(party[i], expGain);
                party[i] = r.monster;
                leveled = leveled || r.leveled;
              }
            } else {
              const r = gainExp(party[battle.playerActiveIndex], expGain);
              party[battle.playerActiveIndex] = r.monster;
              leveled = r.leveled;
            }
            const nextSave = markAreaCleared(
              { ...curSave, party, money: curSave.money + moneyGain, lastSavedAt: nowIso() },
              battle
            );
            const finishedBattle = pushLog({ ...battle, enemy, finished: true, result: "enemy_fainted" as const }, [
              `${MONSTER_SPECS[enemy.specId].name} 倒下了。`,
              `获得经验 ${expGain}，金钱 ¥${moneyGain}。${leveled ? "等级提升！" : ""}`.trim(),
            ]);
            set({ [`save${slot}`]: nextSave, battle: finishedBattle } as any);
          });
          return;
        }

        if (!alive(player)) {
          battle = pushLog(battle, [`${MONSTER_SPECS[player.specId].name} 倒下了。`]);
          const nextIndex = findFirstAliveIndex(nextParty);
          if (alive(nextParty[nextIndex])) {
            battle = pushLog({ ...battle, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [`你派出了 ${MONSTER_SPECS[nextParty[nextIndex].specId].name}。`]);
            set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, turn: battle.turn + 1 } } as any);
            return;
          } else {
            set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, finished: true, result: "player_fainted" as const } } as any);
            return;
          }
        }

        set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, turn: battle.turn + 1 } } as any);
      },

      healAll: () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const party = save.party.map((m) => ({ ...m, hp: m.maxHp, status: "none" as const }));
        set({ [`save${state.slot}`]: { ...save, party, lastHealLocationId: save.locationId, lastSavedAt: nowIso() } } as any);
      },

      useItemOutsideBattle: (itemId, partyIndex) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const item = ITEM_SPECS[itemId];
        const cur = save.party[partyIndex];
        if (!cur) return;

        // P1-3：进化石此前买了用不了。只有内容表配置了 item 进化条件的幻兽才消耗石头并进化；
        // 没有匹配条件时原样返回，避免玩家白扔道具。进化不改等级/经验/捕获数，
        // 因此只是一次合法的道具消耗，自动同步的单调比对会放行。
        if (item.kind === "evolution") {
          const spec = MONSTER_SPECS[cur.specId];
          const evo = spec?.evolutions?.find(
            (e) => e.condition.type === "item" && e.condition.itemId === itemId
          );
          if (!evo) return;
          const consumed = consumeItem(save.inventory, itemId);
          if (!consumed.ok) return;
          const party = save.party.slice();
          party[partyIndex] = evolveMonsterInstance(cur, evo.targetId);
          set({ [`save${state.slot}`]: { ...save, inventory: consumed.inv, party, lastSavedAt: nowIso() } } as any);
          return;
        }

        if (item.kind !== "heal") return;
        const consumed = consumeItem(save.inventory, itemId);
        if (!consumed.ok) return;
        if (cur.hp <= 0) return;
        const healed = Math.min(cur.maxHp, cur.hp + (item.heal ?? 0));
        const party = save.party.slice();
        party[partyIndex] = { ...cur, hp: healed };
        set({ [`save${state.slot}`]: { ...save, inventory: consumed.inv, party, lastSavedAt: nowIso() } } as any);
      },

      buyItem: async (itemId, amount) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        // P1-2-c：价格与扣款由服务端裁决，客户端改价 / 白嫖都会被精确增量核对拒绝。
        await intent("shop_buy", { itemId, amount }, (result, curSave, slot) => {
          const cost = Number(result.cost ?? 0);
          const qty = Number(result.amount ?? 0);
          if (cost <= 0 || qty <= 0) return;
          set({
            [`save${slot}`]: {
              ...curSave,
              money: curSave.money - cost,
              inventory: { ...curSave.inventory, [itemId]: (curSave.inventory[itemId] ?? 0) + qty },
              lastSavedAt: nowIso(),
            },
          } as any);
        });
      },

      startIdle: async (areaId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "请先创建存档" };
        if (!save.clearedAreas?.[areaId]) return { ok: false, reason: "该区域尚未首通，无法挂机" };
        if (save.idle) return { ok: false, reason: "已有进行中的挂机派遣" };
        // P1-2-a：区域难度与开始时间都由服务端给出，客户端系统时间不参与结算。
        const result = await intent("idle_start", { areaId }, (res, curSave, slot) => {
          set({
            [`save${slot}`]: {
              ...curSave,
              idle: {
                areaId,
                areaName: String(res.areaName ?? areaId),
                level: Number(res.level ?? 1),
                startedAt: String(res.startedAt ?? nowIso()),
              },
              lastSavedAt: nowIso(),
            },
          } as any);
        });
        return result ? { ok: true } : { ok: false, reason: "派遣失败，请检查网络后重试" };
      },

      claimIdle: async () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save?.idle) return null;
        // P1-2-a：收益按服务端时钟 + 服务端 RNG 结算，改系统时间（往前/往后）都不生效。
        const result = await intent("idle_claim", {}, (res, curSave, slot) => {
          const money = Number(res.money ?? 0);
          const capsules = (res.capsules ?? {}) as Partial<Record<ItemId, number>>;
          const inventory = { ...curSave.inventory };
          for (const [id, qty] of Object.entries(capsules)) {
            const key = id as ItemId;
            inventory[key] = (inventory[key] ?? 0) + (qty ?? 0);
          }
          set({
            [`save${slot}`]: {
              ...curSave,
              money: curSave.money + money,
              inventory,
              idle: null,
              lastSavedAt: nowIso(),
            },
          } as any);
        });
        if (!result) return null;
        return {
          money: Number(result.money ?? 0),
          capsules: (result.capsules ?? {}) as Partial<Record<ItemId, number>>,
        };
      },

      cancelIdle: async () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save?.idle) return;
        await intent("idle_cancel", {}, (_res, curSave, slot) => {
          set({ [`save${slot}`]: { ...curSave, idle: null, lastSavedAt: nowIso() } } as any);
        });
      },

      movePartyToBox: (partyIndex: number) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        if (save.party.length <= 1) return;
        const m = save.party[partyIndex];
        if (!m) return;
        const party = save.party.filter((_, i) => i !== partyIndex);
        const box = [...save.box, m];
        set({ [`save${state.slot}`]: { ...save, party, box, lastSavedAt: nowIso() } } as any);
      },

      moveBoxToParty: (boxIndex: number) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        if (save.party.length >= 6) return;
        const m = save.box[boxIndex];
        if (!m) return;
        const box = save.box.filter((_, i) => i !== boxIndex);
        const party = [...save.party, m];
        set({ [`save${state.slot}`]: { ...save, party, box, lastSavedAt: nowIso() } } as any);
      },

      releaseMonster: (id: string) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const inParty = save.party.some(m => m.id === id);
        if (inParty && save.party.length <= 1) return;

        set({
          [`save${state.slot}`]: {
            ...save,
            party: save.party.filter(m => m.id !== id),
            box: save.box.filter(m => m.id !== id),
            lastSavedAt: nowIso()
          }
        } as any);
      },

      resolvePendingMove: (monsterId, oldMoveId, newMoveId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;

        const updateMonster = (m: MonsterInstance) => {
          if (m.id !== monsterId) return m;
          const pendingMoves = (m.pendingMoves ?? []).filter(id => id !== newMoveId);
          let moveIds = [...m.moveIds];
          if (oldMoveId !== null) {
            const idx = moveIds.indexOf(oldMoveId);
            if (idx !== -1) {
              moveIds[idx] = newMoveId;
            }
          }
          return { ...m, pendingMoves, moveIds };
        };

        set({
          [`save${state.slot}`]: {
            ...save,
            party: save.party.map(updateMonster),
            box: save.box.map(updateMonster),
            lastSavedAt: nowIso()
          }
        } as any);
      },

      resolvePendingEvolution: (monsterId, accept) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;

        const updateMonster = (m: MonsterInstance) => {
          if (m.id !== monsterId) return m;
          const pending = m.pendingEvolution;
          if (!pending) return m;
          if (!accept) return { ...m, pendingEvolution: undefined };

          const evolved = evolveMonsterInstance(m, pending.targetId);
          return evolved;
        };

        const party = save.party.map(updateMonster);
        const box = save.box.map(updateMonster);

        const evolvedMonster = [...party, ...box].find((m) => m.id === monsterId);
        const evolvedSpecId = evolvedMonster?.specId;

        let collection = save.collection;
        if (evolvedSpecId) {
          const prev = save.collection[evolvedSpecId];
          const seenLocations = prev?.seenLocations?.includes(save.locationId)
            ? prev.seenLocations
            : [...(prev?.seenLocations ?? []), save.locationId];
          collection = {
            ...save.collection,
            [evolvedSpecId]: {
              seen: true,
              captured: true,
              // 进化只登记图鉴「已见过/已获得」，不增加捕获计数：
              // 捕获次数是服务端裁决资源，客户端自行 +1 会被权威摘要判成伪造捕获。
              timesCaptured: prev?.timesCaptured ?? 0,
              seenLocations,
            },
          };
        }

        set({
          [`save${state.slot}`]: {
            ...save,
            party,
            box,
            collection,
            lastSavedAt: nowIso(),
          },
        } as any);
      },

      testOHKO: false,
      testMaxStats: false,
      testShiny: false,
      toggleTestOHKO: () => set((s) => ({ testOHKO: !s.testOHKO })),
      toggleTestMaxStats: () => set((s) => ({ testMaxStats: !s.testMaxStats })),
      toggleTestShiny: () => set((s) => ({ testShiny: !s.testShiny })),
      // P1-2-d：测试菜单必须走服务端 admin_test 授权；普通账号即使直接调用也会被拒，
      // 不会在本地凭空加钱 / 加球。管理员身份只由服务端判定。
      addGold: async (amount) => {
        await intent("admin_test", {}, (_res, save, slot) => {
          set({ [`save${slot}`]: { ...save, money: Math.min(999999, save.money + amount), lastSavedAt: nowIso() } } as any);
        });
      },
      addMasterBalls: async (amount) => {
        await intent("admin_test", {}, (_res, save, slot) => {
          const inventory = { ...save.inventory };
          inventory["capsule_master"] = (inventory["capsule_master"] || 0) + amount;
          set({ [`save${slot}`]: { ...save, inventory, lastSavedAt: nowIso() } } as any);
        });
      }
    }),
    {
      name: "beast-journal-save",
      storage: createJSONStorage(() => customStorage),
      partialize: (s) => ({ save1: s.save1, save2: s.save2, save3: s.save3, slot: s.slot }),
      version: SCHEMA_VERSION,
      migrate: (persistedState: any, version: number) => migrateSaveState(persistedState, version),
    }
  )
);

function effLine(eff: number) {
  if (eff >= 2) return "效果拔群！";
  if (eff <= 0.6) return "效果不太理想。";
  if (eff > 1.05 && eff < 2) return "有点克制。";
  return "";
}

function statusLine(next: MonsterInstance["status"], prev: MonsterInstance["status"]) {
  if (next === prev) return "";
  if (next === "burn") return "被灼伤了。";
  if (next === "paralyze") return "麻痹了。";
  if (next === "sleep") return "睡着了。";
  if (next === "freeze") return "被冻住了。";
  if (next === "poison") return "中毒了。";
  return "";
}

// 内部方法，执行一次完整的招式（含伤害、状态、能力变化）
function executeMoveAction(
  attacker: MonsterInstance,
  defender: MonsterInstance,
  attackerMods: StatModifiers,
  defenderMods: StatModifiers,
  moveId: MoveId,
  testOHKO?: boolean
) {
  const move = MOVE_SPECS[moveId];
  const logs: string[] = [];
  let flinch = false;
  
  const hit = roll(move.accuracy * getAccuracyMultiplier((attackerMods.accuracy ?? 0) - (defenderMods.evasion ?? 0)));
  if (!hit) {
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 的攻击落空了。`);
    return { nextAttacker: attacker, nextDefender: defender, nextAttackerMods: attackerMods, nextDefenderMods: defenderMods, logs, flinch };
  }

  let dmg = 0;
  let nextAttacker = { ...attacker };
  
  if (move.category !== "status") {
    let hits = 1;
    if (move.multiHit) {
      hits = move.multiHit[0] + Math.floor(Math.random() * (move.multiHit[1] - move.multiHit[0] + 1));
    }
    
    let totalDmg = 0;
    let anyCrit = false;
    let eff = 1;
    
    for (let i = 0; i < hits; i++) {
      const res = computeDamage(attacker, defender, moveId, attackerMods, defenderMods);
      totalDmg += res.dmg;
      eff = res.eff;
      if (res.isCrit) anyCrit = true;
    }
    
    dmg = totalDmg;
    if (testOHKO) dmg = defender.hp;
    
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 使用了 ${move.name}，造成 ${dmg} 点伤害。`);
    if (hits > 1) logs.push(`击中了 ${hits} 次！`);
    if (anyCrit) logs.push("击中了要害！");
    if (eff !== 1) logs.push(effLine(eff));
    
    if (move.healPct && dmg > 0) {
      const healAmt = Math.max(1, Math.floor(dmg * move.healPct));
      nextAttacker.hp = Math.min(nextAttacker.maxHp, nextAttacker.hp + healAmt);
      logs.push(`${MONSTER_SPECS[nextAttacker.specId].name} 吸取了体力！`);
    }
    
    if (move.flinchChance && roll(move.flinchChance)) {
      flinch = true;
    }
  } else {
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 使用了 ${move.name}。`);
  }

  let nextDefender = applyDamage(defender, dmg);
  let nextAttackerMods = { ...attackerMods };
  let nextDefenderMods = { ...defenderMods };

  // Status effects
  if (move.status && nextDefender.hp > 0 && nextDefender.status === "none" && roll(move.status.chance)) {
    const targetIsSelf = move.status.target === "self";
    if (targetIsSelf && nextAttacker.status === "none") {
      nextAttacker.status = move.status.type;
      logs.push(`${MONSTER_SPECS[nextAttacker.specId].name} ${statusLine(nextAttacker.status, "none")}`);
    } else if (!targetIsSelf) {
      nextDefender.status = move.status.type;
      logs.push(`${MONSTER_SPECS[nextDefender.specId].name} ${statusLine(nextDefender.status, "none")}`);
    }
  }

  // Stat changes
  if (move.statChanges) {
    for (const c of move.statChanges) {
      const targetIsSelf = c.target === "self";
      if (targetIsSelf && nextAttacker.hp > 0) {
        nextAttackerMods = applyStatChanges(nextAttackerMods, MONSTER_SPECS[nextAttacker.specId].name, [c], logs);
      } else if (!targetIsSelf && nextDefender.hp > 0) {
        nextDefenderMods = applyStatChanges(nextDefenderMods, MONSTER_SPECS[nextDefender.specId].name, [c], logs);
      }
    }
  }

  return { nextAttacker, nextDefender, nextAttackerMods, nextDefenderMods, logs, flinch };
}

function processEndOfTurn(party: MonsterInstance[], activeIdx: number, enemy: MonsterInstance, battle: BattleState) {
  let logs: string[] = [];
  let nextParty = [...party];
  let nextEnemy = { ...enemy };
  let player = nextParty[activeIdx];

  // Poison / Burn DOT
  if (player.hp > 0) {
    if (player.status === "burn") {
      const dmg = Math.max(1, Math.floor(player.maxHp / 16));
      player = applyDamage(player, dmg);
      logs.push(`${MONSTER_SPECS[player.specId].name} 受到烧伤伤害。`);
    } else if (player.status === "poison") {
      const dmg = Math.max(1, Math.floor(player.maxHp / 8));
      player = applyDamage(player, dmg);
      logs.push(`${MONSTER_SPECS[player.specId].name} 受到中毒伤害。`);
    }
    nextParty[activeIdx] = player;
  }

  if (nextEnemy.hp > 0) {
    if (nextEnemy.status === "burn") {
      const dmg = Math.max(1, Math.floor(nextEnemy.maxHp / 16));
      nextEnemy = applyDamage(nextEnemy, dmg);
      logs.push(`${MONSTER_SPECS[nextEnemy.specId].name} 受到烧伤伤害。`);
    } else if (nextEnemy.status === "poison") {
      const dmg = Math.max(1, Math.floor(nextEnemy.maxHp / 8));
      nextEnemy = applyDamage(nextEnemy, dmg);
      logs.push(`${MONSTER_SPECS[nextEnemy.specId].name} 受到中毒伤害。`);
    }
  }

  return { nextParty, nextEnemy, logs };
}

function runEnemyTurn(save: SaveData, battle: BattleState) {
  if (battle.finished) return { save, battle };
  let party = save.party.slice();
  let player = party[battle.playerActiveIndex];
  let enemy = battle.enemy;
  let playerMods = { ...battle.playerStatMods };
  let enemyMods = { ...battle.enemyStatMods };
  let logs: string[] = [];

  if (!alive(player)) {
    const nextIndex = findFirstAliveIndex(party);
    if (nextIndex !== battle.playerActiveIndex && alive(party[nextIndex])) {
      return {
        save,
        battle: pushLog({ ...battle, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [
          `${MONSTER_SPECS[player.specId].name} 倒下了，你派出了 ${MONSTER_SPECS[party[nextIndex].specId].name}。`,
        ]),
      };
    }
    return { save, battle: { ...pushLog(battle, ["你已没有可战斗的伙伴。"]), finished: true, result: "player_fainted" as const } };
  }

  const enemyMoveId = pickUsableMove(enemy, battle.ppByMonster?.[enemy.id]);
  let ppByMonster = battle.ppByMonster ?? {};

  if (!enemyMoveId) {
    logs.push(`${MONSTER_SPECS[enemy.specId].name} 已无可用技能，只能干瞪眼。`);
  } else {
    const enemyPP = ppByMonster[enemy.id] ?? {};
    ppByMonster = { ...ppByMonster, [enemy.id]: { ...enemyPP, [enemyMoveId]: Math.max(0, (enemyPP[enemyMoveId] ?? 0) - 1) } };
    const { ok, nextStatus } = canMove(enemy, logs);
    enemy.status = nextStatus;
    if (ok) {
      const res = executeMoveAction(enemy, player, enemyMods, playerMods, enemyMoveId);
      enemy = res.nextAttacker;
      player = res.nextDefender;
      enemyMods = res.nextAttackerMods;
      playerMods = res.nextDefenderMods;
      logs.push(...res.logs);
    }
  }

  party[battle.playerActiveIndex] = player;
  
  // End of turn
  const endTurnRes = processEndOfTurn(party, battle.playerActiveIndex, enemy, battle);
  party = endTurnRes.nextParty;
  enemy = endTurnRes.nextEnemy;
  logs.push(...endTurnRes.logs);
  player = party[battle.playerActiveIndex];

  let b = pushLog({ ...battle, playerStatMods: playerMods, enemyStatMods: enemyMods, enemy, ppByMonster }, logs);
  const nextSave = { ...save, party, lastSavedAt: nowIso() };

  if (!alive(player)) {
    b = pushLog(b, [`${MONSTER_SPECS[player.specId].name} 倒下了。`]);
    const nextIndex = findFirstAliveIndex(party);
    if (alive(party[nextIndex])) {
      b = pushLog({ ...b, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [`你派出了 ${MONSTER_SPECS[party[nextIndex].specId].name}。`]);
      return { save: nextSave, battle: b };
    }
    return { save: nextSave, battle: { ...b, finished: true, result: "player_fainted" as const } };
  }

  return { save: nextSave, battle: { ...b, turn: b.turn + 1 } };
}
