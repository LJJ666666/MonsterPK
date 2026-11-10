// F01/F02 周期榜与奖励的前端解析单测。
// 客户端只做防御性解析：脏响应一律不进 UI，绝不把服务端之外的数值当真值。
import { describe, it, expect } from "vitest";
import {
  parseRankPeriods, parsePeriodBoards, parseMyRewards, formatReward,
} from "./rank";

const row = {
  rank: 1, username: "amy", value: 468, secondary: 2,
  detail: "出战 1 只六维总和", isMe: false,
};

const periodsRes = {
  ok: true, readonly: true, granularity: "day",
  currentPeriodKey: "2026-11-09", previousPeriodKey: "2026-11-08", rewardMaxRank: 10,
  boards: [{ boardKey: "rank:team_power", label: "全队战力", rewardTiers: [
    { rank: 1, reward: { money: 300, items: [{ itemId: "capsule_prism", count: 1 }] } },
  ] }],
  periods: [
    { periodKey: "2026-11-08", settledAt: "2026-11-09T00:00:00.000Z" },
    { periodKey: "坏键", settledAt: "2026-11-08T00:00:00.000Z" },
  ],
};

describe("F01 周期清单解析", () => {
  it("正常响应保留结构与奖励档位，非法周期键逐条丢弃", () => {
    const p = parseRankPeriods(periodsRes)!;
    expect(p).not.toBeNull();
    expect(p.currentPeriodKey).toBe("2026-11-09");
    expect(p.rewardMaxRank).toBe(10);
    expect(p.periods).toHaveLength(1);
    expect(p.boards[0].rewardTiers[0].reward.money).toBe(300);
  });
  it("非只读 / 缺周期键 / 脏响应一律不进 UI", () => {
    expect(parseRankPeriods({ ...periodsRes, readonly: false })).toBeNull();
    expect(parseRankPeriods({ ...periodsRes, currentPeriodKey: "yesterday" })).toBeNull();
    expect(parseRankPeriods(null)).toBeNull();
    expect(parseRankPeriods([])).toBeNull();
  });
});

describe("F01 历史榜解析", () => {
  it("逐条过滤非法行，保留服务端重标的 isMe", () => {
    const b = parsePeriodBoards({
      ok: true, readonly: true, periodKey: "2026-11-08",
      boards: [{ boardKey: "rank:team_power", label: "全队战力",
        entries: [row, { ...row, value: NaN }, null, { rank: 2 }] }],
    })!;
    expect(b.boards[0].entries).toHaveLength(1);
    expect(b.boards[0].entries[0].username).toBe("amy");
  });
  it("缺 boards 或周期键非法 → null", () => {
    expect(parsePeriodBoards({ ok: true, readonly: true, periodKey: "bad" })).toBeNull();
    expect(parsePeriodBoards({ ok: false, readonly: true, periodKey: "2026-11-08", boards: [] })).toBeNull();
  });
});

describe("F02 奖励记录解析", () => {
  it("奖励数值只来自服务端下发，非法记录逐条丢弃", () => {
    const r = parseMyRewards({
      ok: true, readonly: true,
      entries: [
        { periodKey: "2026-11-08", boardKey: "rank:team_power", label: "全队战力",
          rank: 1, reward: { money: 300, items: [{ itemId: "capsule_prism", count: 1 }] },
          revision: 7, grantedAt: "2026-11-09T00:00:00.000Z" },
        { periodKey: "坏键", label: "x", rank: 1, reward: {} },
      ],
    })!;
    expect(r.entries).toHaveLength(1);
    expect(r.entries[0].reward.money).toBe(300);
    expect(r.entries[0].revision).toBe(7);
  });
  it("非只读响应不进 UI（防止客户端被诱导展示可领取状态）", () => {
    expect(parseMyRewards({ ok: true, readonly: false, entries: [] })).toBeNull();
  });
  it("奖励文案只展示服务端下发的数值", () => {
    expect(formatReward({ money: 300, items: [{ itemId: "capsule_prism", count: 1 }] }))
      .toContain("金币 300");
    expect(formatReward({ money: 0, items: [] })).toBe("无");
  });
});
