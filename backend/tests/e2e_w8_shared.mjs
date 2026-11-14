/**
 * W8 战斗/会话/馆主 CD 共享化：双实例验收（定稿 §4.2 W8）。
 *
 * 运行：cd backend && npm run e2e:w8shared（需 :3001 在线且 REDIS_URL 已配；脚本临时拉起 :3002）
 *
 * 为什么必须双实例：W8 前的三处真值都是进程内 Map，
 *  - 战斗态：A 开的战斗 B 看不见，玩家断线重连被路由到 B 就等于「战斗丢了」；
 *  - 馆主 CD：A 判过「未冷却」、B 也判过，同一次冷却窗口被开两场，20min CD 形同虚设；
 *  - 会话：B 的内存副本可能落后于 A 已提交的版本，REST 分流打到 B 会读到旧档。
 *
 * 验收项：
 *  W0 前置     —— 两实例 health.w8 三个字段都是 redis
 *  W1 换实例不丢战斗 —— A 开战 → B 的 /api/battle/current 拿到同一个 battleId
 *  W2 跨实例续打 —— B 对该 battleId 出招成功，服务端共享状态真的被推进
 *  W3 馆主 CD 不可绕过 —— 开馆主战→放弃→再开（同/异实例）都是 429 GYM_ON_COOLDOWN，
 *                      且 CD 不因放弃回退（防「输→立刻重开」刷经验）；换一座演武堂不受影响
 *  W5 会话新鲜度 —— B 建 WS hydrate 后，A 侧写档，B 侧 GET /api/save 必须返回新 revision
 *
 * 输出逐例 [PASS]/[FAIL]/[SKIP]，末尾 E2E_W8_SHARED_RESULT / E2E_W8_SHARED_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import WebSocket from 'ws';
import {
  Suite, newAccount, cleanupAccounts, requireBackend, loadBackendEnv,
  formatFatal, BACKEND_ROOT, sleep, ORIGIN, waitMsg,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W8_SHARED');
const created = [];
let second = null;
const sockets = [];

const BASE_A = 'http://127.0.0.1:3001';
const BASE_B = 'http://127.0.0.1:3002';
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

/**
 * 连指定实例的 WS（harness.openWs 固定打 :3001）。
 * 与 harness.openWs 同构：token 走 `?token=` query，等待 `hello` 视为连接成功；
 * 返回的 ctx 结构与 harness 一致（`{ ws, queue }`），可直接用它的 `waitMsg`。
 */
function openWsAt(url, token) {
  return new Promise((resolve) => {
    const u = new URL(url);
    if (token) u.searchParams.set('token', token);
    const ws = new WebSocket(u.toString(), { headers: { Origin: ORIGIN }, handshakeTimeout: 5_000 });
    sockets.push(ws);
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
        finish({ ok: false, status: res.statusCode, error: `http ${res.statusCode} ${body.slice(0, 120)}` });
        try { ws.terminate(); } catch { /* 已断开 */ }
      });
    });
    ws.on('error', (e) => finish({ ok: false, status: 0, error: String(e?.message || e) }));
  });
}

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

// —————————————————————————— 主流程 ——————————————————————————

async function main() {
  await requireBackend();
  loadBackendEnv();

  second = await startSecondInstance();

  const acc = await mk('w8a');
  // 建号（含御三家队伍），否则开战会被「队伍为空」拒。
  await rest(BASE_A, '/api/game/new_game', {
    method: 'POST', token: acc.token,
    body: { playerName: 'W8测试', starterSpecId: 'sprout_owl' },
  });

  try {
    // ——— W0：三处共享存储都已切 Redis ———
    const hA = await rest(BASE_A, '/api/health');
    const hB = await rest(BASE_B, '/api/health');
    suite.check('W0a :3001 health.w8.battleStorage === redis',
      hA.data?.w8?.battleStorage === 'redis', `w8=${JSON.stringify(hA.data?.w8)}`);
    suite.check('W0b :3001 health.w8.gymCooldown === redis',
      hA.data?.w8?.gymCooldown === 'redis', `gymCooldown=${hA.data?.w8?.gymCooldown}`);
    suite.check('W0c :3001 health.w8.sessionRevision === redis',
      hA.data?.w8?.sessionRevision === 'redis', `sessionRevision=${hA.data?.w8?.sessionRevision}`);
    suite.check('W0d :3002 health.w8.battleStorage === redis',
      hB.data?.w8?.battleStorage === 'redis', `w8=${JSON.stringify(hB.data?.w8)}`);

    // ——— W1：A 开的战斗，B 实例看得见（换实例不丢战斗）———
    const start = await rest(BASE_A, '/api/battle/start', {
      method: 'POST', token: acc.token,
      body: { theme: 'grass', areaName: '微风林道', areaId: 'wild_starter', levelMin: 1, levelMax: 2 },
    });
    const battleId = start.data?.battle?.battleId;
    const moveId = start.data?.battle?.party?.[0]?.moveIds?.[0];
    suite.check('W1a A(:3001) 开战成功', start.status === 200 && !!battleId,
      `status=${start.status} code=${start.data?.code ?? '-'}`);

    const curB = await rest(BASE_B, '/api/battle/current', { token: acc.token });
    suite.check('W1b B(:3002) 的 /api/battle/current 返回同一个 battleId（跨实例共享战斗态）',
      curB.status === 200 && curB.data?.battle?.battleId === battleId,
      `status=${curB.status} got=${curB.data?.battle?.battleId ?? 'null'} want=${battleId ?? '-'}`);

    const hB2 = await rest(BASE_B, '/api/health');
    suite.check('W1c B 的 health.battles.active ≥ 1（统计读的是共享真值，不是本进程）',
      Number(hB2.data?.battles?.active ?? 0) >= 1,
      `active=${hB2.data?.battles?.active}`);

    // ——— W2：B 对该战斗出招，服务端共享状态被推进 ———
    if (battleId && moveId) {
      const act = await rest(BASE_B, '/api/battle/action', {
        method: 'POST', token: acc.token,
        body: { battleId, action: { type: 'move', moveId } },
      });
      suite.check('W2a B(:3002) 能对 A 开的战斗出招（跨实例续打）',
        act.status === 200, `status=${act.status} code=${act.data?.code ?? '-'}`);

      const curA = await rest(BASE_A, '/api/battle/current', { token: acc.token });
      suite.check('W2b A(:3001) 看到回合已被 B 推进（状态真在共享存储里）',
        (curA.data?.battle?.turn ?? 0) >= 2
          || curA.data?.battle === null, // 一回合结束也接受（说明结束态同样共享）
        `turn=${curA.data?.battle?.turn ?? 'null'} finished=${curA.data?.battle?.finished}`);
    } else {
      suite.check('W2 跨实例续打（跳过：未拿到 battleId/moveId）', false, 'no battleId or moveId');
    }

    // 清场：结束这场野怪战，后面才能开馆主战。
    await rest(BASE_B, '/api/battle/abandon', { method: 'POST', token: acc.token, body: { battleId } });

    // ——— W3：馆主 CD 跨实例不可绕过 ———
    const gymStart = await rest(BASE_A, '/api/gym/start', {
      method: 'POST', token: acc.token, body: { locationId: 'town_starter' },
    });
    const gymBattleId = gymStart.data?.battle?.battleId;
    suite.check('W3a A(:3001) 开馆主战成功',
      gymStart.status === 200 && !!gymBattleId,
      `status=${gymStart.status} code=${gymStart.data?.code ?? '-'}`);

    // 先放弃这场馆主战：CD 在开局那一刻就已占上，放弃/战败都不应回退
    // （否则「输→立刻重开」就能无限刷经验，这正是 F18-b 要防的）。
    // 注意必须先放弃再重开：战斗没结束时重开会先撞 409 GYM_BATTLE_IN_PROGRESS，
    // 那是另一条正确守卫，测不到 CD 本身。
    if (gymBattleId) {
      await rest(BASE_A, '/api/battle/abandon', { method: 'POST', token: acc.token, body: { battleId: gymBattleId } });
      await sleep(80);
    }

    const againA = await rest(BASE_A, '/api/gym/start', {
      method: 'POST', token: acc.token, body: { locationId: 'town_starter' },
    });
    suite.check('W3b 放弃后 A(:3001) 再开 → 429 GYM_ON_COOLDOWN（同实例，且 CD 不因放弃回退）',
      againA.status === 429 && againA.data?.code === 'GYM_ON_COOLDOWN',
      `status=${againA.status} code=${againA.data?.code ?? '-'}`);

    const againB = await rest(BASE_B, '/api/gym/start', {
      method: 'POST', token: acc.token, body: { locationId: 'town_starter' },
    });
    suite.check('W3c B(:3002) 开同一馆主 → 429 GYM_ON_COOLDOWN（跨实例，CD 不可绕过）',
      againB.status === 429 && againB.data?.code === 'GYM_ON_COOLDOWN',
      `status=${againB.status} code=${againB.data?.code ?? '-'}`);
    suite.check('W3d 429 带 retryAfterMs（前端可倒计时）',
      typeof againB.data?.retryAfterMs === 'number' && againB.data.retryAfterMs > 0,
      `retryAfterMs=${againB.data?.retryAfterMs}`);

    // CD 键按 locationId 区分：换一座演武堂不该被这座的 CD 拦住。
    const otherGym = await rest(BASE_B, '/api/gym/start', {
      method: 'POST', token: acc.token, body: { locationId: 'city_pebble' },
    });
    suite.check('W3e 换一座演武堂不受本座 CD 影响（CD 键含 locationId）',
      otherGym.status === 200 && !!otherGym.data?.battle?.battleId,
      `status=${otherGym.status} code=${otherGym.data?.code ?? '-'}`);
    if (otherGym.data?.battle?.battleId) {
      await rest(BASE_B, '/api/battle/abandon', {
        method: 'POST', token: acc.token, body: { battleId: otherGym.data.battle.battleId },
      });
    }

    // ——— W5：会话新鲜度（B 的内存副本不能压过 A 已提交的新版本）———
    // 让 B 先建立该账号的内存会话副本（WS 连接 → hydrate）。
    const wsCtx = await openWsAt(WS_B, acc.token);
    suite.check('W5a B(:3002) WS 连接建立',
      wsCtx.ok === true, `status=${wsCtx.status} err=${wsCtx.error ?? '-'}`);
    const firstState = await waitMsg(wsCtx, (m) => m.type === 'session.state', 6_000);
    const revOnB = firstState?.revision ?? -1;
    suite.check('W5b B(:3002) hydrate 到会话并拿到快照', revOnB >= 0, `rev=${revOnB}`);

    // A 侧写档（heal 稳定推进 revision）。
    const heal = await rest(BASE_A, '/api/game/heal', { method: 'POST', token: acc.token, body: {} });
    const revAfterHeal = heal.data?.save?.revision ?? heal.data?.revision ?? -1;
    suite.check('W5c A(:3001) 写档成功且 revision 前进',
      heal.status === 200 && revAfterHeal > revOnB,
      `status=${heal.status} before=${revOnB} after=${revAfterHeal}`);

    // B 侧读档：内存副本落后 → 必须回库拿到新版本（改造前会返回旧 revision）。
    await sleep(150); // 让 A 的 after-commit 钩子把戳写进 Redis
    const saveOnB = await rest(BASE_B, '/api/save', { token: acc.token });
    suite.check('W5d B(:3002) 的 GET /api/save 返回 A 写入的新 revision（不读陈旧内存副本）',
      saveOnB.status === 200 && saveOnB.data?.revision === revAfterHeal,
      `status=${saveOnB.status} got=${saveOnB.data?.revision} want=${revAfterHeal}`);
  } finally {
    await stopSecondInstance();
  }
}

main()
  .catch((err) => {
    console.error(formatFatal(err));
    process.exitCode = 1;
    suite.check('未捕获异常', false, String(err?.message ?? err));
  })
  .finally(async () => {
    for (const ws of sockets) { try { ws.close(); } catch { /* noop */ } }
    if (second && second.exitCode === null) {
      try { second.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (created.length > 0) await cleanupAccounts(created).catch(() => {});
    suite.done();
  });
