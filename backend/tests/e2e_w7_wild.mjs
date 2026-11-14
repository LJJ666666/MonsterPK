/**
 * W7 野怪池 Redis 化：双实例验收（定稿 §3.6 / §4.2 W7）。
 *
 * 运行：cd backend && npm run e2e:w7wild（需 :3001 在线且 REDIS_URL 已配；脚本临时拉起 :3002）
 *
 * 为什么必须双实例：W7 前的「同一 wildId 只有一个人抢到」是 Node 单线程的语言级保证，
 * 多进程下立刻失效。本套件让 A(:3001) 与 B(:3002) 共享同一份 Redis 野怪真值，逐条验证：
 *  W0 前置     —— 两实例 health.wild.storage === 'redis'
 *  W1 共享真值 —— A 拉的列表与 B 拉的列表是同一批 wildId（跨实例同一份池子）
 *  W2 抢占互斥 —— A 抢到后 B 再抢同一只 → 409 WILD_CLAIMED
 *  W3 并发互斥 —— A/B 同时抢同一只（不同账号）→ 恰好 1 个 200
 *  W4 视图裁剪 —— 被抢占的野怪在列表里 status=claimed 且不含 userId/battleId
 *  W5 放弃归还 —— A 放弃后 B 能抢到（跨实例）
 *  W6 超时归还 —— 把 claimAt 改到 31 分钟前，ensure 应原子归还并清在途索引
 *  W7 每区恒 3 —— 反复抢占/放弃 3 轮，列表长度恒为 3
 *
 * 输出逐例 [PASS]/[FAIL]/[SKIP]，末尾 E2E_W7_WILD_RESULT / E2E_W7_WILD_OK；任一失败 exit 1。
 */
import { spawn } from 'node:child_process';
import Redis from 'ioredis';
import {
  Suite, api, newAccount, cleanupAccounts, requireBackend, loadBackendEnv,
  formatFatal, BACKEND_ROOT, sleep,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W7_WILD');
const created = [];
let second = null;
let redis = null;

const BASE_A = 'http://127.0.0.1:3001';
const BASE_B = 'http://127.0.0.1:3002';
const AREA = 'wild_starter';
const WILD_QUERY = `/api/wild?areaId=${AREA}&theme=grass&levelMin=1&levelMax=5`;
const WILD_PER_AREA = 3;

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

/** 建初始档（含御三家队伍），否则开战会被「队伍为空」拒。 */
async function newGame(base, token) {
  return rest(base, '/api/game/new_game', {
    method: 'POST',
    token,
    body: { playerName: 'W7测试', starterSpecId: 'sprout_owl' },
  });
}

async function listWild(base, token) {
  return rest(base, WILD_QUERY, { token });
}

/** 抢一只野怪开局；spec 从列表响应里拿，避免和内容表不一致。 */
async function startWild(base, token, wildId, spec) {
  return rest(base, '/api/battle/start', {
    method: 'POST',
    token,
    body: {
      theme: spec.theme,
      areaName: spec.areaName,
      areaId: AREA,
      levelMin: spec.levelMin,
      levelMax: spec.levelMax,
      wildId,
    },
  });
}

const abandon = (base, token, battleId) =>
  rest(base, '/api/battle/abandon', { method: 'POST', token, body: { battleId } });

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
  loadBackendEnv(); // 把 .env 的 REDIS_URL 注入 process.env，供子进程继承

  redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 3,
  });

  second = await startSecondInstance();

  const accA = await mk('w7a'); // 主攻手，走 :3001
  const accB = await mk('w7b'); // 对手，走 :3002
  await newGame(BASE_A, accA.token);
  await newGame(BASE_B, accB.token);

  try {
    // ——— W0：两实例都已切到 Redis 共享野怪实现 ———
    const hA = await rest(BASE_A, '/api/health');
    const hB = await rest(BASE_B, '/api/health');
    suite.check('W0a :3001 health.wild.storage === redis',
      hA.data?.wild?.storage === 'redis', `wild=${JSON.stringify(hA.data?.wild)}`);
    suite.check('W0b :3002 health.wild.storage === redis',
      hB.data?.wild?.storage === 'redis', `wild=${JSON.stringify(hB.data?.wild)}`);

    // ——— W1：跨实例同一份池子 ———
    const lA = await listWild(BASE_A, accA.token);
    suite.check('W1a A 列表 200 且恰好 3 只',
      lA.status === 200 && Array.isArray(lA.data?.monsters) && lA.data.monsters.length === WILD_PER_AREA,
      `status=${lA.status} n=${lA.data?.monsters?.length}`);
    const spec = {
      theme: lA.data?.theme, areaName: lA.data?.areaName,
      levelMin: lA.data?.levelMin, levelMax: lA.data?.levelMax,
    };
    const idsA = (lA.data?.monsters ?? []).map((m) => m.id).sort();
    const lB = await listWild(BASE_B, accB.token);
    const idsB = (lB.data?.monsters ?? []).map((m) => m.id).sort();
    suite.check('W1b B(:3002) 看到与 A 完全相同的 wildId 集合（跨实例共享真值）',
      idsB.length === WILD_PER_AREA && JSON.stringify(idsA) === JSON.stringify(idsB),
      `A=${idsA.join(',')} B=${idsB.join(',')}`);

    // ——— W2：A 抢到后 B 抢同一只被拒 ———
    const target = idsA[0];
    const takeA = await startWild(BASE_A, accA.token, target, spec);
    suite.check('W2a A 抢到野怪并开局（200 + battleId）',
      takeA.status === 200 && !!takeA.data?.battle?.battleId,
      `status=${takeA.status} code=${takeA.data?.code ?? '-'}`);
    const battleA = takeA.data?.battle?.battleId;

    const takeB = await startWild(BASE_B, accB.token, target, spec);
    suite.check('W2b B(:3002) 抢同一只 → 409 WILD_CLAIMED（跨实例互斥）',
      takeB.status === 409 && takeB.data?.code === 'WILD_CLAIMED',
      `status=${takeB.status} code=${takeB.data?.code}`);

    // ——— W3：并发抢同一只，恰好一个成功 ———
    // 先把 A 的战斗放弃，让这只重新可抢；然后 A/B 同时打。
    if (battleA) await abandon(BASE_A, accA.token, battleA);
    await sleep(80);
    const [raceA, raceB] = await Promise.all([
      startWild(BASE_A, accA.token, target, spec),
      startWild(BASE_B, accB.token, target, spec),
    ]);
    const winCount = [raceA, raceB].filter((r) => r.status === 200).length;
    const loseOk = [raceA, raceB]
      .filter((r) => r.status !== 200)
      .every((r) => r.status === 409 && r.data?.code === 'WILD_CLAIMED');
    suite.check('W3 双实例并发抢同一只：恰好 1 个 200，其余 409 WILD_CLAIMED',
      winCount === 1 && loseOk,
      `A=${raceA.status}/${raceA.data?.code ?? '-'} B=${raceB.status}/${raceB.data?.code ?? '-'}`);

    const winner = raceA.status === 200 ? { acc: accA, base: BASE_A, res: raceA } : { acc: accB, base: BASE_B, res: raceB };
    const winnerBattle = winner.res.data?.battle?.battleId;

    // ——— W4：视图裁剪（不含归属信息） ———
    const lV = await listWild(BASE_A, accA.token);
    const claimedView = (lV.data?.monsters ?? []).find((m) => m.id === target);
    suite.check('W4 被抢占的野怪在列表里 status=claimed 且不泄露 userId/battleId',
      claimedView?.status === 'claimed'
        && claimedView?.userId === undefined && claimedView?.battleId === undefined
        && claimedView?.claim === undefined,
      `status=${claimedView?.status} keys=${Object.keys(claimedView ?? {}).join('|')}`);

    // ——— W5：放弃后跨实例可抢 ———
    if (winnerBattle) await abandon(winner.base, winner.acc.token, winnerBattle);
    await sleep(80);
    const lAfter = await listWild(BASE_B, accB.token);
    const backView = (lAfter.data?.monsters ?? []).find((m) => m.id === target);
    suite.check('W5a 放弃后野怪回到 available',
      backView?.status === 'available', `status=${backView?.status}`);
    const retake = await startWild(BASE_B, accB.token, target, spec);
    suite.check('W5b 放弃后另一实例能抢到（跨实例归还生效）',
      retake.status === 200, `status=${retake.status} code=${retake.data?.code ?? '-'}`);
    const retakeBattle = retake.data?.battle?.battleId;

    // ——— W6：claim 超时由 ensure 归还 ———
    // 产品 TTL 是 30min，E2E 不可能等；直接把这场的 claimAt 改到 31 分钟前，
    // 再触发一次列表（内部走 ensure），验证 Lua 的「超时归还 + 清在途索引」分支。
    if (retakeBattle) {
      const wildIdOfBattle = await redis.get(`wild:battle:${retakeBattle}`);
      const key = `wild:inst:${wildIdOfBattle ?? target}`;
      const past = String(Date.now() - 31 * 60_000);
      await redis.hset(key, 'claimAt', past);
      const lTimeout = await listWild(BASE_A, accA.token);
      const timedOut = (lTimeout.data?.monsters ?? []).find((m) => m.id === (wildIdOfBattle ?? target));
      suite.check('W6a 超时 claim 被 ensure 归还为 available',
        timedOut?.status === 'available', `status=${timedOut?.status}`);
      const idx = await redis.exists(`wild:battle:${retakeBattle}`);
      suite.check('W6b 归还时清掉 battle 在途索引', idx === 0, `exists=${idx}`);
      // 补到 3 只：被归还的那只还在池子里，数量仍是 3
      suite.check('W6c 归还后每区仍恒 3 只',
        (lTimeout.data?.monsters ?? []).length === WILD_PER_AREA,
        `n=${(lTimeout.data?.monsters ?? []).length}`);
    } else {
      suite.check('W6 超时归还（跳过：上一轮未拿到 battleId）', false, 'no battleId');
    }

    // ——— W7：反复抢占/放弃，数量恒定 ———
    let okRounds = 0;
    let lastCount = 0;
    for (let i = 0; i < 3; i += 1) {
      const snap = await listWild(BASE_A, accA.token);
      const available = (snap.data?.monsters ?? []).find((m) => m.status === 'available');
      lastCount = (snap.data?.monsters ?? []).length;
      if (!available) break;
      const taken = await startWild(BASE_A, accA.token, available.id, spec);
      if (taken.status !== 200) break;
      await abandon(BASE_A, accA.token, taken.data.battle.battleId);
      okRounds += 1;
    }
    const finalSnap = await listWild(BASE_B, accB.token);
    const finalCount = (finalSnap.data?.monsters ?? []).length;
    suite.check('W7 反复抢占/放弃 3 轮后，每区恒 3 只',
      okRounds === 3 && lastCount === WILD_PER_AREA && finalCount === WILD_PER_AREA,
      `rounds=${okRounds} last=${lastCount} final=${finalCount}`);
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
    if (redis) await redis.quit().catch(() => {});
    if (second && second.exitCode === null) {
      try { second.kill('SIGKILL'); } catch { /* noop */ }
    }
    if (created.length > 0) await cleanupAccounts(created).catch(() => {});
    suite.done();
  });
