/**
 * W5 / 设计定稿 §3.5 + §5：广播与跨实例顶号（真 Redis 双实例验收）。
 * 运行：cd backend && npm run e2e:w5（需 :3001 已在线、REDIS_URL 已配；脚本临时拉起 :3002）
 *
 * 为什么必须「双进程」：W5 的全部价值在于「写发生在 A 实例、连在 B 实例的客户端
 * 也能收到快照」。单实例下 publish→自身订阅→本地转发是同一进程内闭环，证明不了跨进程。
 * 故本套件临时 spawn 一个 :3002（同 REDIS_URL / 同 DB），与常驻 :3001 组成双实例。
 *
 * 分区（对应定稿验收断言）：
 *  B0 双实例就绪且 broadcast 均为 redis
 *  B1 session 跨实例  —— A(:3001) PUT 存档 → B(:3002) 连接收到 session.state 且 revision 递增
 *  B2 wild   跨实例  —— A(:3001) 抢占野怪 → B(:3002) 连接收到 wild.state(claimed→available)
 *  B3 room   跨实例  —— A(:3001) 加入/出招 → B(:3002) 创建者收到 room.state；且不含隐藏态
 *  B4 跨实例顶号    —— B 旧连接收到 bye(SESSION_REPLACED) + close(4001)
 *  B5 跳号回源回路  —— session.resync / room.resync 上行均收到服务端重推快照
 *                     （订阅闪断跳号自动回源的「检测」由前端 ws.test.ts 单测覆盖，
 *                       此处覆盖「回源通路」；两者串起完整闭环）
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W5_RESULT / E2E_W5_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  Suite, api, newAccount, login, cleanupAccounts, validSave, asText,
  waitMsg, waitClose, closeWs, requireBackend, loadBackendEnv,
  formatFatal, BACKEND_ROOT, ORIGIN, RUN, sleep,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W5');
const created = [];
const sockets = [];
let second = null;
let aborted = false;

const BASE_A = 'http://127.0.0.1:3001';
const BASE_B = 'http://127.0.0.1:3002';
const WS_B = 'ws://127.0.0.1:3002/ws';
const WS_A = 'ws://127.0.0.1:3001/ws';
const AREA = 'wild_starter';
const WILD_QUERY = `/api/wild?areaId=${AREA}&theme=grass&levelMin=1&levelMax=5`;

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 跨实例 REST（harness.api 只打模块级 BASE=3001）。 */
async function rest(base, path, { method = 'GET', token, body } = {}) {
  const headers = {};
  if (token) headers.Authorization = `Bearer ${token}`;
  let payload;
  if (body !== undefined) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await fetch(`${base}${path}`, { method, headers, body: payload });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data, text };
}

const putSave = (base, token, data, revision) =>
  rest(base, '/api/save', { method: 'PUT', token, body: { data: asText(data), revision } });

/** 与 harness.openWs 同构，但目标 URL 可指定（用于连 :3002）。 */
function openWsAt(url, token) {
  return new Promise((resolve) => {
    const u = new URL(url);
    if (token) u.searchParams.set('token', token);
    const ws = new WebSocket(u.toString(), { headers: { Origin: ORIGIN }, handshakeTimeout: 5_000 });
    const queue = [];
    const ctx = { ws, queue, ok: false, status: 0, hello: null };
    let settled = false;
    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(Object.assign(ctx, extra));
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
    ws.on('close', (code, reason) => { ws.closeInfo = { code, reason: String(reason || '') }; });
  });
}

const track = (ctx) => { sockets.push(ctx); return ctx; };
const drain = (ctx) => { if (ctx?.queue) ctx.queue.length = 0; };

// —————————————————————————— 第二实例生命周期 ——————————————————————————

async function startSecondInstance() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, PORT: '3002' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });

  for (let i = 0; i < 60; i += 1) {
    if (spawnError) throw new Error(`第二实例 spawn 失败：${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`第二实例提前退出(code=${child.exitCode})：${log.slice(-1200)}`);
    }
    try {
      const r = await fetch(`${BASE_B}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return child;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`第二实例 15s 内未就绪：${log.slice(-1200)}`);
}

async function stopSecondInstance() {
  if (!second || second.exitCode !== null) return;
  const exited = new Promise((r) => second.once('exit', r));
  second.kill('SIGTERM');
  await Promise.race([exited, sleep(3_000)]);
  if (second.exitCode === null) {
    second.kill('SIGKILL');
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function main() {
  await requireBackend();
  loadBackendEnv(); // 把 .env 的 REDIS_URL 注入 process.env，供子进程继承

  const accU = await mk('w5u'); // 连在 B(:3002) 的「被广播接收方」
  const accV = await mk('w5v'); // 在 A(:3001) 触发写的「写入方」

  try {
    // ——— B0：双实例就绪 + 广播模式 ———
    const hA = await api('/api/health');
    suite.check('B0a :3001 health.broadcast === redis（W5 已启用）',
      hA.data?.broadcast === 'redis', `broadcast=${hA.data?.broadcast}`);
    second = await startSecondInstance();
    const hB = await rest(BASE_B, '/api/health');
    suite.check('B0b :3002 第二实例就绪且 broadcast === redis',
      hB.status === 200 && hB.data?.broadcast === 'redis',
      `status=${hB.status} broadcast=${hB.data?.broadcast}`);

    // ——— B1：session 跨实例 ———
    // 先给 accU 在 A 上落一份存档（revision 1），再连 B，最后从 A 再写一次，B 应收到 rev 2。
    const base = await putSave(BASE_A, accU.token, validSave(), 0);
    suite.check('B1a A 上基线写入 rev=1', base.status === 200 && base.data?.revision === 1,
      `status=${base.status} rev=${base.data?.revision}`);

    const wsU = track(await openWsAt(WS_B, accU.token));
    await sleep(450);
    const hydrate = wsU.queue.filter((m) => m.type === 'session.state')
      .sort((a, b) => (b.revision ?? -1) - (a.revision ?? -1))[0];
    const baseline = hydrate?.revision ?? 0;
    drain(wsU);

    const w1 = await putSave(BASE_A, accU.token, validSave({ money: 999 }), 1);
    suite.check('B1b A 上二次写入 rev=2', w1.status === 200 && w1.data?.revision === 2,
      `status=${w1.status} rev=${w1.data?.revision}`);
    const snap2 = await waitMsg(wsU,
      (m) => m.type === 'session.state' && m.revision === 2 && m.revision > baseline, 5_000);
    suite.check('B1c B(:3002) 连接收到 A(:3001) 写出的 session.state（rev=2，跨实例）',
      !!snap2, `baseline=${baseline} received=${JSON.stringify(snap2 && { rev: snap2.revision })}`);

    // ——— B2：wild 跨实例 ———
    const vBase = await putSave(BASE_A, accV.token, validSave(), 0);
    suite.check('B2a 写入方 V 基线存档 OK', vBase.status === 200, `status=${vBase.status}`);
    const list = await rest(BASE_A, WILD_QUERY, { token: accV.token });
    const target = list.data?.monsters?.find((m) => m.status === 'available');
    suite.check('B2b 取到一只可抢占的共享野怪', !!target?.id, JSON.stringify(target ?? null));

    const claimed = await rest(BASE_A, '/api/battle/start', {
      method: 'POST', token: accV.token,
      body: { theme: 'grass', areaName: '共享草地', areaId: AREA, levelMin: 1, levelMax: 5, wildId: target.id },
    });
    suite.check('B2c V 在 A 上抢占野怪 → 200', claimed.status === 200, `status=${claimed.status}`);
    const pushClaimed = await waitMsg(wsU,
      (m) => m.type === 'wild.state' && m.areaId === AREA
        && m.monsters?.some((x) => x.id === target.id && x.status === 'claimed'), 5_000);
    suite.check('B2d B(:3002) 连接收到 A(:3001) 抢占产生的 wild.state(claimed)（跨实例）',
      !!pushClaimed, `rev=${pushClaimed?.revision}`);

    const aban = await rest(BASE_A, '/api/battle/abandon', {
      method: 'POST', token: accV.token, body: { battleId: claimed.data?.battle?.battleId },
    });
    suite.check('B2e V 放弃战斗 → 200', aban.status === 200, `status=${aban.status}`);
    const pushReleased = await waitMsg(wsU,
      (m) => m.type === 'wild.state' && m.areaId === AREA
        && m.monsters?.some((x) => x.id === target.id && x.status === 'available'), 5_000);
    suite.check('B2f B(:3002) 连接收到 wild.state(available)（放弃后放回池子，跨实例）',
      !!pushReleased, `rev=${pushReleased?.revision}`);

    // ——— B3：room 广播（经 Redis 传输）+ 隐藏态裁剪 ———
    // 架构说明：房间状态当前为单实例内存态（W6 才迁共享存储），成员连接必在同一实例，
    // 故「跨实例 room 送达」在 W6 前无法构造（单账号单连接 + 房间态不跨实例）。本用例在
    // A(:3001) 上创建并加入，验证 room.state 经 Redis 广播传输送达成员 + 服务端按接收者裁剪
    // （不含 tokenDigest / connectionId / 他人 userId）。room 与 session/wild 共用同一
    // RedisBroadcastTransport.toUser，B1/B2 已证明该传输跨实例可用。
    const accR1 = await mk('w5r1');
    const accR2 = await mk('w5r2');
    const r1Base = await putSave(BASE_A, accR1.token, validSave(), 0);
    suite.check('B3a 房间创建方基线存档 OK', r1Base.status === 200, `status=${r1Base.status}`);
    const wsR1 = track(await openWsAt(WS_A, accR1.token)); // 创建方连 A
    const wsR2 = track(await openWsAt(WS_A, accR2.token)); // 加入方连 A
    const quotaKey = `w5room_${RUN}`;
    const created1 = await rest(BASE_A, '/api/room/create', {
      method: 'POST', token: accR1.token, body: { mode: 'kernel', quotaKey },
    });
    suite.check('B3a 房间创建 → 200 forming',
      created1.status === 200 && created1.data?.room?.status === 'forming',
      `status=${created1.status} room=${JSON.stringify(created1.data?.room).slice(0, 160)}`);
    const roomId = created1.data?.room?.roomId;

    drain(wsR1);
    const joined = await rest(BASE_A, `/api/room/${roomId}/join`, { method: 'POST', token: accR2.token });
    suite.check('B3b 加入房间 → 200 active（2 座位）',
      joined.status === 200 && joined.data?.room?.status === 'active'
      && joined.data.room.seats.length === 2,
      `status=${joined.status} seats=${joined.data?.room?.seats?.length}`);
    const roomSnap = await waitMsg(wsR1,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && m.room.status === 'active' && m.room.seats.length === 2, 5_000);
    suite.check('B3c 创建方收到 room.state（经 Redis 广播传输送达成员）',
      !!roomSnap, `rev=${roomSnap?.room?.revision}`);

    const rawRoom = JSON.stringify(roomSnap?.room ?? {});
    suite.check('B3d room.state 不含隐藏态（tokenDigest / connectionId / 他人 username）',
      !rawRoom.includes('tokenDigest') && !rawRoom.includes('digest')
      && !rawRoom.includes('conn_') && !rawRoom.includes(accR1.username)
      && !rawRoom.includes(accR2.username),
      `len=${rawRoom.length}`);

    const acted = await rest(BASE_A, `/api/room/${roomId}/action`, {
      method: 'POST', token: accR2.token, body: { intent: 'move_1', nonce: 'w5r2a' },
    });
    suite.check('B3e 出招 → 200', acted.status === 200, `status=${acted.status}`);
    const actSnap = await waitMsg(wsR1,
      (m) => m.type === 'room.state' && m.room.roomId === roomId && m.room.lastAction?.seat === 1, 5_000);
    suite.check('B3f 创建方收到出招后的 room.state（广播）',
      !!actSnap, `lastAction=${JSON.stringify(actSnap?.room?.lastAction)}`);

    // B5-room：回源通路（room.resync 上行 → 服务端重推）
    drain(wsR1);
    wsR1.ws.send(JSON.stringify({ type: 'room.resync', roomId }));
    const resyncRoom = await waitMsg(wsR1,
      (m) => m.type === 'room.state' && m.room.roomId === roomId, 4_000);
    suite.check('B5a room.resync 上行 → 服务端重推 room.state',
      !!resyncRoom, `rev=${resyncRoom?.room?.revision}`);

    for (const s of [wsR1, wsR2]) {
      try { await closeWs(s); } catch { /* 已断开 */ }
    }

    // ——— B4：跨实例顶号 ———
    drain(wsU); // wsU 此刻仍是 accU 的「旧 token」连接（在 B 上）
    const relogin = await login(accU.username, accU.password);
    const newToken = relogin.data?.token;
    suite.check('B4a 二次登录签出新 token', relogin.status === 200 && !!newToken && newToken !== accU.token,
      `status=${relogin.status}`);

    // 新设备连 A(:3001) → onConnected 广播 takeover(新sv) → B 踢旧连接 wsU
    const wsNew = track(await openWsAt(WS_A, newToken));
    const bye = await waitMsg(wsU,
      (m) => m.type === 'bye' && m.code === 'SESSION_REPLACED', 6_000);
    suite.check('B4b B(:3002) 旧连接收到 bye(SESSION_REPLACED)（跨实例顶号）',
      !!bye, `bye=${JSON.stringify(bye)}`);
    const closed = await waitClose(wsU.ws, 4_000);
    suite.check('B4c 旧连接被关闭且码为 4001', closed.code === 4001, `code=${closed.code}`);

    // ——— B5：session.resync 回源通路 ———
    const wsU2 = track(await openWsAt(WS_B, newToken)); // 用新 token 在 B 上建连
    await sleep(400);
    drain(wsU2);
    wsU2.ws.send(JSON.stringify({ type: 'session.resync' }));
    const resyncSession = await waitMsg(wsU2, (m) => m.type === 'session.state', 4_000);
    suite.check('B5b session.resync 上行 → 服务端重推 session.state',
      !!resyncSession, `rev=${resyncSession?.revision}`);

    // 收尾：关掉仍开着的 WS（track 列表里的也会在 finally 再关一次，幂等）
    for (const s of [wsNew, wsU2]) {
      try { await closeWs(s); } catch { /* 已断开 */ }
    }
  } catch (e) {
    aborted = true;
    console.error('\n[ABORT]', formatFatal(e));
    suite.check('套件未抛异常', false, String(e?.message ?? e));
  } finally {
    if (second) await stopSecondInstance();
    for (const s of sockets) {
      try { await closeWs(s); } catch { /* 已断开 */ }
    }
    try {
      const removed = await cleanupAccounts(created);
      console.log(`\n清理测试账号：${removed.users} 个（意图日志 ${removed.intents} 条）`);
    } catch (e) {
      console.error('清理测试账号失败：', e?.message ?? e);
    }
    const ok = suite.done();
    if (aborted || !ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  process.exitCode = 1;
});
