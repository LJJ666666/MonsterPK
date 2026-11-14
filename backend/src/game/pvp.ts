/**
 * P4-2d 玩家对战 1v1：状态结构 + 回合推进纯函数。
 *
 * 定位（与排期文档 §4 P4-2d 对应）：
 *  - 1v1 **不新增权威源**：战斗态挂在房间态（owner key = `roomId`）上，写经 `withRoomLock()` 串行。
 *  - 复用 `rules.ts` 的全部公式（伤害 / 命中 / 暴击 / 速度 / PP / 异常 / 回合末），
 *    不重写一套战斗逻辑 —— 否则会与 P3-1 服务端战斗产生两套真值。
 *  - 与单人战斗（`game/battle.ts`）的关键差异：那里「我方是玩家、敌方是服务端 AI」；
 *    这里「双方都是玩家」，各自的 `enemy` 就是对方的 active 幻兽。因此需要一个
 *    **双方镜像**的状态结构，而不是把一方塞进 `BattleState.enemy`。
 *
 * 本文件零 IO：不 import fastify / prisma / ws，时间与 RNG 全部注入，可直接 node:test。
 */

import {
  MONSTER_SPECS, MOVE_SPECS, emptyMods, type ServerMonster, type StatModifiers,
} from './content.js';
import {
  alive, canMove, executeMoveAction, findFirstAliveIndex, getSpeed, initBattlePP,
  pickUsableMove, processEndOfTurn, type Rng,
} from './rules.js';

/** 一方的战斗视角：active 下标 + 队伍副本 + PP + 能力等级。 */
export type PvpSide = {
  userId: string;
  activeIndex: number;
  party: ServerMonster[];
  ppByMonster: Record<string, Record<string, number>>;
  mods: StatModifiers;
};

/** 1v1 战斗态：挂在房间态上，双方镜像。 */
export type PvpState = {
  /** 座位 0 / 1 分别对应 sides[0] / sides[1]。 */
  sides: [PvpSide, PvpSide];
  turn: number;
  log: string[];
  finished: boolean;
  /** null = 进行中；否则为胜方 userId（一方全灭 / 逃跑成功）。 */
  winnerUserId: string | null;
  /** 逃跑成功的一方（PvP 逃跑 = 认输，判负）。 */
  fledUserId: string | null;
};

/** 一个玩家在一个回合内能提交的意图。 */
export type PvpIntent =
  | { type: 'move'; moveId: string }
  | { type: 'switch'; partyIndex: number }
  | { type: 'flee' };

/**
 * 把房间内核的意图字符串解析成结构化 PvpIntent。
 * 编码：`move:<moveId>` / `switch:<0..5>` / `flee`。
 * 解析失败返回 null（调用方回 400）。
 */
export function parsePvpIntent(intent: string): PvpIntent | null {
  if (intent === 'flee') return { type: 'flee' };
  if (intent.startsWith('move:')) {
    const moveId = intent.slice(5);
    if (!moveId || !/^[A-Za-z0-9_\-]+$/.test(moveId)) return null;
    return { type: 'move', moveId };
  }
  if (intent.startsWith('switch:')) {
    const raw = intent.slice(7);
    if (!/^\d+$/.test(raw)) return null;
    const partyIndex = Number(raw);
    if (!Number.isInteger(partyIndex) || partyIndex < 0 || partyIndex > 5) return null;
    return { type: 'switch', partyIndex };
  }
  return null;
}

/**
 * 把结构化 PvpIntent 编码成房间内核的意图字符串（parsePvpIntent 的逆运算）。
 */
export function encodePvpIntent(intent: PvpIntent): string {
  if (intent.type === 'flee') return 'flee';
  if (intent.type === 'switch') return `switch:${intent.partyIndex}`;
  return `move:${intent.moveId}`;
}

/**
 * 从 PvpState 为某个座位挑一个可用意图（托管 / 超时代放用）。
 * 与单人战斗的 `pickUsableMove` 同思路：从还有 PP 的技能里随机挑。
 */
export function pickPvpIntent(state: PvpState, seat: number, rng: Rng): PvpIntent | null {
  const side = state.sides[seat];
  if (!side) return null;
  const m = side.party[side.activeIndex];
  const pp = side.ppByMonster[m.id] ?? {};
  const usable = (m.moveIds ?? []).filter((id) => (pp[id] ?? 0) > 0);
  if (usable.length === 0) return { type: 'flee' };
  return { type: 'move', moveId: usable[Math.floor(rng() * usable.length)] };
}

export type PvpResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

const ok = <T>(value: T): PvpResult<T> => ({ ok: true, value });
const fail = <T>(code: string, reason: string): PvpResult<T> => ({ ok: false, code, reason });

const MAX_LOG = 200;

function pushLog(s: PvpState, lines: string[]): void {
  if (!lines.length) return;
  const log = [...s.log, ...lines];
  s.log = log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log;
}

function nameOf(m: ServerMonster): string {
  return MONSTER_SPECS[m.specId]?.name ?? m.specId;
}

/**
 * 用双方的队伍建一场 1v1 战斗。
 * 入口前已校验队伍非空、有活体；这里只负责把双方镜像化并建立 PP。
 */
export function createPvpState(params: {
  sideA: { userId: string; party: ServerMonster[] };
  sideB: { userId: string; party: ServerMonster[] };
  now: number;
}): PvpResult<PvpState> {
  const { sideA, sideB } = params;
  if (!Array.isArray(sideA.party) || !Array.isArray(sideB.party)) {
    return fail('PVP_BAD_PARTY', '队伍数据不合法');
  }
  if (sideA.party.length === 0 || sideB.party.length === 0) {
    return fail('PVP_EMPTY_PARTY', '队伍为空，无法对战');
  }
  const aIdx = findFirstAliveIndex(sideA.party);
  const bIdx = findFirstAliveIndex(sideB.party);
  if (aIdx < 0 || bIdx < 0) {
    return fail('PVP_FAINTED_PARTY', '队伍中没有可战斗的幻兽');
  }
  const makeSide = (side: { userId: string; party: ServerMonster[] }, activeIndex: number): PvpSide => ({
    userId: side.userId,
    activeIndex,
    party: side.party.map((m) => ({ ...m })),
    ppByMonster: initBattlePP(side.party),
    mods: emptyMods(),
  });
  const sides: [PvpSide, PvpSide] = [makeSide(sideA, aIdx), makeSide(sideB, bIdx)];
  return ok({
    sides,
    turn: 1,
    log: [`对战开始：${nameOf(sides[0].party[aIdx])} vs ${nameOf(sides[1].party[bIdx])}。`],
    finished: false,
    winnerUserId: null,
    fledUserId: null,
  });
}

/** 取对方 side。 */
function other(sides: [PvpSide, PvpSide], self: PvpSide): PvpSide {
  return sides[0] === self ? sides[1] : sides[0];
}

/** 我方 active 幻兽。 */
function active(side: PvpSide): ServerMonster {
  return side.party[side.activeIndex];
}

/**
 * 结算一方的一个动作，返回「对方是否被打倒 / 我方是否逃跑成功」等信息。
 * 返回新 party / mods / pp，**不原地修改 side**（调用方决定是否写回）。
 */
function applySideAction(
  side: PvpSide,
  foe: PvpSide,
  action: PvpIntent,
  log: string[],
  rng: Rng,
): { side: PvpSide; foe: PvpSide; foeFainted: boolean; fled: boolean } {
  const me = { ...side, party: [...side.party], ppByMonster: { ...side.ppByMonster }, mods: { ...side.mods } };
  const enemy = { ...foe, party: [...foe.party], ppByMonster: { ...foe.ppByMonster }, mods: { ...foe.mods } };
  const a = active(me);
  const e = active(enemy);

  // —— 逃跑 ——
  if (action.type === 'flee') {
    // PvP 逃跑：速度优势 75%，否则 50%；成功即认输（判负），对方获胜。
    const chance = getSpeed(a, me.mods) >= getSpeed(e, enemy.mods) ? 0.75 : 0.5;
    if (rng() < chance) {
      log.push(`${nameOf(a)} 成功撤离了对战场。`);
      return { side: me, foe: enemy, foeFainted: false, fled: true };
    }
    log.push(`${nameOf(a)} 撤离失败！`);
    return { side: me, foe: enemy, foeFainted: false, fled: false };
  }

  // —— 换人 ——
  if (action.type === 'switch') {
    const idx = Math.floor(action.partyIndex);
    const next = me.party[idx];
    if (!next) throw new PvpError('PARTY_INDEX_INVALID', '队伍位置不合法');
    if (idx === me.activeIndex) throw new PvpError('SAME_ACTIVE', '已经在场上了');
    if (!alive(next)) throw new PvpError('MONSTER_FAINTED', '已倒下的幻兽无法上场');
    me.activeIndex = idx;
    me.mods = emptyMods();
    log.push(`${nameOf(next)} 上场了。`);
    return { side: me, foe: enemy, foeFainted: false, fled: false };
  }

  // —— 技能 ——
  if (action.type === 'move') {
    const moveId = action.moveId;
    if (!a.moveIds?.includes(moveId)) throw new PvpError('MOVE_UNKNOWN', '该幻兽没有掌握这个技能');
    if (!MOVE_SPECS[moveId]) throw new PvpError('MOVE_UNKNOWN', '未知技能');
    const myPP = me.ppByMonster[a.id] ?? {};
    const remaining = myPP[moveId] ?? 0;
    if (remaining <= 0) throw new PvpError('PP_EXHAUSTED', '该技能的 PP 已耗尽');
    me.ppByMonster = { ...me.ppByMonster, [a.id]: { ...myPP, [moveId]: remaining - 1 } };

    const can = canMove(a, log, rng);
    let att = { ...a, status: can.nextStatus };
    if (!can.ok) {
      me.party[me.activeIndex] = att;
      return { side: me, foe: enemy, foeFainted: false, fled: false };
    }

    const res = executeMoveAction(att, e, me.mods, enemy.mods, moveId, rng);
    att = res.nextAttacker;
    let def = res.nextDefender;
    me.mods = res.nextAttackerMods;
    enemy.mods = res.nextDefenderMods;
    log.push(...res.logs);

    me.party[me.activeIndex] = att;
    enemy.party[enemy.activeIndex] = def;
    const foeFainted = !alive(def);
    if (foeFainted) log.push(`${nameOf(def)} 倒下了。`);
    return { side: me, foe: enemy, foeFainted, fled: false };
  }

  throw new PvpError('ACTION_UNKNOWN', '未知的对战操作');
}

/** 一方倒下后自动换下一只活体；无活体返回 false。 */
function autoSwitchFainted(side: PvpSide, log: string[]): boolean {
  const a = active(side);
  if (alive(a)) return true;
  const next = findFirstAliveIndex(side.party);
  if (next < 0) return false;
  side.activeIndex = next;
  side.mods = emptyMods();
  log.push(`${nameOf(side.party[next])} 上场了。`);
  return true;
}

/**
 * 回合推进的唯一出口：双方各提交一个意图，服务端按速度 / 优先度决定先后，
 * 结算双方行动 + 回合末持续伤害，判断胜负。
 *
 * 一个回合内最多只有一个「倒下 → 换人」的连锁（换人本身不算攻击，回合结束）。
 * 一方逃跑成功即判负（对方获胜），立即结束。
 */
export function applyPvpTurn(
  state: PvpState,
  actions: { seat: number; intent: PvpIntent }[],
  rng: Rng,
): PvpResult<PvpState> {
  if (state.finished) return fail('PVP_FINISHED', '对战已经结束');
  if (actions.length !== 2) return fail('PVP_NEED_TWO_ACTIONS', '需要双方各提交一个意图');

  // 座位 → side 映射：seat 0 / 1 与 sides[0] / sides[1] 对齐（房间座位号 = 加入顺序）。
  const bySeat = new Map<number, PvpIntent>();
  for (const a of actions) {
    if (a.seat !== 0 && a.seat !== 1) return fail('PVP_BAD_SEAT', '座位号不合法');
    if (bySeat.has(a.seat)) return fail('PVP_DUPLICATE_SEAT', '同一座位重复提交');
    bySeat.set(a.seat, a.intent);
  }
  const intentOf = (seat: number): PvpIntent => bySeat.get(seat) as PvpIntent;

  const log: string[] = [];
  const s0 = state.sides[0];
  const s1 = state.sides[1];

  // 决定先手：技能优先度 → 速度 → 随机（与单人战斗同口径）。
  const prio = (side: PvpSide, intent: PvpIntent): number =>
    intent.type === 'move' ? (MOVE_SPECS[intent.moveId]?.priority ?? 0) : 0;
  const p0 = prio(s0, intentOf(0));
  const p1 = prio(s1, intentOf(1));

  let first: PvpSide;
  let second: PvpSide;
  let firstIntent: PvpIntent;
  let secondIntent: PvpIntent;
  if (p0 > p1) {
    first = s0; second = s1; firstIntent = intentOf(0); secondIntent = intentOf(1);
  } else if (p1 > p0) {
    first = s1; second = s0; firstIntent = intentOf(1); secondIntent = intentOf(0);
  } else {
    const spd0 = getSpeed(active(s0), s0.mods);
    const spd1 = getSpeed(active(s1), s1.mods);
    if (spd0 > spd1 || (spd0 === spd1 && rng() < 0.5)) {
      first = s0; second = s1; firstIntent = intentOf(0); secondIntent = intentOf(1);
    } else {
      first = s1; second = s0; firstIntent = intentOf(1); secondIntent = intentOf(0);
    }
  }

  // 依次结算双方行动（后手若已被先手打倒则无法行动）。
  // sides 索引 == seat 号（sides[0]=seat0, sides[1]=seat1），顺序永不改变，
  // 因此用 seat 定位，不用引用查找（applySideAction 会复制 side，引用会失效）。
  const seatOf = (side: PvpSide): number => (side.userId === s0.userId ? 0 : 1);
  let sides: [PvpSide, PvpSide] = [s0, s1];
  const applyOne = (side: PvpSide, intent: PvpIntent): { fled: boolean } => {
    const seat = seatOf(side);
    const foeSeat = seat === 0 ? 1 : 0;
    const foe = sides[foeSeat];
    const r = applySideAction(side, foe, intent, log, rng);
    sides[seat] = r.side;
    sides[foeSeat] = r.foe;
    if (r.fled) {
      state.finished = true;
      state.fledUserId = side.userId;
      state.winnerUserId = foe.userId;
      log.push(`${nameOf(active(r.foe))} 获胜！`);
    }
    return { fled: r.fled };
  };

  let res0 = applyOne(first, firstIntent);
  if (!res0.fled && alive(active(sides[seatOf(second)])) && alive(active(sides[seatOf(first)]))) {
    applyOne(second, secondIntent);
  }

  // 回合末持续伤害（双方各结算一次）。
  const eotLog: string[] = [];
  const applyEot = (seat: number): void => {
    const side = sides[seat];
    const m = active(side);
    if (!alive(m)) return;
    if (m.status === 'burn') {
      const next = { ...m, hp: Math.max(0, m.hp - Math.max(1, Math.floor(m.maxHp / 16))) };
      sides[seat] = { ...side, party: side.party.map((x, i) => (i === side.activeIndex ? next : x)) };
      eotLog.push(`${nameOf(m)} 受到烧伤伤害。`);
      if (!alive(next)) eotLog.push(`${nameOf(m)} 倒下了。`);
    } else if (m.status === 'poison') {
      const next = { ...m, hp: Math.max(0, m.hp - Math.max(1, Math.floor(m.maxHp / 8))) };
      sides[seat] = { ...side, party: side.party.map((x, i) => (i === side.activeIndex ? next : x)) };
      eotLog.push(`${nameOf(m)} 受到中毒伤害。`);
      if (!alive(next)) eotLog.push(`${nameOf(m)} 倒下了。`);
    }
  };
  applyEot(0);
  applyEot(1);
  log.push(...eotLog);

  state.sides = sides;

  // 倒下后的自动换人（一回合最多换一次）。
  for (let seat = 0; seat < 2; seat += 1) {
    if (state.finished) break;
    const side = sides[seat];
    const foe = sides[seat === 0 ? 1 : 0];
    if (!autoSwitchFainted(side, log)) {
      state.finished = true;
      state.winnerUserId = foe.userId;
      log.push(`${nameOf(active(foe))} 获胜！`);
      break;
    }
  }

  pushLog(state, log);
  state.turn += 1;
  return ok(state);
}

export class PvpError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * 只读视图：按接收者裁剪 —— 己方队伍下发完整个体，对方只下发 active 的公开信息
 * （种族 / 等级 / HP / 状态 / 异色），不下发对方未上场成员与技能 PP 之外的细节，
 * 避免把对方的队伍底牌泄露给对手。
 */
export function pvpViewFor(state: PvpState, viewerUserId: string) {
  const selfSeat = state.sides.findIndex((s) => s.userId === viewerUserId);
  const self = state.sides[selfSeat] ?? state.sides[0];
  const foe = other(state.sides, self);
  const foeActive = active(foe);
  return {
    turn: state.turn,
    finished: state.finished,
    winnerUserId: state.winnerUserId,
    winnerIsSelf: state.winnerUserId === viewerUserId,
    fledUserId: state.fledUserId,
    log: state.log,
    self: {
      userId: self.userId,
      activeIndex: self.activeIndex,
      party: self.party,
      ppByMonster: self.ppByMonster,
    },
    foe: {
      userId: foe.userId,
      activeIndex: foe.activeIndex,
      // 按接收者裁剪：在场这只下发明细（HP/状态可见），替补只暴露种族/等级
      // （组合可见），实时 HP/状态清零——否则对手改包/DevTools 能窥探我方替补
      // 当前状态（PvpModal 只读 activeIndex，本改动不影响 UI）。
      party: foe.party.map((m, i) =>
        i === foe.activeIndex
          ? {
              specId: m.specId,
              level: m.level,
              hp: m.hp,
              maxHp: m.maxHp,
              status: m.status,
              isShiny: !!m.isShiny,
              alive: alive(m),
              inField: true,
            }
          : {
              specId: m.specId,
              level: m.level,
              hp: 0,
              maxHp: 0,
              status: 'none',
              isShiny: false,
              alive: true,
              inField: false,
            },
      ),
    },
  };
}
