/**
 * 服务端裁决与增量核对（P1-2 核心 / P1-3 玩法修复的落点）。
 *
 * 两类纯函数：
 *  - decideIntent：服务端唯一的「随机 / 时钟 / 价格 / 奖励公式」出口，产出一次性授权；
 *  - checkIntentDelta：客户端应用裁决结果后提交存档，核对相对基线的资源增量是否
 *    **恰好等于**裁决值（或不超过授权上限）。多一分少一分都拒绝。
 *
 * 为什么用「精确增量」而不是「把服务端存档推给客户端」：P1-2 是渐进改造，
 * 整包存档仍是过渡载体，战斗中间态（HP/PP/状态）不在存档里、由客户端持有。
 * 精确增量让服务端只裁决资源与随机，不打断现有战斗流程；P3 上服务端模拟后再彻底换成瘦终端。
 *
 * 内容真值说明：道具价格/捕获器倍率在这里由服务端持有（经济安全必需）。
 *
 * ⚠️ 2026-11-07 下线 `capture` / `battle_reward` 两个意图：
 *   P1-2 时代战斗在客户端跑，服务端只能采信上报的 `enemyLevel` / `baseRate`
 *   （最多钳一下上界）来裁决奖励与捕获。P3-1c 战斗过程整体上移后，这两个接口
 *   变成「不用打就能领奖」的直通车——任何登录账号反复 POST `battle_reward`
 *   即可刷金币与经验，且 nonce 每次新发、不触发重放检测。
 *   现在奖励与捕获都由 `game/battle.ts` 的 `applySettlement` 在真实战斗结束时写入，
 *   这两条链路不再有任何生产调用方，直接删除，不留兼容开关。
 */
import { digestOf, type ResourceDigest, type DigestViolation, type AuthorityState } from './authority';

export const INTENT_TYPES = [
  'idle_start', 'idle_claim', 'idle_cancel',
  'shop_buy', 'admin_test',
] as const;
export type IntentType = (typeof INTENT_TYPES)[number];

/** 一次性授权：裁决结果 + 允许的精确增量 / 上限增量。 */
export type IntentAllow = {
  /** 必须恰好等于的增量（金钱/道具/持有数/捕获数）。未列出的字段视为 0。 */
  exact?: {
    money?: number;
    inventory?: Record<string, number>;
    rosterCount?: number;
    totalCaptured?: number;
  };
  /** 允许不超过的增量（经验/等级会因 gainExp 升级而变化，无法精确；首通区域同理）。 */
  max?: {
    levelExp?: Record<string, [number, number]>;
    clearedAreas?: string[];
  };
  idle?: 'start' | 'claim' | 'cancel';
  /** 管理员测试菜单：服务端授权重建基线，跳过增量核对。 */
  rebase?: boolean;
};

export type PendingIntent = {
  nonce: string;
  type: string;
  createdAtMs: number;
  /** 裁决请求时服务端落库的基线摘要（可信参照）。 */
  baseDigest: ResourceDigest;
  allow: IntentAllow;
  result: Record<string, unknown>;
  /** idle_start 专用：服务端时钟与服务端确认的区域难度。 */
  idleStart?: { areaId: string; level: number; startedAtMs: number };
};

// —— 服务端持有的内容常量（与前端 src/game/data.ts / idle.ts 保持一致）——
// 改前端价格或挂机参数时必须同步这里，否则经济裁决会与商店显示不一致。
export const ITEM_PRICES: Record<string, number> = {
  capsule_basic: 200, capsule_prism: 600, capsule_ultra: 1200, capsule_master: 100000,
  potion_small: 300, potion_medium: 700, potion_large: 1500, potion_max: 2500,
  heal_antidote: 100, heal_paralyze: 200, heal_awake: 250, heal_burn: 250, heal_ice: 250,
  berry_oran: 100, berry_sitrus: 800, berry_lum: 600,
  stone_fire: 2100, stone_water: 2100, stone_leaf: 2100, stone_thunder: 2100,
  amulet_coin: 10000, exp_share: 50000,
};

/** 服务端挂机参数（与 src/game/idle.ts 一致）。 */
export const IDLE_CAP_MINUTES = 8 * 60;
const CAPSULE_ROLL_MINUTES = 20;
const CAPSULE_DROP_CHANCE = 0.15;
const IDLE_MONEY_BASE = 1.5;
const IDLE_MONEY_PER_LEVEL = 0.15;

function clamp(v: number, min: number, max: number) {
  return Math.max(min, Math.min(max, v));
}
function int(v: unknown, fallback = 0): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.floor(v) : fallback;
}
function parseSave(raw: string): any {
  try { return JSON.parse(raw); } catch { return null; }
}

/** 服务端挂机结算：时钟与 RNG 都在这里，客户端 idle.startedAt 完全不参与。 */
export function settleIdleServer(level: number, minutes: number, rng: () => number) {
  const effective = clamp(Math.floor(minutes), 0, IDLE_CAP_MINUTES);
  const money = Math.floor(effective * (IDLE_MONEY_BASE + level * IDLE_MONEY_PER_LEVEL));
  const capsules: Record<string, number> = {};
  const rolls = Math.floor(effective / CAPSULE_ROLL_MINUTES);
  const pool: Array<{ id: string; weight: number }> = [{ id: 'capsule_basic', weight: 100 }];
  if (level >= 10) pool.push({ id: 'capsule_prism', weight: 28 });
  if (level >= 20) pool.push({ id: 'capsule_ultra', weight: 14 });
  const total = pool.reduce((s, x) => s + x.weight, 0);
  for (let i = 0; i < rolls; i++) {
    if (rng() >= CAPSULE_DROP_CHANCE) continue;
    let r = rng() * total;
    let picked = pool[0].id;
    for (const entry of pool) {
      r -= entry.weight;
      if (r <= 0) { picked = entry.id; break; }
    }
    capsules[picked] = (capsules[picked] ?? 0) + 1;
  }
  return { effective, money, capsules };
}

export type DecisionContext = {
  nowMs: number;
  rng: () => number;
  /** 服务端已校验并落库的当前存档。 */
  dbSaveRaw: string;
  authority: AuthorityState;
  isAdmin: boolean;
  nonce: string;
};

export type DecisionOutcome = { ok: boolean; reason?: string; pending?: PendingIntent };

/** 构造一次性授权；失败时返回中文原因（nonce 已在路由层消费，不允许重试刷 RNG）。 */
export function decideIntent(type: IntentType, payload: Record<string, unknown>, ctx: DecisionContext): DecisionOutcome {
  const save = parseSave(ctx.dbSaveRaw);
  if (!save || typeof save !== 'object') return { ok: false, reason: '服务端存档不可用' };
  const base: PendingIntent = {
    nonce: ctx.nonce,
    type,
    createdAtMs: ctx.nowMs,
    baseDigest: digestOf(ctx.dbSaveRaw),
    allow: { exact: {}, max: {} },
    result: {},
  };
  const inv: Record<string, number> = save.inventory ?? {};

  // —— a 挂机：服务端时钟 + 服务端 RNG ——
  if (type === 'idle_start') {
    const areaId = typeof payload.areaId === 'string' ? payload.areaId : '';
    const area = save.clearedAreas?.[areaId];
    if (!area) return { ok: false, reason: '该区域尚未首通，无法挂机' };
    if (ctx.authority.idleAreaId) return { ok: false, reason: '已有进行中的挂机派遣' };
    const level = int(area.level, 1);
    if (level < 1 || level > 1000) return { ok: false, reason: '挂机区域难度不合法' };
    base.allow.idle = 'start';
    base.idleStart = { areaId, level, startedAtMs: ctx.nowMs };
    base.result = {
      areaId,
      areaName: typeof area.name === 'string' ? area.name : areaId,
      level,
      startedAt: new Date(ctx.nowMs).toISOString(),
    };
    return { ok: true, pending: base };
  }

  if (type === 'idle_claim') {
    const started = ctx.authority.idleStartedAtMs;
    const level = ctx.authority.idleLevel;
    if (started === null || level === null) return { ok: false, reason: '没有可领取的挂机派遣' };
    // 关键：只认服务端时钟。客户端把系统时间往前或往后调都不影响这里。
    const minutes = Math.floor((ctx.nowMs - started) / 60000);
    const r = settleIdleServer(level, minutes, ctx.rng);
    base.allow.exact = { money: r.money, inventory: r.capsules, rosterCount: 0, totalCaptured: 0 };
    base.allow.idle = 'claim';
    base.result = { money: r.money, capsules: r.capsules, minutes: r.effective };
    return { ok: true, pending: base };
  }

  if (type === 'idle_cancel') {
    if (!ctx.authority.idleAreaId) return { ok: false, reason: '没有进行中的挂机派遣' };
    base.allow.idle = 'cancel';
    base.result = { ok: true };
    return { ok: true, pending: base };
  }

  // —— b 捕获与战斗奖励已下线（2026-11-07）——
  // 两者原本都采信客户端上报的过程数据（baseRate / enemyLevel），战斗上移后
  // 成了零成本刷资源的口子。捕获与奖励现在只在 `game/battle.ts` 的真实战斗
  // 结算里产生，这里不再提供意图入口。

  // —— c 经济：商店购买；价格表由服务端持有 ——
  if (type === 'shop_buy') {
    const itemId = typeof payload.itemId === 'string' ? payload.itemId : '';
    const price = ITEM_PRICES[itemId];
    if (price === undefined) return { ok: false, reason: '该道具无法购买' };
    const amount = clamp(int(payload.amount, 1), 1, 99);
    const cost = price * amount;
    const money = typeof save.money === 'number' ? save.money : 0;
    if (money < cost) return { ok: false, reason: '金币不足' };
    base.allow.exact = { money: -cost, inventory: { [itemId]: amount }, rosterCount: 0, totalCaptured: 0 };
    base.result = { itemId, amount, cost };
    return { ok: true, pending: base };
  }

  // —— d 管理员测试菜单：只有服务端判定的管理员能重建基线 ——
  if (type === 'admin_test') {
    if (!ctx.isAdmin) return { ok: false, reason: '没有权限执行该操作' };
    base.allow.rebase = true;
    base.result = { ok: true };
    return { ok: true, pending: base };
  }

  return { ok: false, reason: '未知的操作类型' };
}

/**
 * 精确增量核对：客户端提交的存档相对裁决基线，资源变化必须等于服务端裁决值。
 * 少拿（自损）或多拿（作弊）都拒绝，避免「把裁决结果改一改再落库」。
 * rebase（管理员授权）直接放行，由调用方重建基线。
 */
export function checkIntentDelta(base: ResourceDigest, actual: ResourceDigest, pending: PendingIntent): DigestViolation[] {
  if (pending.allow.rebase) return [];
  const out: DigestViolation[] = [];
  const exact = pending.allow.exact ?? {};
  const max = pending.allow.max ?? {};

  const dMoney = actual.money - base.money;
  if (dMoney !== (exact.money ?? 0)) {
    out.push({ code: 'DELTA_MONEY', reason: `金币变化 ${dMoney} 与服务端裁决值 ${exact.money ?? 0} 不一致`, path: 'money' });
  }

  const keys = new Set([
    ...Object.keys(base.inventory),
    ...Object.keys(actual.inventory),
    ...Object.keys(exact.inventory ?? {}),
  ]);
  for (const k of keys) {
    const d = (actual.inventory[k] ?? 0) - (base.inventory[k] ?? 0);
    const want = exact.inventory?.[k] ?? 0;
    if (d !== want) {
      out.push({ code: 'DELTA_ITEM', reason: `道具 ${k} 变化 ${d} 与服务端裁决值 ${want} 不一致`, path: `inventory.${k}` });
    }
  }

  const dRoster = actual.rosterCount - base.rosterCount;
  if (dRoster !== (exact.rosterCount ?? 0)) {
    out.push({ code: 'DELTA_ROSTER', reason: `持有幻兽变化 ${dRoster} 与服务端裁决值 ${exact.rosterCount ?? 0} 不一致`, path: 'party' });
  }
  const dCaptured = actual.totalCaptured - base.totalCaptured;
  if (dCaptured !== (exact.totalCaptured ?? 0)) {
    out.push({ code: 'DELTA_CAPTURE', reason: `捕获记录变化 ${dCaptured} 与服务端裁决值 ${exact.totalCaptured ?? 0} 不一致`, path: 'collection' });
  }

  for (const [id, [lv, exp]] of Object.entries(actual.levelExp)) {
    const b = base.levelExp[id];
    // 新幻兽 id（捕获成功 / 新建存档）由 exact.rosterCount 精确授权是否允许新增，
    // 不能拿「基线里没有」当成等级/经验增长，否则合法的捕获成功会被误拒。
    if (!b) continue;
    const cap = max.levelExp?.[id] ?? [0, 0];
    if (lv - b[0] > cap[0] || exp - b[1] > cap[1]) {
      out.push({ code: 'DELTA_LEVEL_EXP', reason: `幻兽 ${id} 的等级/经验增长超出服务端奖励`, path: `party.${id}` });
    }
  }

  const baseAreas = new Set(base.clearedAreas);
  const allowedAreas = new Set(max.clearedAreas ?? []);
  for (const k of actual.clearedAreas) {
    if (!baseAreas.has(k) && !allowedAreas.has(k)) {
      out.push({ code: 'DELTA_AREA', reason: `首通区域 ${k} 未经服务端结算`, path: 'clearedAreas' });
    }
  }

  if (pending.allow.idle === 'start') {
    // 不仅要写入派遣，还必须写入服务端裁决的那个区域（难度由服务端定，
    // 客户端不能借 idle_start 塞一个未首通 / 高难度区域来抬高后续挂机收益）。
    if (!actual.idleAreaId || (pending.idleStart && actual.idleAreaId !== pending.idleStart.areaId)) {
      out.push({ code: 'DELTA_IDLE', reason: '挂机派遣区域与服务端裁决不一致', path: 'idle' });
    }
  } else if (pending.allow.idle === 'claim' || pending.allow.idle === 'cancel') {
    if (actual.idleAreaId) out.push({ code: 'DELTA_IDLE', reason: '挂机派遣未正确结束', path: 'idle' });
  } else if (actual.idleAreaId !== base.idleAreaId) {
    out.push({ code: 'DELTA_IDLE', reason: '挂机派遣状态与服务端记录不一致', path: 'idle' });
  }
  return out;
}
