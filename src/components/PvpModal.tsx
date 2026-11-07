// P4-2d 玩家对战 1v1 弹窗：创建 / 加入房间 + 对战界面。
//
// 唯一真值在服务端：房间与 1v1 战斗态由 `room.state` 全量快照下发（按接收者裁剪），
// 客户端只发意图（move:<moveId> / switch:<idx> / flee）。本组件不计算伤害 / 胜负 / PP，
// 只把服务端下发的视图渲染出来，把玩家的选择编码成意图字符串发出去。
import { useCallback, useEffect, useRef, useState } from "react";
import PixelButton from "@/components/PixelButton";
import StatBar from "@/components/StatBar";
import { ELEMENT_LABEL, MOVE_SPECS } from "@/game/data";
import { api } from "@/lib/api";
import { ROOM_STATE_EVENT, type RoomView, type RoomStateMessage } from "@/lib/sessionState";
import { newNonce, PVP_DISCLAIMER, pvpStatusText, pvpViewOf } from "@/lib/pvp";
import { useGameStore } from "@/stores/useGameStore";
import { getMoveMaxPP } from "@/game/rules";
import { MonsterName } from "@/components/MonsterName";

type Phase = "idle" | "creating" | "joining" | "waiting" | "fighting" | "finished";

export default function PvpModal({ onClose }: { onClose: () => void }) {
  const { slot } = useGameStore();
  const [phase, setPhase] = useState<Phase>("idle");
  const [room, setRoom] = useState<RoomView | null>(null);
  const [roomId, setRoomId] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [submitted, setSubmitted] = useState(false);

  const roomRef = useRef<RoomView | null>(null);
  roomRef.current = room;

  // 订阅 room.state 快照：只转发形状合法、revision 递增的快照。
  useEffect(() => {
    const onMsg = (e: Event) => {
      const m = (e as CustomEvent<RoomStateMessage>).detail;
      if (!m?.room) return;
      const cur = roomRef.current;
      if (cur && cur.roomId === m.room.roomId && m.room.revision <= cur.revision) return;
      setRoom(m.room);
      const pvp = pvpViewOf(m.room);
      if (m.room.status === "settled" || (pvp && pvp.finished)) setPhase("finished");
      else if (pvp) setPhase("fighting");
      else if (m.room.status === "active") setPhase("fighting");
      else setPhase("waiting");
      setSubmitted(false);
    };
    window.addEventListener(ROOM_STATE_EVENT, onMsg);
    return () => window.removeEventListener(ROOM_STATE_EVENT, onMsg);
  }, []);

  async function create() {
    setError(null);
    setBusy(true);
    try {
      const res = await api.pvpCreate({ slot });
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
      const res = await api.pvpJoin(roomId.trim(), { slot });
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

  const pvp = pvpViewOf(room);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-md max-h-[90vh] flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">玩家对战</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>

        <div className="border-b-2 border-[color:var(--stroke)] bg-[color:var(--danger)]/10 px-3 py-2 text-[10px] leading-4 text-[color:var(--muted)]">
          {PVP_DISCLAIMER}
        </div>

        {phase === "idle" && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <PixelButton tone="primary" onClick={create} className={busy ? "opacity-50 pointer-events-none" : ""}>
              {busy ? "创建中…" : "创建对战房间"}
            </PixelButton>
            <div className="flex items-center gap-2">
              <input
                type="text"
                placeholder="输入房间号加入"
                value={roomId}
                onChange={(e) => setRoomId(e.target.value)}
                className="flex-1 bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] p-2 text-sm text-[color:var(--text)] placeholder:text-[color:var(--muted)] outline-none focus:border-[color:var(--accent)]"
              />
              <PixelButton tone="muted" size="sm" onClick={join} className={busy ? "opacity-50 pointer-events-none" : ""}>
                加入
              </PixelButton>
            </div>
            <div className="text-[10px] text-[color:var(--muted)] leading-relaxed">
              创建房间后把房间号告诉朋友，对方输入房间号即可加入。双方都准备好后自动开局。
            </div>
          </div>
        )}

        {phase === "waiting" && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <div className="border-2 border-[color:var(--accent)] bg-[color:var(--panel2)] p-3 text-sm text-[color:var(--text)]">
              房间号：<span className="font-display font-bold">{room?.roomId}</span>
            </div>
            <div className="text-sm text-[color:var(--muted)]">等待对手加入…</div>
            <div className="text-[10px] text-[color:var(--muted)]">状态：{pvpStatusText(room)}</div>
          </div>
        )}

        {pvp && (phase === "fighting" || phase === "finished") && (
          <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-3">
            <div className="flex items-center justify-between text-xs text-[color:var(--muted)]">
              <span>回合 {pvp.turn}</span>
              <span>{pvpStatusText(room)}</span>
            </div>

            {/* 对方 active */}
            {(() => {
              const foe = pvp.foe.party[pvp.foe.activeIndex];
              return foe ? (
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
                  <div className="flex items-baseline justify-between">
                    <div className="text-sm font-semibold text-[color:var(--text)]">对手 · {foe.specId}</div>
                    <div className="text-xs text-[color:var(--muted)]">Lv.{foe.level}</div>
                  </div>
                  <div className="mt-2">
                    <StatBar label="HP" value={foe.hp} max={foe.maxHp} tone="enemy" />
                  </div>
                </div>
              ) : null;
            })()}

            {/* 我方 active */}
            {(() => {
              const self = pvp.self.party[pvp.self.activeIndex];
              if (!self) return null;
              const pp = pvp.self.ppByMonster[self.id] ?? {};
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
            <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 text-xs leading-relaxed text-[color:var(--muted)] max-h-[24vh] overflow-y-auto">
              {pvp.log.slice(-6).map((line, idx) => (
                <div key={idx} className={idx === pvp.log.slice(-6).length - 1 ? "text-[color:var(--text)] font-medium" : ""}>
                  {line}
                </div>
              ))}
              {pvp.log.length === 0 && <div className="italic">对战开始…</div>}
            </div>

            {/* 行动面板 */}
            {!pvp.finished ? (
              <div className="grid grid-cols-2 gap-2">
                {(() => {
                  const self = pvp.self.party[pvp.self.activeIndex];
                  if (!self) return null;
                  const pp = pvp.self.ppByMonster[self.id] ?? {};
                  return (
                    <>
                      {self.moveIds.map((id) => {
                        const cur = pp[id] ?? 0;
                        return (
                          <PixelButton
                            key={id}
                            disabled={submitted || cur <= 0}
                            onClick={() => void submit(`move:${id}`)}
                          >
                            <span>{MOVE_SPECS[id]?.name ?? id}</span>
                            <span className="ml-1 text-[10px] opacity-70">PP {cur}/{getMoveMaxPP(id)}</span>
                          </PixelButton>
                        );
                      })}
                      {pvp.self.party.map((m, idx) =>
                        m.hp > 0 && idx !== pvp.self.activeIndex ? (
                          <PixelButton
                            key={m.id}
                            tone="muted"
                            disabled={submitted}
                            onClick={() => void submit(`switch:${idx}`)}
                          >
                            换 <MonsterName m={m as any} />
                          </PixelButton>
                        ) : null,
                      )}
                      <PixelButton tone="muted" disabled={submitted} onClick={() => void submit("flee")}>
                        逃跑（认输）
                      </PixelButton>
                    </>
                  );
                })()}
              </div>
            ) : (
              <div className="text-center text-sm font-bold text-[color:var(--text)]">
                {pvp.winnerIsSelf ? "你获胜了！" : "对方获胜"}
              </div>
            )}

            {submitted && !pvp.finished && (
              <div className="text-center text-[10px] text-[color:var(--accent)] animate-pulse">已提交，等待对手…</div>
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
