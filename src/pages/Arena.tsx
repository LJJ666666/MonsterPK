import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PixelButton from "@/components/PixelButton";
import PixelCard from "@/components/PixelCard";
import StatBar from "@/components/StatBar";
import { ELEMENT_COLORS, ELEMENT_LABEL, ITEM_SPECS, MOVE_SPECS } from "@/game/data";
import type { ItemId } from "@/game/types";
import { useGameStore } from "@/stores/useGameStore";
import { requiredExpForNextLevel, getMoveMaxPP } from "@/game/rules";
import {
  useWildList, wildStatusText, SHARED_WILD_AREA_ID,
} from "@/lib/wild";
import { useStoryTriggers, fireGymClearBeat } from "@/lib/story";
import type { LocationId } from "@/game/types";

import TypeChartModal from "@/components/TypeChartModal";
import StoryModal from "@/components/StoryModal";
import { MonsterName } from "@/components/MonsterName";

function resultText(r: string | undefined) {
  if (r === "captured") return "捕获成功";
  if (r === "enemy_fainted") return "对手倒下";
  if (r === "fled") return "撤退成功";
  if (r === "player_fainted") return "队伍失去战斗力";
  return "";
}

export default function Arena({ onShowMechanics, onShowMoveChart }: { onShowMechanics?: () => void, onShowMoveChart?: () => void }) {
  const navigate = useNavigate();
  const { save, battle, useMove, useItem, switchTo, flee, leaveBattle, startEncounter, startBossBattle, resumeBattle } = useGameStore();
  // F18-b：胜馆主后跨页触发演武堂贺词（getGymClearBeat）；StoryModal 在本页就地渲染。
  const { activeBeat, dismiss, fire } = useStoryTriggers();
  const [panel, setPanel] = useState<"moves" | "items" | "switch">("moves");
  // 开局失败（断网 / 未登录 / 队伍全灭）要如实告知：现在没有本地降级，
  // 静默返回会让玩家以为按钮坏了。
  const [startError, setStartError] = useState<string | null>(null);
  // P4-1b：共享野怪列表在组件顶层订阅（Hook 规则），战斗中也保持最新，
  // 结算后回到营地/训练场能立刻看到「已被捕获」与补进来的新怪。
  const wildView = useWildList(SHARED_WILD_AREA_ID, "grass", 1, 5);

  // P3-1c：我方队伍以服务端下发的战斗副本为准——战斗内的 HP / 经验只存在于那份副本里，
  // 存档要等结算才更新。本地降级已删除（2026-11-07），`?? save?.party` 只是服务端
  // 漏发字段时的兜底，正常路径永远走 serverParty。
  const party = battle?.serverParty ?? save?.party ?? [];
  const active = battle ? party[battle.playerActiveIndex] ?? null : null;

  // 刷新 / 断线重连后取回服务端仍存活的战斗（战斗态不进存档）
  useEffect(() => {
    void resumeBattle();
  }, []);

  // F18-b：演武堂胜利（enemy_fainted）时触发对应城镇的贺词弹窗。
  // firedSession 去重保证同一会话内不会重复弹；逃跑 / 全灭不触发。
  useEffect(() => {
    if (battle?.finished && battle.result === "enemy_fainted" && battle.gymId) {
      fireGymClearBeat(battle.gymId as LocationId, fire);
    }
  }, [battle?.finished, battle?.result, battle?.gymId, fire]);

  const [playerHit, setPlayerHit] = useState(false);
  const [enemyHit, setEnemyHit] = useState(false);

  const [showTypeChart, setShowTypeChart] = useState(false);

  useEffect(() => {
    if (active && active.hp < (active as any)._prevHp) {
      setPlayerHit(true);
      setTimeout(() => setPlayerHit(false), 300);
    }
    if (active) (active as any)._prevHp = active.hp;
  }, [active?.hp]);

  useEffect(() => {
    if (battle && battle.enemy.hp < (battle.enemy as any)._prevHp) {
      setEnemyHit(true);
      setTimeout(() => setEnemyHit(false), 300);
    }
    if (battle) (battle.enemy as any)._prevHp = battle.enemy.hp;
  }, [battle?.enemy.hp]);

  const items = useMemo(() => {
    if (!save) return [];
    // 动态获取背包里所有有的道具，而不是固定写死几个
    return (Object.keys(save.inventory) as ItemId[])
      .map((id) => ({ id, qty: save.inventory[id] ?? 0, spec: ITEM_SPECS[id] }))
      .filter((x) => x.qty > 0 && (x.spec.kind === "capture" || x.spec.kind === "heal" || x.spec.kind === "status_heal"));
  }, [save]);

  // 提取最新的对战日志以精简显示。
  // 注意：这个 useMemo 必须放在下面的 early return 之前——否则「无战斗 → 有战斗」
  // 会让 Hook 数量从 N 变成 N+1，React 直接抛 "Rendered more hooks than during the previous render"。
  const latestLog = useMemo(() => (battle ? battle.log.slice(-4) : []), [battle?.log]);

  if (!save) {
    return (
      <div className="mx-auto flex min-h-screen max-w-4xl items-center justify-center px-5">
        <PixelCard title="未找到存档">
          <div className="space-y-3 text-sm text-[color:var(--muted)]">
            <div>请先创建或导入存档。</div>
            <PixelButton onClick={() => navigate("/")}>返回启动页</PixelButton>
          </div>
        </PixelCard>
      </div>);
  }

  if (!battle || !active) {
    return (
      <div className="mx-auto flex min-h-screen max-w-5xl items-center justify-center px-5">
        <PixelCard title="训练场">
          <div className="space-y-4 text-sm text-[color:var(--muted)]">
            <div>尚未开始遭遇。你可以从营地进入训练场，或在此快速开始一场草地遭遇。</div>
            {startError ? (
              <div className="border-2 border-[color:var(--danger)] px-3 py-2 text-xs text-[color:var(--danger)]">
                {startError}
              </div>
            ) : null}
            <div className="flex flex-wrap gap-2">
              <PixelButton
                onClick={async () => {
                  setStartError(null);
                  const res = await startEncounter("grass", "测试草地", 1, 5);
                  // strict:false 下判别联合不会自动收窄（bug_log §18），显式取
                  if (!res.ok) setStartError((res as { reason?: string }).reason ?? "无法开始战斗");
                }}
              >
                快速开始（草地）
              </PixelButton>
              <PixelButton tone="muted" onClick={() => navigate("/camp", { state: { returnToTown: true } })}>
                回程
              </PixelButton>
            </div>

            {/* P4-1b 共享野怪：所有客户端看到同一批实例，捕获互斥由服务端原子抢占保证。
                小卡片纵向排列，375px 不出现横向滚动。 */}
            <div className="border-t-2 border-[color:var(--stroke)] pt-3">
              <div className="mb-2 flex items-center justify-between gap-2 text-xs">
                <span className="font-display text-[color:var(--text)]">附近野怪（多人共享）</span>
                <button
                  type="button"
                  className="text-[color:var(--muted)] underline"
                  onClick={() => void wildView.refresh()}
                >
                  刷新
                </button>
              </div>
              {wildView.error ? (
                <div className="mb-2 border-2 border-[color:var(--danger)] px-2 py-1 text-[11px] text-[color:var(--danger)]">
                  {wildView.error}
                </div>
              ) : null}
              {wildView.loading && wildView.monsters.length === 0 ? (
                <div className="text-xs text-[color:var(--muted)]">正在读取野怪…</div>
              ) : null}
              <div className="space-y-2">
                {wildView.monsters.map((m) => (
                  <div
                    key={m.id}
                    className="flex items-center justify-between gap-2 border-2 border-[color:var(--stroke)] px-2 py-2 text-xs"
                  >
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-[color:var(--text)]">{m.label}</div>
                      <div className="text-[color:var(--muted)]">Lv.{m.level} · {wildStatusText(m)}</div>
                    </div>
                    <PixelButton
                      size="sm"
                      tone="muted"
                      disabled={m.status !== "available"}
                      onClick={async () => {
                        setStartError(null);
                        const res = await startEncounter(
                          "grass", "共享草地", 1, 5, SHARED_WILD_AREA_ID, m.id,
                        );
                        if (!res.ok) {
                          setStartError((res as { reason?: string }).reason ?? "无法开始战斗");
                          void wildView.refresh();
                        }
                      }}
                    >
                      挑战
                    </PixelButton>
                  </div>
                ))}
              </div>
              <div className="mt-2 text-[11px] leading-relaxed text-[color:var(--muted)]">
                所有玩家看到同一批野怪；被别人抢先时服务端会拒绝，列表自动刷新。
              </div>
            </div>
          </div>
        </PixelCard>
      </div>
    );
  }

  const activePP = battle.ppByMonster?.[active.id] ?? {};

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col bg-[color:var(--bg)] shadow-2xl sm:border-x-2 sm:border-[color:var(--stroke)]">
      {/* Header */}
      <div className="flex-none border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="font-display text-xl tracking-widest text-[color:var(--text)]">{battle.areaName}</div>
          <div className="flex items-center gap-3">
            <button className="text-xs text-[color:var(--muted)] underline" onClick={() => setShowTypeChart(true)}>
              属性表
            </button>
            {onShowMoveChart && (
              <button className="text-xs text-[color:var(--muted)] underline" onClick={onShowMoveChart}>
                技能表
              </button>
            )}
            {onShowMechanics && (
              <button className="text-xs text-[color:var(--muted)] underline" onClick={onShowMechanics}>
                机制表
              </button>
            )}
            <button className="text-xs text-[color:var(--muted)] underline" onClick={() => {
              leaveBattle();
              navigate("/camp", { state: { returnToTown: true } });
            }}>
              回程
            </button>
          </div>
        </div>
        <div className="mt-1 text-xs text-[color:var(--muted)]">
          回合 {battle.turn} · {battle.theme.toUpperCase()}
          {battle.bossId && (
            <span className="ml-2 text-[color:var(--accent)]">
              讨伐 · 本场伤害 {battle.damageDealt ?? 0}
            </span>
          )}
          {battle.serverId ? (
            <span className="ml-2 text-[color:var(--accent)]">服务端裁决</span>
          ) : (
            <span className="ml-2 text-amber-500">本地模式（结果需服务端确认）</span>
          )}
          {battle.pending && <span className="ml-2 animate-pulse text-[color:var(--accent)]">处理中…</span>}
        </div>
      </div>

      {showTypeChart && <TypeChartModal onClose={() => setShowTypeChart(false)} />}

      {/* Main Content */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col gap-4">
        {/* Battle Stage */}
        <div className="grid gap-3">
          <div className={`border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 relative overflow-hidden transition-all duration-200 ${enemyHit ? "bg-red-500/20 translate-x-1" : ""}`}>
            <div className="flex items-baseline justify-between">
              <div className="text-sm font-semibold text-[color:var(--text)]"><MonsterName m={battle.enemy} /></div>
              <div className="text-xs text-[color:var(--muted)]">
                Lv.{battle.enemy.level} · <span className={ELEMENT_COLORS[battle.enemy.element]}>{ELEMENT_LABEL[battle.enemy.element]}</span>
              </div>
            </div>
            <div className="mt-2">
              <StatBar label="HP" value={battle.enemy.hp} max={battle.enemy.maxHp} tone="enemy" />
            </div>
            <div className="mt-2 text-xs text-[color:var(--muted)]">状态：{battle.enemy.status === "none" ? "正常" : battle.enemy.status}</div>
          </div>

          <div className={`border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 relative overflow-hidden transition-all duration-200 ${playerHit ? "bg-red-500/20 -translate-x-1" : ""}`}>
            <div className="flex items-baseline justify-between">
              <div className="text-sm font-semibold text-[color:var(--text)]"><MonsterName m={active} /></div>
              <div className="text-xs text-[color:var(--muted)]">
                Lv.{active.level} · <span className={ELEMENT_COLORS[active.element]}>{ELEMENT_LABEL[active.element]}</span>
              </div>
            </div>
            <div className="mt-2 grid gap-2">
              <StatBar label="HP" value={active.hp} max={active.maxHp} />
              <StatBar label="EXP" value={active.exp} max={requiredExpForNextLevel(active.level)} tone="exp" size="sm" className="-mt-1" />
            </div>
            <div className="mt-2 text-xs text-[color:var(--muted)]">状态：{active.status === "none" ? "正常" : active.status}</div>
          </div>
        </div>

        {/* Current Round Log (Replaces Full Log List) */}
        <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 text-sm leading-relaxed text-[color:var(--muted)] min-h-[5rem] flex flex-col justify-center">
          {latestLog.length > 0 ? (
            latestLog.map((line, idx) => {
              const isEff = line.includes("拔群") || line.includes("克制");
              const isResist = line.includes("不太理想");
              return (
                <div 
                  key={idx} 
                  className={
                    idx === latestLog.length - 1 
                      ? "font-medium " + (isEff ? "text-amber-400" : isResist ? "text-slate-500" : "text-[color:var(--text)]")
                      : (isEff ? "text-amber-400/80" : isResist ? "text-slate-500/80" : "")
                  }
                >
                  {line}
                </div>
              );
            })
          ) : (
            <div className="italic">等待指令...</div>
          )}
        </div>

        {/* Action Panel - Pushed to Bottom */}
        <div className="mt-auto">
          <PixelCard title={battle.finished ? "结束: " + resultText(battle.result) : "选择行动"}>
            {!battle.finished ? (
              <>
                <div className="mb-3 flex flex-wrap gap-2">
                  <PixelButton tone={panel === "moves" ? "primary" : "muted"} size="sm" onClick={() => setPanel("moves")}>
                    技能
                  </PixelButton>
                  <PixelButton tone={panel === "items" ? "primary" : "muted"} size="sm" onClick={() => setPanel("items")}>
                    道具
                  </PixelButton>
                  <PixelButton tone={panel === "switch" ? "primary" : "muted"} size="sm" onClick={() => setPanel("switch")}>
                    换位
                  </PixelButton>
                  <PixelButton tone="muted" size="sm" onClick={() => flee()} disabled={battle.pending}>
                    逃跑
                  </PixelButton>
                </div>

                {panel === "moves" && (
                  <div className="grid grid-cols-2 gap-2">
                    {active.moveIds.map((id) => {
                      const maxPP = getMoveMaxPP(id);
                      const curPP = activePP[id] ?? 0;
                      return (
                        <PixelButton
                          key={id}
                          onClick={() => useMove(id)}
                          disabled={battle.finished || battle.pending || active.hp <= 0 || curPP <= 0}
                        >
                          <div className="flex flex-col items-center py-1">
                            <span className={ELEMENT_COLORS[MOVE_SPECS[id].element]}>{MOVE_SPECS[id].name}</span>
                            <span className="mt-1 text-[10px] opacity-70">
                              威力 {MOVE_SPECS[id].power} · {Math.round(MOVE_SPECS[id].accuracy * 100)}%
                            </span>
                            <span className={`mt-0.5 text-[10px] ${curPP <= 1 ? "text-red-400" : "opacity-70"}`}>
                              PP {curPP}/{maxPP}
                            </span>
                          </div>
                        </PixelButton>
                      );
                    })}
                  </div>
                )}

                {panel === "items" && (
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((x) => (
                      <PixelButton
                        key={x.id}
                        tone={x.spec.kind === "capture" ? "primary" : "muted"}
                        disabled={battle.finished || battle.pending || x.qty <= 0}
                        onClick={() => useItem(x.id)}
                      >
                        {x.spec.name} <span className="ml-1 text-xs opacity-70">x{x.qty}</span>
                      </PixelButton>
                    ))}
                  </div>
                )}

                {panel === "switch" && (
                  <div className="grid grid-cols-2 gap-2">
                    {party.map((m, idx) => (
                      <PixelButton
                        key={m.id}
                        tone={idx === battle.playerActiveIndex ? "muted" : "primary"}
                        disabled={battle.finished || battle.pending || m.hp <= 0 || idx === battle.playerActiveIndex}
                        onClick={() => switchTo(idx)}
                      >
                        <div className="flex flex-col items-center">
                          <MonsterName m={m} />
                          <span className="mt-1 text-[10px] opacity-70">HP {m.hp}/{m.maxHp}</span>
                        </div>
                      </PixelButton>
                    ))}
                  </div>
                )}
              </>
            ) : (
              <div className="flex flex-col gap-2">
                <div className="text-sm font-medium mb-2 text-center text-[color:var(--text)]">{resultText(battle.result)}</div>
                
                {battle.result === "player_fainted" ? (
                  <PixelButton
                    tone="danger"
                    onClick={() => {
                      leaveBattle();
                      navigate("/camp");
                    }}
                  >
                    返回恢复中心
                  </PixelButton>
                ) : (
                  <>
                    <PixelButton
                      tone="muted"
                      onClick={() => {
                        leaveBattle();
                        navigate('/camp', { state: { returnToTown: true } });
                      }}
                    >
                      回程
                    </PixelButton>
                    <PixelButton
                      tone="primary"
                      onClick={async () => {
                        setStartError(null);
                        // 讨伐战要回到同一条 Boss 链路：用普通开局会把 Boss 名当成区域名，
                        // 结果变成一场野生遭遇（theme 也还是 Boss 的主题）。
                        const res = battle.bossId
                          ? await startBossBattle(battle.bossId)
                          : await startEncounter(battle.theme, battle.areaName, battle.levelMin, battle.levelMax, battle.areaId);
                        if (res.ok) setPanel("moves");
                        else setStartError((res as { reason?: string }).reason ?? "无法开始战斗");
                      }}
                    >
                      {battle.bossId ? "再次讨伐" : "继续探索"}
                    </PixelButton>
                    {startError ? (
                      <div className="w-full text-xs text-[color:var(--danger)]">{startError}</div>
                    ) : null}
                  </>
                )}
              </div>
            )}
          </PixelCard>
        </div>
      </div>
      {activeBeat && <StoryModal beat={activeBeat} onClose={dismiss} />}
    </div>
  );
}

