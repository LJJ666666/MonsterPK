/**
 * L2 简化战斗引擎（演示包专用，主工程零改动）。
 *
 * 边界（见 demo-app/README.md「深度路线」）：
 *  - 只复用主工程**前端纯函数** `@/game/rules` / `@/game/data` / `@/game/gen`，
 *    绝不 import 后端模块、绝不发网络请求、绝不写 localStorage；
 *  - 战斗真值是本模块的内存态，退出进程即丢弃（与 L1 固定存档契约一致）；
 *  - 目标只是「点技能能真打一场」：技能 / PP / 命中 / 伤害 / 异常 / 换人 /
 *    捕获 / 逃跑 / 敌方回合 / 胜负奖励日志都真实推进，但不做服务端的
 *    发奖落档、徽章 / CD / 去重 / 排行榜等权威逻辑（那是 L3 / 方案 C）。
 *
 * 视图形状与 `src/lib/battleApi.ts::ServerBattleView` 一一对应，
 * 这样主工程 `toBattleState()` 无需改动即可渲染。
 */
import {
  ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS, THEME_TABLE,
} from '@/game/data';
import {
  applyDamage, canMove, clamp, computeDamage, createInstance, gainExp,
  getAccuracyMultiplier, getMoveMaxPP, getSpeed, roll,
} from '@/game/rules';
import type {
  ItemId, MonsterInstance, MoveId, StatModifiers, Status,
} from '@/game/types';

export type DemoBattleResult = 'captured' | 'enemy_fainted' | 'fled' | 'player_fainted';

export type DemoBattle = {
  battleId: string;
  turn: number;
  finished: boolean;
  result: DemoBattleResult | null;
  log: string[];
  areaName: string;
  theme: string;
  areaId: string | null;
  levelMin: number;
  levelMax: number;
  playerActiveIndex: number;
  playerMods: StatModifiers;
  enemyMods: StatModifiers;
  enemy: MonsterInstance;
  party: MonsterInstance[];
  ppByMonster: Record<string, Record<string, number>>;
  rewards: { expGain: number; moneyGain: number } | null;
  captured: MonsterInstance | null;
  consumed: Record<string, number>;
  actions: number;
  bossId: string | null;
  bossName: string | null;
  damageDealt: number;
  gymId: string | null;
  mapBossId: string | null;
};

export type DemoAction =
  | { type: 'move'; moveId: MoveId }
  | { type: 'item'; itemId: ItemId }
  | { type: 'capture'; itemId: ItemId }
  | { type: 'switch'; partyIndex: number }
  | { type: 'flee' };

export class DemoBattleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_LOG = 200;
const emptyMods = (): StatModifiers => ({
  atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0,
});
const nameOf = (m: MonsterInstance) => MONSTER_SPECS[m.specId]?.name ?? m.specId;
const alive = (m: MonsterInstance | undefined | null) => !!m && m.hp > 0;
const firstAlive = (party: MonsterInstance[]) => party.findIndex(alive);
const pushLog = (s: DemoBattle, lines: string[]) => {
  const all = [...s.log, ...lines];
  s.log = all.length > MAX_LOG ? all.slice(all.length - MAX_LOG) : all;
};

function initPP(monsters: MonsterInstance[]): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  for (const m of monsters) {
    const pp: Record<string, number> = {};
    for (const id of m.moveIds ?? []) pp[id] = getMoveMaxPP(id);
    out[m.id] = pp;
  }
  return out;
}

function pickEnemyMove(m: MonsterInstance, pp: Record<string, number> | undefined): MoveId | null {
  const usable = (m.moveIds ?? []).filter((id) => (pp?.[id] ?? 0) > 0);
  return usable.length ? usable[Math.floor(Math.random() * usable.length)] : null;
}

function partyAvgLevel(party: MonsterInstance[]): number {
  if (!party.length) return 1;
  return Math.max(1, Math.round(party.reduce((a, m) => a + m.level, 0) / party.length));
}

function effLine(eff: number): string {
  if (eff >= 2) return '效果拔群！';
  if (eff <= 0.6) return '效果不太理想。';
  if (eff > 1.05 && eff < 2) return '有点克制。';
  return '';
}

const STATUS_LINE: Partial<Record<Status, string>> = {
  burn: '被灼伤了。', paralyze: '麻痹了。', sleep: '睡着了。',
  freeze: '被冻住了。', poison: '中毒了。',
};

/** 执行一次招式：命中 → 伤害 / 多段 / 吸血 / 反伤 → 异常 → 能力变化。 */
function executeMove(
  attacker: MonsterInstance,
  defender: MonsterInstance,
  attackerMods: StatModifiers,
  defenderMods: StatModifiers,
  moveId: MoveId,
  log: string[],
): {
  attacker: MonsterInstance; defender: MonsterInstance;
  attackerMods: StatModifiers; defenderMods: StatModifiers; flinch: boolean;
} {
  const move = MOVE_SPECS[moveId];
  let a = { ...attacker };
  let d = { ...defender };
  let aMods = { ...attackerMods };
  let dMods = { ...defenderMods };
  let flinch = false;
  if (!move) {
    log.push('使用了一个未知技能。');
    return { attacker: a, defender: d, attackerMods: aMods, defenderMods: dMods, flinch };
  }

  const hitChance = move.accuracy * getAccuracyMultiplier((aMods.accuracy ?? 0) - (dMods.evasion ?? 0));
  if (!roll(clamp(hitChance, 0, 1))) {
    log.push(`${nameOf(a)} 的攻击落空了。`);
    return { attacker: a, defender: d, attackerMods: aMods, defenderMods: dMods, flinch };
  }

  let total = 0;
  let anyCrit = false;
  let mainEff = 1;
  if (move.category !== 'status') {
    const hits = move.multiHit
      ? move.multiHit[0] + Math.floor(Math.random() * (move.multiHit[1] - move.multiHit[0] + 1))
      : 1;
    for (let i = 0; i < hits; i += 1) {
      const res = computeDamage(a, d, moveId, aMods, dMods);
      total += res.dmg;
      mainEff = res.eff;
      if (res.isCrit) anyCrit = true;
    }
    log.push(`${nameOf(a)} 使用了 ${move.name}，造成 ${total} 点伤害。`);
    if (hits > 1) log.push(`击中了 ${hits} 次！`);
    if (anyCrit) log.push('击中了要害！');
    const effText = effLine(mainEff);
    if (effText) log.push(effText);

    if (move.healPct && total > 0) {
      a = { ...a, hp: Math.min(a.maxHp, a.hp + Math.max(1, Math.floor(total * move.healPct))) };
      log.push(`${nameOf(a)} 吸取了体力！`);
    }
    if (move.recoilPct && total > 0) {
      const recoil = Math.max(1, Math.floor(total * move.recoilPct));
      a = applyDamage(a, recoil);
      log.push(`${nameOf(a)} 受到了 ${recoil} 点反作用伤害。`);
    }
    if (move.flinchChance && roll(move.flinchChance)) flinch = true;
  } else {
    log.push(`${nameOf(a)} 使用了 ${move.name}。`);
    if (move.healPct) {
      a = { ...a, hp: Math.min(a.maxHp, a.hp + Math.max(1, Math.floor(a.maxHp * move.healPct))) };
      log.push(`${nameOf(a)} 恢复了体力。`);
    }
  }

  d = applyDamage(d, total);

  if (move.status && d.hp > 0 && d.status === 'none' && roll(move.status.chance)) {
    if (move.status.target === 'self') {
      if (a.status === 'none') {
        a = { ...a, status: move.status.type };
        log.push(`${nameOf(a)} ${STATUS_LINE[move.status.type] ?? ''}`);
      }
    } else {
      d = { ...d, status: move.status.type };
      log.push(`${nameOf(d)} ${STATUS_LINE[move.status.type] ?? ''}`);
    }
  }

  for (const c of move.statChanges ?? []) {
    if (!roll(c.chance)) continue;
    if (c.target === 'self') {
      if (a.hp <= 0) continue;
      const before = aMods[c.stat] ?? 0;
      aMods = { ...aMods, [c.stat]: clamp(before + c.stages, -6, 6) };
      if (aMods[c.stat] !== before) log.push(`${nameOf(a)} 的${c.stat} ${c.stages > 0 ? '提升了' : '降低了'}！`);
    } else {
      if (d.hp <= 0) continue;
      const before = dMods[c.stat] ?? 0;
      dMods = { ...dMods, [c.stat]: clamp(before + c.stages, -6, 6) };
      if (dMods[c.stat] !== before) log.push(`${nameOf(d)} 的${c.stat} ${c.stages > 0 ? '提升了' : '降低了'}！`);
    }
  }

  return { attacker: a, defender: d, attackerMods: aMods, defenderMods: dMods, flinch };
}

function endOfTurn(s: DemoBattle, log: string[]) {
  let p = s.party[s.playerActiveIndex];
  let e = s.enemy;
  if (alive(p)) {
    if (p.status === 'burn') {
      p = applyDamage(p, Math.max(1, Math.floor(p.maxHp / 16)));
      log.push(`${nameOf(p)} 受到烧伤伤害。`);
    } else if (p.status === 'poison') {
      p = applyDamage(p, Math.max(1, Math.floor(p.maxHp / 8)));
      log.push(`${nameOf(p)} 受到中毒伤害。`);
    }
    s.party[s.playerActiveIndex] = p;
  }
  if (alive(e)) {
    if (e.status === 'burn') {
      e = applyDamage(e, Math.max(1, Math.floor(e.maxHp / 16)));
      log.push(`${nameOf(e)} 受到烧伤伤害。`);
    } else if (e.status === 'poison') {
      e = applyDamage(e, Math.max(1, Math.floor(e.maxHp / 8)));
      log.push(`${nameOf(e)} 受到中毒伤害。`);
    }
    s.enemy = e;
  }
}

function rewardsFor(level: number) {
  const lv = clamp(Math.floor(level), 1, 30);
  // 对齐服务端 W3 口径：护符金币已删、金钱不翻倍。
  return { expGain: 10 + lv * 6, moneyGain: 50 + lv * 10 };
}

/** 简化经验分配：击杀者全额；开启学习装置且存活的队友按服务端同款半池均摊。 */
function grantExp(s: DemoBattle, amount: number) {
  const active = s.party[s.playerActiveIndex];
  const sharers = s.party.filter((m) => m.expShareOn === true && alive(m));
  let activeGain = amount;
  if (sharers.length > 0) {
    const half = Math.floor(amount / 2);
    const pool = Math.floor((amount - half) / 2);
    const per = Math.floor(pool / sharers.length);
    activeGain = half;
    for (const m of sharers) s.party[s.party.indexOf(m)] = gainExp(m, per).monster;
  }
  if (active) s.party[s.playerActiveIndex] = gainExp(active, activeGain).monster;
}

function finish(s: DemoBattle, result: DemoBattleResult, log: string[]) {
  s.finished = true;
  s.result = result;
  if (result === 'enemy_fainted') {
    const rewards = rewardsFor(s.enemy.level);
    s.rewards = rewards;
    grantExp(s, rewards.expGain);
    log.push(
      `${nameOf(s.enemy)} 倒下了。`,
      `获得经验 ${rewards.expGain}，金钱 ¥${rewards.moneyGain}。`,
    );
  } else if (result === 'captured') {
    log.push('捕获成功，新伙伴已加入队伍。');
  } else if (result === 'fled') {
    log.push('你成功撤离了。');
  } else if (result === 'player_fainted') {
    log.push('你已没有可战斗的伙伴。');
  }
}

/** 敌方回合（换人 / 道具 / 捕获失败 / 逃跑失败后调用）。 */
function enemyTurn(s: DemoBattle, log: string[]) {
  if (s.finished) return;
  let p = s.party[s.playerActiveIndex];
  if (!alive(p)) {
    const next = firstAlive(s.party);
    if (next >= 0 && next !== s.playerActiveIndex) {
      s.playerActiveIndex = next;
      s.playerMods = emptyMods();
      log.push(`${nameOf(p)} 倒下了，你派出了 ${nameOf(s.party[next])}。`);
      return;
    }
    finish(s, 'player_fainted', log);
    return;
  }

  const moveId = pickEnemyMove(s.enemy, s.ppByMonster[s.enemy.id]);
  if (!moveId) {
    log.push(`${nameOf(s.enemy)} 已无可用技能。`);
  } else {
    const pp = s.ppByMonster[s.enemy.id] ?? {};
    s.ppByMonster = { ...s.ppByMonster, [s.enemy.id]: { ...pp, [moveId]: Math.max(0, (pp[moveId] ?? 0) - 1) } };
    const act = canMove(s.enemy, log);
    s.enemy = { ...s.enemy, status: act.nextStatus };
    if (act.ok) {
      const res = executeMove(s.enemy, p, s.enemyMods, s.playerMods, moveId, log);
      s.enemy = res.attacker;
      p = res.defender;
      s.enemyMods = res.attackerMods;
      s.playerMods = res.defenderMods;
    }
  }

  s.party[s.playerActiveIndex] = p;
  endOfTurn(s, log);
  const cur = s.party[s.playerActiveIndex];
  if (!alive(cur)) {
    log.push(`${nameOf(cur)} 倒下了。`);
    const next = firstAlive(s.party);
    if (next >= 0) {
      s.playerActiveIndex = next;
      s.playerMods = emptyMods();
      log.push(`你派出了 ${nameOf(s.party[next])}。`);
      return;
    }
    finish(s, 'player_fainted', log);
    return;
  }
  s.turn += 1;
}

export function createBattle(params: {
  id: string;
  theme: string;
  areaName: string;
  areaId?: string | null;
  levelMin: number;
  levelMax: number;
  party: MonsterInstance[];
  enemy: MonsterInstance;
  encounterLabel: string;
  bossId?: string | null;
  bossName?: string | null;
  gymId?: string | null;
  mapBossId?: string | null;
}): DemoBattle {
  if (!params.party?.length) throw new DemoBattleError('PARTY_EMPTY', '队伍为空');
  const active = firstAlive(params.party);
  if (active < 0) throw new DemoBattleError('PARTY_FAINTED', '队伍中没有可战斗的幻兽');
  const party = params.party.map((m) => ({ ...m }));
  return {
    battleId: params.id,
    turn: 1,
    finished: false,
    result: null,
    log: [`遭遇：${params.encounterLabel}`],
    areaName: params.areaName,
    theme: params.theme,
    areaId: params.areaId ?? null,
    levelMin: params.levelMin,
    levelMax: params.levelMax,
    playerActiveIndex: active,
    playerMods: emptyMods(),
    enemyMods: emptyMods(),
    enemy: { ...params.enemy },
    party,
    ppByMonster: initPP([...party, params.enemy]),
    rewards: null,
    captured: null,
    consumed: {},
    actions: 0,
    bossId: params.bossId ?? null,
    bossName: params.bossName ?? null,
    damageDealt: 0,
    gymId: params.gymId ?? null,
    mapBossId: params.mapBossId ?? null,
  };
}

function consume(s: DemoBattle, itemId: ItemId, inventory: Record<string, number>) {
  const have = (inventory[itemId] ?? 0) - (s.consumed[itemId] ?? 0);
  if (have < 1) throw new DemoBattleError('ITEM_NOT_ENOUGH', '道具不足');
  s.consumed[itemId] = (s.consumed[itemId] ?? 0) + 1;
}

/** 回合推进：玩家一个意图 + 敌方应对。深拷贝入参，不修改传入状态。 */
function applyActionInner(
  state: DemoBattle,
  action: DemoAction,
  inventory: Record<string, number>,
): DemoBattle {
  if (state.finished) throw new DemoBattleError('BATTLE_FINISHED', '战斗已经结束');
  const s: DemoBattle = {
    ...state,
    log: [...state.log],
    party: state.party.map((m) => ({ ...m })),
    ppByMonster: JSON.parse(JSON.stringify(state.ppByMonster)),
    consumed: { ...state.consumed },
    playerMods: { ...state.playerMods },
    enemyMods: { ...state.enemyMods },
    enemy: { ...state.enemy },
  };
  s.actions += 1;
  const log: string[] = [];
  const hpBefore = s.enemy.hp;
  let player = s.party[s.playerActiveIndex];
  if (!alive(player)) throw new DemoBattleError('PLAYER_FAINTED', '当前幻兽已无法行动');

  if (action.type === 'flee') {
    const chance = getSpeed(player, s.playerMods) >= getSpeed(s.enemy, s.enemyMods) ? 0.75 : 0.5;
    if (roll(chance)) {
      s.turn += 1;
      finish(s, 'fled', log);
    } else {
      log.push('撤离失败！对方抓住了破绽。');
      enemyTurn(s, log);
    }
    pushLog(s, log);
    return s;
  }

  if (action.type === 'switch') {
    const idx = Math.floor(action.partyIndex);
    const next = s.party[idx];
    if (!next) throw new DemoBattleError('PARTY_INDEX_INVALID', '队伍位置不合法');
    if (idx === s.playerActiveIndex) throw new DemoBattleError('SAME_ACTIVE', '已经在场上了');
    if (!alive(next)) throw new DemoBattleError('MONSTER_FAINTED', '已倒下的幻兽无法上场');
    s.playerActiveIndex = idx;
    s.playerMods = emptyMods();
    log.push(`你换上了 ${nameOf(next)}`);
    enemyTurn(s, log);
    pushLog(s, log);
    return s;
  }

  if (action.type === 'item' || action.type === 'capture') {
    const itemId = action.itemId;
    const item = ITEM_SPECS[itemId];
    if (!item) throw new DemoBattleError('ITEM_UNKNOWN', '未知道具');
    if (action.type === 'capture' || item.kind === 'capture') {
      if (s.bossId || s.mapBossId || s.gymId) throw new DemoBattleError('UNCATCHABLE', '该目标无法捕获');
      if (item.kind !== 'capture') throw new DemoBattleError('ITEM_NOT_CAPTURE', '该道具不能用于捕获');
      consume(s, itemId, inventory);
      const baseRate = clamp(MONSTER_SPECS[s.enemy.specId]?.captureRate ?? 0.05, 0.02, 0.62);
      const chance = baseRate * ((3 * s.enemy.maxHp - 2 * s.enemy.hp) / (3 * s.enemy.maxHp))
        * (s.enemy.status === 'none' ? 1 : s.enemy.status === 'sleep' ? 2 : 1.5)
        * (item.modifier ?? 1);
      const ok = roll(clamp(chance, 0.02, 0.95));
      log.push(`抛出了 ${item.name}…（成功率 ${Math.round(clamp(chance, 0.02, 0.95) * 100)}%）`);
      if (ok) {
        s.captured = { ...s.enemy, id: `cap_${Date.now().toString(36)}`, hp: s.enemy.maxHp, status: 'none' };
        s.turn += 1;
        finish(s, 'captured', log);
      } else {
        log.push('摇晃了几下… 失败！');
        enemyTurn(s, log);
      }
      pushLog(s, log);
      return s;
    }
    if (item.kind === 'heal') {
      consume(s, itemId, inventory);
      const healed = item.healPct
        ? Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * (item.heal / 100)))
        : Math.min(player.maxHp, player.hp + item.heal);
      s.party[s.playerActiveIndex] = { ...player, hp: healed };
      log.push(`使用了 ${item.name}，${nameOf(player)} 恢复了体力。`);
      enemyTurn(s, log);
      pushLog(s, log);
      return s;
    }
    if (item.kind === 'status_heal') {
      consume(s, itemId, inventory);
      s.party[s.playerActiveIndex] = { ...player, status: 'none' };
      log.push(`使用了 ${item.name}，${nameOf(player)} 的异常状态解除了。`);
      enemyTurn(s, log);
      pushLog(s, log);
      return s;
    }
    throw new DemoBattleError('ITEM_UNUSABLE', '该道具无法在战斗中使用');
  }

  if (action.type === 'move') {
    const moveId = action.moveId;
    if (!player.moveIds?.includes(moveId)) throw new DemoBattleError('MOVE_UNKNOWN', '该幻兽没有掌握这个技能');
    if (!MOVE_SPECS[moveId]) throw new DemoBattleError('MOVE_UNKNOWN', '未知技能');
    const pp = s.ppByMonster[player.id] ?? {};
    if ((pp[moveId] ?? 0) <= 0) throw new DemoBattleError('PP_EXHAUSTED', '该技能的 PP 已耗尽');
    s.ppByMonster = { ...s.ppByMonster, [player.id]: { ...pp, [moveId]: pp[moveId] - 1 } };

    const enemyMoveId = pickEnemyMove(s.enemy, s.ppByMonster[s.enemy.id]);
    const pPriority = MOVE_SPECS[moveId]?.priority ?? 0;
    const ePriority = enemyMoveId ? (MOVE_SPECS[enemyMoveId]?.priority ?? 0) : 0;
    let playerFirst: boolean;
    if (pPriority !== ePriority) playerFirst = pPriority > ePriority;
    else {
      const ps = getSpeed(player, s.playerMods);
      const es = getSpeed(s.enemy, s.enemyMods);
      playerFirst = ps > es || (ps === es && roll(0.5));
    }

    let flinchedEnemy = false;
    let flinchedPlayer = false;
    const playerAct = () => {
      if (!alive(player) || !alive(s.enemy)) return;
      if (flinchedPlayer) { log.push(`${nameOf(player)} 畏缩了，无法行动！`); return; }
      const act = canMove(player, log);
      player = { ...player, status: act.nextStatus };
      if (!act.ok) return;
      const res = executeMove(player, s.enemy, s.playerMods, s.enemyMods, moveId, log);
      player = res.attacker;
      s.enemy = res.defender;
      s.playerMods = res.attackerMods;
      s.enemyMods = res.defenderMods;
      if (res.flinch) flinchedEnemy = true;
    };
    const enemyAct = () => {
      if (!alive(player) || !alive(s.enemy)) return;
      if (flinchedEnemy) { log.push(`${nameOf(s.enemy)} 畏缩了，无法行动！`); return; }
      if (!enemyMoveId) { log.push(`${nameOf(s.enemy)} 已无可用技能。`); return; }
      const epp = s.ppByMonster[s.enemy.id] ?? {};
      s.ppByMonster = { ...s.ppByMonster, [s.enemy.id]: { ...epp, [enemyMoveId]: Math.max(0, (epp[enemyMoveId] ?? 0) - 1) } };
      const act = canMove(s.enemy, log);
      s.enemy = { ...s.enemy, status: act.nextStatus };
      if (!act.ok) return;
      const res = executeMove(s.enemy, player, s.enemyMods, s.playerMods, enemyMoveId, log);
      s.enemy = res.attacker;
      player = res.defender;
      s.enemyMods = res.attackerMods;
      s.playerMods = res.defenderMods;
      if (res.flinch) flinchedPlayer = true;
    };

    if (playerFirst) { playerAct(); enemyAct(); } else { enemyAct(); playerAct(); }

    s.party[s.playerActiveIndex] = player;
    endOfTurn(s, log);
    player = s.party[s.playerActiveIndex];

    if (!alive(s.enemy)) {
      s.turn += 1;
      finish(s, 'enemy_fainted', log);
    } else if (!alive(player)) {
      log.push(`${nameOf(player)} 倒下了。`);
      const next = firstAlive(s.party);
      if (next >= 0) {
        s.playerActiveIndex = next;
        s.playerMods = emptyMods();
        log.push(`你派出了 ${nameOf(s.party[next])}。`);
        s.turn += 1;
      } else {
        finish(s, 'player_fainted', log);
      }
    } else {
      s.turn += 1;
    }
    pushLog(s, log);
    return s;
  }

  throw new DemoBattleError('ACTION_UNKNOWN', '未知的战斗操作');
}

/** 与 ServerBattleView 同形状的只读视图（额外多带一个无需被主工程消费的 damageDealt）。 */
export function battleView(s: DemoBattle) {
  return {
    battleId: s.battleId,
    turn: s.turn,
    finished: s.finished,
    result: s.result,
    log: s.log,
    areaName: s.areaName,
    theme: s.theme,
    areaId: s.areaId,
    levelMin: s.levelMin,
    levelMax: s.levelMax,
    playerActiveIndex: s.playerActiveIndex,
    playerMods: s.playerMods,
    enemyMods: s.enemyMods,
    enemy: s.enemy,
    party: s.party,
    ppByMonster: s.ppByMonster,
    rewards: s.rewards,
    captured: s.captured,
    consumed: s.consumed,
    actions: s.actions,
    bossId: s.bossId,
    bossName: s.bossName,
    damageDealt: s.damageDealt,
    gymId: s.gymId,
    mapBossId: s.mapBossId,
  };
}

/**
 * 回合推进的唯一出口：先跑状态机，再按敌方 HP 差累计本场伤害（与服务端口径一致）。
 * 不改传入状态。
 */
export function applyAction(
  state: DemoBattle,
  action: DemoAction,
  inventory: Record<string, number>,
): DemoBattle {
  const before = state.enemy.hp;
  const next = applyActionInner(state, action, inventory);
  const dealt = Math.max(0, before - next.enemy.hp);
  if (dealt > 0) next.damageDealt = Math.floor((next.damageDealt ?? 0) + dealt);
  return next;
}

/** 生成野战敌人：主题表来自主工程 data.ts，等级取区域区间。 */
export function rollWildEnemy(theme: string, levelMin: number, levelMax: number) {
  const table = THEME_TABLE[theme] ?? THEME_TABLE.grass ?? [];
  if (!table.length) throw new DemoBattleError('THEME_UNKNOWN', '该区域没有可遭遇的幻兽');
  const lo = clamp(Math.floor(levelMin) || 1, 1, 60);
  const hi = clamp(Math.floor(levelMax) || lo, lo, 60);
  const level = lo + Math.floor(Math.random() * (hi - lo + 1));
  const specId = table[Math.floor(Math.random() * table.length)];
  const enemy = createInstance(specId, level);
  return { enemy, label: `野生 ${MONSTER_SPECS[specId]?.name ?? specId}` };
}

/** 馆主 / Boss / 地图首领：固定王牌，不随机、禁捕获。 */
export function fixedEnemy(specId: string, level: number): MonsterInstance {
  if (!MONSTER_SPECS[specId]) throw new DemoBattleError('SPEC_UNKNOWN', `未知物种 ${specId}`);
  return createInstance(specId, clamp(Math.floor(level), 1, 60));
}

/** L1 遗留的三类特殊战斗 ID → 固定敌人（从 fixture 表读入，见 api.mock.ts）。 */
export function specialBattle(params: {
  id: string; party: MonsterInstance[];
  specId: string; level: number; theme: string; name: string;
  areaName: string; bossId?: string; bossName?: string; gymId?: string; mapBossId?: string;
}): DemoBattle {
  const enemy = fixedEnemy(params.specId, params.level);
  return createBattle({
    id: params.id,
    theme: params.theme,
    areaName: params.areaName,
    areaId: null,
    levelMin: params.level,
    levelMax: params.level,
    party: params.party,
    enemy,
    encounterLabel: params.name,
    bossId: params.bossId,
    bossName: params.bossName ?? params.name,
    gymId: params.gymId,
    mapBossId: params.mapBossId,
  });
}

/** 测试 / 管理员标记（仅演示包用）：异色 / 满属性 / 1 HP。 */
export function applyTestFlags(s: DemoBattle, flags?: { testShiny?: boolean; testMaxStats?: boolean; testOHKO?: boolean }) {
  if (!flags) return s;
  const marks: string[] = [];
  if (flags.testShiny && !s.enemy.isShiny) { s.enemy = { ...s.enemy, isShiny: true }; marks.push('异色'); }
  if (flags.testMaxStats) {
    const spec = MONSTER_SPECS[s.enemy.specId];
    const lv = Math.max(0, s.enemy.level - 1);
    const init = spec?.initStatsMax ?? { hp: 0, atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0 };
    const grow = spec?.growthPerLevel?.max ?? { hp: 2, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
    const maxHp = init.hp + grow.hp * lv;
    s.enemy = {
      ...s.enemy,
      initStats: { ...init }, growthRates: { ...grow },
      maxHp, hp: maxHp,
      atk: init.atk + grow.atk * lv, def: init.def + grow.def * lv,
      spAtk: init.spAtk + grow.spAtk * lv, spDef: init.spDef + grow.spDef * lv,
      spd: init.spd + grow.spd * lv,
    };
    marks.push('满属性');
  }
  if (flags.testOHKO) { s.enemy = { ...s.enemy, hp: 1 }; marks.push('一击必杀'); }
  if (marks.length) s.log.push(`［演示标记：${marks.join(' / ')}］`);
  return s;
}
