import { Children } from "react";
import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  right?: React.ReactNode;
  /** 内容区内边距：小屏紧凑区域可传 "p-3"，默认 p-4 */
  bodyClassName?: string;
  /** 折叠卡片用：内容为空时不渲染 body 容器（避免收起后留下空白占位）。默认关闭。 */
  hideBodyWhenEmpty?: boolean;
};

export default function PixelCard({ className, title, right, bodyClassName, children, hideBodyWhenEmpty, ...props }: Props) {
  const collapsed = !!hideBodyWhenEmpty && Children.toArray(children).length === 0;
  return (
    <div
      className={cn(
        "border-2 border-[color:var(--stroke)] bg-[color:var(--panel)] shadow-[0_10px_30px_rgba(0,0,0,0.35)]",
        "before:pointer-events-none before:absolute before:opacity-30",
        "relative",
        className
      )}
      {...props}
    >
      {(title || right) && (
        <div className={cn(
          "flex items-center justify-between gap-2 px-3 py-2.5",
          collapsed ? "" : "border-b-2 border-[color:var(--stroke)]"
        )}>
          <div className="min-w-0 font-display text-sm tracking-wider text-[color:var(--text)]">{title}</div>
          <div className="flex-none text-xs text-[color:var(--muted)]">{right}</div>
        </div>
      )}
      {!collapsed && <div className={cn("p-3 sm:p-4", bodyClassName)}>{children}</div>}
    </div>
  );
}
