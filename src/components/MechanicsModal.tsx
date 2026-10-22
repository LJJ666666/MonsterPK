import { X } from "lucide-react";
import PixelCard from "./PixelCard";

type Props = {
  onClose: () => void;
};

export default function MechanicsModal({ onClose }: Props) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="w-full max-w-md">
        <PixelCard
          title="战斗机制与概率说明"
          right={
            <button onClick={onClose} className="p-1 hover:text-[color:var(--danger)]">
              <X size={18} />
            </button>
          }
        >
          <div className="space-y-6 text-sm text-[color:var(--text)] max-h-[75vh] overflow-y-auto pr-2">
            
            <section>
              <h3 className="mb-2 border-b-2 border-[color:var(--stroke)] pb-1 font-bold text-[color:var(--accent)]">
                🎲 概率词缀对照表
              </h3>
              <p className="mb-2 text-xs text-[color:var(--muted)]">技能描述中的概率词缀，对应实际的触发几率（命中前提下）：</p>
              <ul className="list-inside list-disc space-y-1 pl-2 text-[13px]">
                <li><span className="font-bold text-[#ff9a7a]">必定</span>：<span className="font-mono font-bold">100%</span> 触发。</li>
                <li><span className="font-bold text-[#f5d061]">大概率</span>：通常为 <span className="font-mono font-bold">70%</span> 触发。</li>
                <li><span className="font-bold text-[#a0c8ff]">有概率</span>：通常为 <span className="font-mono font-bold">30% ~ 40%</span> 触发。</li>
                <li><span className="font-bold text-[color:var(--muted)]">小概率</span>：通常为 <span className="font-mono font-bold">10%</span> 触发。</li>
              </ul>
            </section>

            <section>
              <h3 className="mb-2 border-b-2 border-[color:var(--stroke)] pb-1 font-bold text-[color:var(--accent)]">
                🌀 异常状态 (Status Effects)
              </h3>
              <p className="mb-2 text-xs text-[color:var(--muted)]">一场战斗中只能同时带有一种主要异常状态：</p>
              <div className="grid gap-2 text-[13px]">
                <div className="rounded bg-[color:var(--bg2)] p-2 border border-[color:var(--stroke)]">
                  <div className="font-bold text-[#ff9a7a]">🔥 灼伤 (Burn)</div>
                  <div className="mt-1 opacity-90">每回合结束扣除最大生命值的 1/16。处于灼伤状态时，该幻兽使用<span className="font-bold">物理攻击</span>造成的伤害减半。</div>
                </div>
                <div className="rounded bg-[color:var(--bg2)] p-2 border border-[color:var(--stroke)]">
                  <div className="font-bold text-[#d494ff]">☠️ 中毒 (Poison)</div>
                  <div className="mt-1 opacity-90">每回合结束扣除最大生命值的 1/8。不会降低攻击力，但持续伤害非常致命。</div>
                </div>
                <div className="rounded bg-[color:var(--bg2)] p-2 border border-[color:var(--stroke)]">
                  <div className="font-bold text-[#f5d061]">⚡ 麻痹 (Paralyze)</div>
                  <div className="mt-1 opacity-90">速度值强制减半。每次准备出招时，有 25% 的概率因为身体麻痹而无法行动。</div>
                </div>
                <div className="rounded bg-[color:var(--bg2)] p-2 border border-[color:var(--stroke)]">
                  <div className="font-bold text-[#a0c8ff]">💤 睡眠 (Sleep)</div>
                  <div className="mt-1 opacity-90">陷入沉睡无法行动。每回合行动时，有 33% 的概率自然苏醒。</div>
                </div>
                <div className="rounded bg-[color:var(--bg2)] p-2 border border-[color:var(--stroke)]">
                  <div className="font-bold text-[#b8ffbf]">❄️ 冰冻 (Freeze)</div>
                  <div className="mt-1 opacity-90">被坚冰冻住无法行动。每回合行动时，有 20% 的概率融化解冻。</div>
                </div>
              </div>
            </section>

            <section>
              <h3 className="mb-2 border-b-2 border-[color:var(--stroke)] pb-1 font-bold text-[color:var(--accent)]">
                📈 能力升降 (Stat Modifiers)
              </h3>
              <p className="mb-2 text-xs text-[color:var(--muted)]">物攻、物防、特攻、特防、速度、命中率、闪避率均可被改变：</p>
              <ul className="list-inside list-disc space-y-1 pl-2 text-[13px] opacity-90">
                <li>能力阶级最高可以提升至 <span className="font-bold text-[color:var(--ok)]">+6 级</span>，最低可以下降至 <span className="font-bold text-[color:var(--danger)]">-6 级</span>。</li>
                <li>常规属性每提升 1 级，能力倍率增加 50%。例如提升 2 级，实际能力变为 200%。</li>
                <li>常规属性下降时，倍率衰减。例如下降 1 级，实际能力变为约 66%；下降 2 级变为 50%。</li>
                <li>命中与闪避的计算有所不同，每 1 级阶级变动大约影响 33% 的基础倍率。</li>
              </ul>
            </section>

            <section>
              <h3 className="mb-2 border-b-2 border-[color:var(--stroke)] pb-1 font-bold text-[color:var(--accent)]">
                ⚔️ 特殊战斗机制
              </h3>
              <div className="space-y-2 text-[13px] opacity-90">
                <p><span className="font-bold text-[color:var(--accent)]">吸血 (Heal)：</span>部分技能（如生命吸取）能将造成伤害的一定比例转化为自身的生命值恢复。</p>
                <p><span className="font-bold text-[color:var(--accent)]">畏缩 (Flinch)：</span>部分技能（如陨石碎击、泰山压顶）在<span className="font-bold">先手攻击</span>命中时，有概率让对方当回合因为害怕而无法行动。如果后手攻击则无法触发畏缩效果。</p>
                <p><span className="font-bold text-[color:var(--accent)]">优先度 (Priority)：</span>极少数技能（如破浪激流）具有极高的先制优先度，可以无视双方速度差，绝对优先出手。</p>
              </div>
            </section>

          </div>
        </PixelCard>
      </div>
    </div>
  );
}