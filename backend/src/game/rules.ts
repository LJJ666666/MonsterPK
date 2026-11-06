/**
 * 服务端战斗规则（P3-1）。
 *
 * 与前端 `src/game/rules.ts` 的公式**逐项对齐**（伤害、命中、暴击、速度、PP、捕获率、升级），
 * 差别只有两点：
 *   1. 所有随机源改为注入的 `Rng`，服务端可以复现、可以测试，客户端无法影响；
 *   2. 数值与内容（技能威力、克制、捕获率）全部来自服务端内容表，不采信客户端上报。
 *
 * `tests/battleRules.test.ts` 会直接 import 前端 rules.ts 做公式一致性对照，
 * 任何一侧改了公式而另一侧没跟上，测试会立刻失败。
 */
import {
  MONSTER_SPECS, MOVE_SPECS, effectiveness,
  type ServerMonster, type StatModifiers, type StatBlock, type StatusType, type StatKey,
} from './content.js';

export type Rng = () => number;

// 克制表查询直接复用内容层实现（与前端 rules.ts::effectiveness 同逻辑）。
export { effectiveness };

/** 真随机源：服务端结算默认用它，测试传种子函数。 */
export const defaultRng: Rng = () => Math.random();

export function clamp(n: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, n));
}

export function roll(chance: number, rng: Rng): boolean {
  return rng() < chance;
}

export function getStatMultiplier(stages: number): number {
  const s = clamp(stages, -6, 6);
  if (s >= 0) return (2 + s) / 2;
  return 2 / (2 - s);
}

export function getAccuracyMultiplier(stages: number): number {
  const s = clamp(stages, -6, 6);
  if (s >= 0) return (3 + s) / 3;
  return 3 / (3 - s);
}

export function statusMultiplier(status: StatusType): number {
  if (status === 'sleep' || status === 'freeze') return 2;
  if (status === 'paralyze') return 1.5;
  if (status === 'burn' || status === 'poison') return 1.4;
  return 1;
}

export function getMoveMaxPP(moveId: string): number {
  const move = MOVE_SPECS[moveId];
  if (!move) return 10;
  if (typeof move.pp === 'number') return move.pp;
  if (move.category === 'status') return 15;
  const power = move.power;
  if (power <= 30) return 30;
  if (power <= 50) return 25;
  if (power <= 70) return 20;
  if (power <= 90) return 15;
  if (power <= 110) return 10;
  return 5;
}

/** 战斗开始时按技能表建立每只幻兽的 PP。 */
export function initBattlePP(monsters: ServerMonster[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const m of monsters) {
    const pp: Record<string, number> = {};
    for (const moveId of m.moveIds ?? []) pp[moveId] = getMoveMaxPP(moveId);
    out[m.id] = pp;
  }
  return out;
}

/** 敌方 AI：从还有 PP 的技能里随机挑一个；全空则返回 null。 */
export function pickUsableMove(monster: ServerMonster, pp: Record<string, number> | undefined, rng: Rng): string | null {
  const usable = (monster.moveIds ?? []).filter((id) => (pp?.[id] ?? 0) > 0);
  if (usable.length === 0) return null;
  return usable[Math.floor(rng() * usable.length)];
}

export function computeDamage(
  attacker: ServerMonster,
  defender: ServerMonster,
  moveId: string,
  rng: Rng,
  attackerMods?: StatModifiers,
  defenderMods?: StatModifiers,
): { dmg: number; eff: number; isCrit: boolean } {
  const move = MOVE_SPECS[moveId];
  if (!move || move.category === 'status') return { dmg: 0, eff: 1, isCrit: false };

  const stab = attacker.element === move.element ? 1.5 : 1;
  const eff = effectiveness(move.element, defender.element);
  const variance = 0.85 + rng() * 0.15;

  let a = move.category === 'physical' ? attacker.atk : attacker.spAtk;
  let d = move.category === 'physical' ? defender.def : defender.spDef;

  if (attackerMods) {
    const statKey: StatKey = move.category === 'physical' ? 'atk' : 'spAtk';
    a = Math.floor(a * getStatMultiplier(attackerMods[statKey] ?? 0));
  }
  if (defenderMods) {
    const statKey: StatKey = move.category === 'physical' ? 'def' : 'spDef';
    d = Math.floor(d * getStatMultiplier(defenderMods[statKey] ?? 0));
  }

  if (move.category === 'physical' && attacker.status === 'burn') a = Math.floor(a / 2);

  const levelFactor = (2 * attacker.level) / 5 + 2;
  const baseDmg = (levelFactor * move.power * (a / Math.max(1, d))) / 50 + 2;

  const critChance = move.critChance ?? 0.05;
  const isCrit = roll(critChance, rng);
  const critMod = isCrit ? 1.5 : 1;

  const dmg = Math.max(1, Math.floor(baseDmg * stab * eff * variance * critMod));
  return { dmg, eff, isCrit };
}

export function getSpeed(monster: ServerMonster, mods?: StatModifiers): number {
  let spd = monster.spd;
  if (mods) spd = Math.floor(spd * getStatMultiplier(mods.spd ?? 0));
  if (monster.status === 'paralyze') spd = Math.floor(spd / 2);
  return spd;
}

export function applyDamage(target: ServerMonster, dmg: number): ServerMonster {
  return { ...target, hp: clamp(target.hp - dmg, 0, target.maxHp) };
}

export function alive(monster: ServerMonster | undefined | null): boolean {
  return !!monster && monster.hp > 0;
}

export function findFirstAliveIndex(party: ServerMonster[]): number {
  return party.findIndex((m) => alive(m));
}

const STAT_LABEL: Record<StatKey, string> = {
  atk: '攻击', def: '防御', spAtk: '特攻', spDef: '特防', spd: '速度', accuracy: '命中', evasion: '闪避',
};

export function applyStatChanges(
  targetMods: StatModifiers,
  targetName: string,
  changes: Array<{ stat: StatKey; stages: number; chance: number }>,
  log: string[],
  rng: Rng,
): StatModifiers {
  const next = { ...targetMods };
  for (const c of changes) {
    if (!roll(c.chance, rng)) continue;
    const old = next[c.stat] ?? 0;
    next[c.stat] = clamp(old + c.stages, -6, 6);
    const name = STAT_LABEL[c.stat];
    if (next[c.stat] !== old) {
      log.push(`${targetName} 的${name}${c.stages > 0 ? '提升了' : '降低了'}！`);
    } else {
      log.push(`${targetName} 的${name}已经${c.stages > 0 ? '无法再提升' : '无法再降低'}。`);
    }
  }
  return next;
}

/** 行动前的状态判定（冰冻/睡眠/麻痹）。返回 ok=false 表示本回合无法行动。 */
export function canMove(monster: ServerMonster, log: string[], rng: Rng): { ok: boolean; nextStatus: StatusType } {
  const name = MONSTER_SPECS[monster.specId]?.name ?? monster.specId;
  if (monster.status === 'freeze') {
    if (roll(0.2, rng)) {
      log.push(`${name} 的冰冻解除了！`);
      return { ok: true, nextStatus: 'none' };
    }
    log.push(`${name} 被冻住了，无法行动。`);
    return { ok: false, nextStatus: 'freeze' };
  }
  if (monster.status === 'sleep') {
    if (roll(0.33, rng)) {
      log.push(`${name} 醒来了！`);
      return { ok: true, nextStatus: 'none' };
    }
    log.push(`${name} 正在呼呼大睡。`);
    return { ok: false, nextStatus: 'sleep' };
  }
  if (monster.status === 'paralyze') {
    if (roll(0.25, rng)) {
      log.push(`${name} 因为麻痹无法行动。`);
      return { ok: false, nextStatus: 'paralyze' };
    }
  }
  return { ok: true, nextStatus: monster.status };
}

function effLine(eff: number): string {
  if (eff >= 2) return '效果拔群！';
  if (eff <= 0.6) return '效果不太理想。';
  if (eff > 1.05 && eff < 2) return '有点克制。';
  return '';
}

function statusLine(next: StatusType, prev: StatusType): string {
  if (next === prev) return '';
  if (next === 'burn') return '被灼伤了。';
  if (next === 'paralyze') return '麻痹了。';
  if (next === 'sleep') return '睡着了。';
  if (next === 'freeze') return '被冻住了。';
  if (next === 'poison') return '中毒了。';
  return '';
}

export type MoveResult = {
  nextAttacker: ServerMonster;
  nextDefender: ServerMonster;
  nextAttackerMods: StatModifiers;
  nextDefenderMods: StatModifiers;
  logs: string[];
  flinch: boolean;
};

/** 执行一次完整招式：命中判定 → 伤害/多段/暴击/吸血 → 异常 → 能力变化。 */
export function executeMoveAction(
  attacker: ServerMonster,
  defender: ServerMonster,
  attackerMods: StatModifiers,
  defenderMods: StatModifiers,
  moveId: string,
  rng: Rng,
  testOHKO = false,
): MoveResult {
  const move = MOVE_SPECS[moveId];
  const logs: string[] = [];
  let flinch = false;
  if (!move) {
    logs.push('使用了一个未知技能。');
    return { nextAttacker: attacker, nextDefender: defender, nextAttackerMods: attackerMods, nextDefenderMods: defenderMods, logs, flinch };
  }

  const attackerName = MONSTER_SPECS[attacker.specId]?.name ?? attacker.specId;
  const hit = roll(move.accuracy * getAccuracyMultiplier((attackerMods.accuracy ?? 0) - (defenderMods.evasion ?? 0)), rng);
  if (!hit) {
    logs.push(`${attackerName} 的攻击落空了。`);
    return { nextAttacker: attacker, nextDefender: defender, nextAttackerMods: attackerMods, nextDefenderMods: defenderMods, logs, flinch };
  }

  let dmg = 0;
  const nextAttacker = { ...attacker };

  if (move.category !== 'status') {
    let hits = 1;
    if (move.multiHit) hits = move.multiHit[0] + Math.floor(rng() * (move.multiHit[1] - move.multiHit[0] + 1));

    let totalDmg = 0;
    let anyCrit = false;
    let eff = 1;
    for (let i = 0; i < hits; i++) {
      const res = computeDamage(attacker, defender, moveId, rng, attackerMods, defenderMods);
      totalDmg += res.dmg;
      eff = res.eff;
      if (res.isCrit) anyCrit = true;
    }

    dmg = totalDmg;
    if (testOHKO) dmg = defender.hp;

    logs.push(`${attackerName} 使用了 ${move.name}，造成 ${dmg} 点伤害。`);
    if (hits > 1) logs.push(`击中了 ${hits} 次！`);
    if (anyCrit) logs.push('击中了要害！');
    if (eff !== 1) {
      const line = effLine(eff);
      if (line) logs.push(line);
    }

    if (move.healPct && dmg > 0) {
      const healAmt = Math.max(1, Math.floor(dmg * move.healPct));
      nextAttacker.hp = Math.min(nextAttacker.maxHp, nextAttacker.hp + healAmt);
      logs.push(`${MONSTER_SPECS[nextAttacker.specId]?.name ?? nextAttacker.specId} 吸取了体力！`);
    }

    if (move.flinchChance && roll(move.flinchChance, rng)) flinch = true;
  } else {
    logs.push(`${attackerName} 使用了 ${move.name}。`);
  }

  const nextDefender = applyDamage(defender, dmg);
  let nextAttackerMods = { ...attackerMods };
  let nextDefenderMods = { ...defenderMods };

  if (move.status && nextDefender.hp > 0 && nextDefender.status === 'none' && roll(move.status.chance, rng)) {
    if (move.status.target === 'self') {
      if (nextAttacker.status === 'none') {
        nextAttacker.status = move.status.type;
        logs.push(`${MONSTER_SPECS[nextAttacker.specId]?.name ?? nextAttacker.specId} ${statusLine(nextAttacker.status, 'none')}`);
      }
    } else {
      nextDefender.status = move.status.type;
      logs.push(`${MONSTER_SPECS[nextDefender.specId]?.name ?? nextDefender.specId} ${statusLine(nextDefender.status, 'none')}`);
    }
  }

  if (move.statChanges) {
    for (const c of move.statChanges) {
      const isSelf = c.target === 'self';
      if (isSelf && nextAttacker.hp > 0) {
        nextAttackerMods = applyStatChanges(nextAttackerMods, MONSTER_SPECS[nextAttacker.specId]?.name ?? nextAttacker.specId, [c], logs, rng);
      } else if (!isSelf && nextDefender.hp > 0) {
        nextDefenderMods = applyStatChanges(nextDefenderMods, MONSTER_SPECS[nextDefender.specId]?.name ?? nextDefender.specId, [c], logs, rng);
      }
    }
  }

  return { nextAttacker, nextDefender, nextAttackerMods, nextDefenderMods, logs, flinch };
}

/** 回合末：烧伤 / 中毒持续伤害（双方各结算一次）。 */
export function processEndOfTurn(
  party: ServerMonster[],
  activeIdx: number,
  enemy: ServerMonster,
): { nextParty: ServerMonster[]; nextEnemy: ServerMonster; logs: string[] } {
  const logs: string[] = [];
  const nextParty = [...party];
  let nextEnemy = { ...enemy };
  let player = nextParty[activeIdx];

  if (player && player.hp > 0) {
    if (player.status === 'burn') {
      player = applyDamage(player, Math.max(1, Math.floor(player.maxHp / 16)));
      logs.push(`${MONSTER_SPECS[player.specId]?.name ?? player.specId} 受到烧伤伤害。`);
    } else if (player.status === 'poison') {
      player = applyDamage(player, Math.max(1, Math.floor(player.maxHp / 8)));
      logs.push(`${MONSTER_SPECS[player.specId]?.name ?? player.specId} 受到中毒伤害。`);
    }
    nextParty[activeIdx] = player;
  }

  if (nextEnemy.hp > 0) {
    if (nextEnemy.status === 'burn') {
      nextEnemy = applyDamage(nextEnemy, Math.max(1, Math.floor(nextEnemy.maxHp / 16)));
      logs.push(`${MONSTER_SPECS[nextEnemy.specId]?.name ?? nextEnemy.specId} 受到烧伤伤害。`);
    } else if (nextEnemy.status === 'poison') {
      nextEnemy = applyDamage(nextEnemy, Math.max(1, Math.floor(nextEnemy.maxHp / 8)));
      logs.push(`${MONSTER_SPECS[nextEnemy.specId]?.name ?? nextEnemy.specId} 受到中毒伤害。`);
    }
  }

  return { nextParty, nextEnemy, logs };
}

// —— 成长：升级 / 经验（结算时服务端自己算，客户端不再决定升几级）——

export function requiredExpForNextLevel(level: number): number {
  return 16 + level * 18;
}

export function levelUp(monster: ServerMonster): ServerMonster {
  const spec = MONSTER_SPECS[monster.specId];
  const level = monster.level + 1;
  const g = monster.growthRates;

  const maxHp = monster.maxHp + g.hp;
  const learned = spec
    ? Array.from(new Set(spec.learnset.filter((x) => x.level === level).map((x) => x.moveId)))
    : [];
  const moveIds = [...(monster.moveIds ?? [])];
  const pendingMoves = [...(monster.pendingMoves ?? [])];
  for (const m of learned) {
    if (moveIds.includes(m) || pendingMoves.includes(m)) continue;
    if (moveIds.length < 4) moveIds.push(m);
    else pendingMoves.push(m);
  }

  const evo = spec?.evolutions?.find(
    (e: any) => e.condition?.type === 'level' && e.condition?.level === level,
  );

  return {
    ...monster,
    level,
    maxHp,
    hp: monster.hp + g.hp,
    atk: monster.atk + g.atk,
    def: monster.def + g.def,
    spAtk: monster.spAtk + g.spAtk,
    spDef: monster.spDef + g.spDef,
    spd: monster.spd + g.spd,
    exp: 0,
    moveIds,
    pendingMoves,
    pendingEvolution: evo ? { targetId: evo.targetId, condition: evo.condition } : undefined,
  };
}

export function gainExp(monster: ServerMonster, amount: number): { monster: ServerMonster; leveled: boolean } {
  let next = { ...monster, exp: monster.exp + amount };
  let leveled = false;
  let guard = 0;
  while (next.exp >= requiredExpForNextLevel(next.level) && guard < 100) {
    next = levelUp(next);
    leveled = true;
    guard += 1;
  }
  return { monster: next, leveled };
}

// —— 遭遇生成：敌方全由服务端掷，客户端只收结果 ——

export function getMonsterStatBounds(specId: string): {
  initMin: StatBlock; initMax: StatBlock; gMin: StatBlock; gMax: StatBlock;
} {
  const spec = MONSTER_SPECS[specId];
  const initMin: StatBlock = {
    hp: Math.floor(spec.baseHp + 3.2),
    atk: Math.floor(spec.baseAtk + 2.3),
    def: Math.floor(spec.baseDef + 2.0),
    spAtk: Math.floor(spec.baseSpAtk + 2.3),
    spDef: Math.floor(spec.baseSpDef + 2.0),
    spd: Math.floor(spec.baseSpd + 2.0),
  };
  const initMax: StatBlock = spec.initStatsMax ?? {
    hp: initMin.hp + 5, atk: initMin.atk + 4, def: initMin.def + 4,
    spAtk: initMin.spAtk + 4, spDef: initMin.spDef + 4, spd: initMin.spd + 4,
  };
  const gMin: StatBlock = spec.growthPerLevel?.min ?? { hp: 2, atk: 1, def: 1, spAtk: 1, spDef: 1, spd: 1 };
  const gMax: StatBlock = spec.growthPerLevel?.max ?? {
    hp: 4,
    atk: spec.baseAtk >= 70 ? 3 : 2,
    def: spec.baseDef >= 80 ? 4 : 2,
    spAtk: spec.baseSpAtk >= 70 ? 3 : 2,
    spDef: spec.baseSpDef >= 80 ? 4 : 2,
    spd: spec.baseSpd >= 60 ? 3 : 2,
  };
  return { initMin, initMax, gMin, gMax };
}

function randInt(min: number, max: number, rng: Rng): number {
  return min + Math.floor(rng() * (max - min + 1));
}

/** 生成一个幻兽个体（服务端权威；与前端 createInstance 同公式、同随机顺序）。 */
export function createInstance(
  specId: string,
  level: number,
  rng: Rng,
  opts: { forceShiny?: boolean; forceInitMax?: boolean; forceGrowthMax?: boolean; id?: string } = {},
): ServerMonster {
  const spec = MONSTER_SPECS[specId];
  if (!spec) throw new Error(`未知幻兽：${specId}`);
  const bounds = getMonsterStatBounds(specId);

  const initStats: StatBlock = {
    hp: opts.forceInitMax ? bounds.initMax.hp : randInt(bounds.initMin.hp, bounds.initMax.hp, rng),
    atk: opts.forceInitMax ? bounds.initMax.atk : randInt(bounds.initMin.atk, bounds.initMax.atk, rng),
    def: opts.forceInitMax ? bounds.initMax.def : randInt(bounds.initMin.def, bounds.initMax.def, rng),
    spAtk: opts.forceInitMax ? bounds.initMax.spAtk : randInt(bounds.initMin.spAtk, bounds.initMax.spAtk, rng),
    spDef: opts.forceInitMax ? bounds.initMax.spDef : randInt(bounds.initMin.spDef, bounds.initMax.spDef, rng),
    spd: opts.forceInitMax ? bounds.initMax.spd : randInt(bounds.initMin.spd, bounds.initMax.spd, rng),
  };

  const growthRates: StatBlock = {
    hp: opts.forceGrowthMax ? bounds.gMax.hp : randInt(bounds.gMin.hp, bounds.gMax.hp, rng),
    atk: opts.forceGrowthMax ? bounds.gMax.atk : randInt(bounds.gMin.atk, bounds.gMax.atk, rng),
    def: opts.forceGrowthMax ? bounds.gMax.def : randInt(bounds.gMin.def, bounds.gMax.def, rng),
    spAtk: opts.forceGrowthMax ? bounds.gMax.spAtk : randInt(bounds.gMin.spAtk, bounds.gMax.spAtk, rng),
    spDef: opts.forceGrowthMax ? bounds.gMax.spDef : randInt(bounds.gMin.spDef, bounds.gMax.spDef, rng),
    spd: opts.forceGrowthMax ? bounds.gMax.spd : randInt(bounds.gMin.spd, bounds.gMax.spd, rng),
  };

  const levelups = Math.max(0, level - 1);
  const maxHp = initStats.hp + growthRates.hp * levelups;

  const validMoves = Array.from(new Set(
    spec.learnset.filter((x) => x.level <= level).map((x) => x.moveId),
  ));
  const moveIds = validMoves.slice(-4);
  const isShiny = opts.forceShiny !== undefined ? opts.forceShiny : rng() < 0.01;

  return {
    id: opts.id ?? `wild_${Math.floor(rng() * 1e12).toString(36)}_${Date.now().toString(36)}`,
    specId: spec.id,
    level,
    exp: 0,
    element: spec.element,
    maxHp,
    hp: maxHp,
    atk: initStats.atk + growthRates.atk * levelups,
    def: initStats.def + growthRates.def * levelups,
    spAtk: initStats.spAtk + growthRates.spAtk * levelups,
    spDef: initStats.spDef + growthRates.spDef * levelups,
    spd: initStats.spd + growthRates.spd * levelups,
    status: 'none',
    moveIds,
    initStats,
    growthRates,
    pendingMoves: [],
    isShiny,
  };
}

// —— 捕获：基础率来自服务端内容表，客户端只报「用哪个球」 ——

export function captureChance(enemy: ServerMonster, baseRate: number, deviceModifier: number): number {
  const hpFactor = (3 * enemy.maxHp - 2 * enemy.hp) / (3 * enemy.maxHp);
  const chance = baseRate * hpFactor * statusMultiplier(enemy.status) * deviceModifier;
  return clamp(chance, 0.02, 0.95);
}

export function attemptCapture(
  enemy: ServerMonster,
  baseRate: number,
  deviceModifier: number,
  rng: Rng,
): { ok: boolean; chance: number; shakes: number } {
  const chance = captureChance(enemy, baseRate, deviceModifier);
  const shakes = chance > 0.7 ? 3 : chance > 0.45 ? 2 : 1;
  return { ok: roll(chance, rng), chance, shakes };
}
