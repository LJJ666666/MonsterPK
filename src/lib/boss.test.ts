/**
 * P4-2c 前端 Boss 视图层：只测「防御性解析」。
 *
 * 这里**不测任何伤害计算**——客户端没有这个能力，也不该有。
 * 需要保证的是：脏响应不会把非法数据带进 UI，缺字段有合理兜底。
 */
import { describe, expect, it } from "vitest";
import { parseBossList, parseBossRank } from "./boss";

const entry = {
  bossId: "boss_ember_behemoth",
  name: "烈焰巨兽 · 讨伐",
  speciesId: "ember_behemoth",
  speciesName: "烈焰巨兽",
  level: 12,
  theme: "volcano",
  description: "测试",
  dailyLimit: 3,
  used: 1,
  held: 0,
  remaining: 2,
  my: { total: 4200, best: 1800, attempts: 1 },
};

const row = {
  rank: 1, username: "杰哥", slot: 1, damage: 4200, best: 1800, attempts: 2, isMe: true,
};

describe("parseBossList", () => {
  it("解析正常列表并保留我的次数与伤害", () => {
    const list = parseBossList({ ok: true, periodKey: "2026-11-07", bosses: [entry] });
    expect(list).not.toBeNull();
    expect(list![0].bossId).toBe("boss_ember_behemoth");
    expect(list![0].remaining).toBe(2);
    expect(list![0].my.total).toBe(4200);
  });

  it("ok 不为 true / 缺 bosses 时整份拒绝", () => {
    expect(parseBossList(null)).toBeNull();
    expect(parseBossList({ ok: false, bosses: [] })).toBeNull();
    expect(parseBossList({ ok: true })).toBeNull();
    expect(parseBossList([])).toBeNull();
  });

  it("逐条丢弃非法行，不影响其他行", () => {
    const list = parseBossList({ ok: true, bosses: [entry, { bossId: "" }, 42, null] });
    expect(list).toHaveLength(1);
  });

  it("数值字段缺失或负数按 0 处理", () => {
    const list = parseBossList({
      ok: true,
      bosses: [{ bossId: "b1", name: "x", level: 5, dailyLimit: 1, used: -3, remaining: NaN }],
    });
    expect(list![0].used).toBe(0);
    expect(list![0].remaining).toBe(0);
    expect(list![0].my).toEqual({ total: 0, best: 0, attempts: 0 });
  });
});

describe("parseBossRank", () => {
  it("解析正常榜单并带出 me", () => {
    const rank = parseBossRank({
      ok: true, bossId: "b1", bossName: "Boss", periodKey: "2026-11-07",
      generatedAt: "2026-11-07T12:00:00.000Z", entries: [row], me: { total: 4200, best: 1800, attempts: 2 },
    });
    expect(rank).not.toBeNull();
    expect(rank!.entries[0].isMe).toBe(true);
    expect(rank!.me.attempts).toBe(2);
  });

  it("缺 bossId 或 entries 不是数组时拒绝", () => {
    expect(parseBossRank({ ok: true, entries: [] })).toBeNull();
    expect(parseBossRank({ ok: true, bossId: "b1", entries: {} })).toBeNull();
    expect(parseBossRank("oops")).toBeNull();
  });

  it("非法行被丢弃；缺 me 时返回全 0", () => {
    const rank = parseBossRank({
      ok: true, bossId: "b1", entries: [row, { rank: "1" }, { ...row, damage: Infinity }],
    });
    expect(rank!.entries).toHaveLength(1);
    expect(rank!.me).toEqual({ total: 0, best: 0, attempts: 0 });
  });

  it("没有 isMe 字段的行不进 UI（避免误标「我」）", () => {
    const { isMe, ...withoutMe } = row;
    void isMe;
    const rank = parseBossRank({ ok: true, bossId: "b1", entries: [withoutMe] });
    expect(rank!.entries).toHaveLength(0);
  });
});
