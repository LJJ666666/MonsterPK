/**
 * P2-2 前端会话态纯逻辑单测（vitest）。
 * 不 import useGameStore / 浏览器 API，只覆盖 revision 幂等、意图在途暂存、
 * 以及下行快照的形状校验——这三条正是「收快照不回环、不覆盖未提交结果」的地基。
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
    slot: 1,
    revision: 3,
    data: '{"version":"10","party":[],"inventory":{}}',
    updatedAt: 1_700_000_000_000,
    schemaVersion: "10",
    source: "put",
    online: 1,
    ...overrides,
  };
}

beforeEach(() => resetSessionStateForTest());

describe("revision 幂等", () => {
  it("初始已见版本为 -1，任何合法 revision 都应应用", () => {
    expect(getLastSeenRevision(1)).toBe(-1);
    expect(shouldApplySnapshot(msg({ revision: 1 }))).toBe(true);
  });

  it("noteRevision 后同版本 / 更旧版本一律忽略", () => {
    noteRevision(1, 5);
    expect(getLastSeenRevision(1)).toBe(5);
    expect(shouldApplySnapshot(msg({ revision: 5 }))).toBe(false);
    expect(shouldApplySnapshot(msg({ revision: 4 }))).toBe(false);
    expect(shouldApplySnapshot(msg({ revision: 6 }))).toBe(true);
  });

  it("只记录更大的 revision，槽位之间互不干扰", () => {
    noteRevision(1, 7);
    noteRevision(1, 3);
    noteRevision(2, 9);
    expect(getLastSeenRevision(1)).toBe(7);
    expect(getLastSeenRevision(2)).toBe(9);
    expect(getLastSeenRevision(3)).toBe(-1);
  });

  it("非法 revision（NaN / 字符串）不被记录", () => {
    noteRevision(1, Number.NaN);
    noteRevision(1, "9" as any);
    expect(getLastSeenRevision(1)).toBe(-1);
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
    noteRevision(1, 4);
    beginIntent();
    deferSnapshot(msg());
    resetSessionStateForTest();
    expect(getLastSeenRevision(1)).toBe(-1);
    expect(isIntentInFlight()).toBe(false);
    expect(endIntent()).toBeNull();
  });
});

describe("下行快照形状校验", () => {
  it("合法 session.state 通过", () => {
    expect(isSessionStateMessage(msg())).toBe(true);
  });

  it("缺 data / revision / slot / updatedAt 一律拒绝", () => {
    expect(isSessionStateMessage({ ...msg(), data: undefined as any })).toBe(false);
    expect(isSessionStateMessage({ ...msg(), revision: undefined as any })).toBe(false);
    expect(isSessionStateMessage({ ...msg(), slot: undefined as any })).toBe(false);
    expect(isSessionStateMessage({ ...msg(), updatedAt: undefined as any })).toBe(false);
  });

  it("NaN revision / 非 session.state 类型 / null 一律拒绝", () => {
    expect(isSessionStateMessage(msg({ revision: Number.NaN }))).toBe(false);
    expect(isSessionStateMessage({ ...msg(), type: "hello" as any })).toBe(false);
    expect(isSessionStateMessage(null)).toBe(false);
  });
});
