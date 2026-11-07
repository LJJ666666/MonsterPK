/**
 * P2-1 WebSocket 接入与鉴权端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p21
 *
 * 覆盖：
 *  - 有效 token 握手 → hello（协议版本 / connectionId / userId / 心跳周期 / 服务端时间）
 *  - ping → pong 回显；连接登记与注销体现在 /api/health 的 ws 统计
 *  - 无 token / 篡改 token / 非法 Origin / 错误路径 → 明确拒绝
 *  - 封号账号 → 403 ACCOUNT_BANNED（与 REST 守卫同一口径）
 *  - P4-1a 顶号：单账号单连接、bye SESSION_REPLACED、旧 token REST/WS 双失效、跨账号隔离
 *  - 坏 JSON / 未知类型 / 数组 / 速率限制 / 超长消息
 *  - 断线重连拿到新的 connectionId；原有 REST 接口不回归
 * 输出：逐例 [PASS]/[FAIL]，末尾汇总；任一失败以 exit 1 结束。
 */
import WebSocket from 'ws';
import { PrismaClient } from '@prisma/client';

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const WS_HOST = process.env.E2E_WS_HOST || 'ws://localhost:3001';
const ORIGIN = 'http://localhost:5173';
const PASSWORD = 'e2e-pass-123';
const BAN_CODE = 'ACCOUNT_BANNED';
const RUN = Date.now().toString(36).slice(-6);
const prisma = new PrismaClient();

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
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

/** tag 必须 ≤8 字符，否则用户名会超过注册接口的 20 字符上限（见 bug_log §16）。 */
async function freshUser(tag) {
  const username = `ws_${RUN}_${tag}`;
  const r = await request('/api/auth/register', {
    method: 'POST', body: { username, password: PASSWORD },
  });
  return { username, token: r.data?.token, status: r.status };
}

/**
 * 建立一条 WS 连接并等待 hello。
 * 握手被拒时通过 unexpected-response 读回服务端手写的 HTTP 状态码与 JSON body。
 */
function openWs({ token, origin = ORIGIN, path = '/ws' } = {}) {
  return new Promise((resolve) => {
    const url = new URL(path, WS_HOST);
    if (token !== undefined && token !== null) url.searchParams.set('token', token);
    const headers = {};
    if (origin !== undefined && origin !== null) headers.Origin = origin;
    const ws = new WebSocket(url.toString(), { headers, handshakeTimeout: 5_000 });
    const messages = [];
    let done = false;
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve({ ws, messages, ...r });
    };
    const timer = setTimeout(() => finish({ ok: false, status: -1, error: 'timeout' }), 6_000);

    ws.on('message', (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { m = { raw: d.toString() }; }
      messages.push(m);
      if (m.type === 'hello') finish({ ok: true, hello: m, status: 101 });
    });
    ws.on('unexpected-response', (_req, res) => {
      let body = '';
      res.on('data', (c) => { body += c.toString(); });
      res.on('end', () => {
        let data;
        try { data = JSON.parse(body); } catch { data = body; }
        finish({ ok: false, status: res.statusCode, data });
        try { ws.terminate(); } catch {}
      });
    });
    ws.on('error', (e) => {
      finish({ ok: false, status: 0, error: String(e?.message || e) });
    });
  });
}

function nextMsg(ws, timeout = 3_000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      ws.off('message', onMsg);
      reject(new Error('消息超时'));
    }, timeout);
    function onMsg(d) {
      clearTimeout(timer);
      ws.off('message', onMsg);
      let m;
      try { m = JSON.parse(d.toString()); } catch { m = { raw: d.toString() }; }
      resolve(m);
    }
    ws.on('message', onMsg);
  });
}

function waitClose(ws, timeout = 3_000) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(-1), timeout);
    ws.once('close', (code) => { clearTimeout(timer); resolve(code); });
  });
}

function closeWs(ws) {
  return new Promise((resolve) => {
    if (!ws || ws.readyState === WebSocket.CLOSED) return resolve();
    const timer = setTimeout(resolve, 1_500);
    ws.once('close', () => { clearTimeout(timer); resolve(); });
    try { ws.close(); } catch { clearTimeout(timer); resolve(); }
  });
}

async function main() {
  // ——————————————— A. 握手与控制协议 ———————————————
  const h0 = await request('/api/health');
  check('health 返回 ws 在线统计字段',
    h0.status === 200 && typeof h0.data?.ws?.connections === 'number', JSON.stringify(h0.data));

  const u = await freshUser('main');
  check('注册主账号', u.status === 200 && !!u.token, JSON.stringify(u));
  if (!u.token) { console.log('E2E_P21_ABORT: 未取到 token'); process.exit(1); }
  const me = await request('/api/auth/me', { token: u.token });
  const userId = me.data?.id;

  const c = await openWs({ token: u.token });
  check('有效 token → 握手成功并收到 hello',
    c.ok === true && c.hello?.type === 'hello', JSON.stringify({ status: c.status, error: c.error, data: c.data }));
  check('hello.protocol = 1', c.hello?.protocol === 1, JSON.stringify(c.hello));
  check('hello.connectionId 非空', typeof c.hello?.connectionId === 'string' && c.hello.connectionId.length > 0);
  check('hello.userId 与账号一致', c.hello?.userId === userId, JSON.stringify({ got: c.hello?.userId, want: userId }));
  check('hello.heartbeatMs 在 5s~120s 合法区间',
    c.hello?.heartbeatMs >= 5_000 && c.hello?.heartbeatMs <= 120_000, String(c.hello?.heartbeatMs));
  check('hello.serverTime 接近当前时间',
    typeof c.hello?.serverTime === 'number' && Math.abs(Date.now() - c.hello.serverTime) < 10_000,
    String(c.hello?.serverTime));

  const h1 = await request('/api/health');
  check('连接建立后 health.connections ≥ 1', h1.data?.ws?.connections >= 1, JSON.stringify(h1.data));

  const pongP = nextMsg(c.ws);
  c.ws.send(JSON.stringify({ type: 'ping', ts: 123_456 }));
  const pong = await pongP.catch(() => null);
  check('ping → pong 且原样回显 ts',
    pong?.type === 'pong' && pong.echo === 123_456 && typeof pong.serverTime === 'number', JSON.stringify(pong));

  const pong2P = nextMsg(c.ws);
  c.ws.send(JSON.stringify({ type: 'ping' }));
  const pong2 = await pong2P.catch(() => null);
  check('无 ts 的 ping → pong 不带 echo',
    pong2?.type === 'pong' && !('echo' in pong2), JSON.stringify(pong2));

  await closeWs(c.ws);
  await sleep(250);
  const h2 = await request('/api/health');
  check('连接关闭后在线数回落（登记表已注销）',
    h2.data?.ws?.connections <= h1.data.ws.connections - 1, JSON.stringify(h2.data));

  // ——————————————— B. 未授权 / 来源 / 封号拒绝 ———————————————
  const noToken = await openWs({});
  check('无 token → 401 UNAUTHORIZED',
    noToken.status === 401 && noToken.data?.code === 'UNAUTHORIZED', JSON.stringify({ status: noToken.status, data: noToken.data, error: noToken.error }));

  const badToken = await openWs({ token: u.token + 'tampered' });
  check('篡改 token → 401 UNAUTHORIZED',
    badToken.status === 401 && badToken.data?.code === 'UNAUTHORIZED', JSON.stringify({ status: badToken.status, data: badToken.data }));

  const emptyToken = await openWs({ token: '' });
  check('空 token → 401 UNAUTHORIZED', emptyToken.status === 401, JSON.stringify({ status: emptyToken.status }));

  const badOrigin = await openWs({ token: u.token, origin: 'https://evil.example.com' });
  check('非法 Origin → 403 ORIGIN_DENIED',
    badOrigin.status === 403 && badOrigin.data?.code === 'ORIGIN_DENIED', JSON.stringify({ status: badOrigin.status, data: badOrigin.data }));

  const noOrigin = await openWs({ token: u.token, origin: null });
  check('无 Origin（非浏览器客户端）放行', noOrigin.ok === true, JSON.stringify({ status: noOrigin.status, error: noOrigin.error }));
  await closeWs(noOrigin.ws);

  const wrongPath = await openWs({ token: u.token, path: '/api/ws' });
  check('非 /ws 路径的 upgrade 被拒绝', wrongPath.ok === false, JSON.stringify({ status: wrongPath.status, error: wrongPath.error }));

  const bannedUser = await freshUser('ban');
  await prisma.user.update({
    where: { username: bannedUser.username },
    data: { bannedAt: new Date(), banReason: 'E2E 封号测试' },
  });
  const bannedWs = await openWs({ token: bannedUser.token });
  check('封号账号 → 403 ACCOUNT_BANNED',
    bannedWs.status === 403 && bannedWs.data?.code === BAN_CODE, JSON.stringify({ status: bannedWs.status, data: bannedWs.data }));
  const bannedRest = await request('/api/auth/me', { token: bannedUser.token });
  check('封号账号 REST 同样 403（WS 与 HTTP 口径一致）', bannedRest.status === 403, JSON.stringify(bannedRest));
  await prisma.user.update({
    where: { username: bannedUser.username },
    data: { bannedAt: null, banReason: null },
  });

  // ——————————————— C. P4-1a 顶号：同账号只允许一条在线连接 ———————————————
  const multi = await freshUser('multi');
  const firstConn = await openWs({ token: multi.token });
  check('同一账号第 1 条连接成功', firstConn.ok === true, JSON.stringify({ status: firstConn.status }));
  const hBefore = await request('/api/health');
  const before = hBefore.data?.ws?.connections ?? 0;

  const takeover = await openWs({ token: multi.token });
  check('第 2 条连接成功（后来者赢，不再 429 拒绝）', takeover.ok === true,
    JSON.stringify({ status: takeover.status, data: takeover.data }));
  await sleep(250);
  const bye = firstConn.messages.find((m) => m.type === 'bye');
  check('旧连接收到 bye SESSION_REPLACED', bye?.code === 'SESSION_REPLACED', JSON.stringify(bye));
  check('旧连接已被服务端关闭', firstConn.ws.readyState === 3, `readyState=${firstConn.ws.readyState}`);
  const hAfter = await request('/api/health');
  check('顶号后连接总数不增长（旧连接已注销）', hAfter.data?.ws?.connections === before,
    JSON.stringify({ before, after: hAfter.data?.ws?.connections }));

  const other = await freshUser('other');
  const otherConn = await openWs({ token: other.token });
  check('其它账号不受顶号影响', otherConn.ok === true, JSON.stringify({ status: otherConn.status }));
  await closeWs(otherConn.ws);

  // 重新登录 → 会话代次递增：旧 token 的 REST 与 WS 双双失效，防「刷新页面又把新设备顶掉」
  const relogin = await request('/api/auth/login', {
    method: 'POST', body: { username: multi.username, password: PASSWORD },
  });
  const newToken = relogin.data?.token;
  check('重新登录成功且签发新 token', relogin.status === 200 && !!newToken && newToken !== multi.token,
    JSON.stringify({ status: relogin.status }));
  const oldMe = await request('/api/auth/me', { token: multi.token });
  check('旧 token REST → 403 SESSION_REPLACED',
    oldMe.status === 403 && oldMe.data?.code === 'SESSION_REPLACED', JSON.stringify(oldMe));
  const newMe = await request('/api/auth/me', { token: newToken });
  check('新 token REST 正常', newMe.status === 200, JSON.stringify(newMe));
  const oldWsAgain = await openWs({ token: multi.token });
  check('旧 token 无法再建 WS → 403 SESSION_REPLACED',
    oldWsAgain.status === 403 && oldWsAgain.data?.code === 'SESSION_REPLACED',
    JSON.stringify({ status: oldWsAgain.status, data: oldWsAgain.data }));
  await sleep(200);
  check('重新登录即时踢掉旧 WS 连接',
    takeover.messages.some((m) => m.type === 'bye' && m.code === 'SESSION_REPLACED'),
    JSON.stringify(takeover.messages.slice(-3)));

  await closeWs(takeover.ws);
  await closeWs(firstConn.ws);
  await sleep(250);
  const retryConn = await openWs({ token: newToken });
  check('新 token 可正常建连（登记表已清理）', retryConn.ok === true,
    JSON.stringify({ status: retryConn.status, data: retryConn.data }));
  await closeWs(retryConn.ws);
  await sleep(250);

  // ——————————————— D. 消息协议边界 ———————————————
  const proto = await freshUser('proto');

  const badJson = await openWs({ token: proto.token });
  const badJsonP = nextMsg(badJson.ws);
  badJson.ws.send('not json');
  const badJsonMsg = await badJsonP.catch(() => null);
  check('坏 JSON → error BAD_JSON',
    badJsonMsg?.type === 'error' && badJsonMsg.code === 'BAD_JSON', JSON.stringify(badJsonMsg));
  await closeWs(badJson.ws);

  const unknown = await openWs({ token: proto.token });
  const unknownP = nextMsg(unknown.ws);
  unknown.ws.send(JSON.stringify({ type: 'set_money', money: 999_999 }));
  const unknownMsg = await unknownP.catch(() => null);
  check('未知消息类型 → error UNKNOWN_TYPE',
    unknownMsg?.type === 'error' && unknownMsg.code === 'UNKNOWN_TYPE', JSON.stringify(unknownMsg));
  await closeWs(unknown.ws);

  const shape = await openWs({ token: proto.token });
  const shapeP = nextMsg(shape.ws);
  shape.ws.send('[1,2,3]');
  const shapeMsg = await shapeP.catch(() => null);
  check('数组消息 → error BAD_SHAPE',
    shapeMsg?.type === 'error' && shapeMsg.code === 'BAD_SHAPE', JSON.stringify(shapeMsg));
  await closeWs(shape.ws);

  const rate = await openWs({ token: proto.token });
  const rateP = new Promise((resolve) => {
    const onMsg = (d) => {
      let m;
      try { m = JSON.parse(d.toString()); } catch { return; }
      if (m.type === 'error' && m.code === 'RATE_LIMITED') { rate.ws.off('message', onMsg); resolve(m); }
    };
    rate.ws.on('message', onMsg);
  });
  for (let i = 0; i < 25; i++) {
    try { rate.ws.send(JSON.stringify({ type: 'ping' })); } catch {}
  }
  const rateMsg = await Promise.race([rateP, sleep(2_500).then(() => null)]);
  check('1 秒内 25 条消息 → error RATE_LIMITED', !!rateMsg, JSON.stringify(rateMsg));
  await closeWs(rate.ws);

  const big = await openWs({ token: proto.token });
  const closeCodeP = waitClose(big.ws, 2_500);
  try { big.ws.send(JSON.stringify({ type: 'ping', pad: 'x'.repeat(6_000) })); } catch {}
  const closeCode = await closeCodeP;
  check('超长消息 → 关闭码 1009（maxPayload）', closeCode === 1009, String(closeCode));

  // ——————————————— E. 断线重连 ———————————————
  const re = await freshUser('reconn');
  const first = await openWs({ token: re.token });
  await closeWs(first.ws);
  await sleep(200);
  const second = await openWs({ token: re.token });
  check('断开后重连成功', second.ok === true, JSON.stringify({ status: second.status, data: second.data }));
  check('重连后拿到新的 connectionId',
    !!second.hello?.connectionId && second.hello.connectionId !== first.hello?.connectionId,
    JSON.stringify({ a: first.hello?.connectionId, b: second.hello?.connectionId }));
  await closeWs(second.ws);

  // ——————————————— F. 原有 REST 不回归 ———————————————
  const health = await request('/api/health');
  check('REST 回归：health 仍 200 / ok', health.status === 200 && health.data?.ok === true, JSON.stringify(health.data));
  const meAgain = await request('/api/auth/me', { token: u.token });
  check('REST 回归：me 仍 200', meAgain.status === 200 && meAgain.data?.id === userId, JSON.stringify(meAgain.data));

  console.log(`\nE2E_P21_RESULT pass=${pass} fail=${fail}`);
  if (fail > 0) { console.log('E2E_P21_FAILED'); process.exitCode = 1; }
  else console.log('E2E_P21_OK');
}

main().catch((e) => {
  console.error('E2E_P21_EXCEPTION', e);
  process.exitCode = 1;
}).finally(async () => {
  await prisma.$disconnect();
});
