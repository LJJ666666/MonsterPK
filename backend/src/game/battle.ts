/**
 * 服务端战斗状态机（P3-1）。
 *
 * 设计原则：
 *  - 战斗真值（HP / PP / 异常 / 增益 / 回合数 / 敌方实体）只存在服务端，客户端拿不到可改写的副本；
 *  - 客户端每回合只发「意图」（用哪个技能 / 哪个道具 / 换谁 / 逃跑），服务端推进并回传结果；
 *  - 所有随机（命中、暴击、伤害浮动、敌方选招、捕获、逃跑）都用注入的 `Rng`；
 *  - 结算奖励（经验 / 金钱 / 捕获 / 道具消耗）由引擎算，路由层负责写进存档。
 *
 * 流程与前端 `useGameStore` 的 useMove / useItem / switchTo / flee 一一对应，
 * 保证「同一操作在服务端跑」和「原来在客户端跑」结果同构，玩家手感不变。
 */
import {
  ITEM_SPECS, MONSTER_SPECS, MOVE_SPECS, emptyMods,
  type ServerMonster, type StatModifiers,
} from './content.js';
import {
  alive, attemptCapture, canMove, captureChance, clamp, createInstance,
  executeMoveAction, findFirstAliveIndex, gainExp, getMonsterStatBounds, getSpeed,
  initBattlePP, pickUsableMove, processEndOfTurn, roll,
  type Rng,
} from './rules.js';
import { createBossEnemy, type BossSpec } from './boss.js';
import { createMapBossEnemy, type MapBossSpec } from './mapBosses.js';
import { expGrantAllowed } from './playerLevel.js';

export type BattleResult = 'captured' | 'enemy_fainted' | 'fled' | 'player_fainted';

export type BattleState = {
  id: string;
  userId: string;
  theme: string;
  areaName: string;
  areaId: string | null;
  levelMin: number;
  levelMax: number;
  turn: number;
  log: string[];
  playerActiveIndex: number;
  playerMods: StatModifiers;
  enemyMods: StatModifiers;
  enemy: ServerMonster;
  /** 战斗内的队伍副本：HP / 经验变化只在这个副本上，结算时才写回存档。 */
  party: ServerMonster[];
  ppByMonster: Record<string, Record<string, number>>;
  /** 本场累计消耗的道具（结算时从背包扣）。 */
  consumed: Record<string, number>;
  finished: boolean;
  result: BattleResult | null;
  rewards: { expGain: number; moneyGain: number } | null;
  /** F04：服务端在开局时注入的宠物等级帽；null = 不限制（Boss / 单测构造态）。 */
  levelCap?: number | null;
  /** 捕获成功时的幻兽个体（结算时入队/入箱）。 */
  captured: ServerMonster | null;
  /** 已接受的客户端动作数，用于限流与排查。 */
  actions: number;
  startedAt: number;
  updatedAt: number;
  /** P4-1b：关联的共享野怪实例 id；普通随机遭遇为 null。 */
  wildId?: string | null;
  /**
   * P4-2c：单人 Boss 讨伐。有值即为 Boss 战：
   *  - 敌方由 `game/boss.ts` 内容表生成（固定等级 + HP 倍率）；
   *  - 禁止捕获；逃跑 = 放弃（不记伤害、不扣次数）；
   *  - 结束时把 `damageDealt` 作为唯一伤害真值写入 append-only 事件。
   */
  bossId?: string | null;
  bossName?: string | null;
  /** F18-b 演武堂挑战：有值即为演武堂战；禁止捕获；胜利经 `grantBadge` 发 `gym:<locationId>` 徽章。 */
  gymId?: string | null;
  /** F18-c 地图首领：有值即为地图首领战；禁止捕获；胜利经 `applyPlayReward` 发掉落（不上榜）。 */
  mapBossId?: string | null;
  /** 开局时占用的次数键（含日期与账号）。仅作可读标识，释放/结算一律走 token。 */
  bossQuotaKey?: string | null;
  /** W6.4：hold 返回的租约 token，是释放/结算的唯一权威句柄；迟到/重复释放都是 no-op（防 ABA）。 */
  bossQuotaToken?: string | null;
  /** 本场对敌方造成的累计伤害（服务端按敌方 HP 差累计，客户端上报无效）。 */
  damageDealt: number;
};

export type BattleAction =
  | { type: 'move'; moveId: string }
  | { type: 'item'; itemId: string }
  | { type: 'capture'; itemId: string }
  | { type: 'switch'; partyIndex: number }
  | { type: 'flee' };

/**
 * 队伍平均等级（含已倒下的成员），用于捕获率的等级差修正。
 * 口径与 P1-3 的 `settlements` 实现一致，改这里不用再同步别处——那边已下线。
 */
export function partyAvgLevel(party: ServerMonster[]): number {
  if (!party.length) return 1;
  const sum = party.reduce((acc, m) => acc + m.level, 0);
  return Math.max(1, Math.round(sum / party.length));
}

export class BattleError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

const MAX_LOG = 200;

function pushLog(s: BattleState, lines: string[]): BattleState {
  if (!lines.length) return s;
  const log = [...s.log, ...lines];
  s.log = log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log;
  return s;
}

function resetMods(): StatModifiers {
  return emptyMods();
}

/** 奖励公式与 `settlements.ts::decideIntent('battle_reward')` 完全一致。 */
export function computeRewards(enemyLevel: number, inventory: Record<string, number>) {
  const level = clamp(Math.floor(enemyLevel), 1, 30);
  const expGain = 10 + level * 6;
  const hasAmuletCoin = (inventory.amulet_coin ?? 0) > 0;
  const hasExpShare = (inventory.exp_share ?? 0) > 0;
  const moneyGain = (50 + level * 10) * (hasAmuletCoin ? 2 : 1);
  return { expGain, moneyGain, hasAmuletCoin, hasExpShare };
}

/** 遭遇生成：等级随机区间 + 稀有/精英判定 + 主题表选种，全部在服务端掷。 */
export function generateEncounter(theme: string, partyLevel: number, rng: Rng, themes: Record<string, string[]>) {
  const table = themes[theme];
  if (!table || table.length === 0) throw new BattleError('THEME_UNKNOWN', '该区域没有可遭遇的幻兽');
  const rare = roll(0.08, rng);
  const elite = roll(0.12, rng);
  const levelBase = clamp(partyLevel + (elite ? 2 : 0) + (rare ? 3 : 0) + (rng() < 0.5 ? 0 : 1), 1, 30);
  const specId = table[Math.floor(rng() * table.length)];
  const enemy = createInstance(specId, levelBase, rng);
  const label = `${rare ? '稀有' : elite ? '精英' : '野生'} ${MONSTER_SPECS[specId]?.name ?? specId}`;
  return { enemy, label };
}

export function createBattle(params: {
  id: string;
  userId: string;
  theme: string;
  areaName: string;
  areaId?: string | null;
  levelMin: number;
  levelMax: number;
  party: ServerMonster[];
  themes: Record<string, string[]>;
  now: number;
  rng: Rng;
  /**
   * P4-1b：命中共享野怪实例时，敌方种族 / 等级 / 标签由实例决定，
   * 不再现场掷骰 —— 这样所有客户端看到的「这一只」确实是同一只。
   */
  wild?: { wildId: string; speciesId: string; level: number; label: string };
  /**
   * P4-2c：单人 Boss 战。给了 spec 就不再走随机遭遇：
   * 敌方由内容表生成，`areaName` / `theme` 以 Boss 定义为准（路由层不会再传错）。
   */
  boss?: { spec: BossSpec; quotaKey?: string; quotaToken?: string };
  /**
   * F18-b：演武堂挑战。给了 gym 就走固定王牌（不随机、不记 areaId），
   * 敌方由 `createInstance(aceSpeciesId, aceLevel)` 生成，`areaName` 以馆主为准。
   */
  gym?: { locationId: string; specId: string; level: number };
  /**
   * F18-c：地图首领。给了 mapBoss 就走固定王牌（不随机、不记 areaId），
   * 敌方由 `createMapBossEnemy(spec)` 生成，`areaName` 以首领为准。
   */
  mapBoss?: { spec: MapBossSpec; quotaKey?: string; quotaToken?: string };
  /** F04：由 modules 层读 PlayerProgress 后注入，绝不采信客户端入参。 */
  levelCap?: number | null;
}): BattleState {
  const { rng, now } = params;
  if (!Array.isArray(params.party) || params.party.length === 0) {
    throw new BattleError('PARTY_EMPTY', '队伍为空，无法进入战斗');
  }
  const activeIndex = findFirstAliveIndex(params.party);
  if (activeIndex < 0) throw new BattleError('PARTY_FAINTED', '队伍中没有可战斗的幻兽');

  const levelMin = clamp(Math.floor(params.levelMin) || 1, 1, 60);
  const levelMax = clamp(Math.floor(params.levelMax) || levelMin, levelMin, 60);
  const level = levelMin + Math.floor(rng() * (levelMax - levelMin + 1));
  const { enemy, label } = params.mapBoss
    ? { enemy: createMapBossEnemy(params.mapBoss.spec, rng), label: params.mapBoss.spec.name }
    : params.gym
      ? { enemy: createInstance(params.gym.specId, params.gym.level, rng), label: '演武堂馆主' }
      : params.boss
        ? { enemy: createBossEnemy(params.boss.spec, rng), label: params.boss.spec.name }
        : params.wild
          ? {
              enemy: createInstance(params.wild.speciesId, params.wild.level, rng),
              label: params.wild.label,
            }
          : generateEncounter(params.theme, level, rng, params.themes);

  const party = params.party.map((m) => ({ ...m }));
  return {
    id: params.id,
    userId: params.userId,
    theme: params.mapBoss ? params.mapBoss.spec.theme : (params.boss ? params.boss.spec.theme : params.theme),
    areaName: params.mapBoss ? params.mapBoss.spec.name : (params.boss ? params.boss.spec.name : params.areaName),
    areaId: (params.gym || params.mapBoss || params.boss) ? null : (params.areaId ?? null),
    levelMin,
    levelMax,
    turn: 1,
    log: [`遭遇：${label}`],
    playerActiveIndex: activeIndex,
    playerMods: resetMods(),
    enemyMods: resetMods(),
    enemy,
    party,
    ppByMonster: initBattlePP([...party, enemy]),
    consumed: {},
    finished: false,
    result: null,
    rewards: null,
    levelCap: params.levelCap ?? null,
    captured: null,
    actions: 0,
    startedAt: now,
    updatedAt: now,
    wildId: params.wild?.wildId ?? null,
    bossId: params.boss?.spec.bossId ?? null,
    bossName: params.boss?.spec.name ?? null,
    // F18-c：地图首领的次数键同样要落到战斗态，结算/逃跑时才能精确释放在途名额。
    bossQuotaKey: params.boss?.quotaKey ?? params.mapBoss?.quotaKey ?? null,
    // W6.4：租约 token 一并落战斗态，释放/结算只认 token（防 ABA）。
    bossQuotaToken: params.boss?.quotaToken ?? params.mapBoss?.quotaToken ?? null,
    damageDealt: 0,
    gymId: params.gym?.locationId ?? null,
    mapBossId: params.mapBoss?.spec.mapBossId ?? null,
  };
}

function consumeItem(s: BattleState, itemId: string, inventory: Record<string, number>): void {
  const have = (inventory[itemId] ?? 0) - (s.consumed[itemId] ?? 0);
  if (have < 1) throw new BattleError('ITEM_NOT_ENOUGH', '道具不足');
  s.consumed[itemId] = (s.consumed[itemId] ?? 0) + 1;
}

/** 敌方行动一回合（换人 / 治疗 / 捕获失败 / 逃跑失败后调用）。 */
function runEnemyTurn(s: BattleState, rng: Rng): BattleState {
  if (s.finished) return s;
  let player = s.party[s.playerActiveIndex];
  let enemy = s.enemy;

  if (!alive(player)) {
    const nextIndex = findFirstAliveIndex(s.party);
    if (nextIndex >= 0 && nextIndex !== s.playerActiveIndex) {
      s.playerActiveIndex = nextIndex;
      s.playerMods = resetMods();
      return pushLog(s, [
        `${MONSTER_SPECS[player.specId]?.name ?? player.specId} 倒下了，你派出了 ${MONSTER_SPECS[s.party[nextIndex].specId]?.name ?? s.party[nextIndex].specId}。`,
      ]);
    }
    s.finished = true;
    s.result = 'player_fainted';
    return pushLog(s, ['你已没有可战斗的伙伴。']);
  }

  const logs: string[] = [];
  const enemyMoveId = pickUsableMove(enemy, s.ppByMonster?.[enemy.id], rng);

  if (!enemyMoveId) {
    logs.push(`${MONSTER_SPECS[enemy.specId]?.name ?? enemy.specId} 已无可用技能，只能干瞪眼。`);
  } else {
    const enemyPP = s.ppByMonster[enemy.id] ?? {};
    s.ppByMonster = { ...s.ppByMonster, [enemy.id]: { ...enemyPP, [enemyMoveId]: Math.max(0, (enemyPP[enemyMoveId] ?? 0) - 1) } };
    const { ok, nextStatus } = canMove(enemy, logs, rng);
    enemy = { ...enemy, status: nextStatus };
    if (ok) {
      const res = executeMoveAction(enemy, player, s.enemyMods, s.playerMods, enemyMoveId, rng);
      enemy = res.nextAttacker;
      player = res.nextDefender;
      s.enemyMods = res.nextAttackerMods;
      s.playerMods = res.nextDefenderMods;
      logs.push(...res.logs);
    }
  }

  const party = [...s.party];
  party[s.playerActiveIndex] = player;

  const eot = processEndOfTurn(party, s.playerActiveIndex, enemy);
  s.party = eot.nextParty;
  s.enemy = eot.nextEnemy;
  logs.push(...eot.logs);

  pushLog(s, logs);

  const cur = s.party[s.playerActiveIndex];
  if (!alive(cur)) {
    pushLog(s, [`${MONSTER_SPECS[cur.specId]?.name ?? cur.specId} 倒下了。`]);
    const nextIndex = findFirstAliveIndex(s.party);
    if (nextIndex >= 0) {
      s.playerActiveIndex = nextIndex;
      s.playerMods = resetMods();
      pushLog(s, [`你派出了 ${MONSTER_SPECS[s.party[nextIndex].specId]?.name ?? s.party[nextIndex].specId}。`]);
      return s;
    }
    s.finished = true;
    s.result = 'player_fainted';
    return s;
  }

  s.turn += 1;
  return s;
}

/** 战斗结束：算奖励、分配经验、标记结果。 */
function finish(s: BattleState, result: BattleResult, inventory: Record<string, number>, rng: Rng): BattleState {
  s.finished = true;
  s.result = result;
  if (result === 'enemy_fainted') {
    // P4-2c：Boss 讨伐不发经验 / 金钱。Boss 的产出是「伤害榜上的记录」，
    // 奖励规则待台账 F02；这里若照常发奖，等于每天可稳定刷一笔资源，且与后续奖励设计冲突。
    if (s.bossId) {
      const bossName = MONSTER_SPECS[s.enemy.specId]?.name ?? s.enemy.specId;
      s.rewards = null;
      pushLog(s, [`${bossName} 倒下了。`, '讨伐完成，本次伤害已记入伤害榜。']);
      return s;
    }
    // F18-c（2026-11-10 杰哥口径）：地图首领限次数，胜利**额外**给 3 倍经验 / 5 倍金钱
    // （比普通野怪多），掉落（稀有材料 / 道具）由 modules/mapBoss.ts 的 grantMapBossDrop 另发。
    // 不上任何榜单；禁捕获、逃跑不上榜也不发奖。
    if (s.mapBossId) {
      const bossName = MONSTER_SPECS[s.enemy.specId]?.name ?? s.enemy.specId;
      const base = computeRewards(s.enemy.level, inventory);
      const expGain = base.expGain * 3;
      const moneyGain = base.moneyGain * 5;
      const party = s.party.map((m) => ({ ...m }));
      // F04 §31：达到 / 超过等级帽的宠物只冻结升级（不再获得经验）。
      const capped = s.levelCap != null;
      let frozen = 0;
      const grant = (m: ServerMonster) => {
        if (capped && !expGrantAllowed(m.level, s.levelCap!)) { frozen += 1; return m; }
        return gainExp(m, expGain).monster;
      };
      if (base.hasExpShare) {
        for (let i = 0; i < party.length; i++) {
          if (!alive(party[i])) continue;
          party[i] = grant(party[i]);
        }
      } else {
        const idx = s.playerActiveIndex;
        if (party[idx]) party[idx] = grant(party[idx]);
      }
      s.party = party;
      s.rewards = { expGain, moneyGain };
      pushLog(s, [
        `${bossName} 倒下了。`,
        `获得经验 ${expGain}（3 倍），金钱 ¥${moneyGain}（5 倍）。`,
        ...(frozen > 0 ? [`${frozen} 只伙伴已达等级帽 Lv.${s.levelCap}，本次不获得经验。`] : []),
      ]);
      return s;
    }
    const { expGain, moneyGain, hasExpShare } = computeRewards(s.enemy.level, inventory);
    const party = s.party.map((m) => ({ ...m }));
    // F04 §31：达到 / 超过等级帽的宠物**不降级、只冻结升级**（不再获得经验）。
    // 捕获到的高等级怪原样入队，之后同样因超帽而拿不到经验；帽由服务端注入。
    const capped = s.levelCap != null;
    let frozen = 0;
    const grant = (m: ServerMonster) => {
      if (capped && !expGrantAllowed(m.level, s.levelCap!)) { frozen += 1; return m; }
      return gainExp(m, expGain).monster;
    };
    if (hasExpShare) {
      for (let i = 0; i < party.length; i++) {
        if (!alive(party[i])) continue;
        party[i] = grant(party[i]);
      }
    } else {
      const idx = s.playerActiveIndex;
      if (party[idx]) party[idx] = grant(party[idx]);
    }
    s.party = party;
    s.rewards = { expGain, moneyGain };
    pushLog(s, [
      `${MONSTER_SPECS[s.enemy.specId]?.name ?? s.enemy.specId} 倒下了。`,
      `获得经验 ${expGain}，金钱 ¥${moneyGain}。`,
      ...(frozen > 0 ? [`${frozen} 只伙伴已达等级帽 Lv.${s.levelCap}，本次不获得经验。`] : []),
    ]);
  }
  if (result === 'fled') pushLog(s, ['你成功撤离了训练场。']);
  if (result === 'player_fainted') pushLog(s, ['你已没有可战斗的伙伴。']);
  void rng;
  return s;
}

/** 回合推进：玩家的一个动作 + 敌方的应对。 */
function applyBattleActionInner(
  state: BattleState,
  action: BattleAction,
  ctx: { inventory: Record<string, number>; rng: Rng; now: number; testOHKO?: boolean },
): BattleState {
  if (state.finished) throw new BattleError('BATTLE_FINISHED', '战斗已经结束');
  const { rng } = ctx;
  const inventory = ctx.inventory ?? {};
  const s: BattleState = {
    ...state,
    log: [...state.log],
    party: state.party.map((m) => ({ ...m })),
    ppByMonster: { ...state.ppByMonster },
    consumed: { ...state.consumed },
    playerMods: { ...state.playerMods },
    enemyMods: { ...state.enemyMods },
    enemy: { ...state.enemy },
  };
  s.actions += 1;
  s.updatedAt = ctx.now;

  const player = s.party[s.playerActiveIndex];
  if (!alive(player)) throw new BattleError('PLAYER_FAINTED', '当前幻兽已无法行动');

  // —— 逃跑 ——
  if (action.type === 'flee') {
    const chance = getSpeed(player, s.playerMods) >= getSpeed(s.enemy, s.enemyMods) ? 0.75 : 0.5;
    if (roll(chance, rng)) {
      s.turn += 1;
      return finish(s, 'fled', inventory, rng);
    }
    pushLog(s, ['撤离失败！对方抓住了破绽。']);
    return runEnemyTurn(s, rng);
  }

  // —— 换人：换上后敌方行动一回合 ——
  if (action.type === 'switch') {
    const idx = Math.floor(action.partyIndex);
    const next = s.party[idx];
    if (!next) throw new BattleError('PARTY_INDEX_INVALID', '队伍位置不合法');
    if (idx === s.playerActiveIndex) throw new BattleError('SAME_ACTIVE', '已经在场上了');
    if (!alive(next)) throw new BattleError('MONSTER_FAINTED', '已倒下的幻兽无法上场');
    s.playerActiveIndex = idx;
    s.playerMods = resetMods();
    pushLog(s, [`你换上了 ${MONSTER_SPECS[next.specId]?.name ?? next.specId}`]);
    return runEnemyTurn(s, rng);
  }

  // —— 道具：治疗 / 捕获 ——
  if (action.type === 'item' || action.type === 'capture') {
    const itemId = action.itemId;
    const item = ITEM_SPECS[itemId];
    if (!item) throw new BattleError('ITEM_UNKNOWN', '未知道具');

    if (action.type === 'capture' || item.kind === 'capture') {
      if (s.bossId) throw new BattleError('BOSS_UNCATCHABLE', '讨伐目标无法捕获');
      if (s.mapBossId) throw new BattleError('MAPBOSS_UNCATCHABLE', '地图首领无法捕获');
      if (s.gymId) throw new BattleError('GYM_UNCATCHABLE', '演武堂馆主无法捕获');
      if (item.kind !== 'capture') throw new BattleError('ITEM_NOT_CAPTURE', '该道具不能用于捕获');
      consumeItem(s, itemId, inventory);
      const spec = MONSTER_SPECS[s.enemy.specId];
      const baseRate = clamp(spec?.captureRate ?? 0.05, 0.02, 0.62);
      const res = attemptCapture(s.enemy, baseRate, item.modifier ?? 1, partyAvgLevel(s.party), rng);
      const head = `抛出了 ${item.name}…（成功率 ${Math.round(res.chance * 100)}%）`;
      if (res.ok) {
        const captured: ServerMonster = {
          ...s.enemy,
          id: `cap_${Math.floor(rng() * 1e12).toString(36)}_${ctx.now.toString(36)}`,
          hp: s.enemy.maxHp,
          status: 'none',
        };
        s.captured = captured;
        s.turn += 1;
        pushLog(s, [head, `摇晃 x${res.shakes}… 捕获成功！${MONSTER_SPECS[captured.specId]?.name ?? captured.specId} 已加入。`]);
        return finish(s, 'captured', inventory, rng);
      }
      pushLog(s, [head, `摇晃 x${res.shakes}… 失败！`]);
      return runEnemyTurn(s, rng);
    }

    if (item.kind === 'heal') {
      consumeItem(s, itemId, inventory);
      const healed = item.healPct
        ? Math.min(player.maxHp, player.hp + Math.floor(player.maxHp * ((item as any).heal ?? 0)))
        : Math.min(player.maxHp, player.hp + (item.heal ?? 0));
      s.party[s.playerActiveIndex] = { ...player, hp: healed };
      pushLog(s, [`使用了 ${item.name}，${MONSTER_SPECS[player.specId]?.name ?? player.specId} 恢复了体力。`]);
      return runEnemyTurn(s, rng);
    }

    throw new BattleError('ITEM_UNUSABLE', '该道具无法在战斗中使用');
  }

  // —— 技能 ——
  if (action.type === 'move') {
    const moveId = action.moveId;
    if (!player.moveIds?.includes(moveId)) throw new BattleError('MOVE_UNKNOWN', '该幻兽没有掌握这个技能');
    if (!MOVE_SPECS[moveId]) throw new BattleError('MOVE_UNKNOWN', '未知技能');
    const playerPP = s.ppByMonster[player.id] ?? {};
    const remaining = playerPP[moveId] ?? 0;
    if (remaining <= 0) throw new BattleError('PP_EXHAUSTED', '该技能的 PP 已耗尽');

    s.ppByMonster = { ...s.ppByMonster, [player.id]: { ...playerPP, [moveId]: remaining - 1 } };

    let p = { ...player };
    let enemy = { ...s.enemy };
    let playerMods = { ...s.playerMods };
    let enemyMods = { ...s.enemyMods };
    const logs: string[] = [];

    const enemyMoveId = pickUsableMove(enemy, s.ppByMonster?.[enemy.id], rng);
    const playerPriority = MOVE_SPECS[moveId]?.priority ?? 0;
    const enemyPriority = enemyMoveId ? (MOVE_SPECS[enemyMoveId]?.priority ?? 0) : 0;

    let playerGoesFirst: boolean;
    if (playerPriority > enemyPriority) playerGoesFirst = true;
    else if (playerPriority < enemyPriority) playerGoesFirst = false;
    else {
      const pSpd = getSpeed(p, playerMods);
      const eSpd = getSpeed(enemy, enemyMods);
      playerGoesFirst = pSpd > eSpd || (pSpd === eSpd && roll(0.5, rng));
    }

    let playerFlinched = false;
    let enemyFlinched = false;

    const runPlayerAction = () => {
      if (!alive(p) || !alive(enemy)) return;
      if (playerFlinched) {
        logs.push(`${MONSTER_SPECS[p.specId]?.name ?? p.specId} 畏缩了，无法行动！`);
        return;
      }
      const { ok, nextStatus } = canMove(p, logs, rng);
      p = { ...p, status: nextStatus };
      if (ok) {
        const res = executeMoveAction(p, enemy, playerMods, enemyMods, moveId, rng, ctx.testOHKO);
        p = res.nextAttacker;
        enemy = res.nextDefender;
        playerMods = res.nextAttackerMods;
        enemyMods = res.nextDefenderMods;
        if (res.flinch) enemyFlinched = true;
        logs.push(...res.logs);
      }
    };

    const runEnemyAction = () => {
      if (!alive(p) || !alive(enemy)) return;
      if (enemyFlinched) {
        logs.push(`${MONSTER_SPECS[enemy.specId]?.name ?? enemy.specId} 畏缩了，无法行动！`);
        return;
      }
      if (!enemyMoveId) {
        logs.push(`${MONSTER_SPECS[enemy.specId]?.name ?? enemy.specId} 已无可用技能，只能干瞪眼。`);
        return;
      }
      const enemyPP = s.ppByMonster[enemy.id] ?? {};
      s.ppByMonster = { ...s.ppByMonster, [enemy.id]: { ...enemyPP, [enemyMoveId]: Math.max(0, (enemyPP[enemyMoveId] ?? 0) - 1) } };
      const { ok, nextStatus } = canMove(enemy, logs, rng);
      enemy = { ...enemy, status: nextStatus };
      if (ok) {
        const res = executeMoveAction(enemy, p, enemyMods, playerMods, enemyMoveId, rng);
        enemy = res.nextAttacker;
        p = res.nextDefender;
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

    let party = [...s.party];
    party[s.playerActiveIndex] = p;

    const eot = processEndOfTurn(party, s.playerActiveIndex, enemy);
    party = eot.nextParty;
    enemy = eot.nextEnemy;
    logs.push(...eot.logs);
    p = party[s.playerActiveIndex];

    s.party = party;
    s.enemy = enemy;
    s.playerMods = playerMods;
    s.enemyMods = enemyMods;
    pushLog(s, logs);

    if (!alive(enemy)) {
      s.turn += 1;
      return finish(s, 'enemy_fainted', inventory, rng);
    }

    if (!alive(p)) {
      pushLog(s, [`${MONSTER_SPECS[p.specId]?.name ?? p.specId} 倒下了。`]);
      const nextIndex = findFirstAliveIndex(party);
      if (nextIndex >= 0) {
        s.playerActiveIndex = nextIndex;
        s.playerMods = resetMods();
        pushLog(s, [`你派出了 ${MONSTER_SPECS[party[nextIndex].specId]?.name ?? party[nextIndex].specId}。`]);
        s.turn += 1;
        return s;
      }
      s.finished = true;
      s.result = 'player_fainted';
      pushLog(s, ['你已没有可战斗的伙伴。']);
      return s;
    }

    s.turn += 1;
    return s;
  }

  throw new BattleError('ACTION_UNKNOWN', '未知的战斗操作');
}

/**
 * 回合推进的唯一出口：先跑状态机，再把「敌方 HP 减少量」累计到 `damageDealt`。
 *
 * 为什么用 HP 差而不是在伤害公式里打点：
 *  - 公式入口有 4 处（物理 / 特殊 / 多段 / 状态技），逐处打点必然漏；
 *  - 中毒等回合末伤害也属于玩家造成的有效输出，HP 差天然包含；
 *  - 溢出伤害被 `applyDamage` 钳到 0，所以累计值不会超过 Boss 实际血量。
 * 该值只在 Boss 结算时被读取，普通战斗带着它也不影响任何判定。
 */
export function applyBattleAction(
  state: BattleState,
  action: BattleAction,
  ctx: { inventory: Record<string, number>; rng: Rng; now: number; testOHKO?: boolean },
): BattleState {
  const enemyHpBefore = state?.enemy?.hp ?? 0;
  const next = applyBattleActionInner(state, action, ctx);
  if (next && next !== state) {
    const dealt = Math.max(0, enemyHpBefore - (next.enemy?.hp ?? 0));
    if (dealt > 0) next.damageDealt = Math.max(0, Math.floor((next.damageDealt ?? 0) + dealt));
  }
  return next;
}

/** 给路由层用的只读视图：玩家队伍与敌方都下发，但只是展示快照，客户端改不了服务端状态。 */
/**
 * P3-1c：管理员测试标记（原先前端 `testShiny / testMaxStats / testOHKO` 只在本地战斗生效，
 * 战斗上移服务端后会失效）。这里把三者等价地作用在服务端生成的敌人身上，
 * **只允许管理员账号调用**（由路由层查库判定 role，客户端自称不算数）。
 *
 *  - testShiny：敌方异色；
 *  - testMaxStats：敌方六维/成长取下限表上限，并回满 HP（等价前端的满属性测试）；
 *  - testOHKO：敌方开场 1 HP（等价一击必杀，不必给战斗内核开后门）。
 *
 * 标记会写进战斗日志，便于排查「为什么这只怪这么强」。
 */
export function applyAdminTestFlags(
  state: BattleState,
  flags: { testShiny?: boolean; testMaxStats?: boolean; testOHKO?: boolean },
): BattleState {
  const marks: string[] = [];
  let enemy = state.enemy;

  if (flags.testShiny && !enemy.isShiny) {
    enemy = { ...enemy, isShiny: true };
    marks.push('异色');
  }
  if (flags.testMaxStats) {
    const bounds = getMonsterStatBounds(enemy.specId);
    const levelups = Math.max(0, enemy.level - 1);
    const init = bounds.initMax;
    const grow = bounds.gMax;
    const maxHp = init.hp + grow.hp * levelups;
    enemy = {
      ...enemy,
      initStats: { ...init },
      growthRates: { ...grow },
      maxHp,
      hp: maxHp,
      atk: init.atk + grow.atk * levelups,
      def: init.def + grow.def * levelups,
      spAtk: init.spAtk + grow.spAtk * levelups,
      spDef: init.spDef + grow.spDef * levelups,
      spd: init.spd + grow.spd * levelups,
    };
    marks.push('满属性');
  }
  if (flags.testOHKO) {
    enemy = { ...enemy, hp: 1 };
    marks.push('一击必杀');
  }
  if (marks.length === 0) return state;

  state.enemy = enemy;
  state.log = [...state.log, `［管理员测试标记：${marks.join(' / ')}］`];
  return state;
}

export function battleView(s: BattleState) {
  return {
    battleId: s.id,
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
    /**
     * P3-1c：我方队伍下发**完整个体**（含 moveIds / 六维 / initStats / growthRates）。
     * 战斗内的 HP、经验只存在于这份副本里，存档要等结算才更新，所以客户端必须拿它渲染。
     * 这里不做字段裁剪：客户端存档本来就有这些数据，多下发不构成信息泄露，
     * 反而省掉「服务端下发动态字段 + 客户端拼本地静态字段」的二次组装，
     * 避免两边字段漂移导致 UI 显示错位。
     */
    party: s.party,
    ppByMonster: s.ppByMonster,
    rewards: s.rewards,
    levelCap: s.levelCap ?? null,
    captured: s.captured,
    consumed: s.consumed,
    actions: s.actions,
    /**
     * P4-2c：Boss 战标识与**本场伤害**（服务端累计，客户端只渲染）。
     * 非 Boss 战为 null / 0；前端据此在战斗界面显示「讨伐」标题与本场伤害。
     */
    bossId: s.bossId ?? null,
    bossName: s.bossName ?? null,
    damageDealt: s.damageDealt ?? 0,
    gymId: s.gymId ?? null,
    mapBossId: s.mapBossId ?? null,
  };
}

export type BattleView = ReturnType<typeof battleView>;

/** 捕获率展示（客户端 UI 用，避免客户端自己算 ID 真值）。 */
export function previewCaptureChance(s: BattleState, itemId: string): number | null {
  const item = ITEM_SPECS[itemId];
  if (!item || item.kind !== 'capture') return null;
  const spec = MONSTER_SPECS[s.enemy.specId];
  return captureChance(
    s.enemy,
    clamp(spec?.captureRate ?? 0.05, 0.02, 0.62),
    item.modifier ?? 1,
    partyAvgLevel(s.party),
  );
}
