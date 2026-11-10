/**
 * P4-2a 只读派生榜端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p42a
 *
 * 分区：
 *  A 接口边界   health.rank / 未登录 401 / 未知类型与 limit / 伪上报 400 / 无写入口
 *  B 四榜派生   三个不同数值的账号在四张榜里的相对顺序、字段与免责声明
 *  C 权威真值   maxHp 而非 hp、CAS/风控挡改档、封号与管理员不上榜、顶号旧 token 失效
 *  D 只读语义   limit 生效、行内不含内部 id、元数据清单稳定
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42A_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, login, setRole, cleanupAccounts, validSave,
  save, requireBackend, loadBackendEnv,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42A');
const created = [];

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};

/** 造一份合法存档：三只数值档位故意拉开，保证四榜相对顺序稳定。 */
function rankedSave({ maxHp = 72, partyCount = 1, level = 9, clearedAreas = {}, dex = 1 }) {
  const base = validSave();
  const m0 = base.party[0];
  const party = Array.from({ length: partyCount }, (_, i) => ({
    ...m0, id: `p${i + 1}`, maxHp, hp: maxHp, level,
  }));
  const collection = {};
  if (dex >= 1) collection.sprout_owl = { seen: true, captured: true, timesCaptured: 1 };
  if (dex >= 2) collection.spark_mouse = { seen: true, captured: true, timesCaptured: 1 };
  return { ...base, party, box: [], collection, clearedAreas };
}

const area = (level) => ({ name: '测试区域', level, theme: 'grass', clearedAt: new Date(Date.now() - 60_000).toISOString() });

async function accountWithSave(prefix, data) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, data);
  if (r.status !== 200) throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  return acc;
}

const board = (token, type, limit = 50) =>
  api(`/api/rank/${type}?limit=${limit}`, { token });

/** 只在榜单里挑出本套件造的账号，避免受残留测试账号影响。 */
const mine = (res, names) => (res.data?.entries ?? []).filter((e) => names.includes(e.username));

/** F04：直接写 Grant 表等价于「服务端唯一写入口刚发过徽章」，客户端无领取口。 */
async function grantBadgeFor(username, badgeId) {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    if (!u) return false;
    await prisma.badgeGrant.create({ data: { userId: u.id, badgeId, source: 'e2e:p42a' } });
    return true;
  } catch (e) {
    return e?.code === 'P2002';
  } finally {
    await prisma.$disconnect();
  }
}

async function banByUsername(username) {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    await prisma.user.update({
      where: { username },
      data: { bannedAt: new Date(), banReason: 'E2E 榜单过滤验证' },
    });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const h = await requireBackend();
  suite.check('后端就绪且 health 带 rank 只读统计',
    !!h && h.rank?.types === 4 && h.rank?.readonly === true && h.rank?.source === 'server_save',
    JSON.stringify(h?.rank ?? null));

  // ═══════════════════ A. 接口边界 ═══════════════════
  const anonList = await api('/api/rank');
  suite.check('未登录读榜单清单 → 401', anonList.status === 401, `status=${anonList.status}`);
  const anonBoard = await api('/api/rank/team_power');
  suite.check('未登录读单张榜 → 401', anonBoard.status === 401, `status=${anonBoard.status}`);

  const viewer = await mk('p42v');
  const meta = await api('/api/rank', { token: viewer.token });
  suite.check('GET /api/rank 返回四张榜元数据',
    meta.status === 200 && meta.data?.ok === true && meta.data?.types?.length === 4
    && meta.data?.readonly === true,
    JSON.stringify(meta.data?.types?.map((t) => t.type) ?? null));
  suite.check('战力榜元数据带「不代表实战强弱」免责口径',
    meta.data?.types?.filter((t) => t.unit === '战力')
      .every((t) => String(t.disclaimer).includes('不代表实战强弱')) === true,
    JSON.stringify(meta.data?.types?.[0] ?? null));

  const unknown = await board(viewer.token, 'hacked_type');
  suite.check('未知榜单类型 → 400 RANK_TYPE_UNKNOWN',
    unknown.status === 400 && unknown.data?.code === 'RANK_TYPE_UNKNOWN',
    `${unknown.status} ${JSON.stringify(unknown.data).slice(0, 120)}`);
  const badLimit = await board(viewer.token, 'team_power', 0);
  suite.check('limit=0 → 400', badLimit.status === 400, `status=${badLimit.status}`);
  const bigLimit = await board(viewer.token, 'team_power', 51);
  suite.check('limit=51 → 400', bigLimit.status === 400, `status=${bigLimit.status}`);

  const forgePower = await api('/api/rank/team_power?power=99999999', { token: viewer.token });
  suite.check('客户端上报 power → 400 RANK_INPUT_FORBIDDEN',
    forgePower.status === 400 && forgePower.data?.code === 'RANK_INPUT_FORBIDDEN'
    && forgePower.data?.fields?.includes('power'),
    `${forgePower.status} ${JSON.stringify(forgePower.data).slice(0, 140)}`);
  const forgeLevel = await api('/api/rank/summoner_level?playerLevel=9999', { token: viewer.token });
  suite.check('客户端上报召唤师等级 → 400',
    forgeLevel.status === 400 && forgeLevel.data?.code === 'RANK_INPUT_FORBIDDEN',
    `status=${forgeLevel.status}`);
  const forgeProgress = await api('/api/rank/progress?clearedAreas=all&score=1e9', { token: viewer.token });
  suite.check('客户端上报推图进度 / 分数 → 400',
    forgeProgress.status === 400 && forgeProgress.data?.code === 'RANK_INPUT_FORBIDDEN'
    && forgeProgress.data?.fields?.includes('clearedAreas'),
    `${forgeProgress.status} ${JSON.stringify(forgeProgress.data).slice(0, 140)}`);

  const post = await api('/api/rank/team_power', { method: 'POST', token: viewer.token, body: { value: 9999 } });
  suite.check('POST /api/rank/:type 无写入口 → 404', post.status === 404, `status=${post.status}`);
  const put = await api('/api/rank/team_power', { method: 'PUT', token: viewer.token, body: { value: 9999 } });
  suite.check('PUT /api/rank/:type 无写入口 → 404', put.status === 404, `status=${put.status}`);

  // ═══════════════════ B. 四榜派生 ═══════════════════
  console.log('\n—— B. 四榜派生 ——');
  const accLow = await accountWithSave('p42lo', rankedSave({
    maxHp: 1000, clearedAreas: { wild_starter: area(3) },
  }));
  const accMid = await accountWithSave('p42mi', rankedSave({
    maxHp: 3000, partyCount: 2, clearedAreas: { wild_starter: area(10) },
  }));
  const accHigh = await accountWithSave('p42hi', rankedSave({
    maxHp: 6000, partyCount: 2, level: 30,
    clearedAreas: { wild_starter: area(5), a2: area(18) }, dex: 2,
  }));
  // F04：等级榜真值改读服务端 BadgeGrant，给 high 发一枚赤焰徽章拉开差距。
  const badgeGranted = await grantBadgeFor(accHigh.username, 'badge_flame');
  const names = [accLow.username, accMid.username, accHigh.username];
  suite.check('三个不同数值的测试账号建档成功', names.every(Boolean) && new Set(names).size === 3,
    names.join(','));

  const boards = {};
  for (const t of ['monster_power', 'team_power', 'summoner_level', 'progress']) {
    boards[t] = await board(viewer.token, t);
  }
  suite.check('四张榜均 200 且标记只读 / 服务端存档真值',
    Object.values(boards).every((r) => r.status === 200 && r.data?.ok === true
      && r.data?.readonly === true && r.data?.source === 'server_save'
      && Array.isArray(r.data?.entries) && typeof r.data?.eligible === 'number'
      && typeof r.data?.generatedAt === 'string'),
    Object.entries(boards).map(([k, r]) => `${k}:${r.status}`).join(' '));

  const inTeam = mine(boards.team_power, names);
  suite.check('全队战力榜含三账号且数值来自服务端六维和',
    inTeam.length === 3
    && inTeam.find((e) => e.username === accHigh.username)?.value
      > inTeam.find((e) => e.username === accMid.username)?.value
    && inTeam.find((e) => e.username === accMid.username)?.value
      > inTeam.find((e) => e.username === accLow.username)?.value,
    JSON.stringify(inTeam.map((e) => `${e.username}:${e.value}`)));
  suite.check('全队战力 = party 各只之和（high 两只 6000 基础值）',
    Number(inTeam.find((e) => e.username === accHigh.username)?.value) > 12000,
    JSON.stringify(inTeam.find((e) => e.username === accHigh.username) ?? null));

  const inMonster = mine(boards.monster_power, names);
  suite.check('单宠战力榜取最强一只，顺序与全队榜一致',
    inMonster.length === 3
    && inMonster.find((e) => e.username === accHigh.username)?.value
      > inMonster.find((e) => e.username === accLow.username)?.value,
    JSON.stringify(inMonster.map((e) => `${e.username}:${e.value}`)));

  const inLevel = mine(boards.summoner_level, names);
  // 全量 verify 时前面套件会留下大量账号，全服榜 limit=50 会把低等级的 low/mid 截断
  // （§28 老坑）。因此「未发徽章恒为 Lv.5」直接查只读进度接口，不依赖全服子集完整性。
  const progLow = await api('/api/player/progress', { token: accLow.token });
  const progMid = await api('/api/player/progress', { token: accMid.token });
  const hiRow = inLevel.find((e) => e.username === accHigh.username);
  const loRow = inLevel.find((e) => e.username === accLow.username);
  suite.check('F04 召唤师等级读服务端徽章真值：high（+5）=10，未发徽章恒为基础 Lv.5',
    badgeGranted === true && hiRow?.value === 10
    && progLow.data?.progress?.level === 5 && progMid.data?.progress?.level === 5
    && (!loRow || loRow.value < hiRow.value || loRow.rank > hiRow.rank)
    && inLevel.every((e) => e.username === accHigh.username || e.value === 5),
    `granted=${badgeGranted} hi=${hiRow?.value} lo=${loRow?.value} `
    + `progLow=${progLow.data?.progress?.level} progMid=${progMid.data?.progress?.level} `
    + JSON.stringify(inLevel.map((e) => `${e.username}:${e.value}`)));
  suite.check('召唤师等级行说明不含客户端字段',
    inLevel.every((e) => /首通 \d+ 区/.test(e.detail)),
    JSON.stringify(inLevel[0] ?? null));

  const inProg = mine(boards.progress, names);
  suite.check('推图榜按首通数排序，high 两区 > low 一区',
    inProg.length === 3
    && inProg.find((e) => e.username === accHigh.username)?.value === 2
    && inProg.find((e) => e.username === accLow.username)?.value === 1,
    JSON.stringify(inProg.map((e) => `${e.username}:${e.value}`)));
  suite.check('推图榜同数量时比较最高区域难度（mid Lv.10 排在 low Lv.3 前）',
    inProg.find((e) => e.username === accHigh.username)?.secondary === 18
    && inProg.find((e) => e.username === accMid.username)?.secondary === 10
    && inProg.find((e) => e.username === accMid.username)?.rank
      < inProg.find((e) => e.username === accLow.username)?.rank,
    JSON.stringify(inProg.map((e) => `${e.username}:${e.value}/${e.secondary}@${e.rank}`)));

  suite.check('榜单行不含 userId 等内部字段，且 isMe 标记请求者',
    Object.values(boards).every((r) => (r.data?.entries ?? []).every((e) =>
      e.userId === undefined && e.data === undefined && typeof e.isMe === 'boolean'))
    && boards.team_power.data.entries.some((e) => !e.isMe),
    JSON.stringify(boards.team_power.data?.entries?.[0] ?? null));
  suite.check('战力榜带免责声明，等级/推图榜各自带口径',
    boards.team_power.data?.disclaimer?.includes('不代表实战强弱') === true
    && boards.monster_power.data?.disclaimer?.includes('不代表实战强弱') === true
    && typeof boards.summoner_level.data?.disclaimer === 'string'
    && typeof boards.progress.data?.disclaimer === 'string',
    JSON.stringify(boards.team_power.data?.disclaimer ?? null));

  // ═══════════════════ C. 权威真值 ═══════════════════
  console.log('\n—— C. 权威真值 ——');
  const beforeHp = inTeam.find((e) => e.username === accLow.username)?.value;
  const hurt = rankedSave({ maxHp: 1000, clearedAreas: { wild_starter: area(3) } });
  hurt.party[0].hp = 1;
  const hpPut = await save.put(accLow.token, hurt);
  suite.check('只改 hp 的存档写入成功（HP 只允许变差）', hpPut.status === 200,
    `${hpPut.status} ${JSON.stringify(hpPut.data).slice(0, 140)}`);
  const afterHpBoard = await board(viewer.token, 'team_power');
  const afterHp = mine(afterHpBoard, [accLow.username])[0]?.value;
  suite.check('战力取 maxHp 不取 hp：掉血前后榜单数值不变',
    afterHp === beforeHp && beforeHp > 0,
    JSON.stringify({ beforeHp, afterHp }));

  // 独立账号做改档对抗，避免封号影响主链路
  const cheat = await accountWithSave('p42ch', rankedSave({ maxHp: 2000 }));
  const cheatBefore = mine(await board(viewer.token, 'team_power'), [cheat.username])[0]?.value;
  const noRev = await api('/api/save', {
    method: 'PUT', token: cheat.token,
    body: { data: JSON.stringify(rankedSave({ maxHp: 90000 })) },
  });
  suite.check('缺 revision 的整包覆盖 → 400 REVISION_REQUIRED',
    noRev.status === 400 && noRev.data?.code === 'REVISION_REQUIRED',
    `${noRev.status} ${JSON.stringify(noRev.data).slice(0, 140)}`);
  const stale = await api('/api/save', {
    method: 'PUT', token: cheat.token,
    body: { data: JSON.stringify(rankedSave({ maxHp: 90000 })), revision: 0 },
  });
  suite.check('过期 revision 改档 → 409 REVISION_CONFLICT',
    stale.status === 409 && stale.data?.code === 'REVISION_CONFLICT',
    `${stale.status} ${JSON.stringify(stale.data).slice(0, 140)}`);
  const forged = await save.put(cheat.token, rankedSave({ maxHp: 90000 }));
  suite.check('正确 revision 但凭空抬六维 → 被风控拒绝（非 200）',
    forged.status !== 200,
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 140)}`);
  const cheatAfter = mine(await board(viewer.token, 'team_power'), [cheat.username])[0]?.value;
  suite.check('改档没有把榜单数值抬高', cheatAfter === cheatBefore,
    JSON.stringify({ cheatBefore, cheatAfter }));

  const banned = await accountWithSave('p42bn', rankedSave({ maxHp: 4000 }));
  await banByUsername(banned.username);
  const afterBan = mine(await board(viewer.token, 'team_power'), [banned.username]);
  suite.check('封号账号的存档不进入榜单', afterBan.length === 0,
    JSON.stringify(afterBan));

  const adm = await accountWithSave('p42ad', rankedSave({ maxHp: 4000 }));
  await setRole(adm.username, 'admin');
  const afterAdmin = mine(await board(viewer.token, 'team_power'), [adm.username]);
  suite.check('管理员测试档不进入全服榜（避免测试菜单数据污染）', afterAdmin.length === 0,
    JSON.stringify(afterAdmin));

  const relogin = await login(viewer.username, viewer.password);
  suite.check('viewer 二次登录成功', relogin.status === 200 && !!relogin.data?.token,
    `status=${relogin.status}`);
  const oldToken = await board(viewer.token, 'team_power');
  suite.check('顶号后旧 token 读榜 → 403 SESSION_REPLACED',
    oldToken.status === 403 && oldToken.data?.code === 'SESSION_REPLACED',
    `${oldToken.status} ${JSON.stringify(oldToken.data).slice(0, 140)}`);
  const newToken = await board(relogin.data.token, 'team_power');
  suite.check('新 token 读榜正常', newToken.status === 200, `status=${newToken.status}`);

  // ═══════════════════ D. 只读语义 ═══════════════════
  console.log('\n—— D. 只读语义 ——');
  const one = await board(relogin.data.token, 'team_power', 1);
  suite.check('limit=1 只返回一行', one.status === 200 && one.data?.entries?.length === 1,
    `n=${one.data?.entries?.length}`);
  const metaForged = await api('/api/rank?power=999999', { token: relogin.data.token });
  suite.check('清单接口忽略伪上报字段且类型不变',
    metaForged.status === 200 && metaForged.data?.types?.length === 4,
    `status=${metaForged.status}`);
  const stableA = await board(relogin.data.token, 'team_power');
  const stableB = await board(relogin.data.token, 'team_power');
  suite.check('同一份存档两次派生结果完全一致（可复现）',
    JSON.stringify(stableA.data?.entries) === JSON.stringify(stableB.data?.entries),
    'entries 不一致');
  suite.check('四榜类型回显与请求一致',
    Object.entries(boards).every(([t, r]) => r.data?.type === t),
    Object.entries(boards).map(([t, r]) => `${t}:${r.data?.type}`).join(' '));
}

main().then(() => {
  suite.done();
}).catch((e) => {
  console.error('[FATAL]', e);
  suite.check('E2E 未抛未捕获异常', false, String(e?.message ?? e));
  suite.done();
}).finally(async () => {
  // Grant 表无外键，删账号不会级联，必须显式清（否则污染后续全服榜断言）。
  try {
    loadBackendEnv();
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const ids = await prisma.user.findMany({
      where: { username: { in: created } }, select: { id: true },
    });
    if (ids.length) {
      await prisma.badgeGrant.deleteMany({ where: { userId: { in: ids.map((u) => u.id) } } });
    }
    await prisma.$disconnect();
  } catch (e) { console.warn('[WARN] Grant 清理失败', e?.message); }
  try { await cleanupAccounts(created); } catch (e) { console.warn('[WARN] 清理失败', e?.message); }
});
