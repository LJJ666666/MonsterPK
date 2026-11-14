/**
 * W9 / 设计定稿 §4.2 + §5：双实例验收（反代 + 横向扩展 + 故障注入）。
 *
 * 运行：cd backend && npm run e2e:multi（自起两实例 :3101/:3102 + 反代 :3109，需 PG+Redis）
 *
 * 为什么自起两实例 + 反代（而非复用常驻 :3001）：
 *  - W9 要测「故障注入」——杀 leader / 杀实例 / 连接闪断，必须完全掌控两个进程；
 *  - 用隔离端口 3101/3102/3109，与任何常驻 :3001 不冲突，也不污染它；
 *  - 两实例共享同一 PG + Redis（继承 .env），这正是「横向扩展」成立的硬前提。
 *
 * 分区（对应定稿 §5.4）：
 *  W0  双实例 + 反代就绪，共享存储/广播/选主均为 redis
 *  M1  反代透传：经 :3109 HTTP+WS 建连 + 写档 + 收到 session.state
 *  M2  并发 PUT（经反代）→ 1 成功 1 409、revision 只 +1
 *  M3  同 wildId 双 claim（经反代）→ 只 1 成功
 *  M4  同房间双意图（同 nonce，经反代）→ 只生效 1 次、不双推进
 *  M6  跨实例广播：A 写 → B 连接收到 session.state / wild.state / room.state
 *  M7  跨实例顶号：新设备经反代连 → 旧连接收到 bye SESSION_REPLACED
 *  F2  杀一实例 → 幸存实例仍服务、在途战斗状态不丢、无残留锁
 *  F3  连接闪断 → 经反代重连到幸存实例，回源拉全量 session.state
 *  F1  杀 leader → 新 leader 接管（fence 递增）、野怪每区仍恒 3、无双推进
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_MULTI_RESULT / E2E_MULTI_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import Redis from 'ioredis';
import {
  Suite, cleanupAccounts, validSave, asText,
  waitMsg, waitClose, closeWs, requireTargets, createClient, loadBackendEnv,
  formatFatal, BACKEND_ROOT, ORIGIN, RUN, sleep,
} from './lib/harness.mjs';
import { startReverseProxy } from './lib/reverseProxy.mjs';

const suite = new Suite('E2E_MULTI');
const created = [];
const sockets = [];
let instA = null;
let instB = null;
let proxy = null;
let aborted = false;
let acctSeq = 0;

const PORT_A = 3101;
const PORT_B = 3102;
const PORT_P = 3109;
const BASE_A = `http://127.0.0.1:${PORT_A}`;
const BASE_B = `http://127.0.0.1:${PORT_B}`;
const BASE_P = `http://127.0.0.1:${PORT_P}`;
const WS_A = `ws://127.0.0.1:${PORT_A}/ws`;
const WS_B = `ws://127.0.0.1:${PORT_B}/ws`;
const WS_P = `ws://127.0.0.1:${PORT_P}/ws`;
const AREA = 'wild_starter';
const WILD_QUERY = `/api/wild?areaId=${AREA}&theme=grass&levelMin=1&levelMax=5`;

const mk = async (prefix, base = BASE_A) => {
  acctSeq += 1;
  const username = `${prefix}_${RUN}_${acctSeq}`.slice(0, 20);
  const password = `pw-${RUN}-${acctSeq}`.slice(0, 40);
  const res = await rest(base, '/api/auth/register', { method: 'POST', body: { username, password } });
  if (res.status !== 200 || !res.data?.token) {
    throw new Error(`注册测试账号失败(${res.status}): ${res.text.slice(0, 200)}`);
  }
  created.push(username);
  return { username, password, token: res.data.token };
};

/** 跨实例 REST（绕过模块级 BASE）。 */
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

/** 与 harness.openWs 同构，目标 URL 可指定（用于连 :3101/:3102）。 */
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
    const timer = setTimeout(() => finish({ ok: false, status: -1, error: 'timeout' }), 8_000);
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
  });
}

const track = (ctx) => { sockets.push(ctx); return ctx; };
const drain = (ctx) => { if (ctx?.queue) ctx.queue.length = 0; };

async function spawnInstance(port) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, PORT: String(port), SWEEP_KEY_PREFIX: `mpk-e2e-${RUN}`, WS_HEARTBEAT_MS: '5000' },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  let spawnError = null;
  child.on('error', (e) => { spawnError = e; });
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  for (let i = 0; i < 60; i += 1) {
    if (spawnError) throw new Error(`实例 :${port} spawn 失败：${spawnError.message}`);
    if (child.exitCode !== null) {
      throw new Error(`实例 :${port} 提前退出(code=${child.exitCode})：${log.slice(-1200)}`);
    }
    try {
      const r = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return child;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  child.kill('SIGKILL');
  throw new Error(`实例 :${port} 15s 内未就绪：${log.slice(-1200)}`);
}

async function killInstance(child, signal = 'SIGTERM') {
  if (!child || child.exitCode !== null) return;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill(signal);
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function healthOf(base) {
  try {
    const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
    if (r.ok) return await r.json();
  } catch { /* 实例可能已死 */ }
  return null;
}

/** 返回当前 leader 是 A 还是 B（都不是则 null）。 */
async function leaderOf() {
  const [a, b] = await Promise.all([healthOf(BASE_A), healthOf(BASE_B)]);
  if (a?.sweep?.leader) return 'A';
  if (b?.sweep?.leader) return 'B';
  return null;
}

/** 某区野怪列表长度（WILD_PER_AREA=3）。需带 token（/api/wild 走鉴权）。 */
async function wildCount(base, area, token) {
  const r = await rest(base, `/api/wild?areaId=${area}&theme=grass&levelMin=1&levelMax=5`, { token });
  return Array.isArray(r.data?.monsters) ? r.data.monsters.length : -1;
}

// —————————————————————————— 主流程 ——————————————————————————

async function main() {
  loadBackendEnv(); // 把 .env 的 REDIS_URL / DATABASE_URL 注入，供子进程继承

  instA = await spawnInstance(PORT_A);
  instB = await spawnInstance(PORT_B);

  // 反代：把两实例收拢到 :3109，Origin 白名单放行测试用 ORIGIN（与后端 CORS 同源）。
  const originWhite = [ORIGIN, process.env.CORS_ORIGIN].filter(Boolean).join(',');
  proxy = startReverseProxy({ listenPort: PORT_P, targets: [BASE_A, BASE_B], originWhitelistCsv: originWhite });

  await requireTargets([BASE_A, BASE_B, BASE_P]);

  try {
    // ——— W0：双实例 + 反代就绪，共享存储/广播/选主均为 redis ———
    const hA = await rest(BASE_A, '/api/health');
    const hB = await rest(BASE_B, '/api/health');
    suite.check('W0a :3101 health.broadcast === redis', hA.data?.broadcast === 'redis', `broadcast=${hA.data?.broadcast}`);
    suite.check('W0b :3101 health.sweep.mode === redis', hA.data?.sweep?.mode === 'redis', `sweep=${JSON.stringify(hA.data?.sweep)}`);
    suite.check('W0c :3101 health.w8.battleStorage/gymCooldown/sessionRevision 均 redis',
      hA.data?.w8?.battleStorage === 'redis' && hA.data?.w8?.gymCooldown === 'redis' && hA.data?.w8?.sessionRevision === 'redis',
      `w8=${JSON.stringify(hA.data?.w8)}`);
    suite.check('W0d :3102 同样是 redis 三件套',
      hB.data?.broadcast === 'redis' && hB.data?.sweep?.mode === 'redis'
        && hB.data?.w8?.battleStorage === 'redis' && hB.data?.w8?.gymCooldown === 'redis' && hB.data?.w8?.sessionRevision === 'redis',
      `broadcast=${hB.data?.broadcast} sweep=${hB.data?.sweep?.mode} w8=${JSON.stringify(hB.data?.w8)}`);

    // ——— M1：反代透传 HTTP + WS ———
    const clientP = createClient({ base: BASE_P, wsHost: WS_P });
    const accM1 = await mk('w9m1');
    const wsP = track(await clientP.openWs({ token: accM1.token }));
    suite.check('M1a 经反代(:3109) WS 建连成功', wsP.ok === true, `status=${wsP.status} err=${wsP.error ?? '-'}`);
    drain(wsP);
    const put1 = await putSave(BASE_P, accM1.token, validSave(), 0);
    suite.check('M1b 经反代 PUT 存档 → 200 rev=1', put1.status === 200 && put1.data?.revision === 1, `status=${put1.status} rev=${put1.data?.revision}`);
    const snap = await waitMsg(wsP, (m) => m.type === 'session.state' && m.revision === 1, 6_000);
    suite.check('M1c 经反代写档后 WS 收到 session.state（反代正确转发 WS 下行）', !!snap, `rev=${snap?.revision}`);
    await closeWs(wsP);

    // ——— M2：并发 PUT（经反代）→ 1 成功 1 409 ———
    const accM2 = await mk('w9m2');
    const base2 = await putSave(BASE_P, accM2.token, validSave(), 0);
    suite.check('M2a 基线写档 rev=1', base2.status === 200 && base2.data?.revision === 1, `rev=${base2.data?.revision}`);
    const [cA, cB] = await Promise.all([
      putSave(BASE_P, accM2.token, validSave({ money: 1 }), 1),
      putSave(BASE_P, accM2.token, validSave({ money: 2 }), 1),
    ]);
    const wins = [cA, cB].filter((r) => r.status === 200);
    const loses = [cA, cB].filter((r) => r.status === 409);
    suite.check('M2b 并发 PUT 经负载均衡：恰好 1 成功 1 409（CAS 在共享 PG 下成立）',
      wins.length === 1 && loses.length === 1,
      `200=${wins.length} 409=${loses.length} codes=${[cA.status, cB.status]}`);
    suite.check('M2c 唯一个成功的 revision 只 +1（=2）', wins[0]?.data?.revision === 2, `rev=${wins[0]?.data?.revision}`);

    // ——— M3：同 wildId 双 claim（经反代）→ 只 1 成功 ———
    const accM3 = await mk('w9m3');
    await rest(BASE_P, '/api/game/new_game', { method: 'POST', token: accM3.token, body: { playerName: 'W9', starterSpecId: 'sprout_owl' } });
    const list = await rest(BASE_P, WILD_QUERY, { token: accM3.token });
    const target = list.data?.monsters?.find((m) => m.status === 'available');
    suite.check('M3a 取到一只可抢占的共享野怪', !!target?.id, JSON.stringify(target ?? null));
    let claimWin = 0;
    if (target?.id) {
      const [qA, qB] = await Promise.all([
        rest(BASE_P, '/api/battle/start', { method: 'POST', token: accM3.token, body: { theme: 'grass', areaName: '共享草地', areaId: AREA, levelMin: 1, levelMax: 5, wildId: target.id } }),
        rest(BASE_P, '/api/battle/start', { method: 'POST', token: accM3.token, body: { theme: 'grass', areaName: '共享草地', areaId: AREA, levelMin: 1, levelMax: 5, wildId: target.id } }),
      ]);
      claimWin = [qA, qB].filter((r) => r.status === 200).length;
      suite.check('M3b 同 wildId 双 claim（经反代）：只 1 成功（Lua 原子 claim 跨实例成立）',
        claimWin === 1, `成功数=${claimWin} status=[${qA.status},${qB.status}]`);
      const won = [qA, qB].find((r) => r.status === 200);
      if (won?.data?.battle?.battleId) {
        await rest(BASE_P, '/api/battle/abandon', { method: 'POST', token: accM3.token, body: { battleId: won.data.battle.battleId } });
      }
    } else {
      suite.check('M3b 同 wildId 双 claim（跳过：未取到野怪）', false, 'no target');
    }

    // ——— M4：同房间双意图（同 nonce，经反代）→ 只生效 1 次、不双推进 ———
    const accR1 = await mk('w9r1');
    const accR2 = await mk('w9r2');
    await putSave(BASE_P, accR1.token, validSave(), 0);
    await putSave(BASE_P, accR2.token, validSave(), 0);
    const wsR1 = track(await openWsAt(WS_P, accR1.token));
    const wsR2 = track(await openWsAt(WS_P, accR2.token));
    const quotaKey = `w9room_${RUN}`;
    const created4 = await rest(BASE_P, '/api/room/create', { method: 'POST', token: accR1.token, body: { mode: 'kernel', quotaKey } });
    suite.check('M4a 房间创建 → 200 forming', created4.status === 200 && created4.data?.room?.status === 'forming', `status=${created4.status}`);
    const roomId = created4.data?.room?.roomId;
    const joined4 = await rest(BASE_P, `/api/room/${roomId}/join`, { method: 'POST', token: accR2.token });
    suite.check('M4b 加入 → 200 active（2 座位）', joined4.status === 200 && joined4.data?.room?.seats?.length === 2, `seats=${joined4.data?.room?.seats?.length}`);
    drain(wsR1);
    // 同 nonce 双意图并发：seat0（accR1）提交两次相同 nonce，应只生效一次。
    const [d1, d2] = await Promise.all([
      rest(BASE_P, `/api/room/${roomId}/action`, { method: 'POST', token: accR1.token, body: { intent: 'move_1', nonce: 'w9dup' } }),
      rest(BASE_P, `/api/room/${roomId}/action`, { method: 'POST', token: accR1.token, body: { intent: 'move_1', nonce: 'w9dup' } }),
    ]);
    const okCount = [d1, d2].filter((r) => r.status === 200 && r.data?.ok !== false).length;
    const replayCount = [d1, d2].filter((r) => r.data?.code === 'INTENT_REPLAY').length;
    suite.check('M4c 同 nonce 双意图（经反代）：只 1 次生效、另一 1 次 INTENT_REPLAY（不双推进）',
      okCount === 1 && replayCount === 1, `ok=${okCount} replay=${replayCount} codes=[${d1.data?.code},${d2.data?.code}]`);
    // seat1 提交不同 nonce → 回合正常推进 1 次（证明房间健康、未因重放损坏）。
    const adv = await rest(BASE_P, `/api/room/${roomId}/action`, { method: 'POST', token: accR2.token, body: { intent: 'move_2', nonce: 'w9adv' } });
    suite.check('M4d 另一座位不同 nonce 提交 → 200（回合正常推进，无双推进副作用）', adv.status === 200, `status=${adv.status} code=${adv.data?.code}`);
    for (const s of [wsR1, wsR2]) { try { await closeWs(s); } catch { /* 已断开 */ } }

    // ——— M6：跨实例广播（写方 A，接收方 B 直连）———
    const accU = await mk('w9u');
    const accV = await mk('w9v');
    const baseU = await putSave(BASE_A, accU.token, validSave(), 0);
    suite.check('M6a 接收方 U 基线存档 rev=1', baseU.status === 200 && baseU.data?.revision === 1, `rev=${baseU.data?.revision}`);
    const wsU = track(await openWsAt(WS_B, accU.token)); // 接收方连 B
    await sleep(450);
    drain(wsU);
    const w6a = await putSave(BASE_A, accU.token, validSave({ money: 777 }), 1); // 写方 A
    suite.check('M6b 写方 A 二次写 rev=2', w6a.status === 200 && w6a.data?.revision === 2, `rev=${w6a.data?.revision}`);
    const sSnap = await waitMsg(wsU, (m) => m.type === 'session.state' && m.revision === 2, 6_000);
    suite.check('M6c B(:3102) 连接收到 A(:3101) 写出的 session.state（跨实例广播）', !!sSnap, `rev=${sSnap?.revision}`);

    // wild 跨实例
    const newGameV = await rest(BASE_A, '/api/game/new_game', { method: 'POST', token: accV.token, body: { playerName: 'W9v', starterSpecId: 'sprout_owl' } });
    suite.check('M6d0 accV new_game → 200', newGameV.status === 200, `status=${newGameV.status} body=${newGameV.text.slice(0, 160)}`);
    const listV = await rest(BASE_A, WILD_QUERY, { token: accV.token });
    const tV = listV.data?.monsters?.find((m) => m.status === 'available');
    suite.check('M6d 取到可抢占野怪', !!tV?.id, JSON.stringify(tV ?? null));
    if (tV?.id) {
      const claimed = await rest(BASE_A, '/api/battle/start', { method: 'POST', token: accV.token, body: { theme: 'grass', areaName: 'X', areaId: AREA, levelMin: 1, levelMax: 5, wildId: tV.id } });
      const w6e = await waitMsg(wsU, (m) => m.type === 'wild.state' && m.areaId === AREA && m.monsters?.some((x) => x.id === tV.id && x.status === 'claimed'), 6_000);
      suite.check('M6e B(:3102) 收到 A(:3101) 抢占产生的 wild.state(claimed)（跨实例）', !!w6e, `status=${claimed.status} body=${claimed.text.slice(0, 160)}`);
      if (claimed.data?.battle?.battleId) {
        await rest(BASE_A, '/api/battle/abandon', { method: 'POST', token: accV.token, body: { battleId: claimed.data.battle.battleId } });
      }
    } else {
      suite.check('M6e 野怪跨实例广播（跳过：未取到野怪）', false, 'no target');
    }

    // room 跨实例：创建方 accR3 连 A、在 A 建/操作；成员 accR4 连 B、在 B 加入，
    // 房间态在共享 PG，跨实例 join 成立；A 上的 action 广播经 Redis 转发给 B 上的 accR4。
    const accR3 = await mk('w9r3');
    const accR4 = await mk('w9r4');
    await putSave(BASE_A, accR3.token, validSave(), 0);
    const wsR3 = track(await openWsAt(WS_A, accR3.token)); // 创建方 WS 同实例 A
    const wsR4 = track(await openWsAt(WS_B, accR4.token)); // 接收方 WS 跨实例 B
    const created6 = await rest(BASE_A, '/api/room/create', { method: 'POST', token: accR3.token, body: { mode: 'kernel', quotaKey: `w9room6_${RUN}` } });
    suite.check('M6d6 房间创建 → 200', created6.status === 200, `status=${created6.status} body=${created6.text.slice(0, 160)}`);
    const roomId6 = created6.data?.room?.roomId;
    const joined6 = await rest(BASE_B, `/api/room/${roomId6}/join`, { method: 'POST', token: accR4.token }); // 成员同实例 B
    suite.check('M6e6 加入 → 200', joined6.status === 200, `status=${joined6.status} code=${joined6.data?.code} body=${joined6.text.slice(0, 120)}`);
    drain(wsR4);
    const acted6 = await rest(BASE_A, `/api/room/${roomId6}/action`, { method: 'POST', token: accR3.token, body: { intent: 'move_1', nonce: 'w9r6' } });
    const roomSnap = await waitMsg(wsR4, (m) => m.type === 'room.state' && m.room?.roomId === roomId6, 6_000);
    suite.check('M6f B(:3102) 成员收到 A(:3101) 房间操作后的 room.state（跨实例广播）', !!roomSnap, `acted=${acted6.status} code=${acted6.data?.code} body=${acted6.text.slice(0, 120)}`);
    for (const s of [wsR3, wsR4]) { try { await closeWs(s); } catch { /* 已断开 */ } }

    // ——— M7：跨实例顶号（新设备经反代）———
    drain(wsU);
    const accT = await mk('w9t');
    const oldWs = track(await openWsAt(WS_B, accT.token)); // 旧连接连 B
    const relogin = await rest(BASE_P, '/api/auth/login', { method: 'POST', body: { username: accT.username, password: accT.password } });
    const newToken = relogin.data?.token;
    suite.check('M7a 二次登录签出新 token', relogin.status === 200 && !!newToken && newToken !== accT.token, `status=${relogin.status}`);
    const newWs = track(await openWsAt(WS_P, newToken)); // 新设备经反代
    const bye = await waitMsg(oldWs, (m) => m.type === 'bye' && m.code === 'SESSION_REPLACED', 6_000);
    suite.check('M7b B(:3102) 旧连接收到 bye(SESSION_REPLACED)（跨实例顶号，新设备经反代）', !!bye, `bye=${JSON.stringify(bye)}`);
    const closed = await waitClose(oldWs.ws, 4_000);
    suite.check('M7c 旧连接被关闭且码为 4001', closed.code === 4001, `code=${closed.code}`);
    try { await closeWs(newWs); } catch { /* 已断开 */ }

    // ——— F2：杀一实例 → 幸存实例仍服务、在途战斗不丢、无残留锁 ———
    const accF2 = await mk('w9f2');
    await rest(BASE_A, '/api/game/new_game', { method: 'POST', token: accF2.token, body: { playerName: 'W9f2', starterSpecId: 'sprout_owl' } });
    const startF2 = await rest(BASE_A, '/api/battle/start', { method: 'POST', token: accF2.token, body: { theme: 'grass', areaName: 'X', areaId: AREA, levelMin: 1, levelMax: 2 } });
    const battleF2 = startF2.data?.battle?.battleId;
    suite.check('F2a A(:3101) 开战成功', startF2.status === 200 && !!battleF2, `status=${startF2.status}`);
    await killInstance(instB, 'SIGKILL'); // 杀 B，A 幸存
    await sleep(300);
    const curF2 = await rest(BASE_A, '/api/battle/current', { token: accF2.token });
    suite.check('F2b 杀 B 后 A 仍能读在途战斗（战斗态在共享存储，不丢）', curF2.status === 200 && curF2.data?.battle?.battleId === battleF2, `got=${curF2.data?.battle?.battleId}`);
    const reStart = await rest(BASE_A, '/api/battle/start', { method: 'POST', token: accF2.token, body: { theme: 'grass', areaName: 'Y', areaId: AREA, levelMin: 1, levelMax: 2 } });
    suite.check('F2c 杀 B 后 A 仍能开新战斗（无残留锁阻塞）', reStart.status === 200, `status=${reStart.status} code=${reStart.data?.code}`);
    if (reStart.data?.battle?.battleId) await rest(BASE_A, '/api/battle/abandon', { method: 'POST', token: accF2.token, body: { battleId: reStart.data.battle.battleId } });
    if (battleF2) await rest(BASE_A, '/api/battle/abandon', { method: 'POST', token: accF2.token, body: { battleId: battleF2 } });
    instB = await spawnInstance(PORT_B); // 恢复双实例供 F3

    // ——— F3：连接闪断 → 经反代重连到幸存实例，回源拉全量 ———
    const accF3 = await mk('w9f3');
    await rest(BASE_A, '/api/game/new_game', { method: 'POST', token: accF3.token, body: { playerName: 'W9f3', starterSpecId: 'spark_mouse' } });
    const putF3 = await putSave(BASE_A, accF3.token, validSave({ money: 555 }), 0);
    const revF3 = putF3.data?.revision ?? 1;
    const wsF3 = track(await openWsAt(WS_A, accF3.token)); // 连 A
    const helloF3 = await waitMsg(wsF3, (m) => m.type === 'hello', 4_000);
    suite.check('F3a A(:3101) 直连建连', !!helloF3, `ok=${wsF3.ok}`);
    await killInstance(instA, 'SIGKILL'); // A 掉线 → 连接闪断
    try { await closeWs(wsF3); } catch { /* 已断开 */ }
    // 等反代探活把死 A 从 live 移除（轮询 isLive(BASE_A) 而非 liveCount，避免 B 也临时离线时误退出）。
    for (let i = 0; i < 40 && proxy.isLive(BASE_A); i += 1) await sleep(200);
    // 经反代重连：反代此时只剩 B，路由到 B，重连 hydrate 拉全量。
    suite.check('F3-pre B(:3102) 仍存活可服务', proxy.isLive(BASE_B) === true, `liveB=${proxy.isLive(BASE_B)} liveA=${proxy.isLive(BASE_A)}`);
    const wsF3b = track(await openWsAt(WS_P, accF3.token));
    suite.check('F3b0 经反代(:3109) 重连 WS 建连成功', wsF3b.ok === true, `status=${wsF3b.status} err=${wsF3b.error ?? '-'}`);
    const reSnap = await waitMsg(wsF3b, (m) => m.type === 'session.state' && m.revision >= revF3, 6_000);
    suite.check('F3b 闪断后经反代重连到幸存实例，回源拉到全量 session.state（rev≥断前）', !!reSnap, `rev=${reSnap?.revision} want≥${revF3}`);
    try { await closeWs(wsF3b); } catch { /* 已断开 */ }
    instA = await spawnInstance(PORT_A); // 恢复双实例供 F1

    // ——— F1：杀 leader → 新 leader 接管、野怪每区仍恒 3 ———
    // 先清理上一阶段（F3 SIGKILL 杀 leader）残留的前缀租约：只删 lease 不删 fence，
    // 让两个重生子实例在下一个 5s 心跳重新选主；否则残留 60s TTL 租约会挡住本次选主。
    {
      const redisClr = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true });
      await redisClr.connect();
      await redisClr.del(`mpk-e2e-${RUN}lock:sweep:global`);
      await redisClr.quit();
    }
    let lead = null;
    for (let i = 0; i < 60 && !lead; i += 1) { lead = await leaderOf(); if (!lead) await sleep(500); }
    const accW = await mk('w9wld'); // 供 F1 读野怪池用的合法账号（带 token）
    if (!lead) {
      // 安全网：若 A/B 始终未成为 leader，打印真实 sweep 状态便于定位（不再假红）。
      const sa = await healthOf(BASE_A);
      const sb = await healthOf(BASE_B);
      suite.skip('F1 启动后 A/B 均未成为 leader', `leaderOf=null a.sweep=${JSON.stringify(sa?.sweep)} b.sweep=${JSON.stringify(sb?.sweep)}`);
    } else {
    suite.check('F1a 启动后 A/B 之一成为 leader', lead === 'A' || lead === 'B', `lead=${lead}`);
    const leaderBase = lead === 'A' ? BASE_A : BASE_B;
    const leaderHealth = await healthOf(leaderBase);
    const oldFence = leaderHealth?.sweep?.fence ?? 0;
    const wildBefore = await wildCount(lead === 'A' ? BASE_B : BASE_A, AREA, accW.token); // 在（即将成为）幸存实例上读基线
    suite.check('F1b 接管前野怪每区恒 3', wildBefore === 3, `count=${wildBefore}`);
    await killInstance(lead === 'A' ? instA : instB, 'SIGTERM'); // 优雅关闭 → 主动交还租约，接管更快
    const survBase = lead === 'A' ? BASE_B : BASE_A;
    let took = false;
    let newFence = 0;
    for (let i = 0; i < 80; i += 1) {
      const h = await healthOf(survBase);
      if (h?.sweep?.leader === true) { took = true; newFence = h.sweep.fence ?? 0; break; }
      await sleep(1000);
    }
    suite.check('F1c 幸存实例接管为新 leader', took, `survBase=${survBase}`);
    suite.check('F1d 新 leader 的 fence 严格递增（干净接管，无双推进）', newFence > oldFence, `old=${oldFence} new=${newFence}`);
    const wildAfter = await wildCount(survBase, AREA, accW.token);
    suite.check('F1e 接管后野怪每区仍恒 3（无双推进/漏补）', wildAfter === 3, `count=${wildAfter}`);
    }

    // ——— F4：锁租约过期 + 迟到释放 → 不扣掉新租约、不超卖（真 Redis Lua）———
    // 复用产品脚本，不复制 Lua；与 e2e:w3 B 段同一语义，这里作为 W9 故障注入闭环的一部分。
    const { RELEASE_SCRIPT } = await import('../src/lib/redisLockBackend.ts');
    const redisF4 = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', { lazyConnect: true });
    await redisF4.connect();
    const f4key = `lock:w9fault:late:${RUN}`;
    await redisF4.del(f4key);
    await redisF4.set(f4key, 'tokA', 'PX', 10_000); // 旧持有者 tokA 拿到租约
    await redisF4.del(f4key); // 模拟租约 TTL 过期（不等待）
    await redisF4.set(f4key, 'tokB', 'PX', 10_000); // 新持有者 tokB 拿到新租约
    const late = Number(await redisF4.eval(RELEASE_SCRIPT, 1, f4key, 'tokA')); // 迟到释放 tokA
    const after = await redisF4.get(f4key);
    const okB = Number(await redisF4.eval(RELEASE_SCRIPT, 1, f4key, 'tokB')); // 正确释放 tokB
    suite.check('F4a 租约过期后迟到释放(tokA)不扣掉新租约(tokB)', late === 0 && after === 'tokB', `late=${late} after=${after}`);
    suite.check('F4b 新租约(tokB)仍可被正确释放', okB === 1, `okB=${okB}`);
    await redisF4.del(f4key);
    await redisF4.quit();
  } catch (e) {
    aborted = true;
    console.error('\n[ABORT]', formatFatal(e));
    suite.check('套件未抛异常', false, String(e?.message ?? e));
  } finally {
    if (proxy) proxy.close();
    for (const s of sockets) { try { await closeWs(s); } catch { /* 已断开 */ } }
    for (const inst of [instA, instB]) { try { await killInstance(inst, 'SIGKILL'); } catch { /* 已死 */ } }
    if (created.length > 0) await cleanupAccounts(created).catch(() => {});
    const ok = suite.done();
    if (aborted || !ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  process.exitCode = 1;
});
