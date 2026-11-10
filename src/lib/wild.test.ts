// P4-1b 共享野怪：前端协议与状态文案单测。
import { describe, it, expect } from "vitest";
import { wildStatusText, SHARED_WILD_AREA_ID } from "./wild";
import { isWildStateMessage, parseServerMessage } from "./ws";
import type { WildMonsterView } from "./sessionState";

const base: WildMonsterView = {
  id: "w1", areaId: SHARED_WILD_AREA_ID, speciesId: "spark_mouse",
  name: "电光鼠", level: 3, label: "野生 电光鼠",
  status: "available", result: null, expiresAt: 1,
};

describe("共享野怪状态文案", () => {
  it("可挑战 / 已被挑战", () => {
    expect(wildStatusText(base)).toBe("可挑战");
    expect(wildStatusText({ ...base, status: "claimed" })).toBe("已被挑战");
  });
  it("结算结果按类型区分", () => {
    expect(wildStatusText({ ...base, status: "resolved", result: "captured" })).toBe("已被捕获");
    expect(wildStatusText({ ...base, status: "resolved", result: "defeated" })).toBe("已被击败");
    expect(wildStatusText({ ...base, status: "resolved", result: "fled" })).toBe("已逃走");
    expect(wildStatusText({ ...base, status: "resolved", result: null })).toBe("已逃走");
  });
});

describe("wild.state 下行校验", () => {
  it("合法快照通过", () => {
    const m = parseServerMessage(JSON.stringify({
      type: "wild.state", areaId: SHARED_WILD_AREA_ID, revision: 7, monsters: [base],
    }));
    expect(isWildStateMessage(m)).toBe(true);
  });
  it("缺字段 / 类型错 / 非数组一律拒绝，避免脏数据进 UI", () => {
    expect(isWildStateMessage(null)).toBe(false);
    expect(isWildStateMessage(parseServerMessage('{"type":"wild.state","areaId":"a","revision":1}'))).toBe(false);
    expect(isWildStateMessage(parseServerMessage('{"type":"wild.state","areaId":"a","revision":"7","monsters":[]}'))).toBe(false);
    expect(isWildStateMessage(parseServerMessage('{"type":"wild.state","areaId":3,"revision":7,"monsters":[]}'))).toBe(false);
  });
  it("session.state 不会被误判成 wild.state", () => {
    const m = parseServerMessage('{"type":"session.state","revision":2,"data":"{}","updatedAt":1}');
    expect(isWildStateMessage(m)).toBe(false);
    expect((m as any)?.type).toBe("session.state");
  });
});
