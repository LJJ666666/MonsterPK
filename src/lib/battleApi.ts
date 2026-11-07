/**
 * P3-1c 服务端战斗适配层。
 *
 * 职责边界（只有两件事）：
 *  1. 把客户端意图转成 `/api/battle/*` 请求；
 *  2. 把服务端下发的 `battleView` 映射成前端渲染用的 `BattleState`。
 *
 * **不做任何数值计算**：伤害、命中、暴击、敌方选招、捕获成败、经验金钱全在服务端。
 * 这里出现的 `Math.*` 只用于 UI 兜底（缺字段时给 0），不参与战斗判定。
 *
 * 为什么需要映射而不是直接用服务端结构：
 *  - 服务端没「本地降级模式」这个概念，前端 BattleState 要同时承载两种来源；
 *  - `ppByMonster` 在服务端用 `Record<string, number>`，前端用 `Record<MoveId, number>`；
 *  - 服务端 `result: null` 与前端 `result?: undefined` 需要归一。
 */
import { api } from "./api";
import { isLoggedIn } from "./auth";
import type { BattleState, ItemId, MonsterInstance, MoveId, StatModifiers } from "@/game/types";

/** 服务端 `battleView()` 的结构（字段随 P3-1c 扩展过，见 backend/src/game/battle.ts）。 */
export type ServerBattleView = {
  battleId: string;
  turn: number;
  finished: boolean;
  result: "captured" | "enemy_fainted" | "fled" | "player_fainted" | null;
  log: string[];
  areaName: string;
  theme: string;
  areaId: string | null;
  levelMin: number;
  levelMax: number;
  playerActiveIndex: number;
  playerMods: StatModifiers;
  enemyMods: StatModifiers;
  enemy: MonsterInstance;
  party: MonsterInstance[];
  ppByMonster: Record<string, Record<string, number>>;
  rewards: { expGain: number; moneyGain: number } | null;
  captured: MonsterInstance | null;
  consumed: Record<string, number>;
  actions: number;
};

/** 战斗接口的业务错误：区分「战斗没了」与「网络不通」，前者不能降级到本地重打。 */
export type BattleFailure = {
  /** 服务端业务码（BATTLE_NOT_FOUND / ITEM_NOT_ENOUGH / PARTY_FAINTED …） */
  code?: string;
  status?: number;
  message: string;
  /** true = 网络层失败（后端不可达），可以降级到本地战斗 */
  transient: boolean;
};

export function toFailure(e: unknown): BattleFailure {
  const any = e as any;
  // api.request 在 HTTP 非 2xx 时抛带 status/code 的 Error；fetch 本身失败时只有 message。
  const status = typeof any?.status === "number" ? any.status : undefined;
  return {
    code: typeof any?.code === "string" ? any.code : undefined,
    status,
    message: any?.message ?? "战斗请求失败",
    transient: status === undefined || status >= 500,
  };
}

/** 服务端是否有可用战斗（仅本地粗判，真正的鉴权在服务端）。 */
export function canUseServerBattle(): boolean {
  return isLoggedIn();
}

/** `battleView` → 前端 `BattleState`。纯函数，便于单测。 */
export function toBattleState(view: ServerBattleView): BattleState {
  const pp: Record<string, Record<MoveId, number>> = {};
  for (const [id, table] of Object.entries(view.ppByMonster ?? {})) {
    pp[id] = { ...(table as Record<MoveId, number>) };
  }
  return {
    theme: view.theme as BattleState["theme"],
    areaName: view.areaName,
    areaId: view.areaId ?? undefined,
    levelMin: view.levelMin,
    levelMax: view.levelMax,
    turn: view.turn,
    log: Array.isArray(view.log) ? view.log : [],
    playerActiveIndex: view.playerActiveIndex,
    playerStatMods: view.playerMods,
    enemyStatMods: view.enemyMods,
    enemy: view.enemy,
    ppByMonster: pp,
    finished: !!view.finished,
    result: view.result ?? undefined,
    serverId: view.battleId,
    serverParty: Array.isArray(view.party) ? view.party : [],
    pending: false,
  };
}

export type StartInput = {
  slot: number;
  theme: string;
  areaName: string;
  areaId?: string;
  levelMin: number;
  levelMax: number;
  testFlags?: { testShiny?: boolean; testMaxStats?: boolean; testOHKO?: boolean };
};

export type ActionInput =
  | { type: "move"; moveId: MoveId }
  | { type: "item"; itemId: ItemId }
  | { type: "capture"; itemId: ItemId }
  | { type: "switch"; partyIndex: number }
  | { type: "flee" };

export const battleApi = {
  /** 开局。返回服务端战斗视图；失败抛原始错误，由调用方 `toFailure` 归一。 */
  async start(input: StartInput): Promise<ServerBattleView> {
    const res = await api.battleStart({
      slot: input.slot,
      theme: input.theme,
      areaName: input.areaName,
      areaId: input.areaId ?? null,
      levelMin: input.levelMin,
      levelMax: input.levelMax,
      ...(input.testFlags ? { testFlags: input.testFlags } : {}),
    });
    if (!res?.battle) throw Object.assign(new Error("服务端没有返回战斗"), { code: "BATTLE_VIEW_MISSING" });
    return res.battle as ServerBattleView;
  },

  /** 发动作。返回最新视图 + 是否已结算落档。 */
  async action(
    slot: number,
    battleId: string,
    action: ActionInput,
  ): Promise<{ view: ServerBattleView; settled: boolean; revision?: number }> {
    const res = await api.battleAction({ battleId, slot, action: action as any });
    if (!res?.battle) throw Object.assign(new Error("服务端没有返回战斗"), { code: "BATTLE_VIEW_MISSING" });
    return { view: res.battle as ServerBattleView, settled: !!res.settled, revision: res.revision };
  },

  /** 取回仍存活的战斗（刷新/断线重连）。没有则返回 null。 */
  async current(slot: number): Promise<ServerBattleView | null> {
    const res = await api.battleCurrent(slot);
    return (res?.battle as ServerBattleView) ?? null;
  },

  async abandon(slot: number, battleId: string): Promise<void> {
    await api.battleAbandon(battleId, slot);
  },
};
