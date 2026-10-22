import { useState } from "react";
import { ELEMENT_LABEL, ELEMENT_COLORS } from "@/game/data";
import type { Element } from "@/game/types";
import { effectiveness } from "@/game/rules";

export default function TypeChartModal({ onClose }: { onClose: () => void }) {
  const elements = Object.keys(ELEMENT_LABEL) as Element[];
  const [selected, setSelected] = useState<Element>("normal");
  const [mode, setMode] = useState<"attack" | "defend">("attack");

  const attack2x = elements.filter(def => effectiveness(selected, def) === 2);
  const attackHalf = elements.filter(def => effectiveness(selected, def) === 0.5);
  const attack0 = elements.filter(def => effectiveness(selected, def) === 0);

  const defend2x = elements.filter(atk => effectiveness(atk, selected) === 2);
  const defendHalf = elements.filter(atk => effectiveness(atk, selected) === 0.5);
  const defend0 = elements.filter(atk => effectiveness(atk, selected) === 0);

  const renderTypeList = (list: Element[]) => {
    if (list.length === 0) return <div className="text-xs text-[color:var(--muted)] opacity-50">-</div>;
    return (
      <div className="flex flex-wrap gap-1.5">
        {list.map(e => (
          <div key={e} className={`border-2 border-[color:var(--stroke)] bg-[color:var(--bg)] px-2 py-0.5 text-xs font-bold ${ELEMENT_COLORS[e]}`}>
            {ELEMENT_LABEL[e]}
          </div>
        ))}
      </div>
    );
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">属性相克</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>
        
        <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-5">
          {/* 选择区 */}
          <div>
            <div className="text-xs text-[color:var(--muted)] mb-2">选择要查询的属性：</div>
            <div className="grid grid-cols-6 gap-1.5 sm:gap-2">
              {elements.map(e => (
                <button 
                  key={e} 
                  onClick={() => setSelected(e)}
                  className={`border-2 py-1.5 text-[10px] font-bold transition-colors ${
                    selected === e 
                      ? "border-[color:var(--accent)] bg-[color:var(--panel2)] " + ELEMENT_COLORS[e]
                      : "border-[color:var(--stroke)] bg-[color:var(--bg2)] " + ELEMENT_COLORS[e] + " opacity-60 hover:opacity-100"
                  }`}
                >
                  {ELEMENT_LABEL[e]}
                </button>
              ))}
            </div>
          </div>

          {/* 模式切换 */}
          <div className="flex border-2 border-[color:var(--stroke)] p-1 bg-[color:var(--bg2)]">
            <button 
              onClick={() => setMode("attack")}
              className={`flex-1 py-1.5 text-xs font-bold ${mode === "attack" ? "bg-[color:var(--accent)] text-[color:var(--bg)]" : "text-[color:var(--muted)] hover:text-[color:var(--text)]"}`}
            >
              作为攻击方
            </button>
            <button 
              onClick={() => setMode("defend")}
              className={`flex-1 py-1.5 text-xs font-bold ${mode === "defend" ? "bg-[color:var(--accent)] text-[color:var(--bg)]" : "text-[color:var(--muted)] hover:text-[color:var(--text)]"}`}
            >
              作为防守方
            </button>
          </div>

          {/* 详情展示区 */}
          <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-4 flex flex-col gap-4">
            <div className="flex items-center justify-between border-b-2 border-dashed border-[color:var(--stroke)] pb-2">
              <div className="text-sm font-bold flex items-center gap-2">
                <span className={ELEMENT_COLORS[selected]}>{ELEMENT_LABEL[selected]}</span> 
                <span className="text-[color:var(--text)]">{mode === "attack" ? "攻击其他属性时：" : "被其他属性攻击时："}</span>
              </div>
            </div>

            {mode === "attack" && (
              <>
                <div>
                  <div className="text-xs font-bold text-amber-400 mb-1.5">效果拔群 (造成 2 倍伤害)</div>
                  {renderTypeList(attack2x)}
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-400 mb-1.5">效果不佳 (造成 ½ 倍伤害)</div>
                  {renderTypeList(attackHalf)}
                </div>
                <div>
                  <div className="text-xs font-bold text-red-500 mb-1.5">无效 (造成 0 伤害)</div>
                  {renderTypeList(attack0)}
                </div>
              </>
            )}

            {mode === "defend" && (
              <>
                <div>
                  <div className="text-xs font-bold text-red-500 mb-1.5">弱点 (受到 2 倍伤害)</div>
                  {renderTypeList(defend2x)}
                </div>
                <div>
                  <div className="text-xs font-bold text-emerald-500 mb-1.5">抵抗 (受到 ½ 倍伤害)</div>
                  {renderTypeList(defendHalf)}
                </div>
                <div>
                  <div className="text-xs font-bold text-slate-400 mb-1.5">免疫 (受到 0 伤害)</div>
                  {renderTypeList(defend0)}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}