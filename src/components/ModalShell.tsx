/** 全站弹窗统一外壳：遮罩点击关闭 / ESC 关闭 / 焦点与无障碍语义 / 背景滚动锁定 /
 *  统一的面板尺寸与最大高度。各弹窗的标题栏与内容仍由自己渲染，便于保留定制结构。 */
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

let lockCount = 0;
let previousBodyOverflow = "";

type Props = {
  onClose: () => void;
  children: ReactNode;
  /** 无障碍对话框名称（与可见标题一致） */
  title: string;
  /** 点击遮罩关闭，默认开启；强制决策弹窗可关掉 */
  closeOnScrim?: boolean;
  /** ESC 关闭，默认开启 */
  closeOnEsc?: boolean;
  /** 面板附加类（宽度变体等） */
  panelClassName?: string;
  /** 遮罩附加类（底部卡片式弹窗可改对齐） */
  scrimClassName?: string;
};

export default function ModalShell({
  onClose,
  children,
  title,
  closeOnScrim = true,
  closeOnEsc = true,
  panelClassName,
  scrimClassName,
}: Props) {
  const panelRef = useRef<HTMLDivElement | null>(null);
  // 用 ref 保存最新回调，避免父组件每次渲染内联函数导致监听器反复重挂
  const closeRef = useRef(onClose);
  closeRef.current = onClose;

  useEffect(() => {
    if (!closeOnEsc) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        closeRef.current();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [closeOnEsc]);

  // 弹窗打开期间锁住背景滚动；多个弹窗叠加时用计数避免提前解锁
  useEffect(() => {
    if (lockCount === 0) {
      previousBodyOverflow = document.body.style.overflow;
      document.body.style.overflow = "hidden";
    }
    lockCount += 1;
    panelRef.current?.focus({ preventScroll: true });
    return () => {
      lockCount = Math.max(0, lockCount - 1);
      if (lockCount === 0) document.body.style.overflow = previousBodyOverflow;
    };
  }, []);

  return (
    <div
      className={cn("modal-scrim", scrimClassName)}
      role="presentation"
      onClick={(e) => {
        if (closeOnScrim && e.target === e.currentTarget) closeRef.current();
      }}
    >
      <div
        ref={panelRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        className={cn("modal-panel", panelClassName)}
      >
        {children}
      </div>
    </div>
  );
}
