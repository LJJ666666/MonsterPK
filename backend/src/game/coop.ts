/**
 * F16 共斗 6 房副本：状态结构 + 回合推进纯函数（2026-11-09 杰哥「按默认开工」）。
 *
 * 契约（后端规范 §30）：
 *  - **每房一份 HP 真值**：6 间房、每房固定 2 只敌人，挂在 `RoomState.coop` 上
 *    （owner key = `roomId`），写经 `withRoomLock()` 串行；客户端只发意图、只收
 *    `room.state` 全量快照，永远不能上报 HP / 伤害 / 房间状态 / 回合。
 *  - **一房同时只允许 1 人战斗**：`enter:<0..5>` 认领 `pending` / `defeated` 房，
 *    成功即 `occupantSeat=seat`；同回合两人抢同一间 → 座位号小者优先，其余降级
 *    `idle` 并记日志，**不抛异常炸房间推进**（沿用 P4-2e「非法意图降级跳过」）。
 *  - **战败可重打**：敌人满血重置，但 `contributions` 历史不清零（防反复战败刷贡献）。
 *  - **全清即通关**：6 房全 `cleared` → `win`；全员队伍全灭 → `lose`。
 *  - 伤害真值只认「行动前后敌人 HP 差」，累计到 `rooms[].contributions`，
 *    溢出被钳不虚高；**不写 `BossDamageEvent`、不进单人伤害榜**。
 *  - 房间内核零大改：保留「全员交齐意图 / 超时 → 一次 `advanceTurn`」模型，
 *    本函数在**一次推进内遍历所有 `fighting` 房间**各结算一回合。
 *
 * 零 IO：不 import fastify / prisma / ws，时间与 RNG 全部注入，可直接 node:test。
 */
import {
  MONSTER_SPECS, MOVE_SPECS, THEME_TABLE, emptyMods,
  type ServerMonster, type StatModifiers,
} from './content.js';
import {
  alive, canMove, createInstance, executeMoveAction, findFirstAliveIndex,
  initBattlePP, pickUsableMove, type Rng,
} from './rules.js';
import type { BossSpec } from './boss.js';

// ── §30.8 默认取值：调玩法只改这张常量表，不改状态机 ──
export const COOP_ROOM_COUNT = 6;
export const COOP_ENEMIES_PER_ROOM = 2;
export const COOP_ROOM_BASE_LEVEL = 5;
export const COOP_ROOM_LEVEL_STEP = 2; // Lv.5 / 7 / 9 / 11 / 13 / 15
export const COOP_DAILY_CLEAR_LIMIT = 3;
export const COOP_MIN_CONTRIBUTION = 1; // contributions[seat] >= 1 才发奖（> 0）
export const COOP_OCCUPANTS_PER_ROOM = 1;

export type CoopRoomState = 'pending' | 'fighting' | 'cleared' | 'defeated';

export type CoopRoom = {
  index: number;
  state: CoopRoomState;
  /** 固定 2 只；HP 是该房间的唯一真值。 */
  enemies: ServerMonster[];
  enemyPP: Record<string, number>[];
  enemyMods: StatModifiers[];
  /** 正在打这间的座位；null = 无人占用。 */
  occupantSeat: number | null;
  /** seat → 累计有效伤害；最低贡献门槛与发奖判定的唯一真值。 */
  contributions: Record<number, number>;
  turn: number;
  clearedBy: number | null;
  defeatedBySeat: number | null;
  log: string[];
};

/** 一个成员的战斗视角：active 下标 + 队伍副本 + PP + 能力等级 + 出局标记。 */
export type CoopSide = {
  userId: string;
  activeIndex: number;
  party: ServerMonster[];
  ppByMonster: Record<string, Record<string, number>>;
  mods: StatModifiers;
  /** 队伍全灭且无替补 → 出局；出局座位仍参与房间回合（代放兜底），但不再行动。 */
  out: boolean;
};

export type CoopState = {
  /** 建房时选定的目标（用于 quota key 与只读展示），敌人内容仍由 THEME_TABLE 定。 */
  bossId: string;
  bossName: string;
  theme: string;
  rooms: CoopRoom[];
  sides: CoopSide[];
  /** 每人当前所在房间；-1 = 大厅。 */
  seatRoom: number[];
  turn: number;
  log: string[];
  finished: boolean;
  /** win = 6 房全 cleared；lose = 全员队伍全灭。 */
  result: 'win' | 'lose' | null;
};

/** 一个成员在一个回合内能提交的意图。共斗刻意不支持逃跑（全员同进同退）。 */
export type CoopIntent =
  | { type: 'enter'; roomIndex: number }
  | { type: 'move'; moveId: string }
  | { type: 'switch'; partyIndex: number }
  | { type: 'idle' };

/**
 * 把房间内核的意图字符串解析成结构化 CoopIntent。
 * 编码：`enter:<0..5>` / `move:<moveId>` / `switch:<0..5>` / `idle`；
 * 其余（含 `flee`）一律 null → 路由回 400。
 */
export function parseCoopIntent(intent: string): CoopIntent | null {
  if (intent === 'idle') return { type: 'idle' };
  if (intent.startsWith('enter:')) {
    const raw = intent.slice(6);
    if (!/^\d+$/.test(raw)) return null;
    const roomIndex = Number(raw);
    if (!Number.isInteger(roomIndex) || roomIndex < 0 || roomIndex >= COOP_ROOM_COUNT) return null;
    return { type: 'enter', roomIndex };
  }
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
  switch (intent.type) {
    case 'enter': return `enter:${intent.roomIndex}`;
    case 'switch': return `switch:${intent.partyIndex}`;
    case 'idle': return 'idle';
    default: return `move:${intent.moveId}`;
  }
}

/**
 * 为某个座位挑一个合法意图（托管 / 回合超时代放用）。
 * 在大厅 → 认领第一间可进的房；已 cleared / 全被占 → idle。
 * 在房间内 → 优先有 PP 的技能，PP 全空则换到第一只替补活体，都不行 idle。
 */
export function pickCoopIntent(state: CoopState, seat: number, rng: Rng): CoopIntent {
  const side = state.sides[seat];
  if (!side || side.out) return { type: 'idle' };
  const roomIndex = state.seatRoom[seat];
  if (roomIndex === undefined || roomIndex < 0) {
    const target = state.rooms.find(
      (r) => (r.state === 'pending' || r.state === 'defeated') && r.occupantSeat === null,
    );
    return target ? { type: 'enter', roomIndex: target.index } : { type: 'idle' };
  }
  const room = state.rooms[roomIndex];
  if (!room || room.state !== 'fighting') return { type: 'idle' };
  const m = side.party[side.activeIndex];
  if (m && alive(m)) {
    const pp = side.ppByMonster[m.id] ?? {};
    const moveId = pickUsableMove(m, pp, rng);
    if (moveId && MOVE_SPECS[moveId]) return { type: 'move', moveId };
  }
  const next = side.party.findIndex((x, i) => i !== side.activeIndex && alive(x));
  return next >= 0 ? { type: 'switch', partyIndex: next } : { type: 'idle' };
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

/** 某座位在整场副本里的累计有效伤害（跨房求和，发奖门槛真值）。 */
export function contributionOf(state: CoopState, seat: number): number {
  let sum = 0;
  for (const room of state.rooms) sum += room.contributions[seat] ?? 0;
  return sum;
}

/** 造一间房的敌人：主题表按房号轮换，等级 Lv.5→15 递增。 */
function createRoomEnemies(theme: string, index: number, rng: Rng): ServerMonster[] {
  const pool = THEME_TABLE[theme]?.length ? THEME_TABLE[theme] : (THEME_TABLE.grass ?? []);
  const level = COOP_ROOM_BASE_LEVEL + COOP_ROOM_LEVEL_STEP * index;
  const out: ServerMonster[] = [];
  for (let j = 0; j < COOP_ENEMIES_PER_ROOM; j += 1) {
    const specId = pool.length ? pool[(index * COOP_ENEMIES_PER_ROOM + j) % pool.length] : 'sprout_owl';
    const m = createInstance(specId, level, rng, { id: `d${index}_${j}` });
    out.push({ ...m, hp: m.maxHp, status: 'none' });
  }
  return out;
}

function freshRoom(index: number, spec: BossSpec, rng: Rng): CoopRoom {
  const enemies = createRoomEnemies(spec.theme, index, rng);
  return {
    index,
    state: 'pending',
    enemies,
    enemyPP: enemies.map((e) => initBattlePP([e])[e.id] ?? {}),
    enemyMods: enemies.map(() => emptyMods()),
    occupantSeat: null,
    contributions: {},
    turn: 0,
    clearedBy: null,
    defeatedBySeat: null,
    log: [],
  };
}

/** 用目标主题 + 各成员队伍建一场 6 房副本。入口前已校验队伍非空。 */
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
      out: false,
    });
  }
  const rooms = Array.from({ length: COOP_ROOM_COUNT }, (_, i) => freshRoom(i, spec, rng));
  return ok({
    bossId: spec.bossId,
    bossName: spec.name,
    theme: spec.theme,
    rooms,
    sides,
    seatRoom: parties.map(() => -1),
    turn: 1,
    log: [`副本开始：${COOP_ROOM_COUNT} 间房、每房 ${COOP_ENEMIES_PER_ROOM} 只，全清即通关。`],
    finished: false,
    result: null,
  });
}

/** 持续伤害（烧伤 / 中毒），纯函数：返回扣血后的个体。 */
function burnTick(m: ServerMonster, log: string[]): ServerMonster {
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
}

/**
 * `defeated` 房重打：敌人满血 + 清异常 + PP 复位，**贡献历史保留**。
 * 导出为纯函数便于单测直接验证「满血重置」；`enter` 当回合会立即结算一回合，
 * 因此不能在 `applyCoopTurn` 之后断言敌人仍满血。
 */
export function resetDefeatedRoom(room: CoopRoom): void {
  room.enemies = room.enemies.map((e) => ({ ...e, hp: e.maxHp, status: 'none' }));
  room.enemyPP = room.enemies.map((e) => initBattlePP([e])[e.id] ?? {});
  room.enemyMods = room.enemies.map(() => emptyMods());
  room.defeatedBySeat = null;
}

function releaseRoom(state: CoopState, room: CoopRoom, next: CoopRoomState, log: string[]): void {
  const seat = room.occupantSeat;
  room.state = next;
  room.occupantSeat = null;
  if (seat !== null && state.seatRoom[seat] === room.index) state.seatRoom[seat] = -1;
  if (next === 'cleared') {
    room.clearedBy = seat;
    log.push(`第 ${room.index + 1} 间房已清理。`);
  } else if (next === 'defeated') {
    room.defeatedBySeat = seat;
    log.push(`第 ${room.index + 1} 间房挑战失败，可重新挑战。`);
  }
}

/**
 * 处理本回合所有 `enter` 意图（按座位升序 → 座位号小者优先）。
 * 非法 / 冲突认领一律降级为「本回合不进入」并记日志，绝不抛异常。
 */
function applyEnters(state: CoopState, bySeat: Map<number, CoopIntent>, log: string[]): void {
  for (let seat = 0; seat < state.sides.length; seat += 1) {
    const intent = bySeat.get(seat);
    if (!intent || intent.type !== 'enter') continue;
    const side = state.sides[seat];
    if (side.out) {
      log.push(`座位 ${seat + 1} 已出局，不能进入房间。`);
      continue;
    }
    if (state.seatRoom[seat] !== -1) {
      log.push(`座位 ${seat + 1} 已在房间中，本回合认领未生效。`);
      continue;
    }
    const room = state.rooms[intent.roomIndex];
    if (!room) {
      log.push(`座位 ${seat + 1} 的房间号不合法，本回合未行动。`);
      continue;
    }
    if (room.state === 'cleared') {
      log.push(`第 ${room.index + 1} 间房已清理，无需再进。`);
      continue;
    }
    if (room.state === 'fighting' || room.occupantSeat !== null) {
      log.push(`第 ${room.index + 1} 间房战斗中，座位 ${seat + 1} 本回合等待。`);
      continue;
    }
    if (room.state === 'defeated') resetDefeatedRoom(room);
    room.state = 'fighting';
    room.occupantSeat = seat;
    state.seatRoom[seat] = room.index;
    log.push(`座位 ${seat + 1} 进入第 ${room.index + 1} 间房。`);
  }
}

/** 结算一间 `fighting` 房间的一回合；返回该房间本回合产生的日志。 */
function resolveRoom(state: CoopState, room: CoopRoom, bySeat: Map<number, CoopIntent>, rng: Rng): string[] {
  const log: string[] = [];
  const seat = room.occupantSeat;
  if (seat === null) return log;
  const side = state.sides[seat];
  if (!side || side.out) {
    releaseRoom(state, room, 'defeated', log);
    return log;
  }

  // 本回合刚 enter 的座位：意图是 enter，用服务端代放补一个合法战斗动作。
  let intent = bySeat.get(seat);
  if (!intent || intent.type === 'enter') intent = pickCoopIntent(state, seat, rng);

  // —— 玩家行动（打第一个存活敌人）——
  let targetIdx = room.enemies.findIndex((e) => alive(e));
  if (targetIdx < 0) {
    releaseRoom(state, room, 'cleared', log);
    return log;
  }
  if (intent.type === 'switch') {
    const idx = Math.floor(intent.partyIndex);
    const next = side.party[idx];
    if (!next || idx === side.activeIndex || !alive(next)) {
      log.push(`座位 ${seat + 1} 的换人意图不合法，本回合未行动。`);
    } else {
      side.activeIndex = idx;
      side.mods = emptyMods();
      log.push(`座位 ${seat + 1} 派 ${nameOf(next)} 上场了。`);
    }
  } else if (intent.type === 'move') {
    const me = active(side)!;
    const moveId = intent.moveId;
    const myPP = side.ppByMonster[me.id] ?? {};
    const remaining = myPP[moveId] ?? 0;
    if (!me.moveIds?.includes(moveId) || !MOVE_SPECS[moveId] || remaining <= 0) {
      log.push(`座位 ${seat + 1} 的技能意图不合法，本回合未行动。`);
    } else {
      side.ppByMonster = { ...side.ppByMonster, [me.id]: { ...myPP, [moveId]: remaining - 1 } };
      const can = canMove(me, log, rng);
      const att = { ...me, status: can.nextStatus };
      if (!can.ok) {
        side.party[side.activeIndex] = att;
      } else {
        const enemy = room.enemies[targetIdx];
        const before = enemy.hp;
        const res = executeMoveAction(att, enemy, side.mods, room.enemyMods[targetIdx], moveId, rng);
        side.party[side.activeIndex] = res.nextAttacker;
        side.mods = res.nextAttackerMods;
        room.enemies[targetIdx] = res.nextDefender;
        room.enemyMods[targetIdx] = res.nextDefenderMods;
        log.push(...res.logs);
        const dealt = Math.max(0, before - room.enemies[targetIdx].hp);
        if (dealt > 0) room.contributions[seat] = (room.contributions[seat] ?? 0) + dealt;
        if (!alive(room.enemies[targetIdx])) log.push(`${nameOf(room.enemies[targetIdx])} 倒下了！`);
      }
    }
  }

  // —— 存活敌人各反击一次 ——
  for (let j = 0; j < room.enemies.length; j += 1) {
    const enemy = room.enemies[j];
    if (!alive(enemy)) continue;
    const me = active(side);
    if (!me || !alive(me)) break;
    const moveId = pickUsableMove(enemy, room.enemyPP[j], rng);
    if (!moveId) continue;
    room.enemyPP[j] = { ...room.enemyPP[j], [moveId]: Math.max(0, (room.enemyPP[j][moveId] ?? 0) - 1) };
    const can = canMove(enemy, log, rng);
    const enemyAtt = { ...enemy, status: can.nextStatus };
    if (!can.ok) {
      room.enemies[j] = enemyAtt;
      continue;
    }
    const res = executeMoveAction(enemyAtt, me, room.enemyMods[j], side.mods, moveId, rng);
    room.enemies[j] = res.nextAttacker;
    room.enemyMods[j] = res.nextAttackerMods;
    side.party[side.activeIndex] = res.nextDefender;
    side.mods = res.nextDefenderMods;
    log.push(...res.logs);
  }

  // —— 回合末持续伤害（该房敌人 + 该成员 active）——
  for (let j = 0; j < room.enemies.length; j += 1) {
    const next = burnTick(room.enemies[j], log);
    if (next !== room.enemies[j]) {
      room.enemies[j] = next;
      if (!alive(next)) log.push(`${nameOf(next)} 倒下了！`);
    }
  }
  const meNow = active(side);
  if (meNow) {
    const next = burnTick(meNow, log);
    if (next !== meNow) side.party[side.activeIndex] = next;
  }

  // —— 自动换人 / 出局 ——
  if (!alive(active(side))) {
    const next = findFirstAliveIndex(side.party);
    if (next < 0) {
      side.out = true;
      log.push(`座位 ${seat + 1} 的队伍全灭。`);
    } else {
      side.activeIndex = next;
      side.mods = emptyMods();
      log.push(`座位 ${seat + 1} 派 ${nameOf(side.party[next])} 上场了。`);
    }
  }

  // —— 房间胜负判定 ——
  if (room.enemies.every((e) => !alive(e))) releaseRoom(state, room, 'cleared', log);
  else if (side.out) releaseRoom(state, room, 'defeated', log);

  room.turn += 1;
  const roomLog = [...room.log, ...log];
  room.log = roomLog.length > 40 ? roomLog.slice(roomLog.length - 40) : roomLog;
  return log;
}

/**
 * 回合推进的唯一出口：一次推进内先处理 `enter` 认领，再遍历所有 `fighting` 房间
 * 各结算一回合。伤害记账只认 HP 差，不采信客户端任何数值。
 */
export function applyCoopTurn(
  state: CoopState,
  actions: { seat: number; intent: CoopIntent }[],
  rng: Rng,
): CoopResult<CoopState> {
  if (state.finished) return fail('COOP_FINISHED', '共斗已经结束');

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
    bySeat.set(seat, pickCoopIntent(state, seat, rng));
  }

  const log: string[] = [];
  applyEnters(state, bySeat, log);
  for (const room of state.rooms) {
    if (room.state !== 'fighting') continue;
    log.push(...resolveRoom(state, room, bySeat, rng));
  }

  const cleared = state.rooms.filter((r) => r.state === 'cleared').length;
  if (cleared === COOP_ROOM_COUNT) {
    state.finished = true;
    state.result = 'win';
    log.push('六间房全部清理，副本通关！');
  } else if (state.sides.every((s) => s.out)) {
    state.finished = true;
    state.result = 'lose';
    log.push('全员倒下，副本失败。');
  }

  pushLog(state, log);
  state.turn += 1;
  return ok(state);
}

/**
 * 只读视图：房间状态对全体可见（协作玩法口径），但队友仍不下发未上场成员与技能 PP。
 * 客户端零计算，只渲染「未挑战 / 战斗中 / 已清理 / 已战败」。
 */
export function coopViewFor(state: CoopState, viewerUserId: string) {
  const selfSeat = state.sides.findIndex((s) => s.userId === viewerUserId);
  const seat = selfSeat >= 0 ? selfSeat : 0;
  const self = state.sides[seat] ?? state.sides[0];
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
    theme: state.theme,
    turn: state.turn,
    finished: state.finished,
    result: state.result,
    log: state.log,
    rooms: state.rooms.map((r) => ({
      index: r.index,
      state: r.state,
      occupantSeat: r.occupantSeat,
      clearedBy: r.clearedBy,
      defeatedBySeat: r.defeatedBySeat,
      contributions: { ...r.contributions },
      enemyPreviews: r.enemies.map(publicActive),
    })),
    cleared: state.rooms.filter((r) => r.state === 'cleared').length,
    total: COOP_ROOM_COUNT,
    self: {
      userId: self.userId,
      seat,
      roomIndex: state.seatRoom[seat] ?? -1,
      activeIndex: self.activeIndex,
      party: self.party,
      ppByMonster: self.ppByMonster,
      contribution: contributionOf(state, seat),
      out: self.out,
    },
    members: state.sides.map((s, i) => ({
      seat: i,
      userId: s.userId,
      self: i === seat,
      roomIndex: state.seatRoom[i] ?? -1,
      out: s.out,
      contribution: contributionOf(state, i),
      active: publicActive(active(s)),
    })),
  };
}
