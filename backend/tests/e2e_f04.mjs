/**
 * F04 召唤师等级 / 徽章 / 成就 端到端验收（规范 §31）。
 *
 * A 区（F04-2）：只读进度投影、伪上报 400、Grant 表幂等、脏 id 不虚增等级、成就加成展示。
 * B 区（F04-3）：存档伪字段闸门 / 榜单读 Grant 真值 / 战斗帽由服务端注入 / 首通发徽章。
 *
 * 只走 HTTP + DB 真值：客户端没有发徽章 / 领成就 / 上报等级的接口，
 * 测试里直接写 Grant 表等价于「服务端唯一写入口刚执行完」，再验证只读投影。
 */
import {
  Suite, api, newAccount, cleanupAccounts, health, loadBackendEnv,
  validSave, save,
} from './lib/harness.mjs';

loadBackendEnv();
const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const suite = new Suite('E2E_F04');
const accounts = [];

async function userIdOf(username) {
  const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  return u?.id ?? '';
}
async function grantBadge(userId, badgeId, source = 'e2e') {
  try {
    await prisma.badgeGrant.create({ data: { userId, badgeId, source } });
    return 'created';
  } catch (e) {
    return e?.code === 'P2002' ? 'duplicate' : `error:${e?.code ?? '?'}`;
  }
}
/** 开一场常规战斗并用 tackle 打到结束；客户端故意传 levelCap=999 验证服务端不采信。 */
async function winBattle(token, areaId) {
  const st = await api('/api/battle/start', {
    method: 'POST', token,
    body: {
      theme: 'grass', areaName: '初心草原', areaId,
      levelMin: 2, levelMax: 2, levelCap: 999,
    },
  });
  const bid = st.data?.battle?.battleId;
  let last = st.data;
  if (bid) {
    for (let i = 0; i < 24 && !last?.battle?.finished; i += 1) {
      const r = await api('/api/battle/action', {
        method: 'POST', token,
        body: { battleId: bid, action: { type: 'move', moveId: 'tackle' } },
      });
      if (r.status !== 200) break;
      last = r.data ?? last;
    }
  }
  return { start: st, last, bid };
}

async function grantAchievement(userId, achievementId) {
  try {
    await prisma.achievementGrant.create({ data: { userId, achievementId, source: 'e2e' } });
    return 'created';
  } catch (e) {
    return e?.code === 'P2002' ? 'duplicate' : `error:${e?.code ?? '?'}`;
  }
}

try {
  const h = await health();
  suite.check('health 暴露只读 progress 来源',
    h.status === 200 && h.data?.progress?.readonly === true
    && h.data.progress.source === 'server_grants'
    && h.data.progress.badgeCount === 7,
    JSON.stringify(h.data?.progress));

  const acc = await newAccount('f04');
  accounts.push(acc.username);
  const uid = await userIdOf(acc.username);
  suite.check('测试账号已落库', !!uid, `uid=${uid}`);

  const anon = await api('/api/player/progress');
  suite.check('未登录读取进度 → 401', anon.status === 401, `status=${anon.status}`);

  const p0 = await api('/api/player/progress', { token: acc.token });
  const v0 = p0.data?.progress;
  suite.check('无 Grant 记录 → Lv.5 / 帽 5 / 0 徽章 / 0 成就 / readonly',
    p0.status === 200 && p0.data?.ok === true && p0.data?.readonly === true
    && v0?.level === 5 && v0?.cap === 5 && v0?.baseLevel === 5
    && v0?.badgeBonus === 0 && v0?.badgeCount === 0
    && Array.isArray(v0?.badges) && v0.badges.length === 0
    && Array.isArray(v0?.achievements) && v0.achievements.length === 0
    && v0?.readonly === true,
    JSON.stringify(v0).slice(0, 260));

  suite.check('catalog 下发 7 行且未获得标 false（弹窗灰态真值）',
    Array.isArray(p0.data?.catalog) && p0.data.catalog.length === 7
    && p0.data.catalog.every((b) => b.owned === false && b.levelBonus === 5)
    && p0.data.catalog[4].name === '赤焰徽章',
    JSON.stringify(p0.data?.catalog).slice(0, 220));

  const f1 = await api('/api/player/progress?playerLevel=999', { token: acc.token });
  suite.check('伪上报 playerLevel → 400 PROGRESS_INPUT_FORBIDDEN',
    f1.status === 400 && f1.data?.code === 'PROGRESS_INPUT_FORBIDDEN'
    && f1.data?.field === 'playerLevel',
    `status=${f1.status} ${JSON.stringify(f1.data)}`);
  const f2 = await api('/api/player/progress?badges=badge_flame', { token: acc.token });
  suite.check('伪上报 badges → 400（同一个只读闸门）',
    f2.status === 400 && f2.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `status=${f2.status}`);
  const f3 = await api('/api/player/progress?cap=9999', { token: acc.token });
  suite.check('伪上报 cap → 400', f3.status === 400, `status=${f3.status}`);

  const g1 = await grantBadge(uid, 'badge_flame');
  const p1 = await api('/api/player/progress', { token: acc.token });
  const v1 = p1.data?.progress;
  suite.check('发 1 枚赤焰徽章 → Lv.10 / 帽 10 / 总加成 +5',
    g1 === 'created' && v1?.level === 10 && v1.cap === 10
    && v1.badgeBonus === 5 && v1.badgeCount === 1
    && v1.badges?.[0]?.name === '赤焰徽章' && v1.badges[0].levelBonus === 5,
    `g=${g1} ${JSON.stringify(v1).slice(0, 240)}`);

  const g2 = await grantBadge(uid, 'badge_flame');
  const p2 = await api('/api/player/progress', { token: acc.token });
  suite.check('同一徽章重复发放被唯一键挡下，等级不双涨',
    g2 === 'duplicate' && p2.data?.progress?.level === 10
    && p2.data.progress.badgeCount === 1,
    `g=${g2} level=${p2.data?.progress?.level}`);

  await grantBadge(uid, 'badge_sprout');
  const p3 = await api('/api/player/progress', { token: acc.token });
  suite.check('第二枚徽章 → Lv.15 / 总加成 +10 / 7 行清单可展示',
    p3.data?.progress?.level === 15 && p3.data.progress.cap === 15
    && p3.data.progress.badgeBonus === 10 && p3.data.progress.badgeCount === 2,
    JSON.stringify(p3.data?.progress).slice(0, 220));

  await grantBadge(uid, 'badge_fake');
  const p4 = await api('/api/player/progress', { token: acc.token });
  suite.check('脏 badgeId 落库也不虚增等级（派生层过滤）',
    p4.data?.progress?.level === 15 && p4.data.progress.badgeCount === 2
    && p4.data.progress.badgeBonus === 10,
    `level=${p4.data?.progress?.level}`);

  await grantAchievement(uid, 'ach_veteran');
  await grantAchievement(uid, 'ach_flame_runner');
  const a2 = await grantAchievement(uid, 'ach_veteran');
  const p5 = await api('/api/player/progress', { token: acc.token });
  const v5 = p5.data?.progress;
  suite.check('成就幂等 + 双 Tab 数据：全体物攻 +5 / 火属性速度 +1',
    a2 === 'duplicate' && v5?.achievements?.length === 2
    && v5.achievements[0].bonusText?.[0] === '全体物攻 +5'
    && v5.achievements[1].bonusText?.[0] === '火属性速度 +1'
    && v5.bonuses?.length === 2,
    JSON.stringify(v5?.achievements).slice(0, 260));

  await grantAchievement(uid, 'ach_first_catch');
  const p6 = await api('/api/player/progress', { token: acc.token });
  suite.check('同维度成就加成合并（物攻 5+1 = 6）',
    p6.data?.progress?.bonuses?.some((b) => b.stat === 'atk' && b.amount === 6) === true,
    JSON.stringify(p6.data?.progress?.bonuses));

  suite.check('进度不含客户端可写字段（无 exp / 无领取入口）',
    !('playerExp' in (v5 ?? {})) && !('claim' in (v5 ?? {}))
    && v5?.readonly === true,
    Object.keys(v5 ?? {}).join(','));

  // ═════════════ B. F04-3：伪字段 / 榜单真值 / 等级帽 / 首通徽章 ═════════════
  const putOk = await save.put(acc.token, validSave());
  suite.check('先建一份合法存档（榜单与战斗都基于服务端落库真值）',
    putOk.status === 200, `status=${putOk.status} ${JSON.stringify(putOk.data).slice(0, 140)}`);

  for (const [field, payload] of [
    ['playerLevel', { playerLevel: 999 }],
    ['badges', { badges: ['badge_flame'] }],
    ['achievements', { achievements: ['ach_veteran'] }],
    ['levelCap', { levelCap: 999 }],
  ]) {
    const forged = await save.put(acc.token, { ...validSave(), ...payload });
    suite.check(`整包 PUT 夹带 ${field} → 400 SAVE_INPUT_FORBIDDEN`,
      forged.status === 400 && forged.data?.code === 'SAVE_INPUT_FORBIDDEN'
      && forged.data?.field === field,
      `${forged.status} ${JSON.stringify(forged.data).slice(0, 140)}`);
  }
  const pAfterForge = await api('/api/player/progress', { token: acc.token });
  suite.check('伪上报被拒后等级仍是服务端真值 Lv.15',
    pAfterForge.data?.progress?.level === 15,
    `level=${pAfterForge.data?.progress?.level}`);

  const rk = await api('/api/rank/summoner_level?limit=50', { token: acc.token });
  const myRow = (rk.data?.entries ?? []).find((e) => e.username === acc.username);
  suite.check('召唤师等级榜读 Grant 真值 Lv.15（2 枚徽章 × +5，脏 id 不计）',
    rk.status === 200 && myRow?.value === 15,
    `${rk.status} ${JSON.stringify(myRow ?? null).slice(0, 180)}`);

  const battleRun = await winBattle(acc.token, 'wild_starter');
  suite.check('常规战斗开局下发服务端等级帽 15，客户端传 levelCap=999 无效',
    battleRun.start.status === 200 && battleRun.start.data?.battle?.levelCap === 15,
    `${battleRun.start.status} cap=${battleRun.start.data?.battle?.levelCap}`);
  suite.check('战斗正常打到结束（enemy_fainted）',
    battleRun.last?.battle?.finished === true
    && battleRun.last?.battle?.result === 'enemy_fainted',
    `finished=${battleRun.last?.battle?.finished} result=${battleRun.last?.battle?.result}`);

  // 第二个账号：无任何 Grant，验证「首通野区 → 服务端幂等发对应徽章」闭环。
  const acc2 = await newAccount('f04b');
  accounts.push(acc2.username);
  const put2 = await save.put(acc2.token, validSave());
  const beforeArea = await api('/api/player/progress', { token: acc2.token });
  const areaRun = await winBattle(acc2.token, 'wild_starter');
  const afterArea = await api('/api/player/progress', { token: acc2.token });
  const areaBadges = afterArea.data?.progress?.badges ?? [];
  suite.check('首通初心镇野区 → 自动获得青苗徽章 / 人物 Lv.5 → Lv.10',
    put2.status === 200 && beforeArea.data?.progress?.level === 5
    && areaRun.last?.battle?.result === 'enemy_fainted'
    && afterArea.data?.progress?.level === 10
    && afterArea.data?.progress?.cap === 10
    && areaBadges.some((b) => b.id === 'badge_sprout' && b.name === '青苗徽章'),
    `before=${beforeArea.data?.progress?.level} after=${afterArea.data?.progress?.level} `
    + `result=${areaRun.last?.battle?.result} badges=${JSON.stringify(areaBadges).slice(0, 160)}`);
} catch (e) {
  suite.check('套件执行无异常', false, String(e?.stack ?? e).slice(0, 300));
} finally {
  // Grant 表无外键，删账号不会级联，必须显式清（避免污染后续全服断言）。
  try {
    const ids = await prisma.user.findMany({
      where: { username: { in: accounts } }, select: { id: true },
    });
    const userIds = ids.map((u) => u.id);
    if (userIds.length) {
      await prisma.badgeGrant.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.achievementGrant.deleteMany({ where: { userId: { in: userIds } } });
    }
  } catch { /* 清理失败不掩盖断言结果 */ }
  await cleanupAccounts(accounts);
  await prisma.$disconnect();
}

suite.done();
