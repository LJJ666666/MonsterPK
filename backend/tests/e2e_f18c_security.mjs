/**
 * F18-c 地图首领：防御性 / 越权 E2E（2026-11-11）。
 *
 * 目标：对 F18-c 这一「服务端权威、独立层、不上榜、限每日次数」的玩法，
 * 做一套针对**越权与滥用**的端到端防御验证。所有随机性 / 次数 / quotaKey /
 * periodKey 一律由服务端生成，客户端输入不可注入。
 *
 * 覆盖（详见 main 内分区）：
 *  A. 开局夹带伪造 quotaKey / periodKey → 服务端忽略，返回服务端生成值。
 *  B. 伪造 / 未知 / 未解锁 mapBossId 上行 → 一律拒绝（400 / 403）。
 *  C. 跨用户隔离：用户 A 的 battleId 不能被用户 B 操作（404 BATTLE_NOT_FOUND）。
 *  D. 伪造 battleId（随机串）→ 404 BATTLE_NOT_FOUND。
 *  E. 地图首领捕获 → 400 MAPBOSS_UNCATCHABLE（不可绕过）。
 *  F. 战斗进行中再开 → 409 MAPBOSS_BATTLE_IN_PROGRESS（防多开占用名额）。
 *  G. 顶号后旧 token 续打 → 403 SESSION_REPLACED；新 token 可正常续打结算。
 *  H. 超上限重入 → 429 MAPBOSS_QUOTA_EXHAUSTED。
 *  I. 胜利后重复结算同一 battleId → 404（战斗已 drop），used 计数不叠加（唯一键幂等）。
 *  J. 放弃泄漏回归：start→abandon 循环多次，在途名额必须回收（否则每日次数被暗扣）。
 *
 * 运行：cd backend && npm run e2e:f18c_security（需要 :3001 后端在线）
 * 也可经 npm run verify 自动纳入（scripts/verify.mjs 的 e2e 分组）。
 */
import {
  Suite, api, asText, newAccount, login, cleanupAccounts, requireBackend, validSave, save,
} from './lib/harness.mjs';

// 强力队伍：一级 Lv30，确保稳定击败 Lv8 地图首领（不与 rng 博弈）。
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
const WINTER = 'mb_winter_frostbite';     // town_winter，需 city_shadow 徽章 → 锁定

const s = new Suite('E2E_F18C_SECURITY');
const names = [];

async function startMapBoss(token, mapBossId, extra = {}) {
  return api('/api/mapboss/start', { method: 'POST', token, body: { mapBossId, ...extra } });
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
async function abandon(token, battleId) {
  return api('/api/battle/abandon', { method: 'POST', token, body: { battleId } });
}
/** 把一场战斗打到结束，返回最后 battle 视图与结算附带的 mapBoss 结果。 */
async function playToEnd(token, battleId, maxRounds = 80) {
  let st = (await current(token)).data?.battle;
  let mbResult = null;
  let rounds = 0;
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

  // —— A. 开局夹带伪造 quotaKey / periodKey：服务端必须忽略，返回真值 ——
  {
    const a = await newAccount('secA_');
    names.push(a.username);
    const put = await save.put(a.token, strongSave());
    s.check('A 建档 PUT → 200', put.status === 200 && put.data?.ok === true, `${put.status} ${asText(put.data).slice(0, 120)}`);

    const ov = await overview(a.token);
    const ovPeriod = ov.data?.periodKey;
    const forged = await startMapBoss(a.token, STARTER, { quotaKey: 'evil-key', periodKey: 'evil-period' });
    s.check('A 夹带伪造 quotaKey/periodKey 仍 200', forged.status === 200 && forged.data?.ok === true,
      `${forged.status} ${asText(forged.data).slice(0, 160)}`);
    s.check('A 返回 periodKey 是服务端生成值（非客户端注入的 evil-period）',
      forged.data?.periodKey && forged.data.periodKey !== 'evil-period',
      `periodKey=${forged.data?.periodKey}`);
    s.check('A 返回 periodKey 与总览一致（服务端真值）',
      forged.data?.periodKey === ovPeriod, `start=${forged.data?.periodKey} ov=${ovPeriod}`);
    s.check('A 返回 quota 为服务端权威值（remaining=limit-1=2，非任意注入）',
      forged.data?.quota?.remaining === 2, asText(forged.data?.quota));
    s.check('A 返回体不回显客户端传入的 quotaKey',
      forged.data?.quotaKey === undefined, `quotaKey=${asText(forged.data?.quotaKey)}`);
    // 清场：打完，避免占名额影响后续用例
    const bid = forged.data?.battle?.battleId;
    if (bid) await playToEnd(a.token, bid);
  }

  // —— B. 伪造 / 未知 / 未解锁 mapBossId：一律拒绝 ——
  {
    const a = await newAccount('secB_');
    names.push(a.username);
    await save.put(a.token, strongSave());

    const unk = await startMapBoss(a.token, 'mb_not_exist');
    s.check('B 未知 mapBossId → 400 MAPBOSS_UNKNOWN',
      unk.status === 400 && unk.data?.code === 'MAPBOSS_UNKNOWN',
      `${unk.status} ${asText(unk.data).slice(0, 160)}`);

    const empty = await startMapBoss(a.token, '');
    s.check('B 空 mapBossId → 400 MAPBOSS_BAD_REQUEST',
      empty.status === 400 && empty.data?.code === 'MAPBOSS_BAD_REQUEST',
      `${empty.status} ${asText(empty.data).slice(0, 160)}`);

    const locked = await startMapBoss(a.token, WINTER);
    s.check('B 未解锁 mapBossId → 403 MAPBOSS_LOCKED',
      locked.status === 403 && locked.data?.code === 'MAPBOSS_LOCKED',
      `${locked.status} ${asText(locked.data).slice(0, 160)}`);
  }

  // —— C. 跨用户隔离：用户 A 的 battleId 用户 B 不能操作 ——
  {
    const a = await newAccount('secC_a');
    const b = await newAccount('secC_b');
    names.push(a.username, b.username);
    await save.put(a.token, strongSave());
    await save.put(b.token, strongSave());

    const start = await startMapBoss(a.token, STARTER);
    s.check('C A 开局成功', start.status === 200 && start.data?.ok === true,
      `${start.status} ${asText(start.data).slice(0, 120)}`);
    const battleId = start.data?.battle?.battleId;

    const bAct = await act(b.token, battleId, { type: 'flee' });
    s.check('C 用户 B 操作用户 A 的 battleId → 404 BATTLE_NOT_FOUND',
      bAct.status === 404 && bAct.data?.code === 'BATTLE_NOT_FOUND',
      `${bAct.status} ${asText(bAct.data).slice(0, 160)}`);

    const bCur = await current(b.token);
    s.check('C 用户 B 看不到用户 A 的战斗（current 仅自己）',
      bCur.data?.battle === null || bCur.data?.battle === undefined,
      asText(bCur.data?.battle));

    const bStartA = await startMapBoss(b.token, battleId);
    s.check('C 用户 B 不能用 battleId 当作 mapBossId 开局 → 拒绝',
      bStartA.status === 400, `${bStartA.status} ${asText(bStartA.data).slice(0, 120)}`);

    // 清场
    if (battleId) await playToEnd(a.token, battleId);
  }

  // —— D. 伪造 battleId（随机串）→ 404 ——
  {
    const a = await newAccount('secD_');
    names.push(a.username);
    await save.put(a.token, strongSave());

    const fake = await act(a.token, 'totally_fake_battle_id_xyz', { type: 'flee' });
    s.check('D 伪造 battleId → 404 BATTLE_NOT_FOUND',
      fake.status === 404 && fake.data?.code === 'BATTLE_NOT_FOUND',
      `${fake.status} ${asText(fake.data).slice(0, 160)}`);
  }

  // —— E. 地图首领捕获 → 400 MAPBOSS_UNCATCHABLE（不可绕过）——
  {
    const a = await newAccount('secE_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    const start = await startMapBoss(a.token, STARTER);
    const battleId = start.data?.battle?.battleId;
    s.check('E 开局成功', start.status === 200, `${start.status} ${asText(start.data).slice(0, 120)}`);
    const cap = await act(a.token, battleId, { type: 'capture', itemId: 'capsule_basic' });
    s.check('E 地图首领捕获 → 400 MAPBOSS_UNCATCHABLE',
      cap.status === 400 && cap.data?.code === 'MAPBOSS_UNCATCHABLE',
      `${cap.status} ${asText(cap.data).slice(0, 160)}`);
    if (battleId) await playToEnd(a.token, battleId);
  }

  // —— F. 战斗进行中再开 → 409 MAPBOSS_BATTLE_IN_PROGRESS ——
  {
    const a = await newAccount('secF_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    const first = await startMapBoss(a.token, STARTER);
    const battleId = first.data?.battle?.battleId;
    s.check('F 首次开局成功', first.status === 200, `${first.status}`);
    const second = await startMapBoss(a.token, STARTER);
    s.check('F 进行中再开 → 409 MAPBOSS_BATTLE_IN_PROGRESS',
      second.status === 409 && second.data?.code === 'MAPBOSS_BATTLE_IN_PROGRESS',
      `${second.status} ${asText(second.data).slice(0, 160)}`);
    if (battleId) await playToEnd(a.token, battleId);
  }

  // —— G. 顶号：旧 token 续打 → 403 SESSION_REPLACED；新 token 可续打结算 ——
  {
    const a = await newAccount('secG_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    const start = await startMapBoss(a.token, STARTER);
    const battleId = start.data?.battle?.battleId;
    s.check('G 开战成功（token1）', start.status === 200, `${start.status}`);

    // 同账号再登录 → sessionVersion 递增 → 旧 token 失效
    const relogin = await login(a.username, a.password);
    s.check('G 顶号登录拿到新 token', relogin.status === 200 && !!relogin.data?.token,
      `${relogin.status} ${asText(relogin.data).slice(0, 120)}`);
    const token2 = relogin.data.token;

    const oldAct = await act(a.token, battleId, { type: 'flee' });
    s.check('G 旧 token 续打 → 403 SESSION_REPLACED',
      oldAct.status === 403 && oldAct.data?.code === 'SESSION_REPLACED',
      `${oldAct.status} ${asText(oldAct.data).slice(0, 160)}`);

    const newAct = await act(token2, battleId, { type: 'flee' });
    s.check('G 新 token 仍可操作同一场战斗（battle 按 userId 归属，不随 token 失效）',
      newAct.status === 200, `${newAct.status} ${asText(newAct.data).slice(0, 160)}`);
    // 新 token 打完收尾
    await playToEnd(token2, battleId);
  }

  // —— H. 超上限重入 → 429 MAPBOSS_QUOTA_EXHAUSTED ——
  {
    const a = await newAccount('secH_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    // STARTER dailyLimit=3：打满 3 次（每次胜），第 4 次应被拒。
    for (let i = 0; i < 3; i++) {
      const st = await startMapBoss(a.token, STARTER);
      if (st.status !== 200) {
        s.check(`H 第 ${i + 1} 次开战成功`, false, `${st.status} ${asText(st.data).slice(0, 120)}`);
        break;
      }
      const { st: fin } = await playToEnd(a.token, st.data.battle.battleId);
      s.check(`H 第 ${i + 1} 次打到胜利`, !!fin && fin.result === 'enemy_fainted', `result=${fin?.result}`);
    }
    const ov = await overview(a.token);
    const st3 = (ov.data?.bosses ?? []).find((b) => b.mapBossId === STARTER);
    s.check('H 用满后总览 used=3 / remaining=0', st3?.used === 3 && st3?.remaining === 0, asText(st3));

    const exhausted = await startMapBoss(a.token, STARTER);
    s.check('H 次数用满后再开 → 429 MAPBOSS_QUOTA_EXHAUSTED',
      exhausted.status === 429 && exhausted.data?.code === 'MAPBOSS_QUOTA_EXHAUSTED',
      `${exhausted.status} ${asText(exhausted.data).slice(0, 160)}`);
  }

  // —— I. 胜利后重复结算同一 battleId → 404（幂等），used 不叠加 ——
  {
    const a = await newAccount('secI_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    const start = await startMapBoss(a.token, STARTER);
    const battleId = start.data?.battle?.battleId;
    const { st } = await playToEnd(a.token, battleId);
    s.check('I 首战胜利', !!st && st.result === 'enemy_fainted', `result=${st?.result}`);

    const ovBefore = await overview(a.token);
    const usedBefore = (ovBefore.data?.bosses ?? []).find((b) => b.mapBossId === STARTER)?.used ?? -1;

    // 战斗已 drop，再次用同一 battleId 动作 → 404，不应二次结算
    const dup = await act(a.token, battleId, { type: 'flee' });
    s.check('I 已结束 battleId 再动作 → 404 BATTLE_NOT_FOUND（不二次结算）',
      dup.status === 404 && dup.data?.code === 'BATTLE_NOT_FOUND',
      `${dup.status} ${asText(dup.data).slice(0, 160)}`);

    const ovAfter = await overview(a.token);
    const usedAfter = (ovAfter.data?.bosses ?? []).find((b) => b.mapBossId === STARTER)?.used ?? -1;
    s.check('I 重复结算后 used 不变（唯一键幂等，不叠加次数）',
      usedAfter === usedBefore, `before=${usedBefore} after=${usedAfter}`);
  }

  // —— J. 放弃泄漏回归：start→abandon 循环，在途名额必须回收 ——
  // 若 abandon 不释放 mapBoss 在途名额，heldCount 会随每次 abandon 累积，
  // 第 4 次 start 起触发 429（即使 used=0），导致每日次数被暗扣。
  {
    const a = await newAccount('secJ_');
    names.push(a.username);
    await save.put(a.token, strongSave());
    let allReleased = true;
    const CYCLES = 4; // 超过 dailyLimit(3)，若名额每轮回收则可无限次 start
    for (let i = 0; i < CYCLES; i++) {
      const st = await startMapBoss(a.token, STARTER);
      if (st.status !== 200) {
        allReleased = false;
        s.check(`J 第 ${i + 1} 次 start→abandon 后仍能开战（名额已回收）`, false,
          `${st.status} ${asText(st.data).slice(0, 140)}`);
        break;
      }
      const ab = await abandon(a.token, st.data.battle.battleId);
      s.check(`J 第 ${i + 1} 次 abandon → 200`, ab.status === 200, `${ab.status} ${asText(ab.data).slice(0, 100)}`);
    }
    s.check('J 在途名额每轮回收（无泄漏，超出 dailyLimit 仍可开战）', allReleased,
      `CYCLES=${CYCLES}`);
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
