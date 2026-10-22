import { useGameStore } from "@/stores/useGameStore";
import { MONSTER_SPECS } from "@/game/data";
import PixelButton from "./PixelButton";
import type { MonsterInstance } from "@/game/types";

export function EvolutionModal() {
  const save = useGameStore((s) => s[`save${s.slot}` as keyof typeof s]) as any;
  const resolvePendingEvolution = useGameStore((s) => s.resolvePendingEvolution);

  if (!save) return null;

  const hasPendingMoves = save.party.some((m: MonsterInstance) => (m.pendingMoves?.length ?? 0) > 0);
  if (hasPendingMoves) return null;

  const evolvingMonster = save.party.find((m: MonsterInstance) => m.pendingEvolution) as MonsterInstance | undefined;
  if (!evolvingMonster || !evolvingMonster.pendingEvolution) return null;

  const fromSpec = MONSTER_SPECS[evolvingMonster.specId];
  const toSpec = MONSTER_SPECS[evolvingMonster.pendingEvolution.targetId];
  if (!fromSpec || !toSpec) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-sm border-4 border-[color:var(--stroke)] bg-[color:var(--bg)] p-4 shadow-2xl">
        <div className="mb-4 text-center font-display text-lg text-[color:var(--text)]">
          {fromSpec.name} 即将进化为 <span className="text-[color:var(--accent)]">{toSpec.name}</span>
        </div>
        <div className="mb-4 text-center text-sm text-[color:var(--muted)]">
          是否开始进化？
        </div>

        <div className="grid gap-2">
          <PixelButton tone="primary" className="w-full" onClick={() => resolvePendingEvolution(evolvingMonster.id, true)}>
            开始进化
          </PixelButton>
          <PixelButton tone="muted" className="w-full" onClick={() => resolvePendingEvolution(evolvingMonster.id, false)}>
            暂不进化
          </PixelButton>
        </div>
      </div>
    </div>
  );
}
