import { useMemo, useState, useEffect } from "react";
import { useNavigate, useLocation } from "react-router-dom";
import PixelButton from "@/components/PixelButton";
import PixelCard from "@/components/PixelCard";
import StatBar from "@/components/StatBar";
import { ELEMENT_LABEL, ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS, LOCATIONS, THEME_TABLE } from "@/game/data";
import type { EncounterTheme, ItemId, LocationId, StatBlock, MonsterInstance } from "@/game/types";
import { useGameStore } from "@/stores/useGameStore";
import { getMonsterStatBounds, requiredExpForNextLevel } from "@/game/rules";

import TypeChartModal from "@/components/TypeChartModal";

import { MonsterName } from "@/components/MonsterName";

function getMonsterSupremeState(m: MonsterInstance) {
  const bounds = getMonsterStatBounds(m.specId);
  const checkMaxInit = (stat: keyof StatBlock) => m.initStats?.[stat] >= bounds.initMax[stat];
  const checkMaxGrowth = (stat: keyof StatBlock) => m.growthRates?.[stat] >= bounds.gMax[stat];
  const allInitMax = ["hp", "atk", "def", "spAtk", "spDef", "spd"].every(s => checkMaxInit(s as keyof StatBlock));
  const allGrowthMax = ["hp", "atk", "def", "spAtk", "spDef", "spd"].every(s => checkMaxGrowth(s as keyof StatBlock));
  const isSupreme = m.isShiny && allInitMax && allGrowthMax;
  
  return { allInitMax, allGrowthMax, isSupreme, bounds };
}

function MonsterDetailStats({ m }: { m: MonsterInstance }) {
  const { allInitMax, allGrowthMax, bounds } = getMonsterSupremeState(m);

  const checkMaxInit = (stat: keyof StatBlock) => m.initStats?.[stat] >= bounds.initMax[stat];
  const checkMaxGrowth = (stat: keyof StatBlock) => m.growthRates?.[stat] >= bounds.gMax[stat];

  const getInitClasses = (stat: keyof StatBlock) => {
    if (checkMaxInit(stat)) {
      return "border-[color:var(--danger)] text-[color:var(--danger)] shadow-[0_0_8px_rgba(239,68,68,0.5)]";
    }
    return "border-[color:var(--stroke)]";
  };

  const getGrowthClasses = (stat: keyof StatBlock) => {
    if (checkMaxGrowth(stat)) {
      return "border-[color:var(--danger)] text-[color:var(--danger)] shadow-[0_0_8px_rgba(239,68,68,0.5)]";
    }
    return "border-[color:var(--stroke)]";
  };

  const initContainerClasses = "grid grid-cols-6 gap-1 text-[9px] " + (allInitMax && !allGrowthMax ? "ring-2 ring-yellow-400 ring-offset-2 ring-offset-[color:var(--bg)]" : "");
  const growthContainerClasses = "grid grid-cols-6 gap-1 text-[9px] " + (allGrowthMax && !allInitMax ? "ring-2 ring-yellow-400 ring-offset-2 ring-offset-[color:var(--bg)]" : "");

  return (
    <div className="space-y-4">
      <div>
        <div className="text-xs text-[color:var(--muted)] mb-2 flex justify-between">
          <span>初始基础值 (Lv.1)</span>
          {allInitMax && !allGrowthMax && <span className="text-yellow-400 font-bold">初始全满!</span>}
        </div>
          <div className={initContainerClasses}>
            {([
              { key: "hp", label: "HP" },
              { key: "atk", label: "物攻" },
              { key: "def", label: "物防" },
              { key: "spAtk", label: "特攻" },
              { key: "spDef", label: "特防" },
              { key: "spd", label: "速度" },
            ] as const).map(({ key, label }) => (
              <div key={key} className={`border bg-[color:var(--bg)] py-1 flex flex-col items-center ${getInitClasses(key)}`}>
                <span className="opacity-80 text-[color:var(--muted)]">{label}</span>
                <span className="mt-0.5 font-semibold text-current">{m.initStats?.[key] ?? "?"}</span>
              </div>
            ))}
          </div>
        </div>
        <div>
          <div className="text-xs text-[color:var(--muted)] mb-2 flex justify-between">
            <span>成长潜能</span>
            {allGrowthMax && !allInitMax && <span className="text-yellow-400 font-bold">成长全满!</span>}
          </div>
          <div className={growthContainerClasses}>
            {([
              { key: "hp", label: "HP" },
              { key: "atk", label: "物攻" },
              { key: "def", label: "物防" },
              { key: "spAtk", label: "特攻" },
              { key: "spDef", label: "特防" },
              { key: "spd", label: "速度" },
            ] as const).map(({ key, label }) => (
              <div key={key} className={`border bg-[color:var(--bg)] py-1 flex flex-col items-center ${getGrowthClasses(key)}`}>
                <span className="opacity-80 text-[color:var(--muted)]">{label}</span>
                <span className="mt-0.5 font-semibold text-current">+{m.growthRates?.[key] ?? "?"}</span>
              </div>
            ))}
          </div>
        </div>
     </div>
   );
 }

function TestMenuModal({ onClose }: { onClose: () => void }) {
  const { testOHKO, testMaxStats, testShiny, toggleTestOHKO, toggleTestMaxStats, toggleTestShiny, addGold, addMasterBalls } = useGameStore();

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] w-full max-w-sm flex flex-col shadow-2xl">
        <div className="flex items-center justify-between p-3 border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
          <div className="font-bold text-[color:var(--text)]">测试功能</div>
          <button onClick={onClose} className="text-2xl leading-none text-[color:var(--muted)] hover:text-[color:var(--text)]">&times;</button>
        </div>
        <div className="p-4 flex flex-col gap-3">
          <PixelButton onClick={() => { addGold(999999); onClose(); }}>满金币 (+999999)</PixelButton>
          <PixelButton onClick={() => { addMasterBalls(99); onClose(); }}>大师球 99个</PixelButton>
          <PixelButton tone={testOHKO ? "danger" : "primary"} onClick={toggleTestOHKO}>
            秒杀开关 {testOHKO ? "[ON]" : "[OFF]"}
          </PixelButton>
          <PixelButton tone={testMaxStats ? "danger" : "primary"} onClick={toggleTestMaxStats}>
            捕抓必全满开关 {testMaxStats ? "[ON]" : "[OFF]"}
          </PixelButton>
          <PixelButton tone={testShiny ? "danger" : "primary"} onClick={toggleTestShiny}>
            捕抓必异色开关 {testShiny ? "[ON]" : "[OFF]"}
          </PixelButton>
        </div>
      </div>
    </div>
  );
}

import { Info } from "lucide-react";

export default function Camp({ onShowMechanics, onShowMoveChart }: { onShowMechanics?: () => void, onShowMoveChart?: () => void }) {
  const navigate = useNavigate();
  const location = useLocation();
  const { slot, save1, save2, save3, startEncounter, healAll, useItemOutsideBattle, buyItem, travelTo } = useGameStore();
  const [tab, setTab] = useState<"party" | "bag" | "map" | "dex" | "box">("map");
  const [selected, setSelected] = useState<number | null>(null);
  const [boxSelected, setBoxSelected] = useState<number | null>(null);
  const [shopOpen, setShopOpen] = useState(false);
  const [mapView, setMapView] = useState<"list" | "detail">("list");
  
  const [dialog, setDialog] = useState<{ name: string; text: string } | null>(null);
  const [bagFilter, setBagFilter] = useState<"all" | "heal" | "item" | "skill" | "quest">("all");
  const [showTypeChart, setShowTypeChart] = useState(false);
  const [showTestMenu, setShowTestMenu] = useState(false);
  const [dexSelectedSpecId, setDexSelectedSpecId] = useState<string | null>(null);
  const [dexSearchQuery, setDexSearchQuery] = useState("");

  const maxPlayerLevel = useMemo(() => {
    const s = useGameStore.getState()[`save${slot}` as keyof ReturnType<typeof useGameStore.getState>] as any;
    if (!s || !s.party || s.party.length === 0) return 1;
    return Math.max(...s.party.map((m: any) => m.level));
  }, [slot]);
  
  useEffect(() => {
    if (location.state?.returnToTown) {
      setTab("map");
      setMapView("detail");
    }
  }, [location.state]);

  const saves = [save1, save2, save3];
  const save = saves[slot - 1];

  const party = save?.party ?? [];
  const box = save?.box ?? [];
  const currentLocation = save ? LOCATIONS[save.locationId] : null;
  const visitedLocationIds = save?.visitedLocationIds ?? [];

  const invEntries = useMemo(() => {
    if (!save) return [];
    return (Object.keys(save.inventory) as ItemId[])
      .map((id) => ({
        id,
        qty: save.inventory[id] ?? 0,
        spec: ITEM_SPECS[id],
      }))
      .filter((x) => x.qty > 0);
  }, [save]);

  if (!save || !currentLocation) {
    return (
      <div className="mx-auto flex min-h-[100dvh] max-w-md items-center justify-center px-5">
        <PixelCard title="未找到存档">
          <div className="space-y-3 text-sm text-[color:var(--muted)]">
            <div>请先在启动页创建或导入存档。</div>
            <PixelButton onClick={() => navigate("/")}>返回启动页</PixelButton>
          </div>
        </PixelCard>
      </div>
    );
  }

  const renderParty = () => {
    if (selected !== null && party[selected]) {
      const m = party[selected];
      const { allInitMax, allGrowthMax, isSupreme } = getMonsterSupremeState(m);
      
      const cardClassName = isSupreme
        ? "theme-supreme-stats !bg-[color:var(--panel)] bg-blend-overlay"
        : (allInitMax && allGrowthMax)
          ? "theme-max-stats !bg-[color:var(--panel)] bg-blend-overlay"
          : "";

      return (
        <PixelCard 
          title="伙伴详情" 
          className={cardClassName}
          right={
            <button className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setSelected(null)}>
              返回列表
            </button>
          }
        >
          <div className="grid gap-4">
            <div>
              <MonsterName m={m} className="text-lg font-semibold text-[color:var(--text)]" />
              <div className="mt-1 text-sm text-[color:var(--muted)]">Lv.{m.level} · 属性：{ELEMENT_LABEL[m.element]}</div>
              <div className="mt-4 grid gap-3">
                <StatBar label="HP" value={m.hp} max={m.maxHp} />
                <StatBar label="EXP" value={m.exp} max={requiredExpForNextLevel(m.level)} tone="exp" size="sm" className="-mt-2" />
                <div className="grid grid-cols-5 gap-1 text-[10px] text-[color:var(--muted)]">
                  <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-1 text-center">
                    <div className="opacity-80">物攻</div>
                    <div className="mt-0.5 font-semibold text-[color:var(--text)]">{m.atk}</div>
                  </div>
                  <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-1 text-center">
                    <div className="opacity-80">物防</div>
                    <div className="mt-0.5 font-semibold text-[color:var(--text)]">{m.def}</div>
                  </div>
                  <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-1 text-center">
                    <div className="opacity-80">特攻</div>
                    <div className="mt-0.5 font-semibold text-[color:var(--text)]">{m.spAtk}</div>
                  </div>
                  <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-1 text-center">
                    <div className="opacity-80">特防</div>
                    <div className="mt-0.5 font-semibold text-[color:var(--text)]">{m.spDef}</div>
                  </div>
                  <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-1 text-center">
                    <div className="opacity-80">速度</div>
                    <div className="mt-0.5 font-semibold text-[color:var(--text)]">{m.spd}</div>
                  </div>
                </div>
              </div>
            </div>
            
            <MonsterDetailStats m={m} />
            
            <div>
              <div className="text-xs text-[color:var(--muted)] mb-2">技能</div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                {m.moveIds.map((id, index) => (
                  <div key={`${id}-${index}`} className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                    <div className="text-sm font-semibold text-[color:var(--text)]">{MOVE_SPECS[id].name}</div>
                    <div className="mt-1 text-[10px] text-[color:var(--muted)]">
                      威力 {MOVE_SPECS[id].power} · 命中 {Math.round(MOVE_SPECS[id].accuracy * 100)}%
                    </div>
                    {MOVE_SPECS[id].desc && (
                      <div className="mt-1.5 text-xs text-[color:var(--text)] opacity-80 leading-relaxed">
                        {MOVE_SPECS[id].desc}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <PixelButton
                tone="muted"
                disabled={save.party.length <= 1}
                onClick={() => {
                  useGameStore.getState().movePartyToBox(selected);
                  setSelected(null);
                }}
              >
                存入电脑
              </PixelButton>
              <PixelButton
                tone="danger"
                disabled={save.party.length <= 1}
                onClick={() => {
                  if (confirm(`确定要放生 ${m.nickname || MONSTER_SPECS[m.specId].name} 吗？这无法撤销！`)) {
                    useGameStore.getState().releaseMonster(m.id);
                    setSelected(null);
                  }
                }}
              >
                放生
              </PixelButton>
            </div>
          </div>
        </PixelCard>
      );
    }

    return (
      <PixelCard title="队伍">
        <div className="grid gap-2">
          {party.map((m, idx) => {
            const { isSupreme, allInitMax, allGrowthMax } = getMonsterSupremeState(m);
            const btnClassName = isSupreme
              ? "theme-supreme-stats !bg-[color:var(--panel)] bg-blend-overlay"
              : (allInitMax && allGrowthMax)
                ? "theme-max-stats !bg-[color:var(--panel)] bg-blend-overlay"
                : "border-[color:var(--stroke)] bg-[color:var(--bg2)] active:bg-[color:var(--panel2)]";
            
            return (
              <button
                key={m.id}
                onClick={() => setSelected(idx)}
                className={`flex items-center justify-between border-2 px-3 py-3 text-left ${btnClassName}`}
              >
                <div>
                  <MonsterName m={m} className="text-sm font-semibold text-[color:var(--text)]" />
                  <div className="text-xs text-[color:var(--muted)]">
                    Lv.{m.level} · {ELEMENT_LABEL[m.element]}
                  </div>
                </div>
                <div className="w-32 sm:w-40 grid gap-1">
                  <StatBar label="HP" value={m.hp} max={m.maxHp} className="mb-0" />
                  <StatBar label="EXP" value={m.exp} max={requiredExpForNextLevel(m.level)} tone="exp" size="sm" className="mb-0" />
                </div>
              </button>
            );
          })}
          {party.length === 0 && <div className="text-sm text-[color:var(--muted)]">队伍为空。</div>}
        </div>
      </PixelCard>
    );
  };

  const renderBag = () => {
    const healableParty = party.map((m, idx) => ({ m, idx })).filter(({ m }) => m.hp < m.maxHp);
    const filteredInv = invEntries.filter((x) => {
      if (bagFilter === "all") return true;
      if (bagFilter === "heal") return x.spec.kind === "heal";
      if (bagFilter === "item") return x.spec.kind === "capture";
      return false;
    });

    return (
      <PixelCard 
        title="背包"
        right={
          <div className="flex gap-2 text-xs">
            {[
              { id: "all", label: "全部" },
              { id: "heal", label: "药物" },
              { id: "item", label: "道具" },
              { id: "skill", label: "技能" },
              { id: "quest", label: "任务" },
            ].map((f) => (
              <button
                key={f.id}
                onClick={() => setBagFilter(f.id as any)}
                className={bagFilter === f.id ? "text-[color:var(--accent)] font-bold" : "text-[color:var(--muted)] hover:text-[color:var(--text)]"}
              >
                {f.label}
              </button>
            ))}
          </div>
        }
      >
        <div className="grid gap-2">
          {filteredInv.map((x) => (
            <div key={x.id} className="flex flex-col border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
              <div className="flex flex-col justify-center">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-semibold text-[color:var(--text)]">{x.spec.name}</div>
                  <div className="text-sm text-[color:var(--muted)]">x{x.qty}</div>
                </div>
                <div className="mt-1 text-xs text-[color:var(--muted)]">
                  {x.spec.kind === "capture" ? `捕获修正 ×${x.spec.modifier}` 
                   : x.spec.kind === "heal" ? `回复 ${x.spec.heal} HP`
                   : x.spec.kind === "status_heal" ? `解除状态异常`
                   : x.spec.kind === "evolution" ? `进化用`
                   : `特殊道具`}
                </div>
              </div>
              {x.spec.kind === "heal" && healableParty.length > 0 && (
                <div className="mt-3 flex gap-2 overflow-x-auto pb-1">
                  {healableParty.map(({ m, idx }) => (
                    <button
                      key={m.id}
                      onClick={() => useItemOutsideBattle(x.id as ItemId, idx)}
                      className="shrink-0 whitespace-nowrap border-2 border-[color:var(--accent)] bg-[color:var(--panel2)] px-2 py-1 text-[10px] text-[color:var(--text)]"
                    >
                      对 <MonsterName m={m} /> 使用
                    </button>
                  ))}
                </div>
              )}
            </div>
          ))}
          {filteredInv.length === 0 && <div className="text-sm text-[color:var(--muted)]">当前分类下没有物品。</div>}
        </div>
      </PixelCard>
    );
  };

  const renderMap = () => {
    if (mapView === "list") {
      return (
        <PixelCard title="地区列表">
          <div className="grid gap-2">
            {(Object.values(LOCATIONS) as typeof LOCATIONS[LocationId][]).map((loc) => (
              <button
                key={loc.id}
                onClick={() => {
                  travelTo(loc.id);
                  setMapView("detail");
                }}
                className={`border-2 p-3 text-left flex justify-between items-center ${loc.id === currentLocation.id ? "border-[color:var(--accent)] bg-[color:var(--panel2)]" : "border-[color:var(--stroke)] bg-[color:var(--bg2)]"}`}
              >
                <div>
                  <div className="text-sm font-semibold text-[color:var(--text)]">{loc.name} {loc.id === currentLocation.id && "(当前)"}</div>
                  <div className="mt-1 text-[10px] text-[color:var(--muted)]">{loc.desc}</div>
                </div>
                <div className="text-xs text-[color:var(--accent)]">进入</div>
              </button>
            ))}
          </div>
        </PixelCard>
      );
    }

    if (shopOpen) {
      const shopItems = currentLocation?.shop ?? [];
      return (
        <PixelCard
          title={`${currentLocation?.name} 友好商店`}
          right={
            <button className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setShopOpen(false)}>
              离开
            </button>
          }
        >
          <div className="mb-4 flex items-center justify-between border-b-2 border-[color:var(--stroke)] pb-2 text-sm font-semibold text-[color:var(--text)]">
            <span>拥有金钱</span>
            <span className="text-[color:var(--accent)]">¥{save.money}</span>
          </div>
          <div className="grid gap-2">
            {shopItems.map((itemId) => {
              const item = ITEM_SPECS[itemId];
              return (
                <div key={item.id} className="flex flex-col border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3">
                  <div className="flex items-center justify-between">
                    <div className="text-sm font-semibold text-[color:var(--text)]">{item.name}</div>
                    <div className="text-xs font-semibold text-[color:var(--accent)]">¥{item.price}</div>
                  </div>
                  <div className="mt-1 text-[10px] text-[color:var(--muted)] leading-relaxed">
                    {item.desc}
                  </div>
                  <div className="mt-3">
                    <PixelButton
                      size="sm"
                      disabled={save.money < (item.price ?? 99999)}
                      onClick={() => buyItem(item.id, 1)}
                    >
                      购买 1 个
                    </PixelButton>
                  </div>
                </div>
              );
            })}
            {shopItems.length === 0 && (
              <div className="text-sm text-[color:var(--muted)] p-4 text-center">这里没有出售任何物品。</div>
            )}
          </div>
        </PixelCard>
      );
    }

    if (dialog) {
      return (
        <div className="mt-auto">
          <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-4">
            <div className="text-sm font-semibold text-[color:var(--accent)] mb-2">{dialog.name}</div>
            <div className="text-sm text-[color:var(--text)] leading-relaxed">{dialog.text}</div>
            <div className="mt-4 text-right">
              <PixelButton size="sm" onClick={() => setDialog(null)}>继续</PixelButton>
            </div>
          </div>
        </div>
      );
    }

    return (
      <PixelCard title={currentLocation.name} right={<button className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setMapView("list")}>返回列表</button>}>
        <div className="text-sm text-[color:var(--muted)] mb-6">{currentLocation.desc}</div>
        
        <div className="grid gap-3">
          {currentLocation.hasCenter && (
            <PixelButton tone="primary" onClick={() => {
              healAll();
              setDialog({ name: "护士", text: "欢迎来到恢复中心！你的伙伴们已经完全恢复了活力。" });
            }}>
              恢复中心 (免费治疗)
            </PixelButton>
          )}

          {currentLocation.hasShop && (
            <PixelButton onClick={() => setShopOpen(true)}>
              友好商店
            </PixelButton>
          )}

          {currentLocation.npcs?.map((npc) => (
            <PixelButton key={npc.id} tone="muted" onClick={() => {
              const text = npc.dialog[Math.floor(Math.random() * npc.dialog.length)];
              setDialog({ name: npc.name, text });
            }}>
              与 {npc.name} 交谈
            </PixelButton>
          ))}

          {currentLocation.wildAreas && currentLocation.wildAreas.length > 0 && (
            <div className="mt-4 pt-4 border-t-2 border-[color:var(--stroke)]">
              <div className="text-xs text-[color:var(--muted)] mb-3">野外点</div>
              <div className="grid grid-cols-2 gap-2">
                {currentLocation.wildAreas.map((wa) => {
                  const diff = wa.levelMax - maxPlayerLevel;
                  let dangerColor = "#ffffff";
                  let textColor = "var(--text)";
                  if (diff > 20) {
                    dangerColor = "#991b1b"; // red-800
                    textColor = "#ef4444"; // red-500
                  } else if (diff > 10) {
                    dangerColor = "#dc2626"; // red-600
                    textColor = "#f87171"; // red-400
                  } else if (diff > 5) {
                    dangerColor = "#eab308"; // yellow-500
                    textColor = "#facc15"; // yellow-400
                  }

                  return (
                    <PixelButton
                      key={wa.id}
                      tone="danger"
                      className="!border-[color:var(--danger-border)] !text-[color:var(--danger-text)] text-xs h-10 flex items-center justify-center"
                      style={{ "--danger-border": dangerColor, "--danger-text": textColor } as any}
                      onClick={() => {
                        const res = startEncounter(wa.encounters[0], wa.name, wa.levelMin, wa.levelMax);
                        if (res.ok) {
                          navigate("/arena");
                        }
                      }}
                    >
                      {wa.name}
                  <span className="ml-1 opacity-50">Lv{wa.levelMin}-{wa.levelMax}</span>
                    </PixelButton>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      </PixelCard>
    );
  };

  const renderDex = () => {
    const calcInitAtLevel1 = (specId: string): StatBlock => {
      const spec = MONSTER_SPECS[specId];
      return {
        hp: Math.floor(spec.baseHp + 1 * 3.2),
        atk: Math.floor(spec.baseAtk + 1 * 2.3),
        def: Math.floor(spec.baseDef + 1 * 2.0),
        spAtk: Math.floor(spec.baseSpAtk + 1 * 2.3),
        spDef: Math.floor(spec.baseSpDef + 1 * 2.0),
        spd: Math.floor(spec.baseSpd + 1 * 2.0),
      };
    };

    const calcDefaultGrowth = (specId: string) => {
      const spec = MONSTER_SPECS[specId];
      const min: StatBlock = { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 };
      const max: StatBlock = {
        hp: 4,
        atk: spec.baseAtk >= 70 ? 3 : 2,
        def: spec.baseDef >= 80 ? 4 : 2,
        spAtk: spec.baseSpAtk >= 70 ? 3 : 2,
        spDef: spec.baseSpDef >= 80 ? 4 : 2,
        spd: spec.baseSpd >= 60 ? 3 : 2,
      };
      return { min, max };
    };

    const calcCaptureLocations = (specId: string) => {
      const themes = (Object.entries(THEME_TABLE) as Array<[EncounterTheme, string[]]>)
        .filter(([, ids]) => ids.includes(specId))
        .map(([t]) => t);
      const locs = (Object.values(LOCATIONS) as typeof LOCATIONS[LocationId][])
        .filter((loc) => (loc.wildAreas ?? []).some((wa) => wa.encounters.some((t) => themes.includes(t))))
        .map((loc) => loc.id);
      return Array.from(new Set(locs));
    };

    if (dexSelectedSpecId) {
      const spec = MONSTER_SPECS[dexSelectedSpecId];
      const entry = save.collection[dexSelectedSpecId];
      const initMax = spec.initStatsMax ?? calcInitAtLevel1(dexSelectedSpecId);
      const growth = spec.growthPerLevel ?? calcDefaultGrowth(dexSelectedSpecId);
      const captureLocationIds = calcCaptureLocations(dexSelectedSpecId);

      return (
        <PixelCard
          title={spec.name}
          right={
            <button className="text-xs text-[color:var(--accent)] hover:underline" onClick={() => setDexSelectedSpecId(null)}>
              返回
            </button>
          }
        >
          <div className="grid gap-4">
            <div className="text-xs text-[color:var(--muted)]">
              状态：{entry?.captured ? "已捕获" : "已发现"} · 捕获次数：{entry?.timesCaptured ?? 0}
            </div>

            <div>
              <div className="text-xs text-[color:var(--muted)] mb-2">可捕捉地点</div>
              <div className="flex flex-wrap gap-2">
                {captureLocationIds.length === 0 ? (
                  <div className="text-sm text-[color:var(--muted)]">未知</div>
                ) : (
                  captureLocationIds.map((locId, idx) => {
                    const hasSeenHere = entry?.seenLocations?.includes(locId) ?? false;
                    return (
                      <div
                        key={idx}
                        className={`border-2 px-3 py-1.5 text-sm font-bold ${
                          hasSeenHere
                            ? "border-[color:var(--accent)] bg-[color:var(--panel2)] text-[color:var(--accent)]"
                            : "border-[color:var(--stroke)] bg-[color:var(--bg2)] text-[color:var(--muted)] opacity-50"
                        }`}
                      >
                        {hasSeenHere ? LOCATIONS[locId].name : "???"}
                      </div>
                    );
                  })
                )}
              </div>
            </div>

            <div>
              <div className="text-xs text-[color:var(--muted)] mb-2">最高初始六维（1级）</div>
              <div className="grid grid-cols-3 gap-2 text-xs text-[color:var(--muted)]">
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">HP</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.hp}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">物攻</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.atk}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">物防</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.def}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">特攻</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.spAtk}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">特防</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.spDef}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">速度</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">{initMax.spd}</div>
                </div>
              </div>
            </div>

            <div>
              <div className="text-xs text-[color:var(--muted)] mb-2">成长浮动（每升 1 级）</div>
              <div className="grid grid-cols-3 gap-2 text-xs text-[color:var(--muted)]">
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">HP</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.hp}~+{growth.max.hp}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">物攻</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.atk}~+{growth.max.atk}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">物防</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.def}~+{growth.max.def}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">特攻</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.spAtk}~+{growth.max.spAtk}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">特防</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.spDef}~+{growth.max.spDef}</div>
                </div>
                <div className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                  <div className="text-[10px] opacity-80">速度</div>
                  <div className="mt-1 font-semibold text-[color:var(--text)]">+{growth.min.spd}~+{growth.max.spd}</div>
                </div>
              </div>
            </div>
          </div>
        </PixelCard>
      );
    }

    const totalMonsters = Object.keys(MONSTER_SPECS).length;
    const capturedCount = Object.values(save.collection).filter(e => e?.captured).length;
    const seenCount = Object.values(save.collection).filter(e => e?.seen).length;

    return (
      <PixelCard 
        title="图鉴" 
        right={
          <div className="text-xs text-[color:var(--muted)]">
            发现 {seenCount} / 捕获 {capturedCount} / 总数 {totalMonsters}
          </div>
        }
      >
        <div className="mb-4">
          <input
            type="text"
            placeholder="搜索已发现的幻兽名称..."
            value={dexSearchQuery}
            onChange={(e) => setDexSearchQuery(e.target.value)}
            className="w-full bg-[color:var(--bg)] border-2 border-[color:var(--stroke)] p-2 text-sm text-[color:var(--text)] placeholder:text-[color:var(--muted)] outline-none focus:border-[color:var(--accent)]"
          />
        </div>
        <div className="grid gap-2">
          {Object.values(MONSTER_SPECS)
            .sort((a, b) => a.dexNum - b.dexNum)
            .filter((spec) => {
              const isSeen = !!save.collection[spec.id];
              if (!dexSearchQuery.trim()) return true;
              if (!isSeen) return false; // Hide undiscovered monsters from search results
              return spec.name.toLowerCase().includes(dexSearchQuery.trim().toLowerCase());
            })
            .map((spec) => {
              const entry = save.collection[spec.id];
              const isSeen = !!entry;
              const isCaptured = entry?.captured;

              return (
                <button
                  key={spec.id}
                  disabled={!isSeen}
                  onClick={() => isSeen && setDexSelectedSpecId(spec.id)}
                  className={`flex items-center justify-between border-2 p-3 text-left ${
                    isSeen
                      ? "border-[color:var(--stroke)] bg-[color:var(--bg2)] active:bg-[color:var(--panel2)]"
                      : "border-transparent bg-transparent cursor-default opacity-50"
                  }`}
                >
                  <div>
                    <div className="text-sm font-semibold text-[color:var(--text)]">
                      <span className="text-[color:var(--muted)] mr-2">#{String(spec.dexNum).padStart(3, '0')}</span>
                      {isSeen ? spec.name : "???"}
                    </div>
                    {isSeen && (
                      <div className="mt-1 text-[10px] text-[color:var(--muted)]">捕获次数：{entry.timesCaptured}</div>
                    )}
                  </div>
                  {isSeen && (
                    <div className="text-xs text-[color:var(--muted)]">{isCaptured ? "已捕获" : "已发现"}</div>
                  )}
                </button>
              );
            })}
        </div>
      </PixelCard>
    );
  };

  const renderBox = () => {
    if (boxSelected !== null) {
      const m = save.box[boxSelected];
      if (!m) {
        setBoxSelected(null);
        return null;
      }
      const { allInitMax, allGrowthMax, isSupreme } = getMonsterSupremeState(m);
      
      const cardClassName = isSupreme
        ? "theme-supreme-stats !bg-[color:var(--panel)] bg-blend-overlay"
        : (allInitMax && allGrowthMax)
          ? "theme-max-stats !bg-[color:var(--panel)] bg-blend-overlay"
          : "";

      return (
        <PixelCard title="电脑详情" className={cardClassName} right={<button onClick={() => setBoxSelected(null)}>返回</button>}>
          <div className="grid gap-4">
            <div className="flex items-center justify-between border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-4 py-3">
              <div>
                <MonsterName m={m} className="text-lg font-semibold text-[color:var(--text)]" />
                <div className="text-xs text-[color:var(--muted)]">
                  Lv.{m.level} · {ELEMENT_LABEL[m.element]}
                </div>
              </div>
              <div className="text-right">
                <div className="text-xs text-[color:var(--muted)]">HP</div>
                <div className="text-sm font-semibold text-[color:var(--text)]">
                  {m.hp}/{m.maxHp}
                </div>
              </div>
            </div>
            
            <MonsterDetailStats m={m} />

            <div>
              <div className="text-xs text-[color:var(--muted)] mb-2">技能</div>
              <div className="grid grid-cols-2 gap-2">
                {m.moveIds.map((id, index) => (
                  <div key={`${id}-${index}`} className="border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-2">
                    <div className="text-sm font-semibold text-[color:var(--text)]">{MOVE_SPECS[id].name}</div>
                    <div className="mt-1 text-[10px] text-[color:var(--muted)]">
                      威力 {MOVE_SPECS[id].power} · 命中 {Math.round(MOVE_SPECS[id].accuracy * 100)}%
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="mt-4 flex flex-wrap gap-2">
              <PixelButton
                tone="primary"
                disabled={save.party.length >= 6}
                onClick={() => {
                  useGameStore.getState().moveBoxToParty(boxSelected);
                  setBoxSelected(null);
                }}
              >
                移入队伍
              </PixelButton>
              <PixelButton
                tone="danger"
                onClick={() => {
                  if (confirm(`确定要放生 ${m.nickname || MONSTER_SPECS[m.specId].name} 吗？这无法撤销！`)) {
                    useGameStore.getState().releaseMonster(m.id);
                    setBoxSelected(null);
                  }
                }}
              >
                放生
              </PixelButton>
            </div>
          </div>
        </PixelCard>
      );
    }

    return (
      <PixelCard title="电脑 (收藏箱)">
        <div className="grid gap-2">
          {box.map((m, idx) => (
            <button key={m.id} onClick={() => setBoxSelected(idx)} className="text-left border-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] p-3 active:bg-[color:var(--panel2)]">
              <MonsterName m={m} className="text-sm font-semibold text-[color:var(--text)]" />
              <div className="text-xs text-[color:var(--muted)]">Lv.{m.level}</div>
            </button>
          ))}
          {box.length === 0 && <div className="text-sm text-[color:var(--muted)]">箱子是空的。</div>}
        </div>
      </PixelCard>
    );
  };

  return (
    <div className="mx-auto flex h-[100dvh] w-full max-w-md flex-col bg-[color:var(--bg)] shadow-2xl sm:border-x-2 sm:border-[color:var(--stroke)]">
      {/* Header */}
      <div className="flex-none border-b-2 border-[color:var(--stroke)] bg-[color:var(--bg2)] px-4 py-3">
        <div className="flex items-center justify-between">
          <div className="font-display text-xl tracking-widest text-[color:var(--text)]">兽域手记</div>
          <div className="flex items-center gap-3">
            <button className="text-xs text-[color:var(--muted)] underline" onClick={() => setShowTestMenu(true)}>
              测试
            </button>
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
            <button className="text-xs text-[color:var(--muted)] underline" onClick={() => navigate("/")}>
              系统菜单
            </button>
          </div>
        </div>
        <div className="mt-1 text-xs text-[color:var(--muted)]">
          {save.playerName} · ¥{save.money}
        </div>
      </div>

      {showTestMenu && <TestMenuModal onClose={() => setShowTestMenu(false)} />}
      {showTypeChart && <TypeChartModal onClose={() => setShowTypeChart(false)} />}

      {/* Main Content Area */}
      <div className="flex-1 overflow-y-auto p-4 flex flex-col">
        {tab === "party" && renderParty()}
        {tab === "bag" && renderBag()}
        {tab === "map" && renderMap()}
        {tab === "dex" && renderDex()}
        {tab === "box" && renderBox()}
      </div>

      {/* Bottom Navigation */}
      <div className="flex-none flex h-14 border-t-2 border-[color:var(--stroke)] bg-[color:var(--bg2)]">
        {[
          { id: "party", label: "队伍" },
          { id: "bag", label: "背包" },
          { id: "map", label: "地图" },
          { id: "dex", label: "图鉴" },
          { id: "box", label: "电脑" },
        ].map((item) => (
          <button
            key={item.id}
            onClick={() => {
              setTab(item.id as any);
              setSelected(null);
              setShopOpen(false);
              setMapView("list");
              setDialog(null);
              setDexSelectedSpecId(null);
            }}
            className={`flex-1 flex items-center justify-center border-r-2 border-[color:var(--stroke)] last:border-r-0 text-sm font-semibold transition-colors ${tab === item.id ? "bg-[color:var(--accent)] text-[color:var(--bg)]" : "text-[color:var(--text)] active:bg-[color:var(--panel2)]"}`}
          >
            {item.label}
          </button>
        ))}
      </div>
    </div>
  );
}
