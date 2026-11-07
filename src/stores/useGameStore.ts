import { create } from "zustand";
import { persist, StateStorage, createJSONStorage } from "zustand/middleware";
import { ITEM_SPECS, MONSTER_SPECS, STARTERS } from "@/game/data";
import type { BattleState, EncounterTheme, ItemId, MonsterInstance, SaveData, LocationId, MoveId } from "@/game/types";
import { createInstance, evolveMonsterInstance } from "@/game/rules";
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

function pushLog(battle: BattleState, lines: string[]) {
  const log = [...battle.log, ...lines].slice(-60);
  return { ...battle, log };
}

function consumeItem(inv: Record<ItemId, number>, itemId: ItemId) {
  const qty = inv[itemId] ?? 0;
  if (qty <= 0) return { ok: false as const, inv };
  return { ok: true as const, inv: { ...inv, [itemId]: qty - 1 } };
}

/*
 * 2026-11-07：本地降级战斗（beginLocalEncounter）已删除。
 * 断网不再本地开打——本地战果必然被服务端拒绝，只会制造「打完不认」和同步死循环。
 * 战斗入口只剩 startEncounter 里的服务端路径。
 */

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

        // 战斗只有一条路：服务端。**没有本地降级**（2026-11-07 定）。
        //
        // 为什么不做降级：本地打出来的战果最终要整包 PUT，而服务端的 expected
        // 还是战前摘要 → 必然 400 AUTHORITY_MISMATCH；4xx 又被判永久失败、不进
        // 离线队列。结果是「打完了、UI 给了奖励、联网后存档被拒」，本地还留下一份
        // 富档让后续每次上传继续 400。既没有收益（服务端不认），又制造同步死循环，
        // 还多留一份能被 GG 改的本地战斗实现。断网时如实告知，比假装能玩要好。
        if (!canUseServerBattle()) {
          return { ok: false, reason: "尚未登录，战斗需要连接服务端" };
        }
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
          return {
            ok: false,
            reason: f.transient
              ? "网络中断，战斗需要连接服务端。请检查网络后重试。"
              : f.message,
          };
        }
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
        const battle = get().battle;
        if (!battle?.serverId || battle.finished) return;
        // 服务端战斗只发意图：换人会让敌方获得一次行动，判定全在服务端。
        void runServerBattleAction(set, get, { type: "switch", partyIndex });
      },

      flee: () => {
        const battle = get().battle;
        if (!battle?.serverId || battle.finished) return;
        // 逃跑成功率（速度差决定 75% / 50%）由服务端掷骰。
        void runServerBattleAction(set, get, { type: "flee" });
      },

      useItem: async (itemId) => {
        const battle = get().battle;
        if (!battle?.serverId || battle.finished) return;
        // 道具消耗、回复量、捕获成败全部由服务端裁决。
        // 按道具类型分流：capture 走捕获判定，其余（heal / status_heal）走道具使用。
        const kind = ITEM_SPECS[itemId]?.kind;
        await runServerBattleAction(
          set,
          get,
          kind === "capture" ? { type: "capture", itemId } : { type: "item", itemId },
        );
      },

      useMove: async (moveId) => {
        const battle = get().battle;
        if (!battle?.serverId || battle.finished) return;
        // 只发「我要用这招」：PP 够不够、打多少、谁先手、敌方选什么招全在服务端。
        await runServerBattleAction(set, get, { type: "move", moveId });
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

