import { cn } from "@/lib/utils";

type Props = {
  label: string;
  value: number;
  max: number;
  tone?: "hp" | "enemy" | "exp";
  className?: string;
  size?: "md" | "sm";
};

export default function StatBar({ label, value, max, tone = "hp", className, size = "md" }: Props) {
  const pct = max <= 0 ? 0 : Math.max(0, Math.min(1, value / max));
  
  let fill = "bg-[linear-gradient(90deg,var(--ok),#b8ffbf)]";
  if (tone === "enemy") fill = "bg-[linear-gradient(90deg,var(--danger),#ff9a7a)]";
  if (tone === "exp") fill = "bg-[linear-gradient(90deg,#3b82f6,#93c5fd)]"; // 蓝色的经验条

  const barHeight = size === "sm" ? "h-1" : "h-3";
  const hideText = size === "sm";

  return (
    <div className={cn("w-full", className)}>
      {!hideText && (
        <div className="mb-1 flex items-baseline justify-between text-[11px] text-[color:var(--muted)]">
          <span>{label}</span>
          <span className="tabular-nums">
            {Math.floor(value)}/{Math.floor(max)}
          </span>
        </div>
      )}
      <div className={`${barHeight} border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]`}>
        <div className={cn("h-full transition-all duration-500 ease-in-out", fill)} style={{ width: `${Math.round(pct * 100)}%` }} />
      </div>
    </div>
  );
}
