// P4-2e 共斗 Boss / 副本弹窗：选 Boss → 创建 / 加入房间 → 共斗界面。
//
// 唯一真值在服务端：Boss HP 与整场共斗由 `room.state` 全量快照下发（按接收者裁剪），
// 客户端只发意图（move:<moveId> / switch:<idx>）。本组件不计算伤害 / 胜负 / PP，
// 也不显示任何「领取奖励」入口 —— 本阶段刻意不发奖励（台账 F09 / F14 待设计）。
import { useCallback, useEffect, useRef, useState } from "react";
import PixelButton from "@/components/PixelButton";
import StatBar from "@/components/StatBar";
import { ELEMENT_LABEL, MOVE_SPECS } from "@/game/data";
import { api } from "@/lib/api";
import { ROOM_STATE_EVENT, type RoomView, type RoomStateMessage } from "@/lib/sessionState";
import { COOP_DISCLAIMER, coopResultText, coopStatusText, coopViewOf } from "@/lib/coop";
import { newNonce } from "@/lib/pvp";
import { fetchBossList, type BossEntry } from "@/lib/boss";
import { useGameStore } from "@/stores/useGameStore";
import { getMoveMaxPP } from "@/game/rules";
import { MonsterName } from "@/components/MonsterName";

type Phase = "idle" | "creating" | "joining" | "waiting" | "fighting" | "finished";

export default function CoopModal({ onClose }: { onClose: () => void }) {
  const { slot } = useGameStore();
  const [phase, setPhase] = useState<Phase>("idle");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [roomId, setRoomId] = useState("");
  const [bosses, setBosses] = useState<BossEntry[]>([]);
  const [bossId, setBossId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const roomRef = useRef<RoomView | null>(null);
  roomRef.current = room;

  // 讨伐目标清单只读下发（内容表在服务端）。
  useEffect(() => {
    let cancelled = false;
    void fetchBossList().then((list) => {
      if (cancelled) return;
      setBosses(list);
      if (list.length > 0) setBossId((cur) => cur || list[0].bossId);
    }).catch(() => {
      if (!cancelled) setError("共斗目标列表暂不可用，请稍后重试");
    });
    return () => { cancelled = true; };
  }, []);

  // 订阅 room.state 快照：只转发形状合法、revision 递增的快照。
  useEffect(() => {
    const onMsg = (e: Event) => {
      const m = (e as CustomEvent<RoomStateMessage>).detail;
      if (!m?.room) return;
      const cur = roomRef.current;
      if (cur && cur.roomId === m.room.roomId && m.room.revision <= cur.revision) return;
      setRoom(m.room);
      const coop = coopViewOf(m.room);
      if (m.room.status === "settled" || (coop && coop.finished)) setPhase("finished");
      else if (coop) setPhase("fighting");
      else if (m.room.status === "active") setPhase("fighting");
      else setPhase("waiting");
      setSubmitted(false);
    };
    window.addEventListener(ROOM_STATE_EVENT, onMsg);
    return () => window.removeEventListener(ROOM_STATE_EVENT, onMsg);
  }, []);

  async function create() {
    if (!bossId) { setError("请先选择共斗目标"); return; }
    setError(null);
    setBusy(true);
    try {
      const res = await api.coopCreate({ slot, bossId });
      if (res?.room) {
        setRoom(res.room);
        setRoomId(res.room.roomId ?? "");
        setPhase("waiting");
      } else {
        setError("创建失败：服务端没有返回房间");
      }
    } catch (e: any) {
      setError(e?.message ?? "创建失败");
    } finally {
      setBusy(false);
    }
  }

  async function join() {
    if (!roomId.trim()) { setError("请先输入房间号"); return; }
    setError(null);
    setBusy(true);
    try {
      const res = await api.coopJoin(roomId.trim(), { slot });
      if (res?.room) {
        setRoom(res.room);
        setPhase("fighting");
      } else {
        setError("加入失败：服务端没有返回房间");
      }
    } catch (e: any) {
      setError(e?.message ?? "加入失败");
    } finally {
      setBusy(false);
    }
  }

  const submit = useCallback(async (intent: string) => {
    const r = roomRef.current;
    if (!r) return;
    setSubmitted(true);
    try {
      await api.roomAction(r.roomId, intent, newNonce());
    } catch (e: any) {
      setError(e?.message ?? "指令未生效");
      setSubmitted(false);
    }
  }, []);

  const coop = coopViewOf(room);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">共斗讨伐</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          {COOP_DISCLAIMER}
        </div>

        {phase === "idle" && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <div className="text-xs text-[color:var(--text)] font-semibold">选择共斗目标</div>
            <div className="flex flex-col gap-1 max-h-[28vh] overflow-y-auto">
              {bosses.map((b) => (
                <button
                  key={b.bossId}
                  onClick={() => setBossId(b.bossId)}
                  className={`text-left border-2 p-2 text-xs ${bossId === b.bossId ? "border-[color:var(--accent)] bg-[color:var(--panel2)]" : "border-[color:var(--stroke)] bg-[color:var(--bg2)]"} text-[color:var(--text)]`}
                >
                  <span className="font-semibold">{b.name}</span>
                  <span className="ml-1 text-[10px] text-[color:var(--muted)]">Lv.{b.level} · 每日 {b.dailyLimit} 次</span>
                </button>
              ))}
              {bosses.length === 0 && <div className="text-[10px] text-[color:var(--muted)]">正在读取共斗目标…</div>}
            </div>
            <PixelButton tone="primary" onClick={create} className={busy ? "opacity-50 pointer-events-none" : ""}>
              {busy ? "创建中…" : "创建共斗房间"}
            </PixelButton>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="输入房间号加入"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="flex-1 min-w-0 bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] p-2 text-sm text-[color:var(--text)] placeholder:text-[color:var(--muted)] outline-none focus:border-[color:var(--accent)]"
              />
              <PixelButton tone="muted" size="sm" onClick={join} className={busy ? "opacity-50 pointer-events-none" : ""}>
                加入
              </PixelButton>
            </div>
            <div className="text-[10px] text-[color:var(--muted)] leading-relaxed">
              创建房间后把房间号告诉朋友，对方输入房间号即可加入。全员到齐后自动开局。
            </div>
          </div>
        )}

        {phase === "waiting" && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <div className="border-2 border-[color:var(--accent)] bg-[color:var(--panel2)] p-3 text-sm text-[color:var(--text)]">
              房间号：<span className="font-display font-bold">{room?.roomId}</span>
            </div>
            <div className="text-sm text-[color:var(--muted)]">等待队友加入…</div>
            <div className="text-[10px] text-[color:var(--muted)]">状态：{coopStatusText(room)}</div>
          </div>
        )}

        {coop && (phase === "fighting" || phase === "finished") && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
              <span>回合 {coop.turn}</span>
              <span>{coopStatusText(room)}</span>
            </div>

            {/* Boss：房间真值 HP */}
            <div className="border-2 border-[color:var(--danger)] bg-[color:var(--bg2)] p-3">
              <div className="flex items-baseline justify-between gap-2">
                <div className="text-sm font-semibold text-[color:var(--text)] truncate">{coop.bossName}</div>
                <div className="text-xs text-[color:var(--muted)] flex-none">Lv.{coop.boss.level}</div>
              </div>
              <div className="mt-2">
                <StatBar label="BOSS HP" value={coop.boss.hp} max={coop.boss.maxHp} tone="enemy" />
              </div>
            </div>

            {/* 成员伤害（服务端累计，公开） */}
            <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2 text-[10px] text-[color:var(--muted)]">
              <div className="font-semibold text-[color:var(--text)] text-xs mb-1">本场伤害</div>
              {coop.members.map((m) => (
                <div key={m.seat} className="flex justify-between gap-2">
                  <span className="truncate">{m.self ? "我" : `座位 ${m.seat + 1}`}{m.out ? "（已出局）" : ""}</span>
                  <span className="flex-none">{m.damage}</span>
                </div>
              ))}
            </div>

            {/* 我方 active */}
            {(() => {
              const self = coop.self.party[coop.self.activeIndex];
              if (!self) return null;
              const pp = coop.self.ppByMonster[self.id] ?? {};
              return (
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
                  <div className="flex items-baseline justify-between">
                    <div className="text-sm font-semibold text-[color:var(--text)]"><MonsterName m={self as any} /></div>
                    <div className="text-xs text-[color:var(--muted)]">
                      Lv.{self.level} · {ELEMENT_LABEL[self.element as keyof typeof ELEMENT_LABEL] ?? self.element}
                    </div>
                  </div>
                  <div className="mt-2">
                    <StatBar label="HP" value={self.hp} max={self.maxHp} />
                  </div>
                  <div className="mt-1 text-[10px] text-[color:var(--muted)]">状态：{self.status === "none" ? "正常" : self.status}</div>
                </div>
              );
            })()}

            {/* 日志 */}
            <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 text-xs leading-relaxed text-[color:var(--muted)] max-h-[20vh] overflow-y-auto">
              {coop.log.slice(-6).map((line, idx) => (
                <div key={idx} className={idx === coop.log.slice(-6).length - 1 ? "text-[color:var(--text)] font-medium" : ""}>
                  {line}
                </div>
              ))}
              {coop.log.length === 0 && <div className="italic">共斗开始…</div>}
            </div>

            {/* 行动面板：共斗刻意不支持逃跑 */}
            {!coop.finished ? (
              <div className="grid grid-cols-2 gap-2">
                {(() => {
                  const self = coop.self.party[coop.self.activeIndex];
                  if (!self) return null;
                  const pp = coop.self.ppByMonster[self.id] ?? {};
                  return (
                    <>
                      {self.moveIds.map((id) => {
                        const cur = pp[id] ?? 0;
                        return (
                          <PixelButton
                            key={id}
                            disabled={submitted || cur <= 0 || coop.self.out}
                            onClick={() => void submit(`move:${id}`)}
                          >
                            <span>{MOVE_SPECS[id]?.name ?? id}</span>
                            <span className="ml-1 text-[10px] opacity-70">PP {cur}/{getMoveMaxPP(id)}</span>
                          </PixelButton>
                        );
                      })}
                      {coop.self.party.map((m, idx) =>
                        m.hp > 0 && idx !== coop.self.activeIndex ? (
                          <PixelButton
                            key={m.id}
                            tone="muted"
                            disabled={submitted || coop.self.out}
                            onClick={() => void submit(`switch:${idx}`)}
                          >
                            换 <MonsterName m={m as any} />
                          </PixelButton>
                        ) : null,
                      )}
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="text-center text-sm font-bold text-[color:var(--text)]">{coopResultText(coop)}</div>
            )}

            {submitted && !coop.finished && (
              <div className="text-center text-[10px] text-[color:var(--accent)] animate-pulse">已提交，等待队友…</div>
            )}
          </div>
        )}

        {error && (
          <div className="border-t-2 border-[color:var(--stroke)] px-3 py-2 text-[10px] text-[color:var(--danger)]">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
