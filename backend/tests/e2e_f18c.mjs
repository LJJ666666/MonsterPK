/**
 * F18-c 地图首领 E2E（2026-11-11）。
 *
 * 验证口径（服务端权威，规范 §33.4，杰哥 2026-11-10 拍板）：
 *  - 全新独立玩法层，与 P4-2c「每日 Boss（带伤害榜 + F14 双档奖励）」完全不共享：
 *    地图首领**不上任何榜单**，胜利只发「更好的资源」（稀有材料 / 特殊道具掉落）。
 *  - 解锁门槛 = 该城必须在 `unlockedLocations`（F18-a 线性解锁派生）；新区账号默认只解锁
 *    town_starter（首城），其余未持上一城徽章则 403 MAPBOSS_LOCKED。
 *  - 有每日次数上限（账号 + 自然日，真值记在 BossDamageEvent 行数）；内存只记在途 hold，
 *    进程重启不重置。town_starter dailyLimit=3。
 *  - 禁捕获（MAPBOSS_UNCATCHABLE）、逃跑不上榜也不发奖（不插事件、不计数）。
 *  - 胜利只发掉落，不发常规战斗经验 / 金钱（与 boss 同口径，避免成刷钱 / 刷经验口子）。
 *
 * 运行：cd backend && npm run e2e:f18c（需要 :3001 后端在线）
 * 也可经 npm run verify 自动纳入（见 scripts/verify.mjs 的 e2e 分组）。
 */
import { Suite, api, asText, newAccount, cleanupAccounts, requireBackend, validSave, save } from './lib/harness.mjs';

// 强力队伍：一级 Lv30 高数值，确保能稳定击败 Lv8 地图首领（不与 rng 博弈）。
const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const STRONG_PARTY = [
  {
    id: 'p1', specId: 'sprout_owl', level: 30, exp: 0,
    element: 'grass', maxHp: 220, hp: 220,
    atk: 150, def: 150, spAtk: 150, spDef: 150, spd: 150,
    status: 'none', moveIds: ['tackle', 'wood_strike'],
    initStats: STATS, growthRates: GROWTH, isShiny: false,
  },
];
const strongSave = () => validSave({ party: STRONG_PARTY });

const STARTER = 'mb_starter_guardian';   // town_starter，默认解锁，dailyLimit=3
const WINTER = 'mb_winter_frostbite';     // town_winter，需 city_shadow 徽章 → 新区账号锁定

const s = new Suite('E2E_F18C');
const names = [];

/** GET /api/save 的 data 是 JSON 字符串（DB String 列），需要解析才能读 money/inventory。 */
function saveDataOf(res) {
  const raw = res?.data?.data ?? res?.data?.save;
  if (!raw) return null;
  try { return typeof raw === 'string' ? JSON.parse(raw) : raw; } catch { return null; }
}



async function startMapBoss(token, mapBossId) {
  return api('/api/mapboss/start', { method: 'POST', token, body: { mapBossId } });
}
async function overview(token) {
  return api('/api/mapboss', { token });
}
async function act(token, battleId, action) {
  return api('/api/battle/action', { method: 'POST', token, body: { battleId, action } });
}
async function current(token) {
  return api('/api/battle/current', { token });
}
/** 把一场战斗打到结束（优先用有 PP 的技能），返回最后一份 battle 视图与结算附带的 mapBoss 结果。 */
async function playToEnd(token, battleId, maxRounds = 80) {
  let st = (await current(token)).data?.battle;
  let rounds = 0;
  let mbResult = null;
  while (st && !st.finished && rounds < maxRounds) {
    const idx = st.playerActiveIndex ?? 0;
    const me = st.party?.[idx];
    const usable = (me?.moveIds ?? []).find((id) => (st.ppByMonster?.[me.id]?.[id] ?? 0) > 0);
    const action = usable ? { type: 'move', moveId: usable } : { type: 'flee' };
    const r = await act(token, battleId, action);
    if (r.status !== 200) {
      s.check('战斗中动作持续可用', false, `${r.status} ${asText(r.data)}`);
      break;
    }
    st = r.data?.battle;
    if (r.data?.mapBoss) mbResult = r.data.mapBoss;
    rounds += 1;
  }
  return { st, mbResult, rounds };
}

async function main() {
  await requireBackend();
  const a = await newAccount('f18c_');
  names.push(a.username);
  const token = a.token;

  // —— 建档（/api/mapboss/start 要求已有存档且队伍有可战幻兽）——
  const putRes = await save.put(token, strongSave());
  s.check('建档 PUT → 200', putRes.status === 200 && putRes.data?.ok === true,
    `${putRes.status} ${asText(putRes.data).slice(0, 120)}`);

  // —— 0) 初始总览：town_starter 默认解锁，其余锁定 ——
  const ov0 = await overview(token);
  s.check('总览含 7 座地图首领', Array.isArray(ov0.data?.bosses) && ov0.data.bosses.length === 7,
    `count=${(ov0.data?.bosses || []).length}`);
  const starter0 = (ov0.data?.bosses ?? []).find((b) => b.mapBossId === STARTER);
  s.check('初始总览：town_starter 已解锁', starter0?.unlocked === true, asText(starter0));
  s.check('初始总览：town_starter 余量 = dailyLimit(3)', starter0?.remaining === 3, asText(starter0));
  const winter0 = (ov0.data?.bosses ?? []).find((b) => b.mapBossId === WINTER);
  s.check('初始总览：town_winter 未解锁（需 city_shadow 徽章）', winter0?.unlocked === false, asText(winter0));

  // —— 1) 未解锁城开战 → 403 MAPBOSS_LOCKED ——
  const locked = await startMapBoss(token, WINTER);
  s.check('未解锁地图首领 → 403 MAPBOSS_LOCKED',
    locked.status === 403 && locked.data?.code === 'MAPBOSS_LOCKED',
    `${locked.status} ${asText(locked.data).slice(0, 160)}`);

  // —— 2) 未知 mapBossId → 400 MAPBOSS_UNKNOWN ——
  const unk = await startMapBoss(token, 'mb_not_exist');
  s.check('未知地图首领 → 400 MAPBOSS_UNKNOWN',
    unk.status === 400 && unk.data?.code === 'MAPBOSS_UNKNOWN',
    `${unk.status} ${asText(unk.data).slice(0, 160)}`);

  // —— 3) 开 town_starter 地图首领 ——
  const start = await startMapBoss(token, STARTER);
  s.check('mapboss/start town_starter → 200', start.status === 200 && start.data?.ok === true,
    `${start.status} ${asText(start.data).slice(0, 160)}`);
  const battleId = start.data?.battle?.battleId;
  s.check('返回 battle 且 mapBossId=mb_starter_guardian',
    !!battleId && start.data?.battle?.mapBossId === STARTER,
    `battleId=${battleId} mapBossId=${start.data?.battle?.mapBossId}`);
  s.check('敌方为 sprout_owl (Lv8)',
    start.data?.battle?.enemy?.specId === 'sprout_owl' && start.data?.battle?.enemy?.level === 8,
    `spec=${start.data?.battle?.enemy?.specId} lv=${start.data?.battle?.enemy?.level}`);
  s.check('开局占用一次在途名额 → 余量=limit-1=2', start.data?.quota?.remaining === 2,
    `quota=${asText(start.data?.quota)}`);

  // —— 4) 地图首领战斗中捕获被拒 ——
  const cap = await act(token, battleId, { type: 'capture', itemId: 'capsule_basic' });
  s.check('地图首领捕获 → 400 MAPBOSS_UNCATCHABLE',
    cap.status === 400 && cap.data?.code === 'MAPBOSS_UNCATCHABLE',
    `${cap.status} ${asText(cap.data).slice(0, 160)}`);

  // —— 5) 打到胜利，校验掉落（money+物品，且不含常规战斗经验/金钱）——
  const before = saveDataOf(await save.get(token));
  const beforeMoney = before?.money ?? 0;
  const { st, mbResult, rounds } = await playToEnd(token, battleId);
  s.check('地图首领战斗推进到结束', !!st && st.finished, `finished=${st?.finished} result=${st?.result} rounds=${rounds}`);
  s.check('胜利结果为 enemy_fainted', st?.result === 'enemy_fainted', `result=${st?.result}`);
  s.check('结算返回 mapBoss 结果', !!mbResult, asText(mbResult));
  s.check('胜利发放掉落（money=50）',
    mbResult?.drop?.money === 50, `drop=${asText(mbResult?.drop)}`);
  s.check('胜利发放掉落（stone_leaf:1 / berry_sitrus:1）',
    Array.isArray(mbResult?.drop?.items) &&
      mbResult.drop.items.some((i) => i.itemId === 'stone_leaf' && i.count === 1) &&
      mbResult.drop.items.some((i) => i.itemId === 'berry_sitrus' && i.count === 1),
    `drop=${asText(mbResult?.drop)}`);

  const after = saveDataOf(await save.get(token));
  const afterMoney = after?.money ?? 0;
  s.check('存档金钱精确增加 50（无常规战斗金钱）', afterMoney === beforeMoney + 50,
    `before=${beforeMoney} after=${afterMoney}`);
  s.check('存档背包获得 stone_leaf ≥1', (after?.inventory?.stone_leaf ?? 0) >= 1,
    `inv=${asText(after?.inventory)}`);
  s.check('存档背包获得 berry_sitrus ≥1', (after?.inventory?.berry_sitrus ?? 0) >= 1,
    `inv=${asText(after?.inventory)}`);

  // —— 6) 胜利后总览：used=1，余量=2 ——
  const ov1 = await overview(token);
  const starter1 = (ov1.data?.bosses ?? []).find((b) => b.mapBossId === STARTER);
  s.check('胜利后总览 used=1', starter1?.used === 1, asText(starter1));
  s.check('胜利后总览 remaining=2', starter1?.remaining === 2, asText(starter1));

  // —— 7) 逃跑：不插事件、不计数、不发奖 ——
  const fleeStart = await startMapBoss(token, STARTER);
  if (fleeStart.status === 200) {
    const fb = fleeStart.data.battle.battleId;
    const fleeRes = await act(token, fb, { type: 'flee' });
    s.check('地图首领逃跑结算无 mapBoss 掉落',
      fleeRes.data?.mapBoss === undefined || fleeRes.data?.mapBoss?.drop === null,
      asText(fleeRes.data?.mapBoss));
    const ov2 = await overview(token);
    const starter2 = (ov2.data?.bosses ?? []).find((b) => b.mapBossId === STARTER);
    s.check('逃跑后总览 used 仍为 1（不计数）', starter2?.used === 1, asText(starter2));
    s.check('逃跑后总览 remaining 回到 2（已释放在途名额）', starter2?.remaining === 2, asText(starter2));
  } else {
    s.skip('地图首领逃跑用例（开局失败，跳过）', `fleeStart=${fleeStart.status}`);
  }

  // —— 8) 把剩余次数用完 → 第 4 次开战 429 MAPBOSS_QUOTA_EXHAUSTED ——
  // 当前已用 1（胜利 1 次，逃跑不计数），再赢 2 次到 3，第 4 次应被拒。
  for (let i = 0; i < 2; i++) {
    const stStart = await startMapBoss(token, STARTER);
    if (stStart.status !== 200) {
      s.check(`补满次数第 ${i + 1} 次开局成功`, false, `${stStart.status} ${asText(stStart.data).slice(0, 120)}`);
      break;
    }
    const { st: st2 } = await playToEnd(token, stStart.data.battle.battleId);
    s.check(`补满次数第 ${i + 1} 次打到胜利`, !!st2 && st2.result === 'enemy_fainted', `result=${st2?.result}`);
  }
  const ov3 = await overview(token);
  const starter3 = (ov3.data?.bosses ?? []).find((b) => b.mapBossId === STARTER);
  s.check('用满后总览 used=3', starter3?.used === 3, asText(starter3));
  s.check('用满后总览 remaining=0', starter3?.remaining === 0, asText(starter3));

  const exhausted = await startMapBoss(token, STARTER);
  s.check('次数用满后再开 → 429 MAPBOSS_QUOTA_EXHAUSTED',
    exhausted.status === 429 && exhausted.data?.code === 'MAPBOSS_QUOTA_EXHAUSTED',
    `${exhausted.status} ${asText(exhausted.data).slice(0, 160)}`);
}

try {
  await main();
} catch (e) {
  s.check('套件执行未抛异常', false, String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 280));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
