/**
 * F01 榜单周期结算 + F02 榜单奖励端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:f01f02
 *
 * 分区：
 *  A 接口边界   未登录 401 / 只读清单 / 无领取入口 / 伪上报 400 / 普通账号 403
 *  B 结算门禁   进行中周期禁结算、非法周期键、管理员才有权
 *  C 结算与发奖 七榜快照、服务端写档增 money、我的奖励记录、历史榜只读
 *  D 幂等与风控 重跑不重复发奖 / 不覆盖快照、管理员与封号不上榜
 *
 * 用固定的远古周期键 '2020-01-01' 做结算目标：既不污染「昨天」的真实快照，
 * 也让重复运行可以从干净基线开始（开头先删该周期的快照与奖励记录）。
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_F01F02_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, setRole, cleanupAccounts, validSave, save,
  requireBackend, loadBackendEnv,
} from './lib/harness.mjs';

const suite = new Suite('E2E_F01F02');
const created = [];
/** 固定远古周期：已结束、不会与真实结算撞车、便于重复运行。 */
const TEST_PERIOD = '2020-01-01';

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 三档数值拉开，确保稳居四榜前 10（数值仍在既有存档校验允许范围）。 */
function rankedSave(maxHp, level, cleared = 0) {
  const base = validSave();
  const party = base.party.map((m, i) => ({ ...m, maxHp, hp: maxHp, level, id: `p${i + 1}` }));
  const clearedAreas = {};
  for (let i = 0; i < cleared; i++) {
    clearedAreas[`area_${i}`] = {
      name: `区域${i}`, level: 5 + i, theme: 'grass',
      clearedAt: new Date(Date.now() - 60_000).toISOString(),
    };
  }
  return { ...base, party, box: [], clearedAreas };
}

async function db() {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

/** 只清理本套件使用的远古周期，绝不碰真实结算数据。 */
async function resetPeriod(prisma) {
  await prisma.rankReward.deleteMany({ where: { periodKey: TEST_PERIOD } });
  await prisma.rankPeriodSnapshot.deleteMany({ where: { periodKey: TEST_PERIOD } });
}

/** 读回存档里的 money（兼容字符串与对象两种返回形状）。 */
function moneyOf(res) {
  const raw = res?.data?.data ?? res?.data?.save;
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return typeof obj?.money === 'number' ? obj.money : null;
  } catch { return null; }
}

const settle = (token, body) =>
  api('/api/rank/admin/settle', { method: 'POST', token, body });

async function main() {
  await requireBackend();
  const prisma = await db();
  // 先清本周期残留，再从干净基线开始；同时清掉历史测试账号，避免它们占满榜单前 10。
  await resetPeriod(prisma);
  await prisma.$disconnect();
  const { cleanupByPrefix } = await import('./lib/harness.mjs');
  await cleanupByPrefix(['e2e_', 'ui_', 'harden_', 'hd_', 'edge_', 'bt_', 'p12_', 'ws_',
    'b3a_', 'b3b_', 'ss_', 'p41_', 'p42a_', 'p42b_', 'p42c_', 'p42d_', 'p42e_', 'f01_', 'f02_']);

  // ═══════════════════ A. 接口边界 ═══════════════════
  suite.check('未登录读周期清单 → 401', (await api('/api/rank/periods')).status === 401);
  suite.check('未登录读历史榜 → 401',
    (await api(`/api/rank/periods/${TEST_PERIOD}`)).status === 401);
  suite.check('未登录读奖励记录 → 401', (await api('/api/rank/rewards')).status === 401);
  suite.check('未登录触发结算 → 401',
    (await settle(undefined, { periodKey: TEST_PERIOD })).status === 401);

  const viewer = await mk('f01v');
  const list = await api('/api/rank/periods', { token: viewer.token });
  suite.check('周期清单只读，含当前 / 上一周期键与七张榜',
    list.status === 200 && list.data?.readonly === true && list.data?.granularity === 'day'
    && /^\d{4}-\d{2}-\d{2}$/.test(list.data?.currentPeriodKey ?? '')
    && /^\d{4}-\d{2}-\d{2}$/.test(list.data?.previousPeriodKey ?? '')
    && list.data?.boards?.length === 7 && list.data?.rewardMaxRank === 10,
    `${list.status} ${JSON.stringify(list.data).slice(0, 200)}`);
  suite.check('奖励档位由服务端下发且第 1 名 > 第 4 名',
    (list.data?.boards?.[0]?.rewardTiers?.[0]?.reward?.money ?? 0)
    > (list.data?.boards?.[0]?.rewardTiers?.[3]?.reward?.money ?? 0));

  const noClaim = await api('/api/rank/rewards/claim', { method: 'POST', token: viewer.token, body: {} });
  suite.check('不存在「领取奖励」写接口 → 404', noClaim.status === 404, `status=${noClaim.status}`);
  const noSettleRead = await api('/api/rank/periods', { method: 'POST', token: viewer.token, body: {} });
  suite.check('周期清单不接受 POST → 404', noSettleRead.status === 404, `status=${noSettleRead.status}`);

  const forgedList = await api('/api/rank/periods?rank=1', { token: viewer.token });
  suite.check('周期清单上报 rank → 400 RANK_INPUT_FORBIDDEN',
    forgedList.status === 400 && forgedList.data?.code === 'RANK_INPUT_FORBIDDEN');
  const forgedRewards = await api('/api/rank/rewards?claim=1', { token: viewer.token });
  suite.check('奖励记录上报 claim → 400 RANK_INPUT_FORBIDDEN',
    forgedRewards.status === 400 && forgedRewards.data?.code === 'RANK_INPUT_FORBIDDEN');
  const notSettled = await api(`/api/rank/periods/${TEST_PERIOD}`, { token: viewer.token });
  suite.check('未结算周期读历史榜 → 404 RANK_PERIOD_NOT_SETTLED',
    notSettled.status === 404 && notSettled.data?.code === 'RANK_PERIOD_NOT_SETTLED');

  // ═══════════════════ B. 结算门禁 ═══════════════════
  const playerSettle = await settle(viewer.token, { periodKey: TEST_PERIOD });
  suite.check('普通账号触发结算 → 403 RANK_SETTLE_FORBIDDEN',
    playerSettle.status === 403 && playerSettle.data?.code === 'RANK_SETTLE_FORBIDDEN',
    `${playerSettle.status} ${JSON.stringify(playerSettle.data).slice(0, 140)}`);

  const admin = await mk('f01a');
  await setRole(admin.username, 'admin');
  const openPeriod = await settle(admin.token, { periodKey: list.data.currentPeriodKey });
  suite.check('进行中的周期禁止提前结算 → 400 RANK_PERIOD_OPEN',
    openPeriod.status === 400 && openPeriod.data?.code === 'RANK_PERIOD_OPEN',
    `${openPeriod.status} ${JSON.stringify(openPeriod.data).slice(0, 140)}`);
  const badKey = await settle(admin.token, { periodKey: '2020-02-30' });
  suite.check('非法周期键 → 400 RANK_PERIOD_INVALID',
    badKey.status === 400 && badKey.data?.code === 'RANK_PERIOD_INVALID');
  const forgedSettle = await settle(admin.token, { periodKey: TEST_PERIOD, money: 999999 });
  suite.check('结算请求上报 money → 400 RANK_INPUT_FORBIDDEN',
    forgedSettle.status === 400 && forgedSettle.data?.code === 'RANK_INPUT_FORBIDDEN');

  // ═══════════════════ C. 结算与发奖 ═══════════════════
  const high = await mk('f01h');
  const mid = await mk('f01m');
  const low = await mk('f01l');
  const putHigh = await save.put(high.token, rankedSave(6000, 12, 2));
  const putMid = await save.put(mid.token, rankedSave(3000, 9, 1));
  const putLow = await save.put(low.token, rankedSave(1000, 5, 0));
  suite.check('三个参榜账号建档成功',
    [putHigh, putMid, putLow].every((r) => r.status === 200),
    [putHigh.status, putMid.status, putLow.status].join(','));

  const beforeHigh = moneyOf(await save.get(high.token));
  const result = await settle(admin.token, { periodKey: TEST_PERIOD });
  suite.check('管理员结算已结束周期 → 200，七张榜全部产出快照',
    result.status === 200 && result.data?.ok === true && result.data?.boards === 7
    && result.data?.snapshotsCreated === 7,
    `${result.status} ${JSON.stringify(result.data).slice(0, 220)}`);
  suite.check('结算产生了实际发奖且无失败',
    result.data?.rewardsGranted > 0 && result.data?.rewardsFailed === 0,
    JSON.stringify({ g: result.data?.rewardsGranted, f: result.data?.rewardsFailed }));

  const myRewards = await api('/api/rank/rewards', { token: high.token });
  const rows = myRewards.data?.entries ?? [];
  suite.check('我的奖励记录只读且只含本周期结算结果',
    myRewards.status === 200 && myRewards.data?.readonly === true
    && rows.length > 0 && rows.every((r) => r.periodKey === TEST_PERIOD && r.rank >= 1),
    `${myRewards.status} ${JSON.stringify(rows).slice(0, 200)}`);
  const rewardMoney = rows.reduce((n, r) => n + (r.reward?.money ?? 0), 0);
  const afterHigh = moneyOf(await save.get(high.token));
  suite.check('发奖由服务端写档：money 增量 == 奖励记录金额之和',
    beforeHigh !== null && afterHigh !== null && afterHigh - beforeHigh === rewardMoney
    && rewardMoney > 0,
    JSON.stringify({ beforeHigh, afterHigh, rewardMoney }));
  suite.check('发奖记录带服务端 revision（经 commitState）',
    rows.every((r) => Number.isInteger(r.revision) && r.revision > 0));

  const hist = await api(`/api/rank/periods/${TEST_PERIOD}`, { token: high.token });
  suite.check('历史榜返回七张榜且标记只读',
    hist.status === 200 && hist.data?.readonly === true && hist.data?.boards?.length === 7,
    `${hist.status} boards=${hist.data?.boards?.length}`);
  const rankBoard = hist.data?.boards?.find((b) => b.boardKey === 'rank:team_power');
  suite.check('历史榜行不含 userId，且按请求者重标 isMe',
    !!rankBoard && rankBoard.entries.length > 0
    && rankBoard.entries.every((e) => !('userId' in e))
    && rankBoard.entries.some((e) => e.username === high.username && e.isMe === true),
    JSON.stringify(rankBoard?.entries?.slice(0, 2) ?? null));
  const forgedHist = await api(`/api/rank/periods/${TEST_PERIOD}?score=99999`, { token: high.token });
  suite.check('历史榜上报 score → 400 RANK_INPUT_FORBIDDEN',
    forgedHist.status === 400 && forgedHist.data?.code === 'RANK_INPUT_FORBIDDEN');

  const listAfter = await api('/api/rank/periods', { token: viewer.token });
  suite.check('已结算周期清单包含本次周期',
    (listAfter.data?.periods ?? []).some((p) => p.periodKey === TEST_PERIOD));

  // ═══════════════════ D. 幂等与风控 ═══════════════════
  const again = await settle(admin.token, { periodKey: TEST_PERIOD });
  suite.check('重跑结算：不新建快照、不重复发奖',
    again.status === 200 && again.data?.snapshotsCreated === 0
    && again.data?.rewardsGranted === 0 && again.data?.rewardsSkipped > 0
    && again.data?.rewardsFailed === 0,
    JSON.stringify(again.data).slice(0, 220));
  const afterAgain = moneyOf(await save.get(high.token));
  suite.check('重跑后存档 money 不变（无双花）',
    afterAgain === afterHigh, `${afterHigh} -> ${afterAgain}`);
  const histAgain = await api(`/api/rank/periods/${TEST_PERIOD}`, { token: high.token });
  suite.check('重跑不覆盖首次快照',
    JSON.stringify(histAgain.data?.boards) === JSON.stringify(hist.data?.boards));

  const adminBoard = await api('/api/rank/team_power?limit=50', { token: viewer.token });
  suite.check('管理员测试档不进入全服榜（不污染结算）',
    !(adminBoard.data?.entries ?? []).some((e) => e.username === admin.username));

  const banned = await mk('f01b');
  await save.put(banned.token, rankedSave(9000, 20, 3));
  const p3 = await db();
  await p3.user.update({
    where: { username: banned.username },
    data: { bannedAt: new Date(), banReason: 'F01/F02 E2E 排除验证' },
  });
  await p3.$disconnect();
  const bannedBoard = await api('/api/rank/team_power?limit=50', { token: viewer.token });
  suite.check('封号账号不进入全服榜',
    !(bannedBoard.data?.entries ?? []).some((e) => e.username === banned.username));

  // ═══════════════════ 清理 ═══════════════════
  await setRole(admin.username, 'player');
  const p2 = await db();
  await resetPeriod(p2);
  await p2.$disconnect();
  await cleanupAccounts(created);
  suite.check('测试账号与本周期结算数据已清理', true);
  suite.done();
}

main().catch((e) => {
  console.error('E2E_F01F02_ABORT', e);
  process.exitCode = 1;
});
