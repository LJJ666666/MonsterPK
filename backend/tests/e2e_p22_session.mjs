/**
 * P2-2 GameSession 在线权威态端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p22
 *
 * 覆盖：
 *  - 连接建立时 hydrate：hello 能力声明 + 主动下发 session.state 全量快照
 *  - 服务端写入（PUT / 意图裁决）统一经会话态：revision 单调递增并广播给同账号所有连接
 *  - P4-1a 顶号：单账号单连接、旧连接收到 bye；GET /api/save 以内存权威态为准
 *  - 上行不能写状态：伪造 session.state 被 UNKNOWN_TYPE 拒绝并关闭，DB/会话态不变
 *  - session.resync 只请求重推；断线后会话按 TTL 保留、重连拿到最新快照
 *  - 在线状态查询 /api/session 与 health.sessions；REST 回归
 * 输出：逐例 [PASS]/[FAIL]，末尾 E2E_P22_OK；任一失败 exit 1。
 */
import WebSocket from 'ws';
import { makeSaveWriter } from './lib/saveWriter.mjs';

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const WS_HOST = process.env.E2E_WS_HOST || 'ws://localhost:3001';
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'e2e-pass-123';
const RUN = Date.now().toString(36).slice(-6);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const recentIso = () => new Date(Date.now() - 60_000).toISOString();
const clone = (o) => JSON.parse(JSON.stringify(o));
const asText = (o) => typeof o === 'string' ? o : JSON.stringify(o);

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
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: { area_a: { name: '初始草原', level: 12, theme: 'grass', clearedAt: recentIso() } },
    lastSavedAt: recentIso(),
    ...overrides,
  };
}

// P4：整包 PUT 必须带 revision（CAS）。saveWriter 逐 token 跟踪当前版本，
// 需要构造版本冲突时显式传 { revision: n }。
const saveWriter = makeSaveWriter(request);
const put = saveWriter.put;
const get = (token) => request('/api/save?slot=1', { token });
const session = (token, slot = 1) => request(`/api/session?slot=${slot}`, { token });
const health = () => request('/api/health');
const me = (token) => request('/api/auth/me', { token });
// P4：意图也要带 revision（CAS）。裁决成功后服务端返回新版本号，这里立刻同步，
// 否则紧接着的 commitIntent（PUT 带 intentNonce）会拿旧版本撞 409。
const intent = async (token, type, payload, save, nonce) => {
  const revision = await saveWriter.revOf(token, 1);
  const res = await request(`/api/actions/${type}`, {
    method: 'POST', token,
    body: { slot: 1, nonce, save: asText(save), payload, revision },
  });
  if (res.status === 200 && typeof res.data?.revision === 'number') {
    saveWriter.set(token, 1, res.data.revision);
  }
  return res;
};
const newNonce = () => `n_${RUN}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

/** 建立一条 WS 连接，所有下行消息进队列，供 waitMsg 按条件取用。 */
function openWs(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', WS_HOST);
    url.searchParams.set('token', token);
    const ws = new WebSocket(url.toString(), { headers: { Origin: ORIGIN }, handshakeTimeout: 5_000 });
    const ctx = { ws, queue: [], closeCode: null };
    ws.on('message', (d) => {
      try { ctx.queue.push(JSON.parse(d.toString())); }
      catch { ctx.queue.push({ raw: d.toString() }); }
    });
    ws.on('close', (code) => { ctx.closeCode = code; });
    ws.on('open', () => resolve(ctx));
    ws.on('error', (e) => reject(e));
  });
}

/** 从队列里取走第一条满足条件的消息（消费掉，避免重复匹配）。 */
async function waitMsg(ctx, pred, timeout = 3_000) {
  const start = Date.now();
  while (Date.now() - start < timeout) {
    const i = ctx.queue.findIndex(pred);
    if (i >= 0) return ctx.queue.splice(i, 1)[0];
    await sleep(20);
  }
  return null;
}
const isHello = (m) => m?.type === 'hello';
const isState = (m) => m?.type === 'session.state' && m.slot === 1;
const stateAfter = (rev) => (m) => isState(m) && m.revision > rev;

function closeWs(ctx) {
  return new Promise((resolve) => {
    if (ctx.ws.readyState === WebSocket.CLOSED) return resolve();
    ctx.ws.once('close', () => resolve());
    try { ctx.ws.close(); } catch { resolve(); }
  });
}

async function main() {
  // ——— A. health / 注册 / 建立初始权威态 ———
  const h = await health();
  check('health 带 sessions 在线权威态统计',
    h.status === 200 && h.data?.sessions && typeof h.data.sessions.slots === 'number',
    JSON.stringify(h.data?.sessions));

  const username = `ss_${RUN}_main`;
  const reg = await request('/api/auth/register', {
    method: 'POST', body: { username, password: PASSWORD },
  });
  const token = reg.data?.token;
  check('注册主账号', reg.status === 200 && !!token, JSON.stringify(reg.data));

  const base = validSave();
  const first = await put(token, base);
  const rev1 = first.data?.revision;
  check('PUT 初始档 → 200 且返回权威态 revision',
    first.status === 200 && typeof rev1 === 'number', JSON.stringify(first.data));

  // ——— B. 连接 hydrate：hello + 主动快照 ———
  const a = await openWs(token);
  const helloA = await waitMsg(a, isHello);
  check('WS A 握手 hello（protocol=1 + capabilities 含 session.state）',
    helloA?.protocol === 1 && Array.isArray(helloA?.capabilities)
      && helloA.capabilities.includes('session.state'), JSON.stringify(helloA?.capabilities));

  const snapA = await waitMsg(a, isState);
  check('连接 A 收到 session.state 权威快照',
    !!snapA && snapA.revision === rev1 && snapA.source === 'hydrate',
    JSON.stringify(snapA && { revision: snapA.revision, source: snapA.source }));
  check('快照含完整存档、slot 与在线连接数',
    !!snapA && JSON.parse(snapA.data).money === 1200 && snapA.slot === 1 && snapA.online >= 1,
    JSON.stringify(snapA && { slot: snapA.slot, online: snapA.online }));

  const s1 = await session(token);
  check('/api/session：会话在线且 revision 与快照一致',
    s1.status === 200 && s1.data?.online === true && s1.data?.revision === rev1
      && s1.data?.connections >= 1, JSON.stringify(s1.data));

  // P4-1a 顶号：同账号只允许一条在线连接。第 2 条握手成功，第 1 条被即时踢下线。
  const b = await openWs(token);
  await waitMsg(b, isHello);
  const snapB = await waitMsg(b, isState);
  check('顶号后新连接同样 hydrate 到最新权威快照',
    !!snapB && snapB.revision === rev1 && snapB.data === snapA?.data,
    JSON.stringify(snapB && { revision: snapB.revision }));
  const byeA = await waitMsg(a, (m) => m?.type === 'bye', 2_000);
  check('旧连接收到 bye SESSION_REPLACED',
    byeA?.code === 'SESSION_REPLACED', JSON.stringify(byeA));
  const s2 = await session(token);
  check('/api/session：顶号后只登记 1 条连接',
    s2.status === 200 && s2.data?.connections === 1, JSON.stringify(s2.data?.connections));

  // ——— C. 服务端写入 → revision 递增 → 广播给所有连接 ———
  const spent = clone(base);
  spent.money = 1100;
  spent.lastSavedAt = recentIso();
  const second = await put(token, spent);
  const rev2 = second.data?.revision;
  check('PUT 合法消耗 → 200 且 revision 严格递增',
    second.status === 200 && rev2 > rev1, `rev1=${rev1} rev2=${rev2}`);

  const pushA = await waitMsg(b, stateAfter(rev1));
  check('唯一活跃连接收到变更广播（revision / source / data 正确）',
    !!pushA && pushA.revision === rev2 && pushA.source === 'put'
      && JSON.parse(pushA.data).money === 1100,
    JSON.stringify(pushA && { revision: pushA.revision, source: pushA.source }));
  const stalePushes = a.queue.filter((m) => isState(m) && m.revision > rev1);
  check('被顶号下线的旧连接不再收到任何状态广播',
    stalePushes.length === 0, JSON.stringify(stalePushes.map((m) => m.revision)));

  const g2 = await get(token);
  check('GET /api/save 以在线权威态为准（revision / data 与广播一致）',
    g2.status === 200 && g2.data?.revision === rev2 && JSON.parse(g2.data.data).money === 1100,
    JSON.stringify(g2.data && { revision: g2.data.revision }));

  // ——— D. 上行协议：只请求重推，不能写状态 ———
  b.ws.send(JSON.stringify({ type: 'session.resync' }));
  const resync = await waitMsg(b, isState);
  check('session.resync → 服务端重推当前快照（不回 pong）',
    !!resync && resync.revision === rev2 && !b.queue.some((m) => m.type === 'pong'),
    JSON.stringify(resync && { revision: resync.revision }));

  b.ws.send(JSON.stringify({
    type: 'session.state', slot: 1, revision: 999,
    data: JSON.stringify(Object.assign(clone(spent), { money: 9_999_999 })),
  }));
  const err = await waitMsg(b, (m) => m?.type === 'error', 2_000);
  await sleep(150);
  check('伪造 session.state 上行 → error UNKNOWN_TYPE 并关闭连接',
    err?.code === 'UNKNOWN_TYPE' && b.closeCode === 1008,
    JSON.stringify({ code: err?.code, closeCode: b.closeCode }));
  // 伪造上行会让这条连接被关掉，E/F 段重新建一条活跃连接。
  const c = await openWs(token);
  await waitMsg(c, isHello);
  await waitMsg(c, isState);
  const gAfterForge = await get(token);
  check('伪造上行未写入服务端状态（revision / 金币不变）',
    gAfterForge.data?.revision === rev2 && JSON.parse(gAfterForge.data.data).money === 1100,
    JSON.stringify(gAfterForge.data && { revision: gAfterForge.data.revision }));

  // ——— E. 意图裁决也走会话态：登记 pending 与提交结果各广播一次 ———
  const nonce = newNonce();
  const buy = await intent(token, 'shop_buy', { itemId: 'capsule_prism', amount: 1 }, spent, nonce);
  check('shop_buy 意图裁决 200（服务端价格表）',
    buy.status === 200 && buy.data?.ok === true, JSON.stringify(buy.data));
  const pushIntentA = await waitMsg(c, stateAfter(rev2));
  const rev3 = pushIntentA?.revision;
  check('意图登记广播 source=intent 且 revision 递增',
    !!pushIntentA && pushIntentA.source === 'intent' && rev3 > rev2,
    JSON.stringify(pushIntentA && { source: pushIntentA.source, revision: pushIntentA.revision }));

  const bought = clone(spent);
  bought.money = 500;
  bought.inventory.capsule_prism = 1;
  bought.lastSavedAt = recentIso();
  const committed = await put(token, bought, { intentNonce: nonce });
  const rev4 = committed.data?.revision;
  check('带 intentNonce 提交结算 → 200 且 revision 再递增',
    committed.status === 200 && rev4 > rev3, `rev3=${rev3} rev4=${rev4}`);
  const pushCommitB = await waitMsg(c, stateAfter(rev3));
  check('提交结果广播给活跃连接（data 与服务端权威态一致）',
    !!pushCommitB && pushCommitB.revision === rev4 && JSON.parse(pushCommitB.data).money === 500,
    JSON.stringify(pushCommitB && { revision: pushCommitB.revision }));

  // ——— F. 断线 / 重连 / 会话保留 ———
  await closeWs(c);
  await closeWs(b);
  await sleep(150);
  const sAfterClose = await session(token);
  check('断线后在线连接数下降',
    sAfterClose.status === 200 && sAfterClose.data?.connections < s2.data?.connections,
    JSON.stringify(sAfterClose.data?.connections));
  await sleep(150);
  const sOffline = await session(token);
  check('最后一条连接断开后会话按 TTL 保留（online=false 但 revision 仍在）',
    sOffline.status === 200 && sOffline.data?.online === false
      && sOffline.data?.revision === rev4, JSON.stringify(sOffline.data));

  const re = await openWs(token);
  await waitMsg(re, isHello);
  const snapRe = await waitMsg(re, isState);
  check('重连拿到最新权威快照（DB 持久化 + hydrate）',
    !!snapRe && snapRe.revision === rev4 && JSON.parse(snapRe.data).money === 500,
    JSON.stringify(snapRe && { revision: snapRe.revision }));
  await closeWs(re);

  // ——— G. REST 回归 ———
  const h2 = await health();
  const m2 = await me(token);
  const g3 = await get(token);
  check('REST 回归：health / me / GET save 均 200 且状态未被破坏',
    h2.status === 200 && m2.status === 200 && g3.status === 200
      && g3.data?.revision === rev4, JSON.stringify({ h: h2.status, m: m2.status, g: g3.status }));

  console.log(`E2E_P22_RESULT pass=${pass} fail=${fail}`);
  if (fail > 0) {
    console.log('E2E_P22_FAILED');
    process.exit(1);
  }
  console.log('E2E_P22_OK');
}

main().catch((e) => {
  console.error(e);
  console.log('E2E_P22_FAILED');
  process.exit(1);
});
