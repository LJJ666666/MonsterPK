/**
 * F14 Boss 双档奖励端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:f14
 *
 * 分区：
 *  A 接口边界   未登录 401 / 无领取入口 / 伪上报奖励字段 400 / 讨伐清单只读
 *  B 首胜双档   打赢一场同时发大包 + 小包，写档 money/inventory，DB 两条流水
 *  C 每日首讨   第二场只发小包，first 唯一键不重复
 *  D 幂等与写档 同一 battleId 不双花 / 发奖后整包 PUT 不被权威摘要拒绝
 *  E 非获胜     逃跑不发奖励、不写流水、不写伤害事件
 *  F 跨 Boss    另一只 Boss 有独立的每日首讨大包
 *  G 回归       F01/F02 周期接口、P4-2c 次数与伤害榜仍正常
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_F14_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save, requireBackend,
  loadBackendEnv,
} from './lib/harness.mjs';

const suite = new Suite('E2E_F14');
const created = [];

const BOSS_MAIN = 'boss_ember_behemoth';   // 每日 3 次
const BOSS_RARE = 'boss_apex_dragon';      // 每日 1 次

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/**
 * 强档：Lv.40 / 高攻，保证几回合内打死 Boss（沿用 p42c 口径）。
 * HP 刻意给到 8000：战斗结算会把队伍 HP 写回存档，同一账号要连打两场验证
 * 「每日首讨唯一键」，若用 420 会因第一场掉血 + 烧伤导致第二场偶发全灭（概率红灯）。
 * 8000 远低于存档校验 STAT_MAX=100000，且不改任何产品逻辑，只是让用例确定性。
 */
function strongSave() {
  const base = validSave();
  return {
    ...base,
    money: 5000,
    inventory: { potion_small: 2 },
    party: base.party.map((m) => ({
      ...m, level: 40, maxHp: 8000, hp: 8000,
      atk: 320, def: 220, spAtk: 320, spDef: 220, spd: 240,
      moveIds: ['tackle', 'wood_strike'],
    })),
  };
}

async function accountWithSave(prefix, data) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, data);
  if (r.status !== 200) {
    throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  }
  return acc;
}

const bossList = (token) => api('/api/boss', { token });
const bossStart = (token, bossId) =>
  api('/api/boss/start', { method: 'POST', token, body: { bossId } });
const bossRank = (token, bossId, limit = 20) =>
  api(`/api/boss/${bossId}/rank?limit=${limit}`, { token });
const act = (token, battleId, action) =>
  api('/api/battle/action', { method: 'POST', token, body: { battleId, action } });

const ATTACK = { type: 'move', moveId: 'tackle' };

/** 一直打到战斗结束（最多 30 回合）。返回最后一次响应。 */
async function fightToEnd(token, battleId) {
  let last = null;
  for (let i = 0; i < 30; i += 1) {
    const r = await act(token, battleId, ATTACK);
    if (r.status !== 200) return { status: r.status, data: r.data, ended: false };
    last = r;
    if (r.data?.battle?.finished) return { status: 200, data: r.data, ended: true };
  }
  return { status: last?.status ?? 0, data: last?.data, ended: false };
}

/** 逃跑直到成功（速度优势下概率高，最多 10 次）。 */
async function fleeUntilDone(token, battleId) {
  for (let i = 0; i < 10; i += 1) {
    const r = await act(token, battleId, { type: 'flee' });
    if (r.status !== 200) return { status: r.status, data: r.data, ended: false };
    if (r.data?.battle?.finished) return { status: 200, data: r.data, ended: true };
  }
  return { status: 0, data: null, ended: false };
}

function saveDataOf(res) {
  const raw = res?.data?.data ?? res?.data?.save;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

const moneyOf = (res) => saveDataOf(res)?.money ?? null;
const invOf = (res) => saveDataOf(res)?.inventory ?? null;

const rewardItemsOf = (view) =>
  Object.fromEntries((view?.items ?? []).map((x) => [x.itemId, x.count]));

async function db() {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}

async function userIdOf(prisma, username) {
  const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return u?.id ?? null;
}

async function grantsOf(prisma, userId) {
  return prisma.bossRewardGrant.findMany({ where: { userId }, orderBy: { id: 'asc' } });
}

async function main() {
  await requireBackend();
  const { cleanupByPrefix } = await import('./lib/harness.mjs');
  await cleanupByPrefix(['f14_']);
  const prisma = await db();

  // ═══════════════════ A. 接口边界 ═══════════════════
  suite.check('未登录读讨伐清单 → 401', (await bossList(null)).status === 401);
  suite.check('未登录开局 → 401', (await bossStart(null, BOSS_MAIN)).status === 401);
  suite.check('无领取入口 POST /api/boss/rewards → 404',
    (await api('/api/boss/rewards', { method: 'POST', body: {} })).status === 404);
  suite.check('无领取入口 POST /api/boss/claim → 404',
    (await api('/api/boss/claim', { method: 'POST', body: {} })).status === 404);

  const forgedAnon = await api('/api/boss/start', {
    method: 'POST', body: { bossId: BOSS_MAIN, reward: 999999 },
  });
  suite.check('未登录伪上报 reward → 401（鉴权先于字段校验）',
    forgedAnon.status === 401, `${forgedAnon.status}`);

  const viewer = await mk('f14v');
  const overview = await bossList(viewer.token);
  suite.check('讨伐清单只读，三只 Boss 且不下发 HP 倍率',
    overview.status === 200 && overview.data?.readonly === true
    && Array.isArray(overview.data?.bosses) && overview.data.bosses.length === 3
    && !('hpMultiplier' in (overview.data.bosses[0] ?? {})),
    `${overview.status} n=${overview.data?.bosses?.length}`);

  for (const field of ['reward', 'rewards', 'money', 'items', 'grantKey', 'tier']) {
    const forged = await api('/api/boss/start', {
      method: 'POST', token: viewer.token,
      body: { bossId: BOSS_MAIN, [field]: 999999 },
    });
    suite.check(`开局伪上报 ${field} → 400 BOSS_INPUT_FORBIDDEN`,
      forged.status === 400 && forged.data?.code === 'BOSS_INPUT_FORBIDDEN'
      && (forged.data?.fields ?? []).includes(field),
      `${forged.status} ${JSON.stringify(forged.data).slice(0, 150)}`);
  }

  // ═══════════════════ B. 首胜双档 ═══════════════════
  const hero = await accountWithSave('f14h', strongSave());
  const heroId = await userIdOf(prisma, hero.username);
  suite.check('建档成功：money=5000 / potion_small=2',
    moneyOf(await save.get(hero.token)) === 5000
    && invOf(await save.get(hero.token))?.potion_small === 2);

  const first = await bossStart(hero.token, BOSS_MAIN);
  suite.check('首场开局 200 且每日上限 3',
    first.status === 200 && first.data?.ok === true
    && first.data?.quota?.limit === 3,
    `${first.status} ${JSON.stringify(first.data?.quota ?? null)}`);
  const b1 = first.data?.battle?.battleId;
  const win1 = await fightToEnd(hero.token, b1);
  suite.check('首场打赢（finished + enemy_fainted）',
    win1.ended && win1.data?.battle?.result === 'enemy_fainted',
    `${win1.status} ${win1.data?.battle?.result} ${JSON.stringify(win1.data).slice(0, 200)}`);

  const rw1 = win1.data?.boss?.reward;
  // boss.reward = BossRewardResult；实际发放明细在 .reward 里（含 perRun/first 状态便于排查）。
  suite.check('回包含双档奖励（非 null）', !!rw1?.reward, JSON.stringify(rw1 ?? null));
  suite.check('首胜实发 money = 100 大包 + 20 小包 = 120',
    rw1?.reward?.money === 120, JSON.stringify(rw1 ?? null));
  const items1 = rewardItemsOf(rw1?.reward);
  suite.check('首胜实发道具 = capsule_prism×1 + potion_small×1',
    items1.capsule_prism === 1 && items1.potion_small === 1,
    JSON.stringify(items1));
  suite.check('写档 money = 5120', moneyOf(await save.get(hero.token)) === 5120,
    `${moneyOf(await save.get(hero.token))}`);
  const inv1 = invOf(await save.get(hero.token));
  suite.check('写档 inventory：potion_small=3 / capsule_prism=1',
    inv1?.potion_small === 3 && inv1?.capsule_prism === 1, JSON.stringify(inv1));

  const g1 = await grantsOf(prisma, heroId);
  suite.check('DB 落两条流水（per_run + first）',
    g1.length === 2 && g1.some((x) => x.tier === 'per_run') && g1.some((x) => x.tier === 'first'),
    JSON.stringify(g1.map((x) => x.tier)));
  suite.check('流水 grantKey 前缀正确且 revision 已回填',
    g1.every((x) => x.revision > 0)
    && g1.find((x) => x.tier === 'per_run')?.grantKey?.startsWith('boss:run:') === true
    && g1.find((x) => x.tier === 'first')?.grantKey?.startsWith('boss:first:') === true,
    JSON.stringify(g1.map((x) => ({ tier: x.tier, key: x.grantKey, rev: x.revision }))));
  suite.check('每场小包流水绑定本场 battleId',
    g1.find((x) => x.tier === 'per_run')?.battleId === b1);

  // ═══════════════════ C. 第二场只发小包 ═══════════════════
  const second = await bossStart(hero.token, BOSS_MAIN);
  suite.check('第二场开局 200（次数口径未被发奖影响）',
    second.status === 200 && second.data?.quota?.used === 1,
    `${second.status} ${JSON.stringify(second.data?.quota ?? null)}`);
  const b2 = second.data?.battle?.battleId;
  const win2 = await fightToEnd(hero.token, b2);
  const rw2 = win2.data?.boss?.reward;
  suite.check('第二场打赢', win2.ended && win2.data?.battle?.result === 'enemy_fainted',
    `${win2.status} ${win2.data?.battle?.result} ${JSON.stringify(win2.data).slice(0, 200)}`);
  suite.check('第二场实发 money = 20（无每日首讨大包）',
    rw2?.reward?.money === 20, JSON.stringify(rw2 ?? null));
  const items2 = rewardItemsOf(rw2?.reward);
  suite.check('第二场实发道具只有 potion_small×1',
    items2.potion_small === 1 && !items2.capsule_prism, JSON.stringify(items2));
  suite.check('写档 money = 5140', moneyOf(await save.get(hero.token)) === 5140,
    `${moneyOf(await save.get(hero.token))}`);

  const g2 = await grantsOf(prisma, heroId);
  suite.check('DB 共 3 条流水（2 per_run + 1 first），首讨大包不重复',
    g2.length === 3 && g2.filter((x) => x.tier === 'per_run').length === 2
    && g2.filter((x) => x.tier === 'first').length === 1,
    JSON.stringify(g2.map((x) => x.tier)));

  // ═══════════════════ D. 幂等与写档回归 ═══════════════════
  suite.check('同一 battleId 的 per_run 流水唯一（无双花）',
    g2.filter((x) => x.grantKey === `boss:run:${b1}`).length === 1
    && g2.filter((x) => x.grantKey === `boss:run:${b2}`).length === 1);
  const replay = await act(hero.token, b1, ATTACK);
  suite.check('对已结束战斗再发意图 → 非 200（战斗会话已丢弃）',
    replay.status !== 200, `${replay.status}`);
  suite.check('重放后 money 不变 = 5140', moneyOf(await save.get(hero.token)) === 5140);

  const cur = await save.get(hero.token);
  const curData = saveDataOf(cur);
  save.setRevision(hero.token, cur.data?.revision ?? 0);
  const put = await save.put(hero.token, curData);
  suite.check('发奖后整包 PUT 不被 authority.expected 拒绝 → 200',
    put.status === 200, `${put.status} ${JSON.stringify(put.data).slice(0, 180)}`);

  // ═══════════════════ E. 非获胜不发 ═══════════════════
  const runner = await accountWithSave('f14r', strongSave());
  const runnerId = await userIdOf(prisma, runner.username);
  const fleeStart = await bossStart(runner.token, BOSS_MAIN);
  const fled = await fleeUntilDone(runner.token, fleeStart.data?.battle?.battleId);
  suite.check('逃跑成功', fled.ended, `${fled.status}`);
  suite.check('逃跑回包 reward === null（不发任何奖励）',
    fled.data?.boss?.reward === null, JSON.stringify(fled.data?.boss?.reward ?? 'MISSING'));
  suite.check('逃跑账号 money 不变 = 5000', moneyOf(await save.get(runner.token)) === 5000,
    `${moneyOf(await save.get(runner.token))}`);
  const runnerGrants = await grantsOf(prisma, runnerId);
  const runnerEvents = await prisma.bossDamageEvent.count({ where: { userId: runnerId } });
  suite.check('逃跑账号无奖励流水、无伤害事件（P4-2c 口径不回归）',
    runnerGrants.length === 0 && runnerEvents === 0,
    `grants=${runnerGrants.length} events=${runnerEvents}`);

  // ═══════════════════ F. 全灭不发 + 另一只 Boss 独立次数 ═══════════════════
  // 跨 Boss 首讨键的 bossId 隔离由 playReward.test.ts 纯函数单测钉住；
  // 这里用弱档必然全灭，稳定覆盖「只有打赢才发」的第三个分支（逃跑 / 全灭都不发）。
  const weak = await accountWithSave('f14w', validSave());
  const weakId = await userIdOf(prisma, weak.username);
  const weakStart = await bossStart(weak.token, BOSS_RARE);
  suite.check('另一只 Boss 开局 200（独立每日次数 1）',
    weakStart.status === 200 && weakStart.data?.quota?.limit === 1,
    `${weakStart.status} ${JSON.stringify(weakStart.data?.quota ?? null)}`);
  const lose = await fightToEnd(weak.token, weakStart.data?.battle?.battleId);
  suite.check('弱档挑战高难 Boss 全灭（player_fainted）',
    lose.ended && lose.data?.battle?.result === 'player_fainted',
    `${lose.status} ${lose.data?.battle?.result} ${JSON.stringify(lose.data).slice(0, 200)}`);
  const loseRw = lose.data?.boss?.reward;
  suite.check('全灭不发奖励（eligible=false / 明细 null）',
    loseRw?.eligible === false && loseRw?.reward === null,
    JSON.stringify(loseRw ?? null));
  suite.check('全灭账号 money 不变且无奖励流水',
    moneyOf(await save.get(weak.token)) === 1200
    && (await grantsOf(prisma, weakId)).length === 0,
    `${moneyOf(await save.get(weak.token))}`);
  suite.check('全灭仍写伤害事件（P4-2c 口径），但奖励流水为 0',
    (await prisma.bossDamageEvent.count({ where: { userId: weakId } })) === 1);

  // ═══════════════════ G. 回归 ═══════════════════
  suite.check('F01/F02 周期接口仍 200（无回归）',
    (await api('/api/rank/periods', { token: hero.token })).status === 200);
  const overview2 = await bossList(hero.token);
  const mainView = (overview2.data?.bosses ?? []).find((x) => x.bossId === BOSS_MAIN);
  suite.check('P4-2c 次数真值仍为 2 场（发奖不影响次数口径）',
    overview2.status === 200 && mainView?.used === 2 && mainView?.remaining === 1,
    JSON.stringify(mainView ?? null));
  suite.check('P4-2c 伤害榜仍只读可查',
    (await bossRank(hero.token, BOSS_MAIN)).status === 200);

  // ═══════════════════ 清理 ═══════════════════
  for (const username of created) {
    const uid = await userIdOf(prisma, username);
    if (uid) await prisma.bossRewardGrant.deleteMany({ where: { userId: uid } });
  }
  await prisma.$disconnect();
  await cleanupAccounts(created);
  suite.check('测试账号与奖励流水已清理', true);
  suite.done();
}

main().catch((e) => {
  console.error('E2E_F14_ABORT', e);
  process.exitCode = 1;
});
