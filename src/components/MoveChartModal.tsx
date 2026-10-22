import { useState } from "react";
import { ELEMENT_LABEL, ELEMENT_COLORS, MOVE_SPECS } from "@/game/data";
import type { Element, MoveSpec } from "@/game/types";
import { X } from "lucide-react";

export default function MoveChartModal({ onClose }: { onClose: () => void }) {
  const elements = Object.keys(ELEMENT_LABEL) as Element[];
  const [selected, setSelected] = useState<Element>("fire");

  // 筛选出属于当前选中属性的所有技能
  const elementMoves = Object.values(MOVE_SPECS).filter((m) => m.element === selected);

  const getCategoryColor = (cat: MoveSpec["category"]) => {
    if (cat === "physical") return "text-orange-400 border-orange-500/50 bg-orange-500/10";
    if (cat === "special") return "text-blue-400 border-blue-500/50 bg-blue-500/10";
    return "text-slate-400 border-slate-500/50 bg-slate-500/10"; // status
  };

  const getCategoryLabel = (cat: MoveSpec["category"]) => {
    if (cat === "physical") return "物理";
    if (cat === "special") return "特殊";
    return "变化";
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        
        {/* 头部 */}
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] flex-none">
          <div className="font-bold text-[color:var(--text)]">技能图鉴</div>
          <button onClick={onClose} className="p-1 hover:text-[color:var(--danger)] text-[color:var(--muted)]">
            <X size={18} />
          </button>
        </div>
        
        {/* 属性选择区 (固定在顶部) */}
        <div className="flex-none p-4 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg)] z-10 shadow-sm">
          <div className="text-xs text-[color:var(--muted)] mb-2">选择要查询的属性：</div>
          <div className="grid grid-cols-6 gap-1.5 sm:gap-2">
            {elements.map(e => (
              <button 
                key={e} 
                onClick={() => setSelected(e)}
                className={`border-2 py-1.5 text-[10px] font-bold transition-colors ${
                  selected === e 
                    ? `${ELEMENT_COLORS[e]} border-current ring-1 ring-current ring-offset-1 ring-offset-[color:var(--bg)]` 
                    : "border-[color:var(--stroke)] bg-[color:var(--bg2)] text-[color:var(--muted)] hover:text-[color:var(--text)]"
                }`}
              >
                {ELEMENT_LABEL[e]}
              </button>
            ))}
          </div>
        </div>

        {/* 技能列表区 (可滚动) */}
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
          <div className="mt-0 flex-1">
            <div className="flex items-center gap-2 mb-3">
              <span className={`px-2 py-0.5 text-xs font-bold border-2 ${ELEMENT_COLORS[selected]}`}>
                {ELEMENT_LABEL[selected]}属性
              </span>
              <span className="text-xs text-[color:var(--muted)]">共 {elementMoves.length} 个技能</span>
            </div>

            <div className="grid gap-2">
              {elementMoves.length === 0 ? (
                <div className="text-sm text-[color:var(--muted)] italic p-4 text-center border-2 border-dashed border-[color:var(--stroke)]">
                  暂无该属性的技能记录。
                </div>
              ) : (
                elementMoves.map((move) => (
                  <div key={move.id} className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
                    <div className="flex justify-between items-start mb-1">
                      <div className="font-bold text-[color:var(--text)]">{move.name}</div>
                      <div className={`text-[10px] px-1.5 py-0.5 border ${getCategoryColor(move.category)}`}>
                        {getCategoryLabel(move.category)}
                      </div>
                    </div>
                    
                    <div className="flex gap-4 text-[10px] text-[color:var(--muted)] mb-2 font-mono">
                      <div>威力: <span className="text-[color:var(--text)] font-bold">{move.power === 0 ? "-" : move.power}</span></div>
                      <div>命中: <span className="text-[color:var(--text)] font-bold">{Math.round(move.accuracy * 100)}%</span></div>
                      {move.priority ? (
                        <div className="text-amber-400">优先度: +{move.priority}</div>
                      ) : null}
                    </div>

                    <div className="text-xs text-[color:var(--text)] opacity-80 leading-relaxed">
                      {move.desc || "暂无描述。"}
                    </div>
                  </div>
                ))
              )}
            </div>
          </div>

        </div>
      </div>
    </div>
  );
}