// F18-d 剧情对话弹窗（2026-11-10 骨架）。
// 轻量、移动优先：底部卡片、逐行推进、点击背景或按钮继续；占位 beat 显式标注。
// 不持久化任何状态，关闭即释放。
import { useState } from "react";
import type { StoryBeat } from "@/game/story";

export default function StoryModal({ beat, onClose }: { beat: StoryBeat; onClose: () => void }) {
  const [idx, setIdx] = useState(0);
  const line = beat.lines[idx];
  const last = idx >= beat.lines.length - 1;

  const advance = () => {
    if (last) onClose();
    else setIdx(idx + 1);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/60 p-2"
      onClick={advance}
    >
      <div
        className="w-full max-w-[420px] border-2 border-[color:var(--stroke)] bg-[color:var(--bg)] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-3 py-2">
          <div className="font-display text-sm tracking-[0.08em] text-[color:var(--text)]">剧情</div>
          {beat.placeholder && (
            <div className="text-[10px] text-[color:var(--muted)]">（占位·待补全）</div>
          )}
        </div>

        <div className="max-h-[55vh] overflow-auto p-3">
          {beat.cutscene && (
            <div className="mb-2 border-2 border-dashed border-[color:var(--stroke)] bg-[color:var(--panel2)] p-2 text-[11px] text-[color:var(--accent)]">
              ▶ 播片：{beat.cutscene}
            </div>
          )}
          <div className="text-[11px] font-semibold text-[color:var(--accent)]">
            {line.speaker ?? "旁白"}
          </div>
          <div className="mt-1 text-sm leading-relaxed text-[color:var(--text)]">{line.text}</div>
        </div>

        <div className="flex items-center justify-between border-t-2 border-[color:var(--stroke)] p-2">
          <div className="text-[10px] text-[color:var(--muted)]">
            {idx + 1} / {beat.lines.length}
          </div>
          <button
            onClick={advance}
            className="border-2 border-[color:var(--accent)] bg-[color:var(--accent)] px-4 py-1 text-xs font-semibold text-[color:var(--bg)]"
          >
            {last ? "完成" : "继续"}
          </button>
        </div>
      </div>
    </div>
  );
}
