import { create } from "zustand";
import { persist, StateStorage, createJSONStorage } from "zustand/middleware";
import { ITEM_SPECS, STARTERS } from "@/game/data";
import type { BattleState, EncounterTheme, ItemId, SaveData, LocationId, MoveId } from "@/game/types";
import { SCHEMA_VERSION, migrateSaveState } from "@/stores/saveVersion";
import type { IntentResult } from "@/lib/intents";
import { battleApi, canUseServerBattle, toBattleState, toFailure, type ActionInput, type ServerBattleView } from "@/lib/battleApi";
import { api } from "@/lib/api";
import { runGameOp, type MutationOp } from "@/lib/gameApi";

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

/**
 * P3-2：把服务端写操作返回的整包存档应用回本地。
 *
 * 为什么不走 PUT 校验链路：服务端已经在 `commitState` 里落库并广播了自己的权威态，
 * 本地这份只是渲染副本。先 `suppressNextUpload()` 抑制一次自动上传，避免刚写完
 * 又原样传回去（那会多一次 revision 和一次广播）。
 */
async function applyServerSave(slot: number, data: string): Promise<void> {
  const { suppressNextUpload } = await import("@/lib/sync");
  suppressNextUpload();
  useGameStore.getState().importSaveJson(data, slot as 1 | 2 | 3, { keepBattle: true });
}

/** P3-2：所有「会改存档」的操作统一走这里，失败只回报文，不做任何本地补偿。 */
async function serverOp(
  get: () => GameState,
  op: MutationOp,
  body: Record<string, unknown>,
): Promise<{ ok: boolean; reason?: string }> {
  const state = get();
  const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
  if (!save) return { ok: false, reason: "请先创建或导入存档" };
  const res = await runGameOp(op, { slot: state.slot, ...body });
  // strict:false 下判别联合不收窄，用 in 判字段（bug_log §18）。
  if (!res.ok) return { ok: false, reason: "reason" in res ? res.reason : "操作失败" };
  await applyServerSave(state.slot, res.data);
  return { ok: true };
}

type GameState = {
  slot: 1 | 2 | 3;
  save1: SaveData | null;
  save2: SaveData | null;
  save3: SaveData | null;
  battle: BattleState | null;
  
  setSlot: (slot: 1 | 2 | 3) => void;
  leaveBattle: () => void;
  newGame: (
    playerName: string,
    starterSpecId: (typeof STARTERS)[number],
  ) => Promise<{ ok: boolean; reason?: string }>;
  resetSave: (slotToReset?: 1 | 2 | 3) => void;
  travelTo: (locationId: LocationId) => Promise<{ ok: boolean; reason?: string }>;
  importSaveJson: (
    json: string,
    targetSlot?: 1 | 2 | 3,
    opts?: { keepBattle?: boolean },
  ) => { ok: true } | { ok: false; reason: string };
  exportSaveJson: (targetSlot?: 1 | 2 | 3) => { ok: true; json: string } | { ok: false; reason: string };
  
  startEncounter: (theme: EncounterTheme, areaName: string, levelMin: number, levelMax: number, areaId?: string, wildId?: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /**
   * P4-2c：开一场单人 Boss 讨伐。
   * 只传 bossId：Boss 等级 / HP 倍率 / 每日次数 / 敌方选招全在服务端，
   * 前端拿到的只是一份战斗视图（和普通遭遇同一套渲染与动作入口）。
   */
  startBossBattle: (bossId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  useMove: (moveId: MoveId) => Promise<void>;
  useItem: (itemId: ItemId) => Promise<void>;
  switchTo: (partyIndex: number) => void;
  flee: () => void;
  /** P3-1c：刷新/断线重连后取回服务端仍存活的战斗（战斗态不进存档）。 */
  resumeBattle: () => Promise<void>;
  healAll: () => Promise<{ ok: boolean; reason?: string }>;
  useItemOutsideBattle: (itemId: ItemId, partyIndex: number) => Promise<{ ok: boolean; reason?: string }>;
  buyItem: (itemId: ItemId, amount: number) => Promise<void>;

  /** 派遣挂机到某个已首通区域（服务端时钟裁决）。 */
  startIdle: (areaId: string) => Promise<{ ok: true } | { ok: false; reason: string }>;
  /** 领取挂机收益并结束本次派遣（收益由服务端按服务端时钟结算）。 */
  claimIdle: () => Promise<{ money: number; capsules: Partial<Record<ItemId, number>> } | null>;
  /** 放弃本次挂机派遣，不结算收益。 */
  cancelIdle: () => Promise<void>;

  movePartyToBox: (partyIndex: number) => Promise<{ ok: boolean; reason?: string }>;
  moveBoxToParty: (boxIndex: number) => Promise<{ ok: boolean; reason?: string }>;
  releaseMonster: (id: string) => Promise<{ ok: boolean; reason?: string }>;
  resolvePendingMove: (
    monsterId: string,
    oldMoveId: MoveId | null,
    newMoveId: MoveId,
    opts?: { discard?: boolean },
  ) => Promise<{ ok: boolean; reason?: string }>;
  resolvePendingEvolution: (monsterId: string, accept: boolean) => Promise<{ ok: boolean; reason?: string }>;

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

function pushLog(battle: BattleState, lines: string[]) {
  const log = [...battle.log, ...lines].slice(-60);
  return { ...battle, log };
}

/*
 * 2026-11-07：本地降级战斗（beginLocalEncounter）已删除。
 * 断网不再本地开打——本地战果必然被服务端拒绝，只会制造「打完不认」和同步死循环。
 * 战斗入口只剩 startEncounter 里的服务端路径。
 *
 * 2026-11-07（P3-2）：本地「改存档」的业务逻辑也全部删除——治疗、战斗外道具、
 * 进化、学招、队伍整理、移动都改调 `/api/game/*`，由服务端判定并写档。
 * 现在前端只剩三类写本地状态的入口：新建/导入存档（rebase 明确授权）、
 * 服务端快照应用（importSaveJson）、测试菜单开关（纯 UI 标记，随开局上报给服务端判定）。
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
        // P3-2：全灭惩罚（回满 + 送回最近恢复点）已由服务端在结算时写档，
        // 这里不再改存档，只关闭战斗界面。
        set({ battle: null });
      },

      newGame: async (playerName, starterSpecId) => {
        const { slot } = get();
        // P3-2b：整份新档由服务端生成（初始幻兽的个体值、初始背包都在服务端掷），
        // 客户端只提交「名字 + 选哪只御三家」。不再本地 createInstance + rebase。
        const res = await runGameOp("new_game", {
          slot,
          playerName,
          starterSpecId,
          // 前端在「新建旅程」里已经让玩家确认过覆盖，这里显式授权。
          overwrite: true,
        });
        if (!res.ok) return { ok: false, reason: "reason" in res ? res.reason : "创建存档失败" };
        await applyServerSave(slot, res.data);
        return { ok: true };
      },

      resetSave: (slotToReset) => {
        const s = slotToReset ?? get().slot;
        set({ [`save${s}`]: null, battle: null } as any);
      },

      travelTo: async (locationId) => {
        // P3-2：地点合法性由服务端判（地图可达性等 P4 上移），本地只发意图。
        return serverOp(get, "travel", { locationId });
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

      startEncounter: async (theme, areaName, levelMin, levelMax, areaId, wildId) => {
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
            ...(wildId ? { wildId } : {}),
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

      startBossBattle: async (bossId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "请先创建或导入存档" };
        if (!canUseServerBattle()) return { ok: false, reason: "尚未登录，战斗需要连接服务端" };
        try {
          // 只传 slot + bossId：Boss 数值、每日次数、敌方选招全由服务端决定。
          const res = await api.bossStart({ slot: state.slot, bossId });
          if (!res?.battle) {
            throw Object.assign(new Error("服务端没有返回战斗"), { code: "BATTLE_VIEW_MISSING" });
          }
          set({ battle: toBattleState(res.battle as ServerBattleView) } as any);
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

      healAll: async () => {
        // P3-2：治疗从「客户端回满」改成「服务端确认你在恢复中心再回满」。
        // 以前这个函数在任何地点都能调，等于无限免费回血。
        return serverOp(get, "heal", {});
      },

      useItemOutsideBattle: async (itemId, partyIndex) => {
        // P3-2：道具消耗、回复量、解异常、进化石条件与进化后数值全在服务端算。
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const target = save?.party[partyIndex];
        if (!target) return { ok: false, reason: "找不到这只幻兽" };
        return serverOp(get, "use_item", { itemId, monsterId: target.id });
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

      movePartyToBox: async (partyIndex) => serverOp(get, "move_to_box", { partyIndex }),

      moveBoxToParty: async (boxIndex) => serverOp(get, "move_to_party", { boxIndex }),

      releaseMonster: async (id) => serverOp(get, "release", { monsterId: id }),

      resolvePendingMove: async (monsterId, oldMoveId, newMoveId, opts) =>
        serverOp(get, "learn_move", {
          monsterId,
          oldMoveId,
          newMoveId,
          ...(opts?.discard ? { discard: true } : {}),
        }),

      resolvePendingEvolution: async (monsterId, accept) =>
        serverOp(get, "evolve", { monsterId, accept }),

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

