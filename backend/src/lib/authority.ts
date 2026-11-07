/**
 * 服务端权威摘要与意图账本（P1-2 底座）。
 *
 * 背景：P0-3 的自动同步是「整包 PUT /api/save」。只在服务端加裁决接口而不约束这条链路，
 * 客户端下一次自动 PUT 就会把自己算的结果覆盖回数据库（任务表 §7.1）。
 * 本模块提供信任锚：
 *   - expected：服务端认可的资源摘要，整包 PUT 时客户端资源「不得更富」；
 *   - pending：一次性意图授权，记录服务端裁决结果 + 裁决时的基线摘要，
 *     客户端应用结果后带 intentNonce 提交，服务端精确核对增量；
 *   - 挂机会话：服务端时钟记录的 startedAt，客户端 idle.startedAt 一律不采信。
 *
 * 设计原则：纯函数、零外部依赖（不连库、不依赖 Fastify），便于 node:test 单测；
 * 与游戏内容表解耦（ID 真值校验留 P3）。
 *
 * ⚠️ 能力边界：本层能挡住改存档加资源 / 伪造裁决结果 / 重复领奖 / 改系统时间刷挂机；
 *    GG 修改器改内存、加速器改节奏、战斗过程 HP/PP 伪造仍需 P3 客户端瘦终端化根治。
 */
import type { PendingIntent } from './settlements';
import { INITIAL_INVENTORY } from '../game/content.js';

export type ResourceDigest = {
  money: number;
  /** 道具 id -> 数量；expected 里没有的 key 视为 0。 */
  inventory: Record<string, number>;
  /** 幻兽 id -> [等级, 经验]。 */
  levelExp: Record<string, [number, number]>;
  /** party.length + box.length，防止凭空多出幻兽。 */
  rosterCount: number;
  totalCaptured: number;
  clearedAreas: string[];
  /** 挂机派遣的区域 id；null 表示无派遣。 */
  idleAreaId: string | null;
};

export type AuthorityState = {
  expected: ResourceDigest;
  /** 服务端时钟记录的挂机开始时间（毫秒）。客户端 idle.startedAt 一律不采信。 */
  idleStartedAtMs: number | null;
  idleAreaId: string | null;
  idleLevel: number | null;
  /** 裁决次数，便于排查；每次意图成功 +1。 */
  revision: number;
  /** 一次性意图授权（裁决接口写入，带 intentNonce 的 PUT 消费）。 */
  pending: PendingIntent | null;
};

export type DigestViolation = {
  code: string;
  reason: string;
  path: string;
};

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function emptyDigest(): ResourceDigest {
  return { money: 0, inventory: {}, levelExp: {}, rosterCount: 0, totalCaptured: 0, clearedAreas: [], idleAreaId: null };
}

/** 从存档 JSON 文本提取资源摘要。解析失败返回空摘要（调用方会先做结构校验）。 */
export function digestOf(raw: string): ResourceDigest {
  let s: any;
  try {
    s = JSON.parse(raw);
  } catch {
    return emptyDigest();
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return emptyDigest();

  const d = emptyDigest();
  d.money = num(s.money);
  if (s.inventory && typeof s.inventory === 'object' && !Array.isArray(s.inventory)) {
    for (const [k, v] of Object.entries(s.inventory)) d.inventory[k] = num(v);
  }
  for (const list of [s.party, s.box]) {
    if (!Array.isArray(list)) continue;
    for (const m of list) {
      if (m && typeof m === 'object' && typeof m.id === 'string') d.levelExp[m.id] = [num(m.level), num(m.exp)];
    }
  }
  d.rosterCount = (Array.isArray(s.party) ? s.party.length : 0) + (Array.isArray(s.box) ? s.box.length : 0);
  if (s.collection && typeof s.collection === 'object' && !Array.isArray(s.collection)) {
    for (const e of Object.values(s.collection)) {
      if (e && typeof e === 'object') d.totalCaptured += num((e as any).timesCaptured);
    }
  }
  if (s.clearedAreas && typeof s.clearedAreas === 'object' && !Array.isArray(s.clearedAreas)) {
    d.clearedAreas = Object.keys(s.clearedAreas).sort();
  }
  if (s.idle && typeof s.idle === 'object' && typeof s.idle.areaId === 'string') d.idleAreaId = s.idle.areaId;
  return d;
}

/** 容错还原摘要（兼容旧数据/手工改库），缺字段补默认值。 */
function normalizeDigest(p: any): ResourceDigest {
  const d = emptyDigest();
  if (!p || typeof p !== 'object') return d;
  d.money = num(p.money);
  if (p.inventory && typeof p.inventory === 'object') {
    for (const [k, v] of Object.entries(p.inventory)) d.inventory[k] = num(v);
  }
  if (p.levelExp && typeof p.levelExp === 'object') {
    for (const [k, v] of Object.entries(p.levelExp)) {
      if (Array.isArray(v)) d.levelExp[k] = [num(v[0]), num(v[1])];
    }
  }
  d.rosterCount = num(p.rosterCount);
  d.totalCaptured = num(p.totalCaptured);
  d.clearedAreas = Array.isArray(p.clearedAreas) ? p.clearedAreas.filter((x: any) => typeof x === 'string').sort() : [];
  d.idleAreaId = typeof p.idleAreaId === 'string' ? p.idleAreaId : null;
  return d;
}

/** 容错还原一次性意图授权。 */
function normalizePending(p: any): PendingIntent | null {
  if (!p || typeof p !== 'object' || typeof p.nonce !== 'string' || !p.baseDigest || !p.allow) return null;
  return {
    nonce: p.nonce,
    type: typeof p.type === 'string' ? p.type : 'unknown',
    createdAtMs: typeof p.createdAtMs === 'number' ? p.createdAtMs : 0,
    baseDigest: normalizeDigest(p.baseDigest),
    allow: {
      exact: p.allow?.exact && typeof p.allow.exact === 'object' ? p.allow.exact : {},
      max: p.allow?.max && typeof p.allow.max === 'object' ? p.allow.max : {},
      idle: ['start', 'claim', 'cancel'].includes(p.allow?.idle) ? p.allow.idle : undefined,
      rebase: p.allow?.rebase === true,
    },
    result: p.result && typeof p.result === 'object' ? p.result : {},
    idleStart: p.idleStart && typeof p.idleStart.areaId === 'string' ? p.idleStart : undefined,
  };
}

/** 解析存档行上的 authority；不存在/坏数据则以当前存档重建基线（老档平滑升级）。 */
export function parseAuthority(raw: string | null | undefined, saveRaw: string): AuthorityState {
  if (raw) {
    try {
      const p = JSON.parse(raw);
      if (p && p.expected && typeof p.expected === 'object') {
        return {
          expected: normalizeDigest(p.expected),
          idleStartedAtMs: typeof p.idleStartedAtMs === 'number' && Number.isFinite(p.idleStartedAtMs) ? p.idleStartedAtMs : null,
          idleAreaId: typeof p.idleAreaId === 'string' ? p.idleAreaId : null,
          idleLevel: typeof p.idleLevel === 'number' && Number.isFinite(p.idleLevel) ? p.idleLevel : null,
          revision: num(p.revision),
          pending: normalizePending(p.pending),
        };
      }
    } catch {
      // 落到下面重建基线
    }
  }
  return freshAuthority(saveRaw);
}

/** 以某份存档为基线建立权威摘要（首次 PUT / 新游戏重置 / 管理员测试 / 坏数据自愈）。 */
export function freshAuthority(saveRaw: string): AuthorityState {
  return {
    expected: digestOf(saveRaw),
    idleStartedAtMs: null,
    idleAreaId: null,
    idleLevel: null,
    revision: 0,
    pending: null,
  };
}

/** 结算落库后推进权威状态：以服务端认可的存档为准，覆盖挂机会话与 pending。 */
export function advanceAuthority(
  prev: AuthorityState,
  settledSaveRaw: string,
  patch: Partial<Pick<AuthorityState, 'idleStartedAtMs' | 'idleAreaId' | 'idleLevel' | 'pending'>> = {},
): AuthorityState {
  return {
    expected: digestOf(settledSaveRaw),
    idleStartedAtMs: patch.idleStartedAtMs !== undefined ? patch.idleStartedAtMs : prev.idleStartedAtMs,
    idleAreaId: patch.idleAreaId !== undefined ? patch.idleAreaId : prev.idleAreaId,
    idleLevel: patch.idleLevel !== undefined ? patch.idleLevel : prev.idleLevel,
    revision: prev.revision + 1,
    pending: patch.pending !== undefined ? patch.pending : prev.pending,
  };
}

export function serializeAuthority(a: AuthorityState): string {
  return JSON.stringify(a);
}

/**
 * 单调比对（普通整包 PUT）：客户端上报的资源不得高于服务端裁决值。
 * 减少代表合法消耗（用药/丢球/买东西扣钱），放行后调用方把 expected 同步为实际落库摘要，
 * 防止把已发生的消耗「撤销」回去。
 */
export function compareDigest(actual: ResourceDigest, expected: ResourceDigest): DigestViolation[] {
  const out: DigestViolation[] = [];
  if (actual.money > expected.money) {
    out.push({ code: 'AUTHORITY_MONEY_INCREASE', reason: `金币 ${actual.money} 高于服务端裁决值 ${expected.money}，疑似修改数据`, path: 'money' });
  }
  for (const [k, v] of Object.entries(actual.inventory)) {
    const base = expected.inventory[k] ?? 0;
    if (v > base) {
      out.push({ code: 'AUTHORITY_ITEM_INCREASE', reason: `道具 ${k} 数量 ${v} 高于服务端裁决值 ${base}，疑似修改数据`, path: `inventory.${k}` });
    }
  }
  for (const [id, [lv, exp]] of Object.entries(actual.levelExp)) {
    const base = expected.levelExp[id];
    if (!base) continue; // 新 id（新建/重置会整批换 id）不单独拦，由 rosterCount 兜底
    if (lv > base[0] || exp > base[1]) {
      out.push({ code: 'AUTHORITY_MONSTER_INCREASE', reason: `幻兽 ${id} 等级/经验高于服务端裁决值，疑似修改数据`, path: `party.${id}` });
    }
  }
  if (actual.rosterCount > expected.rosterCount) {
    out.push({ code: 'AUTHORITY_ROSTER_INCREASE', reason: `持有幻兽数 ${actual.rosterCount} 高于服务端裁决值 ${expected.rosterCount}，疑似伪造捕获`, path: 'party' });
  }
  if (actual.totalCaptured > expected.totalCaptured) {
    out.push({ code: 'AUTHORITY_CAPTURE_INCREASE', reason: `图鉴捕获次数 ${actual.totalCaptured} 高于服务端裁决值 ${expected.totalCaptured}`, path: 'collection' });
  }
  const baseAreas = new Set(expected.clearedAreas);
  for (const k of actual.clearedAreas) {
    if (!baseAreas.has(k)) {
      out.push({ code: 'AUTHORITY_AREA_INCREASE', reason: `首通区域 ${k} 未经服务端结算`, path: 'clearedAreas' });
    }
  }
  if (actual.idleAreaId !== expected.idleAreaId) {
    out.push({ code: 'AUTHORITY_IDLE_FORGED', reason: '挂机派遣状态与服务端记录不一致', path: 'idle' });
  }
  return out;
}

/**
 * P3-2：队伍个体状态校验（HP / 异常状态）。
 *
 * 资源摘要 `digestOf` 只覆盖金钱、道具、持有数、等级经验、首通与挂机，
 * **不包含 HP 与异常状态**。于是「客户端把 HP 改回满 / 把烧伤清掉」在普通整包 PUT 里
 * 没有任何痕迹：资源没变富，`compareDigest` 直接放行——等于免费治疗。
 *
 * P3-2 之后所有治疗都必须由服务端产生（`/api/game/heal`、战斗结算、道具接口），
 * 所以普通 PUT 里只接受两个方向：
 *   · HP 下降或不变；
 *   · 异常状态变差或不变（解异常同样走服务端）。
 * 变差方向仍然放行，避免玩家在同步失败时被卡死。
 *
 * 返回值是第一条违规（没有则 null）。
 */
export function checkPartyStateRegression(
  prevRaw: string | null | undefined,
  nextRaw: string,
): DigestViolation | null {
  if (!prevRaw) return null;
  let prev: any;
  let next: any;
  try {
    prev = JSON.parse(prevRaw);
    next = JSON.parse(nextRaw);
  } catch {
    return null; // 解析失败交给上层结构校验
  }
  if (!prev?.party || !next?.party) return null;

  const prevById = new Map<string, any>();
  for (const m of Array.isArray(prev.party) ? prev.party : []) {
    if (m && typeof m.id === 'string') prevById.set(m.id, m);
  }
  const nextList = Array.isArray(next.party) ? next.party : [];
  for (const m of nextList) {
    if (!m || typeof m.id !== 'string') continue;
    const before = prevById.get(m.id);
    if (!before) continue; // 新 id：由持有数/捕获校验兜底
    const prevHp = typeof before.hp === 'number' ? before.hp : 0;
    const nextHp = typeof m.hp === 'number' ? m.hp : 0;
    if (nextHp > prevHp) {
      return {
        code: 'AUTHORITY_HP_INCREASE',
        reason: `幻兽 ${m.id} 的 HP 从 ${prevHp} 提升到 ${nextHp}，治疗必须经服务端结算`,
        path: `party.${m.id}.hp`,
      };
    }
    const prevStatus = typeof before.status === 'string' ? before.status : 'none';
    const nextStatus = typeof m.status === 'string' ? m.status : 'none';
    if (prevStatus !== 'none' && nextStatus === 'none') {
      return {
        code: 'AUTHORITY_STATUS_CLEARED',
        reason: `幻兽 ${m.id} 的异常状态 ${prevStatus} 被清除，治疗必须经服务端结算`,
        path: `party.${m.id}.status`,
      };
    }
  }
  return null;
}

/**
 * 「新游戏 / 重置存档」重建基线的准入校验。
 * 自动同步是整包 PUT，无法分辨「玩家点了重新开始」和「外挂造了份存档」。
 * 前端只在这两个动作里标记 rebase，服务端要求这份存档确实像初始档：
 * 资源不得超过初始模板。伪造 rebase 最多只能拿到初始资源，无收益。
 * 初始模板与前端 defaultInventory() / newGame() 一致，改前端初始值时两处同步。
 */
export const FRESH_SAVE_TEMPLATE = {
  moneyMax: 0,
  /** 初始背包从内容表取（真源 src/game/data.ts::INITIAL_INVENTORY），不再手抄一份。 */
  inventory: INITIAL_INVENTORY as Record<string, number>,
  partyMax: 1,
  levelMax: 5,
  stepsMax: 0,
  /** 初始御三家自带 1 次图鉴捕获记录。 */
  capturedMax: 1,
};

export function checkFreshSave(raw: string): { ok: boolean; reason?: string } {
  let s: any;
  try {
    s = JSON.parse(raw);
  } catch {
    return { ok: false, reason: '存档不是合法 JSON' };
  }
  if (!s || typeof s !== 'object' || Array.isArray(s)) return { ok: false, reason: '存档格式不正确' };
  if (num(s.money) > FRESH_SAVE_TEMPLATE.moneyMax) return { ok: false, reason: '重置存档的金币超出初始值' };
  if (num(s.steps) > FRESH_SAVE_TEMPLATE.stepsMax) return { ok: false, reason: '重置存档的步数超出初始值' };
  const inv = s.inventory && typeof s.inventory === 'object' ? s.inventory : {};
  for (const [k, v] of Object.entries(inv)) {
    const limit = FRESH_SAVE_TEMPLATE.inventory[k] ?? 0;
    if (num(v) > limit) return { ok: false, reason: `重置存档的道具 ${k} 超出初始值` };
  }
  const party = Array.isArray(s.party) ? s.party : [];
  if (party.length > FRESH_SAVE_TEMPLATE.partyMax) return { ok: false, reason: '重置存档的队伍超出初始数量' };
  for (const m of party) {
    if (m && num(m.level) > FRESH_SAVE_TEMPLATE.levelMax) return { ok: false, reason: '重置存档的幻兽等级超出初始值' };
  }
  if (Array.isArray(s.box) && s.box.length > 0) return { ok: false, reason: '重置存档不应携带箱子幻兽' };
  if (s.idle) return { ok: false, reason: '重置存档不应存在挂机派遣' };
  if (s.clearedAreas && Object.keys(s.clearedAreas).length > 0) return { ok: false, reason: '重置存档不应存在首通区域' };
  let captured = 0;
  if (s.collection && typeof s.collection === 'object') {
    for (const e of Object.values(s.collection)) captured += num((e as any)?.timesCaptured);
  }
  if (captured > FRESH_SAVE_TEMPLATE.capturedMax) return { ok: false, reason: '重置存档不应存在捕获记录' };
  return { ok: true };
}
