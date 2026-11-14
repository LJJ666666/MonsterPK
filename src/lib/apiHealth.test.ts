// 状态嗅探回归单测：锁定 api.health() 的「禁缓存 + 超时 + 传 signal」。
// 背景（2026-11-14 真机实测）：health 是 GET，未禁缓存时断网后 Chromium 直接返回
// 缓存过的 200，登录页「持续嗅探」永久粘在「服务器在线」；冷启动才正确显示离线。
// 修复后必须保证每次探测都带 cache: "no-store"，且悬挂请求能被超时打断。
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { api } from "@/lib/api";

function okResponse(): Response {
  return {
    ok: true,
    status: 200,
    text: async () => JSON.stringify({ ok: true }),
  } as unknown as Response;
}

beforeEach(() => {
  vi.stubGlobal("localStorage", {
    getItem: () => null,
    setItem: () => {},
    removeItem: () => {},
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("api.health：状态嗅探必须绕开 HTTP 缓存", () => {
  it("每次探测都带 cache: no-store，并透传 AbortSignal", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    const data = await api.health({ timeoutMs: 2500 });

    expect(data).toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("不传 timeoutMs 时也禁缓存（其它调用方同样受益）", async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => okResponse());
    vi.stubGlobal("fetch", fetchMock);

    await api.health();

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.cache).toBe("no-store");
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it("请求悬挂超过 timeoutMs 时中止，避免状态永远停在 checking/online", async () => {
    vi.useFakeTimers();
    // 模拟黑洞网络：fetch 一直不返回，仅在 signal 触发时 reject。
    const fetchMock = vi.fn(
      (_url: string, init: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          const signal = init.signal!;
          if (signal.aborted) {
            reject(new Error("aborted"));
            return;
          }
          signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true });
        })
    );
    vi.stubGlobal("fetch", fetchMock);

    const p = api.health({ timeoutMs: 2500 });
    const assertion = expect(p).rejects.toThrow(/aborted/);
    await vi.advanceTimersByTimeAsync(2500);
    await assertion;

    const init = fetchMock.mock.calls[0][1] as RequestInit;
    expect(init.signal!.aborted).toBe(true);
  });
});
