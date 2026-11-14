// 换账号回归单测（2026-11-15 真机复现）：
// 新账号 aabbcc 在服务端没有存档（GET /api/save = 404），但内存里还留着
// gametest001 的渲染副本，于是 Start 显示「继续旅程」、Camp 拿旧图鉴渲染，
// 写操作却全部 404 SAVE_NOT_FOUND。bootstrapSave 收到 404 必须清空渲染副本。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { bootstrapSave } from "@/lib/saveBootstrap";
import { useGameStore } from "@/stores/useGameStore";
import { setSessionSuspended, setRevision } from "@/lib/sessionState";

const TOKEN_KEY = "mpk_token";
const SAVE_JSON = JSON.stringify({
  version: "11",
  playerName: "旧账号",
  money: 999,
  party: [],
  inventory: {},
  collection: {},
  locationId: "town_starter",
});

function fakeToken(): string {
  const enc = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  return `${enc({ alg: "HS256", typ: "JWT" })}.${enc({ exp: Math.floor(Date.now() / 1000) + 3600 })}.sig`;
}

function response(status: number, body: unknown): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

beforeEach(() => {
  const store = new Map<string, string>();
  store.set(TOKEN_KEY, fakeToken());
  vi.stubGlobal("localStorage", {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => { store.set(k, v); },
    removeItem: (k: string) => { store.delete(k); },
  });
  setSessionSuspended(false);
  setRevision(0);
  useGameStore.getState().resetLocalSave();
  useGameStore.getState().importSaveJson(SAVE_JSON);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("bootstrapSave：服务端确认无档时必须丢弃旧渲染副本", () => {
  it("404 → 清空 save/battle，基线归 0", async () => {
    expect(useGameStore.getState().save?.playerName).toBe("旧账号");
    vi.stubGlobal("fetch", vi.fn(async () => response(404, { error: "还没有存档" })));

    const ok = await bootstrapSave();

    expect(ok).toBe(false);
    expect(useGameStore.getState().save).toBeNull();
    expect(useGameStore.getState().battle).toBeNull();
  });

  it("200 有档 → 导入服务端真值", async () => {
    const cloud = JSON.parse(SAVE_JSON);
    cloud.playerName = "新账号";
    vi.stubGlobal("fetch", vi.fn(async () => response(200, {
      data: JSON.stringify(cloud), revision: 3,
    })));

    const ok = await bootstrapSave();

    expect(ok).toBe(true);
    expect(useGameStore.getState().save?.playerName).toBe("新账号");
  });

  it("非 404 的网络故障 → 不误清空（避免诱导玩家覆盖服务端真档）", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => response(500, { error: "boom" })));

    const ok = await bootstrapSave();

    expect(ok).toBe(false);
    expect(useGameStore.getState().save?.playerName).toBe("旧账号");
  });
});
