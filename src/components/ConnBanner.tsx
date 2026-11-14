// 全局实时通道状态横幅（P2-1 可视化）：把 ws.ts 的连接相位机「展示」出来。
// - connecting / reconnecting / offline：顶部显示带脉冲点的提示条，告知当前断连状态；
// - 从故障态恢复到 online：短暂弹出「已恢复连接」，让用户看见重连成功的结果。
// 仅在已登录、实时通道活跃时才有意义；登录页（phase=idle）不渲染，避免与登录页自带的健康探测重复。
import { useEffect, useRef, useState } from "react";
import { useWsStatus, type WsPhase } from "@/lib/ws";

const PROBLEM: WsPhase[] = ["connecting", "reconnecting", "offline"];

export type BannerView = {
  visible: boolean;
  recovered: boolean;
  border: string;
  text: string;
  msg: string;
};

/**
 * 纯展示决策（导出供单测穷举各相位）：相位 + 是否处于「刚恢复」窗口 → 横幅配置。
 * 抽成纯函数是为了让「断线重连如何展示」可被 node 环境的静态渲染单测覆盖，
 * 不依赖 jsdom / fake timer。
 */
export function resolveBannerView(
  phase: WsPhase,
  info: string | undefined,
  recovered: boolean
): BannerView {
  const showProblem = PROBLEM.includes(phase);
  if (!showProblem && !recovered) {
    return { visible: false, recovered: false, border: "", text: "", msg: "" };
  }
  if (recovered) {
    return {
      visible: true,
      recovered: true,
      border: "border-[color:var(--ok)]",
      text: "text-[color:var(--ok)]",
      msg: "已恢复连接",
    };
  }
  if (phase === "offline") {
    return {
      visible: true,
      recovered: false,
      border: "border-[color:var(--danger)]",
      text: "text-[color:var(--danger)]",
      msg: "网络连接已断开",
    };
  }
  return {
    visible: true,
    recovered: false,
    border: "border-[color:var(--accent)]",
    text: "text-[color:var(--accent)]",
    msg: phase === "reconnecting" ? (info ?? "连接已断开，正在重连…") : "正在连接服务器…",
  };
}

export default function ConnBanner() {
  const { phase, info } = useWsStatus();
  const [recovered, setRecovered] = useState(false);
  const prev = useRef<WsPhase>(phase);

  // 监测「从故障态恢复到在线」的跳变，弹一次恢复提示。
  useEffect(() => {
    const wasProblem = PROBLEM.includes(prev.current);
    if (phase === "online" && wasProblem) {
      setRecovered(true);
      const t = setTimeout(() => setRecovered(false), 2600);
      prev.current = phase;
      return () => clearTimeout(t);
    }
    prev.current = phase;
  }, [phase]);

  const view = resolveBannerView(phase, info, recovered);
  if (!view.visible) return null;

  return (
    <div
      className="pointer-events-none fixed inset-x-0 top-0 z-[60] flex justify-center px-3"
      style={{ paddingTop: "max(env(safe-area-inset-top, 0px), 10px)" }}
    >
      <div
        role="status"
        aria-live="polite"
        className={[
          "pointer-events-auto w-full max-w-md border-2 bg-[color:var(--bg2)] px-3 py-2 text-center text-xs font-semibold shadow-lg",
          view.border,
          view.text,
        ].join(" ")}
      >
        <span className="inline-flex items-center gap-2">
          {!view.recovered && (
            <span className="inline-block h-2 w-2 shrink-0 animate-pulse rounded-full bg-current" />
          )}
          {view.msg}
        </span>
      </div>
    </div>
  );
}
