/**
 * P4-2e 共斗 Boss / 副本：状态结构 + 回合推进纯函数。
 *
 * 定位（与排期文档 §4 P4-2e 对应，2026-11-08 杰哥拍板口径）：
 *  - **Boss HP 是房间真值**：整场共斗只有一个 Boss，HP 存在 `CoopState.boss`，
 *    挂在 `RoomState.coop` 上（owner key = `roomId`），写经 `withRoomLock()` 串行。
 *    客户端只发意图、只收 `room.state` 全量快照，永远不能上报 HP / 伤害 / 回合。
 *  - **N 人意图排序**：`sides` 是数组、按座位循环，不写死两个座位；一回合内按
 *    「技能优先度 → 速度 → 座位号」稳定排序依次结算，Boss 最后反击一次。
 *    以后放开 maxSeats 到 3~4 人只改配置，本文件零改动。
 *  - 复用 `rules.ts` 全部公式与 `game/boss.ts::createBossEnemy()`，不重写伤害 / 异常 / 命中。
 *  - **本阶段不发奖励**（F09 / F14 待设计）：意图只 `move:` / `switch:`，
 *    **不支持 flee** —— Boss HP 是共享真值，单人中途退出会让其余成员的回合态与伤害归属分叉，
 *    先用「全员同进同退」简化；逃跑语义留到副本规则设计时一并处理。
 *
 * 本文件零 IO：不 import fastify / prisma / ws，时间与 RNG 全部注入，可直接 node:test。
 */
import {
  MONSTER_SPECS, MOVE_SPECS, emptyMods, type ServerMonster, type StatModifiers,
} from './content.js';
import {
  alive, canMove, executeMoveAction, findFirstAliveIndex, getSpeed, initBattlePP,
  pickUsableMove, type Rng,
} from './rules.js';
import { createBossEnemy, type BossSpec } from './boss.js';

/** 一个成员的战斗视角：active 下标 + 队伍副本 + PP + 能力等级 + 服务端累计伤害。 */
export type CoopSide = {
  userId: string;
  activeIndex: number;
  party: ServerMonster[];
  ppByMonster: Record<string, Record<string, number>>;
  mods: StatModifiers;
  /** 该成员对 Boss 造成的累计伤害，唯一真值 = 每次行动前后 Boss HP 差（溢出被钳，不虚高）。 */
  damage: number;
  /** 队伍全灭且无替补 → 出局；出局座位仍参与房间回合（代放兜底），但不再行动。 */
  out: boolean;
};

/** 共斗态：挂房间态上。Boss 只有一只，HP 是全房唯一真值。 */
export type CoopState = {
  bossId: string;
  bossName: string;
  boss: ServerMonster;
  bossPP: Record<string, number>;
  bossMods: StatModifiers;
  /** 按座位号排列，长度 = 房间座位数；N 人通用。 */
  sides: CoopSide[];
  turn: number;
  log: string[];
  finished: boolean;
  /** null 进行中；'win' Boss 倒下；'lose' 全员出局。 */
  result: 'win' | 'lose' | null;
};

/** 一个成员在一个回合内能提交的意图。共斗刻意不支持逃跑（见文件头）。 */
export type CoopIntent =
  | { type: 'move'; moveId: string }
  | { type: 'switch'; partyIndex: number };

/**
 * 把房间内核的意图字符串解析成结构化 CoopIntent。
 * 编码：`move:<moveId>` / `switch:<0..5>`；其余（含 `flee`）一律 null → 路由回 400。
 */
export function parseCoopIntent(intent: string): CoopIntent | null {
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

/** parseCoopIntent 的逆运算。 */
export function encodeCoopIntent(intent: CoopIntent): string {
  return intent.type === 'switch' ? `switch:${intent.partyIndex}` : `move:${intent.moveId}`;
}

/**
 * 为某个座位挑一个合法意图（托管 / 回合超时代放用）。
 * 优先从还有 PP 的技能里随机挑；PP 全空则换到第一只替补活体；都不行返回 null。
 */
export function pickCoopIntent(state: CoopState, seat: number, rng: Rng): CoopIntent | null {
  const side = state.sides[seat];
  if (!side) return null;
  const m = side.party[side.activeIndex];
  if (m) {
    const pp = side.ppByMonster[m.id] ?? {};
    const moveId = pickUsableMove(m, pp, rng);
    if (moveId) return { type: 'move', moveId };
  }
  const next = side.party.findIndex((x, i) => i !== side.activeIndex && alive(x));
  return next >= 0 ? { type: 'switch', partyIndex: next } : null;
}

export type CoopResult<T> = { ok: true; value: T } | { ok: false; code: string; reason: string };

const ok = <T>(value: T): CoopResult<T> => ({ ok: true, value });
const fail = <T>(code: string, reason: string): CoopResult<T> => ({ ok: false, code, reason });

const MAX_LOG = 200;

function pushLog(s: CoopState, lines: string[]): void {
  if (!lines.length) return;
  const log = [...s.log, ...lines];
  s.log = log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log;
}

function nameOf(m: ServerMonster | undefined): string {
  return m ? (MONSTER_SPECS[m.specId]?.name ?? m.specId) : '幻兽';
}

function active(side: CoopSide): ServerMonster | undefined {
  return side.party[side.activeIndex];
}

/** 用 Boss 内容表 + 各成员队伍建一场共斗。入口前已校验队伍非空。 */
export function createCoopState(params: {
  spec: BossSpec;
  parties: { userId: string; party: ServerMonster[] }[];
  rng: Rng;
}): CoopResult<CoopState> {
  const { spec, parties, rng } = params;
  if (!Array.isArray(parties) || parties.length === 0) {
    return fail('COOP_EMPTY_SEATS', '共斗至少需要一名成员');
  }
  const sides: CoopSide[] = [];
  for (const p of parties) {
    if (!Array.isArray(p.party) || p.party.length === 0) {
      return fail('COOP_EMPTY_PARTY', '队伍为空，无法共斗');
    }
    const idx = findFirstAliveIndex(p.party);
    if (idx < 0) return fail('COOP_FAINTED_PARTY', '队伍中没有可战斗的幻兽');
    sides.push({
      userId: p.userId,
      activeIndex: idx,
      party: p.party.map((m) => ({ ...m })),
      ppByMonster: initBattlePP(p.party),
      mods: emptyMods(),
      damage: 0,
      out: false,
    });
  }
  const boss = createBossEnemy(spec, rng);
  const bossPP = initBattlePP([boss])[boss.id] ?? {};
  return ok({
    bossId: spec.bossId,
    bossName: spec.name,
    boss,
    bossPP,
    bossMods: emptyMods(),
    sides,
    turn: 1,
    log: [`共斗开始：${parties.length} 人挑战 ${spec.name}（${nameOf(boss)}）。`],
    finished: false,
    result: null,
  });
}

/** 回合末持续伤害：对 Boss 与每个成员的 active 各结算一次（与 pvp 同口径）。 */
function endOfTurnDamage(state: CoopState, log: string[]): void {
  const apply = (m: ServerMonster): ServerMonster => {
    if (!alive(m)) return m;
    if (m.status === 'burn') {
      log.push(`${nameOf(m)} 受到烧伤伤害。`);
      return { ...m, hp: Math.max(0, m.hp - Math.max(1, Math.floor(m.maxHp / 16))) };
    }
    if (m.status === 'poison') {
      log.push(`${nameOf(m)} 受到中毒伤害。`);
      return { ...m, hp: Math.max(0, m.hp - Math.max(1, Math.floor(m.maxHp / 8))) };
    }
    return m;
  };
  const bossBefore = state.boss;
  state.boss = apply(bossBefore);
  if (state.boss.hp !== bossBefore.hp && !alive(state.boss)) log.push(`${nameOf(state.boss)} 倒下了！`);
  for (const side of state.sides) {
    const m = active(side);
    if (!m) continue;
    const next = apply(m);
    if (next !== m) side.party[side.activeIndex] = next;
    if (!alive(next)) log.push(`${nameOf(next)} 倒下了。`);
  }
}

/**
 * 回合推进的唯一出口：N 个成员各提交一个意图，服务端排序后依次结算，
 * 随后 Boss 反击一次，最后回合末伤害 + 自动换人 + 胜负判定。
 *
 * 伤害记账只认「行动前后 Boss HP 差」，不采信客户端任何数值；
 * 一次推进只调用一次（房间内核全员交齐才 advanceTurn），并发意图不会让 HP 减两次。
 */
export function applyCoopTurn(
  state: CoopState,
  actions: { seat: number; intent: CoopIntent }[],
  rng: Rng,
): CoopResult<CoopState> {
  if (state.finished) return fail('COOP_FINISHED', '共斗已经结束');

  // 座位 → 意图；缺失座位用服务端代放补齐（超时/托管路径兜底），出局座位跳过。
  const bySeat = new Map<number, CoopIntent>();
  for (const a of actions) {
    if (!Number.isInteger(a.seat) || a.seat < 0 || a.seat >= state.sides.length) {
      return fail('COOP_BAD_SEAT', '座位号不合法');
    }
    if (bySeat.has(a.seat)) return fail('COOP_DUPLICATE_SEAT', '同一座位重复提交');
    bySeat.set(a.seat, a.intent);
  }
  for (let seat = 0; seat < state.sides.length; seat += 1) {
    if (bySeat.has(seat)) continue;
    const picked = pickCoopIntent(state, seat, rng);
    if (picked) bySeat.set(seat, picked);
  }

  // N 人意图排序：技能优先度 → 速度 → 座位号（稳定，可复现）。
  const priorityOf = (intent: CoopIntent): number =>
    intent.type === 'move' ? (MOVE_SPECS[intent.moveId]?.priority ?? 0) : 0;
  const order = [...bySeat.entries()].sort((a, b) => {
    const pa = priorityOf(a[1]);
    const pb = priorityOf(b[1]);
    if (pa !== pb) return pb - pa;
    const sa = getSpeed(active(state.sides[a[0]]), state.sides[a[0]].mods);
    const sb = getSpeed(active(state.sides[b[0]]), state.sides[b[0]].mods);
    if (sa !== sb) return sb - sa;
    return a[0] - b[0];
  });

  const log: string[] = [];
  for (const [seat, intent] of order) {
    const side = state.sides[seat];
    if (side.out || !alive(active(side))) continue;

    // —— 换人 ——
    if (intent.type === 'switch') {
      const idx = Math.floor(intent.partyIndex);
      const next = side.party[idx];
      // 非法意图由服务端裁决为「本回合不行动」，绝不抛异常炸掉整房推进。
      if (!next || idx === side.activeIndex || !alive(next)) {
        log.push(`${side.userId} 的换人意图不合法，本回合未行动。`);
        continue;
      }
      side.activeIndex = idx;
      side.mods = emptyMods();
      log.push(`${side.userId} 派 ${nameOf(next)} 上场了。`);
      continue;
    }

    // —— 技能 ——
    const me = active(side)!;
    const moveId = intent.moveId;
    const myPP = side.ppByMonster[me.id] ?? {};
    const remaining = myPP[moveId] ?? 0;
    if (!me.moveIds?.includes(moveId) || !MOVE_SPECS[moveId] || remaining <= 0) {
      log.push(`${side.userId} 的技能意图不合法，本回合未行动。`);
      continue;
    }
    side.ppByMonster = { ...side.ppByMonster, [me.id]: { ...myPP, [moveId]: remaining - 1 } };

    const can = canMove(me, log, rng);
    const att = { ...me, status: can.nextStatus };
    if (!can.ok) {
      side.party[side.activeIndex] = att;
      continue;
    }

    const before = state.boss.hp;
    const res = executeMoveAction(att, state.boss, side.mods, state.bossMods, moveId, rng);
    side.party[side.activeIndex] = res.nextAttacker;
    side.mods = res.nextAttackerMods;
    state.boss = res.nextDefender;
    state.bossMods = res.nextDefenderMods;
    log.push(...res.logs);
    side.damage += Math.max(0, before - state.boss.hp);

    if (!alive(state.boss)) {
      log.push(`${nameOf(state.boss)} 倒下了！共斗胜利。`);
      break;
    }
  }

  // Boss 反击：从还有 PP 的技能里随机挑一个，打向随机一名仍可战斗的成员。
  if (alive(state.boss)) {
    const targets: number[] = [];
    for (let seat = 0; seat < state.sides.length; seat += 1) {
      const side = state.sides[seat];
      if (!side.out && alive(active(side))) targets.push(seat);
    }
    if (targets.length > 0) {
      const moveId = pickUsableMove(state.boss, state.bossPP, rng);
      if (moveId) {
        state.bossPP = { ...state.bossPP, [moveId]: Math.max(0, (state.bossPP[moveId] ?? 0) - 1) };
        const can = canMove(state.boss, log, rng);
        const bossAtt = { ...state.boss, status: can.nextStatus };
        if (can.ok) {
          const targetSeat = targets[Math.min(targets.length - 1, Math.floor(rng() * targets.length))];
          const target = state.sides[targetSeat];
          const res = executeMoveAction(bossAtt, active(target)!, state.bossMods, target.mods, moveId, rng);
          state.boss = res.nextAttacker;
          state.bossMods = res.nextAttackerMods;
          target.party[target.activeIndex] = res.nextDefender;
          target.mods = res.nextDefenderMods;
          log.push(...res.logs);
        } else {
          state.boss = bossAtt;
        }
      }
    }
  }

  // 回合末持续伤害（Boss 与所有成员）。
  if (alive(state.boss)) endOfTurnDamage(state, log);

  // 倒下后自动换人；无替补则出局。
  for (const side of state.sides) {
    if (alive(active(side))) continue;
    const next = findFirstAliveIndex(side.party);
    if (next < 0) {
      side.out = true;
      log.push(`${side.userId} 的队伍全灭。`);
    } else {
      side.activeIndex = next;
      side.mods = emptyMods();
      log.push(`${side.userId} 派 ${nameOf(side.party[next])} 上场了。`);
    }
  }

  // 胜负判定。
  if (!alive(state.boss)) {
    state.finished = true;
    state.result = 'win';
  } else if (state.sides.every((s) => s.out)) {
    state.finished = true;
    state.result = 'lose';
    log.push('全员倒下，共斗失败。');
  }

  pushLog(state, log);
  state.turn += 1;
  return ok(state);
}

/**
 * 只读视图：按接收者裁剪 —— 己方下发完整队伍（含 PP / 六维），
 * 队友只下发 active 公开信息与累计伤害（共斗不是对抗，伤害榜可公开，但不泄露队友底牌）。
 */
export function coopViewFor(state: CoopState, viewerUserId: string) {
  const selfSeat = state.sides.findIndex((s) => s.userId === viewerUserId);
  const self = state.sides[selfSeat] ?? state.sides[0];
  const publicActive = (m: ServerMonster | undefined) => ({
    specId: m?.specId ?? '',
    name: nameOf(m),
    level: m?.level ?? 0,
    hp: m?.hp ?? 0,
    maxHp: m?.maxHp ?? 0,
    status: m?.status ?? 'none',
    isShiny: !!m?.isShiny,
    alive: alive(m),
  });
  return {
    bossId: state.bossId,
    bossName: state.bossName,
    boss: publicActive(state.boss),
    turn: state.turn,
    finished: state.finished,
    result: state.result,
    log: state.log,
    self: {
      userId: self.userId,
      seat: selfSeat,
      activeIndex: self.activeIndex,
      party: self.party,
      ppByMonster: self.ppByMonster,
      damage: self.damage,
      out: self.out,
    },
    members: state.sides.map((s, i) => ({
      seat: i,
      userId: s.userId,
      self: i === selfSeat,
      damage: s.damage,
      out: s.out,
      active: publicActive(active(s)),
    })),
  };
}
