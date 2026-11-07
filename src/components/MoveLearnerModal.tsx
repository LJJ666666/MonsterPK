import { useState } from "react";
import { useGameStore } from "@/stores/useGameStore";
import { MONSTER_SPECS, MOVE_SPECS } from "@/game/data";
import PixelButton from "./PixelButton";
import type { MonsterInstance } from "@/game/types";

export function MoveLearnerModal() {
  const save = useGameStore((s) => s[`save${s.slot}` as keyof typeof s]) as any;
  const resolvePendingMove = useGameStore((s) => s.resolvePendingMove);
  // P3-2：学招/替换/放弃都在服务端校验（待学列表、技能栏位、要替换的技能是否真的在身上）。
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (!save) return null;

  // 找出队伍中第一个有待学技能的宠物
  const learningMonster = save.party.find((m: MonsterInstance) => m.pendingMoves && m.pendingMoves.length > 0) as MonsterInstance | undefined;

  if (!learningMonster || !learningMonster.pendingMoves) return null;

  const newMoveId = learningMonster.pendingMoves[0];
  const newMove = MOVE_SPECS[newMoveId];

  const act = async (fn: () => Promise<{ ok: boolean; reason?: string }>) => {
    setBusy(true);
    const res = await fn();
    setBusy(false);
    if (!res.ok) setError(res.reason ?? "学招请求失败");
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 p-4">
      <div className="w-full max-w-sm border-4 border-[color:var(--stroke)] bg-[color:var(--bg)] p-4 shadow-2xl">
        <div className="mb-4 text-center font-display text-lg text-[color:var(--text)]">
          {MONSTER_SPECS[learningMonster.specId].name} 想要学习 <span className="text-[color:var(--accent)]">{newMove.name}</span>
        </div>
        <div className="mb-4 text-center text-sm text-[color:var(--muted)]">
          但是它只能学会 4 个技能。<br/>请选择一个要遗忘的技能，或者放弃学习。
        </div>

        {error && (
          <div className="mb-3 border-2 border-[color:var(--danger)] px-2 py-1 text-xs text-[color:var(--danger)]">
            {error}
          </div>
        )}

        <div className="mb-4 border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
          <div className="text-xs text-[color:var(--accent)] mb-1">新技能</div>
          <div className="flex items-center justify-between">
            <div className="font-semibold text-[color:var(--text)]">{newMove.name}</div>
            <div className="text-[10px] text-[color:var(--muted)]">
              威力 {newMove.power} · 命中 {Math.round(newMove.accuracy * 100)}%
            </div>
          </div>
          {newMove.desc && (
            <div className="mt-2 text-xs text-[color:var(--text)] opacity-90 leading-relaxed">
              {newMove.desc}
            </div>
          )}
        </div>

        <div className="text-xs text-[color:var(--muted)] mb-2">点击要遗忘的技能：</div>
        <div className="grid gap-2">
          {learningMonster.moveIds.map((id) => {
            const move = MOVE_SPECS[id];
            return (
              <button
                key={id}
                disabled={busy}
                onClick={() => void act(() => resolvePendingMove(learningMonster.id, id, newMoveId))}
                className="block w-full border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2 text-left active:bg-[color:var(--panel2)]"
              >
                <div className="flex items-center justify-between">
                  <div className="font-semibold text-[color:var(--text)]">{move.name}</div>
                  <div className="text-[10px] text-[color:var(--muted)]">
                    威力 {move.power} · 命中 {Math.round(move.accuracy * 100)}%
                  </div>
                </div>
                {move.desc && (
                  <div className="mt-1 text-xs text-[color:var(--text)] opacity-80">
                    {move.desc}
                  </div>
                )}
              </button>
            );
          })}
        </div>

        <div className="mt-4 border-t-2 border-[color:var(--stroke)] pt-4">
          <PixelButton
            tone="muted"
            className="w-full"
            disabled={busy}
            onClick={() => void act(() => resolvePendingMove(learningMonster.id, null, newMoveId, { discard: true }))}
          >
            放弃学习 {newMove.name}
          </PixelButton>
        </div>
      </div>
    </div>
  );
}
