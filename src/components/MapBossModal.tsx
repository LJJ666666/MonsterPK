// F18-c 地图首领弹窗：列出 7 座地图首领，每座显示王牌 / 每日余量 / 掉落预览 / 解锁态。
// 只读优先：列表与解锁、每日余量、掉落都来自服务端 `/api/mapboss`；点「挑战」只发 mapBossId。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import { ITEM_SPECS } from "@/game/data";
import { fetchMapBossList, type MapBossEntry } from "@/lib/mapBoss";

function itemName(id: string): string {
  return ITEM_SPECS[id as keyof typeof ITEM_SPECS]?.name ?? id;
}

export default function MapBossModal({
  onClose,
  onFight,
}: {
  onClose: () => void;
  onFight: (mapBossId: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [list, setList] = useState<MapBossEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fightError, setFightError] = useState<string | null>(null);
  const [fighting, setFighting] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchMapBossList()
      .then((rows) => { if (!cancelled) setList(rows); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? "地图首领列表暂时不可用"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  async function fight(m: MapBossEntry) {
    if (fighting || !m.unlocked || m.remaining <= 0) return;
    setFightError(null);
    setFighting(m.mapBossId);
    try {
      const res = await onFight(m.mapBossId);
      if (!res.ok) setFightError(res.reason ?? "无法开始挑战");
    } finally {
      setFighting(null);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">地图首领</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          地图首领为稀有头领，击败可获得更好的资源（稀有材料 / 特殊道具）。不上排行榜，每日有次数上限。
        </div>

        <div className="flex-1 overflow-y-auto p-2 flex flex-col gap-2">
          {loading && <div className="py-6 text-center text-sm text-[color:var(--muted)]">正在读取地图首领…</div>}
          {!loading && error && (
            <div className="py-4 text-center text-sm text-[color:var(--danger)]">{error}</div>
          )}
          {!loading && !error && list.length === 0 && (
            <div className="py-6 text-center text-sm text-[color:var(--muted)]">暂无地图首领。</div>
          )}
          {!loading && !error && list.map((m) => {
            const noLeft = m.remaining <= 0;
            const disabled = !m.unlocked || noLeft || !!fighting;
            return (
              <div
                key={m.mapBossId}
                className={`border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2 ${m.unlocked ? "" : "opacity-60"}`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs font-semibold text-[color:var(--text)] truncate">{m.name}</div>
                  {!m.unlocked && <span className="flex-none text-[10px] text-[color:var(--muted)]">区域未解锁</span>}
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[color:var(--muted)]">
                  <span>王牌 {m.speciesName} · Lv.{m.level}</span>
                  <span>每日余量 {Math.max(0, m.remaining)}/{m.dailyLimit}</span>
                </div>
                <div className="mt-1 text-[10px] text-[color:var(--accent)]">
                  掉落：{m.drop.money > 0 ? `${m.drop.money} 金币` : ""}
                  {m.drop.items.map((it, i) => (
                    <span key={it.itemId} className="ml-1">{itemName(it.itemId)}×{it.count}</span>
                  ))}
                </div>
                <div className="mt-2 flex items-center justify-end">
                  <PixelButton
                    size="sm"
                    onClick={() => fight(m)}
                    className={disabled ? "opacity-50 pointer-events-none" : ""}
                  >
                    {fighting === m.mapBossId ? "准备中…" : !m.unlocked ? "未解锁" : noLeft ? "今日已打完" : "挑战"}
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
