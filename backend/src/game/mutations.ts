/**
 * 服务端存档写操作（P3-2 瘦终端）。
 *
 * 背景：P3-1 之前，除了「战斗」和「商店/挂机/管理员测试」走了服务端裁决，
 * 其余**所有会改存档的操作都还在客户端算**——治疗点回满、战斗外用药、进化、
 * 学招替换、队伍整理、移动。这些操作的结果由客户端算完后整包 PUT，服务端只能
 * 做「资源不得更富」的单调比对，于是：
 *   · 治疗回满不需要在任何据点，也不消耗任何东西（客户端随便调）；
 *   · 进化后的六维由客户端 `evolveMonsterInstance` 决定，服务端只能靠存档校验兜；
 *   · 战斗外道具/状态药的效果是客户端写的，服务端只看到「背包 -1」。
 * 这条链路正是「改客户端就能改结果」的最后一个大面。本模块把这些操作搬到服务端：
 * 客户端只发「我想干什么」，服务端查自己的内容表判定、自己算、自己写，
 * 客户端拿回一份新存档渲染。
 *
 * 纯函数设计：不连库、不碰 WebSocket，输入「已解析的存档对象 + 请求体」，
 * 输出「新存档 + 变更摘要」，由 `modules/game.ts` 负责持久化与广播。
 * 这样 `tests/mutations.test.ts` 可以直接覆盖每一条规则。
 */
import {
  INITIAL_INVENTORY, ITEM_SPECS, LOCATIONS, MONSTER_SPECS, START_LOCATION_ID, STARTERS,
  type ServerMonster,
} from './content';
import { createInstance, evolveMonsterInstance } from './rules';

export const MUTATION_OPS = [
  'heal',
  'use_item',
  'evolve',
  'learn_move',
  'move_to_box',
  'move_to_party',
  'release',
  'travel',
] as const;export type MutationOp = (typeof MUTATION_OPS)[number];

/** 业务拒绝（400，不封号）。code 供前端做文案映射。 */
export class MutationError extends Error {
  constructor(public code: string, message: string) {
    super(message);
  }
}

type Save = Record<string, any>;

export type MutationBody = {
  itemId?: string;
  /** 目标幻兽：优先按 id 定位（party + box 都找），兼容旧的 partyIndex。 */
  monsterId?: string;
  partyIndex?: number;
  boxIndex?: number;
  accept?: boolean;
  oldMoveId?: string | null;
  newMoveId?: string;
  /** 放弃学习：只把这招从待学列表里去掉，不改技能栏。 */
  discard?: boolean;
  locationId?: string;
};

export type MutationEffect = Record<string, unknown>;

export type MutationResult = { save: Save; effect: MutationEffect };

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

function partyOf(save: Save): ServerMonster[] {
  return Array.isArray(save.party) ? (save.party as ServerMonster[]) : [];
}

function boxOf(save: Save): ServerMonster[] {
  return Array.isArray(save.box) ? (save.box as ServerMonster[]) : [];
}

/** 按 id 或下标定位幻兽，返回它在哪个列表里。 */
function locate(
  save: Save,
  body: MutationBody,
): { list: 'party' | 'box'; index: number; monster: ServerMonster } {
  const party = partyOf(save);
  const box = boxOf(save);
  if (typeof body.monsterId === 'string' && body.monsterId.length > 0) {
    const pi = party.findIndex((m) => m.id === body.monsterId);
    if (pi >= 0) return { list: 'party', index: pi, monster: party[pi] };
    const bi = box.findIndex((m) => m.id === body.monsterId);
    if (bi >= 0) return { list: 'box', index: bi, monster: box[bi] };
    throw new MutationError('MONSTER_NOT_FOUND', '找不到这只幻兽');
  }
  const pi = typeof body.partyIndex === 'number' ? body.partyIndex : -1;
  if (pi >= 0 && pi < party.length) return { list: 'party', index: pi, monster: party[pi] };
  throw new MutationError('MONSTER_NOT_FOUND', '找不到这只幻兽');
}

function replaceMonster(save: Save, list: 'party' | 'box', index: number, next: ServerMonster): void {
  const arr = list === 'party' ? partyOf(save) : boxOf(save);
  arr[index] = next;
  if (list === 'party') save.party = arr;
  else save.box = arr;
}

/** 图鉴登记：进化只算「见过 + 拥有」，不增加捕获次数（捕获次数是服务端资源）。 */
function markDex(save: Save, specId: string, locationId: string): void {
  const collection = { ...(save.collection ?? {}) };
  const prev = collection[specId] ?? {};
  const seenLocations = Array.isArray(prev.seenLocations) ? [...prev.seenLocations] : [];
  if (!seenLocations.includes(locationId)) seenLocations.push(locationId);
  collection[specId] = {
    seen: true,
    captured: true,
    timesCaptured: num(prev.timesCaptured),
    seenLocations,
  };
  save.collection = collection;
}

function requireItem(save: Save, itemId: string) {
  const item = ITEM_SPECS[itemId];
  if (!item) throw new MutationError('ITEM_UNKNOWN', '没有这种道具');
  const inventory: Record<string, number> = { ...(save.inventory ?? {}) };
  if (num(inventory[itemId]) < 1) throw new MutationError('ITEM_NOT_ENOUGH', '道具不足');
  return { item, inventory };
}

function consume(inventory: Record<string, number>, itemId: string, save: Save): void {
  inventory[itemId] = Math.max(0, num(inventory[itemId]) - 1);
  save.inventory = inventory;
}

/**
 * 执行一条存档写操作。
 *
 * 所有判定都基于**服务端内容表**（`ITEM_SPECS` / `LOCATIONS` / `MONSTER_SPECS`）：
 * 请求体里只有「用哪个道具」「对哪只幻兽」「去哪」这类意图 ID，没有任何数值。
 */
export function applyMutation(op: MutationOp, rawSave: Save, body: MutationBody): MutationResult {
  if (!rawSave || typeof rawSave !== 'object' || Array.isArray(rawSave)) {
    throw new MutationError('SAVE_UNREADABLE', '存档结构异常');
  }
  const save = clone(rawSave);

  // —— 治疗点：只有带恢复中心的据点才能回满 ——
  if (op === 'heal') {
    const locationId = String(save.locationId ?? '');
    const loc = LOCATIONS[locationId];
    if (!loc?.hasCenter) throw new MutationError('NO_HEAL_CENTER', '这里没有幻兽恢复中心');
    const party = partyOf(save).map((m) => ({ ...m, hp: m.maxHp, status: 'none' as const }));
    save.party = party;
    save.lastHealLocationId = locationId;
    return { save, effect: { healed: party.length, locationId } };
  }

  // —— 战斗外道具：回复 / 解异常 / 进化石 ——
  if (op === 'use_item') {
    const itemId = String(body.itemId ?? '');
    const { item, inventory } = requireItem(save, itemId);
    const target = locate(save, body);

    if (item.kind === 'evolution') {
      // 进化条件由服务端内容表决定：客户端只知道「我想用这块石头」。
      const spec = MONSTER_SPECS[target.monster.specId];
      const evo = spec?.evolutions?.find(
        (e) => e.condition?.type === 'item' && e.condition?.itemId === itemId,
      );
      if (!evo) throw new MutationError('EVOLUTION_NOT_APPLICABLE', '这只幻兽无法使用该进化石');
      const evolved = evolveMonsterInstance(target.monster, evo.targetId);
      consume(inventory, itemId, save);
      replaceMonster(save, target.list, target.index, evolved);
      markDex(save, evolved.specId, String(save.locationId ?? ''));
      return {
        save,
        effect: { itemId, from: target.monster.specId, to: evolved.specId, monsterId: evolved.id },
      };
    }

    if (item.kind === 'heal') {
      const m = target.monster;
      if (num(m.hp) <= 0) throw new MutationError('MONSTER_FAINTED', '倒下的幻兽不能使用回复道具');
      const healed = Math.min(num(m.maxHp), num(m.hp) + num((item as any).heal));
      consume(inventory, itemId, save);
      replaceMonster(save, target.list, target.index, { ...m, hp: healed });
      const party = partyOf(save);
      const cur = party.find((x) => x.id === m.id);
      return { save, effect: { itemId, monsterId: m.id, hp: cur ? cur.hp : healed } };
    }

    if (item.kind === 'status_heal') {
      const m = target.monster;
      const cures = Array.isArray((item as any).cures) ? ((item as any).cures as string[]) : [];
      if (!cures.includes(String(m.status))) {
        throw new MutationError('STATUS_NOT_MATCH', '这只幻兽没有该道具能解除的状态');
      }
      consume(inventory, itemId, save);
      replaceMonster(save, target.list, target.index, { ...m, status: 'none' });
      return { save, effect: { itemId, monsterId: m.id, cured: m.status } };
    }

    throw new MutationError('ITEM_NOT_USABLE', '该道具不能在战斗外使用');
  }

  // —— 待进化：接受或放弃（等级触发）——
  if (op === 'evolve') {
    const target = locate(save, body);
    const pending = target.monster.pendingEvolution;
    if (!pending) throw new MutationError('NO_PENDING_EVOLUTION', '这只幻兽没有等待中的进化');
    if (body.accept === false) {
      replaceMonster(save, target.list, target.index, { ...target.monster, pendingEvolution: undefined });
      return { save, effect: { monsterId: target.monster.id, evolved: false } };
    }
    // 目标必须真的是这个种族配置里的进化去向，客户端塞一个任意 targetId 会被拒。
    const spec = MONSTER_SPECS[target.monster.specId];
    const allowed = (spec?.evolutions ?? []).some((e) => e.targetId === pending.targetId);
    if (!allowed) throw new MutationError('EVOLUTION_TARGET_INVALID', '进化目标与图鉴配置不符');
    const evolved = evolveMonsterInstance(target.monster, pending.targetId);
    replaceMonster(save, target.list, target.index, evolved);
    markDex(save, evolved.specId, String(save.locationId ?? ''));
    return { save, effect: { monsterId: evolved.id, from: target.monster.specId, to: evolved.specId, evolved: true } };
  }

  // —— 学招替换：只能从「待学列表」里挑，替换目标必须是已有技能 ——
  if (op === 'learn_move') {
    const target = locate(save, body);
    const m = target.monster;
    const newMoveId = String(body.newMoveId ?? '');
    const pendingMoves = Array.isArray(m.pendingMoves) ? [...m.pendingMoves] : [];
    const moveIds = Array.isArray(m.moveIds) ? [...m.moveIds] : [];
    if (!newMoveId || !pendingMoves.includes(newMoveId)) {
      throw new MutationError('MOVE_NOT_PENDING', '这个技能不在待学列表里');
    }
    // 放弃学习：只清掉待学标记，技能栏原样保留。
    if (body.discard === true) {
      replaceMonster(save, target.list, target.index, {
        ...m,
        pendingMoves: pendingMoves.filter((x) => x !== newMoveId),
      });
      return { save, effect: { monsterId: m.id, discarded: newMoveId } };
    }
    const oldMoveId = body.oldMoveId ?? null;
    let nextMoveIds: string[];
    if (oldMoveId === null) {
      if (moveIds.length >= 4) throw new MutationError('MOVE_SLOTS_FULL', '技能栏已满，需要指定要替换的技能');
      nextMoveIds = [...moveIds, newMoveId];
    } else {
      const idx = moveIds.indexOf(oldMoveId);
      if (idx < 0) throw new MutationError('MOVE_NOT_KNOWN', '要替换的技能不在这只幻兽身上');
      nextMoveIds = [...moveIds];
      nextMoveIds[idx] = newMoveId;
    }
    replaceMonster(save, target.list, target.index, {
      ...m,
      moveIds: Array.from(new Set(nextMoveIds)),
      pendingMoves: pendingMoves.filter((x) => x !== newMoveId),
    });
    return { save, effect: { monsterId: m.id, newMoveId, replaced: oldMoveId } };
  }

  // —— 队伍整理：出队 / 入队 / 放生 ——
  if (op === 'move_to_box') {
    const party = partyOf(save);
    if (party.length <= 1) throw new MutationError('PARTY_TOO_SMALL', '队伍至少保留一只幻兽');
    const index = num(body.partyIndex);
    if (index >= party.length) throw new MutationError('MONSTER_NOT_FOUND', '找不到这只幻兽');
    const [m] = party.splice(index, 1);
    save.party = party;
    save.box = [...boxOf(save), m];
    return { save, effect: { monsterId: m.id, to: 'box' } };
  }

  if (op === 'move_to_party') {
    const party = partyOf(save);
    if (party.length >= 6) throw new MutationError('PARTY_FULL', '队伍已满 6 只');
    const box = boxOf(save);
    const index = num(body.boxIndex);
    if (index >= box.length) throw new MutationError('MONSTER_NOT_FOUND', '找不到这只幻兽');
    const [m] = box.splice(index, 1);
    save.box = box;
    save.party = [...party, m];
    return { save, effect: { monsterId: m.id, to: 'party' } };
  }

  if (op === 'release') {
    const target = locate(save, body);
    const party = partyOf(save).filter((m) => m.id !== target.monster.id);
    if (target.list === 'party' && party.length === 0) {
      throw new MutationError('PARTY_TOO_SMALL', '队伍至少保留一只幻兽');
    }
    save.party = party;
    save.box = boxOf(save).filter((m) => m.id !== target.monster.id);
    return { save, effect: { monsterId: target.monster.id, released: true } };
  }

  // —— 移动：目前只校验地点合法（地图可达性等 P4 上移）——
  if (op === 'travel') {
    const locationId = String(body.locationId ?? '');
    if (!LOCATIONS[locationId]) throw new MutationError('LOCATION_UNKNOWN', '没有这个地点');
    const visited = Array.isArray(save.visitedLocationIds) ? [...save.visitedLocationIds] : [];
    if (!visited.includes(locationId)) visited.push(locationId);
    save.locationId = locationId;
    save.visitedLocationIds = visited;
    return { save, effect: { locationId } };
  }

  throw new MutationError('OP_UNKNOWN', '未知的操作');
}

// —— 新档生成（P3-2b）——

/**
 * 服务端生成一份全新存档。
 *
 * 之前这一步在前端 `newGame()` 里：客户端用 `createInstance` 掷初始幻兽、拼初始背包，
 * 然后打 rebase 标记让服务端「重建基线」。服务端的 `checkFreshSave` 只能校验
 * 「看起来像新档」（金钱 0、背包不超过模板、等级 ≤ 5），无法验证那只初始幻兽
 * 是不是真的按内容表随机出来的——客户端想给满个体就给满个体。
 * 现在整份新档由服务端生成，客户端只传「名字 + 选哪只御三家」。
 */
export function createNewSave(
  input: { playerName?: unknown; starterSpecId?: unknown },
  ctx: { rng: () => number; schemaVersion: string; nowIso: string },
): Save {
  const name = typeof input.playerName === 'string' ? input.playerName.trim() : '';
  if (!name || name.length > 12) throw new MutationError('NAME_INVALID', '名字需要 1~12 个字符');
  const specId = typeof input.starterSpecId === 'string' ? input.starterSpecId : '';
  if (!STARTERS.includes(specId)) throw new MutationError('STARTER_INVALID', '只能选择初始幻兽');

  const starter = createInstance(specId, 5, ctx.rng);

  const inventory: Record<string, number> = {};
  for (const id of Object.keys(ITEM_SPECS)) inventory[id] = 0;
  for (const [id, qty] of Object.entries(INITIAL_INVENTORY)) inventory[id] = num(qty);

  return {
    version: ctx.schemaVersion,
    playerName: name,
    money: 0,
    steps: 0,
    locationId: START_LOCATION_ID,
    lastHealLocationId: START_LOCATION_ID,
    visitedLocationIds: [START_LOCATION_ID],
    party: [starter],
    box: [],
    inventory,
    collection: {
      [specId]: { seen: true, captured: true, timesCaptured: 1, seenLocations: [START_LOCATION_ID] },
    },
    lastSavedAt: ctx.nowIso,
  };
}
