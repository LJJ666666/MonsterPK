// P4-2a 榜单视图层单测：类型清单、防御性解析、数值文案、免责口径。
import { describe, it, expect } from "vitest";
import {
  RANK_TABS, RANK_DISCLAIMER, isRankType, parseRankBoard,
  formatRankValue, rankTabLabel, type RankRow,
} from "./rank";

const row: RankRow = {
  rank: 1, username: "amy", slot: 1, value: 468,
  secondary: 468, detail: "出战 1 只六维总和", isMe: false,
};

const res = {
  ok: true, type: "team_power", label: "全队战力", unit: "战力",
  description: "出战队伍各只六维总和之和", disclaimer: RANK_DISCLAIMER,
  generatedAt: "2026-11-07T00:00:00.000Z", eligible: 3, entries: [row],
  readonly: true, source: "server_save",
};

describe("榜单类型清单", () => {
  it("四张榜且与服务端 RANK_TYPES 对齐", () => {
    expect(RANK_TABS.map((t) => t.type)).toEqual([
      "monster_power", "team_power", "summoner_level", "progress",
    ]);
    expect(new Set(RANK_TABS.map((t) => t.type)).size).toBe(4);
  });
  it("isRankType 拒绝未知与伪造类型", () => {
    for (const t of RANK_TABS) expect(isRankType(t.type)).toBe(true);
    expect(isRankType("power")).toBe(false);
    expect(isRankType(null)).toBe(false);
    expect(isRankType(1)).toBe(false);
  });
  it("标签映射完整", () => {
    expect(rankTabLabel("progress")).toBe("推图");
    expect(rankTabLabel("monster_power")).toBe("单宠战力");
  });
});

describe("榜单响应防御性解析", () => {
  it("合法响应解析成功且保留服务端文案", () => {
    const b = parseRankBoard(res)!;
    expect(b.type).toBe("team_power");
    expect(b.entries).toHaveLength(1);
    expect(b.disclaimer).toBe(RANK_DISCLAIMER);
    expect(b.eligible).toBe(3);
  });
  it("响应缺 ok / 未知类型 / entries 非数组一律拒绝", () => {
    expect(parseRankBoard(null)).toBeNull();
    expect(parseRankBoard({ ...res, ok: false })).toBeNull();
    expect(parseRankBoard({ ...res, type: "hacked" })).toBeNull();
    expect(parseRankBoard({ ...res, entries: "oops" })).toBeNull();
    expect(parseRankBoard([])).toBeNull();
  });
  it("非法行逐条过滤，不把脏数据渲染进 UI", () => {
    const b = parseRankBoard({
      ...res,
      entries: [row, { ...row, value: NaN }, { ...row, username: "" }, null, { rank: 2 }],
    })!;
    expect(b.entries).toHaveLength(1);
    expect(b.entries[0].username).toBe("amy");
  });
  it("缺 disclaimer 时回落到固定免责口径", () => {
    const b = parseRankBoard({ ...res, disclaimer: undefined })!;
    expect(b.disclaimer).toBe(RANK_DISCLAIMER);
  });
});

describe("数值文案与免责声明", () => {
  it("战力 / 等级 / 推图三种格式", () => {
    expect(formatRankValue("team_power", row)).toBe("468 战力");
    expect(formatRankValue("monster_power", row)).toBe("468 战力");
    expect(formatRankValue("summoner_level", row)).toBe("Lv.468");
    expect(formatRankValue("progress", row)).toBe("468 区");
  });
  it("战力不代表实战强弱（口径不可丢）", () => {
    expect(RANK_DISCLAIMER).toContain("不代表实战强弱");
    expect(RANK_DISCLAIMER).toContain("六维总和");
  });
});
