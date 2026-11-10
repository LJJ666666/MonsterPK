// P4-2c 讨伐弹窗：Boss 列表 + 今日伤害榜 + 开战入口。
//
// 只读优先：列表与榜都来自服务端（`/api/boss`、`/api/boss/:id/rank`），
// 客户端不算伤害、不扣次数。点「讨伐」只发 `bossId`，战斗仍在 Arena 里按服务端下发的视图渲染。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import {
  BOSS_DISCLAIMER, fetchBossList, fetchBossRank,
  type BossEntry, type BossRank,
} from "@/lib/boss";

function fmt(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (n >= 10000) return `${(n / 10000).toFixed(1)}万`;
  return `${Math.max(0, Math.floor(n))}`;
}

export default function BossBoardModal({
  onClose,
  onFight,
}: {
  onClose: () => void;
  onFight: (bossId: string) => Promise<{ ok: boolean; reason?: string }>;
}) {
  const [list, setList] = useState<BossEntry[]>([]);
  const [listLoading, setListLoading] = useState(true);
  const [listError, setListError] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);

  const [rank, setRank] = useState<BossRank | null>(null);
  const [rankLoading, setRankLoading] = useState(false);
  const [rankError, setRankError] = useState<string | null>(null);

  const [fightError, setFightError] = useState<string | null>(null);
  const [fighting, setFighting] = useState(false);
  const [reloadKey, setReloadKey] = useState(0);

  // 列表：进入时拉一次；失败给重试，不静默空列表。
  useEffect(() => {
    let cancelled = false;
    setListLoading(true);
    setListError(null);
    void fetchBossList()
      .then((rows) => {
        if (cancelled) return;
        setList(rows);
        setSelected((prev) => prev ?? rows[0]?.bossId ?? null);
      })
      .catch((e: any) => {
        if (cancelled) return;
        setList([]);
        setListError(e?.message ?? "讨伐列表暂时不可用");
      })
      .finally(() => { if (!cancelled) setListLoading(false); });
    return () => { cancelled = true; };
  }, [reloadKey]);

  // 榜：切换 Boss 时丢弃过期响应（与 P4-2a 榜单同一个坑，见 bug_log §28）。
  useEffect(() => {
    if (!selected) { setRank(null); return; }
    let cancelled = false;
    setRankLoading(true);
    setRankError(null);
    void fetchBossRank(selected, 20)
      .then((r) => { if (!cancelled) setRank(r); })
      .catch((e: any) => {
        if (cancelled) return;
        setRank(null);
        setRankError(e?.message ?? "伤害榜暂时不可用");
      })
      .finally(() => { if (!cancelled) setRankLoading(false); });
    return () => { cancelled = true; };
  }, [selected, reloadKey]);

  const current = list.find((b) => b.bossId === selected) ?? null;

  async function fight() {
    if (!current || fighting) return;
    setFightError(null);
    setFighting(true);
    try {
      const res = await onFight(current.bossId);
      if (!res.ok) setFightError(res.reason ?? "无法开始讨伐");
    } finally {
      setFighting(false);
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">兽域讨伐</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          {BOSS_DISCLAIMER}
        </div>

        {/* Boss 列表：窄屏单列，卡片内部换行，不出现横向滚动 */}
        <div className="max-h-[30vh] overflow-y-auto p-2 flex flex-col gap-2">
          {listLoading && <div className="py-6 text-center text-sm text-[color:var(--muted)]">正在读取讨伐列表…</div>}
          {!listLoading && listError && (
            <div className="py-4 text-center text-sm text-[color:var(--danger)]">
              <div>{listError}</div>
              <PixelButton className="mt-2" size="sm" onClick={() => setReloadKey((k) => k + 1)}>重试</PixelButton>
            </div>
          )}
          {!listLoading && !listError && list.length === 0 && (
            <div className="py-6 text-center text-sm text-[color:var(--muted)]">暂无讨伐目标。</div>
          )}
          {!listLoading && !listError && list.map((b) => {
            const active = b.bossId === selected;
            return (
              <button
                key={b.bossId}
                onClick={() => setSelected(b.bossId)}
                className={`text-left border-2 p-2 min-w-0 ${
                  active
                    ? "border-[color:var(--accent)] bg-[color:var(--panel2)]"
                    : "border-[color:var(--stroke)] bg-[color:var(--bg2)]"
                }`}
              >
                <div className="flex items-center justify-between gap-2">
                  <div className="min-w-0 text-xs font-semibold text-[color:var(--text)] truncate">{b.name}</div>
                  <div className="flex-none text-[10px] text-[color:var(--muted)] whitespace-nowrap">Lv.{b.level}</div>
                </div>
                <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[10px] text-[color:var(--muted)]">
                  <span>今日剩余 {b.remaining}/{b.dailyLimit}</span>
                  <span>累计伤害 {fmt(b.my.total)}</span>
                  <span>最高 {fmt(b.my.best)}</span>
                </div>
              </button>
            );
          })}
        </div>

        <div className="border-t-2 border-[color:var(--stroke)] px-3 py-2 text-[10px] text-[color:var(--muted)]">
          {current ? current.description : "选择一只讨伐目标查看伤害榜。"}
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          <div className="text-[10px] font-bold text-[color:var(--text)]">
            今日伤害榜{rank?.periodKey ? ` · ${rank.periodKey}` : ""}
          </div>
          {rankLoading && <div className="py-6 text-center text-sm text-[color:var(--muted)]">正在读取榜单…</div>}
          {!rankLoading && rankError && (
            <div className="py-4 text-center text-sm text-[color:var(--danger)]">
              <div>{rankError}</div>
              <PixelButton className="mt-2" size="sm" onClick={() => setReloadKey((k) => k + 1)}>重试</PixelButton>
            </div>
          )}
          {!rankLoading && !rankError && rank?.entries.length === 0 && (
            <div className="py-6 text-center text-sm text-[color:var(--muted)]">今日还没有人上榜，抢个第一。</div>
          )}
          {!rankLoading && !rankError && rank?.entries.map((row) => (
            <div
              key={`${row.username}#${row.rank}`}
              className={`flex items-center gap-2 border-2 p-2 min-w-0 ${
                row.isMe
                  ? "border-[color:var(--accent)] bg-[color:var(--panel2)]"
                  : "border-[color:var(--stroke)] bg-[color:var(--bg2)]"
              }`}
            >
              <div className="w-7 flex-none text-center font-display text-sm text-[color:var(--accent)]">{row.rank}</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-[color:var(--text)] truncate">
                  {row.username}
                  {row.isMe && <span className="ml-1 text-[color:var(--accent)]">[我]</span>}
                </div>
                <div className="text-[10px] text-[color:var(--muted)] truncate">
                  {row.attempts} 次 · 最高 {fmt(row.best)}
                </div>
              </div>
              <div className="flex-none text-right text-xs font-bold text-[color:var(--text)] whitespace-nowrap">
                {fmt(row.damage)}
              </div>
            </div>
          ))}
        </div>

        <div className="border-t-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 flex flex-col gap-2">
          {fightError && (
            <div className="border-2 border-[color:var(--danger)] px-2 py-1 text-[10px] text-[color:var(--danger)]">
              {fightError}
            </div>
          )}
          <div className="flex items-center justify-between gap-2">
            <div className="text-[10px] text-[color:var(--muted)] min-w-0 truncate">
              {current
                ? `今日已用 ${current.used} 次${current.remaining <= 0 ? " · 次数已用完" : ""}`
                : "只读视图"}
            </div>
            <PixelButton
              size="sm"
              onClick={fight}
              className={fighting || !current || current.remaining <= 0 ? "opacity-50 pointer-events-none" : ""}
            >
              {fighting ? "准备中…" : "讨伐"}
            </PixelButton>
          </div>
        </div>
      </div>
    </div>
  );
}
