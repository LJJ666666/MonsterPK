import { describe, expect, it } from "vitest";
import { toBattleState, toFailure, type ServerBattleView } from "@/lib/battleApi";
import type { MonsterInstance, StatModifiers } from "@/game/types";

const MODS: StatModifiers = { atk: 1, def: 0, spAtk: 0, spDef: 0, spd: -1, accuracy: 0, evasion: 0 };

function monster(over: Partial<MonsterInstance> = {}): MonsterInstance {
  return {
    id: "m1",
    specId: "sprout_owl",
    level: 5,
    exp: 10,
    element: "grass",
    maxHp: 57,
    hp: 40,
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

function view(over: Partial<ServerBattleView> = {}): ServerBattleView {
  return {
    battleId: "bt_abc",
    turn: 3,
    finished: false,
    result: null,
    log: ["遭遇：野生 芽羽鸮", "你使用了撞击。"],
    areaName: "测试草地",
    theme: "grass",
    areaId: "area_a",
    levelMin: 1,
    levelMax: 5,
    playerActiveIndex: 0,
    playerMods: MODS,
    enemyMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemy: monster({ id: "e1", specId: "ember_marmot", hp: 12, maxHp: 50 }),
    party: [monster()],
    ppByMonster: { m1: { tackle: 34, vine_whip: 24 }, e1: { tackle: 34 } },
    rewards: null,
    captured: null,
    consumed: {},
    actions: 3,
    ...over,
  };
}

describe("battleApi.toBattleState：服务端视图 → 前端渲染态", () => {
  it("保留服务端战斗 id 与我方队伍副本", () => {
    const b = toBattleState(view());
    expect(b.serverId).toBe("bt_abc");
    expect(b.serverParty).toHaveLength(1);
    // 队伍副本必须带技能列表，否则 UI 的技能面板是空的
    expect(b.serverParty?.[0].moveIds).toEqual(["tackle", "vine_whip"]);
  });

  it("战斗进程字段逐个对齐（回合 / 出战位 / 增益 / 日志）", () => {
    const b = toBattleState(view());
    expect(b.turn).toBe(3);
    expect(b.playerActiveIndex).toBe(0);
    expect(b.playerStatMods).toEqual(MODS);
    expect(b.enemy.hp).toBe(12);
    expect(b.log).toHaveLength(2);
    // levelMin/levelMax 用于「继续探索」再开一场同难度的战斗
    expect(b.levelMin).toBe(1);
    expect(b.levelMax).toBe(5);
  });

  it("pending 归零：服务端响应到达即代表本次动作已完成", () => {
    expect(toBattleState(view()).pending).toBe(false);
  });

  it("result: null 归一成 undefined（前端约定用可选字段）", () => {
    expect(toBattleState(view()).result).toBeUndefined();
    expect(toBattleState(view({ finished: true, result: "captured" })).result).toBe("captured");
  });

  it("areaId: null 归一成 undefined（前端用可选字段判断首通记录）", () => {
    expect(toBattleState(view({ areaId: null })).areaId).toBeUndefined();
    expect(toBattleState(view()).areaId).toBe("area_a");
  });

  it("ppByMonster 做浅拷贝，不与服务端响应对象共享引用", () => {
    const src = view();
    const b = toBattleState(src);
    b.ppByMonster.m1.tackle = 0;
    expect(src.ppByMonster.m1.tackle).toBe(34);
  });

  it("缺字段时不抛异常（服务端旧版本 / 网络截断时的兜底）", () => {
    const broken = view({ log: undefined as any, party: undefined as any, ppByMonster: undefined as any });
    const b = toBattleState(broken);
    expect(b.log).toEqual([]);
    expect(b.serverParty).toEqual([]);
    expect(b.ppByMonster).toEqual({});
  });
});

describe("battleApi.toFailure：错误归一（决定能否降级到本地战斗）", () => {
  it("网络层失败（没有 status）→ transient，可降级本地战斗", () => {
    const f = toFailure(new TypeError("Failed to fetch"));
    expect(f.transient).toBe(true);
    expect(f.status).toBeUndefined();
  });

  it("服务端 5xx → transient（后端临时故障，允许降级）", () => {
    const e: any = new Error("Internal Server Error");
    e.status = 503;
    expect(toFailure(e).transient).toBe(true);
  });

  it("业务拒绝 4xx → 不可降级，必须把原因讲给玩家", () => {
    const e: any = new Error("队伍为空");
    e.status = 400;
    e.code = "PARTY_EMPTY";
    const f = toFailure(e);
    expect(f.transient).toBe(false);
    expect(f.code).toBe("PARTY_EMPTY");
    expect(f.message).toBe("队伍为空");
  });

  it("BATTLE_NOT_FOUND 保留业务码（前端据此结束本地战斗态而不是重打）", () => {
    const e: any = new Error("战斗不存在或已结束");
    e.status = 404;
    e.code = "BATTLE_NOT_FOUND";
    const f = toFailure(e);
    expect(f.code).toBe("BATTLE_NOT_FOUND");
    expect(f.transient).toBe(false);
  });

  it("被 401 拦下 → 不降级（会话已失效，降级只会掩盖登录问题）", () => {
    const e: any = new Error("登录已过期");
    e.status = 401;
    expect(toFailure(e).transient).toBe(false);
  });
});
