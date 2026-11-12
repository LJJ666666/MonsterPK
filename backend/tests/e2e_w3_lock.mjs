/**
 * W3 / 设计定稿 §3.2 + §4.2：分布式租约锁。
 * 运行：cd backend && npm run e2e:w3（需 :3001 已在线、PG + Redis 可用；脚本临时拉起 :3002）
 *
 * 用 `node --import tsx` 运行，因此可以**直接 import 产品 TS 模块**，不复制
 * Lua 脚本 / 命名空间规则，避免 E2E 与实现漂移。
 *
 * 分区：
 *  A 锁模式     两实例 health.lock 均为 redis；Redis PING 通；TTL/watchdog 参数正确
 *  B 真 Redis    两个独立 RedisLockProvider（等价两个进程各持自己的 ALS）并发不交错、
 *                嵌套同 key 不死锁、watchdog 续租、租约过期、token 安全释放、抢锁超时
 *  C 双进程 HTTP E2E 预占账号锁 → 3001/3002 的 PUT 都被挡住 → 释放后恰好 1 赢 1 409
 *  D fail-fast   REDIS_URL 配了但不可达时拒绝启动，绝不静默降级回进程内锁
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W3_RESULT；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import Redis from 'ioredis';
import {
  Suite, api, newAccount, cleanupAccounts, validSave, asText,
  sleep, requireBackend, loadBackendEnv, formatFatal, BACKEND_ROOT,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W3');
const created = [];
const SECOND_PORT = 3002;
const BAD_PORT = 3003;
const SECOND_BASE = `http://127.0.0.1:${SECOND_PORT}`;
const BAD_URL = 'redis://127.0.0.1:6399';

const mk = async (prefix = 'w3a') => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

const rawPut = (token, data, revision) => api('/api/save', {
  method: 'PUT', token,
  body: { data: asText(data), revision },
});

async function rawPutAt(base, token, data, revision) {
  const res = await fetch(`${base}/api/save`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: asText(data), revision }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text };
}

const healthAt = async (base) => {
  const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(1500) });
  return { status: r.status, data: await r.json() };
};

// —————————————————————————— 子进程生命周期 ——————————————————————————

/** 单进程 `node --import tsx`（tsx CLI 会 fork 孤儿占端口，勿改回）。 */
function spawnBackend(port, extraEnv = {}) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, PORT: String(port), ...extraEnv },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  let log = '';
  child.stdout.on('data', (d) => { log += d.toString(); });
  child.stderr.on('data', (d) => { log += d.toString(); });
  return { child, log: () => log.slice(-2500) };
}

async function stopBackend(inst) {
  if (!inst?.child || inst.child.exitCode !== null) return;
  const { child } = inst;
  const exited = new Promise((r) => child.once('exit', r));
  child.kill('SIGTERM');
  await Promise.race([exited, sleep(3_000)]);
  if (child.exitCode === null) {
    child.kill('SIGKILL');
    await Promise.race([exited, sleep(1_000)]);
  }
}

async function startSecondInstance() {
  const inst = spawnBackend(SECOND_PORT);
  for (let i = 0; i < 60; i += 1) {
    if (inst.child.exitCode !== null) {
      throw new Error(`第二实例提前退出(code=${inst.child.exitCode})：${inst.log()}`);
    }
    try {
      const h = await healthAt(SECOND_BASE);
      if (h.status === 200 && h.data?.lock?.mode === 'redis') return inst;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  await stopBackend(inst);
  throw new Error(`第二实例 15s 内未就绪：${inst.log()}`);
}

// —————————————————————————— 主流程 ——————————————————————————

async function main() {
  await requireBackend();
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const { RedisLockProvider, lockNamespaceOf } = await import('../src/lib/redisLockProvider.ts');
  const { createIoredisLockBackend, RELEASE_SCRIPT, RENEW_SCRIPT } =
    await import('../src/lib/redisLockBackend.ts');

  const db = new PrismaClient();
  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 2,
  });
  let second = null;
  let bad = null;
  let aborted = false;

  try {
    // ——— A：锁模式诊断 ———
    const h1 = await healthAt('http://127.0.0.1:3001');
    suite.check('A0 :3001 跑在 Redis 租约锁上',
      h1.status === 200 && h1.data?.lock?.mode === 'redis',
      `mode=${h1.data?.lock?.mode}`);
    suite.check('A1 TTL / watchdog 参数与实现一致（30s / 10s）',
      h1.data?.lock?.ttlMs === 30_000 && h1.data?.lock?.renewMs === 10_000,
      `ttl=${h1.data?.lock?.ttlMs} renew=${h1.data?.lock?.renewMs}`);
    const pong = await redis.ping();
    suite.check('A2 本地 Redis PING 通', pong === 'PONG', `ping=${pong}`);
    suite.check('A3 命名空间映射覆盖五类 W0 裸 key',
      lockNamespaceOf('u1') === 'lock:acct:u1'
      && lockNamespaceOf('room:r1') === 'lock:room:r1'
      && lockNamespaceOf('bossq:u1') === 'lock:bossq:u1'
      && lockNamespaceOf('mapbossq:u1') === 'lock:mapbossq:u1'
      && lockNamespaceOf('rank:settle:d') === 'lock:rank:d');

    second = await startSecondInstance();
    const h2 = await healthAt(SECOND_BASE);
    suite.check('A4 :3002 就绪且同样是 Redis 锁（共享同一 Redis）',
      h2.status === 200 && h2.data?.lock?.mode === 'redis',
      `mode=${h2.data?.lock?.mode}`);

    // ——— B：真 Redis + 产品 Provider（两个独立实例 = 两个进程各自的 ALS） ———
    const backend = createIoredisLockBackend(redis);
    const mkProvider = (opts = {}) => new RedisLockProvider(backend, {
      ttlMs: 3_000, renewIntervalMs: 1_000, acquireTimeoutMs: 5_000, ...opts,
    });
    const pA = mkProvider();
    const pB = mkProvider();
    const key = 'w3:mutual';
    const nsKey = lockNamespaceOf(key);

    const events = [];
    const runBoth = (tag, provider) => provider.run(key, async () => {
      events.push(`${tag}:in`);
      await sleep(120);
      events.push(`${tag}:out`);
    });
    await Promise.all([runBoth('A', pA), runBoth('B', pB)]);
    let inside = 0;
    let maxInside = 0;
    for (const e of events) {
      if (e.endsWith(':in')) { inside += 1; maxInside = Math.max(maxInside, inside); }
      else inside -= 1;
    }
    suite.check('B0 两个独立 Provider 并发同 key：临界区不交错',
      events.length === 4 && maxInside === 1,
      `events=${events.join(',')} maxInside=${maxInside}`);
    suite.check('B1 释放后锁 key 不残留', (await redis.get(nsKey)) === null,
      `value=${await redis.get(nsKey)}`);

    // 反证：不走锁、用 barrier 强制两个任务在临界区交汇 → 必然交错。
    let gateCount = 0;
    let releaseGate;
    const gate = new Promise((r) => { releaseGate = r; });
    const unlocked = [];
    const rawJob = (tag) => (async () => {
      unlocked.push(`${tag}:in`);
      gateCount += 1;
      if (gateCount === 2) releaseGate();
      await gate;
      unlocked.push(`${tag}:out`);
    })();
    await Promise.all([rawJob('A'), rawJob('B')]);
    suite.check('B2 反证：去掉锁 + barrier 必然交错（断言不是摆设）',
      unlocked[0] === 'A:in' && unlocked[1] === 'B:in',
      `events=${unlocked.join(',')}`);

    const nestedSame = await pA.run('w3:nested', async () =>
      pA.run('w3:nested', async () => 42));
    suite.check('B3 嵌套同 key 不死锁（AsyncLocalStorage 重入旁路）',
      nestedSame === 42, `result=${nestedSame}`);

    const heldDuringNest = [];
    await pA.run('w3:outer', async () => pA.run('room:w3:r1', async () => {
      heldDuringNest.push(await redis.get('lock:acct:w3:outer'));
      heldDuringNest.push(await redis.get('lock:room:w3:r1'));
    }));
    suite.check('B4 嵌套不同 key（账号→房间）两把锁同时持有且调用顺序不变',
      heldDuringNest.length === 2 && heldDuringNest.every((t) => typeof t === 'string' && t.length > 0),
      `tokens=${heldDuringNest.map((t) => (t ? 'set' : 'null')).join(',')}`);

    // watchdog：TTL 400ms / 每 100ms 续租，持锁 700ms 期间锁必须一直有效。
    const short = mkProvider({ ttlMs: 400, renewIntervalMs: 100, acquireTimeoutMs: 3_000 });
    const wKey = 'lock:acct:w3:watchdog';
    let token0 = null;
    let minPttl = Infinity;
    let tokenChanged = false;
    await short.run('w3:watchdog', async () => {
      token0 = await redis.get(wKey);
      for (let i = 0; i < 7; i += 1) {
        await sleep(100);
        const pttl = await redis.pttl(wKey);
        minPttl = Math.min(minPttl, pttl);
        if ((await redis.get(wKey)) !== token0) tokenChanged = true;
      }
    });
    suite.check('B5 watchdog 续租：临界区超过 TTL 仍持有同一把锁',
      minPttl > 0 && !tokenChanged && typeof token0 === 'string',
      `minPttl=${minPttl} tokenChanged=${tokenChanged}`);
    suite.check('B6 watchdog 结束后锁被正常释放', (await redis.get(wKey)) === null);

    // 租约到期：没有 watchdog 续租时 TTL 自动归还，进程崩溃不会永久残留。
    const ttlKey = 'lock:acct:w3:expire';
    await redis.set(ttlKey, 'tok', 'PX', 300, 'NX');
    await sleep(450);
    suite.check('B7 租约 TTL 到期自动归还（崩溃不残留）',
      (await redis.get(ttlKey)) === null, `value=${await redis.get(ttlKey)}`);

    // token 安全续租 / 安全释放：迟到释放不得抹掉同名新租约。
    const safeKey = 'lock:acct:w3:safe';
    await redis.set(safeKey, 'tokA', 'PX', 5_000, 'NX');
    const renewWrong = Number(await redis.eval(RENEW_SCRIPT, 1, safeKey, 'tokB', '5000'));
    const releaseWrong = Number(await redis.eval(RELEASE_SCRIPT, 1, safeKey, 'tokB'));
    await redis.set(safeKey, 'tokB', 'PX', 5_000); // 模拟锁易主
    const lateRelease = Number(await redis.eval(RELEASE_SCRIPT, 1, safeKey, 'tokA'));
    const afterLate = await redis.get(safeKey);
    await redis.eval(RELEASE_SCRIPT, 1, safeKey, 'tokB');
    suite.check('B8 Lua token 比对：错 token 不续租/不释放，迟到释放不删新租约',
      renewWrong === 0 && releaseWrong === 0 && lateRelease === 0 && afterLate === 'tokB',
      `renewWrong=${renewWrong} releaseWrong=${releaseWrong} late=${lateRelease} after=${afterLate}`);

    // 抢锁超时必须明确报错，绝不静默放行。
    const holdKey = 'lock:acct:w3:timeout';
    await redis.set(holdKey, 'e2e:hold', 'PX', 3_000, 'NX');
    const impatient = mkProvider({ ttlMs: 1_000, acquireTimeoutMs: 250, retryMinMs: 20, retryMaxMs: 30 });
    let timeoutMsg = '';
    try {
      await impatient.run('w3:timeout', async () => 1);
    } catch (e) {
      timeoutMsg = String(e?.message ?? e);
    }
    suite.check('B9 抢锁超时明确抛 LOCK_ACQUIRE_TIMEOUT',
      timeoutMsg.includes('LOCK_ACQUIRE_TIMEOUT'), `msg=${timeoutMsg}`);
    await redis.eval(RELEASE_SCRIPT, 1, holdKey, 'e2e:hold');

    // ——— C：双进程 HTTP，证明写路径真的经过 Redis 锁 ———
    const accC = await mk('w3c');
    const uidC = (await db.user.findUnique({ where: { username: accC.username } })).id;
    const base = await rawPut(accC.token, validSave(), 0);
    suite.check('C0 基线存档 rev=1', base.status === 200 && base.data?.revision === 1,
      `status=${base.status} rev=${base.data?.revision}`);

    const acctKey = `lock:acct:${uidC}`;
    const preHold = await redis.set(acctKey, 'e2e:prehold', 'PX', 8_000, 'NX');
    let doneA = false;
    let doneB = false;
    const reqA = rawPut(accC.token, validSave({ money: 900 }), 1)
      .then((r) => { doneA = true; return r; });
    const reqB = rawPutAt(SECOND_BASE, accC.token, validSave({ money: 800 }), 1)
      .then((r) => { doneB = true; return r; });
    await sleep(350);
    const stillHeld = await redis.get(acctKey);
    suite.check('C1 预占账号锁成功且两实例 PUT 均被挡在门外',
      preHold === 'OK' && !doneA && !doneB && stillHeld === 'e2e:prehold',
      `preHold=${preHold} doneA=${doneA} doneB=${doneB} holder=${stillHeld}`);
    const wrongRelease = Number(await redis.eval(RELEASE_SCRIPT, 1, acctKey, 'wrong:token'));
    await sleep(120);
    suite.check('C2 错 token 释放无效，请求仍被阻塞',
      wrongRelease === 0 && !doneA && !doneB,
      `wrongRelease=${wrongRelease} doneA=${doneA} doneB=${doneB}`);

    const freed = Number(await redis.eval(RELEASE_SCRIPT, 1, acctKey, 'e2e:prehold'));
    const [rA, rB] = await Promise.all([reqA, reqB]);
    const statuses = [rA.status, rB.status].sort();
    const rowC = await db.save.findUnique({ where: { userId: uidC } });
    suite.check('C3 正确 token 释放后两实例竞争：恰好 1×200 + 1×409',
      freed === 1 && statuses[0] === 200 && statuses[1] === 409,
      `freed=${freed} statuses=${rA.status},${rB.status}`);
    suite.check('C4 版本严格 +1（DB 条件更新兜底，锁失效不写脏）',
      rowC?.revision === 2, `revision=${rowC?.revision}`);
    await sleep(150);
    suite.check('C5 两个实例释放后 Redis 无残留锁', (await redis.get(acctKey)) === null,
      `value=${await redis.get(acctKey)}`);

    // ——— D：配了 REDIS_URL 但不可达 → 拒绝启动，不静默降级 ———
    bad = spawnBackend(BAD_PORT, { REDIS_URL: BAD_URL });
    const badExited = new Promise((r) => bad.child.once('exit', r));
    await Promise.race([badExited, sleep(6_000)]);
    let badPortListening = false;
    try {
      await healthAt(`http://127.0.0.1:${BAD_PORT}`);
      badPortListening = true;
    } catch { /* 期望：端口不可达 */ }
    const badLog = bad.log();
    suite.check('D0 错误的 REDIS_URL 让实例启动失败且端口未监听',
      bad.child.exitCode !== null && !badPortListening,
      `exitCode=${bad.child.exitCode} listening=${badPortListening}`);
    suite.check('D1 失败日志明确拒绝以进程内锁降级启动',
      badLog.includes('拒绝以进程内锁降级启动') || badLog.includes('REDIS_URL'),
      `logTail=${badLog.slice(-180).replace(/\s+/g, ' ')}`);
  } catch (e) {
    aborted = true;
    console.error('\n[ABORT]', formatFatal(e));
    suite.check('套件未抛异常', false, String(e?.message ?? e));
  } finally {
    if (second) await stopBackend(second);
    if (bad) await stopBackend(bad);
    try {
      const keys = await redis.keys('lock:*:w3*');
      if (keys.length) await redis.del(...keys);
    } catch { /* 清理失败不影响结论 */ }
    try {
      const removed = await cleanupAccounts(created);
      console.log(`\n清理测试账号：${removed.users} 个（意图日志 ${removed.intents} 条）`);
    } catch (e) {
      console.error('清理测试账号失败：', e?.message ?? e);
    }
    await db?.$disconnect().catch(() => {});
    await redis.quit().catch(() => {});
    const ok = suite.done();
    if (aborted || !ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  process.exit(1);
});
