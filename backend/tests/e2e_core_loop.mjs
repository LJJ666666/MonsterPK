/**
 * 核心循环串联 E2E（2026-11-11）。
 *
 * 目的：用同一个账号把游戏主玩法一条龙跑通，验证跨模块状态累积的一致性
 * （等级 / 徽章 / 金钱 / 队伍 / 伤害事件计数），并确认任一模块结算不会
 * 破坏另一模块的状态。这不是各模块的边界用例（那些由 e2e_f18a/b/c、e2e_p42c、
 * e2e_f16 等覆盖），而是「playthrough」级别的串联。
 *
 * 串联顺序：
 *   1) 野怪捕获   capture 一只 wild_starter 野怪（满血反复抛球，不误杀）→ party+1 / collection 更新
 *                注意：捕获不发放经验/金钱（只有 enemy_fainted 才发），但会触发「首通野区」徽章（V1 口径）。
 *   2) 演武堂     town_starter 胜馆主 → 幂等发 badge_sprout（捕获首通已发过则为 already，不双计）
 *                → travel 到 city_pebble 由 400 变为 200（徽章解锁）。
 *   3) 每日 Boss  ember_behemoth 一胜 → 记 BossDamageEvent(used=1) / F14 双档奖励（金钱+棱彩胶囊）/ 上榜。
 *   4) 地图首领   mb_starter_guardian 一胜 → 记 BossDamageEvent(bossId=mapBoss, used=1) / 3×经验 / 5×金钱 / 掉落，
 *                经验/金钱比是「计算出的奖励值」（高等级宠物超帽冻结只影响实际到账，不影响奖励数值）。
 *   5) 共斗       hero=房主 + guest=第二账号，六房全清 → hero 获通关奖励（+40 金钱 / +capsule_basic×1）。
 *
 * 不变量断言：
 *   - 等级 = 5 + 5×徽章数（本流程 1 枚 → 10）；经验到达等级帽只冻不降（不依赖宠物经验到账验证）。
 *   - 队伍长度 = 2（起步）+ 1（捕获）= 3。
 *   - hero 的 BossDamageEvent 计数 = 2（每日Boss 1 + 地图首领 1），且两者不串味（不同 bossId）。
 *   - 每个模块结算后，其它模块的关键状态未被篡改（徽章/等级/队伍保持）。
 *
 * 注意：徽章与等级不在存档 JSON 顶层存储，走服务端 BadgeGrant 表派生；本套件一律通过
 * `GET /api/player/progress` 读取，绝不断言 `save.badges` / `save.level`。
 *
 * 运行：cd backend && npm run e2e:core_loop（需要 :3001 后端在线）
 * 也可经 npm run verify 自动纳入（见 scripts/verify.mjs 的 e2e 分组）。
 */
import {
  Suite, api, asText, newAccount, cleanupAccounts, requireBackend, validSave, save,
  openWs, closeWs, sleep, formatFatal } from './lib/harness.mjs';

const s = new Suite('E2E_CORE_LOOP');
const names = [];

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };

// 强档成员：负责演武堂 / 每日Boss / 地图首领 / 共斗，确保稳定通关。
const STRONG = {
  id: 'core_strong', specId: 'sprout_owl', level: 40, exp: 0,
  element: 'grass', maxHp: 400, hp: 400,
  atk: 500, def: 300, spAtk: 500, spDef: 300, spd: 300,
  status: 'none', moveIds: ['tackle', 'wood_strike'],
  initStats: STATS, growthRates: GROWTH, isShiny: false,
};
// 第二只强宠：前面只占位、不参与捕获（捕获由 index 0 执行）；共斗时作替补。
// 共斗敌人按 rng 生成、canMove / 命中 / 状态也吃 RNG，回合一旦拖长，
// 「1 强 + 弱占位」的队伍会被反杀（round19 抓到 result=lose / cleared=3）。
// 与 e2e_f16 的「6 只全强宠」同口径，把胜负从 RNG 手里拿回来。
const WEAK = {
  id: 'core_weak', specId: 'spark_mouse', level: 40, exp: 0,
  element: 'electric', maxHp: 400, hp: 400,
  atk: 500, def: 300, spAtk: 500, spDef: 300, spd: 300,
  status: 'none', moveIds: ['tackle'],
  initStats: STATS, growthRates: GROWTH, isShiny: false,
};
// 捕获每抛一球消耗一个 capsule_basic，给足数量避免中途 ITEM_NOT_ENOUGH。
const HERO_SAVE = () => validSave({
  money: 5000,
  party: [STRONG, WEAK],
  inventory: { capsule_basic: 60, potion_small: 3 },
});

const AREA = 'wild_starter';
const GYM_LOC = 'town_starter';
const BOSS = 'boss_ember_behemoth';
const MAPBOSS = 'mb_starter_guardian';

/** GET /api/save 的 data 是 JSON 字符串（DB String 列），需要解析才能读 money/inventory/party。 */
function saveDataOf(res) {
  const raw = res?.data?.data ?? res?.data?.save;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}

/** 只读进度：等级 / 徽章数 / 徽章列表（服务端 BadgeGrant 派生，存档顶层无这些字段）。 */
async function progressOf(token) {
  const r = await api('/api/player/progress', { token });
  return r.data?.progress ?? null;
}

const act = (token, battleId, action) =>
  api('/api/battle/action', { method: 'POST', token, body: { battleId, action } });
const current = (token) => api('/api/battle/current', { token });

/** 把一场战斗打到结束（优先用有 PP 的技能），返回最后一份 battle 视图与结算附带的结果。 */
async function playToEnd(token, battleId, maxRounds = 80) {
  let st = (await current(token)).data?.battle;
  let rounds = 0;
  let extra = null;
  while (st && !st.finished && rounds < maxRounds) {
    const idx = st.playerActiveIndex ?? 0;
    const me = st.party?.[idx];
    const usable = (me?.moveIds ?? []).find((id) => (st.ppByMonster?.[me.id]?.[id] ?? 0) > 0);
    const action = usable ? { type: 'move', moveId: usable } : { type: 'flee' };
    const r = await act(token, battleId, action);
    if (r.status !== 200) { s.check('战斗中动作持续可用', false, `${r.status} ${asText(r.data)}`); break; }
    st = r.data?.battle;
    if (r.data?.boss) extra = r.data.boss;
    if (r.data?.mapBoss) extra = r.data.mapBoss;
    if (r.data?.gym) extra = r.data.gym;
    rounds += 1;
  }
  return { st, extra, rounds };
}

const post = (token, path, body = {}) => api(path, { method: 'POST', token, body });
const get = (token, path) => api(path, { token });

// —— 共斗：照搬 e2e_f16 的推进与发奖轮询范式 ——
const COOP_BOSS = 'boss_ember_behemoth';
const COOP_REWARD_MONEY = 40;

/** 轮询存档直到满足谓词（奖励写档多为异步，避免固定 sleep 抖动）。 */
async function pollSave(token, pred, tries = 30) {
  for (let i = 0; i < tries; i += 1) {
    const sv = saveDataOf(await save.get(token));
    if (sv && pred(sv)) return sv;
    await sleep(200);
  }
  return saveDataOf(await save.get(token));
}

function intentFor(coop) {
  if (!coop || coop.finished || coop.self?.out) return 'idle';
  if (coop.self?.roomIndex >= 0) return 'move:tackle';
  const target = coop.rooms.find((r) => (r.state === 'pending' || r.state === 'defeated') && r.occupantSeat === null);
  return target ? `enter:${target.index}` : 'idle';
}
async function playToFinish(host, guest, roomId, tag) {
  let lastRoom = null;
  for (let round = 0; round < 48; round += 1) {
    const hv = await get(host.token, `/api/room/${roomId}`);
    const hostCoop = hv.data?.room?.coop;
    if (hv.data?.room?.status === 'settled' || hostCoop?.finished) { lastRoom = hv.data.room; break; }
    const gv = await get(guest.token, `/api/room/${roomId}`);
    const guestCoop = gv.data?.room?.coop;
    const hi = intentFor(hostCoop);
    const gi = intentFor(guestCoop);
    await post(host.token, `/api/room/${roomId}/action`, { intent: hi, nonce: `h_${tag}_${round}` });
    const last = await post(guest.token, `/api/room/${roomId}/action`, { intent: gi, nonce: `g_${tag}_${round}` });
    if (last.data?.room?.coop?.finished || last.data?.room?.status === 'settled') lastRoom = last.data.room;
  }
  return lastRoom;
}

async function main() {
  await requireBackend();

  const hero = await newAccount('core_');
  names.push(hero.username);
  const token = hero.token;

  const putRes = await save.put(token, HERO_SAVE());
  s.check('建档 PUT → 200', putRes.status === 200 && putRes.data?.ok === true,
    `${putRes.status} ${asText(putRes.data).slice(0, 120)}`);

  // 基线：0 徽章 → travel 被锁（之后持徽章才能解锁，验证地图锁服务端权威）
  const travelLocked = await post(token, '/api/game/travel', { locationId: 'city_pebble' });
  s.check('0 徽章时 travel 到 city_pebble → 400 LOCATION_LOCKED',
    travelLocked.status === 400 && travelLocked.data?.code === 'LOCATION_LOCKED',
    `${travelLocked.status} ${asText(travelLocked.data).slice(0, 120)}`);

  const p0 = await progressOf(token);
  s.check('初始进度：0 徽章 / 等级 5', p0?.badgeCount === 0 && p0?.level === 5,
    `badgeCount=${p0?.badgeCount} level=${p0?.level}`);
  const preWild = saveDataOf(await save.get(token));
  s.check('初始队伍 = 2', preWild?.party?.length === 2, `party=${preWild?.party?.length}`);

  // ═══════════════════ 1) 野怪捕获 ═══════════════════
  console.log('\n—— 1) 野怪捕获 ——');
  const wildList = await api(`/api/wild?areaId=${AREA}&theme=grass&levelMin=1&levelMax=5`, { token });
  s.check('GET /api/wild → 200 且返回野怪列表',
    wildList.status === 200 && Array.isArray(wildList.data?.monsters) && wildList.data.monsters.length >= 1,
    `n=${wildList.data?.monsters?.length}`);
  // 优先复用共享池里 available 的野怪；若池子被其它测试污染（全 claimed/resolved，属环境态而非玩法缺陷），
  // 则省略 wildId 走「随机野怪」分支——两种路径都完整跑通捕获主链路。
  const target = (wildList.data?.monsters ?? []).find((m) => m.status === 'available');
  s.check('共享池存在可挑战野怪（被污染时降级为随机野怪）',
    !!target?.id || (wildList.data?.monsters?.length ?? 0) >= 1,
    `statuses=${(wildList.data?.monsters ?? []).map((m) => m.status).join(',')}`);
  const wildStart = await api('/api/battle/start', {
    method: 'POST', token,
    body: { theme: 'grass', areaName: '共享草地', areaId: AREA, levelMin: 1, levelMax: 5, wildId: target?.id },
  });
  s.check('开野怪战 → 200 且有敌方', wildStart.status === 200 && !!wildStart.data?.battle?.battleId
    && !!wildStart.data?.battle?.enemy?.specId,
    `${wildStart.status} ${asText(wildStart.data).slice(0, 120)}`);
  const wildBattleId = wildStart.data?.battle?.battleId;
  const wildSpec = wildStart.data?.battle?.enemy?.specId;

  // 满血反复抛球：捕获不扣敌方血、不会误杀；有界重试高概率成功（不依赖 RNG 单点）。
  let captured = false;
  let wildResult = null;
  for (let i = 0; i < 60 && !captured; i += 1) {
    const r = await act(token, wildBattleId, { type: 'capture', itemId: 'capsule_basic' });
    if (r.status === 200 && r.data?.battle?.result === 'captured') { captured = true; wildResult = 'captured'; break; }
    if (r.status !== 200) { s.check('野怪捕获动作持续可用', false, `${r.status} ${asText(r.data)}`); break; }
    if (r.data?.battle?.finished) { wildResult = r.data.battle.result; break; }
  }
  s.check('满血反复抛球成功捕获野怪', captured, `result=${wildResult}`);
  const postWild = await pollSave(token, (sv) => sv.party?.length === 3);
  s.check('捕获后队伍 +1（2 → 3）', postWild?.party?.length === 3, `party=${postWild?.party?.length}`);
  s.check('捕获后图鉴记录该物种 captured=true',
    !!postWild?.collection?.[wildSpec]?.captured, `collection=${JSON.stringify(postWild?.collection?.[wildSpec])}`);
  s.check('捕获不发金钱（rewards 为 null）', postWild?.money === preWild?.money,
    `money ${preWild?.money} → ${postWild?.money}`);

  // 捕获触发「首通野区」→ 发 badge_sprout（V1 口径，幂等）
  const pCap = await progressOf(token);
  s.check('捕获后已持 badge_sprout（首通野区发徽章）',
    (pCap?.badges ?? []).some((b) => b.id === 'badge_sprout'),
    `badgeCount=${pCap?.badgeCount} level=${pCap?.level}`);
  s.check('捕获后等级随徽章提升：= 5 + 5×徽章数', pCap?.level === 5 + 5 * (pCap?.badgeCount ?? 0),
    `level=${pCap?.level} badgeCount=${pCap?.badgeCount}`);

  // ═══════════════════ 2) 演武堂 + 解锁 travel ═══════════════════
  console.log('\n—— 2) 演武堂 + 解锁 travel ——');
  const gymStart = await post(token, '/api/gym/start', { locationId: GYM_LOC });
  s.check('gym/start town_starter → 200', gymStart.status === 200 && !!gymStart.data?.battle?.battleId,
    `${gymStart.status} ${asText(gymStart.data).slice(0, 120)}`);
  const { st: gymSt, extra: gymRes } = await playToEnd(token, gymStart.data.battle.battleId);
  s.check('演武堂战斗推进到结束且胜利', !!gymSt && gymSt.finished && gymSt.result === 'enemy_fainted',
    `result=${gymSt?.result}`);
  s.check('结算返回 gym 结果且 gymCleared=true', !!gymRes && gymRes.gymCleared === true, asText(gymRes));
  s.check('胜馆主针对 badge_sprout（gym:<loc> 幂等，已持有的话为 already）',
    gymRes?.badgeId === 'badge_sprout', asText(gymRes));

  const pGym2 = await progressOf(token);
  s.check('徽章数仍为 1（捕获首通已发，演武堂幂等不双计）',
    (pGym2?.badgeCount ?? 0) === 1, `badgeCount=${pGym2?.badgeCount}`);
  s.check('徽章集合含 badge_sprout', (pGym2?.badges ?? []).some((b) => b.id === 'badge_sprout'),
    JSON.stringify(pGym2?.badges));
  s.check('等级保持 10（5 + 5×1）', pGym2?.level === 10, `level=${pGym2?.level}`);
  const postGym = saveDataOf(await save.get(token));
  s.check('队伍保持 3（捕获不被演武堂篡改）', postGym?.party?.length === 3, `party=${postGym?.party?.length}`);
  s.check('演武堂给金钱（enemy_fainted 普通战斗奖励）', postGym.money > postWild.money,
    `money ${postWild.money} → ${postGym.money}`);

  // 徽章解锁 travel：city_pebble 现在可前往，且可来回不锁。
  const travelOk = await post(token, '/api/game/travel', { locationId: 'city_pebble' });
  s.check('持徽章后 travel 到 city_pebble → 200', travelOk.status === 200, `${travelOk.status}`);
  const travelBack = await post(token, '/api/game/travel', { locationId: GYM_LOC });
  s.check('再 travel 回 town_starter → 200（线性解锁不丢）', travelBack.status === 200, `${travelBack.status}`);

  // ═══════════════════ 3) 每日 Boss ═══════════════════
  console.log('\n—— 3) 每日 Boss ——');
  const bossStart = await post(token, '/api/boss/start', { bossId: BOSS });
  s.check('boss/start ember_behemoth → 200', bossStart.status === 200 && !!bossStart.data?.battle?.battleId,
    `${bossStart.status} ${asText(bossStart.data).slice(0, 120)}`);
  const preBoss = saveDataOf(await save.get(token));
  const { st: bossSt, extra: bossRes } = await playToEnd(token, bossStart.data.battle.battleId);
  s.check('每日 Boss 推进到结束且胜利', !!bossSt && bossSt.finished && bossSt.result === 'enemy_fainted',
    `result=${bossSt?.result}`);
  s.check('Boss 结算 recorded=true（记一次伤害事件）', bossRes?.recorded === true, asText(bossRes));
  s.check('Boss 次数 used=1 / remaining=limit-1',
    bossRes?.quota?.used === 1 && bossRes?.quota?.remaining === (bossRes?.quota?.limit ?? 1) - 1,
    `used=${bossRes?.quota?.used} remaining=${bossRes?.quota?.remaining} limit=${bossRes?.quota?.limit}`);

  const postBoss = await pollSave(token, (sv) =>
    sv.money > preBoss.money && (sv.inventory?.capsule_prism ?? 0) >= 1);
  s.check('每日 Boss 发奖励（金钱增加）', postBoss.money > preBoss.money,
    `money ${preBoss.money} → ${postBoss.money}`);
  s.check('每日 Boss 发棱彩胶囊（双档奖励硬证据）', (postBoss.inventory?.capsule_prism ?? 0) >= 1,
    `prism=${postBoss.inventory?.capsule_prism}`);
  const bossRank = await api(`/api/boss/${BOSS}/rank?limit=50`, { token });
  s.check('每日 Boss 上榜（有我的伤害记录）', bossRank.status === 200 && (bossRank.data?.me?.total ?? 0) > 0,
    `me.total=${bossRank.data?.me?.total}`);

  // ═══════════════════ 4) 地图首领（F18-c，3×经验/5×金钱）═══════════════════
  console.log('\n—— 4) 地图首领（F18-c） ——');
  const mbStart = await post(token, '/api/mapboss/start', { mapBossId: MAPBOSS });
  s.check('mapboss/start mb_starter_guardian → 200', mbStart.status === 200 && !!mbStart.data?.battle?.battleId,
    `${mbStart.status} ${asText(mbStart.data).slice(0, 120)}`);
  const enemyLv = mbStart.data?.battle?.enemy?.level ?? 0;
  const preMb = saveDataOf(await save.get(token));
  const { st: mbSt, extra: mbRes } = await playToEnd(token, mbStart.data.battle.battleId);
  s.check('地图首领推进到结束且胜利', !!mbSt && mbSt.finished && mbSt.result === 'enemy_fainted',
    `result=${mbSt?.result}`);
  s.check('地图首领结算 recorded=true', mbRes?.recorded === true, asText(mbRes));
  // 3×经验 / 5×金钱（与普通野怪公式对齐：10+lv*6 经验, (50+lv*10) 金钱，无幸运币）
  const baseExp = 10 + enemyLv * 6;
  const baseMoney = 50 + enemyLv * 10;
  s.check('地图首领经验 = 3×普通野怪（奖励数值）', mbSt?.rewards?.expGain === baseExp * 3,
    `exp=${mbSt?.rewards?.expGain} expect=${baseExp * 3}`);
  s.check('地图首领金钱 = 5×普通野怪（奖励数值）', mbSt?.rewards?.moneyGain === baseMoney * 5,
    `money=${mbSt?.rewards?.moneyGain} expect=${baseMoney * 5}`);
  // 轮询：5×战斗金钱（同步写档）+ 掉落 50（异步）+ 掉落道具（异步）
  const mbExpectMoney = preMb.money + 50 + (mbSt?.rewards?.moneyGain ?? 0);
  const postMb = await pollSave(token, (sv) =>
    sv.money === mbExpectMoney
    && (sv.inventory?.stone_leaf ?? 0) >= 1
    && (sv.inventory?.berry_sitrus ?? 0) >= 1);
  s.check('地图首领金钱精确 = 掉落(50) + 5×战斗金钱', postMb.money === mbExpectMoney,
    `before=${preMb.money} after=${postMb.money} expect=${mbExpectMoney}`);
  s.check('地图首领掉落入背包（stone_leaf ≥1 & berry_sitrus ≥1）',
    (postMb.inventory?.stone_leaf ?? 0) >= 1 && (postMb.inventory?.berry_sitrus ?? 0) >= 1,
    JSON.stringify(postMb.inventory));
  const mbOv = await api('/api/mapboss', { token });
  const mbEntry = (mbOv.data?.bosses ?? []).find((b) => b.mapBossId === MAPBOSS);
  s.check('地图首领总览 used=1（独立于每日 Boss 计数）', mbEntry?.used === 1, asText(mbEntry));

  // 跨模块一致性：前面的徽章/等级/队伍在地图首领后仍完好
  const pMb = await progressOf(token);
  s.check('地图首领后等级仍为 10 / 队伍仍为 3', pMb?.level === 10 && postMb.party.length === 3,
    `level=${pMb?.level} party=${postMb.party.length}`);

  // ═══════════════════ 5) 共斗（hero=房主 + guest=第二账号）═══════════════════
  console.log('\n—— 5) 共斗 ——');
  const guest = await newAccount('core_g_');
  names.push(guest.username);
  // guest 同样带 3 只强宠：单只强宠一倒下该座位立即 out，是偶发全灭的主因。
  const guestStrong = (i) => ({ ...STRONG, id: `core_g_strong_${i}` });
  const guestParty = validSave({
    money: 5000,
    party: [guestStrong(0), guestStrong(1), guestStrong(2)],
    inventory: { capsule_basic: 60, potion_small: 3 },
  });
  const gPut = await save.put(guest.token, guestParty);
  s.check('共斗队友建档 → 200', gPut.status === 200, `${gPut.status}`);

  const hostWs = await openWs({ token });
  const guestWs = await openWs({ token: guest.token });
  const create = await post(token, '/api/coop/create', { bossId: COOP_BOSS });
  s.check('共斗建房 → 200', create.status === 200 && !!create.data?.room?.roomId, `${create.status}`);
  const roomId = create.data.room.roomId;
  const join = await post(guest.token, `/api/coop/${roomId}/join`, {});
  s.check('队友加入 → 200 / 六房态生成', join.status === 200 && join.data?.room?.coop?.rooms?.length === 6,
    `${join.status} rooms=${join.data?.room?.coop?.rooms?.length}`);

  const preCoop = saveDataOf(await save.get(token));
  const expectMoney = preCoop.money + COOP_REWARD_MONEY;
  const expectCapsule = (preCoop.inventory?.capsule_basic ?? 0) + 1;
  const finished = await playToFinish(hero, guest, roomId, 'core');
  s.check('六房全清 → settled / result=win / cleared=6',
    !!finished && finished.status === 'settled' && finished.coop?.result === 'win' && finished.coop?.cleared === 6,
    JSON.stringify(finished?.coop && { result: finished.coop.result, cleared: finished.coop.cleared }));

  const postCoop = await pollSave(token, (sv) =>
    sv.money === expectMoney && (sv.inventory?.capsule_basic ?? 0) === expectCapsule);
  s.check('房主通关奖励：+40 金钱', postCoop?.money === expectMoney, `money=${postCoop?.money} expect=${expectMoney}`);
  s.check('房主通关奖励：+capsule_basic×1', (postCoop?.inventory?.capsule_basic ?? 0) === expectCapsule,
    `capsule=${postCoop?.inventory?.capsule_basic} expect=${expectCapsule}`);

  // 最终跨模块不变量
  const pFinal = await progressOf(token);
  s.check('最终等级=10（1 徽章，经验冻结不降）', pFinal?.level === 10, `level=${pFinal?.level}`);
  s.check('最终徽章仅 1 枚（捕获/演武堂同源 badge_sprout，无重复）', pFinal?.badgeCount === 1,
    `badgeCount=${pFinal?.badgeCount}`);
  s.check('最终队伍=3（捕获 +1 未被后续模块改回）', postCoop?.party?.length === 3, `party=${postCoop?.party?.length}`);

  await closeWs(hostWs);
  await closeWs(guestWs);
}

try {
  await main();
} catch (e) {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  s.check('套件执行未抛异常', false, formatFatal(e).replace(/\s+/g, ' ').slice(0, 1200));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
