/**
 * P1-2 服务端权威端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && node tests/e2e_p12.mjs
 *
 * 覆盖：
 *  - 整包 PUT 自造资源增量 → 400 AUTHORITY_MISMATCH，且不封号、不落库
 *  - 意图 nonce 一次性：重复裁决 409、旧 nonce 提交被单调比对拒绝
 *  - 商店购买：少扣钱（白嫖）被精确增量核对拒绝，修正后可重试成功
 *  - 战斗奖励：amulet_coin 翻倍 / exp_share 授权（P1-3）
 *  - 挂机：区域难度只认服务端；改系统时间（前调/后调）不产生额外资源且不封号
 *  - 捕获：伪造成功 / 忽略服务端结果被拒，按裁决结果提交才落库
 *  - 竞态：裁决与提交之间插一次普通 PUT，不覆盖服务端裁决
 *  - 管理员测试菜单走服务端授权，普通账号调用被拒
 * 输出：逐例 [PASS]/[FAIL]，末尾 E2E_P12_OK；任一失败 exit 1。
 */
import { PrismaClient } from '@prisma/client';
import { makeSaveWriter } from './lib/saveWriter.mjs';

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const PASSWORD = 'e2e-pass-123';
const RUN = Date.now().toString(36).slice(-6);
const prisma = new PrismaClient();

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const recentIso = () => new Date(Date.now() - 60_000).toISOString();

/** 首次 PUT 会由服务端建立权威基线，因此这里可以放一份「进行中」的合法存档。 */
function validSave(overrides = {}) {
  return {
    version: '10',
    playerName: '旅行者',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [{
      id: 'abc123', specId: 'sprout_owl', level: 5, exp: 12,
      element: 'grass', maxHp: 57, hp: 57,
      atk: 63, def: 54, spAtk: 71, spDef: 61, spd: 76,
      status: 'none', moveIds: ['tackle', 'vine_whip'],
      initStats: STATS, growthRates: GROWTH, isShiny: false,
    }],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: { area_a: { name: '初始草原', level: 12, theme: 'grass', clearedAt: recentIso() } },
    lastSavedAt: recentIso(),
    ...overrides,
  };
}
const asText = (o) => typeof o === 'string' ? o : JSON.stringify(o);
const clone = (o) => JSON.parse(JSON.stringify(o));

async function request(path, { method = 'GET', token, body } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (token) headers.Authorization = `Bearer ${token}`;
  const res = await fetch(BASE + path, {
    method, headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = text; }
  return { status: res.status, data };
}

// P4：整包 PUT 必须带 revision（CAS）。saveWriter 逐 token 跟踪当前版本，
// 需要构造版本冲突时显式传 { revision: n }。
const saveWriter = makeSaveWriter(request);
const put = saveWriter.put;
const get = (token) => request('/api/save?slot=1', { token });
const me = (token) => request('/api/auth/me', { token });
// P4：意图也要带 revision（CAS）。裁决成功后服务端返回新版本号，这里立刻同步，
// 否则紧接着的 commitIntent（PUT 带 intentNonce）会拿旧版本撞 409。
const intent = async (token, type, payload, save, nonce) => {
  const revision = await saveWriter.revOf(token, 1);
  const res = await request(`/api/actions/${type}`, {
    method: 'POST', token,
    body: { slot: 1, nonce, save: asText(save), payload, revision },
  });
  if (res.status === 200 && typeof res.data?.revision === 'number') {
    saveWriter.set(token, 1, res.data.revision);
  }
  return res;
};
const newNonce = () => `n_${RUN}_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
}

async function freshUser(tag, baseline = validSave()) {
  const username = `p12_${RUN}_${tag}`;
  const r = await request('/api/auth/register', {
    method: 'POST', body: { username, password: PASSWORD },
  });
  if (r.status !== 200 || !r.data?.token) throw new Error(`注册失败 ${tag}: ${JSON.stringify(r)}`);
  const first = await put(r.data.token, baseline);
  check(`建立基线 / ${tag}`, first.status === 200, JSON.stringify(first.data));
  return { username, token: r.data.token, baseline };
}

async function main() {
  // ————— A. 整包 PUT 自造增量：拒绝、不封号、不落库 —————
  const mainUser = await freshUser('main');
  const forged = clone(mainUser.baseline);
  forged.money = 999999;
  const reject = await put(mainUser.token, forged);
  check('改钱 PUT → 400 AUTHORITY_MISMATCH',
    reject.status === 400 && reject.data?.code === 'AUTHORITY_MISMATCH', JSON.stringify(reject.data));
  const afterReject = await get(mainUser.token);
  check('被拒档没有落库', JSON.parse(afterReject.data.data).money === 1200, JSON.stringify(afterReject.data).slice(0, 160));
  const stillOk = await me(mainUser.token);
  check('自造增量不封号', stillOk.status === 200 && stillOk.data?.banned === false, JSON.stringify(stillOk.data));

  const forgedItem = clone(mainUser.baseline);
  forgedItem.inventory.capsule_master = 99;
  const rejectItem = await put(mainUser.token, forgedItem);
  check('凭空加道具 → 400（path 精确指向背包字段）',
    rejectItem.status === 400 && rejectItem.data?.code === 'AUTHORITY_MISMATCH' &&
    rejectItem.data?.path === 'inventory.capsule_master', JSON.stringify(rejectItem.data));

  // ————— B. 商店购买：白嫖被拒、修正后重试、nonce 重放 —————
  const nBuy = newNonce();
  const buy = await intent(mainUser.token, 'shop_buy', { itemId: 'capsule_prism', amount: 2 }, mainUser.baseline, nBuy);
  check('shop_buy 裁决 200 且价格取服务端表',
    buy.status === 200 && buy.data?.result?.cost === 1200, JSON.stringify(buy.data));

  const freeBuy = clone(mainUser.baseline);
  freeBuy.inventory.capsule_prism = 2; // 拿了东西但没扣钱
  const freeCommit = await put(mainUser.token, freeBuy, { intentNonce: nBuy });
  check('白嫖购买 → 400 INTENT_DELTA_MISMATCH',
    freeCommit.status === 400 && freeCommit.data?.code === 'INTENT_DELTA_MISMATCH', JSON.stringify(freeCommit.data));

  const goodBuy = clone(mainUser.baseline);
  goodBuy.money = 0;
  goodBuy.inventory.capsule_prism = 2;
  // 竞态：裁决与提交之间插一次普通 PUT（旧存档），不应抹掉服务端授权。
  const stalePut = await put(mainUser.token, mainUser.baseline);
  check('裁决中途的普通 PUT 不覆盖授权', stalePut.status === 200, JSON.stringify(stalePut.data));
  const goodCommit = await put(mainUser.token, goodBuy, { intentNonce: nBuy });
  check('按裁决结果提交 → 200', goodCommit.status === 200, JSON.stringify(goodCommit.data));
  const bought = await get(mainUser.token);
  const boughtSave = JSON.parse(bought.data.data);
  check('落库：扣钱 1200 + 得到 2 个高级球',
    boughtSave.money === 0 && boughtSave.inventory.capsule_prism === 2, JSON.stringify(boughtSave.inventory));

  const replay = await intent(mainUser.token, 'shop_buy', { itemId: 'heal_antidote', amount: 1 }, goodBuy, nBuy);
  check('重复 nonce → 409 INTENT_REPLAY',
    replay.status === 409 && replay.data?.code === 'INTENT_REPLAY', JSON.stringify(replay.data));
  const oldNonceCommit = await put(mainUser.token, Object.assign(clone(goodBuy), { money: 500 }), { intentNonce: nBuy });
  check('旧 nonce 再次提交加钱 → 400', oldNonceCommit.status === 400, JSON.stringify(oldNonceCommit.data));

  // ————— C. battle_reward / capture 意图已下线（2026-11-07）—————
  // P1-2 时代战斗在客户端跑，服务端只能采信上报的 enemyLevel / baseRate。
  // P3-1c 战斗上移后这两个接口等于「不用打就能领奖」，已从 INTENT_TYPES 删除。
  // 这里守住删除结果：任何人再来调都必须被挡在 schema 校验层。
  const plainUser = await freshUser('reward');
  const reward = await intent(plainUser.token, 'battle_reward',
    { enemyLevel: 30, areaId: 'area_a', monsterIds: ['abc123'] }, plainUser.baseline, newNonce());
  check('battle_reward 已下线 → 400 未知的操作类型',
    reward.status === 400 && /未知的操作类型/.test(String(reward.data?.error)), JSON.stringify(reward.data));

  const rewardRetry = await intent(plainUser.token, 'battle_reward',
    { enemyLevel: 30, areaId: 'area_a', monsterIds: ['abc123'] }, plainUser.baseline, newNonce());
  check('换新 nonce 重试仍 400（是类型下线，不是重放拦截）',
    rewardRetry.status === 400 && /未知的操作类型/.test(String(rewardRetry.data?.error)), JSON.stringify(rewardRetry.data));

  const captureGone = await intent(plainUser.token, 'capture',
    { itemId: 'capsule_basic', enemyLevel: 30, enemyHp: 1, enemyMaxHp: 100, baseRate: 0.62 },
    plainUser.baseline, newNonce());
  check('capture 已下线 → 400（伪造 baseRate 的路子关闭）',
    captureGone.status === 400 && /未知的操作类型/.test(String(captureGone.data?.error)), JSON.stringify(captureGone.data));

  // ————— D. 挂机：服务端时钟，改系统时间不生效且不封号 —————
  const idleUser = await freshUser('idle');
  const nStart = newNonce();
  const start = await intent(idleUser.token, 'idle_start',
    { areaId: 'area_a', level: 999 }, idleUser.baseline, nStart);
  check('挂机难度只认服务端存档（客户端报 999 → 实为 12）',
    start.status === 200 && start.data?.result?.level === 12, JSON.stringify(start.data));
  const idleSave = clone(idleUser.baseline);
  idleSave.idle = {
    areaId: start.data.result.areaId,
    areaName: start.data.result.areaName,
    level: start.data.result.level,
    startedAt: start.data.result.startedAt,
  };
  check('挂机开始提交 → 200', (await put(idleUser.token, idleSave, { intentNonce: nStart })).status === 200, '');

  const nClaim = newNonce();
  const claim = await intent(idleUser.token, 'idle_claim',
    { clientStartedAt: '1999-01-01T00:00:00.000Z', clientNow: '2099-01-01T00:00:00.000Z' }, idleSave, nClaim);
  check('改系统时间（前调/后调）不产生额外资源',
    claim.status === 200 && claim.data?.result?.money === 0 && claim.data?.result?.minutes === 0,
    JSON.stringify(claim.data));
  const claimedSave = clone(idleSave);
  claimedSave.idle = null;
  check('挂机领取提交 → 200', (await put(idleUser.token, claimedSave, { intentNonce: nClaim })).status === 200);
  const claimAgain = await intent(idleUser.token, 'idle_claim', {}, claimedSave, newNonce());
  check('重复领取（新 nonce）→ 400 无派遣', claimAgain.status === 400, JSON.stringify(claimAgain.data));
  const idleMe = await me(idleUser.token);
  check('改系统时间不封号', idleMe.status === 200 && idleMe.data?.banned === false, JSON.stringify(idleMe.data));

  // ————— E. 捕获已只走服务端战斗（capture 意图 2026-11-07 下线）—————
  // 原用例验证「客户端伪造捕获结果会被增量核对拒绝」。现在 capture 意图不再存在，
  // 捕获只能由 /api/battle/action 的 capture 动作在真实战斗里产生；相关断言
  // （越权 battleId、非法道具、结算一致性）在 e2e:p31 的战斗接口区覆盖。

  // ————— F. 管理员测试菜单授权 —————
  const adminUser = await freshUser('admin');
  const nNo = newNonce();
  const denied = await intent(adminUser.token, 'admin_test', {}, adminUser.baseline, nNo);
  check('普通账号调 admin_test → 400', denied.status === 400, JSON.stringify(denied.data));
  await prisma.user.update({ where: { username: adminUser.username }, data: { role: 'admin' } });
  try {
    const nYes = newNonce();
    const allowed = await intent(adminUser.token, 'admin_test', {}, adminUser.baseline, nYes);
    check('管理员 admin_test 裁决 200', allowed.status === 200, JSON.stringify(allowed.data));
    const testSave = clone(adminUser.baseline);
    testSave.money = 999999;
    testSave.inventory.capsule_master = 99;
    const committed = await put(adminUser.token, testSave, { intentNonce: nYes });
    check('管理员测试档授权落库 → 200', committed.status === 200, JSON.stringify(committed.data));
    const readBack = JSON.parse((await get(adminUser.token)).data.data);
    check('管理员基线已重建（GET 回读一致）', readBack.money === 999999, String(readBack.money));
  } finally {
    await prisma.user.update({ where: { username: adminUser.username }, data: { role: 'player' } });
  }

  // ————— G. 新档 rebase 防伪造 —————
  const rebaseUser = await freshUser('rebase');
  const fakeFresh = clone(rebaseUser.baseline);
  fakeFresh.money = 888888;
  const rebaseReject = await put(rebaseUser.token, fakeFresh, { rebase: true });
  check('伪造 rebase 洗白高资源 → 400', rebaseReject.status === 400, JSON.stringify(rebaseReject.data));

  await prisma.$disconnect();
  console.log(`\nE2E_P12_RESULT pass=${pass} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('E2E_P12_OK');
}

main().catch(async (e) => {
  console.error('E2E_P12_ABORT', e);
  await prisma.$disconnect();
  process.exit(1);
});
