// P4-2a 只读派生榜弹窗：四榜切换、加载/错误/空态、窄屏无横向溢出。
// 所有数值来自 GET /api/rank/:type，本地不计算战力、不缓存可改写的榜单真值。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import {
  RANK_TABS, RANK_DISCLAIMER, fetchRankBoard, formatRankValue,
  type RankBoard, type RankType,
} from "@/lib/rank";

export default function RankBoardModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<RankType>("monster_power");
  const [board, setBoard] = useState<RankBoard | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 切 Tab / 刷新时丢弃过期响应：快速连点会让先发的请求后到，
  // 若不取消，界面会出现「Tab 是推图、说明却是战力榜」的错位。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void fetchRankBoard(tab, 20)
      .then((b) => { if (!cancelled) setBoard(b); })
      .catch((e: any) => {
        if (cancelled) return;
        setBoard(null);
        setError(e?.message ?? "榜单暂时不可用");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [tab, reloadKey]);

  const disclaimer = loading ? RANK_DISCLAIMER : (board?.disclaimer || RANK_DISCLAIMER);
  const description = loading ? "读取中…" : (board?.description ?? "");

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">兽域榜单</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          {disclaimer} · 榜单由服务端存档派生，只读
        </div>

        <div className="grid grid-cols-4 border-b-2 border-[color:var(--stroke)]">
          {RANK_TABS.map((t) => (
            <button
              key={t.type}
              onClick={() => setTab(t.type)}
              className={`py-2 text-[10px] border-r-2 border-[color:var(--stroke)] last:border-r-0 ${
                tab === t.type
                  ? "bg-[color:var(--accent)] text-[color:var(--bg)] font-bold"
                  : "bg-[color:var(--bg2)] text-[color:var(--muted)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="px-3 pt-2 text-[10px] text-[color:var(--muted)]">
          {description}
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loading && <div className="py-8 text-center text-sm text-[color:var(--muted)]">正在读取榜单…</div>}
          {!loading && error && (
            <div className="py-6 text-center text-sm text-[color:var(--danger)]">
              <div>{error}</div>
              <PixelButton className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>重试</PixelButton>
            </div>
          )}
          {!loading && !error && board?.entries.length === 0 && (
            <div className="py-8 text-center text-sm text-[color:var(--muted)]">暂无上榜记录，先去野外走走吧。</div>
          )}
          {!loading && !error && board?.entries.map((row) => (
            <div
              key={`${row.username}#${row.slot}#${row.rank}`}
              className={`flex items-center gap-2 border-2 p-2 min-w-0 ${
                row.isMe
                  ? "border-[color:var(--accent)] bg-[color:var(--panel2)]"
                  : "border-[color:var(--stroke)] bg-[color:var(--bg2)]"
              }`}
            >
              <div className="w-7 flex-none text-center font-display text-sm text-[color:var(--accent)]">{row.rank}</div>
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-[color:var(--text)] truncate">
                  {row.username}<span className="text-[color:var(--muted)]">#{row.slot}</span>
                  {row.isMe && <span className="ml-1 text-[color:var(--accent)]">[我]</span>}
                </div>
                <div className="text-[10px] text-[color:var(--muted)] truncate">{row.detail}</div>
              </div>
              <div className="flex-none text-right text-xs font-bold text-[color:var(--text)] whitespace-nowrap">
                {formatRankValue(tab, row)}
              </div>
            </div>
          ))}
        </div>

        <div className="flex items-center justify-between gap-2 border-t-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
          <div className="text-[10px] text-[color:var(--muted)] truncate">
            共 {board?.eligible ?? 0} 份合格存档 · 服务端派生
          </div>
          <PixelButton size="sm" onClick={() => setReloadKey((k) => k + 1)}>刷新</PixelButton>
        </div>
      </div>
    </div>
  );
}
