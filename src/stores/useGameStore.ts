import { create } from "zustand";
import { persist, StateStorage, createJSONStorage } from "zustand/middleware";
import { ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS, STARTERS } from "@/game/data";
import type { BattleState, EncounterTheme, ItemId, MonsterInstance, SaveData, LocationId, MoveId, StatModifiers } from "@/game/types";
import { applyDamage, attemptCapture, computeDamage, createInstance, gainExp, evolveMonsterInstance, getStatMultiplier, getAccuracyMultiplier, applyStatChanges, getSpeed, canMove, roll, uuid, getMonsterStatBounds } from "@/game/rules";
import { generateEncounter } from "@/game/gen";

export const SAVE_VERSION = "0.1.0";

type GameState = {
  slot: 1 | 2 | 3;
  save1: SaveData | null;
  save2: SaveData | null;
  save3: SaveData | null;
  battle: BattleState | null;
  
  setSlot: (slot: 1 | 2 | 3) => void;
  leaveBattle: () => void;
  newGame: (playerName: string, starterSpecId: (typeof STARTERS)[number]) => void;
  resetSave: (slotToReset?: 1 | 2 | 3) => void;
  travelTo: (locationId: LocationId) => void;
  importSaveJson: (json: string, targetSlot?: 1 | 2 | 3) => { ok: true } | { ok: false; reason: string };
  exportSaveJson: (targetSlot?: 1 | 2 | 3) => { ok: true; json: string } | { ok: false; reason: string };
  
  startEncounter: (theme: EncounterTheme, areaName: string, levelMin: number, levelMax: number) => { ok: true } | { ok: false; reason: string };
  useMove: (moveId: MoveId) => void;
  useItem: (itemId: ItemId) => void;
  switchTo: (partyIndex: number) => void;
  flee: () => void;
  healAll: () => void;
  useItemOutsideBattle: (itemId: ItemId, partyIndex: number) => void;
  buyItem: (itemId: ItemId, amount: number) => void;

  movePartyToBox: (partyIndex: number) => void;
  moveBoxToParty: (boxIndex: number) => void;
  releaseMonster: (id: string) => void;
  resolvePendingMove: (monsterId: string, oldMoveId: MoveId | null, newMoveId: MoveId) => void;
  resolvePendingEvolution: (monsterId: string, accept: boolean) => void;

  // 测试功能
  testOHKO: boolean;
  testMaxStats: boolean;
  testShiny: boolean;
  toggleTestOHKO: () => void;
  toggleTestMaxStats: () => void;
  toggleTestShiny: () => void;
  addGold: (amount: number) => void;
  addMasterBalls: (amount: number) => void;
};

function nowIso() {
  return new Date().toISOString();
}

function defaultInventory(): Record<ItemId, number> {
  const inv: Partial<Record<ItemId, number>> = {};
  for (const id of Object.keys(ITEM_SPECS) as ItemId[]) {
    inv[id] = 0;
  }
  inv.capsule_basic = 6;
  inv.capsule_prism = 1;
  inv.potion_small = 3;
  return inv as Record<ItemId, number>;
}

function averagePartyLevel(party: MonsterInstance[]) {
  if (party.length === 0) return 1;
  const s = party.reduce((acc, m) => acc + m.level, 0);
  return Math.max(1, Math.round(s / party.length));
}

function pushLog(battle: BattleState, lines: string[]) {
  const log = [...battle.log, ...lines].slice(-60);
  return { ...battle, log };
}

function alive(mon: MonsterInstance) {
  return mon.hp > 0;
}

function findFirstAliveIndex(party: MonsterInstance[]) {
  const idx = party.findIndex((m) => m.hp > 0);
  return idx === -1 ? 0 : idx;
}

function consumeItem(inv: Record<ItemId, number>, itemId: ItemId) {
  const qty = inv[itemId] ?? 0;
  if (qty <= 0) return { ok: false as const, inv };
  return { ok: true as const, inv: { ...inv, [itemId]: qty - 1 } };
}

const customStorage: StateStorage = {
  getItem: async (name: string): Promise<string | null> => {
    try {
      const res = await fetch('/api/save');
      if (res.ok) {
        const text = await res.text();
        return text || null;
      }
    } catch (e) {
      console.warn('Failed to fetch remote save, falling back to local', e);
    }
    return localStorage.getItem(name);
  },
  setItem: async (name: string, value: string): Promise<void> => {
    localStorage.setItem(name, value);
    try {
      await fetch('/api/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ value })
      });
    } catch (e) {
      console.warn('Failed to sync save to server', e);
    }
  },
  removeItem: async (name: string): Promise<void> => {
    localStorage.removeItem(name);
  },
};

export const useGameStore = create<GameState>()(
  persist(
    (set, get) => ({
      slot: 1,
      save1: null,
      save2: null,
      save3: null,
      battle: null,
      
      setSlot: (slot) => set({ slot }),
      leaveBattle: () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (state.battle?.result === "player_fainted" && save) {
          // 全灭惩罚：回到最近的恢复点，并恢复所有队伍状态
          const party = save.party.map((m) => ({ ...m, hp: m.maxHp, status: "none" as const }));
          set({ 
            battle: null,
            [`save${state.slot}`]: { 
              ...save, 
              party, 
              locationId: save.lastHealLocationId, 
              lastSavedAt: nowIso() 
            } 
          } as any);
        } else {
          set({ battle: null });
        }
      },

      newGame: (playerName, starterSpecId) => {
        const { slot } = get();
        const starter = createInstance(starterSpecId, 5);
        // 强制去重，防止因为旧版代码缓存等不可控因素导致的初始重复技能
        if (starter.moveIds) {
          starter.moveIds = Array.from(new Set(starter.moveIds));
        }
        
        const save: SaveData = {
          version: SAVE_VERSION,
          playerName,
          money: 0,
          steps: 0,
          locationId: "town_starter",
          lastHealLocationId: "town_starter",
          visitedLocationIds: ["town_starter"],
          party: [starter],
          box: [],
          inventory: defaultInventory(),
          collection: {
            [starterSpecId]: { seen: true, captured: true, timesCaptured: 1, seenLocations: ["town_starter"] },
          },
          lastSavedAt: nowIso(),
        };
        set({ [`save${slot}`]: save, battle: null } as any);
      },

      resetSave: (slotToReset) => {
        const s = slotToReset ?? get().slot;
        set({ [`save${s}`]: null, battle: null } as any);
      },

      travelTo: (locationId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const visited = save.visitedLocationIds?.includes(locationId)
          ? save.visitedLocationIds
          : [...(save.visitedLocationIds ?? []), locationId];
        set({ [`save${state.slot}`]: { ...save, locationId, visitedLocationIds: visited, lastSavedAt: nowIso() } } as any);
      },

      importSaveJson: (json, targetSlot) => {
        const s = targetSlot ?? get().slot;
        try {
          const parsed = JSON.parse(json) as SaveData;
          if (!parsed || typeof parsed !== "object") return { ok: false, reason: "存档格式不正确" };
          if (typeof parsed.version !== "string") return { ok: false, reason: "缺少版本信息" };
          if (!Array.isArray(parsed.party)) return { ok: false, reason: "队伍字段不正确" };
          if (!parsed.inventory) return { ok: false, reason: "背包字段不正确" };
          const locationId = (parsed.locationId ?? "town_starter") as LocationId;
          const lastHealLocationId = (parsed.lastHealLocationId ?? locationId) as LocationId;
          const visitedLocationIds = (parsed.visitedLocationIds ?? [locationId]) as LocationId[];
          set({
            [`save${s}`]: { ...parsed, locationId, lastHealLocationId, visitedLocationIds, lastSavedAt: nowIso() },
            battle: null,
          } as any);
          return { ok: true };
        } catch {
          return { ok: false, reason: "JSON 解析失败" };
        }
      },

      exportSaveJson: (targetSlot) => {
        const state = get();
        const s = targetSlot ?? state.slot;
        const save = state[`save${s}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "没有可导出的存档" };
        return { ok: true, json: JSON.stringify({ ...save, lastSavedAt: nowIso() }, null, 2) };
      },

      startEncounter: (theme, areaName, levelMin, levelMax) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return { ok: false, reason: "请先创建或导入存档" };
        if (save.party.length === 0) return { ok: false, reason: "队伍为空" };
        const playerActiveIndex = findFirstAliveIndex(save.party);
        const level = Math.floor(Math.random() * (levelMax - levelMin + 1)) + levelMin;
        let { enemy, label } = generateEncounter(theme, level);
        
        if (state.testShiny) enemy.isShiny = true;
        if (state.testMaxStats) {
          const bounds = getMonsterStatBounds(enemy.specId);
          enemy.initStats = bounds.initMax;
          enemy.growthRates = bounds.gMax;
          // 重新计算当前 HP 和 maxHp
          const levelups = Math.max(0, enemy.level - 1);
          enemy.maxHp = enemy.initStats.hp + enemy.growthRates.hp * levelups;
          enemy.hp = enemy.maxHp;
          enemy.atk = enemy.initStats.atk + enemy.growthRates.atk * levelups;
          enemy.def = enemy.initStats.def + enemy.growthRates.def * levelups;
          enemy.spAtk = enemy.initStats.spAtk + enemy.growthRates.spAtk * levelups;
          enemy.spDef = enemy.initStats.spDef + enemy.growthRates.spDef * levelups;
          enemy.spd = enemy.initStats.spd + enemy.growthRates.spd * levelups;
        }
        
        const prevSeenLocations = save.collection[enemy.specId]?.seenLocations ?? [];
        const seenLocations = prevSeenLocations.includes(save.locationId)
          ? prevSeenLocations
          : [...prevSeenLocations, save.locationId];

        // Ensure we also mark the first evolution (if any) as seen, to match traditional Pokédex logic
        // where encountering an evolution stage also reveals its base, but here we just mark the encountered one as seen.
        // Wait, the user's prompt means: when you see a monster, it gets unlocked (seen).
        // If it's an evolution, should we mark its base as seen?
        // Actually, just tracking the encountered `enemy.specId` is enough.
        // We will just let the UI handle the `???` rendering for missing dexNums.

        const collection = {
          ...save.collection,
          [enemy.specId]: {
            seen: true,
            captured: save.collection[enemy.specId]?.captured ?? false,
            timesCaptured: save.collection[enemy.specId]?.timesCaptured ?? 0,
            seenLocations,
          },
        };
        const battle: BattleState = {
          theme,
          areaName,
          levelMin,
          levelMax,
          turn: 1,
          log: [`遭遇：${label}`],
          playerActiveIndex,
          playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
          enemyStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
          enemy,
          finished: false,
        };
        set({ [`save${state.slot}`]: { ...save, collection, lastSavedAt: nowIso() }, battle } as any);
        return { ok: true };
      },

      switchTo: (partyIndex) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!save || !battle || battle.finished) return;
        const next = save.party[partyIndex];
        if (!next || next.hp <= 0) return;
        if (partyIndex === battle.playerActiveIndex) return;
        let b = pushLog(
          { 
            ...battle, 
            playerActiveIndex: partyIndex,
            playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 }
          }, 
          [`你换上了 ${MONSTER_SPECS[next.specId].name}`]
        );
        const res = runEnemyTurn(save, b);
        set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
      },

      flee: () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!save || !battle || battle.finished) return;
        const player = save.party[battle.playerActiveIndex];
        const enemy = battle.enemy;
        const chance = player.spd >= enemy.spd ? 0.75 : 0.5;
        if (roll(chance)) {
          set({ battle: { ...battle, finished: true, result: "fled" as const, log: [...battle.log, "你成功撤离了训练场。"] } });
          return;
        }
        const res = runEnemyTurn(save, pushLog(battle, ["撤离失败！对方抓住了破绽。"]));
        set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
      },

      useItem: (itemId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        const battle = state.battle;
        if (!save || !battle || battle.finished) return;
        const item = ITEM_SPECS[itemId];
        const consumed = consumeItem(save.inventory, itemId);
        if (!consumed.ok) {
          set({ battle: pushLog(battle, ["道具不足。"]) });
          return;
        }

        if (item.kind === "heal") {
          const idx = battle.playerActiveIndex;
          const cur = save.party[idx];
          const healed = Math.min(cur.maxHp, cur.hp + (item.heal ?? 0));
          const party = save.party.slice();
          party[idx] = { ...cur, hp: healed };
          const nextSave = { ...save, inventory: consumed.inv, party, lastSavedAt: nowIso() };
          let b = pushLog(battle, [`使用了 ${item.name}。`]);
          const res = runEnemyTurn(nextSave, b);
          set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
          return;
        }

        const baseRate = MONSTER_SPECS[battle.enemy.specId].captureRate;
        const modifier = item.kind === "capture" ? (item.modifier ?? 1) : 1;
        const { ok, chance, shakes } = attemptCapture(battle.enemy, baseRate, modifier);
        const head = `抛出了 ${item.name}…（成功率 ${Math.round(chance * 100)}%）`;
        if (ok) {
          const enemyName = MONSTER_SPECS[battle.enemy.specId].name;
          const captured: MonsterInstance = { ...battle.enemy, id: uuid(), hp: battle.enemy.maxHp, status: "none" as const };
          const party = save.party.length < 6 ? [...save.party, captured] : save.party;
          const box = save.party.length < 6 ? save.box : [...save.box, captured];
          const collection = {
            ...save.collection,
            [captured.specId]: {
              seen: true,
              captured: true,
              timesCaptured: (save.collection[captured.specId]?.timesCaptured ?? 0) + 1,
            },
          };
          const nextSave = { ...save, inventory: consumed.inv, party, box, collection, lastSavedAt: nowIso() };
          set({
            [`save${state.slot}`]: nextSave,
            battle: pushLog({ ...battle, finished: true, result: "captured" as const }, [head, `摇晃 x${shakes}… 捕获成功！${enemyName} 已加入。`]),
          } as any);
          return;
        }

        const nextSave = { ...save, inventory: consumed.inv, lastSavedAt: nowIso() };
        const res = runEnemyTurn(nextSave, pushLog(battle, [head, `摇晃 x${shakes}… 失败！`]));
        set({ [`save${state.slot}`]: res.save, battle: res.battle } as any);
      },

      useMove: (moveId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        let battle = state.battle;
        if (!save || !battle || battle.finished) return;

        let player = save.party[battle.playerActiveIndex];
        let enemy = battle.enemy;
        let playerMods = { ...battle.playerStatMods };
        let enemyMods = { ...battle.enemyStatMods };
        let logs: string[] = [];

        const enemyMoveId = enemy.moveIds[Math.floor(Math.random() * enemy.moveIds.length)];

        // Speed check
        const playerSpd = getSpeed(player, playerMods);
        const enemySpd = getSpeed(enemy, enemyMods);
        const playerPriority = MOVE_SPECS[moveId].priority ?? 0;
        const enemyPriority = MOVE_SPECS[enemyMoveId].priority ?? 0;

        let playerGoesFirst = false;
        if (playerPriority > enemyPriority) {
          playerGoesFirst = true;
        } else if (playerPriority < enemyPriority) {
          playerGoesFirst = false;
        } else {
          playerGoesFirst = playerSpd > enemySpd || (playerSpd === enemySpd && roll(0.5));
        }

        let playerFlinched = false;
        let enemyFlinched = false;

        const runPlayerAction = () => {
          if (!alive(player) || !alive(enemy)) return;
          if (playerFlinched) {
            logs.push(`${MONSTER_SPECS[player.specId].name} 畏缩了，无法行动！`);
            return;
          }
          const { ok, nextStatus } = canMove(player, logs);
          player.status = nextStatus;
          if (ok) {
            const res = executeMoveAction(player, enemy, playerMods, enemyMods, moveId, state.testOHKO);
            player = res.nextAttacker;
            enemy = res.nextDefender;
            playerMods = res.nextAttackerMods;
            enemyMods = res.nextDefenderMods;
            if (res.flinch) enemyFlinched = true;
            logs.push(...res.logs);
          }
        };

        const runEnemyAction = () => {
          if (!alive(player) || !alive(enemy)) return;
          if (enemyFlinched) {
            logs.push(`${MONSTER_SPECS[enemy.specId].name} 畏缩了，无法行动！`);
            return;
          }
          const { ok, nextStatus } = canMove(enemy, logs);
          enemy.status = nextStatus;
          if (ok) {
            const res = executeMoveAction(enemy, player, enemyMods, playerMods, enemyMoveId);
            enemy = res.nextAttacker;
            player = res.nextDefender;
            enemyMods = res.nextAttackerMods;
            playerMods = res.nextDefenderMods;
            if (res.flinch) playerFlinched = true;
            logs.push(...res.logs);
          }
        };

        if (playerGoesFirst) {
          runPlayerAction();
          runEnemyAction();
        } else {
          runEnemyAction();
          runPlayerAction();
        }

        let nextParty = save.party.slice();
        nextParty[battle.playerActiveIndex] = player;

        // End of turn
        const endTurnRes = processEndOfTurn(nextParty, battle.playerActiveIndex, enemy, battle);
        nextParty = endTurnRes.nextParty;
        enemy = endTurnRes.nextEnemy;
        logs.push(...endTurnRes.logs);
        player = nextParty[battle.playerActiveIndex];

        battle = pushLog({ ...battle, playerStatMods: playerMods, enemyStatMods: enemyMods, enemy }, logs);

        // Check faints
        if (!alive(enemy)) {
          const expGain = 10 + enemy.level * 6;
          const moneyGain = 50 + enemy.level * 10;
          const res = gainExp(player, expGain);
          nextParty[battle.playerActiveIndex] = res.monster;
          const nextSave = { ...save, party: nextParty, money: save.money + moneyGain, lastSavedAt: nowIso() };
          battle = pushLog({ ...battle, enemy, finished: true, result: "enemy_fainted" as const }, [
            `${MONSTER_SPECS[enemy.specId].name} 倒下了。`,
            `获得经验 ${expGain}，金钱 ¥${moneyGain}。${res.leveled ? "等级提升！" : ""}`.trim(),
          ]);
          set({ [`save${state.slot}`]: nextSave, battle } as any);
          return;
        }

        if (!alive(player)) {
          battle = pushLog(battle, [`${MONSTER_SPECS[player.specId].name} 倒下了。`]);
          const nextIndex = findFirstAliveIndex(nextParty);
          if (alive(nextParty[nextIndex])) {
            battle = pushLog({ ...battle, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [`你派出了 ${MONSTER_SPECS[nextParty[nextIndex].specId].name}。`]);
            set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, turn: battle.turn + 1 } } as any);
            return;
          } else {
            set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, finished: true, result: "player_fainted" as const } } as any);
            return;
          }
        }

        set({ [`save${state.slot}`]: { ...save, party: nextParty, lastSavedAt: nowIso() }, battle: { ...battle, turn: battle.turn + 1 } } as any);
      },

      healAll: () => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const party = save.party.map((m) => ({ ...m, hp: m.maxHp, status: "none" as const }));
        set({ [`save${state.slot}`]: { ...save, party, lastHealLocationId: save.locationId, lastSavedAt: nowIso() } } as any);
      },

      useItemOutsideBattle: (itemId, partyIndex) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const item = ITEM_SPECS[itemId];
        if (item.kind !== "heal") return;
        const consumed = consumeItem(save.inventory, itemId);
        if (!consumed.ok) return;

        const cur = save.party[partyIndex];
        if (!cur || cur.hp <= 0) return;
        const healed = Math.min(cur.maxHp, cur.hp + (item.heal ?? 0));
        const party = save.party.slice();
        party[partyIndex] = { ...cur, hp: healed };
        set({ [`save${state.slot}`]: { ...save, inventory: consumed.inv, party, lastSavedAt: nowIso() } } as any);
      },

      buyItem: (itemId, amount) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const item = ITEM_SPECS[itemId];
        const cost = (item.price ?? 99999) * amount;
        if (save.money < cost) return;
        const currentAmount = save.inventory[itemId] ?? 0;
        set({
          [`save${state.slot}`]: {
            ...save,
            money: save.money - cost,
            inventory: { ...save.inventory, [itemId]: currentAmount + amount },
            lastSavedAt: nowIso(),
          },
        } as any);
      },

      movePartyToBox: (partyIndex: number) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        if (save.party.length <= 1) return;
        const m = save.party[partyIndex];
        if (!m) return;
        const party = save.party.filter((_, i) => i !== partyIndex);
        const box = [...save.box, m];
        set({ [`save${state.slot}`]: { ...save, party, box, lastSavedAt: nowIso() } } as any);
      },

      moveBoxToParty: (boxIndex: number) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        if (save.party.length >= 6) return;
        const m = save.box[boxIndex];
        if (!m) return;
        const box = save.box.filter((_, i) => i !== boxIndex);
        const party = [...save.party, m];
        set({ [`save${state.slot}`]: { ...save, party, box, lastSavedAt: nowIso() } } as any);
      },

      releaseMonster: (id: string) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const inParty = save.party.some(m => m.id === id);
        if (inParty && save.party.length <= 1) return;

        set({
          [`save${state.slot}`]: {
            ...save,
            party: save.party.filter(m => m.id !== id),
            box: save.box.filter(m => m.id !== id),
            lastSavedAt: nowIso()
          }
        } as any);
      },

      resolvePendingMove: (monsterId, oldMoveId, newMoveId) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;

        const updateMonster = (m: MonsterInstance) => {
          if (m.id !== monsterId) return m;
          const pendingMoves = (m.pendingMoves ?? []).filter(id => id !== newMoveId);
          let moveIds = [...m.moveIds];
          if (oldMoveId !== null) {
            const idx = moveIds.indexOf(oldMoveId);
            if (idx !== -1) {
              moveIds[idx] = newMoveId;
            }
          }
          return { ...m, pendingMoves, moveIds };
        };

        set({
          [`save${state.slot}`]: {
            ...save,
            party: save.party.map(updateMonster),
            box: save.box.map(updateMonster),
            lastSavedAt: nowIso()
          }
        } as any);
      },

      resolvePendingEvolution: (monsterId, accept) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;

        const updateMonster = (m: MonsterInstance) => {
          if (m.id !== monsterId) return m;
          const pending = m.pendingEvolution;
          if (!pending) return m;
          if (!accept) return { ...m, pendingEvolution: undefined };

          const evolved = evolveMonsterInstance(m, pending.targetId);
          return evolved;
        };

        const party = save.party.map(updateMonster);
        const box = save.box.map(updateMonster);

        const evolvedMonster = [...party, ...box].find((m) => m.id === monsterId);
        const evolvedSpecId = evolvedMonster?.specId;

        let collection = save.collection;
        if (evolvedSpecId) {
          const prev = save.collection[evolvedSpecId];
          const seenLocations = prev?.seenLocations?.includes(save.locationId)
            ? prev.seenLocations
            : [...(prev?.seenLocations ?? []), save.locationId];
          collection = {
            ...save.collection,
            [evolvedSpecId]: {
              seen: true,
              captured: true,
              timesCaptured: Math.max(prev?.timesCaptured ?? 0, 1),
              seenLocations,
            },
          };
        }

        set({
          [`save${state.slot}`]: {
            ...save,
            party,
            box,
            collection,
            lastSavedAt: nowIso(),
          },
        } as any);
      },

      testOHKO: false,
      testMaxStats: false,
      testShiny: false,
      toggleTestOHKO: () => set((s) => ({ testOHKO: !s.testOHKO })),
      toggleTestMaxStats: () => set((s) => ({ testMaxStats: !s.testMaxStats })),
      toggleTestShiny: () => set((s) => ({ testShiny: !s.testShiny })),
      addGold: (amount) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        set({ [`save${state.slot}`]: { ...save, money: Math.min(999999, save.money + amount), lastSavedAt: nowIso() } } as any);
      },
      addMasterBalls: (amount) => {
        const state = get();
        const save = state[`save${state.slot}` as keyof GameState] as SaveData | null;
        if (!save) return;
        const inventory = { ...save.inventory };
        inventory["capsule_master"] = (inventory["capsule_master"] || 0) + amount;
        set({ [`save${state.slot}`]: { ...save, inventory, lastSavedAt: nowIso() } } as any);
      }
    }),
    {
      name: "beast-journal-save",
      storage: createJSONStorage(() => customStorage),
      partialize: (s) => ({ save1: s.save1, save2: s.save2, save3: s.save3, slot: s.slot }),
      version: 9,
      migrate: (persistedState: any, version: number) => {
        let state = persistedState;
        if (version === 1) {
          state = { slot: 1, save1: state.save, save2: null, save3: null };
          version = 2;
        }
        if (version === 2) {
          if (state.save1) state.save1.locationId = "town_starter";
          if (state.save2) state.save2.locationId = "town_starter";
          if (state.save3) state.save3.locationId = "town_starter";
          version = 3;
        }
        if (version === 3) {
          if (state.save1) state.save1.lastHealLocationId = state.save1.locationId;
          if (state.save2) state.save2.lastHealLocationId = state.save2.locationId;
          if (state.save3) state.save3.lastHealLocationId = state.save3.locationId;
          version = 4;
        }
        if (version === 4) {
          const migrateLocation = (save: any) => {
            if (!save) return;
            if (save.locationId === "route_1") save.locationId = "town_starter";
            if (save.locationId === "cave_echo") save.locationId = "city_pebble";
            if (save.lastHealLocationId === "route_1") save.lastHealLocationId = "town_starter";
            if (save.lastHealLocationId === "cave_echo") save.lastHealLocationId = "city_pebble";
            if (!save.visitedLocationIds) save.visitedLocationIds = [save.locationId];
            
            // replace old wild areas in visited array
            save.visitedLocationIds = save.visitedLocationIds.map((id: string) => {
              if (id === "route_1") return "town_starter";
              if (id === "cave_echo") return "city_pebble";
              return id;
            });
          };
          migrateLocation(state.save1);
          migrateLocation(state.save2);
          migrateLocation(state.save3);
          version = 5;
        }
        if (version === 5) {
          const migrateGrowth = (save: any) => {
            if (!save) return;
            const fixMonster = (m: any) => {
              if (!m.growthRates || !m.initStats) {
                // Generate fresh stats for existing monsters, we just keep their current level
                // but replace their stats with properly generated ones for consistency
                const fresh = createInstance(m.specId, m.level);
                m.initStats = fresh.initStats;
                m.growthRates = fresh.growthRates;
                m.maxHp = fresh.maxHp;
                m.hp = m.hp > m.maxHp ? fresh.maxHp : m.hp;
                m.atk = fresh.atk;
                m.def = fresh.def;
                m.spAtk = fresh.spAtk;
                m.spDef = fresh.spDef;
                m.spd = fresh.spd;
              }
              return m;
            };
            if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
            if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
          };
          migrateGrowth(state.save1);
          migrateGrowth(state.save2);
          migrateGrowth(state.save3);
          version = 6;
        }
        if (version === 6) {
          const dedupeMoves = (save: any) => {
            if (!save) return;
            const fixMonster = (m: any) => {
              if (m.moveIds && Array.isArray(m.moveIds)) {
                m.moveIds = Array.from(new Set(m.moveIds));
              }
              return m;
            };
            if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
            if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
          };
          dedupeMoves(state.save1);
          dedupeMoves(state.save2);
          dedupeMoves(state.save3);
          version = 7;
        }
        if (version === 7) {
          const dedupeMoves = (save: any) => {
            if (!save) return;
            const fixMonster = (m: any) => {
              if (m.moveIds && Array.isArray(m.moveIds)) {
                m.moveIds = Array.from(new Set(m.moveIds));
              }
              return m;
            };
            if (Array.isArray(save.party)) save.party = save.party.map(fixMonster);
            if (Array.isArray(save.box)) save.box = save.box.map(fixMonster);
          };
          dedupeMoves(state.save1);
          dedupeMoves(state.save2);
          dedupeMoves(state.save3);
          version = 8;
        }
        if (version === 8) {
          const initSeenLocations = (save: any) => {
            if (!save || !save.collection) return;
            Object.values(save.collection).forEach((entry: any) => {
              if (entry.seen && !entry.seenLocations) {
                entry.seenLocations = []; // or we could add save.visitedLocationIds if we wanted to be lenient
              }
            });
            if (save.party && save.party.length > 0 && save.collection[save.party[0].specId]) {
              save.collection[save.party[0].specId].seenLocations = ["town_starter"];
            }
          };
          initSeenLocations(state.save1);
          initSeenLocations(state.save2);
          initSeenLocations(state.save3);
          version = 9;
        }
        return state;
      }
    }
  )
);

function effLine(eff: number) {
  if (eff >= 2) return "效果拔群！";
  if (eff <= 0.6) return "效果不太理想。";
  if (eff > 1.05 && eff < 2) return "有点克制。";
  return "";
}

function statusLine(next: MonsterInstance["status"], prev: MonsterInstance["status"]) {
  if (next === prev) return "";
  if (next === "burn") return "被灼伤了。";
  if (next === "paralyze") return "麻痹了。";
  if (next === "sleep") return "睡着了。";
  if (next === "freeze") return "被冻住了。";
  if (next === "poison") return "中毒了。";
  return "";
}

// 内部方法，执行一次完整的招式（含伤害、状态、能力变化）
function executeMoveAction(
  attacker: MonsterInstance,
  defender: MonsterInstance,
  attackerMods: StatModifiers,
  defenderMods: StatModifiers,
  moveId: MoveId,
  testOHKO?: boolean
) {
  const move = MOVE_SPECS[moveId];
  const logs: string[] = [];
  let flinch = false;
  
  const hit = roll(move.accuracy * getAccuracyMultiplier((attackerMods.accuracy ?? 0) - (defenderMods.evasion ?? 0)));
  if (!hit) {
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 的攻击落空了。`);
    return { nextAttacker: attacker, nextDefender: defender, nextAttackerMods: attackerMods, nextDefenderMods: defenderMods, logs, flinch };
  }

  let dmg = 0;
  let nextAttacker = { ...attacker };
  
  if (move.category !== "status") {
    let hits = 1;
    if (move.multiHit) {
      hits = move.multiHit[0] + Math.floor(Math.random() * (move.multiHit[1] - move.multiHit[0] + 1));
    }
    
    let totalDmg = 0;
    let anyCrit = false;
    let eff = 1;
    
    for (let i = 0; i < hits; i++) {
      const res = computeDamage(attacker, defender, moveId, attackerMods, defenderMods);
      totalDmg += res.dmg;
      eff = res.eff;
      if (res.isCrit) anyCrit = true;
    }
    
    dmg = totalDmg;
    if (testOHKO) dmg = defender.hp;
    
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 使用了 ${move.name}，造成 ${dmg} 点伤害。`);
    if (hits > 1) logs.push(`击中了 ${hits} 次！`);
    if (anyCrit) logs.push("击中了要害！");
    if (eff !== 1) logs.push(effLine(eff));
    
    if (move.healPct && dmg > 0) {
      const healAmt = Math.max(1, Math.floor(dmg * move.healPct));
      nextAttacker.hp = Math.min(nextAttacker.maxHp, nextAttacker.hp + healAmt);
      logs.push(`${MONSTER_SPECS[nextAttacker.specId].name} 吸取了体力！`);
    }
    
    if (move.flinchChance && roll(move.flinchChance)) {
      flinch = true;
    }
  } else {
    logs.push(`${MONSTER_SPECS[attacker.specId].name} 使用了 ${move.name}。`);
  }

  let nextDefender = applyDamage(defender, dmg);
  let nextAttackerMods = { ...attackerMods };
  let nextDefenderMods = { ...defenderMods };

  // Status effects
  if (move.status && nextDefender.hp > 0 && nextDefender.status === "none" && roll(move.status.chance)) {
    const targetIsSelf = move.status.target === "self";
    if (targetIsSelf && nextAttacker.status === "none") {
      nextAttacker.status = move.status.type;
      logs.push(`${MONSTER_SPECS[nextAttacker.specId].name} ${statusLine(nextAttacker.status, "none")}`);
    } else if (!targetIsSelf) {
      nextDefender.status = move.status.type;
      logs.push(`${MONSTER_SPECS[nextDefender.specId].name} ${statusLine(nextDefender.status, "none")}`);
    }
  }

  // Stat changes
  if (move.statChanges) {
    for (const c of move.statChanges) {
      const targetIsSelf = c.target === "self";
      if (targetIsSelf && nextAttacker.hp > 0) {
        nextAttackerMods = applyStatChanges(nextAttackerMods, MONSTER_SPECS[nextAttacker.specId].name, [c], logs);
      } else if (!targetIsSelf && nextDefender.hp > 0) {
        nextDefenderMods = applyStatChanges(nextDefenderMods, MONSTER_SPECS[nextDefender.specId].name, [c], logs);
      }
    }
  }

  return { nextAttacker, nextDefender, nextAttackerMods, nextDefenderMods, logs, flinch };
}

function processEndOfTurn(party: MonsterInstance[], activeIdx: number, enemy: MonsterInstance, battle: BattleState) {
  let logs: string[] = [];
  let nextParty = [...party];
  let nextEnemy = { ...enemy };
  let player = nextParty[activeIdx];

  // Poison / Burn DOT
  if (player.hp > 0) {
    if (player.status === "burn") {
      const dmg = Math.max(1, Math.floor(player.maxHp / 16));
      player = applyDamage(player, dmg);
      logs.push(`${MONSTER_SPECS[player.specId].name} 受到烧伤伤害。`);
    } else if (player.status === "poison") {
      const dmg = Math.max(1, Math.floor(player.maxHp / 8));
      player = applyDamage(player, dmg);
      logs.push(`${MONSTER_SPECS[player.specId].name} 受到中毒伤害。`);
    }
    nextParty[activeIdx] = player;
  }

  if (nextEnemy.hp > 0) {
    if (nextEnemy.status === "burn") {
      const dmg = Math.max(1, Math.floor(nextEnemy.maxHp / 16));
      nextEnemy = applyDamage(nextEnemy, dmg);
      logs.push(`${MONSTER_SPECS[nextEnemy.specId].name} 受到烧伤伤害。`);
    } else if (nextEnemy.status === "poison") {
      const dmg = Math.max(1, Math.floor(nextEnemy.maxHp / 8));
      nextEnemy = applyDamage(nextEnemy, dmg);
      logs.push(`${MONSTER_SPECS[nextEnemy.specId].name} 受到中毒伤害。`);
    }
  }

  return { nextParty, nextEnemy, logs };
}

function runEnemyTurn(save: SaveData, battle: BattleState) {
  if (battle.finished) return { save, battle };
  let party = save.party.slice();
  let player = party[battle.playerActiveIndex];
  let enemy = battle.enemy;
  let playerMods = { ...battle.playerStatMods };
  let enemyMods = { ...battle.enemyStatMods };
  let logs: string[] = [];

  if (!alive(player)) {
    const nextIndex = findFirstAliveIndex(party);
    if (nextIndex !== battle.playerActiveIndex && alive(party[nextIndex])) {
      return {
        save,
        battle: pushLog({ ...battle, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [
          `${MONSTER_SPECS[player.specId].name} 倒下了，你派出了 ${MONSTER_SPECS[party[nextIndex].specId].name}。`,
        ]),
      };
    }
    return { save, battle: { ...pushLog(battle, ["你已没有可战斗的伙伴。"]), finished: true, result: "player_fainted" as const } };
  }

  const enemyMoveId = enemy.moveIds[Math.floor(Math.random() * enemy.moveIds.length)];

  const { ok, nextStatus } = canMove(enemy, logs);
  enemy.status = nextStatus;
  if (ok) {
    const res = executeMoveAction(enemy, player, enemyMods, playerMods, enemyMoveId);
    enemy = res.nextAttacker;
    player = res.nextDefender;
    enemyMods = res.nextAttackerMods;
    playerMods = res.nextDefenderMods;
    logs.push(...res.logs);
  }

  party[battle.playerActiveIndex] = player;
  
  // End of turn
  const endTurnRes = processEndOfTurn(party, battle.playerActiveIndex, enemy, battle);
  party = endTurnRes.nextParty;
  enemy = endTurnRes.nextEnemy;
  logs.push(...endTurnRes.logs);
  player = party[battle.playerActiveIndex];

  let b = pushLog({ ...battle, playerStatMods: playerMods, enemyStatMods: enemyMods, enemy }, logs);
  const nextSave = { ...save, party, lastSavedAt: nowIso() };

  if (!alive(player)) {
    b = pushLog(b, [`${MONSTER_SPECS[player.specId].name} 倒下了。`]);
    const nextIndex = findFirstAliveIndex(party);
    if (alive(party[nextIndex])) {
      b = pushLog({ ...b, playerActiveIndex: nextIndex, playerStatMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 } }, [`你派出了 ${MONSTER_SPECS[party[nextIndex].specId].name}。`]);
      return { save: nextSave, battle: b };
    }
    return { save: nextSave, battle: { ...b, finished: true, result: "player_fainted" as const } };
  }

  return { save: nextSave, battle: { ...b, turn: b.turn + 1 } };
}
