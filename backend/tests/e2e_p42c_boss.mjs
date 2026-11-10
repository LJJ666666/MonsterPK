/**
 * P4-2c 单人 Boss 讨伐 + 伤害排名 端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p42c
 *
 * 分区：
 *  A 接口边界   health.boss / 未登录 401 / 未知 Boss 400 / 伪上报 400 / 无写入口 404
 *  B 开局       Boss 字段与 theme 来自内容表 / 禁止捕获 / 战斗互斥 / 伤害只来自服务端
 *  C 结算       正常结算记事件 + 扣一次 / 重复结算不叠加 / 逃跑与放弃不扣次数 / 次数用完 429
 *  D 榜         按账号合并多槽位 / 封号与管理员不上榜 / limit / 只读字段 / 不含内部 id
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42C_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, setRole, cleanupAccounts, validSave, save, requireBackend,
  loadBackendEnv,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42C');
const created = [];

const BOSS_MAIN = 'boss_ember_behemoth';   // 每日 3 次
const BOSS_RARE = 'boss_apex_dragon';      // 每日 1 次

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 强档：Lv.40 / 高攻，保证几回合内打死 Lv.12 的 Boss，E2E 不必跑几十轮。
 * HP 与 F14 一致给到 8000：同一账号要连打多场 + 多槽位，结算会把队伍 HP 写回存档，
 * 420 在敌方 elite/rare 叠加的偶发高强度下会被打全灭，下一场开局直接 PARTY_FAINTED。
 * 8000 远低于 saveValidator STAT_MAX，纯用例确定性，产品逻辑零改动（bug_log §38）。
 */
function strongSave() {
  const base = validSave();
  return {
    ...base,
    money: 5000,
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
  if (r.status !== 200) throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  return acc;
}

const bossList = (token) => api('/api/boss', { token });
const bossStart = (token, bossId, slot = 1) =>
  api('/api/boss/start', { method: 'POST', token, body: { slot, bossId } });
const bossRank = (token, bossId, limit = 20) =>
  api(`/api/boss/${bossId}/rank?limit=${limit}`, { token });
const act = (token, battleId, action, slot = 1) =>
  api('/api/battle/action', { method: 'POST', token, body: { slot, battleId, action } });

const ATTACK = { type: 'move', moveId: 'tackle' };

/** 一直打到战斗结束（最多 20 回合；PP 够用）。返回最后一次响应。 */
async function fightToEnd(token, battleId, slot = 1) {
  let last = null;
  for (let i = 0; i < 20; i += 1) {
    const r = await act(token, battleId, ATTACK, slot);
    if (r.status !== 200) return { status: r.status, data: r.data, ended: false };
    last = r;
    if (r.data?.battle?.finished) return { status: 200, data: r.data, ended: true };
  }
  return { status: last?.status ?? 0, data: last?.data, ended: false };
}

/** 逃跑直到成功（速度优势下概率 75%，最多 8 次）。 */
async function fleeUntilDone(token, battleId, slot = 1) {
  let last = null;
  for (let i = 0; i < 8; i += 1) {
    const r = await act(token, battleId, { type: 'flee' }, slot);
    if (r.status !== 200) return { status: r.status, data: r.data };
    last = r;
    if (r.data?.battle?.finished) return { status: 200, data: r.data };
  }
  return { status: last?.status ?? 0, data: last?.data };
}

const mineEntries = (res, names) =>
  (res.data?.entries ?? []).filter((e) => names.includes(e.username));

async function main() {
  const h = await requireBackend();
  suite.check('后端就绪且 health 带 boss 真值来源',
    !!h && h.boss?.bosses === 3 && h.boss?.source === 'server_content'
    && h.boss?.damageSource === 'server_battle' && typeof h.boss?.quotas?.held === 'number',
    JSON.stringify(h?.boss ?? null));

  // ═══════════════════ A. 接口边界 ═══════════════════
  console.log('\n—— A. 接口边界 ——');
  suite.check('未登录读讨伐列表 → 401', (await bossList(null)).status === 401);
  suite.check('未登录开局 → 401', (await bossStart(null, BOSS_MAIN)).status === 401);
  suite.check('未登录读伤害榜 → 401', (await bossRank(null, BOSS_MAIN)).status === 401);

  const viewer = await mk('p42c_v');
  const list = await bossList(viewer.token);
  suite.check('GET /api/boss 返回三只 Boss 且标记只读',
    list.status === 200 && list.data?.ok === true && list.data?.readonly === true
    && Array.isArray(list.data?.bosses) && list.data.bosses.length === 3
    && typeof list.data?.periodKey === 'string',
    `status=${list.status} n=${list.data?.bosses?.length}`);
  const view0 = (list.data?.bosses ?? []).find((b) => b.bossId === BOSS_MAIN);
  suite.check('Boss 视图含等级 / 每日次数 / 今日余量 / 我的伤害，且不下发 HP 倍率',
    !!view0 && view0.level === 12 && view0.dailyLimit === 3
    && view0.used === 0 && view0.remaining === 3
    && view0.my?.total === 0 && view0.my?.attempts === 0
    && !('hpMultiplier' in view0),
    JSON.stringify(view0 ?? null));

  suite.check('未知 bossId 开局 → 400 BOSS_UNKNOWN',
    await (async () => {
      const r = await bossStart(viewer.token, 'boss_hacked');
      return r.status === 400 && r.data?.code === 'BOSS_UNKNOWN';
    })());

  const forgeDamage = await api('/api/boss/start', {
    method: 'POST', token: viewer.token,
    body: { slot: 1, bossId: BOSS_MAIN, damage: 999999 },
  });
  suite.check('开局上报 damage → 400 BOSS_INPUT_FORBIDDEN',
    forgeDamage.status === 400 && forgeDamage.data?.code === 'BOSS_INPUT_FORBIDDEN'
    && forgeDamage.data?.fields?.includes('damage'),
    `${forgeDamage.status} ${JSON.stringify(forgeDamage.data).slice(0, 140)}`);

  const forgeLimit = await api('/api/boss/start', {
    method: 'POST', token: viewer.token,
    body: { slot: 1, bossId: BOSS_MAIN, dailyLimit: 99 },
  });
  suite.check('开局上报 dailyLimit → 400（次数上限只由服务端定）',
    forgeLimit.status === 400 && forgeLimit.data?.code === 'BOSS_INPUT_FORBIDDEN',
    `status=${forgeLimit.status}`);

  const forgeRank = await api(`/api/boss/${BOSS_MAIN}/rank?damage=999999`, { token: viewer.token });
  suite.check('伤害榜上报 damage → 400 BOSS_INPUT_FORBIDDEN',
    forgeRank.status === 400 && forgeRank.data?.code === 'BOSS_INPUT_FORBIDDEN',
    `status=${forgeRank.status}`);
  suite.check('伤害榜 limit=0 → 400', (await bossRank(viewer.token, BOSS_MAIN, 0)).status === 400);
  suite.check('伤害榜 limit=51 → 400', (await bossRank(viewer.token, BOSS_MAIN, 51)).status === 400);
  suite.check('POST 伤害榜无写入口 → 404',
    (await api(`/api/boss/${BOSS_MAIN}/rank`, { method: 'POST', token: viewer.token, body: { damage: 1 } })).status === 404);
  suite.check('PUT 讨伐列表无写入口 → 404',
    (await api('/api/boss', { method: 'PUT', token: viewer.token, body: { used: 0 } })).status === 404);

  const emptyRank = await bossRank(viewer.token, BOSS_RARE);
  suite.check('新账号的伤害榜为空且 me 全 0',
    emptyRank.status === 200 && emptyRank.data?.readonly === true
    && emptyRank.data?.source === 'boss_damage_events'
    && Array.isArray(emptyRank.data?.entries)
    && emptyRank.data.entries.length === 0
    && emptyRank.data?.me?.total === 0,
    JSON.stringify(emptyRank.data?.me ?? null));

  // ═══════════════════ B. 开局与战斗 ═══════════════════
  console.log('\n—— B. 开局与战斗 ——');
  const hero = await accountWithSave('p42c_a', strongSave());
  const heroBefore = JSON.parse((await save.get(hero.token)).data.data);

  const first = await bossStart(hero.token, BOSS_MAIN);
  suite.check('开局成功：返回战斗视图 + 次数信息',
    first.status === 200 && first.data?.ok === true
    && typeof first.data?.battle?.battleId === 'string'
    && first.data?.boss?.bossId === BOSS_MAIN
    && first.data?.quota?.limit === 3 && first.data?.quota?.used === 0
    && first.data?.quota?.remaining === 2,
    `${first.status} ${JSON.stringify(first.data?.quota ?? null)}`);

  const b1 = first.data?.battle;
  suite.check('Boss 战：区域名与主题取自内容表，areaId 为空（不写首通）',
    b1?.areaName === '烈焰巨兽 · 讨伐' && b1?.theme === 'volcano' && b1?.areaId === null,
    JSON.stringify({ areaName: b1?.areaName, theme: b1?.theme, areaId: b1?.areaId }));
  suite.check('Boss 战：敌方固定等级且满血（HP 倍率在服务端）',
    b1?.enemy?.level === 12 && b1?.enemy?.hp === b1?.enemy?.maxHp && b1?.enemy?.maxHp > 60,
    JSON.stringify({ lv: b1?.enemy?.level, hp: b1?.enemy?.hp, maxHp: b1?.enemy?.maxHp }));
  suite.check('Boss 战视图带 bossId / bossName / damageDealt=0',
    b1?.bossId === BOSS_MAIN && typeof b1?.bossName === 'string' && b1?.damageDealt === 0,
    JSON.stringify({ bossId: b1?.bossId, dmg: b1?.damageDealt }));

  const cap = await act(hero.token, b1.battleId, { type: 'capture', itemId: 'capsule_basic' });
  suite.check('Boss 战禁止捕获 → 400 BOSS_UNCATCHABLE（且不扣道具）',
    cap.status === 400 && cap.data?.code === 'BOSS_UNCATCHABLE',
    `${cap.status} ${JSON.stringify(cap.data).slice(0, 120)}`);

  const again = await bossStart(hero.token, BOSS_MAIN);
  suite.check('同槽位已有讨伐 → 409 BOSS_BATTLE_IN_PROGRESS',
    again.status === 409 && again.data?.code === 'BOSS_BATTLE_IN_PROGRESS',
    `${again.status} ${JSON.stringify(again.data).slice(0, 120)}`);

  const plain = await api('/api/battle/start', {
    method: 'POST', token: hero.token,
    body: { slot: 1, theme: 'grass', areaName: '草地', levelMin: 1, levelMax: 2 },
  });
  suite.check('讨伐未结束时开普通遭遇 → 409 BOSS_IN_PROGRESS（不会顶掉在途次数）',
    plain.status === 409 && plain.data?.code === 'BOSS_IN_PROGRESS',
    `${plain.status} ${JSON.stringify(plain.data).slice(0, 120)}`);

  const potion = await act(hero.token, b1.battleId, { type: 'item', itemId: 'potion_small' });
  suite.check('Boss 战可使用治疗道具，消耗计入 consumed',
    potion.status === 200 && potion.data?.battle?.consumed?.potion_small === 1,
    `${potion.status} ${JSON.stringify(potion.data?.battle?.consumed ?? null)}`);

  const midHp = potion.data?.battle?.enemy?.hp ?? 0;
  const hit = await act(hero.token, b1.battleId, ATTACK);
  const afterHp = hit.data?.battle?.enemy?.hp ?? midHp;
  suite.check('伤害只来自服务端：damageDealt 等于敌方 HP 差',
    hit.status === 200 && hit.data?.battle?.damageDealt === Math.max(0, midHp - afterHp)
    && hit.data?.battle?.damageDealt > 0,
    JSON.stringify({ midHp, afterHp, dealt: hit.data?.battle?.damageDealt }));

  // ═══════════════════ C. 结算与次数 ═══════════════════
  console.log('\n—— C. 结算与次数 ——');
  const fin = await fightToEnd(hero.token, b1.battleId);
  const bossRes = fin.data?.boss;
  suite.check('击败 Boss → settled 且写入一条伤害事件',
    fin.ended && fin.data?.settled === true && bossRes?.recorded === true
    && bossRes?.damageDealt > 0 && bossRes?.attempts === 1
    && bossRes?.quota?.used === 1 && bossRes?.quota?.remaining === 2,
    JSON.stringify(bossRes ?? null).slice(0, 200));
  suite.check('结算伤害累计 = 本场 damageDealt（单场即累计）',
    bossRes?.total === bossRes?.damageDealt && bossRes?.best === bossRes?.damageDealt,
    JSON.stringify({ total: bossRes?.total, best: bossRes?.best, dealt: bossRes?.damageDealt }));

  const repeat = await act(hero.token, b1.battleId, ATTACK);
  suite.check('战斗已结算 → 再发动作 404（同一场不会重复计）',
    repeat.status === 404, `status=${repeat.status}`);

  const afterFight = JSON.parse((await save.get(hero.token)).data.data);
  // F14 后契约变更：Boss 首胜由服务端发放「每日首讨大包 + 每场小包」，
  // 不再断言「不发金钱 / 道具」；仍然不给经验、不写首通（战斗公式与榜单口径不变）。
  // 小包药水与战斗消耗相抵，故 potion_small 净额为 0；棱彩胶囊 +1 是发奖硬证据。
  suite.check('Boss 结算写回队伍状态；不给经验 / 首通，按 F14 发双档奖励（+120 金钱 / +棱彩胶囊）',
    afterFight.money === heroBefore.money + 120
    && afterFight.inventory.capsule_prism === (heroBefore.inventory.capsule_prism ?? 0) + 1
    && Object.keys(afterFight.clearedAreas ?? {}).length === 0
    && afterFight.party[0].exp === heroBefore.party[0].exp,
    JSON.stringify({
      potion: [heroBefore.inventory.potion_small, afterFight.inventory.potion_small],
      money: [heroBefore.money, afterFight.money],
      prism: [heroBefore.inventory.capsule_prism ?? 0, afterFight.inventory.capsule_prism ?? 0],
      cleared: Object.keys(afterFight.clearedAreas ?? {}).length,
      exp: [heroBefore.party[0].exp, afterFight.party[0].exp],
    }));

  const listAfter = (await bossList(hero.token)).data?.bosses?.find((b) => b.bossId === BOSS_MAIN);
  suite.check('今日概览：used=1 / remaining=2 / my.total 与服务端结算一致',
    listAfter?.used === 1 && listAfter?.remaining === 2
    && listAfter?.my?.total === bossRes?.total && listAfter?.my?.attempts === 1,
    JSON.stringify(listAfter ?? null).slice(0, 200));

  // 逃跑：不写事件、不扣次数
  const s2 = await bossStart(hero.token, BOSS_MAIN);
  const fled = await fleeUntilDone(hero.token, s2.data?.battle?.battleId);
  suite.check('逃跑成功 → recorded=false 且标记 fled',
    fled.data?.settled === true && fled.data?.boss?.recorded === false
    && fled.data?.boss?.reason === 'fled',
    JSON.stringify(fled.data?.boss ?? null).slice(0, 160));
  const listAfterFlee = (await bossList(hero.token)).data?.bosses?.find((b) => b.bossId === BOSS_MAIN);
  suite.check('逃跑不扣次数（used 仍为 1）',
    listAfterFlee?.used === 1 && listAfterFlee?.remaining === 2,
    JSON.stringify({ used: listAfterFlee?.used, remaining: listAfterFlee?.remaining }));

  // 放弃：不写事件、不扣次数
  const s3 = await bossStart(hero.token, BOSS_MAIN);
  const abandoned = await api('/api/battle/abandon', {
    method: 'POST', token: hero.token,
    body: { slot: 1, battleId: s3.data?.battle?.battleId },
  });
  const listAfterAbandon = (await bossList(hero.token)).data?.bosses?.find((b) => b.bossId === BOSS_MAIN);
  suite.check('放弃讨伐 → dropped 且不扣次数',
    abandoned.status === 200 && abandoned.data?.dropped === true
    && listAfterAbandon?.used === 1 && listAfterAbandon?.remaining === 2,
    JSON.stringify({ status: abandoned.status, used: listAfterAbandon?.used }));

  // 第二次真实讨伐（同槽位）→ used=2
  const s4 = await bossStart(hero.token, BOSS_MAIN);
  const fin2 = await fightToEnd(hero.token, s4.data?.battle?.battleId);
  suite.check('第二次讨伐结算 → used=2，累计伤害 = 两场之和',
    fin2.ended && fin2.data?.boss?.attempts === 2
    && fin2.data?.boss?.total === bossRes.total + fin2.data.boss.damageDealt
    && fin2.data?.boss?.quota?.remaining === 1,
    JSON.stringify(fin2.data?.boss ?? null).slice(0, 200));

  // 同账号 slot 2 再打一次 → 次数按账号合并、榜也合并
  await save.put(hero.token, strongSave(), {}, 2);
  const s5 = await bossStart(hero.token, BOSS_MAIN, 2);
  const fin3 = await fightToEnd(hero.token, s5.data?.battle?.battleId, 2);
  suite.check('同账号第二槽位共享每日次数并合并统计（attempts=3）',
    fin3.ended && fin3.data?.boss?.attempts === 3
    && fin3.data?.boss?.quota?.used === 3 && fin3.data?.boss?.quota?.remaining === 0,
    JSON.stringify(fin3.data?.boss ?? null).slice(0, 200));

  const exhausted = await bossStart(hero.token, BOSS_MAIN);
  suite.check('次数用完 → 429 BOSS_QUOTA_EXHAUSTED',
    exhausted.status === 429 && exhausted.data?.code === 'BOSS_QUOTA_EXHAUSTED',
    `${exhausted.status} ${JSON.stringify(exhausted.data).slice(0, 120)}`);
  const other = await bossStart(hero.token, BOSS_RARE);
  suite.check('其它 Boss 的次数独立（ember 用完不影响 apex）',
    other.status === 200 && other.data?.boss?.bossId === BOSS_RARE,
    `status=${other.status} ${JSON.stringify(other.data?.quota ?? null)}`);
  if (other.status === 200) {
    await api('/api/battle/abandon', {
      method: 'POST', token: hero.token,
      body: { slot: 1, battleId: other.data.battle.battleId },
    });
  }

  // 唯一索引：同一 battleId 不能重复计
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  let dupBlocked = false;
  try {
    const u = await prisma.user.findUnique({ where: { username: hero.username }, select: { id: true } });
    const ev = await prisma.bossDamageEvent.findFirst({ where: { userId: u.id } });
    try {
      await prisma.bossDamageEvent.create({
        data: {
          userId: ev.userId, slot: ev.slot, bossId: ev.bossId, periodKey: ev.periodKey,
          damage: 999999, result: ev.result, battleId: ev.battleId,
        },
      });
    } catch (e) {
      dupBlocked = e?.code === 'P2002';
    }
  } finally {
    await prisma.$disconnect();
  }
  suite.check('BossDamageEvent.battleId 唯一索引挡住重复计入', dupBlocked);

  // ═══════════════════ D. 伤害榜 ═══════════════════
  console.log('\n—— D. 伤害榜 ——');
  const brother = await accountWithSave('p42c_b', strongSave());
  const bs = await bossStart(brother.token, BOSS_MAIN);
  const bfin = await fightToEnd(brother.token, bs.data?.battle?.battleId);
  suite.check('第二个账号讨伐成功（用于榜排序）', bfin.ended && bfin.data?.boss?.recorded === true);

  const rank = await bossRank(viewer.token, BOSS_MAIN, 50);
  const mineRows = mineEntries(rank, [hero.username, brother.username]);
  suite.check('伤害榜按账号合并多槽位：hero 只有一行且 attempts=3',
    mineRows.length === 2
    && mineRows.find((r) => r.username === hero.username)?.attempts === 3,
    JSON.stringify(mineRows.map((r) => `${r.username}:${r.damage}/${r.attempts}`)));
  suite.check('伤害榜按累计伤害降序，行内字段完整且不含内部 id',
    mineRows.every((r) => typeof r.rank === 'number' && typeof r.damage === 'number'
      && typeof r.best === 'number' && typeof r.attempts === 'number'
      && typeof r.isMe === 'boolean'
      && !('userId' in r) && !('battleId' in r))
    && mineRows[0].damage >= mineRows[1].damage,
    JSON.stringify(mineRows[0] ?? null));
  suite.check('伤害榜带 me 汇总，且只读标记 / 真值来源正确',
    rank.data?.readonly === true && rank.data?.source === 'boss_damage_events'
    && typeof rank.data?.periodKey === 'string'
    && typeof rank.data?.me?.total === 'number',
    JSON.stringify(rank.data?.me ?? null));

  const limitOne = await bossRank(viewer.token, BOSS_MAIN, 1);
  suite.check('limit=1 只返回一行', limitOne.status === 200 && limitOne.data?.entries?.length === 1);

  // 管理员不上榜
  const adminAcc = await accountWithSave('p42c_adm', strongSave());
  const as = await bossStart(adminAcc.token, BOSS_MAIN);
  await fightToEnd(adminAcc.token, as.data?.battle?.battleId);
  await setRole(adminAcc.username, 'admin');
  const afterAdmin = await bossRank(viewer.token, BOSS_MAIN, 50);
  suite.check('管理员不进伤害榜',
    !(afterAdmin.data?.entries ?? []).some((e) => e.username === adminAcc.username),
    JSON.stringify((afterAdmin.data?.entries ?? []).map((e) => e.username)));

  // 封号不上榜
  const bannedAcc = await accountWithSave('p42c_ban', strongSave());
  const bns = await bossStart(bannedAcc.token, BOSS_MAIN);
  await fightToEnd(bannedAcc.token, bns.data?.battle?.battleId);
  const beforeBan = await bossRank(viewer.token, BOSS_MAIN, 50);
  const appearedBeforeBan = (beforeBan.data?.entries ?? []).some((e) => e.username === bannedAcc.username);
  await prismaBan(bannedAcc.username);
  const afterBan = await bossRank(viewer.token, BOSS_MAIN, 50);
  suite.check('封号账号从伤害榜消失',
    appearedBeforeBan && !(afterBan.data?.entries ?? []).some((e) => e.username === bannedAcc.username),
    `before=${appearedBeforeBan}`);

  suite.done();
}

async function prismaBan(username) {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.user.update({
      where: { username },
      data: { bannedAt: new Date(), banReason: 'E2E 伤害榜过滤验证' },
    });
  } finally {
    await prisma.$disconnect();
  }
}

main()
  .catch((e) => {
    console.error('[ABORT]', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    // 账号清理：BossDamageEvent 无外键，harness 会一并删除
    await cleanupAccounts(created).catch(() => {});
  });
