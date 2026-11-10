/**
 * P2-2 前端会话态纯逻辑单测（vitest）。
 * 不 import useGameStore / 浏览器 API，只覆盖 revision 幂等、意图在途暂存、
 * 以及下行快照的形状校验——这三条正是「收快照不回环、不覆盖未提交结果」的地基。
 * F17：单档后 revision 是单值。
 */
import { describe, it, expect, beforeEach } from "vitest";
import {
  getLastSeenRevision, noteRevision, shouldApplySnapshot,
  beginIntent, endIntent, isIntentInFlight, deferSnapshot,
  resetSessionStateForTest, type SessionStateMessage,
} from "./sessionState";
import { isSessionStateMessage } from "./ws";

function msg(overrides: Partial<SessionStateMessage> = {}): SessionStateMessage {
  return {
    type: "session.state",
    revision: 3,
    data: '{"version":"11","party":[],"inventory":{}}',
    updatedAt: 1_700_000_000_000,
    schemaVersion: "11",
    source: "put",
    online: 1,
    ...overrides,
  };
}

beforeEach(() => resetSessionStateForTest());

describe("revision 幂等", () => {
  it("初始已见版本为 -1，任何合法 revision 都应应用", () => {
    expect(getLastSeenRevision()).toBe(-1);
    expect(shouldApplySnapshot(msg({ revision: 1 }))).toBe(true);
  });

  it("noteRevision 后同版本 / 更旧版本一律忽略", () => {
    noteRevision(5);
    expect(getLastSeenRevision()).toBe(5);
    expect(shouldApplySnapshot(msg({ revision: 5 }))).toBe(false);
    expect(shouldApplySnapshot(msg({ revision: 4 }))).toBe(false);
    expect(shouldApplySnapshot(msg({ revision: 6 }))).toBe(true);
  });

  it("只记录更大的 revision", () => {
    noteRevision(7);
    noteRevision(3);
    noteRevision(9);
    expect(getLastSeenRevision()).toBe(9);
  });

  it("非法 revision（NaN / 字符串）不被记录", () => {
    noteRevision(Number.NaN);
    noteRevision("9" as any);
    expect(getLastSeenRevision()).toBe(-1);
  });
});

describe("意图在途保护", () => {
  it("在途期间的快照不应用，结束后返回暂存的最后一份", () => {
    beginIntent();
    expect(isIntentInFlight()).toBe(true);
    expect(shouldApplySnapshot(msg({ revision: 10 }))).toBe(false);
    deferSnapshot(msg({ revision: 10 }));
    deferSnapshot(msg({ revision: 11 }));
    const d = endIntent();
    expect(d?.revision).toBe(11);
    expect(isIntentInFlight()).toBe(false);
  });

  it("嵌套意图全部结束才释放，且没有暂存时返回 null", () => {
    beginIntent();
    beginIntent();
    expect(endIntent()).toBeNull();
    expect(isIntentInFlight()).toBe(true);
    expect(endIntent()).toBeNull();
    expect(isIntentInFlight()).toBe(false);
  });

  it("reset 清空版本与在途状态", () => {
    noteRevision(4);
    beginIntent();
    deferSnapshot(msg());
    resetSessionStateForTest();
    expect(getLastSeenRevision()).toBe(-1);
    expect(isIntentInFlight()).toBe(false);
    expect(endIntent()).toBeNull();
  });
});

describe("下行快照形状校验", () => {
  it("合法 session.state 通过", () => {
    expect(isSessionStateMessage(msg())).toBe(true);
  });

  it("缺 data / revision / updatedAt 一律拒绝", () => {
    expect(isSessionStateMessage({ ...msg(), data: undefined as any })).toBe(false);
    expect(isSessionStateMessage({ ...msg(), revision: undefined as any })).toBe(false);
    expect(isSessionStateMessage({ ...msg(), updatedAt: undefined as any })).toBe(false);
  });

  it("NaN revision / 非 session.state 类型 / null 一律拒绝", () => {
    expect(isSessionStateMessage(msg({ revision: Number.NaN }))).toBe(false);
    expect(isSessionStateMessage({ ...msg(), type: "hello" as any })).toBe(false);
    expect(isSessionStateMessage(null)).toBe(false);
  });
});
