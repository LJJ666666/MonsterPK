import { cn } from "@/lib/utils";
import type { HTMLAttributes } from "react";

type Props = HTMLAttributes<HTMLDivElement> & {
  title?: string;
  right?: React.ReactNode;
};

export default function PixelCard({ className, title, right, children, ...props }: Props) {
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
        <div className="flex items-center justify-between border-b-2 border-[color:var(--stroke)] px-4 py-3">
          <div className="font-display text-sm tracking-wider text-[color:var(--text)]">{title}</div>
          <div className="text-xs text-[color:var(--muted)]">{right}</div>
        </div>
      )}
      <div className="p-4">{children}</div>
    </div>
  );
}
