// 全局重连横幅单测：穷举 WS 各相位的「断线重连如何展示」。
// node 环境用 react-dom/server 静态渲染；展示决策抽成纯函数 resolveBannerView 穷举，
// 组件层再用静态渲染确认窄屏/无障碍/安全区契约，不引入 jsdom 或 testing-library。
import { describe, it, expect, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { resolveBannerView } from "./ConnBanner";
import type { WsPhase } from "@/lib/ws";

// mock 掉 hook，让静态渲染能指定相位；模块其余导出（WsPhase 只是类型，运行时无值）。
const mockStatus = vi.fn(() => ({ phase: "online" as WsPhase, info: undefined as string | undefined }));
vi.mock("@/lib/ws", () => ({
  useWsStatus: () => mockStatus(),
}));

// vi.mock 会被提升，故用动态 import 拿组件，确保拿到的是 mock 后的模块图。
async function renderWith(phase: WsPhase, info?: string) {
  mockStatus.mockReturnValue({ phase, info });
  const { default: ConnBanner } = await import("./ConnBanner");
  return renderToStaticMarkup(createElement(ConnBanner));
}

describe("resolveBannerView：在线/静默态不显示横幅", () => {
  it("idle / online / unauthorized 且非恢复窗口 → 不渲染", () => {
    for (const phase of ["idle", "online", "unauthorized"] as WsPhase[]) {
      expect(resolveBannerView(phase, undefined, false).visible).toBe(false);
    }
  });
});

describe("resolveBannerView：断线/重连/恢复三态文案与配色", () => {
  it("connecting → 琥珀「正在连接服务器…」", () => {
    const v = resolveBannerView("connecting", undefined, false);
    expect(v.visible).toBe(true);
    expect(v.border).toContain("--accent");
    expect(v.msg).toBe("正在连接服务器…");
  });

  it("reconnecting → 优先用服务端给的退避信息", () => {
    const v = resolveBannerView("reconnecting", "3 秒后重连（第 2 次）", false);
    expect(v.msg).toBe("3 秒后重连（第 2 次）");
    expect(resolveBannerView("reconnecting", undefined, false).msg).toBe("连接已断开，正在重连…");
  });

  it("offline → 红色「网络连接已断开」", () => {
    const v = resolveBannerView("offline", undefined, false);
    expect(v.border).toContain("--danger");
    expect(v.msg).toBe("网络连接已断开");
  });

  it("恢复窗口 → 绿色「已恢复连接」，且覆盖掉原相位", () => {
    const v = resolveBannerView("online", undefined, true);
    expect(v.visible).toBe(true);
    expect(v.recovered).toBe(true);
    expect(v.border).toContain("--ok");
    expect(v.msg).toBe("已恢复连接");
  });
});

describe("ConnBanner 静态渲染：移动端 / 无障碍 / 安全区契约", () => {
  it("reconnecting 时渲染状态条，含脉冲点、aria-live、小 max-w 与顶部安全区", async () => {
    const html = await renderWith("reconnecting", "3 秒后重连（第 2 次）");
    expect(html).toContain("3 秒后重连（第 2 次）");
    expect(html).toContain('role="status"');
    expect(html).toContain('aria-live="polite"');
    expect(html).toContain("animate-pulse");
    expect(html).toContain("max-w-md");
    expect(html).toContain("safe-area-inset-top");
  });

  it("online 时完全不输出 DOM（不占屏幕、不遮挡内容）", async () => {
    const html = await renderWith("online");
    expect(html).toBe("");
  });
});
