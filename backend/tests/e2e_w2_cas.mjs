/**
 * W2 / 设计定稿 §3.1 + §4.2：409 的唯一裁决是 Postgres 条件更新的受影响行数。
 * 运行：cd backend && npm run e2e:w2（需 :3001 已在线、PG 可用；脚本会临时拉起 :3002）
 *
 * 为什么必须「双进程」：单实例下 `withSlotLock(userId)` 会把第二个 PUT 排队，
 * 它重读到的已是新版本，在 `checkWriteRevision` 快速拒绝阶段就 409 了 —— 永远
 * 走不到 `commitState` 的 DB 条件更新分支。只有两个后端进程各持自己的进程内锁，
 * 才会同时读到同一基线并同时进入 `updateMany`，由 DB 行锁裁决谁赢。
 *
 * 分区：
 *  A 真 PG 双连接   两条独立连接的条件 UPDATE 同时发，恰好 1 命中；附无条件 upsert 反证
 *  B 单实例并发 PUT  1×200 + 1×409，409 回带服务端当前存档，DB / GET / session 三处一致
 *  C 首档并发       单实例下恰好建 1 行、revision=1
 *  D 双进程并发 PUT  :3001 与 :3002 同基线并发 → 恰好 1 赢；create 分支 P2002→409
 *  E 严格 +1        连续 5 次串行写不跳号，authority JSON 里的镜像与 DB 列一致
 *  F 失败短路       被拒绝的写不 apply 内存、不广播快照（WS 只收到赢家那一条）
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W2_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import {
  Suite, api, newAccount, cleanupAccounts, validSave, asText,
  openWs, closeWs, sleep, requireBackend, loadBackendEnv,
  formatFatal, BACKEND_ROOT,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W2');
const created = [];
const SECOND_PORT = 3002;
const SECOND_BASE = `http://127.0.0.1:${SECOND_PORT}`;

const mk = async (prefix = 'w2') => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 完全手工控制 revision 的整包 PUT（CAS 用例必须精确控制基线）。 */
const rawPut = (token, data, revision, extra = {}) =>
  api('/api/save', {
    method: 'PUT', token,
    body: revision === undefined
      ? { data: asText(data), ...extra }
      : { data: asText(data), revision, ...extra },
  });

/** 打到第二实例的同构请求（harness.api 用模块级 BASE，不能按调用改 target）。 */
async function rawPutAt(base, token, data, revision, extra = {}) {
  const res = await fetch(`${base}/api/save`, {
    method: 'PUT',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ data: asText(data), revision, ...extra }),
  });
  const text = await res.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: res.status, data: parsed, text };
}

/** 409 若由 DB 条件更新 / create 的 P2002 裁决，文案带这句；快速拒绝不带。 */
const isDbBranch = (res) =>
  res?.status === 409 && String(res?.data?.error ?? '').includes('服务端条件写入未命中');

const getSave = (token) => api('/api/save', { token });
const getSession = (token) => api('/api/session', { token });

/** 一写一读共用的真值查询；DB 列是 W2 的唯一版本源。 */
let dbA = null;
let dbB = null;
const rowOf = async (userId) => dbA.save.findUnique({ where: { userId } });

// —————————————————————————— 第二实例生命周期 ——————————————————————————

/**
 * 拉起第二个后端进程（同库、PORT=3002），轮询 health 直到就绪。
 * 用 `node --import tsx src/index.ts` 而非 `tsx src/index.ts`：后者 CLI 会 fork
 * 子进程注册 loader，kill 父进程会留下占着 3002 的孤儿；前者单进程可干净退出。
 */
async function startSecondInstance() {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: BACKEND_ROOT,
    env: { ...process.env, PORT: String(SECOND_PORT) },
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
      const r = await fetch(`${SECOND_BASE}/api/health`, { signal: AbortSignal.timeout(800) });
      if (r.ok) return { child, log: () => log.slice(-2000) };
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  await stopSecondInstance({ child });
  throw new Error(`第二实例 15s 内未就绪：${log.slice(-1200)}`);
}

async function stopSecondInstance(inst) {
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

// —————————————————————————— 主流程 ——————————————————————————

async function main() {
  await requireBackend();
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  dbA = new PrismaClient();
  dbB = new PrismaClient();
  let second = null;
  let aborted = false;

  try {
    // ——— A：真 PG 双连接，产品 updateIfRevision 的同一条 SQL 形态 ———
    // casWriteSave 的编排由 w2SaveCas.test.ts 用确定性 barrier 单测覆盖；这里用两条
    // 独立连接直接证明「PG 行锁 + WHERE revision=N」的原子性，且给定反证。
    const accA = await mk('w2a');
    const uidA = (await dbA.user.findUnique({ where: { username: accA.username } })).id;
    const aBase = await rawPut(accA.token, validSave(), 0);
    suite.check('A0 基线写入 rev=1', aBase.status === 200 && aBase.data?.revision === 1,
      `status=${aBase.status} rev=${aBase.data?.revision}`);

    const [condA, condB] = await Promise.all([
      dbA.save.updateMany({
        where: { userId: uidA, revision: 1 },
        data: { data: '"COND_A"', revision: 2 },
      }),
      dbB.save.updateMany({
        where: { userId: uidA, revision: 1 },
        data: { data: '"COND_B"', revision: 2 },
      }),
    ]);
    const aRow = await rowOf(uidA);
    suite.check('A1 双连接条件 UPDATE 恰好 1 条命中',
      condA.count + condB.count === 1,
      `countA=${condA.count} countB=${condB.count}`);
    suite.check('A2 版本严格 +1 且落库内容属于赢家',
      aRow.revision === 2 && aRow.data === (condA.count === 1 ? '"COND_A"' : '"COND_B"'),
      `revision=${aRow.revision} data=${aRow.data}`);

    // 反证：去掉 WHERE revision 条件（W2 之前的无条件 upsert）两个写都成功，
    // 版本只涨一次 → 后写静默覆盖先写。证明 A1/A2 的断言不是永远绿的摆设。
    const unconditional = await Promise.all([
      dbA.save.update({ where: { userId: uidA }, data: { data: '"UNCOND_A"', revision: 3 } }),
      dbB.save.update({ where: { userId: uidA }, data: { data: '"UNCOND_B"', revision: 3 } }),
    ]).then(() => true, () => false);
    const uRow = await rowOf(uidA);
    suite.check('A3 反证：无条件 upsert 两写都成功且版本只涨一次',
      unconditional && uRow.revision === 3 && ['"UNCOND_A"', '"UNCOND_B"'].includes(uRow.data),
      `ok=${unconditional} revision=${uRow.revision} data=${uRow.data}`);

    // ——— B：单实例真 HTTP 并发 PUT ———
    const accB = await mk('w2b');
    const uidB = (await dbA.user.findUnique({ where: { username: accB.username } })).id;
    const bBase = await rawPut(accB.token, validSave(), 0);
    const [b1, b2] = await Promise.all([
      rawPut(accB.token, validSave({ money: 900 }), 1),
      rawPut(accB.token, validSave({ money: 800 }), 1),
    ]);
    const bStatuses = [b1.status, b2.status].sort();
    const bLoser = b1.status === 409 ? b1 : b2;
    const bWinner = b1.status === 200 ? b1 : b2;
    const bRow = await rowOf(uidB);
    const bGet = await getSave(accB.token);
    const bSession = await getSession(accB.token);
    suite.check('B0 基线写入 rev=1', bBase.status === 200 && bBase.data?.revision === 1,
      `status=${bBase.status} rev=${bBase.data?.revision}`);
    suite.check('B1 并发 PUT 恰好 1×200 + 1×409',
      bStatuses[0] === 200 && bStatuses[1] === 409,
      `statuses=${b1.status},${b2.status}`);
    suite.check('B2 409 回带服务端当前版本与存档',
      bLoser.data?.code === 'REVISION_CONFLICT' && bLoser.data?.revision === 2
      && typeof bLoser.data?.data === 'string',
      `code=${bLoser.data?.code} revision=${bLoser.data?.revision}`);
    suite.check('B3 DB 列 / GET / session 三处版本一致且严格 +1',
      bRow.revision === 2 && bGet.data?.revision === 2 && bSession.data?.revision === 2
      && bWinner.data?.revision === 2,
      `db=${bRow.revision} get=${bGet.data?.revision} session=${bSession.data?.revision} put=${bWinner.data?.revision}`);

    // ——— C：单实例首档并发，只能建一行 ———
    const accC = await mk('w2c');
    const uidC = (await dbA.user.findUnique({ where: { username: accC.username } })).id;
    const [c1, c2] = await Promise.all([
      rawPut(accC.token, validSave(), 0),
      rawPut(accC.token, validSave({ money: 1100 }), 0),
    ]);
    const cRow = await rowOf(uidC);
    const cCount = await dbA.save.count({ where: { userId: uidC } });
    suite.check('C1 首档并发恰好 1×200 + 1×409',
      [c1.status, c2.status].sort()[0] === 200 && [c1.status, c2.status].sort()[1] === 409,
      `statuses=${c1.status},${c2.status}`);
    suite.check('C2 只有一行且 revision=1',
      cCount === 1 && cRow?.revision === 1,
      `count=${cCount} revision=${cRow?.revision}`);

    // ——— D：双进程并发（W2 验收断言的核心） ———
    second = await startSecondInstance();
    suite.check('D0 第二实例 :3002 已就绪', true, 'health 200');

    // D1 首档并发：两进程各自 store.find() 都返回 null → 都走 create → P2002 → 409。
    const accD0 = await mk('w2d0');
    const [d0a, d0b] = await Promise.all([
      rawPut(accD0.token, validSave(), 0),
      rawPutAt(SECOND_BASE, accD0.token, validSave({ money: 1100 }), 0),
    ]);
    const uidD0 = (await dbA.user.findUnique({ where: { username: accD0.username } })).id;
    const d0Row = await rowOf(uidD0);
    const d0DbHit = isDbBranch(d0a) || isDbBranch(d0b);
    // 分支类型只作 INFO：两个进程谁先完成 create 由时序决定，赢家先提交时输家
    // 会在 checkWriteRevision 快速拒绝阶段就 409，走不到 P2002。create 分支的
    // P2002→409 由 w2SaveCas.test.ts 的 barrier 单测确定性覆盖，不能在 E2E 里
    // 硬断言命中某条分支（那会引入刚修完的偶发红）。
    console.log(`  [INFO] 首档并发 409 分支：${d0DbHit ? 'DB create(P2002)' : '快速拒绝'}`);
    suite.check('D1 双进程首档并发恰好 1×200 + 1×409',
      [d0a.status, d0b.status].sort()[0] === 200 && [d0a.status, d0b.status].sort()[1] === 409,
      `statuses=${d0a.status},${d0b.status} loser=${isDbBranch(d0a) || isDbBranch(d0b) ? 'DB分支' : '快速拒绝'}`);
    suite.check('D2 首档只建 1 行、revision=1，冲突请求未落库',
      d0Row?.revision === 1 && (await dbA.save.count({ where: { userId: uidD0 } })) === 1,
      `revision=${d0Row?.revision} branch=${d0DbHit ? 'DB(P2002)' : '快速拒绝'}`);

    // D2~D5：已有档并发 4 轮，每轮两进程带同一基线，赢家严格 +1。
    const accD = await mk('w2d');
    const uidD = (await dbA.user.findUnique({ where: { username: accD.username } })).id;
    const dBase = await rawPut(accD.token, validSave(), 0);
    suite.check('D3 双进程基线写入 rev=1',
      dBase.status === 200 && dBase.data?.revision === 1,
      `status=${dBase.status} rev=${dBase.data?.revision}`);
    let dRev = 1;
    let dbBranchHits = d0DbHit ? 1 : 0;
    let allRoundsOk = true;
    for (let round = 1; round <= 4; round += 1) {
      const [ra, rb] = await Promise.all([
        rawPut(accD.token, validSave({ money: 1200 - round }), dRev),
        rawPutAt(SECOND_BASE, accD.token, validSave({ money: 1100 - round }), dRev),
      ]);
      const row = await rowOf(uidD);
      const oneWinner = [ra.status, rb.status].sort()[0] === 200 && [ra.status, rb.status].sort()[1] === 409;
      const bumped = row?.revision === dRev + 1;
      if (isDbBranch(ra) || isDbBranch(rb)) dbBranchHits += 1;
      suite.check(`D3.${round} 双进程并发 1 赢 1 冲突且版本严格 +1`,
        oneWinner && bumped,
        `statuses=${ra.status},${rb.status} dbRev=${row?.revision} expect=${dRev + 1} dbBranch=${isDbBranch(ra) || isDbBranch(rb)}`);
      if (!oneWinner || !bumped) allRoundsOk = false;
      dRev = row?.revision ?? dRev;
    }
    const dFinal = await rowOf(uidD);
    // dbBranchHits 同样只作 INFO：DB 裁决的确定性证据在段 A（双连接条件 UPDATE
    // 恰好 1 命中）与 w2SaveCas.test.ts 的 barrier 单测，E2E 只裁决对外契约。
    console.log(`  [INFO] 双进程 5 组并发中命中 DB 条件更新分支：${dbBranchHits}/5`);
    suite.check('D4 四轮并发全部 1 赢 1 冲突且版本无跳号（终值 rev=5）',
      allRoundsOk && dFinal?.revision === 5,
      `allRoundsOk=${allRoundsOk} finalRev=${dFinal?.revision}`);
    suite.check('D5 冲突请求未污染存档：落库内容属于最后一轮赢家',
      [1200 - 4, 1100 - 4].includes(JSON.parse(dFinal.data).money),
      `money=${JSON.parse(dFinal.data).money} revision=${dFinal?.revision}`);

    // ——— E：revision 严格 +1 不跳号，authority JSON 是列的只读镜像 ———
    const accE = await mk('w2e');
    const uidE = (await dbA.user.findUnique({ where: { username: accE.username } })).id;
    let eRev = 0;
    let eOk = true;
    for (let i = 0; i < 5; i += 1) {
      const r = await rawPut(accE.token, validSave({ money: 1200 - i }), eRev);
      if (r.status !== 200 || r.data?.revision !== eRev + 1) eOk = false;
      eRev = r.data?.revision ?? eRev;
    }
    const eRow = await rowOf(uidE);
    const eMirror = eRow?.authority ? JSON.parse(eRow.authority).revision : null;
    suite.check('E1 连续 5 次写入每次严格 +1，DB 列=5',
      eOk && eRow?.revision === 5, `eOk=${eOk} dbRev=${eRow?.revision}`);
    suite.check('E2 authority JSON 的 revision 与 DB 列一致（只读镜像）',
      eMirror === 5, `mirror=${eMirror} column=${eRow?.revision}`);

    // ——— F：被拒绝的写不 apply 内存、不广播 ———
    const accF = await mk('w2f');
    const uidF = (await dbA.user.findUnique({ where: { username: accF.username } })).id;
    const fBase = await rawPut(accF.token, validSave(), 0);
    const ws = await openWs({ token: accF.token });
    await sleep(250);
    ws.queue.length = 0; // 丢弃 hydrate 的初始快照
    const [f1, f2] = await Promise.all([
      rawPut(accF.token, validSave({ money: 900 }), 1),
      rawPut(accF.token, validSave({ money: 800 }), 1),
    ]);
    await sleep(400);
    const snaps = ws.queue.filter((m) => m.type === 'session.state');
    const fRow = await rowOf(uidF);
    const fSession = await getSession(accF.token);
    suite.check('F0 基线写入 rev=1 且 WS 已连接',
      fBase.status === 200 && ws.ok, `status=${fBase.status} ws=${ws.ok}`);
    suite.check('F1 并发只产生 1 条 session.state 快照（冲突不广播）',
      snaps.length === 1, `snapshots=${snaps.length} statuses=${f1.status},${f2.status}`);
    suite.check('F2 内存只读缓存版本 = DB 列 = 2（冲突不 apply）',
      fRow.revision === 2 && fSession.data?.revision === 2 && snaps[0]?.revision === 2,
      `db=${fRow.revision} session=${fSession.data?.revision} snapshot=${snaps[0]?.revision}`);
    await closeWs(ws);
  } catch (e) {
    aborted = true;
    console.error('\n[ABORT]', formatFatal(e));
    suite.check('套件未抛异常', false, String(e?.message ?? e));
  } finally {
    if (second) await stopSecondInstance(second);
    try {
      const removed = await cleanupAccounts(created);
      console.log(`\n清理测试账号：${removed.users} 个（意图日志 ${removed.intents} 条）`);
    } catch (e) {
      console.error('清理测试账号失败：', e?.message ?? e);
    }
    await dbA?.$disconnect().catch(() => {});
    await dbB?.$disconnect().catch(() => {});
    const ok = suite.done();
    if (aborted || !ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  process.exit(1);
});
