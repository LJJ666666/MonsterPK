/** 全站统一页头：标题 + 副信息 + 玩法入口 chip 条 + 单点「菜单」。
 *  原先 Camp/Arena 把 7~11 个 12px 下划线链接挤在两行（触控目标不足 24dp），
 *  这里把辅助功能收敛到菜单、把玩法入口做成可横滑的 40dp chip，保持一屏高度。 */
import { useState } from "react";
import type { ReactNode } from "react";
import ModalShell from "@/components/ModalShell";

export type HeaderAction = {
  label: string;
  onClick: () => void;
};

type Props = {
  title: string;
  subtitle?: ReactNode;
  /** 玩法入口：横向可滑动 chip 条 */
  links?: HeaderAction[];
  /** 辅助功能：收进右上角菜单 */
  menu?: HeaderAction[];
};

export default function GameHeader({ title, subtitle, links = [], menu = [] }: Props) {
  const [open, setOpen] = useState(false);

  return (
    <div className="flex-none border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 truncate font-display text-lg tracking-widest text-[color:var(--text)]">
          {title}
        </div>
        {menu.length > 0 && (
          <button
            type="button"
            aria-label="打开菜单"
            aria-expanded={open}
            onClick={() => setOpen(true)}
            className="flex h-11 w-11 flex-none items-center justify-center border-2 border-[color:var(--stroke2)] text-[color:var(--text)] active:bg-[color:var(--panel2)]"
          >
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none" aria-hidden="true">
              <path d="M3 5h14M3 10h14M3 15h14" stroke="currentColor" strokeWidth="2" />
            </svg>
          </button>
        )}
      </div>

      {subtitle && (
        <div className="mt-1 min-w-0 break-words text-[13px] leading-relaxed text-[color:var(--muted)]">
          {subtitle}
        </div>
      )}

      {links.length > 0 && (
        <div
          className="-mx-3 mt-2 flex gap-1.5 overflow-x-auto px-3 pb-0.5"
          role="group"
          aria-label="玩法入口"
        >
          {links.map((a) => (
            <button
              key={a.label}
              type="button"
              onClick={a.onClick}
              className="min-h-[40px] shrink-0 border-2 border-[color:var(--stroke2)] bg-[color:var(--panel)] px-3 text-[13px] font-semibold text-[color:var(--accent)] active:bg-[color:var(--panel2)]"
            >
              {a.label}
            </button>
          ))}
        </div>
      )}

      {open && (
        <ModalShell onClose={() => setOpen(false)} title="菜单">
          <div className="modal-header">
            <span className="min-w-0 text-sm font-semibold text-[color:var(--text)]">菜单</span>
            <button
              type="button"
              onClick={() => setOpen(false)}
              aria-label="关闭"
              className="modal-close tap-expand"
            >
              &times;
            </button>
          </div>
          <div className="modal-body p-3">
            <div className="flex flex-col gap-2">
              {menu.map((a) => (
                <button
                  key={a.label}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    a.onClick();
                  }}
                  className="min-h-[44px] border-2 border-[color:var(--stroke)] bg-[color:var(--panel)] px-3 text-left text-sm text-[color:var(--text)] active:bg-[color:var(--panel2)]"
                >
                  {a.label}
                </button>
              ))}
            </div>
          </div>
        </ModalShell>
      )}
    </div>
  );
}
