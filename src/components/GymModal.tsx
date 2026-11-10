// F18-b 演武堂弹窗：列出 7 座演武堂，每座显示馆主 / 王牌 / 已得徽章 / 馆主休息倒计时。
// 只读优先：列表与冷却、徽章归属都来自服务端 `/api/gym/overview`；点「挑战馆主」只发 locationId。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import { MONSTER_SPECS } from "@/game/data";
import { fetchGymOverview, type GymEntry } from "@/lib/gym";

function fmtClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(s / 60);
  const r = s % 60;
  return `${m}:${r.toString().padStart(2, "0")}`;
}

export default function GymModal({
  onClose,
  onFight,
}: {
  onClose: () => void;
  onFight: (locationId: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [list, setList] = useState<GymEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fightError, setFightError] = useState<string | null>(null);
  const [fighting, setFighting] = useState<string | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchGymOverview()
      .then((rows) => { if (!cancelled) setList(rows); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? "演武堂列表暂时不可用"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  // 馆主休息倒计时：每秒刷新一次，避免手动重拉列表。
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, []);

  async function fight(g: GymEntry) {
    if (fighting) return;
    setFightError(null);
    setFighting(g.locationId);
    try {
      const res = await onFight(g.locationId);
      if (!res.ok) setFightError(res.reason ?? "无法开始挑战");
    } finally {
      setFighting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">兽域演武堂</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          击败馆主可获得对应城镇徽章（徽章提升召唤师等级上限）。馆主每次比试后需休息 20 分钟。
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
          {loading && <div className="py-6 text-center text-sm text-[color:var(--muted)]">正在读取演武堂…</div>}
          {!loading && error && (
            <div className="py-4 text-center text-sm text-[color:var(--danger)]">{error}</div>
          )}
          {!loading && !error && list.length === 0 && (
            <div className="py-6 text-center text-sm text-[color:var(--muted)]">暂无演武堂。</div>
          )}
          {!loading && !error && list.map((g) => {
            const aceName = MONSTER_SPECS[g.aceSpeciesId]?.name ?? g.aceSpeciesId;
            const cdLeft = g.cooldownUntil - now;
            const cooling = g.onCooldown && cdLeft > 0;
            return (
              <div
                key={g.locationId}
                className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2"
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs font-semibold text-[color:var(--text)] truncate">{g.leaderName}</div>
                  {g.badgeOwned && (
                    <span className="flex-none text-[10px] text-[color:var(--accent)]">已获徽章 ✓</span>
                  )}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[color:var(--muted)]">
                  <span>王牌 {aceName} · Lv.{g.aceLevel}</span>
                  {cooling && <span className="text-[color:var(--danger)]">馆主休息中 {fmtClock(cdLeft)}</span>}
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <PixelButton
                    size="sm"
                    onClick={() => fight(g)}
                    className={fighting || cooling ? "opacity-50 pointer-events-none" : ""}
                  >
                    {fighting === g.locationId ? "准备中…" : cooling ? "休息中" : "挑战馆主"}
                  </PixelButton>
                </div>
              </div>
            );
          })}
        </div>

        {fightError && (
          <div className="border-t-2 border-[color:var(--danger)] px-3 py-2 text-[10px] text-[color:var(--danger)]">
            {fightError}
          </div>
        )}
      </div>
    </div>
  );
}
