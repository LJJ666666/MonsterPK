/**
 * P3-1c：前端战斗入口 → 服务端意图的接线测试。
 *
 * 这里不测数值（伤害/命中/捕获率都在服务端，由 backend 的 battleEngine / numericRules 覆盖），
 * 只测**接线**：五个入口有没有真的把动作发给 `/api/battle/*`、有没有把回包正确落到 store、
 * 以及「服务端不可达」时会不会安全降级而不是白屏或凭空结算。
 *
 * 为什么这一层必须有测试：P3-1c 之前战斗全在客户端跑，改完之后只要有一个入口忘了分流，
 * 玩家就会在「服务端战斗」里用客户端算法算伤害 —— 表现上看不出来，但反作弊直接失效。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

// —— 最小浏览器环境（store 用 persist + localStorage，auth 读 token）——
const mem = new Map<string, string>();
(globalThis as any).localStorage = {
  getItem: (k: string) => mem.get(k) ?? null,
  setItem: (k: string, v: string) => void mem.set(k, v),
  removeItem: (k: string) => void mem.delete(k),
  clear: () => mem.clear(),
  key: (i: number) => [...mem.keys()][i] ?? null,
  get length() {
    return mem.size;
  },
};
// persist 的 storage 会 fetch /api/save；测试里让它 404（等同于「还没有云端存档」）
(globalThis as any).fetch = async () => ({ ok: false, status: 404, text: async () => "" });

vi.mock("@/lib/api", () => ({
  API_BASE: "http://127.0.0.1:3001",
  UNAUTHORIZED_EVENT: "mpk:unauthorized",
  BANNED_EVENT: "mpk:banned",
  BAN_CODE: "ACCOUNT_BANNED",
  api: {
    battleStart: vi.fn(),
    battleAction: vi.fn(),
    battleCurrent: vi.fn(),
    battleAbandon: vi.fn(),
    bossStart: vi.fn(),
    getSave: vi.fn(async () => ({ data: null })),
  },
}));

import { api } from "@/lib/api";
import { useGameStore } from "@/stores/useGameStore";
import type { BattleState, MonsterInstance, SaveData } from "@/game/types";
import type { ServerBattleView } from "@/lib/battleApi";

function b64url(obj: any): string {
  return Buffer.from(JSON.stringify(obj)).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}
/** 造一个未过期的 JWT 放进 localStorage，让 canUseServerBattle() 为 true。 */
function loginAs(userId = "u1"): void {
  const now = Math.floor(Date.now() / 1000);
  const token = `${b64url({ alg: "HS256", typ: "JWT" })}.${b64url({ userId, iat: now, exp: now + 3600 })}.sig`;
  mem.set("mpk_token", token);
  mem.set("mpk_client_id", "cid_test");
}

function monster(over: Partial<MonsterInstance> = {}): MonsterInstance {
  return {
    id: "m1",
    specId: "sprout_owl",
    level: 5,
    exp: 0,
    element: "grass",
    maxHp: 57,
    hp: 57,
    atk: 63,
    def: 54,
    spAtk: 71,
    spDef: 61,
    spd: 76,
    status: "none",
    moveIds: ["tackle", "vine_whip"],
    initStats: { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 },
    growthRates: { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 },
    ...over,
  };
}

function makeSave(): SaveData {
  return {
    version: "11",
    playerName: "旅行者",
    money: 1200,
    steps: 340,
    locationId: "town_starter",
    lastHealLocationId: "town_starter",
    visitedLocationIds: ["town_starter"],
    party: [monster()],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 } as any,
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: {},
    lastSavedAt: new Date().toISOString(),
  };
}

const MODS = { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 };

function view(over: Partial<ServerBattleView> = {}): ServerBattleView {
  return {
    battleId: "bt_1",
    turn: 1,
    finished: false,
    result: null,
    log: ["遭遇：野生 芽羽鸮"],
    areaName: "测试草地",
    theme: "grass",
    areaId: null,
    levelMin: 1,
    levelMax: 5,
    playerActiveIndex: 0,
    playerMods: { ...MODS },
    enemyMods: { ...MODS },
    enemy: monster({ id: "e1", specId: "ember_marmot", hp: 30, maxHp: 50 }),
    party: [monster()],
    ppByMonster: { m1: { tackle: 34, vine_whip: 24 }, e1: { tackle: 34 } },
    rewards: null,
    captured: null,
    consumed: {},
    actions: 1,
    ...over,
  };
}

const startArgs = ["grass", "测试草地", 1, 5] as const;

beforeEach(() => {
  mem.clear();
  vi.clearAllMocks();
  loginAs();
  useGameStore.setState({ save: makeSave(), battle: null });
  (api.battleStart as any).mockResolvedValue({ ok: true, battle: view(), ttlMs: 1_800_000 });
  (api.battleAction as any).mockResolvedValue({ ok: true, battle: view({ turn: 2 }), settled: false });
  (api.battleCurrent as any).mockResolvedValue({ ok: true, battle: null });
  (api.battleAbandon as any).mockResolvedValue({ ok: true });
});

function currentBattle(): BattleState | null {
  return useGameStore.getState().battle;
}

describe("startEncounter：开局走服务端", () => {
  it("调用 /api/battle/start 并把服务端战斗落到 store", async () => {
    const res = await useGameStore.getState().startEncounter(...startArgs);
    expect(res.ok).toBe(true);
    expect(api.battleStart).toHaveBeenCalledTimes(1);
    const b = currentBattle();
    expect(b?.serverId).toBe("bt_1");
    // 队伍副本来自服务端（带技能列表），UI 靠它渲染技能面板
    expect(b?.serverParty?.[0].moveIds).toEqual(["tackle", "vine_whip"]);
  });

  it("开局不改本地存档：图鉴「已见」与队伍 HP 都等服务端结算", async () => {
    const before = JSON.stringify(useGameStore.getState().save);
    await useGameStore.getState().startEncounter("grass", "测试草地", 1, 5);
    expect(JSON.stringify(useGameStore.getState().save)).toBe(before);
  });

  it("请求参数带上区域与等级区间（服务端据此校准真值）", async () => {
    await useGameStore.getState().startEncounter("grass", "测试草地", 2, 6, "area_a");
    expect(api.battleStart).toHaveBeenCalledWith(
      expect.objectContaining({ theme: "grass", areaName: "测试草地", areaId: "area_a", levelMin: 2, levelMax: 6 }),
    );
  });

  it("业务拒绝（4xx）如实报错，不偷偷换成客户端战斗", async () => {
    (api.battleStart as any).mockRejectedValue(Object.assign(new Error("队伍为空"), { status: 400, code: "PARTY_EMPTY" }));
    const res = await useGameStore.getState().startEncounter(...startArgs);
    expect(res).toEqual({ ok: false, reason: "队伍为空" });
    expect(currentBattle()).toBeNull();
  });

  it("服务端不可达（网络层失败）→ 如实报错，不再降级本地战斗", async () => {
    // 2026-11-07：本地降级已删除。本地战果必然被服务端增量核对拒绝，
    // 只会留下「打完不认」和同步 400 死循环，收益为零。
    const saveBefore = JSON.stringify(useGameStore.getState().save);
    (api.battleStart as any).mockRejectedValue(new TypeError("Failed to fetch"));
    const res = await useGameStore.getState().startEncounter(...startArgs);
    expect(res.ok).toBe(false);
    expect((res as { reason?: string }).reason ?? "").toContain("网络中断");
    expect(currentBattle()).toBeNull();
    // 开局失败不能偷偷写档（旧实现会给图鉴补 seen 并刷新 lastSavedAt）
    expect(JSON.stringify(useGameStore.getState().save)).toBe(saveBefore);
  });

  it("未登录 → 拒绝开局，不发任何请求", async () => {
    mem.clear();
    const res = await useGameStore.getState().startEncounter(...startArgs);
    expect(res.ok).toBe(false);
    expect((res as { reason?: string }).reason ?? "").toContain("尚未登录");
    expect(api.battleStart).not.toHaveBeenCalled();
    expect(currentBattle()).toBeNull();
  });
});

describe("五个战斗入口：转成对应意图", () => {
  beforeEach(async () => {
    await useGameStore.getState().startEncounter(...startArgs);
  });

  it("useMove → { type: 'move', moveId }", async () => {
    await useGameStore.getState().useMove("tackle" as any);
    expect(api.battleAction).toHaveBeenCalledWith(
      expect.objectContaining({ battleId: "bt_1", action: { type: "move", moveId: "tackle" } }),
    );
    expect(currentBattle()?.turn).toBe(2);
  });

  it("useItem(回复药) → { type: 'item' }", async () => {
    await useGameStore.getState().useItem("potion_small" as any);
    expect(api.battleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "item", itemId: "potion_small" } }),
    );
  });

  it("useItem(精灵球) → { type: 'capture' }：捕获判定在服务端", async () => {
    await useGameStore.getState().useItem("capsule_basic" as any);
    expect(api.battleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "capture", itemId: "capsule_basic" } }),
    );
  });

  it("switchTo → { type: 'switch', partyIndex }", async () => {
    useGameStore.getState().switchTo(0);
    await vi.waitFor(() => expect(api.battleAction).toHaveBeenCalled());
    expect(api.battleAction).toHaveBeenCalledWith(
      expect.objectContaining({ action: { type: "switch", partyIndex: 0 } }),
    );
  });

  it("flee → { type: 'flee' }：逃跑骰子在服务端", async () => {
    useGameStore.getState().flee();
    await vi.waitFor(() => expect(api.battleAction).toHaveBeenCalled());
    expect(api.battleAction).toHaveBeenCalledWith(expect.objectContaining({ action: { type: "flee" } }));
  });
});

describe("并发与异常：不能用客户端算法兜底", () => {
  beforeEach(async () => {
    await useGameStore.getState().startEncounter(...startArgs);
  });

  it("动作在途时再点一次 → 不重复发请求（防连点把回合打两次）", async () => {
    let release!: (v: any) => void;
    (api.battleAction as any).mockReturnValue(new Promise((r) => { release = r; }));
    void useGameStore.getState().useMove("tackle" as any);
    await vi.waitFor(() => expect(currentBattle()?.pending).toBe(true));
    void useGameStore.getState().useMove("tackle" as any);
    expect(api.battleAction).toHaveBeenCalledTimes(1);
    release({ ok: true, battle: view({ turn: 2 }), settled: false });
    await vi.waitFor(() => expect(currentBattle()?.pending).toBe(false));
  });

  it("战斗已被服务端回收（BATTLE_NOT_FOUND）→ 标记结束并提示，不重打", async () => {
    (api.battleAction as any).mockRejectedValue(
      Object.assign(new Error("战斗不存在或已结束"), { status: 404, code: "BATTLE_NOT_FOUND" }),
    );
    await useGameStore.getState().useMove("tackle" as any);
    const b = currentBattle();
    expect(b?.finished).toBe(true);
    expect(b?.log.at(-1)).toContain("在服务端已经不存在");
  });

  it("网络抖动 → 只回滚 pending 并提示，不改任何战斗数值", async () => {
    (api.battleAction as any).mockRejectedValue(new TypeError("Failed to fetch"));
    const before = currentBattle()!;
    await useGameStore.getState().useMove("tackle" as any);
    const after = currentBattle()!;
    expect(after.pending).toBe(false);
    expect(after.enemy.hp).toBe(before.enemy.hp);
    expect(after.serverParty?.[0].hp).toBe(before.serverParty?.[0].hp);
    expect(after.log.at(-1)).toContain("操作未生效");
  });

  it("结算完成 → 触发一次存档拉取（WS 未连接时的 HTTP 兜底）", async () => {
    (api.battleAction as any).mockResolvedValue({
      ok: true,
      battle: view({ finished: true, result: "enemy_fainted", turn: 5 }),
      settled: true,
      revision: 7,
    });
    await useGameStore.getState().useMove("tackle" as any);
    expect(currentBattle()?.finished).toBe(true);
    expect(currentBattle()?.result).toBe("enemy_fainted");
    expect(api.getSave).toHaveBeenCalledWith();
  });
});

describe("leaveBattle：中途离开要通知服务端", () => {
  it("战斗未结束 → 调 abandon，避免服务端会话悬挂", async () => {
    await useGameStore.getState().startEncounter(...startArgs);
    useGameStore.getState().leaveBattle();
    await vi.waitFor(() => expect(api.battleAbandon).toHaveBeenCalledWith("bt_1"));
    expect(currentBattle()).toBeNull();
  });

  it("战斗已结束 → 不再发 abandon（服务端已 drop）", async () => {
    (api.battleStart as any).mockResolvedValue({ ok: true, battle: view({ finished: true, result: "fled" }) });
    await useGameStore.getState().startEncounter(...startArgs);
    useGameStore.getState().leaveBattle();
    expect(api.battleAbandon).not.toHaveBeenCalled();
  });
});

describe("resumeBattle：刷新后取回服务端战斗", () => {
  it("没有本地战斗时拉 current 并落地", async () => {
    (api.battleCurrent as any).mockResolvedValue({ ok: true, battle: view({ turn: 4 }) });
    await useGameStore.getState().resumeBattle();
    expect(currentBattle()?.serverId).toBe("bt_1");
    expect(currentBattle()?.turn).toBe(4);
  });

  it("本地已有战斗 → 不覆盖（避免把正在打的场次换掉）", async () => {
    (api.battleCurrent as any).mockResolvedValue({ ok: true, battle: view({ battleId: "bt_other" }) });
    await useGameStore.getState().startEncounter(...startArgs);
    await useGameStore.getState().resumeBattle();
    expect(api.battleCurrent).not.toHaveBeenCalled();
    expect(currentBattle()?.serverId).toBe("bt_1");
  });

  it("服务端没有存活战斗 → 保持空态，不报错", async () => {
    (api.battleCurrent as any).mockRejectedValue(Object.assign(new Error("x"), { status: 404 }));
    await expect(useGameStore.getState().resumeBattle()).resolves.toBeUndefined();
    expect(currentBattle()).toBeNull();
  });
});
