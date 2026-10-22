import { cn } from "@/lib/utils";
import type { ButtonHTMLAttributes } from "react";

type Props = ButtonHTMLAttributes<HTMLButtonElement> & {
  tone?: "primary" | "danger" | "muted";
  size?: "sm" | "md";
};

export default function PixelButton({ className, tone = "primary", size = "md", ...props }: Props) {
  return (
    <button
      className={cn(
        "relative select-none rounded-none border-2 px-4 py-2 text-sm font-semibold tracking-wide transition",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-[color:var(--accent)] focus-visible:ring-offset-2 focus-visible:ring-offset-[color:var(--bg)]",
        "active:translate-y-[1px]",
        size === "sm" ? "px-3 py-1.5 text-xs" : "px-4 py-2 text-sm",
        tone === "primary" && "border-[color:var(--stroke)] bg-[color:var(--panel)] text-[color:var(--text)] hover:bg-[color:var(--panel2)]",
        tone === "danger" && "border-[color:var(--danger)] bg-[color:var(--panel)] text-[color:var(--text)] hover:bg-[color:var(--panel2)]",
        tone === "muted" && "border-[color:var(--stroke2)] bg-[color:var(--bg2)] text-[color:var(--muted)] hover:text-[color:var(--text)]",
        "disabled:cursor-not-allowed disabled:opacity-50 disabled:active:translate-y-0",
        className
      )}
      {...props}
    />
  );
}
