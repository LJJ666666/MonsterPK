/**
 * P3-2 服务端存档写操作端到端验证（需后端已在 :3001 运行）。
 * 运行：cd backend && npm run e2e:p32
 *
 * 覆盖：治疗 / 战斗外道具 / 进化 / 学招 / 队伍整理 / 移动
 *  - 服务端判定：没有恢复中心不能回满、道具不足、状态不匹配、进化条件不符一律 400
 *  - 服务端写档：返回的 data 与 GET /api/save 一致，revision 单调递增
 *  - 权威收口：服务端写完后，客户端再自己 PUT 一个更富的档会被 AUTHORITY_MISMATCH 拒
 *  - 战斗中禁止动存档（BATTLE_IN_PROGRESS）
 *  - 实时：写操作通过 WS 广播 session.state（source='action'）
 * 输出：逐例 [PASS]/[FAIL]，末尾 E2E_P32_OK；任一失败 exit 1。
 */
import WebSocket from 'ws';

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
const asText = (o) => (typeof o === 'string' ? o : JSON.stringify(o));

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

function mon(id, specId, overrides = {}) {
  return {
    id, specId, level: 9, exp: 12,
    element: 'grass', maxHp: 72, hp: 72,
    atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90,
    status: 'none', moveIds: ['tackle'],
    initStats: STATS, growthRates: GROWTH, isShiny: false,
    ...overrides,
  };
}

function validSave(overrides = {}) {
  return {
    version: '10',
    playerName: '写操作测试员',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    // P3-2 之后「新增幻兽」只能由服务端产生（捕获/新档），所以三只初始幻兽一次建好：
    // p1 用来测治疗/学招，p2 测道具进化，p3 测等级进化与队伍整理。
    party: [
      mon('p1', 'sprout_owl', { hp: 20 }),
      mon('p2', 'spark_mouse', { element: 'electric' }),
      mon('p3', 'spark_mouse', { element: 'electric' }),
    ],
    box: [],
    inventory: { potion_small: 3, heal_antidote: 1, stone_thunder: 1, stone_fire: 1, capsule_basic: 6 },
    collection: {},
    clearedAreas: {},
    lastSavedAt: recentIso(),
    ...overrides,
  };
}

const put = (token, data, extra = {}) =>
  request('/api/save?slot=1', { method: 'PUT', token, body: { data: asText(data), ...extra } });
const getSave = (token) => request('/api/save?slot=1', { token });
const op = (token, name, body = {}) =>
  request(`/api/game/${name}`, { method: 'POST', token, body: { slot: 1, ...body } });

function openWs(token) {
  return new Promise((resolve, reject) => {
    const url = new URL('/ws', WS_HOST);
    url.searchParams.set('token', token);
    const ws = new WebSocket(url.toString(), { headers: { Origin: ORIGIN }, handshakeTimeout: 5_000 });
    const ctx = { ws, queue: [] };
    ws.on('message', (d) => {
      try { ctx.queue.push(JSON.parse(d.toString())); } catch { /* ignore */ }
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

const parseData = (res) => {
  try { return JSON.parse(res.data?.data ?? 'null'); } catch { return null; }
};

async function main() {
  console.log(`[INFO] 账号前缀 b32_${RUN}`);

  // —— 新档由服务端生成（P3-2b）——
  const ngToken = await register(`b32n_${RUN}`);
  const ng1 = await op(ngToken, 'new_game', { playerName: '杰哥', starterSpecId: 'sprout_owl' });
  const ngData = parseData(ng1);
  check('服务端生成新档 200', ng1.status === 200 && ngData?.party?.length === 1,
    `${ng1.status} ${asText(ng1.data).slice(0, 120)}`);
  check('初始幻兽由服务端掷（5 级御三家）',
    ngData?.party?.[0]?.level === 5 && ngData?.party?.[0]?.specId === 'sprout_owl',
    JSON.stringify({ level: ngData?.party?.[0]?.level, specId: ngData?.party?.[0]?.specId }));
  check('初始资源符合模板', ngData?.money === 0 && ngData?.inventory?.capsule_basic === 6,
    JSON.stringify({ money: ngData?.money, capsule: ngData?.inventory?.capsule_basic }));
  const ngSelf = await getSave(ngToken);
  check('新档已在服务端落库', ngSelf.status === 200 && JSON.parse(ngSelf.data.data).playerName === '杰哥',
    `${ngSelf.status}`);
  const ngAgain = await op(ngToken, 'new_game', { playerName: 'x', starterSpecId: 'sprout_owl' });
  check('已有存档时拒绝覆盖（409）', ngAgain.status === 409 && ngAgain.data?.code === 'SAVE_EXISTS',
    `${ngAgain.status} ${asText(ngAgain.data)}`);
  const ngBad = await op(ngToken, 'new_game', { playerName: 'x', starterSpecId: 'thunder_rat', overwrite: true });
  check('非法初始幻兽被拒', ngBad.status === 400 && ngBad.data?.code === 'STARTER_INVALID',
    `${ngBad.status} ${asText(ngBad.data)}`);

  const token = await register(`b32_${RUN}`);
  check('账号注册成功', !!token);
  if (!token) return finish();

  const first = await put(token, validSave());
  check('初始存档写入 200', first.status === 200, `${first.status} ${asText(first.data).slice(0, 120)}`);

  // —— 未登录 / 未知操作 ——
  const anon = await request('/api/game/heal', { method: 'POST', body: { slot: 1 } });
  check('未登录调用写操作 401', anon.status === 401, String(anon.status));
  const badOp = await op(token, 'not_an_op');
  check('未知操作返回 400/OP_UNKNOWN', badOp.status === 400 && badOp.data?.code === 'OP_UNKNOWN',
    `${badOp.status} ${asText(badOp.data)}`);

  // —— 治疗 ——
  const wsCtx = await openWs(token);
  await waitMsg(wsCtx, (m) => m?.type === 'hello');

  const heal1 = await op(token, 'heal');
  const healed = parseData(heal1);
  check('治疗返回 200', heal1.status === 200, `${heal1.status} ${asText(heal1.data).slice(0, 120)}`);
  check('治疗由服务端回满（hp = maxHp）', healed?.party?.[0]?.hp === healed?.party?.[0]?.maxHp,
    JSON.stringify(healed?.party?.[0]));
  check('治疗返回 revision', typeof heal1.data?.revision === 'number' && heal1.data.revision > 0,
    String(heal1.data?.revision));

  const snap = await waitMsg(wsCtx, (m) => m?.type === 'session.state' && m?.source === 'action');
  check('写操作广播 session.state(source=action)', !!snap, JSON.stringify(snap)?.slice(0, 160));

  const persisted = await getSave(token);
  const persistedData = (() => { try { return JSON.parse(persisted.data?.data ?? 'null'); } catch { return null; } })();
  check('服务端已落库（GET 与返回一致）', persistedData?.party?.[0]?.hp === healed?.party?.[0]?.hp,
    `${persistedData?.party?.[0]?.hp} vs ${healed?.party?.[0]?.hp}`);
  check('治疗更新 lastHealLocationId', persistedData?.lastHealLocationId === 'town_starter',
    String(persistedData?.lastHealLocationId));

  // 非法地点
  await put(token, { ...persistedData, locationId: 'nowhere', lastHealLocationId: 'nowhere' });
  const healBad = await op(token, 'heal');
  check('不在恢复中心时治疗被拒', healBad.status === 400 && healBad.data?.code === 'NO_HEAL_CENTER',
    `${healBad.status} ${asText(healBad.data)}`);
  await put(token, { ...persistedData, locationId: 'town_starter', lastHealLocationId: 'town_starter' });

  // —— 战斗外道具 ——
  const cur = (await getSave(token)).data?.data ? JSON.parse((await getSave(token)).data.data) : null;
  // 只把首发 HP 压到 10，其余成员原样保留（减少成员会被当成「放生」，不可逆）。
  const before = { ...cur, party: cur.party.map((m, i) => (i === 0 ? { ...m, hp: 10 } : m)) };
  const beforePut = await put(token, before);
  check('压低 HP 的档可写入（变差不拦）', beforePut.status === 200,
    `${beforePut.status} ${asText(beforePut.data).slice(0, 140)}`);

  const use1 = await op(token, 'use_item', { itemId: 'potion_small', monsterId: 'p1' });
  const used = parseData(use1);
  check('战斗外回血 200', use1.status === 200, `${use1.status} ${asText(use1.data).slice(0, 120)}`);
  check('回血结果由服务端计算', used?.party?.[0]?.hp > 10, String(used?.party?.[0]?.hp));
  check('道具被扣 1', used?.inventory?.potion_small === 2, String(used?.inventory?.potion_small));

  const noItem = await op(token, 'use_item', { itemId: 'potion_max', monsterId: 'p1' });
  check('没有的道具被拒', noItem.status === 400 && noItem.data?.code === 'ITEM_NOT_ENOUGH',
    `${noItem.status} ${asText(noItem.data)}`);

  const antidoteBad = await op(token, 'use_item', { itemId: 'heal_antidote', monsterId: 'p1' });
  check('状态不匹配时解药被拒', antidoteBad.status === 400 && antidoteBad.data?.code === 'STATUS_NOT_MATCH',
    `${antidoteBad.status} ${asText(antidoteBad.data)}`);

  const ghost = await op(token, 'use_item', { itemId: 'potion_small', monsterId: 'ghost' });
  check('目标不存在被拒', ghost.status === 400 && ghost.data?.code === 'MONSTER_NOT_FOUND',
    `${ghost.status} ${asText(ghost.data)}`);

  // —— 进化石 ——
  const evo1 = await op(token, 'use_item', { itemId: 'stone_thunder', monsterId: 'p2' });
  const evolved = parseData(evo1);
  check('进化石由服务端判定并进化', evo1.status === 200 && evolved?.party?.[1]?.specId === 'thunder_rat',
    `${evo1.status} ${evolved?.party?.[1]?.specId} ${asText(evo1.data).slice(0, 120)}`);
  check('进化扣掉石头', (evolved?.inventory?.stone_thunder ?? 0) === 0, String(evolved?.inventory?.stone_thunder));
  check('进化登记图鉴', evolved?.collection?.thunder_rat?.captured === true,
    JSON.stringify(evolved?.collection?.thunder_rat));
  check('进化不增加捕获次数', (evolved?.collection?.thunder_rat?.timesCaptured ?? -1) === 0,
    String(evolved?.collection?.thunder_rat?.timesCaptured));

  const wrongStone = evolved;
  const evoBad = await op(token, 'use_item', { itemId: 'stone_fire', monsterId: 'p1' });
  check('不适用的进化石被拒', evoBad.status === 400 && evoBad.data?.code === 'EVOLUTION_NOT_APPLICABLE',
    `${evoBad.status} ${asText(evoBad.data)}`);

  // —— 等级进化（p3）——
  const pending = JSON.parse(JSON.stringify(wrongStone));
  pending.party[2].pendingEvolution = { targetId: 'thunder_rat', condition: { type: 'level', level: 16 } };
  const pendingPut = await put(token, pending);
  check('待进化状态可写入（不改变持有数）', pendingPut.status === 200,
    `${pendingPut.status} ${asText(pendingPut.data).slice(0, 140)}`);
  const evo2 = await op(token, 'evolve', { monsterId: 'p3', accept: true });
  const evo2Data = parseData(evo2);
  check('等级进化由服务端执行', evo2.status === 200 && evo2Data?.party?.[2]?.specId === 'thunder_rat',
    `${evo2.status} ${evo2Data?.party?.[2]?.specId}`);
  check('进化后清空待进化标记', !evo2Data?.party?.[2]?.pendingEvolution,
    JSON.stringify(evo2Data?.party?.[2]?.pendingEvolution));

  const forged = JSON.parse(JSON.stringify(evo2Data));
  forged.party[0].pendingEvolution = { targetId: 'titan_golem', condition: { type: 'level', level: 16 } };
  await put(token, forged);
  const evoForge = await op(token, 'evolve', { monsterId: 'p1', accept: true });
  check('伪造进化目标被拒', evoForge.status === 400 && evoForge.data?.code === 'EVOLUTION_TARGET_INVALID',
    `${evoForge.status} ${asText(evoForge.data)}`);

  // —— 学招（p1）——
  const learnBase = JSON.parse(JSON.stringify(evo2Data));
  learnBase.party[0].pendingMoves = ['ice_beam'];
  learnBase.party[0].moveIds = ['tackle'];
  await put(token, learnBase);
  const learn = await op(token, 'learn_move', { monsterId: 'p1', newMoveId: 'ice_beam', oldMoveId: null });
  const learnData = parseData(learn);
  check('学招由服务端执行', learn.status === 200 && learnData?.party?.[0]?.moveIds?.includes('ice_beam'),
    `${learn.status} ${JSON.stringify(learnData?.party?.[0]?.moveIds)}`);

  const moveBad = await op(token, 'learn_move', { monsterId: 'p1', newMoveId: 'hyper_beam', oldMoveId: null });
  check('学不到的技能被拒', moveBad.status === 400 && moveBad.data?.code === 'MOVE_NOT_PENDING',
    `${moveBad.status} ${asText(moveBad.data)}`);

  const discardBase = JSON.parse(JSON.stringify(learnData));
  discardBase.party[0].pendingMoves = ['ice_beam'];
  await put(token, discardBase);
  const movesBeforeDiscard = (discardBase.party[0].moveIds ?? []).join(',');
  const discard = await op(token, 'learn_move', { monsterId: 'p1', newMoveId: 'ice_beam', discard: true });
  const discardData = parseData(discard);
  check('放弃学习只清待学标记', discard.status === 200
    && (discardData?.party?.[0]?.pendingMoves ?? []).length === 0
    && (discardData?.party?.[0]?.moveIds ?? []).join(',') === movesBeforeDiscard,
    `${discard.status} pending=${JSON.stringify(discardData?.party?.[0]?.pendingMoves)} moves=${JSON.stringify(discardData?.party?.[0]?.moveIds)}`);

  // —— 队伍整理 ——
  // 「最后一只不能下放」用独立账号（队伍只有 1 只）：减少成员在普通 PUT 里是允许的（自损），
  // 拿主账号测会真的把幻兽删掉，再也补不回来。
  const soloName = `b32s_${RUN}`;
  const soloToken = await register(soloName);
  const soloSave = validSave({ party: [mon('s1', 'sprout_owl')] });
  await put(soloToken, soloSave);
  const boxBad = await op(soloToken, 'move_to_box', { partyIndex: 0 });
  check('最后一只不能下放', boxBad.status === 400 && boxBad.data?.code === 'PARTY_TOO_SMALL',
    `${boxBad.status} ${asText(boxBad.data)}`);
  const releaseBad = await op(soloToken, 'release', { monsterId: 's1' });
  check('最后一只不能放生', releaseBad.status === 400 && releaseBad.data?.code === 'PARTY_TOO_SMALL',
    `${releaseBad.status} ${asText(releaseBad.data)}`);

  const boxed = await op(token, 'move_to_box', { partyIndex: 2 });
  const boxedData = parseData(boxed);
  check('下放到箱子由服务端执行', boxed.status === 200 && boxedData?.party?.length === 2 && boxedData?.box?.length === 1,
    `${boxed.status} party=${boxedData?.party?.length} box=${boxedData?.box?.length}`);

  const back = await op(token, 'move_to_party', { boxIndex: 0 });
  const backData = parseData(back);
  check('移回队伍由服务端执行', back.status === 200 && backData?.party?.length === 3 && backData?.box?.length === 0,
    `${back.status} party=${backData?.party?.length}`);

  const released = await op(token, 'release', { monsterId: 'p3' });
  const releasedData = parseData(released);
  check('放生由服务端执行', released.status === 200 && releasedData?.party?.length === 2,
    `${released.status} party=${releasedData?.party?.length}`);

  // —— 移动 ——
  const travelBad = await op(token, 'travel', { locationId: 'atlantis' });
  check('未知地点被拒', travelBad.status === 400 && travelBad.data?.code === 'LOCATION_UNKNOWN',
    `${travelBad.status} ${asText(travelBad.data)}`);
  const travelOk = await op(token, 'travel', { locationId: 'city_pebble' });
  const travelData = parseData(travelOk);
  check('移动到合法地点', travelOk.status === 200 && travelData?.locationId === 'city_pebble',
    `${travelOk.status} ${travelData?.locationId}`);
  check('访问记录由服务端追加', (travelData?.visitedLocationIds ?? []).includes('city_pebble'),
    JSON.stringify(travelData?.visitedLocationIds));

  // —— 权威收口：客户端自己 PUT 更富的档必被拒 ——
  const richer = JSON.parse(JSON.stringify(travelData));
  richer.money = richer.money + 5000;
  const cheat = await put(token, richer);
  check('客户端自造资源被 AUTHORITY_MISMATCH 拒',
    cheat.status === 400 && cheat.data?.code === 'AUTHORITY_MISMATCH',
    `${cheat.status} ${asText(cheat.data)}`);

  // 直接改 HP 回满（不通过服务端）也应被拒：资源没有变富，但摘要变了 —— 需要确认服务端口径
  const cheatHp = JSON.parse(JSON.stringify(travelData));
  cheatHp.party[0].hp = cheatHp.party[0].maxHp;
  const cheatHpRes = await put(token, cheatHp);
  check('客户端自改 HP 不被服务端接受', cheatHpRes.status === 400,
    `${cheatHpRes.status} ${asText(cheatHpRes.data).slice(0, 140)}`);

  // —— 战斗中禁止动存档 ——
  const afterCheat = await getSave(token);
  const fresh = JSON.parse(afterCheat.data.data);
  fresh.party[0].hp = fresh.party[0].maxHp;
  await put(token, fresh); // 先把 HP 恢复（服务端已回满，这里提交一致档）

  const start = await request('/api/battle/start', {
    method: 'POST', token,
    body: { slot: 1, theme: 'grass', areaName: '初始草原', areaId: null, levelMin: 2, levelMax: 2 },
  });
  check('开局成功（用于验证战斗中禁写）', start.status === 200 && !!start.data?.battle?.battleId,
    `${start.status} ${asText(start.data).slice(0, 120)}`);
  const inBattle = await op(token, 'heal');
  check('战斗中治疗被拒', inBattle.status === 400 && inBattle.data?.code === 'BATTLE_IN_PROGRESS',
    `${inBattle.status} ${asText(inBattle.data)}`);
  const inBattleItem = await op(token, 'use_item', { itemId: 'potion_small', monsterId: 'p1' });
  check('战斗中用药被拒', inBattleItem.status === 400 && inBattleItem.data?.code === 'BATTLE_IN_PROGRESS',
    `${inBattleItem.status} ${asText(inBattleItem.data)}`);
  await request('/api/battle/abandon', {
    method: 'POST', token,
    body: { slot: 1, battleId: start.data.battle.battleId },
  });

  // —— revision 单调递增 ——
  const r1 = (await op(token, 'heal')).data?.revision;
  const r2 = (await op(token, 'heal')).data?.revision;
  check('revision 单调递增', typeof r1 === 'number' && typeof r2 === 'number' && r2 === r1 + 1,
    `${r1} -> ${r2}`);

  await closeWs(wsCtx);
  return finish();
}

async function finish() {
  const total = pass + fail;
  console.log(`\n[SUMMARY] ${pass}/${total} 通过，${fail} 失败`);
  if (fail === 0) console.log('E2E_P32_OK');
  else console.log('E2E_P32_FAILED');
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error('[FATAL]', err);
  process.exit(1);
});
