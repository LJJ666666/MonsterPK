/**
 * W6.7（#188）：双实例房间跨实例送达验收（真 Redis 双实例）。
 * 运行：cd backend && npm run e2e:w7（需 :3001 已在线、REDIS_URL 已配；脚本临时拉起 :3002）
 *
 * 为什么是 W6.7 而非 W6 前：房间状态在 W6 才迁到 PG 共享存储（PgRoomStorage）。
 * W6 之前房间态是单实例内存态，成员连接必在同一实例，「跨实例 room 送达」在物理上
 * 无法构造（单账号单连接 + 房间态不跨实例）。W6 后房间真值在 PG、成员可分布在不同
 * 实例，`publishRoom` 按 seat.userId 经 `broadcastToUser`（Redis）送达，故本套件把
 * 「R1 连 A(:3001)、R2 连 B(:3002)」这一 W6 前不可能的拓扑做成真实验收。
 *
 * 约束说明：REST 进入房间要求 `connectionOf(userId)` 在「处理该请求的实例」上有 WS
 * 连接（ROOM_WS_REQUIRED）。本套件让每个成员把 REST 打到自己所连的实例，既满足 WS
 * 必连约束，又把成员分布到两个实例——正是「跨实例 room 送达」的拓扑前提。
 *
 * 分区：
 *  C0 双实例就绪且 broadcast 均为 redis
 *  C1 创建方 R1 连 A，在 A 上创建房间（本实例 WS 在线 → connectionOf 命中）
 *  C2 R2 连 B，在 B 上加入 → 连 A 的 R1 收到 room.state(active,2 seats)（跨实例送达）
 *                            连 B 的 R2 收到 room.state(active,2 seats)（同实例）
 *  C4 按接收者裁剪：R1 视图不含 R2 隐藏态、R2 视图不含 R1 隐藏态（W6.6 裁剪跨实例仍正确）
 *  C3 双向跨实例：R1 在 A 出招 → 连 B 的 R2 收到（反向）；R2 在 B 出招 → 连 A 的 R1 收到（正向，推进回合）
 *  C5 R2 连 B 上行 room.resync → 收到 room.state（回源通路跨实例）
 *  C6 断线重连：R2 断 B 再连 B，R1 在 A 再出招 → R2 重连后仍收到且仍被识别为成员（reconnect 跨实例不丢成员）
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W7_RESULT / E2E_W7_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  Suite, api, newAccount, cleanupAccounts, validSave, asText,
  waitMsg, waitClose, closeWs, requireBackend, loadBackendEnv,
  formatFatal, BACKEND_ROOT, ORIGIN, RUN, sleep,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W7');
const created = [];
const sockets = [];
let second = null;
let aborted = false;

const BASE_A = 'http://127.0.0.1:3001';
const BASE_B = 'http://127.0.0.1:3002';
const WS_A = 'ws://127.0.0.1:3001/ws';
const WS_B = 'ws://127.0.0.1:3002/ws';

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
    env: { ...process.env, PORT: '3002', MPK_DISABLE_SWEEP: '1' },
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

  const R1 = await mk('w7r1'); // 创建方，连 A(:3001)
  const R2 = await mk('w7r2'); // 加入方，连 B(:3002)

  let wsR1 = null;
  let wsR2 = null;
  let wsR2b = null;

  try {
    // ——— C0：双实例就绪 + 广播模式 ———
    const hA = await api('/api/health');
    suite.check('C0a :3001 health.broadcast === redis（W5 已启用）',
      hA.data?.broadcast === 'redis', `broadcast=${hA.data?.broadcast}`);
    second = await startSecondInstance();
    const hB = await rest(BASE_B, '/api/health');
    suite.check('C0b :3002 第二实例就绪且 broadcast === redis',
      hB.status === 200 && hB.data?.broadcast === 'redis',
      `status=${hB.status} broadcast=${hB.data?.broadcast}`);

    // ——— C1：R1 连 A 并在 A 上创建房间（本实例 WS 在线 → connectionOf 命中）———
    const r1Base = await putSave(BASE_A, R1.token, validSave(), 0);
    suite.check('C1a R1 基线存档 OK', r1Base.status === 200, `status=${r1Base.status}`);
    wsR1 = track(await openWsAt(WS_A, R1.token)); // R1 连 A
    await sleep(450);
    drain(wsR1); // 清掉刚连上时的快照（此刻 R1 还不在任何房间，通常无快照）

    const created1 = await rest(BASE_A, '/api/room/create', {
      method: 'POST', token: R1.token, body: { mode: 'kernel' },
    });
    suite.check('C1b R1 在 A 创建房间 → 200 forming',
      created1.status === 200 && created1.data?.room?.status === 'forming',
      `status=${created1.status} room=${JSON.stringify(created1.data?.room).slice(0, 160)}`);
    const roomId = created1.data?.room?.roomId;
    suite.check('C1c 房间标识非空', !!roomId, `roomId=${roomId}`);

    // ——— C2：R2 连 B 并在 B 上加入（本实例 WS 在线 → connectionOf 命中）———
    const r2Base = await putSave(BASE_B, R2.token, validSave(), 0);
    suite.check('C2a R2 基线存档 OK', r2Base.status === 200, `status=${r2Base.status}`);
    wsR2 = track(await openWsAt(WS_B, R2.token)); // R2 连 B
    await sleep(450);
    drain(wsR2);

    const joined = await rest(BASE_B, `/api/room/${roomId}/join`, { method: 'POST', token: R2.token });
    suite.check('C2b R2 在 B 加入房间 → 200 active（2 座位）',
      joined.status === 200 && joined.data?.room?.status === 'active'
      && joined.data.room.seats.length === 2,
      `status=${joined.status} seats=${joined.data?.room?.seats?.length}`);

    // 关键跨实例断言：连在 A 的 R1 收到房间状态变化（R2 在 B 加入）
    const roomSnapR1 = await waitMsg(wsR1,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && m.room.status === 'active' && m.room.seats.length === 2, 6_000);
    suite.check('C2c 连 A 的 R1 收到 room.state(active,2 seats)（跨实例送达：R2 在 B 加入）',
      !!roomSnapR1, `rev=${roomSnapR1?.room?.revision}`);

    // 同实例对照：连在 B 的 R2 收到自己的加入快照
    const roomSnapR2 = await waitMsg(wsR2,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && m.room.status === 'active' && m.room.seats.length === 2, 6_000);
    suite.check('C2d 连 B 的 R2 收到 room.state(active,2 seats)（同实例）',
      !!roomSnapR2, `rev=${roomSnapR2?.room?.revision}`);

    // ——— C4：按接收者裁剪（用 C2 拿到的快照，避免下面 drain 后丢失）———
    const rawR1 = JSON.stringify(roomSnapR1?.room ?? {});
    const rawR2 = JSON.stringify(roomSnapR2?.room ?? {});
    suite.check('C4a R1 视图不含 R2 隐藏态（username/tokenDigest/conn_）',
      !rawR1.includes(R2.username) && !rawR1.includes('tokenDigest')
      && !rawR1.includes('digest') && !rawR1.includes('conn_'),
      `len=${rawR1.length}`);
    suite.check('C4b R2 视图不含 R1 隐藏态（username/tokenDigest/conn_）',
      !rawR2.includes(R1.username) && !rawR2.includes('tokenDigest')
      && !rawR2.includes('digest') && !rawR2.includes('conn_'),
      `len=${rawR2.length}`);

    // ——— C3：双向跨实例送达 ———
    // 反向：R1（连 A）出招 → 连 B 的 R2 收到 lastAction
    drain(wsR1); drain(wsR2);
    const actedA = await rest(BASE_A, `/api/room/${roomId}/action`, {
      method: 'POST', token: R1.token, body: { intent: 'move_1', nonce: `w7-${RUN}-a1` },
    });
    suite.check('C3a R1 在 A 出招 → 200', actedA.status === 200, `status=${actedA.status}`);
    const actSnapR2 = await waitMsg(wsR2,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && m.room.lastAction?.seat === 0, 6_000);
    suite.check('C3b 连 B 的 R2 收到 R1 出招后的 room.state（反向跨实例送达）',
      !!actSnapR2, `lastAction=${JSON.stringify(actSnapR2?.room?.lastAction)}`);

    // 正向：R2（连 B）出招 → 连 A 的 R1 收到（全员交齐推进回合）
    drain(wsR1); drain(wsR2);
    const actedB = await rest(BASE_B, `/api/room/${roomId}/action`, {
      method: 'POST', token: R2.token, body: { intent: 'move_2', nonce: `w7-${RUN}-a2` },
    });
    suite.check('C3c R2 在 B 出招 → 200', actedB.status === 200, `status=${actedB.status}`);
    const fwdSnapR1 = await waitMsg(wsR1,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && (m.room.turn ?? 0) >= 2, 6_000);
    suite.check('C3d 连 A 的 R1 收到 R2 出招后的 room.state（正向跨实例送达 + 回合推进）',
      !!fwdSnapR1, `turn=${fwdSnapR1?.room?.turn}`);

    // ——— C5：R2 连 B 上行 room.resync → 收到 room.state（回源通路跨实例）———
    drain(wsR2);
    wsR2.ws.send(JSON.stringify({ type: 'room.resync', roomId }));
    const resyncRoom = await waitMsg(wsR2,
      (m) => m.type === 'room.state' && m.room.roomId === roomId, 4_000);
    suite.check('C5a R2 连 B 上行 room.resync → 服务端重推 room.state（回源跨实例）',
      !!resyncRoom, `rev=${resyncRoom?.room?.revision}`);

    // ——— C6：断线重连 —— R2 断 B 再连 B，R1 在 A 再出招 → R2 重连后仍收到且被识别为成员 ———
    await closeWs(wsR2);
    await sleep(300);
    wsR2b = track(await openWsAt(WS_B, R2.token)); // R2 重连 B
    await sleep(450);
    drain(wsR2b);
    const acted2 = await rest(BASE_A, `/api/room/${roomId}/action`, {
      method: 'POST', token: R1.token, body: { intent: 'move_3', nonce: `w7-${RUN}-a3` },
    });
    suite.check('C6a R1 在 A 再次出招 → 200', acted2.status === 200, `status=${acted2.status}`);
    const reSnapR2 = await waitMsg(wsR2b,
      (m) => m.type === 'room.state' && m.room.roomId === roomId
        && m.room.seats.some((s) => s.self === true), 6_000);
    suite.check('C6b R2 重连 B 后仍收到 room.state 且被识别为成员（reconnect 跨实例不丢成员）',
      !!reSnapR2, `selfSeat=${reSnapR2?.room?.seats?.find((s) => s.self)?.seat}`);

    // 收尾关 WS
    for (const s of [wsR1, wsR2b]) {
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
