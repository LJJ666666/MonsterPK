/**
 * P4-1 顶号 + 共享野怪端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p41
 *
 * 分区：
 *  A 接口边界      health 带 wild 统计；未登录读野怪 401；未知实例 404
 *  B 共享一致性    两个不同账号读同一区域，看到完全相同的实例 id 列表
 *  C 捕获互斥      两个账号并发抢同一只，只有一条 200，另一条 409 WILD_CLAIMED
 *  D 跨账号广播    B 开 WS，A 抢占 → B 收到 wild.state(claimed)；A 放弃 → available
 *  E 结算广播      A 打完一场 → B 看到 wild.state(resolved)
 *  F 顶号          二次登录后旧 token 访问新接口同样 403 SESSION_REPLACED
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P41_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, login, cleanupAccounts, validSave, asText,
  openWs, waitMsg, closeWs, requireBackend,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P41');
const created = [];
let aborted = false;

/** 用内容表里的真实野怪区域：主题与等级区间完全由服务端 LOCATIONS 决定。 */
const AREA = 'wild_starter';
const WILD_QUERY = `/api/wild?areaId=${AREA}&theme=grass&levelMin=1&levelMax=5`;

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 带存档的账号（/api/battle/start 会读档取队伍）。 */
async function accountWithSave(prefix) {
  const acc = await mk(prefix);
  const r = await api('/api/save', {
    method: 'PUT', token: acc.token, body: { data: asText(validSave()), revision: 0 },
  });
  if (r.status !== 200) throw new Error(`基线存档失败 ${r.status}: ${JSON.stringify(r.data).slice(0, 200)}`);
  return { ...acc, revision: r.data.revision };
}

const listWild = (token) => api(WILD_QUERY, { token });

const startBattle = (token, wildId) => api('/api/battle/start', {
  method: 'POST', token,
  body: {
    theme: 'grass', areaName: '共享草地', areaId: AREA,
    levelMin: 1, levelMax: 5, ...(wildId ? { wildId } : {}),
  },
});

const abandon = (token, battleId) => api('/api/battle/abandon', {
  method: 'POST', token, body: { battleId },
});

const battleAction = (token, battleId, action) => api('/api/battle/action', {
  method: 'POST', token, body: { battleId, action },
});

async function main() {
  const h = await requireBackend();
  suite.check('后端就绪且 health 带 wild 统计', !!h && !!h.wild,
    JSON.stringify(h?.wild ?? null));

  // ═══════════════════ A. 接口边界 ═══════════════════
  console.log('\n—— A. 接口边界 ——');

  const anon = await api(WILD_QUERY);
  suite.check('未登录读野怪 → 401', anon.status === 401, `status=${anon.status}`);

  const accA = await accountWithSave('p41_a');
  const accB = await accountWithSave('p41_b');

  const first = await listWild(accA.token);
  suite.check('GET /api/wild → 200 且返回 3 只共享野怪',
    first.status === 200 && first.data?.ok === true && first.data?.monsters?.length === 3,
    `status=${first.status} n=${first.data?.monsters?.length}`);
  suite.check('列表字段完整且不含归属信息',
    first.data?.monsters?.every((m) => m.id && m.speciesId && m.name && m.status === 'available'
      && m.claim === undefined && m.userId === undefined && m.battleId === undefined),
    JSON.stringify(first.data?.monsters?.[0] ?? null));
  suite.check('区域真值由服务端给出（theme / 等级区间）',
    first.data?.theme === 'grass' && first.data?.levelMin === 1 && first.data?.levelMax === 5,
    JSON.stringify({ theme: first.data?.theme, min: first.data?.levelMin, max: first.data?.levelMax }));

  const spoof = await api(`/api/wild?areaId=${AREA}&theme=volcano&levelMin=50&levelMax=60`, { token: accA.token });
  const idsOf = (r) => (r?.monsters ?? []).map((m) => m.id).join(',');
  suite.check('客户端伪造主题/等级不能改共享野怪真值',
    spoof.status === 200 && spoof.data?.theme === 'grass' && spoof.data?.levelMax === 5
      && idsOf(spoof.data) === idsOf(first.data),
    JSON.stringify({ theme: spoof.data?.theme, max: spoof.data?.levelMax }));

  const unknownArea = await api('/api/wild?areaId=area_not_in_content&theme=volcano&levelMin=50&levelMax=60',
    { token: accA.token });
  suite.check('未知区域也固定用服务端默认（grass 1-5）',
    unknownArea.status === 200 && unknownArea.data?.theme === 'grass'
      && unknownArea.data?.levelMin === 1 && unknownArea.data?.levelMax === 5,
    JSON.stringify({ theme: unknownArea.data?.theme, min: unknownArea.data?.levelMin, max: unknownArea.data?.levelMax }));

  const fake = await startBattle(accA.token, 'w_not_exist_anywhere');
  suite.check('伪造 wildId → 404 WILD_NOT_FOUND',
    fake.status === 404 && fake.data?.code === 'WILD_NOT_FOUND',
    `status=${fake.status} code=${fake.data?.code}`);

  // ═══════════════════ B. 共享一致性 ═══════════════════
  console.log('\n—— B. 共享一致性 ——');
  const fromB = await listWild(accB.token);
  const idsA = (first.data?.monsters ?? []).map((m) => m.id).join(',');
  const idsB = (fromB.data?.monsters ?? []).map((m) => m.id).join(',');
  suite.check('两个不同账号看到完全相同的实例（同一份服务端真值）',
    fromB.status === 200 && idsA.length > 0 && idsA === idsB,
    `A=[${idsA}] B=[${idsB}]`);
  suite.check('两次读取 revision 一致（列表没变化不该推新版本）',
    first.data?.revision === fromB.data?.revision,
    `A=${first.data?.revision} B=${fromB.data?.revision}`);

  // ═══════════════════ C. 捕获互斥 ═══════════════════
  console.log('\n—— C. 捕获互斥 ——');
  const target = (await listWild(accA.token)).data?.monsters?.find((m) => m.status === 'available');
  suite.check('找到一只可挑战的野怪', !!target?.id, JSON.stringify(target ?? null));

  const [ra, rb] = await Promise.all([
    startBattle(accA.token, target?.id),
    startBattle(accB.token, target?.id),
  ]);
  const winner = ra.status === 200 ? ra : rb;
  const loser = ra.status === 200 ? rb : ra;
  suite.check('并发抢同一只：恰好一条成功',
    (ra.status === 200) !== (rb.status === 200),
    `A=${ra.status} B=${rb.status}`);
  suite.check('输的一条 → 409 WILD_CLAIMED（不是静默覆盖）',
    loser.status === 409 && loser.data?.code === 'WILD_CLAIMED',
    `status=${loser.status} code=${loser.data?.code}`);
  suite.check('赢家拿到的敌方就是这只野怪',
    winner.data?.battle?.enemy?.specId === target?.speciesId
      && winner.data?.battle?.enemy?.level === target?.level,
    JSON.stringify({ enemy: winner.data?.battle?.enemy?.specId, lvl: winner.data?.battle?.enemy?.level,
      want: target?.speciesId, wantLvl: target?.level }));
  suite.check('开局响应带回 wild 归属',
    winner.data?.wild?.id === target?.id,
    JSON.stringify(winner.data?.wild ?? null));

  const afterClaim = await listWild(accA.token);
  suite.check('列表里该野怪变为 claimed',
    afterClaim.data?.monsters?.find((m) => m.id === target?.id)?.status === 'claimed',
    JSON.stringify(afterClaim.data?.monsters?.find((m) => m.id === target?.id) ?? null));

  const winnerToken = ra.status === 200 ? accA.token : accB.token;
  await abandon(winnerToken, winner.data?.battle?.battleId);
  const afterRelease = await listWild(accA.token);
  suite.check('放弃战斗后野怪放回池子（available）',
    afterRelease.data?.monsters?.find((m) => m.id === target?.id)?.status === 'available',
    JSON.stringify(afterRelease.data?.monsters?.find((m) => m.id === target?.id) ?? null));

  // ═══════════════════ D. 跨账号广播 ═══════════════════
  console.log('\n—— D. 跨账号广播 ——');
  const wsB = await openWs({ token: accB.token });
  suite.check('账号 B 的 WS 建连成功', wsB.ok === true, `status=${wsB.status}`);

  const nextTarget = (await listWild(accA.token)).data?.monsters?.find((m) => m.status === 'available');
  const claimed = await startBattle(accA.token, nextTarget?.id);
  suite.check('账号 A 抢占另一只 → 200', claimed.status === 200, `status=${claimed.status}`);
  const pushClaimed = await waitMsg(
    wsB,
    (m) => m.type === 'wild.state' && m.areaId === AREA
      && m.monsters?.some((x) => x.id === nextTarget?.id && x.status === 'claimed'),
    4_000,
  );
  suite.check('账号 B（不同账号）收到 wild.state(claimed)',
    !!pushClaimed, JSON.stringify(pushClaimed && { revision: pushClaimed.revision }));

  await abandon(accA.token, claimed.data?.battle?.battleId);
  const pushReleased = await waitMsg(
    wsB,
    (m) => m.type === 'wild.state' && m.areaId === AREA
      && m.monsters?.some((x) => x.id === nextTarget?.id && x.status === 'available'),
    4_000,
  );
  suite.check('账号 B 收到 wild.state(available)（放弃后放回池子）',
    !!pushReleased, JSON.stringify(pushReleased && { revision: pushReleased.revision }));
  suite.check('广播 revision 单调递增',
    !!pushClaimed && !!pushReleased && pushReleased.revision > pushClaimed.revision,
    `claimed=${pushClaimed?.revision} released=${pushReleased?.revision}`);

  // ═══════════════════ E. 结算广播 ═══════════════════
  console.log('\n—— E. 结算广播 ——');
  const finalTarget = (await listWild(accA.token)).data?.monsters?.find((m) => m.status === 'available');
  const finalBattle = await startBattle(accA.token, finalTarget?.id);
  suite.check('结算用例开局成功', finalBattle.status === 200, `status=${finalBattle.status}`);
  let settled = false;
  for (let i = 0; i < 14 && !settled; i += 1) {
    const act = await battleAction(accA.token, finalBattle.data?.battle?.battleId, { type: 'flee' });
    settled = act.status === 200 && act.data?.settled === true;
  }
  suite.check('反复撤退直到战斗结算（服务端 RNG，允许多次）', settled, `settled=${settled}`);
  const pushResolved = await waitMsg(
    wsB,
    (m) => m.type === 'wild.state' && m.areaId === AREA
      && m.monsters?.some((x) => x.id === finalTarget?.id && x.status === 'resolved'),
    4_000,
  );
  suite.check('账号 B 看到该野怪 resolved（捕获/击败/逃走互斥生效）',
    !!pushResolved,
    JSON.stringify(pushResolved?.monsters?.find((x) => x.id === finalTarget?.id) ?? null));
  const resolvedView = pushResolved?.monsters?.find((x) => x.id === finalTarget?.id);
  suite.check('结算结果在公开视图里（captured / defeated / fled）',
    ['captured', 'defeated', 'fled'].includes(resolvedView?.result),
    `result=${resolvedView?.result}`);

  await closeWs(wsB);

  // ═══════════════════ F. 顶号 ═══════════════════
  console.log('\n—— F. 顶号 ——');
  const relogin = await login(accB.username, accB.password);
  const newToken = relogin.data?.token;
  suite.check('账号 B 二次登录成功且 token 变化',
    relogin.status === 200 && !!newToken && newToken !== accB.token,
    `status=${relogin.status}`);
  const oldRead = await listWild(accB.token);
  suite.check('旧 token 访问 /api/wild → 403 SESSION_REPLACED',
    oldRead.status === 403 && oldRead.data?.code === 'SESSION_REPLACED',
    `status=${oldRead.status} code=${oldRead.data?.code}`);
  const newRead = await listWild(newToken);
  suite.check('新 token 访问 /api/wild 正常', newRead.status === 200, `status=${newRead.status}`);

  const health = await api('/api/health');
  suite.check('health.wild 反映实例池状态',
    health.status === 200 && health.data?.wild?.active >= 3,
    JSON.stringify(health.data?.wild ?? null));
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
  if (aborted || !ok) process.exitCode = 1;
}
