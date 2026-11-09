// 榜单弹窗：P4-2a 本期四榜 + F01 周期历史榜 + F02 我的奖励。
// 三块数据全部来自服务端只读接口；本地不计算名次、不上报奖励、没有领取入口。
// 375px 窄屏：全纵向列表 + min-w-0/truncate，禁止大表格横向滚动。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import {
  RANK_TABS, RANK_DISCLAIMER, fetchRankBoard, fetchRankPeriods, fetchPeriodBoards,
  fetchMyRewards, formatRankValue, formatReward,
  type RankBoard, type RankRow, type RankType,
  type RankPeriodInfo, type PeriodBoards, type MyRewards,
} from "@/lib/rank";

type View = "current" | "periods" | "rewards";
const VIEWS: { id: View; label: string }[] = [
  { id: "current", label: "本期榜" },
  { id: "periods", label: "周期榜" },
  { id: "rewards", label: "我的奖励" },
];

export default function RankBoardModal({ onClose }: { onClose: () => void }) {
  const [view, setView] = useState<View>("current");
  const [tab, setTab] = useState<RankType>("monster_power");
  const [board, setBoard] = useState<RankBoard | null>(null);
  const [periodInfo, setPeriodInfo] = useState<RankPeriodInfo | null>(null);
  const [selectedPeriod, setSelectedPeriod] = useState<string | null>(null);
  const [periodBoards, setPeriodBoards] = useState<PeriodBoards | null>(null);
  const [rewards, setRewards] = useState<MyRewards | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [reloadKey, setReloadKey] = useState(0);

  // 快速切换视图 / Tab 时丢弃过期响应，避免「界面是推图、数据却是战力」的错位。
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    const run = async () => {
      if (view === "current") return fetchRankBoard(tab, 20);
      if (view === "rewards") return fetchMyRewards();
      return fetchRankPeriods();
    };
    void run()
      .then((data) => {
        if (cancelled) return;
        if (view === "current") setBoard(data as RankBoard);
        else if (view === "rewards") setRewards(data as MyRewards);
        else {
          const info = data as RankPeriodInfo;
          setPeriodInfo(info);
          setSelectedPeriod((prev) =>
            prev && info.periods.some((p) => p.periodKey === prev)
              ? prev : info.periods[0]?.periodKey ?? null);
        }
      })
      .catch((e: any) => {
        if (cancelled) return;
        setError(e?.message ?? "数据暂时不可用");
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [view, tab, reloadKey]);

  // 选中周期变化时拉历史榜；未结算周期由服务端返回明确错误，UI 只显示中文原因。
  useEffect(() => {
    if (view !== "periods" || !selectedPeriod) return;
    let cancelled = false;
    setPeriodBoards(null);
    void fetchPeriodBoards(selectedPeriod)
      .then((d) => { if (!cancelled) setPeriodBoards(d); })
      .catch(() => { if (!cancelled) setPeriodBoards(null); });
    return () => { cancelled = true; };
  }, [view, selectedPeriod, reloadKey]);

  const rowItem = (row: RankRow, key: string, type: RankType) => (
    <div
      key={key}
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
        {formatRankValue(type, row)}
      </div>
    </div>
  );

  const empty = (text: string) => (
    <div className="py-8 text-center text-sm text-[color:var(--muted)]">{text}</div>
  );

  const footerText = view === "current"
    ? `共 ${board?.eligible ?? 0} 份合格存档 · 服务端派生`
    : view === "periods"
      ? `按周期结算 · 共 ${periodBoards?.boards.length ?? 0} 张榜 · 服务端结算`
      : `共 ${rewards?.entries.length ?? 0} 条记录 · 服务端发放 · 只读`;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">兽域榜单</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          {RANK_DISCLAIMER} · 榜单与奖励均由服务端结算，客户端只读
        </div>

        <div className="grid grid-cols-3 border-b-2 border-[color:var(--stroke)]">
          {VIEWS.map((v) => (
            <button
              key={v.id}
              onClick={() => setView(v.id)}
              className={`py-2 text-[10px] border-r-2 border-[color:var(--stroke)] last:border-r-0 ${
                view === v.id
                  ? "bg-[color:var(--accent)] text-[color:var(--bg)] font-bold"
                  : "bg-[color:var(--bg2)] text-[color:var(--muted)]"
              }`}
            >
              {v.label}
            </button>
          ))}
        </div>

        {view === "current" && (
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
        )}

        {view === "periods" && periodInfo && (
          <div className="border-b-2 border-[color:var(--stroke)] px-3 py-2">
            <div className="text-[10px] text-[color:var(--muted)] mb-2">
              已结算周期 · 日榜 UTC+8 · 当前 {periodInfo.currentPeriodKey}
            </div>
            <div className="flex flex-wrap gap-1 max-h-16 overflow-y-auto">
              {periodInfo.periods.map((p) => (
                <button
                  key={p.periodKey}
                  onClick={() => setSelectedPeriod(p.periodKey)}
                  className={`px-2 py-1 text-[10px] border ${
                    selectedPeriod === p.periodKey
                      ? "border-[color:var(--accent)] text-[color:var(--accent)] font-bold"
                      : "border-[color:var(--stroke)] text-[color:var(--muted)]"
                  }`}
                >
                  {p.periodKey}
                </button>
              ))}
              {periodInfo.periods.length === 0 && (
                <span className="text-[10px] text-[color:var(--muted)]">暂无已结算周期</span>
              )}
            </div>
          </div>
        )}

        <div className="px-3 pt-2 text-[10px] text-[color:var(--muted)] truncate">
          {view === "current" ? (loading ? "读取中…" : (board?.description ?? ""))
            : view === "periods" ? `周期 ${selectedPeriod ?? "—"} · 前 ${periodInfo?.rewardMaxRank ?? 10} 名有奖励`
              : "奖励在周期结算时由服务端写档，无需领取"}
        </div>

        <div className="flex-1 overflow-y-auto p-3 flex flex-col gap-2">
          {loading && <div className="py-8 text-center text-sm text-[color:var(--muted)]">正在读取…</div>}
          {!loading && error && (
            <div className="py-6 text-center text-sm text-[color:var(--danger)]">
              <div>{error}</div>
              <PixelButton className="mt-3" onClick={() => setReloadKey((k) => k + 1)}>重试</PixelButton>
            </div>
          )}

          {!loading && !error && view === "current" && (
            board?.entries.length === 0
              ? empty("暂无上榜记录，先去野外走走吧。")
              : board?.entries.map((row) =>
                rowItem(row, `${row.username}#${row.slot}#${row.rank}`, tab))
          )}

          {!loading && !error && view === "periods" && (() => {
            const key = `rank:${tab}`;
            const one = periodBoards?.boards.find((b) => b.boardKey === key);
            if (!one || one.entries.length === 0) return empty("该周期暂无榜单记录");
            return one.entries.map((row) =>
              rowItem(row, `${selectedPeriod}#${row.username}#${row.slot}`, tab));
          })()}

          {!loading && !error && view === "rewards" && (
            rewards?.entries.length === 0
              ? empty("暂无获奖记录")
              : rewards?.entries.map((r, i) => (
                <div key={`${r.periodKey}#${r.boardKey}#${i}`}
                  className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2 min-w-0">
                  <div className="flex items-center justify-between gap-2 min-w-0">
                    <span className="text-xs font-semibold text-[color:var(--text)] truncate">
                      {r.periodKey} · {r.label}
                    </span>
                    <span className="flex-none text-xs font-bold text-[color:var(--accent)]">第 {r.rank} 名</span>
                  </div>
                  <div className="text-[10px] text-[color:var(--muted)] truncate mt-1">
                    {formatReward(r.reward)} · 服务端发放 · 槽位 {r.slot}
                  </div>
                </div>
              ))
          )}
        </div>

        <div className="flex items-center justify-between gap-2 border-t-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
          <div className="text-[10px] text-[color:var(--muted)] truncate">{footerText}</div>
          <PixelButton size="sm" onClick={() => setReloadKey((k) => k + 1)}>刷新</PixelButton>
        </div>
      </div>
    </div>
  );
}
