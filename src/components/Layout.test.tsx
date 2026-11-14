import { describe, expect, it } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import ModalShell from "./ModalShell";
import GameHeader from "./GameHeader";

// 前端单测跑在 node 环境（无 jsdom），用 react-dom/server 静态渲染锁定
// 全站 UI 底座的无障碍语义与结构契约；交互事件（ESC / 遮罩点击）由真机门禁覆盖。
describe("ModalShell", () => {
  it("渲染对话框语义：role/aria-modal/aria-label 与统一外壳类", () => {
    const html = renderToStaticMarkup(
      createElement(ModalShell, {
        onClose: () => {},
        title: "徽章与成就",
        children: createElement("div", null, "内容"),
      }),
    );
    expect(html).toContain('role="dialog"');
    expect(html).toContain('aria-modal="true"');
    expect(html).toContain('aria-label="徽章与成就"');
    expect(html).toContain("modal-scrim");
    expect(html).toContain("modal-panel");
    expect(html).toContain("内容");
  });

  it("标题与自定义类透传，不写死内容", () => {
    const html = renderToStaticMarkup(
      createElement(ModalShell, {
        onClose: () => {},
        title: "剧情",
        scrimClassName: "items-end p-2",
        panelClassName: "modal-panel--story",
        children: createElement("span", null, "剧情正文"),
      }),
    );
    expect(html).toContain('aria-label="剧情"');
    expect(html).toContain("modal-panel--story");
    expect(html).toContain("items-end");
  });
});

describe("GameHeader", () => {
  it("标题/副信息/玩法 chip 全渲染，chip 带最小触控高度", () => {
    const html = renderToStaticMarkup(
      createElement(GameHeader, {
        title: "兽域手记",
        subtitle: createElement("span", null, "旅行者 · ¥0"),
        links: [
          { label: "讨伐", onClick: () => {} },
          { label: "演武堂", onClick: () => {} },
        ],
        menu: [{ label: "属性相克表", onClick: () => {} }],
      }),
    );
    expect(html).toContain("兽域手记");
    expect(html).toContain("旅行者");
    expect(html).toContain("讨伐");
    expect(html).toContain("演武堂");
    expect(html).toContain("min-h-[40px]");
    expect(html).toContain('aria-label="玩法入口"');
  });

  it("有菜单项才显示 44px 菜单按钮；未渲染时弹窗不出现", () => {
    const withMenu = renderToStaticMarkup(
      createElement(GameHeader, { title: "初心镇", menu: [{ label: "回程", onClick: () => {} }] }),
    );
    expect(withMenu).toContain('aria-label="打开菜单"');
    expect(withMenu).toContain("h-11 w-11");
    expect(withMenu).not.toContain('role="dialog"');

    const withoutMenu = renderToStaticMarkup(createElement(GameHeader, { title: "初心镇" }));
    expect(withoutMenu).not.toContain('aria-label="打开菜单"');
  });
});
