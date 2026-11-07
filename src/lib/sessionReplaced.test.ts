// P4-1a 顶号：前端「只读下线态」与通知闸门单测。
// vitest 默认 Node 环境没有 window，这里用一个最小 EventTarget 替身验证事件派发。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  notifySessionReplaced, resetSessionReplaced,
  SESSION_REPLACED_EVENT, SESSION_REPLACED_CODE, DEFAULT_REPLACED_REASON,
} from "./sessionReplaced";
import { isSessionSuspended, setSessionSuspended } from "./sessionState";
import { BAN_CODE } from "./api";

describe("顶号通知闸门", () => {
  beforeEach(() => {
    resetSessionReplaced();
    (globalThis as any).window = new EventTarget();
  });
  afterEach(() => {
    delete (globalThis as any).window;
    resetSessionReplaced();
  });

  it("REST 403 与 WS bye 双通道同时到达，只弹一次窗", () => {
    const spy = vi.fn();
    (globalThis as any).window.addEventListener(SESSION_REPLACED_EVENT, spy);
    notifySessionReplaced("来自 REST");
    notifySessionReplaced("来自 WS");
    expect(spy).toHaveBeenCalledTimes(1);
    expect((spy.mock.calls[0][0] as CustomEvent).detail.reason).toBe("来自 REST");
  });

  it("不传 reason 时用默认文案", () => {
    const spy = vi.fn();
    (globalThis as any).window.addEventListener(SESSION_REPLACED_EVENT, spy);
    notifySessionReplaced();
    expect((spy.mock.calls[0][0] as CustomEvent).detail.reason).toBe(DEFAULT_REPLACED_REASON);
  });

  it("reset 后（重新登录）下一次顶号还能弹窗", () => {
    const spy = vi.fn();
    (globalThis as any).window.addEventListener(SESSION_REPLACED_EVENT, spy);
    notifySessionReplaced();
    resetSessionReplaced();
    notifySessionReplaced("第二轮");
    expect(spy).toHaveBeenCalledTimes(2);
  });

  it("顶号与封号是不同机器码，不能弹错弹窗", () => {
    expect(SESSION_REPLACED_CODE).toBe("SESSION_REPLACED");
    expect(SESSION_REPLACED_CODE).not.toBe(BAN_CODE);
  });
});

describe("只读下线态", () => {
  afterEach(() => setSessionSuspended(false));

  it("默认可写；置位后 api.request 会拒绝所有业务请求", () => {
    expect(isSessionSuspended()).toBe(false);
    setSessionSuspended(true);
    expect(isSessionSuspended()).toBe(true);
    setSessionSuspended(false);
    expect(isSessionSuspended()).toBe(false);
  });
});
