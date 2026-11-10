/**
 * F18-b 演武堂挑战 E2E（2026-11-11）。
 *
 * 验证口径（服务端权威，F18-b 规范）：
 *  - gym/start 只接受 locationId；王牌 / 等级 / 馆主休息冷却全由服务端内容表决定；
 *  - 开局即置 20min「馆主休息」冷却（防刷经验 / 金钱），冷却期内再开（且战斗已结束）→ 429 GYM_ON_COOLDOWN；
 *  - 未知 locationId → 400 GYM_UNKNOWN；战斗进行中再开 → 409 GYM_BATTLE_IN_PROGRESS；
 *  - 演武堂战斗中捕获被拒 → 400 GYM_UNCATCHABLE（`bossId` 同源拦截，见 game/battle.ts）；
 *  - 打到胜利（enemy_fainted）→ 经 grantBadge 发 `gym:town_starter` 徽章（badge_sprout），
 *    结算响应带 gym 结果（gymCleared=true / granted=true），overview 反映已得徽章；
 *  - 逃跑 / 全灭 → 不发徽章（gymCleared=false）。
 *
 * 运行：cd backend && npm run e2e:f18b（需要 :3001 后端在线）
 * 也可经 npm run verify 自动纳入（见 scripts/verify.mjs 的 e2e 分组）。
 */
import { Suite, api, asText, newAccount, cleanupAccounts, requireBackend, validSave, save } from './lib/harness.mjs';

// 强力队伍：一级 Lv30 高数值，确保能稳定击败 Lv8 馆主王牌（不与 rng 博弈）。
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

const s = new Suite('E2E_F18B');
const names = [];

async function startGym(token, locationId) {
  return api('/api/gym/start', { method: 'POST', token, body: { locationId } });
}
async function act(token, battleId, action) {
  return api('/api/battle/action', { method: 'POST', token, body: { battleId, action } });
}
async function current(token) {
  return api('/api/battle/current', { token });
}
/** 把一场战斗打到结束（优先用有 PP 的技能），返回最后一份 battle 视图与结算附带的 gym 结果。 */
async function playToEnd(token, battleId, maxRounds = 80) {
  let st = (await current(token)).data?.battle;
  let rounds = 0;
  let gymResult = null;
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
    if (r.data?.gym) gymResult = r.data.gym;
    rounds += 1;
  }
  return { st, gymResult, rounds };
}

async function main() {
  await requireBackend();
  const a = await newAccount('f18b_');
  names.push(a.username);
  const token = a.token;

  // —— 建档（gym/start 要求已有存档且队伍有可战幻兽）——
  const putRes = await save.put(token, strongSave());
  s.check('建档 PUT → 200', putRes.status === 200 && putRes.data?.ok === true,
    `${putRes.status} ${asText(putRes.data).slice(0, 120)}`);

  // —— 1) 开演武堂：town_starter ——
  const start = await startGym(token, 'town_starter');
  s.check('gym/start town_starter → 200', start.status === 200 && start.data?.ok === true,
    `${start.status} ${asText(start.data).slice(0, 160)}`);
  const battleId = start.data?.battle?.battleId;
  s.check('返回 battle 且 gymId=town_starter', !!battleId && start.data?.battle?.gymId === 'town_starter',
    `battleId=${battleId} gymId=${start.data?.battle?.gymId}`);
  s.check('敌方为馆主王牌 sprout_owl (Lv8)',
    start.data?.battle?.enemy?.specId === 'sprout_owl' && start.data?.battle?.enemy?.level === 8,
    `spec=${start.data?.battle?.enemy?.specId} lv=${start.data?.battle?.enemy?.level}`);
  s.check('下发 20min 馆主休息冷却到期时间',
    typeof start.data?.cooldownUntil === 'number' && start.data.cooldownUntil > Date.now(),
    `cooldownUntil=${start.data?.cooldownUntil}`);

  // —— 2) 战斗进行中再开同一演武堂 → 409 GYM_BATTLE_IN_PROGRESS（冷却检查在战斗闸门之后）——
  const inProg = await startGym(token, 'town_starter');
  s.check('战斗进行中再开 → 409 GYM_BATTLE_IN_PROGRESS',
    inProg.status === 409 && inProg.data?.code === 'GYM_BATTLE_IN_PROGRESS',
    `${inProg.status} ${asText(inProg.data).slice(0, 160)}`);

  // —— 3) 未知 locationId → 400 GYM_UNKNOWN ——
  const unk = await startGym(token, 'nowhere');
  s.check('未知演武堂 → 400 GYM_UNKNOWN',
    unk.status === 400 && unk.data?.code === 'GYM_UNKNOWN',
    `${unk.status} ${asText(unk.data).slice(0, 160)}`);

  // —— 4) 演武堂战斗中捕获被拒 ——
  const cap = await act(token, battleId, { type: 'capture', itemId: 'capsule_basic' });
  s.check('演武堂捕获 → 400 GYM_UNCATCHABLE',
    cap.status === 400 && cap.data?.code === 'GYM_UNCATCHABLE',
    `${cap.status} ${asText(cap.data).slice(0, 160)}`);

  // —— 5) 打到胜利，校验徽章发放 ——
  const { st, gymResult, rounds } = await playToEnd(token, battleId);
  s.check('演武堂战斗推进到结束', !!st && st.finished, `finished=${st?.finished} result=${st?.result} rounds=${rounds}`);
  s.check('胜利结果为 enemy_fainted', st?.result === 'enemy_fainted', `result=${st?.result}`);
  s.check('结算返回 gym 结果且 gymCleared=true', !!gymResult && gymResult.gymCleared === true, asText(gymResult));
  s.check('胜馆主发放 badge_sprout 徽章 (granted=true)',
    gymResult?.badgeId === 'badge_sprout' && gymResult?.granted === true, asText(gymResult));

  // —— 6) 胜利后冷却生效：再开同一演武堂 → 429 GYM_ON_COOLDOWN ——
  const cd = await startGym(token, 'town_starter');
  s.check('胜利后馆主休息中再开 → 429 GYM_ON_COOLDOWN',
    cd.status === 429 && cd.data?.code === 'GYM_ON_COOLDOWN',
    `${cd.status} ${asText(cd.data).slice(0, 160)}`);
  s.check('冷却响应带 retryAfterMs（>0）',
    typeof cd.data?.retryAfterMs === 'number' && cd.data.retryAfterMs > 0,
    `retryAfterMs=${cd.data?.retryAfterMs}`);

  // —— 7) overview 反映已得徽章 + 7 座演武堂 ——
  const ov = await api('/api/gym/overview', { token });
  s.check('overview 含 7 座演武堂', Array.isArray(ov.data?.gyms) && ov.data.gyms.length === 7,
    `count=${(ov.data?.gyms || []).length}`);
  const starter = (ov.data?.gyms ?? []).find((g) => g.locationId === 'town_starter');
  s.check('overview 反映 town_starter 已得徽章', starter?.badgeOwned === true, asText(starter));

  // —— 8) 逃跑不发红（用另一座未冷却的演武堂验证）——
  const start2 = await startGym(token, 'city_pebble');
  if (start2.status === 200) {
    const b2 = start2.data.battle.battleId;
    const fleeRes = await act(token, b2, { type: 'flee' });
    s.check('演武堂逃跑结算无 gymCleared（不发徽章）',
      fleeRes.data?.gym === undefined || fleeRes.data?.gym?.gymCleared === false,
      asText(fleeRes.data?.gym));
  } else {
    s.skip('演武堂逃跑用例（city_pebble 也处于冷却，跳过）', `start2=${start2.status}`);
  }
}

try {
  await main();
} catch (e) {
  s.check('套件执行未抛异常', false, String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 280));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
