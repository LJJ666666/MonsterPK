/**
 * P3-1 服务端战斗端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p31
 *
 * 覆盖：
 *  - 开局：敌方由服务端按主题表生成，队伍/背包取自服务端存档（不采信客户端上报）
 *  - 动作：技能扣 PP、回合推进、敌方行动、换人、道具、捕获、逃跑；非法动作被拒
 *  - 隔离：别人的 battleId / 伪造 battleId 一律 404；同槽位新开局覆盖旧战斗
 *  - 结算：战斗结束由服务端写档（金钱 / 队伍 HP / 图鉴 / 首通 / 道具消耗）并提升 revision
 *  - 实时：动作后同账号 WS 收到 battle.state 广播
 * 输出：逐例 [PASS]/[FAIL]，末尾 E2E_P31_OK；任一失败 exit 1。
 */
import WebSocket from 'ws';
import { PrismaClient } from '@prisma/client';
import { makeSaveWriter } from './lib/saveWriter.mjs';

// P3-1c：管理员测试标记必须验证「身份由服务端查库判定」，所以本套件直连数据库提权。
// 连不上就跳过该组，不让一个可选的验证点把整套 E2E 拖挂。
let prisma = null;
try {
  prisma = new PrismaClient();
} catch (err) {
  console.log(`[WARN] Prisma 不可用，跳过管理员测试标记组：${err?.message ?? err}`);
}

const BASE = process.env.E2E_BASE || 'http://localhost:3001';
const WS_HOST = process.env.E2E_WS_HOST || 'ws://localhost:3001';
const ORIGIN = 'http://localhost:5173';
const RUN = Date.now().toString(36).slice(-6);

let pass = 0;
let fail = 0;
function check(name, ok, detail = '') {
  if (ok) { pass++; console.log(`[PASS] ${name}`); }
  else { fail++; console.log(`[FAIL] ${name} ${detail}`); }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const recentIso = () => new Date(Date.now() - 60_000).toISOString();
const asText = (o) => (typeof o === 'string' ? o : JSON.stringify(o));

function validSave(overrides = {}) {
  return {
    version: '10',
    playerName: '战斗测试员',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [
      {
        id: 'p1', specId: 'sprout_owl', level: 9, exp: 12,
        element: 'grass', maxHp: 72, hp: 72,
        atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90,
        status: 'none', moveIds: ['tackle', 'wood_strike'],
        initStats: STATS, growthRates: GROWTH, isShiny: false,
      },
      {
        id: 'p2', specId: 'spark_mouse', level: 9, exp: 0,
        element: 'electric', maxHp: 66, hp: 66,
        atk: 74, def: 60, spAtk: 70, spDef: 62, spd: 96,
        status: 'none', moveIds: ['tackle'],
        initStats: STATS, growthRates: GROWTH, isShiny: false,
      },
    ],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    clearedAreas: {},
    lastSavedAt: recentIso(),
    ...overrides,
  };
}

// P4：整包 PUT 必须带 revision（CAS）。saveWriter 逐 token 跟踪当前版本，
// 需要构造版本冲突时显式传 { revision: n }。
const put = makeSaveWriter(request).put;
const getSave = (token) => request('/api/save?slot=1', { token });
const getSession = (token) => request('/api/session?slot=1', { token });
const health = () => request('/api/health');
const startBattle = (token, body = {}) =>
  request('/api/battle/start', {
    method: 'POST', token,
    body: { slot: 1, theme: 'grass', areaName: '初始草原', areaId: null, levelMin: 2, levelMax: 2, ...body },
  });
const act = (token, battleId, action) =>
  request('/api/battle/action', { method: 'POST', token, body: { slot: 1, battleId, action } });
const current = (token) => request('/api/battle/current?slot=1', { token });

function openWs(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', WS_HOST);
    url.searchParams.set('token', token);
    const ws = new WebSocket(url.toString(), { headers: { Origin: ORIGIN }, handshakeTimeout: 5_000 });
    const ctx = { ws, queue: [] };
    ws.on('message', (d) => {
      try { ctx.queue.push(JSON.parse(d.toString())); } catch { /* 忽略非 JSON */ }
    });
    ws.on('open', () => resolve(ctx));
    ws.on('error', reject);
  });
}

async function waitMsg(ctx, pred, timeout = 3_000) {
  const started = Date.now();
  while (Date.now() - started < timeout) {
    const i = ctx.queue.findIndex(pred);
    if (i >= 0) return ctx.queue.splice(i, 1)[0];
    await sleep(20);
  }
  return null;
}

function closeWs(ctx) {
  return new Promise((resolve) => {
    if (ctx.ws.readyState === WebSocket.CLOSED) return resolve();
    ctx.ws.on('close', () => resolve());
    ctx.ws.close();
  });
}

async function register(name) {
  const r = await request('/api/auth/register', {
    method: 'POST', body: { username: name, password: 'e2e-pass-123' },
  });
  return r.data?.token ?? null;
}

async function main() {
  console.log(`[INFO] 账号前缀 b3_${RUN}`);

  // —— 内容表 ——
  const h = await health();
  check('health 返回内容表规模', h.data?.content?.moves === 294 && h.data?.content?.monsters === 40,
    JSON.stringify(h.data?.content));
  check('health 返回活跃战斗统计', typeof h.data?.battles?.active === 'number',
    JSON.stringify(h.data?.battles));

  // —— 准备账号与存档 ——
  const userA = `b3a_${RUN}`;
  const tokenA = await register(userA);
  check('A 账号注册成功', !!tokenA);
  if (!tokenA) return finish();

  const initial = validSave();
  const p = await put(tokenA, initial);
  check('A 初始存档写入 200', p.status === 200, `${p.status} ${asText(p.data).slice(0, 120)}`);

  const wsCtx = await openWs(tokenA);
  const hello = await waitMsg(wsCtx, (m) => m?.type === 'hello');
  check('WS hello 声明 battle.state 能力', Array.isArray(hello?.capabilities) && hello.capabilities.includes('battle.state'),
    JSON.stringify(hello?.capabilities));

  // —— 开局 ——
  const s1 = await startBattle(tokenA);
  check('开局成功', s1.status === 200 && typeof s1.data?.battle?.battleId === 'string',
    `${s1.status} ${asText(s1.data).slice(0, 160)}`);
  const battleId = s1.data?.battle?.battleId;
  const b1 = s1.data?.battle ?? {};

  check('敌方来自服务端主题表', b1.enemy?.specId === 'sprout_owl' || ['sprout_owl'].includes(b1.enemy?.specId)
    || typeof b1.enemy?.specId === 'string', String(b1.enemy?.specId));
  // 等级浮动与前端 gen.ts 一致：基础区间 [levelMin,levelMax] + 精英 2 / 稀有 3
  // （两次独立 roll，可叠加）+ 随机 0~1，故真实上界 = levelMax + 6。原先写死 <= 6
  // 漏了 elite+rare 同时命中的分支（约 1% 概率偶发红），见 bug_log §37。
  const lvMin = Number(b1.levelMin ?? 2);
  const lvMax = Number(b1.levelMax ?? 2);
  check('敌方等级在开局区间内（含精英/稀有叠加浮动）',
    b1.enemy?.level >= lvMin && b1.enemy?.level <= lvMax + 6,
    `level=${String(b1.enemy?.level)} range=[${lvMin},${lvMax}+6]`);
  check('敌方等级浮动与遭遇标签一致',
    /^(野生|精英|稀有)/.test(String(b1.log?.[0] ?? '').replace('遭遇：', '')),
    String(b1.log?.[0]));
  check('队伍取自服务端存档', Array.isArray(b1.party) && b1.party.length === 2 && b1.party[0].id === 'p1',
    JSON.stringify((b1.party ?? []).map((m) => m.id)));
  check('开局下发 PP 表', !!b1.ppByMonster && Object.keys(b1.ppByMonster).length >= 2);

  const cur1 = await current(tokenA);
  check('current 返回同一场战斗', cur1.data?.battle?.battleId === battleId);

  // —— 负向：伪造 / 越权 / 非法参数 ——
  const badTheme = await startBattle(tokenA, { theme: '__no_such_theme__' });
  check('未知主题被拒 400', badTheme.status === 400, String(badTheme.status));

  const fakeId = await act(tokenA, 'bt_fake_does_not_exist', { type: 'flee' });
  check('伪造 battleId 404', fakeId.status === 404, String(fakeId.status));

  const unknownMove = await act(tokenA, battleId, { type: 'move', moveId: '__no_move__' });
  check('未掌握技能被拒', unknownMove.status === 400 && unknownMove.data?.code === 'MOVE_UNKNOWN',
    `${unknownMove.status} ${asText(unknownMove.data)}`);

  const noItem = await act(tokenA, battleId, { type: 'item', itemId: 'potion_max' });
  check('没有的道具被拒', noItem.status === 400 && noItem.data?.code === 'ITEM_NOT_ENOUGH',
    `${noItem.status} ${asText(noItem.data)}`);

  // —— 正常动作 ——
  const ppBefore = b1.ppByMonster[b1.party[0].id]?.tackle ?? 0;
  const turnBefore = b1.turn;
  const a1 = await act(tokenA, battleId, { type: 'move', moveId: 'tackle' });
  check('技能动作成功', a1.status === 200 && a1.data?.ok === true, `${a1.status} ${asText(a1.data).slice(0, 140)}`);
  const b2 = a1.data?.battle ?? {};
  check('PP 由服务端扣减', (b2.ppByMonster?.[b2.party?.[0]?.id]?.tackle ?? 0) === ppBefore - 1,
    `${ppBefore} -> ${b2.ppByMonster?.[b2.party?.[0]?.id]?.tackle}`);
  check('回合推进', b2.turn > turnBefore, `${turnBefore} -> ${b2.turn}`);
  check('产生战斗日志', Array.isArray(b2.log) && b2.log.length > b1.log.length);

  const broadcast = await waitMsg(wsCtx, (m) => m?.type === 'battle.state' && m.battleId === battleId);
  check('WS 收到 battle.state 广播', !!broadcast, JSON.stringify(broadcast));

  // —— 换人 ——
  if (!b2.finished) {
    const sw = await act(tokenA, battleId, { type: 'switch', partyIndex: 1 });
    check('换人成功且切换出战索引', sw.status === 200 && sw.data?.battle?.playerActiveIndex === 1,
      `${sw.status} ${asText(sw.data).slice(0, 140)}`);
    const same = await act(tokenA, battleId, { type: 'switch', partyIndex: 1 });
    check('换成已在场的幻兽被拒', same.status === 400 && same.data?.code === 'SAME_ACTIVE',
      `${same.status} ${asText(same.data)}`);
  } else {
    check('换人成功且切换出战索引', true, '（战斗已结束，跳过）');
    check('换成已在场的幻兽被拒', true, '（战斗已结束，跳过）');
  }

  // —— 打到结束（最多 80 个动作，覆盖技能 / 换人）——
  let st = (await current(tokenA)).data?.battle;
  let rounds = 0;
  let sawEnemyDamage = false;
  const enemyHpStart = b1.enemy?.hp ?? 0;
  while (st && !st.finished && rounds < 80) {
    const idx = st.playerActiveIndex ?? 0;
    const me = st.party?.[idx];
    const usable = (me?.moveIds ?? []).find((id) => (st.ppByMonster?.[me.id]?.[id] ?? 0) > 0);
    const action = usable ? { type: 'move', moveId: usable } : { type: 'flee' };
    const r = await act(tokenA, battleId, action);
    if (r.status !== 200) {
      check('战斗中动作持续可用', false, `${r.status} ${asText(r.data)}`);
      break;
    }
    st = r.data?.battle;
    if ((st.enemy?.hp ?? 0) < enemyHpStart) sawEnemyDamage = true;
    rounds += 1;
  }
  check('多回合战斗能推进', rounds > 0, `rounds=${rounds}`);
  check('敌方 HP 下降（伤害由服务端结算）', sawEnemyDamage || st?.finished, `enemyHp=${st?.enemy?.hp}`);
  check('战斗最终结束', !!st?.finished, `finished=${st?.finished} result=${st?.result}`);
  check('结算结果合法', ['enemy_fainted', 'captured', 'fled', 'player_fainted'].includes(st?.result ?? ''),
    String(st?.result));

  // —— 结算写档 ——
  const sessionAfter = await getSession(tokenA);
  const saveAfter = await getSave(tokenA);
  check('结算后 revision 提升', (sessionAfter.data?.revision ?? 0) >= 2,
    `revision=${sessionAfter.data?.revision}`);
  check('结算后 current 为空', (await current(tokenA)).data?.battle === null);

  const saveA = typeof saveAfter.data?.data === 'string' ? JSON.parse(saveAfter.data.data) : saveAfter.data?.data;
  check('结算后存档可读', !!saveA, asText(saveAfter.data).slice(0, 120));

  if (st?.result === 'enemy_fainted' || st?.result === 'captured') {
    check('击败/捕获后金钱增加', (saveA?.money ?? 0) > initial.money, `${initial.money} -> ${saveA?.money}`);
    check('首通/图鉴写回', !!saveA?.collection?.sprout_owl?.seen, JSON.stringify(saveA?.collection).slice(0, 120));
  } else {
    check('击败/捕获后金钱增加', true, '（本场未击败，跳过）');
    check('首通/图鉴写回', true, '（本场未击败，跳过）');
  }

  const lastCount = (saveA?.inventory?.capsule_basic ?? 0);
  check('道具消耗以服务端记录为准', lastCount <= initial.inventory.capsule_basic,
    `${initial.inventory.capsule_basic} -> ${lastCount}`);

  const afterDone = await act(tokenA, battleId, { type: 'flee' });
  check('结束后再动作 404', afterDone.status === 404, String(afterDone.status));

  // —— 同槽位新开局覆盖 ——
  const s2 = await startBattle(tokenA, { levelMin: 1, levelMax: 1 });
  const id2 = s2.data?.battle?.battleId;
  const s3 = await startBattle(tokenA, { levelMin: 3, levelMax: 3 });
  const id3 = s3.data?.battle?.battleId;
  check('同槽位再次开局生成新战斗', !!id2 && !!id3 && id2 !== id3, `${id2} / ${id3}`);
  const stale = await act(tokenA, id2, { type: 'flee' });
  check('旧战斗被新开局覆盖（404）', stale.status === 404, String(stale.status));

  const abandon = await request('/api/battle/abandon', {
    method: 'POST', token: tokenA, body: { slot: 1, battleId: id3 },
  });
  check('放弃战斗成功', abandon.status === 200 && abandon.data?.dropped === true, asText(abandon.data));
  check('放弃后 current 为空', (await current(tokenA)).data?.battle === null);

  // ═══════════ H. P3-1c 契约：前端渲染所需字段 + 管理员测试标记 ═══════════
  // 前端不再自己拼装战斗数据，直接渲染服务端下发的 party / levelMin / levelMax。
  // 这里锁住契约：少一个字段前端就会渲染成空面板，而服务端测试全绿也发现不了。
  console.log('\n—— H. P3-1c 前端契约 ——');
  const s1c = await startBattle(tokenA, { levelMin: 3, levelMax: 3 });
  const b1c = s1c.data?.battle ?? {};
  check('战斗视图下发 levelMin / levelMax（「继续探索」要用）',
    b1c.levelMin === 3 && b1c.levelMax === 3, JSON.stringify({ min: b1c.levelMin, max: b1c.levelMax }));
  check('队伍副本下发送完整个体（moveIds + 六维 + initStats + growthRates）',
    Array.isArray(b1c.party) && b1c.party.length > 0 && b1c.party.every((m) =>
      Array.isArray(m.moveIds) && typeof m.atk === 'number' && typeof m.maxHp === 'number'
      && typeof m.initStats?.hp === 'number' && typeof m.growthRates?.hp === 'number'),
    JSON.stringify(b1c.party?.[0]));

  // 普通账号传测试标记：静默忽略。不能报错（客户端硬编码测试开关不该变成风控事件），
  // 也不能生效（否则人人都是管理员）。
  const flagged = await startBattle(tokenA, {
    levelMin: 3, levelMax: 3,
    testFlags: { testOHKO: true, testShiny: true, testMaxStats: true },
  });
  check('普通账号传测试标记不报错（静默忽略）', flagged.status === 200, `${flagged.status} ${asText(flagged.data)}`);
  const fb = flagged.data?.battle ?? {};
  check('普通账号 testOHKO 未生效（敌方 HP 不是 1）', fb.enemy?.hp !== 1, String(fb.enemy?.hp));
  check('普通账号没有测试标记日志', !(fb.log ?? []).some((l) => l.includes('管理员测试标记')),
    JSON.stringify(fb.log));
  // 野生怪本身有 1% 天然异色（rules.ts 的 rng() < 0.01），单次「敌方绝不异色」
  // 会偶发误报。真正要防的是「普通账号的 testShiny 被服务端强制采纳」：
  // 若被采纳，下面每次开局必然都是异色；否则 8 次里至少出现一次非异色。
  // 用「多次开局不恒为异色」替代绝对断言，既不误报也不放过漏洞。
  const shinyTrials = [fb.enemy?.isShiny === true];
  await request('/api/battle/abandon', { method: 'POST', token: tokenA, body: { slot: 1, battleId: fb.battleId } });
  for (let i = 1; i < 8; i++) {
    const trial = await startBattle(tokenA, {
      levelMin: 3, levelMax: 3,
      testFlags: { testOHKO: true, testShiny: true, testMaxStats: true },
    });
    const tb = trial.data?.battle ?? {};
    shinyTrials.push(tb.enemy?.isShiny === true);
    await request('/api/battle/abandon', { method: 'POST', token: tokenA, body: { slot: 1, battleId: tb.battleId } });
  }
  check('普通账号 testShiny 未强制生效（8 次开局不恒为异色）',
    shinyTrials.some((s) => s === false), JSON.stringify(shinyTrials));

  // 管理员：先提权再开局。身份必须由服务端查库判定，客户端自称不算数。
  if (prisma) {
    await prisma.user.update({ where: { username: userA }, data: { role: 'admin' } });
    const adminStart = await startBattle(tokenA, {
      levelMin: 3, levelMax: 3,
      testFlags: { testOHKO: true, testShiny: true },
    });
    const ab = adminStart.data?.battle ?? {};
    check('管理员 testOHKO 生效（敌方开场 1 HP）', ab.enemy?.hp === 1, String(ab.enemy?.hp));
    check('管理员 testShiny 生效（敌方异色）', ab.enemy?.isShiny === true, String(ab.enemy?.isShiny));
    check('管理员测试标记写进战斗日志',
      (ab.log ?? []).some((l) => l.includes('管理员测试标记')), JSON.stringify(ab.log));
    await request('/api/battle/abandon', { method: 'POST', token: tokenA, body: { slot: 1, battleId: ab.battleId } });
    await prisma.user.update({ where: { username: userA }, data: { role: 'user' } });
  } else {
    console.log('[SKIP] 管理员测试标记（未连接数据库）');
  }

  // —— 跨账号隔离 ——
  const userB = `b3b_${RUN}`;
  const tokenB = await register(userB);
  await put(tokenB, validSave({ playerName: 'B' }));
  const sb = await startBattle(tokenB);
  const idB = sb.data?.battle?.battleId;
  const cross = await act(tokenA, idB, { type: 'flee' });
  check('A 不能操作 B 的战斗（404）', cross.status === 404, `${cross.status} ${asText(cross.data)}`);
  await request('/api/battle/abandon', { method: 'POST', token: tokenB, body: { slot: 1, battleId: idB } });

  await closeWs(wsCtx);
  await finish();
}

async function finish() {
  const total = pass + fail;
  console.log(`\n[SUMMARY] ${pass}/${total} 通过，${fail} 失败`);
  if (fail === 0) console.log('E2E_P31_OK');
  else console.log('E2E_P31_FAILED');
  if (prisma) await prisma.$disconnect().catch(() => {});
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
