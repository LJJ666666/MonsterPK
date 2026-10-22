import type { Element, MonsterInstance, MoveId, StatBlock, Status, StatModifiers, Stat } from "@/game/types";
import { MOVE_SPECS, MONSTER_SPECS } from "@/game/data";

export function clamp(n: number, min: number, max: number) {
  return Math.max(min, Math.min(max, n));
}

const TYPE_CHART: Record<Element, Partial<Record<Element, number>>> = {
  normal: { rock: 0.5, ghost: 0, steel: 0.5 },
  fire: { fire: 0.5, water: 0.5, grass: 2, ice: 2, bug: 2, rock: 0.5, dragon: 0.5, steel: 2 },
  water: { fire: 2, water: 0.5, grass: 0.5, ground: 2, rock: 2, dragon: 0.5 },
  grass: { fire: 0.5, water: 2, grass: 0.5, poison: 0.5, ground: 2, flying: 0.5, bug: 0.5, rock: 2, dragon: 0.5, steel: 0.5 },
  electric: { water: 2, grass: 0.5, electric: 0.5, ground: 0, flying: 2, dragon: 0.5 },
  ice: { fire: 0.5, water: 0.5, grass: 2, ice: 0.5, ground: 2, flying: 2, dragon: 2, steel: 0.5 },
  fighting: { normal: 2, ice: 2, poison: 0.5, flying: 0.5, psychic: 0.5, bug: 0.5, rock: 2, ghost: 0, dark: 2, steel: 2, fairy: 0.5 },
  poison: { grass: 2, poison: 0.5, ground: 0.5, rock: 0.5, ghost: 0.5, steel: 0, fairy: 2 },
  ground: { fire: 2, water: 1, grass: 0.5, electric: 2, poison: 2, flying: 0, bug: 0.5, rock: 2, steel: 2 },
  flying: { grass: 2, electric: 0.5, fighting: 2, bug: 2, rock: 0.5, steel: 0.5 },
  psychic: { fighting: 2, poison: 2, psychic: 0.5, dark: 0, steel: 0.5 },
  bug: { fire: 0.5, grass: 2, fighting: 0.5, poison: 0.5, flying: 0.5, psychic: 2, ghost: 0.5, dark: 2, steel: 0.5, fairy: 0.5 },
  rock: { fire: 2, ice: 2, fighting: 0.5, ground: 0.5, flying: 2, bug: 2, steel: 0.5 },
  ghost: { normal: 0, psychic: 2, ghost: 2, dark: 0.5 },
  dragon: { dragon: 2, steel: 0.5, fairy: 0 },
  dark: { fighting: 0.5, psychic: 2, ghost: 2, dark: 0.5, fairy: 0.5 },
  steel: { fire: 0.5, water: 0.5, electric: 0.5, ice: 2, rock: 2, steel: 0.5, fairy: 2 },
  fairy: { fire: 0.5, fighting: 2, poison: 0.5, dragon: 2, dark: 2, steel: 0.5 }
};

export function effectiveness(attacking: Element, defending: Element) {
  return TYPE_CHART[attacking]?.[defending] ?? 1;
}

export function getStatMultiplier(stages: number) {
  const s = clamp(stages, -6, 6);
  if (s >= 0) {
    return (2 + s) / 2;
  } else {
    return 2 / (2 - s);
  }
}

export function statusMultiplier(status: Status) {
  if (status === "sleep") return 2;
  if (status === "paralyze") return 1.5;
  if (status === "burn") return 1.4;
  return 1;
}

export function roll(chance: number) {
  return Math.random() < chance;
}

export function computeDamage(
  attacker: MonsterInstance,
  defender: MonsterInstance,
  moveId: MoveId,
  attackerMods?: Record<string, number>,
  defenderMods?: Record<string, number>
) {
  const move = MOVE_SPECS[moveId];
  if (move.category === "status") {
    return { dmg: 0, eff: 1 };
  }
  
  const stab = attacker.element === move.element ? 1.5 : 1;
  const eff = effectiveness(move.element, defender.element);
  const variance = 0.85 + Math.random() * 0.15;
  
  let a = move.category === "physical" ? attacker.atk : attacker.spAtk;
  let d = move.category === "physical" ? defender.def : defender.spDef;
  
  // Apply modifiers
  if (attackerMods) {
    const statKey = move.category === "physical" ? "atk" : "spAtk";
    a = Math.floor(a * getStatMultiplier(attackerMods[statKey] ?? 0));
  }
  if (defenderMods) {
    const statKey = move.category === "physical" ? "def" : "spDef";
    d = Math.floor(d * getStatMultiplier(defenderMods[statKey] ?? 0));
  }
  
  // Apply Burn penalty to physical attack
  if (move.category === "physical" && attacker.status === "burn") {
    a = Math.floor(a / 2);
  }
  
  const levelFactor = (2 * attacker.level) / 5 + 2;
  const baseDmg = ((levelFactor * move.power * (a / Math.max(1, d))) / 50) + 2;
  
  // Crit
  const critChance = move.critChance ?? 0.05;
  const isCrit = roll(critChance);
  const critMod = isCrit ? 1.5 : 1;

  const dmg = Math.max(1, Math.floor(baseDmg * stab * eff * variance * critMod));
  return { dmg, eff, isCrit };
}

export function getSpeed(monster: MonsterInstance, mods?: Record<string, number>) {
  let spd = monster.spd;
  if (mods) {
    spd = Math.floor(spd * getStatMultiplier(mods.spd ?? 0));
  }
  if (monster.status === "paralyze") {
    spd = Math.floor(spd / 2);
  }
  return spd;
}

export function canMove(monster: MonsterInstance, log: string[]): { ok: boolean; nextStatus: Status } {
  if (monster.status === "freeze") {
    if (roll(0.2)) {
      log.push(`${MONSTER_SPECS[monster.specId].name} 的冰冻解除了！`);
      return { ok: true, nextStatus: "none" };
    }
    log.push(`${MONSTER_SPECS[monster.specId].name} 被冻住了，无法行动。`);
    return { ok: false, nextStatus: "freeze" };
  }
  if (monster.status === "sleep") {
    if (roll(0.33)) {
      log.push(`${MONSTER_SPECS[monster.specId].name} 醒来了！`);
      return { ok: true, nextStatus: "none" };
    }
    log.push(`${MONSTER_SPECS[monster.specId].name} 正在呼呼大睡。`);
    return { ok: false, nextStatus: "sleep" };
  }
  if (monster.status === "paralyze") {
    if (roll(0.25)) {
      log.push(`${MONSTER_SPECS[monster.specId].name} 因为麻痹无法行动。`);
      return { ok: false, nextStatus: "paralyze" };
    }
  }
  return { ok: true, nextStatus: monster.status };
}

export function applyDamage(target: MonsterInstance, dmg: number) {
  return { ...target, hp: clamp(target.hp - dmg, 0, target.maxHp) };
}

export function getAccuracyMultiplier(stages: number) {
  const s = clamp(stages, -6, 6);
  if (s >= 0) {
    return (3 + s) / 3;
  } else {
    return 3 / (3 - s);
  }
}

export function applyStatChanges(
  targetMods: StatModifiers,
  targetName: string,
  changes: { stat: Stat; stages: number; chance: number }[],
  log: string[]
): StatModifiers {
  const next = { ...targetMods };
  for (const c of changes) {
    if (!roll(c.chance)) continue;
    const old = next[c.stat];
    next[c.stat] = clamp(old + c.stages, -6, 6);
    if (next[c.stat] !== old) {
      const statName = { atk: "攻击", def: "防御", spAtk: "特攻", spDef: "特防", spd: "速度", accuracy: "命中", evasion: "闪避" }[c.stat];
      const direction = c.stages > 0 ? "提升了" : "降低了";
      log.push(`${targetName} 的${statName}${direction}！`);
    } else {
      const statName = { atk: "攻击", def: "防御", spAtk: "特攻", spDef: "特防", spd: "速度", accuracy: "命中", evasion: "闪避" }[c.stat];
      const direction = c.stages > 0 ? "无法再提升" : "无法再降低";
      log.push(`${targetName} 的${statName}已经${direction}。`);
    }
  }
  return next;
}

export function maybeInflictStatus(target: MonsterInstance, moveId: MoveId) {
  const move = MOVE_SPECS[moveId];
  if (!move.status) return target;
  if (target.status !== "none") return target;
  if (!roll(move.status.chance)) return target;
  return { ...target, status: move.status.type };
}

export function requiredExpForNextLevel(level: number) {
  return 16 + level * 18;
}

export function gainExp(monster: MonsterInstance, amount: number) {
  let next = { ...monster, exp: monster.exp + amount };
  let leveled = false;
  while (next.exp >= requiredExpForNextLevel(next.level)) {
    next = levelUp(next);
    leveled = true;
  }
  return { monster: next, leveled };
}

function remapByBounds(value: number, oldMin: number, oldMax: number, newMin: number, newMax: number) {
  if (oldMax <= oldMin) return newMin;
  const t = clamp((value - oldMin) / (oldMax - oldMin), 0, 1);
  return Math.round(newMin + t * (newMax - newMin));
}

export function evolveMonsterInstance(monster: MonsterInstance, targetSpecId: string): MonsterInstance {
  const fromSpec = MONSTER_SPECS[monster.specId];
  const toSpec = MONSTER_SPECS[targetSpecId];
  if (!toSpec) return { ...monster, pendingEvolution: undefined };

  const fromBounds = getMonsterStatBounds(fromSpec.id);
  const toBounds = getMonsterStatBounds(toSpec.id);

  const initStats = {
    hp: remapByBounds(monster.initStats.hp, fromBounds.initMin.hp, fromBounds.initMax.hp, toBounds.initMin.hp, toBounds.initMax.hp),
    atk: remapByBounds(monster.initStats.atk, fromBounds.initMin.atk, fromBounds.initMax.atk, toBounds.initMin.atk, toBounds.initMax.atk),
    def: remapByBounds(monster.initStats.def, fromBounds.initMin.def, fromBounds.initMax.def, toBounds.initMin.def, toBounds.initMax.def),
    spAtk: remapByBounds(monster.initStats.spAtk, fromBounds.initMin.spAtk, fromBounds.initMax.spAtk, toBounds.initMin.spAtk, toBounds.initMax.spAtk),
    spDef: remapByBounds(monster.initStats.spDef, fromBounds.initMin.spDef, fromBounds.initMax.spDef, toBounds.initMin.spDef, toBounds.initMax.spDef),
    spd: remapByBounds(monster.initStats.spd, fromBounds.initMin.spd, fromBounds.initMax.spd, toBounds.initMin.spd, toBounds.initMax.spd),
  };

  const growthRates = {
    hp: remapByBounds(monster.growthRates.hp, fromBounds.gMin.hp, fromBounds.gMax.hp, toBounds.gMin.hp, toBounds.gMax.hp),
    atk: remapByBounds(monster.growthRates.atk, fromBounds.gMin.atk, fromBounds.gMax.atk, toBounds.gMin.atk, toBounds.gMax.atk),
    def: remapByBounds(monster.growthRates.def, fromBounds.gMin.def, fromBounds.gMax.def, toBounds.gMin.def, toBounds.gMax.def),
    spAtk: remapByBounds(monster.growthRates.spAtk, fromBounds.gMin.spAtk, fromBounds.gMax.spAtk, toBounds.gMin.spAtk, toBounds.gMax.spAtk),
    spDef: remapByBounds(monster.growthRates.spDef, fromBounds.gMin.spDef, fromBounds.gMax.spDef, toBounds.gMin.spDef, toBounds.gMax.spDef),
    spd: remapByBounds(monster.growthRates.spd, fromBounds.gMin.spd, fromBounds.gMax.spd, toBounds.gMin.spd, toBounds.gMax.spd),
  };

  const levelups = Math.max(0, monster.level - 1);
  const maxHp = initStats.hp + growthRates.hp * levelups;
  const atk = initStats.atk + growthRates.atk * levelups;
  const def = initStats.def + growthRates.def * levelups;
  const spAtk = initStats.spAtk + growthRates.spAtk * levelups;
  const spDef = initStats.spDef + growthRates.spDef * levelups;
  const spd = initStats.spd + growthRates.spd * levelups;

  const hpRatio = monster.maxHp > 0 ? monster.hp / monster.maxHp : 1;
  const hp = monster.hp <= 0 ? 0 : clamp(Math.round(hpRatio * maxHp), 1, maxHp);

  const learned = Array.from(new Set(toSpec.learnset.filter((x) => x.level === monster.level).map((x) => x.moveId)));
  const moveIds = [...monster.moveIds];
  const pendingMoves = [...(monster.pendingMoves ?? [])];
  for (const m of learned) {
    if (!moveIds.includes(m) && !pendingMoves.includes(m)) {
      if (moveIds.length < 4) {
        moveIds.push(m);
      } else {
        pendingMoves.push(m);
      }
    }
  }

  return {
    ...monster,
    specId: toSpec.id,
    element: toSpec.element,
    initStats,
    growthRates,
    maxHp,
    hp,
    atk,
    def,
    spAtk,
    spDef,
    spd,
    moveIds: Array.from(new Set(moveIds)),
    pendingMoves,
    pendingEvolution: undefined,
  };
}

export function uuid() {
  return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
}

export function levelUp(monster: MonsterInstance) {
  const spec = MONSTER_SPECS[monster.specId];
  const level = monster.level + 1;
  const growth = monster.growthRates;

  const maxHp = monster.maxHp + growth.hp;
  const atk = monster.atk + growth.atk;
  const def = monster.def + growth.def;
  const spAtk = monster.spAtk + growth.spAtk;
  const spDef = monster.spDef + growth.spDef;
  const spd = monster.spd + growth.spd;

  const learned = Array.from(new Set(spec.learnset.filter((x) => x.level === level).map((x) => x.moveId)));
  const moveIds = [...monster.moveIds];
  const pendingMoves = [...(monster.pendingMoves ?? [])];
  
  for (const m of learned) {
    if (!moveIds.includes(m) && !pendingMoves.includes(m)) {
      if (moveIds.length < 4) {
        moveIds.push(m);
      } else {
        pendingMoves.push(m);
      }
    }
  }

  const evo = spec.evolutions?.find((e) => e.condition.type === "level" && e.condition.level === level);
  const pendingEvolution = evo ? { targetId: evo.targetId, condition: evo.condition } : undefined;
  
  return {
    ...monster,
    level,
    maxHp,
    hp: monster.hp + growth.hp, // Heal the gained max HP
    atk,
    def,
    spAtk,
    spDef,
    spd,
    exp: 0,
    moveIds,
    pendingMoves,
    pendingEvolution,
  };
}

export function getMonsterStatBounds(specId: string) {
  const spec = MONSTER_SPECS[specId];

  const initMin: StatBlock = {
    hp: Math.floor(spec.baseHp + 3.2),
    atk: Math.floor(spec.baseAtk + 2.3),
    def: Math.floor(spec.baseDef + 2.0),
    spAtk: Math.floor(spec.baseSpAtk + 2.3),
    spDef: Math.floor(spec.baseSpDef + 2.0),
    spd: Math.floor(spec.baseSpd + 2.0),
  };

  const initMax = spec.initStatsMax ?? {
    hp: initMin.hp + 5,
    atk: initMin.atk + 4,
    def: initMin.def + 4,
    spAtk: initMin.spAtk + 4,
    spDef: initMin.spDef + 4,
    spd: initMin.spd + 4,
  };

  const gMin = spec.growthPerLevel?.min ?? { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 };
  const gMax = spec.growthPerLevel?.max ?? {
    hp: 4,
    atk: spec.baseAtk >= 70 ? 3 : 2,
    def: spec.baseDef >= 80 ? 4 : 2,
    spAtk: spec.baseSpAtk >= 70 ? 3 : 2,
    spDef: spec.baseSpDef >= 80 ? 4 : 2,
    spd: spec.baseSpd >= 60 ? 3 : 2,
  };

  return { initMin, initMax, gMin, gMax };
}

export function createInstance(specId: string, level: number, forceShiny?: boolean, forceInitMax?: boolean, forceGrowthMax?: boolean): MonsterInstance {
  const spec = MONSTER_SPECS[specId];

  const bounds = getMonsterStatBounds(specId);

  // 随机生成初始六维 (1级时的数值)
  const initStats: StatBlock = {
    hp: forceInitMax ? bounds.initMax.hp : bounds.initMin.hp + Math.floor(Math.random() * (bounds.initMax.hp - bounds.initMin.hp + 1)),
    atk: forceInitMax ? bounds.initMax.atk : bounds.initMin.atk + Math.floor(Math.random() * (bounds.initMax.atk - bounds.initMin.atk + 1)),
    def: forceInitMax ? bounds.initMax.def : bounds.initMin.def + Math.floor(Math.random() * (bounds.initMax.def - bounds.initMin.def + 1)),
    spAtk: forceInitMax ? bounds.initMax.spAtk : bounds.initMin.spAtk + Math.floor(Math.random() * (bounds.initMax.spAtk - bounds.initMin.spAtk + 1)),
    spDef: forceInitMax ? bounds.initMax.spDef : bounds.initMin.spDef + Math.floor(Math.random() * (bounds.initMax.spDef - bounds.initMin.spDef + 1)),
    spd: forceInitMax ? bounds.initMax.spd : bounds.initMin.spd + Math.floor(Math.random() * (bounds.initMax.spd - bounds.initMin.spd + 1)),
  };

  // 随机生成此宠物的固定成长潜能
  const growthRates: StatBlock = {
    hp: forceGrowthMax ? bounds.gMax.hp : bounds.gMin.hp + Math.floor(Math.random() * (bounds.gMax.hp - bounds.gMin.hp + 1)),
    atk: forceGrowthMax ? bounds.gMax.atk : bounds.gMin.atk + Math.floor(Math.random() * (bounds.gMax.atk - bounds.gMin.atk + 1)),
    def: forceGrowthMax ? bounds.gMax.def : bounds.gMin.def + Math.floor(Math.random() * (bounds.gMax.def - bounds.gMin.def + 1)),
    spAtk: forceGrowthMax ? bounds.gMax.spAtk : bounds.gMin.spAtk + Math.floor(Math.random() * (bounds.gMax.spAtk - bounds.gMin.spAtk + 1)),
    spDef: forceGrowthMax ? bounds.gMax.spDef : bounds.gMin.spDef + Math.floor(Math.random() * (bounds.gMax.spDef - bounds.gMin.spDef + 1)),
    spd: forceGrowthMax ? bounds.gMax.spd : bounds.gMin.spd + Math.floor(Math.random() * (bounds.gMax.spd - bounds.gMin.spd + 1)),
  };

  // 如果生成时大于 1 级，累加成长值
  const levelups = Math.max(0, level - 1);
  const maxHp = initStats.hp + growthRates.hp * levelups;
  const atk = initStats.atk + growthRates.atk * levelups;
  const def = initStats.def + growthRates.def * levelups;
  const spAtk = initStats.spAtk + growthRates.spAtk * levelups;
  const spDef = initStats.spDef + growthRates.spDef * levelups;
  const spd = initStats.spd + growthRates.spd * levelups;

  const validMoves = Array.from(new Set(spec.learnset
    .filter((x) => x.level <= level)
    .map((x) => x.moveId)));

  const moveIds = validMoves.slice(-4);
  console.log("createInstance moveIds for", spec.name, ":", moveIds);

  return {
    id: uuid(),
    specId: spec.id,
    level,
    exp: 0,
    element: spec.element,
    maxHp,
    hp: maxHp,
    atk,
    def,
    spAtk,
    spDef,
    spd,
    status: "none",
    moveIds,
    initStats,
    growthRates,
    pendingMoves: [],
    isShiny: forceShiny !== undefined ? forceShiny : Math.random() < 0.01,
  };
}

export function captureChance(enemy: MonsterInstance, baseRate: number, deviceModifier: number) {
  const hpFactor = (3 * enemy.maxHp - 2 * enemy.hp) / (3 * enemy.maxHp);
  const chance = baseRate * hpFactor * statusMultiplier(enemy.status) * deviceModifier;
  return clamp(chance, 0.02, 0.95);
}

export function attemptCapture(enemy: MonsterInstance, baseRate: number, deviceModifier: number) {
  const chance = captureChance(enemy, baseRate, deviceModifier);
  const shakes = chance > 0.7 ? 3 : chance > 0.45 ? 2 : 1;
  const ok = roll(chance);
  return { ok, chance, shakes };
}
