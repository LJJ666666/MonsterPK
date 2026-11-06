import { describe, it, expect } from "vitest";
import { wsUrl, reconnectDelayMs, parseServerMessage, getWsPhase } from "./ws";

describe("wsUrl（P2-1 地址派生）", () => {
  it("http → ws，路径固定 /ws", () => {
    expect(wsUrl("http://localhost:3001", "abc")).toBe("ws://localhost:3001/ws?token=abc");
  });

  it("https → wss（上线后走 TLS）", () => {
    expect(wsUrl("https://api.example.com", "t1")).toBe("wss://api.example.com/ws?token=t1");
  });

  it("清掉原 base 的 query / hash / 路径，不把旧参数带进握手", () => {
    const u = wsUrl("http://localhost:3001/v1?debug=1#frag", "tok");
    expect(u).toBe("ws://localhost:3001/ws?token=tok");
  });

  it("token 里的特殊字符按 URL 规则编码", () => {
    const u = wsUrl("http://localhost:3001", "a+b/c");
    expect(new URL(u).searchParams.get("token")).toBe("a+b/c");
  });
});

describe("reconnectDelayMs（指数退避）", () => {
  it("0~4 次为 1/2/4/8/15 秒，15 秒封顶", () => {
    expect(reconnectDelayMs(0)).toBe(1000);
    expect(reconnectDelayMs(1)).toBe(2000);
    expect(reconnectDelayMs(2)).toBe(4000);
    expect(reconnectDelayMs(3)).toBe(8000);
    expect(reconnectDelayMs(4)).toBe(15000);
    expect(reconnectDelayMs(10)).toBe(15000);
  });

  it("负数与小数归零，不会算出小于 1 秒的退避", () => {
    expect(reconnectDelayMs(-3)).toBe(1000);
    expect(reconnectDelayMs(1.9)).toBe(2000);
  });

  it("抖动最多 +25%，且 random 越界时被钳制", () => {
    expect(reconnectDelayMs(0, 0)).toBe(1000);
    expect(reconnectDelayMs(0, 1)).toBe(1250);
    expect(reconnectDelayMs(0, 0.5)).toBe(1125);
    expect(reconnectDelayMs(0, 99)).toBe(1250);
    expect(reconnectDelayMs(0, -1)).toBe(1000);
  });
});

describe("parseServerMessage（容错解析）", () => {
  it("合法控制消息原样返回", () => {
    const hello = { type: "hello", protocol: 1, heartbeatMs: 30000 };
    expect(parseServerMessage(JSON.stringify(hello))).toEqual(hello);
    expect(parseServerMessage('{"type":"bye","code":"ACCOUNT_BANNED","reason":"你已被封号"}'))
      .toMatchObject({ type: "bye", code: "ACCOUNT_BANNED" });
  });

  it("坏 JSON / 数组 / 无 type / null 一律返回 null", () => {
    expect(parseServerMessage("not json")).toBeNull();
    expect(parseServerMessage("[1,2]")).toBeNull();
    expect(parseServerMessage('{"heartbeatMs":1}')).toBeNull();
    expect(parseServerMessage("null")).toBeNull();
    expect(parseServerMessage('"hello"')).toBeNull();
  });
});

describe("初始连接状态", () => {
  it("模块加载后尚未启动，相位为 idle", () => {
    // 单测不触碰 window/WebSocket，只验证纯状态初值
    expect(getWsPhase()).toBe("idle");
  });
});
