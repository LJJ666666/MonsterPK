// F04 徽章 / 成就弹窗：一个页面、两个 Tab（规范 §31.1 / §31.4）。
// 数据全部来自服务端只读接口；本地不计算等级、不上报字段、没有领取入口。
// 375px 窄屏：全纵向列表 + min-w-0/truncate + max-h/overflow-auto，禁止横向滚动。
import { useEffect, useState } from "react";
import PixelButton from "@/components/PixelButton";
import {
  PROGRESS_DISCLAIMER, fetchPlayerProgress,
  type PlayerProgressResponse,
} from "@/lib/playerProgress";

type Tab = "badges" | "achievements";
const TABS: { id: Tab; label: string }[] = [
  { id: "badges", label: "徽章" },
  { id: "achievements", label: "成就" },
];

export default function BadgeModal({ onClose }: { onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("badges");
  const [data, setData] = useState<PlayerProgressResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void fetchPlayerProgress()
      .then((d) => { if (!cancelled) setData(d); })
      .catch((e: any) => { if (!cancelled) setError(e?.message ?? "数据暂时不可用"); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, []);

  const p = data?.progress;
  const owned = new Set((p?.badges ?? []).map((b) => b.id));

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-display text-sm tracking-[0.08em] text-[color:var(--text)]">徽章与成就</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        {/* 顶部总览：人物等级 / 等级帽 / 总等级加成（服务端真值，只读） */}
        <div className="border-b-2 border-[color:var(--stroke2)] bg-[color:var(--panel2)] px-3 py-2">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-[color:var(--muted)]">
            <span>人物等级 <b className="text-[color:var(--text)]">Lv.{p?.level ?? 5}</b></span>
            <span>宠物等级帽 <b className="text-[color:var(--text)]">{p?.cap ?? 5}</b></span>
          </div>
          <div className="mt-1 font-display text-sm text-[color:var(--accent)]">
            总等级加成 +{p?.badgeBonus ?? 0}
          </div>
          <div className="text-[10px] text-[color:var(--muted)]">
            已获徽章 {p?.badgeCount ?? 0} / {data?.catalog.length ?? 7} · 每座城镇演武堂胜利可得
          </div>
        </div>

        <div className="flex flex-none border-b-2 border-[color:var(--stroke)]">
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex-1 py-2 text-xs font-semibold ${
                tab === t.id
                  ? "bg-[color:var(--accent)] text-[color:var(--bg)]"
                  : "bg-[color:var(--bg2)] text-[color:var(--muted)]"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="flex-1 overflow-auto p-3 min-h-0">
          {loading && <div className="py-8 text-center text-sm text-[color:var(--muted)]">读取服务端进度…</div>}
          {!loading && error && <div className="py-8 text-center text-sm text-[color:var(--danger)]">{error}</div>}
          {!loading && !error && tab === "badges" && (
            <div className="space-y-2">
              {(data?.catalog ?? []).map((b) => {
                const has = owned.has(b.id);
                return (
                  <div
                    key={b.id}
                    className={`flex items-center gap-2 border-2 p-2 min-w-0 ${
                      has
                        ? "border-[color:var(--accent)] bg-[color:var(--panel2)]"
                        : "border-[color:var(--stroke)] bg-[color:var(--bg2)] opacity-60"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className="text-xs font-semibold text-[color:var(--text)] truncate">
                        {b.name} 丨 {b.levelBonus}
                      </div>
                      <div className="text-[10px] text-[color:var(--muted)] truncate">
                        {b.locationName} · {has ? b.desc : "未获得"}
                      </div>
                    </div>
                    <div className="flex-none text-[10px] text-[color:var(--muted)] whitespace-nowrap">
                      {has ? "已获得" : "未挑战"}
                    </div>
                  </div>
                );
              })}
              {(data?.catalog.length ?? 0) === 0 && (
                <div className="py-8 text-center text-sm text-[color:var(--muted)]">暂无徽章清单</div>
              )}
            </div>
          )}
          {!loading && !error && tab === "achievements" && (
            <div className="space-y-2">
              {(p?.achievements ?? []).map((a) => (
                <div key={a.id} className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2 min-w-0">
                  <div className="text-xs font-semibold text-[color:var(--text)] truncate">{a.name}</div>
                  <div className="text-[10px] text-[color:var(--muted)] truncate">{a.desc}</div>
                  <div className="mt-1 flex flex-wrap gap-1">
                    {a.bonusText.map((t) => (
                      <span key={t} className="border border-[color:var(--accent)] px-1 text-[10px] text-[color:var(--accent)]">
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
              ))}
              {(p?.achievements.length ?? 0) === 0 && (
                <div className="py-8 text-center text-sm text-[color:var(--muted)]">尚未解锁成就</div>
              )}
              {(p?.bonuses.length ?? 0) > 0 && (
                <div className="border-t-2 border-[color:var(--stroke2)] pt-2 text-[10px] text-[color:var(--muted)]">
                  合计加成 {p?.bonuses.length ?? 0} 项 · 属性加成待装备系统统一生效（F06）
                </div>
              )}
            </div>
          )}
        </div>

        <div className="flex-none border-t-2 border-[color:var(--stroke)] p-2">
          <div className="mb-2 text-[10px] leading-relaxed text-[color:var(--muted)]">{PROGRESS_DISCLAIMER}</div>
          <PixelButton onClick={onClose}>关闭</PixelButton>
        </div>
      </div>
    </div>
  );
}
