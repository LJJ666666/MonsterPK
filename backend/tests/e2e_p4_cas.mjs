/**
 * P4 写入版本并发控制（CAS）端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p4
 *
 * 这是 P4 多人的前置：在此之前，整包 PUT 只做「资源不得变富」的单调比对，
 * 两个客户端都是合法消耗时都能写成功 —— 后写的静默覆盖先写的（last-write-wins）。
 * P4 起写入必须声明基线版本，服务端按 CAS 拒绝过期写入（server-wins）。
 *
 * 分区：
 *  A 版本必填        缺 revision / 非法 revision / 超前 revision 一律拒绝
 *  B 串行 CAS        写入成功推进版本；用旧版本再写必须 409，并带回服务端快照
 *  C 重放 + 顶号      旧版本重放被 409；二次登录让旧 token 立刻失效
 *  D 意图 CAS        意图同样要带版本；冲突时不消耗 nonce（可原样重放）
 *  E 服务端写操作     gameOp 由服务端自持状态，不需要客户端声明版本，但仍推进版本号
 *  F 一致性          GET / PUT / WS 三处看到的 revision 一致
 *  G 不误封          反复冲突属并发而非作弊，不封号、不留封号审计
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P4_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, login, cleanupAccounts, validSave, asText,
  openWs, waitMsg, closeWs, requireBackend,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P4');
const created = [];
let aborted = false;

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 直接发 PUT，完全手工控制 revision（CAS 用例必须精确控制）。 */
const rawPut = (token, data, revision, extra = {}) =>
  api('/api/save', {
    method: 'PUT',
    token,
    body: revision === undefined ? { data: asText(data), ...extra } : { data: asText(data), revision, ...extra },
  });

const rawIntent = (token, type, body) =>
  api(`/api/actions/${type}`, { method: 'POST', token, body: { ...body } });

const getSave = (token) => api('/api/save', { token });
const nonceOf = (tag) => `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const jsonOf = (res) => {
  try { return JSON.parse(res.data.data); } catch { return null; }
};

/** 建一个带存档的账号，返回 { token, revision }（revision 为服务端当前版本）。 */
async function accountWithSave(prefix, overrides = {}) {
  const acc = await mk(prefix);
  const r = await rawPut(acc.token, validSave(overrides), 0);
  if (r.status !== 200) throw new Error(`基线存档失败 ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return { ...acc, revision: r.data.revision };
}

async function main() {
  const h = await requireBackend();
  suite.check('后端就绪', !!h, JSON.stringify(h));

  // ═══════════════════ A. 版本必填 ═══════════════════
  console.log('\n—— A. 版本必填 ——');

  const accA = await mk('p4_req');
  const missing = await rawPut(accA.token, validSave(), undefined);
  suite.check('不带 revision → 400 REVISION_REQUIRED',
    missing.status === 400 && missing.data?.code === 'REVISION_REQUIRED',
    `status=${missing.status} code=${missing.data?.code}`);

  const notInt = await rawPut(accA.token, validSave(), 1.5);
  suite.check('revision 非整数 → 400 REVISION_REQUIRED',
    notInt.status === 400 && notInt.data?.code === 'REVISION_REQUIRED',
    `status=${notInt.status} code=${notInt.data?.code}`);

  const ahead = await rawPut(accA.token, validSave(), 99);
  suite.check('服务端无存档但客户端声称 rev=99 → 409 REVISION_CONFLICT',
    ahead.status === 409 && ahead.data?.code === 'REVISION_CONFLICT',
    `status=${ahead.status} code=${ahead.data?.code}`);

  const first = await rawPut(accA.token, validSave(), 0);
  suite.check('新档显式 revision=0 → 200 且版本推进到 1',
    first.status === 200 && first.data?.revision === 1,
    `status=${first.status} revision=${first.data?.revision}`);

  const noSave = await mk('p4_none');
  const noSaveGet = await getSave(noSave.token);
  suite.check('无存档时 GET → 404（客户端可据此把基线定为 0）',
    noSaveGet.status === 404, `status=${noSaveGet.status}`);

  // ═══════════════════ B. 串行 CAS ═══════════════════
  console.log('\n—— B. 串行 CAS ——');

  let rev = first.data.revision;
  const second = await rawPut(accA.token, validSave({ money: 900 }), rev);
  suite.check('用当前版本继续写 → 200 且版本 +1',
    second.status === 200 && second.data?.revision === rev + 1,
    `status=${second.status} revision=${second.data?.revision}`);
  rev = second.data?.revision ?? rev;

  const stale = await rawPut(accA.token, validSave({ money: 800 }), rev - 1);
  suite.check('用过期版本再写 → 409 REVISION_CONFLICT',
    stale.status === 409 && stale.data?.code === 'REVISION_CONFLICT',
    `status=${stale.status} code=${stale.data?.code}`);
  suite.check('冲突响应带回服务端当前版本',
    stale.data?.revision === rev, `resp=${stale.data?.revision} expect=${rev}`);

  const conflictSave = (() => {
    try { return JSON.parse(stale.data?.data ?? 'null'); } catch { return null; }
  })();
  const serverNow = await getSave(accA.token);
  suite.check('冲突响应带回服务端存档本体（客户端可直接应用）',
    !!conflictSave && conflictSave.money === jsonOf(serverNow)?.money,
    `conflict.money=${conflictSave?.money} server.money=${jsonOf(serverNow)?.money}`);

  const replayOk = await rawPut(accA.token, validSave({ money: 800 }), stale.data.revision);
  suite.check('用冲突响应里的版本重放 → 200（一条往返即可自愈）',
    replayOk.status === 200 && replayOk.data?.revision === rev + 1,
    `status=${replayOk.status} revision=${replayOk.data?.revision}`);
  rev = replayOk.data?.revision ?? rev;

  // ═══════════════════ C. 旧版本重放 + 顶号 ═══════════════════
  console.log('\n—— C. 旧版本重放 + 顶号 ——');

  const dual = await accountWithSave('p4_dual');
  // P4-1a 顶号后同账号不再允许两台设备同时在线，CAS 的现实用途变成
  // 「同一会话内的网络重传 / 双击提交 / 离线队列重放」——仍必须带对版本。
  const baseRev = dual.revision;
  const firstWrite = await rawPut(dual.token, validSave({ money: 1000 }), baseRev);
  suite.check('首次基于当前版本写入 → 200', firstWrite.status === 200, `status=${firstWrite.status}`);

  const replay = await rawPut(dual.token, validSave({ money: 500 }), baseRev);
  suite.check('同一会话拿旧版本重放 → 409（不再静默覆盖）',
    replay.status === 409 && replay.data?.code === 'REVISION_CONFLICT',
    `status=${replay.status} code=${replay.data?.code}`);

  const nowSave = jsonOf(await getSave(dual.token));
  suite.check('服务端保留的是先写的那份（server-wins，不是 last-write-wins）',
    nowSave?.money === 1000, `money=${nowSave?.money}`);

  const replayFixed = await rawPut(dual.token, validSave({ money: 500 }), replay.data.revision);
  suite.check('对齐服务端版本后重放 → 200',
    replayFixed.status === 200, `status=${replayFixed.status}`);
  const afterRetry = jsonOf(await getSave(dual.token));
  suite.check('重放生效：现在服务端是新的内容',
    afterRetry?.money === 500, `money=${afterRetry?.money}`);

  // 顶号：二次登录让旧 token 立刻失效，从根上消除「两台设备同时写同一存档」。
  const dev2 = await login(dual.username, dual.password);
  const tokenB = dev2.data?.token;
  suite.check('二次登录拿到新 token', typeof tokenB === 'string' && tokenB !== dual.token,
    `len=${tokenB?.length}`);
  const oldMe = await api('/api/auth/me', { token: dual.token });
  suite.check('旧 token REST → 403 SESSION_REPLACED（顶号）',
    oldMe.status === 403 && oldMe.data?.code === 'SESSION_REPLACED',
    `status=${oldMe.status} code=${oldMe.data?.code}`);
  const newMe = await api('/api/auth/me', { token: tokenB });
  suite.check('新 token REST 正常', newMe.status === 200, `status=${newMe.status}`);

  // ═══════════════════ D. 意图 CAS ═══════════════════
  console.log('\n—— D. 意图 CAS ——');

  const shopAcc = await accountWithSave('p4_intent', { money: 1000 });
  const buyBase = validSave({ money: 1000 });

  const intentNoRev = await rawIntent(shopAcc.token, 'shop_buy', {
    nonce: nonceOf('nir'), save: asText(buyBase), payload: { itemId: 'capsule_basic', amount: 1 },
  });
  suite.check('意图不带 revision → 400 REVISION_REQUIRED',
    intentNoRev.status === 400 && intentNoRev.data?.code === 'REVISION_REQUIRED',
    `status=${intentNoRev.status} code=${intentNoRev.data?.code}`);

  const staleIntentNonce = nonceOf('ist');
  const intentStale = await rawIntent(shopAcc.token, 'shop_buy', {
    nonce: staleIntentNonce, revision: 0, save: asText(buyBase), payload: { itemId: 'capsule_basic', amount: 1 },
  });
  suite.check('意图带过期 revision → 409',
    intentStale.status === 409 && intentStale.data?.code === 'REVISION_CONFLICT',
    `status=${intentStale.status} code=${intentStale.data?.code}`);

  // 冲突发生在消费 nonce 之前，所以同一个 nonce 应该还能用（不白吃一次性额度）
  const retryNonce = nonceOf('iok');
  const intentOk = await rawIntent(shopAcc.token, 'shop_buy', {
    nonce: retryNonce, revision: shopAcc.revision, save: asText(buyBase),
    payload: { itemId: 'capsule_basic', amount: 1 },
  });
  suite.check('意图带正确 revision → 200 且返回裁决后版本',
    intentOk.status === 200 && typeof intentOk.data?.revision === 'number',
    `status=${intentOk.status} revision=${intentOk.data?.revision}`);
  suite.check('裁决推进了版本（不只是登记授权）',
    intentOk.data?.revision > shopAcc.revision,
    `before=${shopAcc.revision} after=${intentOk.data?.revision}`);

  const cost = intentOk.data?.result?.cost;
  const applied = validSave({ money: 1000 - (cost ?? 200), inventory: { capsule_basic: 7, potion_small: 3 } });
  const commit = await rawPut(shopAcc.token, applied, intentOk.data.revision, { intentNonce: retryNonce });
  suite.check('按裁决结果提交（用裁决后的版本）→ 200',
    commit.status === 200, `status=${commit.status} code=${commit.data?.code ?? ''}`);

  const commitStaleRev = await rawPut(shopAcc.token, applied, intentOk.data.revision, { intentNonce: nonceOf('late') });
  suite.check('提交后用旧版本再提交 → 409（版本已推进）',
    commitStaleRev.status === 409, `status=${commitStaleRev.status} code=${commitStaleRev.data?.code ?? ''}`);

  // ═══════════════════ E. 服务端写操作 ═══════════════════
  console.log('\n—— E. 服务端写操作 ——');

  const healAcc = await accountWithSave('p4_heal', {
    locationId: 'town_starter',
    party: [{ ...validSave().party[0], hp: 1 }],
  });
  const heal = await api('/api/game/heal', { method: 'POST', token: healAcc.token, body: {} });
  suite.check('服务端写操作不需要客户端声明版本（服务端自持状态）→ 200',
    heal.status === 200, `status=${heal.status} code=${heal.data?.code ?? ''}`);
  suite.check('服务端写操作推进版本号',
    typeof heal.data?.revision === 'number' && heal.data.revision > healAcc.revision,
    `before=${healAcc.revision} after=${heal.data?.revision}`);

  const healThenPut = await rawPut(healAcc.token, jsonOf(heal), healAcc.revision);
  suite.check('写操作后用旧版本 PUT → 409（客户端必须跟上）',
    healThenPut.status === 409, `status=${healThenPut.status} code=${healThenPut.data?.code ?? ''}`);

  // ═══════════════════ F. 一致性 ═══════════════════
  console.log('\n—— F. revision 三处一致 ——');

  const wsAcc = await accountWithSave('p4_ws');
  const ws = await openWs({ token: wsAcc.token });
  try {
    // 连接建立会推 hydrate 快照
    await waitMsg(ws, (m) => m.type === 'session.state', 3_000);
    const putRes = await rawPut(wsAcc.token, validSave({ money: 777 }), wsAcc.revision);
    const putRev = putRes.data?.revision;
    const snap = await waitMsg(ws, (m) => m.type === 'session.state' && m.revision === putRev, 3_000);
    suite.check('WS 广播的 revision 与 PUT 返回一致',
      snap?.revision === putRev, `ws=${snap?.revision} put=${putRev}`);

    const got = await getSave(wsAcc.token);
    suite.check('GET /api/save 的 revision 与 PUT 返回一致',
      got.data?.revision === putRev, `get=${got.data?.revision} put=${putRev}`);

    const ses = await api('/api/session', { token: wsAcc.token });
    suite.check('GET /api/session 的 revision 与 PUT 返回一致',
      ses.data?.revision === putRev, `session=${ses.data?.revision} put=${putRev}`);
  } finally {
    closeWs(ws);
  }

  // ═══════════════════ G. 不误封 ═══════════════════
  console.log('\n—— G. 反复冲突不误封 ——');

  const spamAcc = await accountWithSave('p4_spam');
  let lastStatus = 0;
  for (let i = 0; i < 10; i++) {
    const r = await rawPut(spamAcc.token, validSave({ money: 10 }), 0); // 一直用 0
    lastStatus = r.status;
  }
  suite.check('连续 10 次版本冲突 → 每次都是 409（不是 403/封号）',
    lastStatus === 409, `last=${lastStatus}`);

  const spamMe = await api('/api/auth/me', { token: spamAcc.token });
  suite.check('冲突不改判为作弊：账号未被封',
    spamMe.status === 200 && spamMe.data?.banned === false, JSON.stringify(spamMe.data?.banned));

  const spamSave = await getSave(spamAcc.token);
  suite.check('冲突不落库：服务端存档仍是原来的内容',
    jsonOf(spamSave)?.money === 1200, `money=${jsonOf(spamSave)?.money}`);

  const spamWrite = await rawPut(spamAcc.token, validSave({ money: 1100 }), spamSave.data?.revision);
  suite.check('冲突后正常写入仍然可行（没被锁死）',
    spamWrite.status === 200, `status=${spamWrite.status}`);

  // ═══════════════════ H. 真并发（TOCTOU）═══════════════════
  // 上面都是「先 A 后 B」的串行冲突。真正危险的是两条请求同时进来：
  // 校验和写之间有 await，若没有并发保护，两条都会读到同一版本、都通过校验、
  // 都写成功，版本号却只涨一次 —— 后写的一方被静默覆盖，CAS 形同虚设。
  // 说明：本机这个形状（undici + Prisma 队列 + 内存会话）即使去掉锁也只会有
  // 一条成功，所以这里测的是「对外契约」；「临界区不交错」由
  // tests/slotLock.test.ts 确定性钉住（去掉锁时该单测的 1、2 两条会失败）。
  console.log('\n—— H. 真并发（同时发出，不能双写）——');

  const raceAcc = await accountWithSave('p4_race');
  const raceRev = raceAcc.revision;
  const [ra, rb] = await Promise.all([
    rawPut(raceAcc.token, validSave({ money: 1001 }), raceRev),
    rawPut(raceAcc.token, validSave({ money: 1002 }), raceRev),
  ]);
  const passed = [ra, rb].filter((r) => r.status === 200).length;
  const rejected = [ra, rb].filter((r) => r.status === 409 && r.data?.code === 'REVISION_CONFLICT').length;
  suite.check('同一版本同时发两条 PUT → 恰好一条成功',
    passed === 1, `a=${ra.status} b=${rb.status}`);
  suite.check('另一条 409 REVISION_CONFLICT（不是 500/双成功）',
    rejected === 1, `a=${ra.status}/${ra.data?.code ?? ''} b=${rb.status}/${rb.data?.code ?? ''}`);

  const raceNow = await getSave(raceAcc.token);
  suite.check('版本只涨一次（并发写没有都落库）',
    raceNow.data?.revision === raceRev + 1,
    `before=${raceRev} after=${raceNow.data?.revision}`);
  const raceMoney = jsonOf(raceNow)?.money;
  const winner = [ra, rb].find((r) => r.status === 200);
  suite.check('落库内容与胜出的那条一致',
    raceMoney === (ra.status === 200 ? 1001 : 1002) && winner?.data?.revision === raceRev + 1,
    `money=${raceMoney}`);

  // 服务端写操作没有 CAS 但同样要串行：两条并发 heal 都必须生效，不能互相吞掉。
  const healRace = await accountWithSave('p4_healrace', {
    locationId: 'town_starter',
    party: [{ ...validSave().party[0], hp: 1 }],
  });
  const [h1, h2] = await Promise.all([
    api('/api/game/heal', { method: 'POST', token: healRace.token, body: {} }),
    api('/api/game/heal', { method: 'POST', token: healRace.token, body: {} }),
  ]);
  const healOk = [h1, h2].filter((r) => r.status === 200).length;
  suite.check('并发两条服务端写操作都成功（互相不吞）',
    healOk === 2, `h1=${h1.status} h2=${h2.status}`);
  const healRaceNow = await getSave(healRace.token);
  suite.check('并发写操作版本各涨一次（+2）',
    healRaceNow.data?.revision === healRace.revision + 2,
    `before=${healRace.revision} after=${healRaceNow.data?.revision}`);
}

try {
  await main();
} catch (e) {
  aborted = true;
  console.error('\n[ABORT]', e?.stack || e);
  suite.check('套件未抛异常', false, String(e?.message ?? e));
} finally {
  if (!process.argv.includes('--keep')) {
    const removed = await cleanupAccounts(created);
    console.log(`\n清理测试账号：${removed.users} 个（意图日志 ${removed.intents} 条）`);
  }
  const ok = suite.done();
  if (aborted) process.exitCode = 1;
  if (!ok) process.exitCode = 1;
}
