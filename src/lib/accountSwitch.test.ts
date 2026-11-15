// 账号边界回归单测（2026-11-15 真机复现 → 同日测试资产审核补齐）。
//
// 锁住 accountSwitch.ts 的清理契约：停实时/写通道、丢渲染副本、清 revision 基线与
// 展示态、退出再清 token。重点还有一条不变式：「清」不是「写」，
// 退出/换账号不得产生任何网络请求或服务端真值（否则会变成新的写档入口）。
//
// mock 采用 spy-through：既断言调用，又保留真实实现，避免「把被测行为 mock 掉」的假绿。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const spy = vi.hoisted(() => ({
  stopRealtime: vi.fn(),
  stopWriteChannel: vi.fn(),
  forgetAllRevisions: vi.fn(),
  resetSessionView: vi.fn(),
  clearToken: vi.fn(),
}));

vi.mock("@/lib/ws", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, stopRealtime: spy.stopRealtime.mockImplementation(() => actual.stopRealtime()) };
});
vi.mock("@/lib/sync", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, stopWriteChannel: spy.stopWriteChannel.mockImplementation(() => actual.stopWriteChannel()) };
});
vi.mock("@/lib/sessionState", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, forgetAllRevisions: spy.forgetAllRevisions.mockImplementation(() => actual.forgetAllRevisions()) };
});
vi.mock("@/lib/session", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, resetSessionView: spy.resetSessionView.mockImplementation(() => actual.resetSessionView()) };
});
vi.mock("@/lib/auth", async (importOriginal) => {
  const actual: any = await importOriginal();
  return { ...actual, clearToken: spy.clearToken.mockImplementation(() => actual.clearToken()) };
});

import { signOut, resetAccountState } from "@/lib/accountSwitch";
import { useGameStore } from "@/stores/useGameStore";
import { setRevision, getWriteRevision, getLastSeenRevision } from "@/lib/sessionState";
import { getSyncPhase, setSyncError } from "@/lib/sync";
import { getToken } from "@/lib/auth";

const SAVE_JSON = JSON.stringify({
  version: "11",
  playerName: "旧账号",
  money: 999,
  party: [],
  inventory: {},
  collection: {},
  locationId: "town_starter",
});

let fetchSpy: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.clearAllMocks(); // 只清调用记录，保留 spy-through 实现
  const store = new Map<string, string>();
  store.set("mpk_token", "old-token");
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  fetchSpy = vi.fn(async () => { throw new Error("退出/换账号不得发请求"); });
  vi.stubGlobal("fetch", fetchSpy);

  setRevision(7);
  setSyncError("旧账号残留错误");
  useGameStore.getState().resetLocalSave();
  useGameStore.getState().importSaveJson(SAVE_JSON);
  // 准备动作可能触发状态清理（spy-through 会记到调用），清掉记录，
  // 让下面的调用次数断言只统计被测的 signOut / resetAccountState。
  vi.clearAllMocks();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("accountSwitch：账号边界清理", () => {
  it("signOut 停双通道、清 token/渲染副本/基线/展示态，且零网络请求", () => {
    expect(useGameStore.getState().save?.playerName).toBe("旧账号");
    expect(getWriteRevision()).toBe(7);
    expect(getSyncPhase()).toBe("error");

    signOut();

    expect(spy.stopRealtime).toHaveBeenCalledTimes(1);
    expect(spy.stopWriteChannel).toHaveBeenCalledTimes(1);
    // accountSwitch 显式清一次，auth.clearToken() 内部还会清一次（幂等，两处都合法）。
    expect(spy.forgetAllRevisions).toHaveBeenCalled();
    expect(spy.resetSessionView).toHaveBeenCalledTimes(1);
    expect(spy.clearToken).toHaveBeenCalledTimes(1);
    expect(getToken()).toBeNull();
    expect(useGameStore.getState().save).toBeNull();
    expect(useGameStore.getState().battle).toBeNull();
    expect(getWriteRevision()).toBeNull();
    expect(getLastSeenRevision()).toBe(-1);
    expect(getSyncPhase()).toBe("idle");
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("resetAccountState 只清内存态、保留 token（登录成功前调用）", () => {
    resetAccountState();

    expect(spy.clearToken).not.toHaveBeenCalled();
    expect(getToken()).toBe("old-token");
    expect(spy.stopRealtime).toHaveBeenCalledTimes(1);
    expect(spy.stopWriteChannel).toHaveBeenCalledTimes(1);
    expect(useGameStore.getState().save).toBeNull();
    expect(getWriteRevision()).toBeNull();
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("退出后新账号建档只含新档，不混旧账号的渲染副本", () => {
    signOut();
    const fresh = { ...JSON.parse(SAVE_JSON), playerName: "新账号", money: 0 };

    const r = useGameStore.getState().importSaveJson(JSON.stringify(fresh));

    expect(r).toMatchObject({ ok: true });
    expect(useGameStore.getState().save?.playerName).toBe("新账号");
    expect(useGameStore.getState().save?.money).toBe(0);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
