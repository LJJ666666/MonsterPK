import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  right?: React.ReactNode;
  /** 内容区内边距：小屏紧凑区域可传 "p-3"，默认 p-4 */
  bodyClassName?: string;
};

export default function PixelCard({ className, title, right, bodyClassName, children, ...props }: Props) {
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
        <div className="flex items-center justify-between gap-2 border-b-2 border-[color:var(--stroke)] px-3 py-2.5">
          <div className="min-w-0 font-display text-sm tracking-wider text-[color:var(--text)]">{title}</div>
          <div className="flex-none text-xs text-[color:var(--muted)]">{right}</div>
        </div>
      )}
      <div className={cn("p-3 sm:p-4", bodyClassName)}>{children}</div>
    </div>
  );
}
