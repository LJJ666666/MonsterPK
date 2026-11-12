import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ErrorBoundary, { normalizeError } from "./ErrorBoundary";

// 项目前端单测跑在 node 环境（无 jsdom / testing-library），这里用
// react-dom/server 做静态渲染，覆盖「透传 children」与「兜底页」两条契约，
// 不引入任何新依赖。
describe("normalizeError", () => {
  it("取 Error.message 并截断，避免超长文案撑破窄屏", () => {
    expect(normalizeError(new Error("boom"))).toBe("boom");
    expect(normalizeError(new Error("x".repeat(500)))).toHaveLength(200);
  });

  it("字符串直接展示，其它抛出值给中文占位", () => {
    expect(normalizeError("网络异常")).toBe("网络异常");
    expect(normalizeError(null)).toBe("未知错误");
    expect(normalizeError({ code: 42 })).toBe("未知错误");
  });
});

describe("ErrorBoundary", () => {
  it("未出错时原样透传 children", () => {
    const html = renderToStaticMarkup(
      createElement(ErrorBoundary, null, createElement("span", null, "营地")),
    );
    expect(html).toContain("营地");
    expect(html).not.toContain("手记出了点问题");
  });

  it("捕获渲染异常后展示像素风中文兜底页而不是白屏", () => {
    const boundary = new ErrorBoundary({ children: null });
    boundary.state = ErrorBoundary.getDerivedStateFromError(new Error("组件炸了"));
    const html = renderToStaticMarkup(boundary.render() as ReactElement);
    expect(html).toContain("手记出了点问题");
    expect(html).toContain("重新加载");
    expect(html).toContain("重试渲染");
    expect(html).toContain("组件炸了");
    expect(html).toContain("进度保存在服务端");
    // 窄屏契约：小 max-w + 可滚动兜底容器。
    expect(html).toContain("max-w-sm");
    expect(html).toContain("overflow-auto");
  });

  it("componentDidCatch 把完整堆栈留在控制台", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const boundary = new ErrorBoundary({ children: null });
    boundary.componentDidCatch(new Error("x"), { componentStack: "at App" } as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy.mock.calls[0][0]).toBe("[兽域手记] 渲染异常");
    spy.mockRestore();
  });
});
