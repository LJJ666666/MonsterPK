/**
 * P1-1 / P1-1b 存档校验与风控端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && node tests/e2e_save_validation.mjs
 *
 * 覆盖：
 *  - 结构/格式问题 → 400 且不封号（防误封）
 *  - 合法档 / 旧档 / 空档 → 200 放行
 *  - 改系统时间（未来时间戳）→ 200 且服务端钳制，绝不封号
 *  - 明确改档（满金币/高等级/超队伍）→ 403 封号；
 *    后续请求 403、重新登录 403、库里 bannedAt 与审计记录落地
 *  - 管理员账号：改档特征放行，结构错误仍 400，且自身不会被封
 *  - 解封后可正常登录写档
 *  - 被拒档不落库（GET 回读校验）
 * 输出：逐例 [PASS]/[FAIL]，末尾汇总；任一失败以 exit 1 结束。
 */
import { PrismaClient } from '@prisma/client';

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const BAN_CODE = 'ACCOUNT_BANNED';
const PASSWORD = 'e2e-pass-123';
const RUN = Date.now().toString(36).slice(-6);
const prisma = new PrismaClient();

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const recentIso = () => new Date(Date.now() - 60_000).toISOString();
const FUTURE = '2099-01-01T00:00:00.000Z';

function validSave(overrides = {}) {
  return {
    version: '10',
    playerName: '旅行者',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [{
      id: 'abc123', specId: 'sprout_owl', level: 5, exp: 12,
      element: 'grass', maxHp: 57, hp: 57,
      atk: 63, def: 54, spAtk: 71, spDef: 61, spd: 76,
      status: 'none', moveIds: ['tackle', 'vine_whip'],
      initStats: STATS, growthRates: GROWTH, isShiny: false,
    }],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3, amulet_coin: 0 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    lastSavedAt: recentIso(),
    ...overrides,
  };
}
const asText = (obj) => typeof obj === 'string' ? obj : JSON.stringify(obj);

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const put = (token, data, slot = 1) =>
  request(`/api/save?slot=${slot}`, { method: 'PUT', token, body: { data: asText(data) } });

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
}

/** 每个封号用例必须用独立账号，否则第一个封号会让后续用例全变成守卫拒绝。 */
async function freshUser(tag) {
  const username = `e2e_${RUN}_${tag}`;
  const r = await request('/api/auth/register', {
    method: 'POST', body: { username, password: PASSWORD },
  });
  return { username, token: r.data?.token, status: r.status };
}

const login = (username) =>
  request('/api/auth/login', { method: 'POST', body: { username, password: PASSWORD } });

async function main() {
  // ——————————————— A. 主账号基础能力 ———————————————
  const main = await freshUser('main');
  check('注册主账号', main.status === 200 && !!main.token, JSON.stringify(main));
  if (!main.token) { console.log('E2E_ABORT: 未取到 token'); process.exit(1); }

  const me = await request('/api/auth/me', { token: main.token });
  check('me 返回 isAdmin=false / banned=false',
    me.status === 200 && me.data?.isAdmin === false && me.data?.banned === false,
    JSON.stringify(me.data));

  // ——————————————— B. 结构 / 格式问题：400 且不封号 ———————————————
  const rejectCases = [
    ['非 JSON 文本', 'not-a-json', 'NOT_JSON'],
    ['顶层是数组', '[]', 'NOT_OBJECT'],
    ['缺 version', (() => { const s = validSave(); delete s.version; return s; })(), 'VERSION_MISSING'],
    ['缺 party', (() => { const s = validSave(); delete s.party; return s; })(), 'PARTY_MISSING'],
    ['缺 inventory', (() => { const s = validSave(); delete s.inventory; return s; })(), 'INVENTORY_MISSING'],
    ['版本高于服务端', validSave({ version: '999' }), 'VERSION_TOO_NEW'],
    ['版本非数字（旧档格式）', validSave({ version: 'abc' }), 'VERSION_FORMAT'],
    ['属性枚举伪造', (() => { const s = validSave(); s.party[0].element = 'god'; return s; })(), 'MONSTER_ELEMENT'],
  ];
  for (const [name, data, code] of rejectCases) {
    const r = await put(main.token, data);
    check(`拒绝不封号 / ${name} → 400 ${code}`,
      r.status === 400 && r.data?.code === code, JSON.stringify(r.data));
  }
  const afterRejects = await request('/api/auth/me', { token: main.token });
  check('结构/格式问题后账号仍可访问（未封号）', afterRejects.status === 200, JSON.stringify(afterRejects.data));

  // ——————————————— C. 合法档放行 ———————————————
  const okCases = [
    ['标准合法档', validSave()],
    ['旧版存档 v9', validSave({ version: '9' })],
    ['空队伍新档', validSave({ party: [], inventory: {}, collection: {}, money: 0, steps: 0 })],
    ['旧档缺 initStats', (() => { const s = validSave(); delete s.party[0].initStats; return s; })()],
  ];
  // P1-2 契约升级：整包 PUT 不再允许客户端随意覆盖资源（会被权威摘要拒绝）。
  // 这些用例验证的是校验器对「合法结构」的放行能力，因此每例用独立账号以首次写档
  // 建立基线；改资源本身属于 P1-2 的拦截目标，由 e2e_p12.mjs 专门覆盖。
  for (let i = 0; i < okCases.length; i++) {
    const [name, data] = okCases[i];
    const u = await freshUser(`ok${i}`);
    const r = await put(u.token, data);
    check(`合法放行 / ${name} → 200`, r.status === 200 && r.data?.ok === true, JSON.stringify(r.data));
  }

  // ——————————————— D. 安全边界 ———————————————
  const noToken = await request('/api/save?slot=1', { method: 'PUT', body: { data: asText(validSave()) } });
  check('无 token → 401', noToken.status === 401, JSON.stringify(noToken.data));
  const badSlot = await put(main.token, validSave(), 9);
  check('非法 slot=9 → 400', badSlot.status === 400, JSON.stringify(badSlot.data));
  const emptyBody = await request('/api/save?slot=1', { method: 'PUT', token: main.token, body: { data: '' } });
  check('空存档文本 → 400', emptyBody.status === 400, JSON.stringify(emptyBody.data));

  // ——————————————— E. 改系统时间：不封号、不生效 ———————————————
  const futureUser = await freshUser('ft');
  const futureSave = await put(futureUser.token, validSave({ lastSavedAt: FUTURE }));
  check('lastSavedAt 填 2099 → 200 且不封号', futureSave.status === 200, JSON.stringify(futureSave.data));
  const gotFuture = await request('/api/save?slot=1', { token: futureUser.token });
  const storedFuture = typeof gotFuture.data?.data === 'string' ? JSON.parse(gotFuture.data.data) : null;
  const clampedT = Date.parse(storedFuture?.lastSavedAt ?? '');
  check('未来时间戳被服务端钳制为当前时间',
    Number.isFinite(clampedT) && clampedT < Date.parse('2030-01-01T00:00:00.000Z') && clampedT <= Date.now() + 60_000,
    JSON.stringify({ lastSavedAt: storedFuture?.lastSavedAt }));

  const idleTimeUser = await freshUser('it');
  const idleFuture = await put(idleTimeUser.token, validSave({
    idle: { areaId: 'a', areaName: 'A', level: 10, startedAt: FUTURE },
  }));
  check('idle.startedAt 填 2099 → 200 且不封号', idleFuture.status === 200, JSON.stringify(idleFuture.data));
  const gotIdle = await request('/api/save?slot=1', { token: idleTimeUser.token });
  const storedIdle = typeof gotIdle.data?.data === 'string' ? JSON.parse(gotIdle.data.data) : null;
  check('挂机开始时间被钳制，改时间拿不到额外收益',
    Date.parse(storedIdle?.idle?.startedAt ?? '') <= Date.now() + 60_000,
    JSON.stringify({ startedAt: storedIdle?.idle?.startedAt }));

  // ——————————————— F. 被拒档不落库 ———————————————
  const markerUser = await freshUser('marker');
  const marker = validSave({ money: 4321, playerName: 'E2E_MARKER' });
  await put(markerUser.token, marker); // 首次写档建立基线
  await put(markerUser.token, validSave({ version: '999' }));
  const got = await request('/api/save?slot=1', { token: markerUser.token });
  const stored = typeof got.data?.data === 'string' ? JSON.parse(got.data.data) : null;
  check('被拒档不落库（GET 回读仍为 4321）',
    got.status === 200 && stored?.money === 4321 && stored?.playerName === 'E2E_MARKER',
    JSON.stringify({ status: got.status, money: stored?.money, name: stored?.playerName }));
  check('GET 返回 schemaVersion 元数据', !!got.data?.schemaVersion, JSON.stringify(got.data));

  // ——————————————— G. 明确改档 → 403 封号（每例独立账号）———————————————
  // 只收「合法但正常玩不到」与「容量越界」两类。格式错误见 G2，两者性质不同：
  // 前者正常游戏逻辑不可能产生，后者脏档 / 旧版迁移 / 客户端算术 bug 都会产生。
  const cheatCases = [
    ['满金币（测试菜单级）', validSave({ money: 1_500_000 })],
    ['高等级 Lv120', (() => { const s = validSave(); s.party[0].level = 120; return s; })()],
    ['队伍 7 只', (() => { const s = validSave(); s.party = Array(7).fill(s.party[0]); return s; })()],
  ];
  let firstBanned = null;
  for (const [name, data] of cheatCases) {
    const tag = `b${cheatCases.findIndex((x) => x[0] === name)}`;
    const u = await freshUser(tag);
    const r = await put(u.token, data);
    check(`改档封号 / ${name} → 403 ${BAN_CODE}`,
      r.status === 403 && r.data?.code === BAN_CODE && !!r.data?.reason, JSON.stringify(r.data));

    const after = await request('/api/save?slot=1', { token: u.token });
    check(`改档封号 / ${name} 后续请求被守卫拒绝 → 403`,
      after.status === 403 && after.data?.code === BAN_CODE, JSON.stringify(after.data));

    const relog = await login(u.username);
    check(`改档封号 / ${name} 重新登录被拒 → 403`, relog.status === 403, JSON.stringify(relog.data));

    const db = await prisma.user.findUnique({ where: { username: u.username } });
    check(`改档封号 / ${name} 库里 bannedAt 已写`, !!db?.bannedAt, JSON.stringify(db));
    const audit = db ? await prisma.banRecord.count({ where: { userId: db.id } }) : 0;
    check(`改档封号 / ${name} 封号审计记录已写`, audit === 1, `count=${audit}`);
    if (!firstBanned) firstBanned = { username: u.username, id: db?.id };
  }

  // ——————————————— G2. 格式错误 → 400 拒绝，不封号 ———————————————
  // 契约（2026-11-07 起）：<FIELD>_FORMAT 只拒绝；<FIELD>_RANGE 与容量类才封号。
  // 把「负金钱 / 小数 / hp>maxHp」这类格式脏档当作弊封号，会误封正常玩家。
  const formatCases = [
    ['负金钱', validSave({ money: -1 }), 'MONEY_FORMAT'],
    ['小数金钱', validSave({ money: 1.5 }), 'MONEY_FORMAT'],
    ['hp 超过 maxHp', (() => { const s = validSave(); s.party[0].hp = 99999; return s; })(), 'MONSTER_HP_EXCEED'],
  ];
  for (const [name, data, expectCode] of formatCases) {
    const u = await freshUser(`f${formatCases.findIndex((x) => x[0] === name)}`);
    const r = await put(u.token, data);
    check(`格式错误 / ${name} → 400 ${expectCode}（不封号）`,
      r.status === 400 && r.data?.code === expectCode, JSON.stringify(r.data));

    const db = await prisma.user.findUnique({ where: { username: u.username } });
    check(`格式错误 / ${name} 库里未写 bannedAt`, !db?.bannedAt, JSON.stringify(db?.bannedAt));
    const audit = db ? await prisma.banRecord.count({ where: { userId: db.id } }) : 0;
    check(`格式错误 / ${name} 未产生封号审计`, audit === 0, `count=${audit}`);

    const ok = await put(u.token, validSave({ playerName: '正常存档' }));
    check(`格式错误 / ${name} 之后仍可正常写档`, ok.status === 200, JSON.stringify(ok.data));

    const relog = await login(u.username);
    check(`格式错误 / ${name} 仍可正常登录`, relog.status === 200, JSON.stringify(relog.data));
  }

  // ——————————————— H. 管理员：改档放行、结构仍拒绝 ———————————————
  const adm = await freshUser('adm');
  await prisma.user.update({ where: { username: adm.username }, data: { role: 'admin' } });
  const admMe = await request('/api/auth/me', { token: adm.token });
  check('me 对管理员返回 isAdmin=true', admMe.data?.isAdmin === true, JSON.stringify(admMe.data));

  const admMoney = await put(adm.token, validSave({ money: 1_500_000 }));
  check('管理员满金币 → 200 放行', admMoney.status === 200, JSON.stringify(admMoney.data));
  const admNegative = await put(adm.token, validSave({ money: -1 }));
  // 格式脏档任何账号都不入库：管理员放行的是「数值偏高」，不是「结构损坏」。
  check('管理员负金钱 → 400（格式脏档不入库）',
    admNegative.status === 400 && admNegative.data?.code === 'MONEY_FORMAT', JSON.stringify(admNegative.data));
  const admBadJson = await put(adm.token, 'not-a-json');
  check('管理员非 JSON → 400（结构损坏仍拒绝）', admBadJson.status === 400, JSON.stringify(admBadJson.data));
  const admDb = await prisma.user.findUnique({ where: { username: adm.username } });
  check('管理员账号未被封号', !admDb?.bannedAt, JSON.stringify(admDb));
  // 用完即撤销：E2E 密码写在脚本里，若留下 role=admin 的账号等于留一个公开后门。
  await prisma.user.update({ where: { username: adm.username }, data: { role: 'player' } });
  check('E2E 临时管理员权限已撤销（不留后门）',
    (await prisma.user.findUnique({ where: { username: adm.username } }))?.role === 'player');

  // ——————————————— I. 解封后可恢复 ———————————————
  if (firstBanned?.username) {
    await prisma.user.update({
      where: { username: firstBanned.username },
      data: { bannedAt: null, banReason: null },
    });
    const relog = await login(firstBanned.username);
    check('解封后重新登录 → 200', relog.status === 200 && !!relog.data?.token, JSON.stringify(relog.data));
    if (relog.data?.token) {
      const afterUnban = await put(relog.data.token, validSave());
      check('解封后正常写档 → 200', afterUnban.status === 200, JSON.stringify(afterUnban.data));
    }
  }

  console.log(`\nE2E_RESULT pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('E2E_OK');
}

main()
  .catch((e) => { console.error('E2E_EXCEPTION', e); process.exitCode = 1; })
  .finally(async () => { await prisma.$disconnect(); });
