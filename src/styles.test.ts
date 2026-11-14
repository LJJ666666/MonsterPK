import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

// 锁死全站 UI 底座的 CSS 契约：零 CDN、字体自包含、最小触控目标、
// 安全区与统一外壳。这些是 APK 离线可用与一屏布局的地基，防止被改回去。
const css = readFileSync(resolve(process.cwd(), "src/index.css"), "utf-8");
const fontFile = resolve(process.cwd(), "public/fonts/press-start-2p-latin.woff2");

describe("index.css 设计底座", () => {
  it("不再引入外部字体 CDN，改为本地 @font-face", () => {
    // 注释里提到旧 CDN 域名属正常说明，只禁止真实生效的 @import 远程 URL
    expect(css).not.toMatch(/@import\s+url\(\s*["']?https?:/i);
    expect(css).not.toMatch(/@import\s+["']https?:/i);
    expect(css).toContain('font-family: "Press Start 2P"');
    expect(css).toContain("/fonts/press-start-2p-latin.woff2");
  });

  it("本地字体文件真实存在且是 woff2", () => {
    const buf = readFileSync(fontFile);
    expect(buf.subarray(0, 4).toString("ascii")).toBe("wOF2");
    expect(buf.length).toBeGreaterThan(1000);
  });

  it("令牌与全局交互契约齐备", () => {
    expect(css).toContain("--tap: 44px");
    expect(css).toContain("overflow-x: hidden");
    expect(css).toContain("touch-action: manipulation");
    expect(css).toContain(":focus-visible");
    expect(css).toContain("scrollbar-width: thin");
    // 内容区小按钮触控兜底，且不覆盖显式 min-h 的组件
    expect(css).toContain('button:not([class*="min-h-"])');
    expect(css).toContain("min-height: 36px");
  });

  it("统一外壳与安全区类齐备", () => {
    for (const cls of [
      ".page-shell",
      ".modal-scrim",
      ".modal-panel",
      ".modal-header",
      ".modal-close",
      ".modal-body",
      ".tap-expand",
      ".safe-top",
      ".safe-bottom",
      ".nav-safe-bottom",
    ]) {
      expect(css).toContain(cls);
    }
  });

  it("顶部安全区只用真实 inset，不再白占 24px 兜底", () => {
    expect(css).toContain("padding-top: env(safe-area-inset-top, 0px);");
    expect(css).not.toContain("max(env(safe-area-inset-top, 0px), 24px)");
  });

  it("可读性：次要文字对比度高于旧值 0.72", () => {
    expect(css).toContain("--muted: rgba(238, 241, 255, 0.82)");
  });
});
