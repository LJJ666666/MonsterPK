/**
 * 后端端到端测试共享工具（P3-1 后固化，2026-11-07）。
 *
 * 目的：把「HTTP 请求 / 注册账号 / 合法存档 / WS 连接 / 断言汇总 / 测试数据清理」
 * 收敛到一处，新增测试套件只写用例，不再各抄一份 helper。
 *
 * 约定：
 *  - 所有套件输出逐例 [PASS]/[FAIL]，末尾 `<NAME>_RESULT pass=N fail=N` + `<NAME>_OK`；
 *  - 任一失败 exit 1，可直接接 CI / `npm run verify`；
 *  - 账号统一带 RUN 后缀（6 位），测试结束调用 cleanupAccounts 清理，避免 dev.db 膨胀。
 *
 * 注意：本文件是 **测试专用**，不参与 tsc 编译（package.json 的 check 只查 src）。
 */
import WebSocket from 'ws';
import { readFileSync, existsSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeSaveWriter } from './saveWriter.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
/** backend/ 根目录（tests/lib/ 回退两级）。 */
export const BACKEND_ROOT = resolve(HERE, '../..');

export const BASE = process.env.E2E_BASE || 'http://localhost:3001';
export const WS_HOST = process.env.E2E_WS_HOST || 'ws://localhost:3001';
export const ORIGIN = process.env.E2E_ORIGIN || 'http://localhost:5173';
/** 单次运行的短标识；同一进程内创建的账号都带它，便于精确清理。 */
export const RUN = Date.now().toString(36).slice(-6);

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const asText = (o) => (typeof o === 'string' ? o : JSON.stringify(o));

/**
 * 极简 .env 加载，与 src/lib/env.ts 同口径。
 * Prisma Client 运行时不会自动读 .env，脚本里要连库必须先调它。
 */
export function loadBackendEnv() {
  const envPath = resolve(BACKEND_ROOT, '.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    let val = m[2];
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1);
    }
    if (process.env[m[1]] === undefined) process.env[m[1]] = val;
  }
}

/**
 * 读取服务端内容表（与 `npm run gen:content` 生成物一致）。
 * 测试里取真实技能/幻兽 id，避免硬编码过期或拼错。
 */
export function loadContent() {
  const p = resolve(BACKEND_ROOT, 'src/game/content.generated.ts');
  const raw = readFileSync(p, 'utf8');
  return JSON.parse(raw.slice(raw.indexOf('{')).replace(/;\s*$/, '').trim());
}

// —————————————————————————— 断言与汇总 ——————————————————————————

export class Suite {
  /** @param {string} name 输出前缀，如 E2E_HARDENING */
  constructor(name) {
    this.name = name;
    this.results = [];
    this.startedAt = Date.now();
  }

  check(title, ok, detail = '') {
    const normalized = String(detail ?? '').replace(/\s+/g, ' ').slice(0, 300);
    this.results.push({ title, ok: !!ok, detail: normalized });
    console.log(`${ok ? '[PASS]' : '[FAIL]'} ${title}${ok ? '' : `  « ${normalized}`}`);
    return !!ok;
  }

  /** 记录一条跳过（例如依赖环境不具备），不计入失败。 */
  skip(title, why) {
    this.results.push({ title, ok: true, skipped: true, detail: why });
    console.log(`[SKIP] ${title}  « ${why}`);
  }

  get pass() {
    return this.results.filter((r) => r.ok).length;
  }

  get fail() {
    return this.results.filter((r) => !r.ok).length;
  }

  get skipped() {
    return this.results.filter((r) => r.skipped).length;
  }

  /** 打印汇总并设置退出码；返回是否全绿。 */
  done() {
    const elapsed = ((Date.now() - this.startedAt) / 1000).toFixed(1);
    const ok = this.fail === 0;
    console.log(`\n${this.name}_RESULT pass=${this.pass} fail=${this.fail} skip=${this.skipped} elapsed=${elapsed}s`);
    if (!ok) {
      console.log(`${this.name}_FAILED`);
      for (const r of this.results.filter((x) => !x.ok)) {
        console.log(`  ✗ ${r.title}  « ${r.detail}`);
      }
      process.exitCode = 1;
      return false;
    }
    console.log(`${this.name}_OK`);
    return true;
  }
}

// —————————————————————————— HTTP ——————————————————————————

/**
 * 发请求并解析响应。
 * @param {string} path
 * @param {{method?:string, token?:string, body?:unknown, bodyText?:string, headers?:Record<string,string>, noJson?:boolean}} opts
 */
export async function api(path, opts = {}) {
  const { method = 'GET', token, body, bodyText, headers = {} } = opts;
  const h = { ...headers };
  let payload;
  if (bodyText !== undefined) {
    payload = bodyText;
    if (!h['Content-Type']) h['Content-Type'] = 'application/json';
  } else if (body !== undefined) {
    payload = JSON.stringify(body);
    h['Content-Type'] = 'application/json';
  }
  if (token) h.Authorization = `Bearer ${token}`;

  const res = await fetch(BASE + path, { method, headers: h, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

export const health = () => api('/api/health');

// —————————————————————————— 账号 ——————————————————————————

let accountSeq = 0;

/**
 * 注册一个测试账号。
 * 用户名 3~20 字符（后端 zod 约束），前缀 + RUN + 序号刚好可控。
 * @param {string} prefix
 */
export async function newAccount(prefix = 'e2e') {
  accountSeq += 1;
  const username = `${prefix}_${RUN}_${accountSeq}`.slice(0, 20);
  const password = `pw-${RUN}-${accountSeq}`.slice(0, 40);
  const res = await api('/api/auth/register', { method: 'POST', body: { username, password } });
  if (res.status !== 200 || !res.data?.token) {
    throw new Error(`注册测试账号失败(${res.status}): ${res.text.slice(0, 200)}`);
  }
  return { username, password, token: res.data.token };
}

/** 登录并返回 token（用于验证封号后登录被拒等场景）。 */
export async function login(username, password) {
  return api('/api/auth/login', { method: 'POST', body: { username, password } });
}

/** 直接用 Prisma 改角色，避免每次 fork 一个 npm 进程（管理员只由服务端判定，见 lib/account.ts）。 */
export async function setRole(username, role) {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.user.update({ where: { username }, data: { role } });
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 删除指定用户名的账号及其关联数据。
 * Save / BanRecord 有 onDelete: Cascade；IntentLog 无外键，需手动清。
 */
export async function cleanupAccounts(usernames = []) {
  const names = [...new Set(usernames.filter(Boolean))];
  if (names.length === 0) return { users: 0, intents: 0 };
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { username: { in: names } },
      select: { id: true },
    });
    const ids = users.map((u) => u.id);
    let intents = 0;
    if (ids.length > 0) {
      const r = await prisma.intentLog.deleteMany({ where: { userId: { in: ids } } });
      intents = r.count;
      // P4-2c：Boss 伤害事件没有外键，账号删除不会级联，必须显式清。
      await prisma.bossDamageEvent.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    return { users: ids.length, intents };
  } finally {
    await prisma.$disconnect();
  }
}

/**
 * 用真实 JWT_SECRET 签一个 token，用于「伪造声明 / 已过期」这类白盒对抗。
 * 返回 null 表示读不到密钥（此时调用方应 skip，而不是假装通过）。
 * @param {Record<string, unknown>} payload
 * @param {{expiresInMs?: number}} opts 负值即已过期
 */
export async function forgeToken(payload, { expiresInMs = 3_600_000 } = {}) {
  loadBackendEnv();
  const key = process.env.JWT_SECRET;
  if (!key) return null;
  const { createSigner } = await import('fast-jwt');
  const claims = { ...payload };
  // fast-jwt 的 expiresIn 只接受正值；要造过期 token 就直接写一个过去的 exp（秒）。
  if (expiresInMs <= 0) {
    claims.exp = Math.floor((Date.now() + expiresInMs) / 1000);
    return createSigner({ key, noTimestamp: true })(claims);
  }
  return createSigner({ key, expiresIn: expiresInMs })(claims);
}

/**
 * 按用户名前缀批量清理历史测试账号（供 `npm run clean:e2e` 使用）。
 * 默认覆盖各套件的账号前缀，绝不动 admin 等真实账号。
 * @param {string[]} prefixes
 * @param {{dryRun?: boolean}} opts
 */
export async function cleanupByPrefix(prefixes = ['e2e_', 'ui_', 'harden_', 'hd_', 'edge_', 'bt_', 'p12_', 'ws_', 'b3a_', 'b3b_', 'ss_', 'p41_', 'p42a_', 'p42b_', 'p42c_', 'p42d_', 'p42e_', 'f17_'], opts = {}) {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const users = await prisma.user.findMany({
      where: { OR: prefixes.map((p) => ({ username: { startsWith: p } })) },
      select: { id: true, username: true, role: true },
    });
    // 保险：即使前缀命中，也不删管理员
    const targets = users.filter((u) => u.role !== 'admin');
    if (opts.dryRun) {
      return { users: targets.length, intents: 0, names: targets.map((u) => u.username) };
    }
    const ids = targets.map((u) => u.id);
    let intents = 0;
    if (ids.length > 0) {
      const r = await prisma.intentLog.deleteMany({ where: { userId: { in: ids } } });
      intents = r.count;
      await prisma.bossDamageEvent.deleteMany({ where: { userId: { in: ids } } });
      await prisma.user.deleteMany({ where: { id: { in: ids } } });
    }
    return { users: ids.length, intents, names: targets.map((u) => u.username) };
  } finally {
    await prisma.$disconnect();
  }
}

// —————————————————————————— 存档 ——————————————————————————

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
export const recentIso = () => new Date(Date.now() - 60_000).toISOString();

/** 合法存档基线（version 留旧档号，服务端按 VERSION_OLD 软告警放行）。 */
export function validSave(overrides = {}) {
  return {
    version: '10',
    playerName: '测试员',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [
      {
        id: 'p1', specId: 'sprout_owl', level: 9, exp: 12,
        element: 'grass', maxHp: 72, hp: 72,
        atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90,
        status: 'none', moveIds: ['tackle', 'wood_strike'],
        initStats: STATS, growthRates: GROWTH, isShiny: false,
      },
      {
        id: 'p2', specId: 'spark_mouse', level: 9, exp: 0,
        element: 'electric', maxHp: 66, hp: 66,
        atk: 74, def: 60, spAtk: 70, spDef: 62, spd: 96,
        status: 'none', moveIds: ['tackle'],
        initStats: STATS, growthRates: GROWTH, isShiny: false,
      },
    ],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: {},
    lastSavedAt: recentIso(),
    ...overrides,
  };
}

/**
 * 存档相关接口（F17 单档：一账号一档）。
 * P4：`put` 自动带 revision（CAS），逐 token 跟踪当前版本；
 * 需要构造版本冲突用例时显式传 `{ revision: n }`。
 */
const saveWriter = makeSaveWriter(api);

export const save = {
  put: saveWriter.put,
  get: (token) => api('/api/save', { token }),
  session: (token) => api('/api/session', { token }),
  /** 手工改本地跟踪的版本号（模拟「其它端已经写过」）。 */
  setRevision: saveWriter.set,
  /** 读取当前跟踪的版本号（不请求服务端）。 */
  revisionOf: saveWriter.revOf,
};

// —————————————————————————— 战斗 ——————————————————————————

export const battle = {
  start: (token, body = {}) =>
    api('/api/battle/start', {
      method: 'POST', token,
      body: { theme: 'grass', areaName: '初始草原', areaId: null, levelMin: 2, levelMax: 2, ...body },
    }),
  action: (token, battleId, action) =>
    api('/api/battle/action', { method: 'POST', token, body: { battleId, action } }),
  current: (token) => api('/api/battle/current', { token }),
  abandon: (token, battleId) =>
    api('/api/battle/abandon', { method: 'POST', token, body: { battleId } }),
};

// —————————————————————————— WebSocket ——————————————————————————

/**
 * 建立 WS 连接并等待 hello；被拒时通过 unexpected-response 读回状态码与 JSON body。
 * @param {{token?:string|null, origin?:string|null, path?:string}} opts
 */
export function openWs({ token, origin = ORIGIN, path = '/ws' } = {}) {
  return new Promise((resolvePromise) => {
    const url = new URL(path, WS_HOST);
    if (token !== undefined && token !== null) url.searchParams.set('token', token);
    const headers = {};
    if (origin !== undefined && origin !== null) headers.Origin = origin;
    const ws = new WebSocket(url.toString(), { headers, handshakeTimeout: 5_000 });
    const queue = [];
    const ctx = { ws, queue, ok: false, status: 0, hello: null };
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolvePromise(Object.assign(ctx, extra));
    };
    const timer = setTimeout(() => finish({ ok: false, status: -1, error: 'timeout' }), 6_000);

    ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { m = { raw: d.toString() }; }
      queue.push(m);
      if (m.type === 'hello') finish({ ok: true, status: 101, hello: m });
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { data = body; }
        finish({ ok: false, status: res.statusCode, data, error: `http ${res.statusCode}` });
        try { ws.terminate(); } catch { /* 已断开 */ }
      });
    });
    ws.on('error', (e) => finish({ ok: false, status: 0, error: String(e?.message || e) }));
    // 记录关闭码：连接可能在 waitMsg 消费 error 后就已关闭，此时 waitClose 只能读这里。
    ws.on('close', (code, reason) => {
      ws.closeInfo = { code, reason: String(reason || '') };
      ctx.closeInfo = ws.closeInfo;
    });
  });
}

/** 从队列里取出（并移除）第一条满足条件的消息，超时返回 null。 */
export async function waitMsg(ctx, pred, timeout = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const i = ctx.queue.findIndex(pred);
    if (i >= 0) return ctx.queue.splice(i, 1)[0];
    await sleep(20);
  }
  return null;
}

/** 等待连接关闭并返回 { code, reason }。 */
export function waitClose(ws, timeout = 4_000) {
  return new Promise((resolvePromise) => {
    if (ws.readyState === WebSocket.CLOSED) {
      return resolvePromise(ws.closeInfo ?? { code: 0, reason: 'already-closed' });
    }
    const timer = setTimeout(() => resolvePromise({ code: -1, reason: 'timeout' }), timeout);
    ws.once('close', (code, reason) => {
      clearTimeout(timer);
      resolvePromise({ code, reason: String(reason || '') });
    });
  });
}

export function closeWs(ctx) {
  return new Promise((resolvePromise) => {
    if (!ctx?.ws || ctx.ws.readyState === WebSocket.CLOSED) return resolvePromise();
    ctx.ws.once('close', () => resolvePromise());
    try { ctx.ws.close(); } catch { resolvePromise(); }
    setTimeout(resolvePromise, 1_000);
  });
}

/** 发一条原始文本帧（用于伪造上行、超长帧、限流测试）。 */
export function sendRaw(ctx, text) {
  ctx.ws.send(text);
}

// —————————————————————————— 前置检查 ——————————————————————————

/** 服务不在线时直接给出可执行的提示，而不是一堆 ECONNREFUSED。 */
export async function requireBackend() {
  try {
    const r = await health();
    if (r.status === 200 && r.data?.ok) return r.data;
  } catch { /* 下面统一报错 */ }
  console.error(`[ABORT] 后端未就绪：${BASE}（先 cd backend && npm run dev）`);
  process.exit(1);
}
