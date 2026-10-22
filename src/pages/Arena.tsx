import { useMemo, useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import PixelButton from "@/components/PixelButton";
import PixelCard from "@/components/PixelCard";
import StatBar from "@/components/StatBar";
import { ELEMENT_COLORS, ELEMENT_LABEL, ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS } from "@/game/data";
import type { ItemId, Element } from "@/game/types";
import { useGameStore } from "@/stores/useGameStore";
import { requiredExpForNextLevel } from "@/game/rules";

import TypeChartModal from "@/components/TypeChartModal";
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
  const { slot, save1, save2, save3, battle, useMove, useItem, switchTo, flee, leaveBattle, startEncounter } = useGameStore();
  const [panel, setPanel] = useState<"moves" | "items" | "switch">("moves");

  const saves = [save1, save2, save3];
  const save = saves[slot - 1];

  const party = save?.party ?? [];
  const active = battle && save ? party[battle.playerActiveIndex] : null;

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
            <div className="flex flex-wrap gap-2">
              <PixelButton
                onClick={() => {
                  const res = startEncounter("grass", "测试草地", 1, 5);
                  if (!res.ok) return;
                }}
              >
                快速开始（草地）
              </PixelButton>
              <PixelButton tone="muted" onClick={() => navigate("/camp", { state: { returnToTown: true } })}>
                回程
              </PixelButton>
            </div>
          </div>
        </PixelCard>
      </div>
    );
  }

  const enemySpec = MONSTER_SPECS[battle.enemy.specId];
  const playerSpec = MONSTER_SPECS[active.specId];

  // 提取最新的对战日志以精简显示
  const latestLog = useMemo(() => {
    if (!battle) return [];
    // 返回最后4条日志（通常是一个回合的交互结果）
    return battle.log.slice(-4);
  }, [battle?.log]);

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
                  <PixelButton tone="muted" size="sm" onClick={() => flee()}>
                    逃跑
                  </PixelButton>
                </div>

                {panel === "moves" && (
                  <div className="grid grid-cols-2 gap-2">
                    {active.moveIds.map((id) => (
                      <PixelButton key={id} onClick={() => useMove(id)} disabled={battle.finished || active.hp <= 0}>
                        <div className="flex flex-col items-center py-1">
                          <span className={ELEMENT_COLORS[MOVE_SPECS[id].element]}>{MOVE_SPECS[id].name}</span>
                          <span className="mt-1 text-[10px] opacity-70">
                            威力 {MOVE_SPECS[id].power} · {Math.round(MOVE_SPECS[id].accuracy * 100)}%
                          </span>
                        </div>
                      </PixelButton>
                    ))}
                  </div>
                )}

                {panel === "items" && (
                  <div className="grid grid-cols-2 gap-2">
                    {items.map((x) => (
                      <PixelButton
                        key={x.id}
                        tone={x.spec.kind === "capture" ? "primary" : "muted"}
                        disabled={battle.finished || x.qty <= 0}
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
                        disabled={battle.finished || m.hp <= 0 || idx === battle.playerActiveIndex}
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
                      onClick={() => {
                        const res = startEncounter(battle.theme, battle.areaName, battle.levelMin, battle.levelMax);
                        if (res.ok) setPanel("moves");
                      }}
                    >
                      继续探索
                    </PixelButton>
                  </>
                )}
              </div>
            )}
          </PixelCard>
        </div>
      </div>
    </div>
  );
}

