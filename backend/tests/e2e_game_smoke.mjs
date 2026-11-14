/**
 * 全链路游戏冒烟测试（游戏测试专家视角，2026-11-14）。
 *
 * 目的：从「注册 → 登录 → 新档 → 核心玩法 → 多人对战系统 → 反作弊」做一次端到端实战验收，
 * 全部跑在真实 PG/Redis 后端（默认 http://localhost:3001）。任何一步失败都给出可复盘上下文。
 *
 * 覆盖：
 *  A 认证：注册 / 登录 / me / 错误密码拒登 / 重名拒注册
 *  B 新档与存档：new_game / GET save / player progress / session
 *  C 野外 + 战斗击败 + 奖励落地
 *  D 捕获流程（削弱后循环捕获，验证 roster 增长）
 *  E 治疗 + 旅行地图锁 + 商店购买闭环（意图通道 → 精确增量 PUT）
 *  F 多人对战系统冒烟：boss / mapboss / pvp / coop / room / rank / gym
 *  G 反作弊安全：伪造服务端进度字段 / 改富存档 / 未知道具购买
 *
 * 账号统一带 RUN 前缀，结束 cleanupAccounts 清理。
 */
import {
  Suite, api, health, newAccount, login, openWs, closeWs, cleanupAccounts, requireBackend,
} from './lib/harness.mjs';

const uid = () => 't' + Math.random().toString(36).slice(2, 12);

/** 读取存档：返回 { raw(字符串), data(对象), revision }。 */
async function getSave(token) {
  const r = await api('/api/save', { token });
  if (r.status !== 200) throw new Error(`GET /api/save 失败 status=${r.status} ${r.text?.slice(0, 120)}`);
  const raw = typeof r.data.data === 'string' ? r.data.data : JSON.stringify(r.data.data);
  return { raw, data: JSON.parse(raw), revision: r.data.revision };
}

/** 开一场野生战斗；返回 { ok, battleId, moveId, battle }。 */
async function startWildBattle(token, areaId, theme, lvMin, lvMax) {
  const r = await api('/api/battle/start', {
    method: 'POST', token,
    body: { theme, areaName: '微风林道', areaId, levelMin: lvMin, levelMax: lvMax },
  });
  if (r.status !== 200) return { ok: false, r };
  const b = r.data.battle;
  const moveId = b?.party?.[0]?.moveIds?.[0];
  return { ok: true, battleId: b.battleId, moveId, battle: b };
}

/** 用指定招式把战斗打到结束（默认不捕获，验证击败）。返回 { battle, timeout }。 */
async function autoBattle(token, battleId, moveId, maxTurns = 40) {
  let last = null;
  for (let i = 0; i < maxTurns; i++) {
    const r = await api('/api/battle/action', {
      method: 'POST', token, body: { battleId, action: { type: 'move', moveId } },
    });
    if (r.status !== 200) return { err: r, battle: last };
    last = r.data.battle;
    if (last.finished) return { battle: last };
  }
  return { battle: last, timeout: true };
}

/** 先削弱敌人，再循环「捕获→若未结束则出招削弱」直到捕获成功或敌人倒下。 */
async function captureBattle(token, battleId, moveId, capsuleId = 'capsule_basic', maxRounds = 12) {
  // 先出 1 招软化，提升捕获率
  let r = await api('/api/battle/action', { method: 'POST', token, body: { battleId, action: { type: 'move', moveId } } });
  if (r.status !== 200) return { err: r };
  let last = r.data.battle;
  if (last.finished) return { battle: last, captured: last.result === 'captured' };
  let captured = false;
  for (let i = 0; i < maxRounds; i++) {
    r = await api('/api/battle/action', { method: 'POST', token, body: { battleId, action: { type: 'capture', itemId: capsuleId } } });
    if (r.status !== 200) return { err: r };
    last = r.data.battle;
    if (last.finished) { captured = last.result === 'captured'; break; }
    // 敌人还活着：再出 1 招削弱后继续捕获
    const m = await api('/api/battle/action', { method: 'POST', token, body: { battleId, action: { type: 'move', moveId } } });
    if (m.status !== 200) return { err: m };
    last = m.data.battle;
    if (last.finished) break;
  }
  return { battle: last, captured };
}

/** 反复打野生战斗攒钱，直到 money >= target（上限 maxBattles 场）。 */
async function farmMoney(token, target = 250, maxBattles = 12) {
  for (let i = 0; i < maxBattles; i++) {
    const s = await getSave(token);
    if (s.data.money >= target) return true;
    await api('/api/game/heal', { method: 'POST', token }); // 满血开打，避免昏厥雪球
    const b = await startWildBattle(token, 'wild_starter', 'grass', 2, 2);
    if (!b.ok) continue;
    await autoBattle(token, b.battleId, b.moveId);
  }
  const s = await getSave(token);
  return s.data.money >= target;
}

async function main() {
  const S = new Suite('E2E_GAME');
  await requireBackend();

  const created = [];
  let wsCtx = null;
  try {
    // ——— A 认证 ———
    const acc = await newAccount('gtest');
    created.push(acc.username);
    S.check('A1 注册返回 token', !!acc.token);
    S.check('A2 用户名长度合规(3~20)', acc.username.length >= 3 && acc.username.length <= 20, acc.username);

    const loginOk = await login(acc.username, acc.password);
    S.check('A3 正确密码登录 200+token', loginOk.status === 200 && !!loginOk.data?.token, `status=${loginOk.status}`);
    // P4-1a 顶号：登录会令注册 token 失效（sv 自增），后续一律用「当前登录 token」。
    if (loginOk.status === 200) acc.token = loginOk.data.token;

    const me = await api('/api/auth/me', { token: acc.token });
    S.check('A4 /auth/me 返回本账号', me.status === 200 && me.data?.username === acc.username, `status=${me.status} username=${me.data?.username}`);

    const wrong = await login(acc.username, 'bad-password-xxx');
    S.check('A5 错误密码登录被拒(401)', wrong.status === 401, `status=${wrong.status}`);

    const dupReg = await api('/api/auth/register', { method: 'POST', body: { username: acc.username, password: 'whatever123' } });
    S.check('A6 重名注册被拒(409)', dupReg.status === 409, `status=${dupReg.status} code=${dupReg.data?.code}`);

    // ——— B 新档与存档 ———
    const ng = await api('/api/game/new_game', {
      method: 'POST', token: acc.token,
      body: { playerName: '测试勇者', starterSpecId: 'sprout_owl' },
    });
    S.check('B1 new_game 200 且 party=1', ng.status === 200 && (() => {
      try { return JSON.parse(ng.data.data).party.length === 1; } catch { return false; }
    })(), `status=${ng.status}`);

    const sv = await getSave(acc.token);
    S.check('B2 GET save 含初心镇+初始背包', sv.data.locationId === 'town_starter' && sv.data.inventory?.capsule_basic === 6, `loc=${sv.data.locationId}`);

    const prog = await api('/api/player/progress', { token: acc.token });
    S.check('B3 player/progress 200', prog.status === 200, `status=${prog.status}`);

    const sess = await api('/api/session', { token: acc.token });
    S.check('B4 session 200', sess.status === 200, `status=${sess.status}`);

    // ——— C 野外 + 战斗击败 + 奖励 ———
    const wildR = await api('/api/wild?areaId=wild_starter&theme=grass&levelMin=2&levelMax=2', { token: acc.token });
    S.check('C1 /api/wild 列表非空', wildR.status === 200 && Array.isArray(wildR.data.monsters) && wildR.data.monsters.length > 0, `n=${wildR.data?.monsters?.length}`);

    // 满血开打 + 最多 6 次重试：野生敌人等级最高 5（服务端按区域校准，忽略客户端等级区间），
    // 与 5 级御三家互有胜负，靠重试拿到一次稳定胜利，再校验奖励落地。
    const preSave = await getSave(acc.token);
    let cWin = false;
    let cBattle = null;
    for (let attempt = 0; attempt < 6 && !cWin; attempt++) {
      await api('/api/game/heal', { method: 'POST', token: acc.token }); // 满血开打，避免昏厥雪球
      const cb = await startWildBattle(acc.token, 'wild_starter', 'grass', 2, 2);
      if (!cb.ok) continue;
      const ab = await autoBattle(acc.token, cb.battleId, cb.moveId);
      if (ab.err) continue;
      cBattle = ab.battle;
      if (cBattle.finished && (cBattle.result === 'enemy_fainted' || cBattle.result === 'captured')) cWin = true;
    }
    S.check('C2/C3 野生战斗打到结束且获胜', !!cWin && !!cBattle?.finished, cBattle ? `result=${cBattle.result}` : '无战斗');
    if (cWin) {
      const postSave = await getSave(acc.token);
      const moneyDelta = (postSave.data.money ?? 0) - (preSave.data.money ?? 0);
      const expDelta = (postSave.data.party?.[0]?.exp ?? 0) - (preSave.data.party?.[0]?.exp ?? 0);
      const clearedDelta = Object.keys(postSave.data.clearedAreas ?? {}).length - Object.keys(preSave.data.clearedAreas ?? {}).length;
      S.check('C4 战斗奖励落地(金币/经验/首通)', moneyDelta > 0 || expDelta > 0 || clearedDelta > 0, `moneyΔ=${moneyDelta} expΔ=${expDelta} clearΔ=${clearedDelta}`);
    }

    // ——— D 捕获流程 ———
    const capBefore = await getSave(acc.token);
    const capRosterBefore = (capBefore.data.party?.length ?? 0) + (capBefore.data.box?.length ?? 0);
    let captured = false;
    let capBattle = null;
    let capErr = null;
    for (let attempt = 0; attempt < 5 && !captured; attempt++) {
      await api('/api/game/heal', { method: 'POST', token: acc.token }); // 满血开打
      const cb = await startWildBattle(acc.token, 'wild_starter', 'grass', 2, 2);
      if (!cb.ok) { capErr = cb.r; continue; }
      const cap = await captureBattle(acc.token, cb.battleId, cb.moveId);
      if (cap.err) { capErr = cap.err; continue; }
      capBattle = cap.battle;
      captured = cap.captured;
    }
    S.check('D1 捕获战斗执行无错且结束', !capErr && !!capBattle?.finished, capErr ? `err=${capErr.status}` : `result=${capBattle?.result}`);
    S.check('D2 捕获成功一次', captured, `result=${capBattle?.result}`);
    if (captured) {
      const capAfter = await getSave(acc.token);
      const capRosterAfter = (capAfter.data.party?.length ?? 0) + (capAfter.data.box?.length ?? 0);
      S.check('D3 捕获后 roster 增长', capRosterAfter === capRosterBefore + 1, `${capRosterBefore}->${capRosterAfter}`);
    }

    // ——— E 治疗 + 旅行锁 + 商店闭环 ———
    const heal = await api('/api/game/heal', { method: 'POST', token: acc.token });
    S.check('E1 恢复中心治疗 200', heal.status === 200, `status=${heal.status}`);

    const travelLock = await api('/api/game/travel', { method: 'POST', token: acc.token, body: { locationId: 'city_shadow' } });
    S.check('E2 未解锁城市旅行被锁(400 LOCATION_LOCKED)', travelLock.status === 400 && travelLock.data?.code === 'LOCATION_LOCKED', `status=${travelLock.status} code=${travelLock.data?.code}`);

    const travelOk = await api('/api/game/travel', { method: 'POST', token: acc.token, body: { locationId: 'town_starter' } });
    S.check('E3 已解锁地点旅行 200', travelOk.status === 200, `status=${travelOk.status}`);

    // 攒钱确保能买
    const farmed = await farmMoney(acc.token, 250, 12);
    S.check('E4 野生战斗攒钱达标(>=250)', farmed, '金币不足');

    if (farmed) {
      const s0 = await getSave(acc.token);
      const moneyBefore = s0.data.money;
      const capBefore2 = s0.data.inventory?.capsule_basic ?? 0;
      const buy = await api('/api/actions/shop_buy', {
        method: 'POST', token: acc.token,
        body: {
          nonce: uid(), save: s0.raw, revision: s0.revision,
          payload: { itemId: 'capsule_basic', amount: 1 },
        },
      });
      S.check('E5 商店购买意图 200+成本', buy.status === 200 && typeof buy.data?.result?.cost === 'number', `status=${buy.status} cost=${buy.data?.result?.cost}`);
      if (buy.status === 200) {
        const cost = buy.data.result.cost;
        const ns = JSON.parse(s0.raw);
        ns.money = (ns.money ?? 0) - cost;
        ns.inventory = ns.inventory ?? {};
        ns.inventory.capsule_basic = (ns.inventory.capsule_basic ?? 0) + 1;
        const put = await api('/api/save', {
          method: 'PUT', token: acc.token,
          body: { data: JSON.stringify(ns), revision: buy.data.revision, intentNonce: buy.data.nonce },
        });
        S.check('E6 购买结算 PUT 200', put.status === 200, `status=${put.status} ${put.data?.error ?? ''}`);
        if (put.status === 200) {
          const s1 = await getSave(acc.token);
          S.check('E7 金币精确 -cost & 胶囊 +1', s1.data.money === moneyBefore - cost && (s1.data.inventory.capsule_basic ?? 0) === capBefore2 + 1, `money ${moneyBefore}->${s1.data.money}, cap ${capBefore2}->${s1.data.inventory.capsule_basic}`);
        }
      }
    }

    // ——— F 多人对战系统冒烟 ———
    // 先开一个 WS（pvp/coop/room 的 create/join/action 依赖 connectionOf）
    wsCtx = await openWs({ token: acc.token });
    S.check('F0 主账号 WS 连接 hello', wsCtx.ok, `status=${wsCtx.status}`);

    const bossOv = await api('/api/boss', { token: acc.token });
    let bossId = null;
    if (bossOv.status === 200) {
      const arr = Array.isArray(bossOv.data?.bosses) ? bossOv.data.bosses : (Array.isArray(bossOv.data) ? bossOv.data : []);
      bossId = arr.find((b) => b?.bossId)?.bossId ?? null;
    }
    S.check('F1 /api/boss 概览 200', bossOv.status === 200, `status=${bossOv.status}`);
    if (bossId) {
      const bs = await api('/api/boss/start', { method: 'POST', token: acc.token, body: { bossId } });
      S.check('F2 Boss 开局 200+战斗', bs.status === 200 && !!bs.data?.battle?.battleId, `status=${bs.status}`);
      if (bs.status === 200) {
        const ab = await api('/api/battle/abandon', { method: 'POST', token: acc.token, body: { battleId: bs.data.battle.battleId } });
        S.check('F3 Boss 放弃(释放在途名额)', ab.status === 200, `status=${ab.status}`);
      }
    } else {
      S.skip('F2/F3 Boss 开局', '概览未返回可用 bossId');
    }

    const mbOv = await api('/api/mapboss', { token: acc.token });
    let mapBossId = null;
    if (mbOv.status === 200) {
      const arr = Array.isArray(mbOv.data?.bosses) ? mbOv.data.bosses : (Array.isArray(mbOv.data) ? mbOv.data : []);
      mapBossId = arr.find((b) => b?.mapBossId && b.unlocked === true)?.mapBossId ?? arr.find((b) => b?.mapBossId)?.mapBossId ?? null;
    }
    S.check('F4 /api/mapboss 概览 200', mbOv.status === 200, `status=${mbOv.status}`);
    if (mapBossId) {
      const ms = await api('/api/mapboss/start', { method: 'POST', token: acc.token, body: { mapBossId } });
      S.check('F5 地图首领开局 200+战斗', ms.status === 200 && !!ms.data?.battle?.battleId, `status=${ms.status}`);
      if (ms.status === 200) {
        const ab = await api('/api/battle/abandon', { method: 'POST', token: acc.token, body: { battleId: ms.data.battle.battleId } });
        S.check('F6 地图首领放弃', ab.status === 200, `status=${ab.status}`);
      }
    } else {
      S.skip('F5/F6 地图首领开局', '概览未返回可用 mapBossId');
    }

    const pvp = await api('/api/pvp/create', { method: 'POST', token: acc.token });
    S.check('F7 1v1 创建房间 200+roomId', pvp.status === 200 && !!pvp.data?.room?.roomId, `status=${pvp.status}`);

    if (bossId) {
      const coop = await api('/api/coop/create', { method: 'POST', token: acc.token, body: { bossId } });
      S.check('F8 共斗创建房间 200+roomId', coop.status === 200 && !!coop.data?.room?.roomId, `status=${coop.status}`);
    } else {
      S.skip('F8 共斗创建房间', '无可用 bossId');
    }

    const room = await api('/api/room/create', { method: 'POST', token: acc.token, body: { mode: 'kernel' } });
    S.check('F9 房间创建 200+roomId', room.status === 200 && !!room.data?.room?.roomId, `status=${room.status}`);
    if (room.status === 200) {
      const rid = room.data.room.roomId;
      // 单座 kernel 房间仍处于 forming，提交意图应被正确拒绝（需 2 人入座才转 active）。
      const ra = await api(`/api/room/${rid}/action`, { method: 'POST', token: acc.token, body: { intent: 'enter:0', nonce: uid() } });
      S.check('F10 房间未激活时拒意图(409 ROOM_CLOSED)', ra.status === 409 && ra.data?.code === 'ROOM_CLOSED', `status=${ra.status} code=${ra.data?.code}`);
      const rv = await api(`/api/room/${rid}`, { token: acc.token });
      S.check('F11 房间详情 200+本人入座', rv.status === 200 && Array.isArray(rv.data?.room?.seats) && rv.data.room.seats.length >= 1, `status=${rv.status} seats=${rv.data?.room?.seats?.length}`);
    }

    const rank = await api('/api/rank', { token: acc.token });
    S.check('F12 /api/rank 200', rank.status === 200, `status=${rank.status}`);
    const rankPeriods = await api('/api/rank/periods', { token: acc.token });
    S.check('F13 /api/rank/periods 200', rankPeriods.status === 200, `status=${rankPeriods.status}`);
    const rankRewards = await api('/api/rank/rewards', { token: acc.token });
    S.check('F14 /api/rank/rewards 200', rankRewards.status === 200, `status=${rankRewards.status}`);

    const gymOv = await api('/api/gym/overview', { token: acc.token });
    S.check('F15 /api/gym/overview 200', gymOv.status === 200, `status=${gymOv.status}`);

    // ——— G 反作弊安全 ———
    const sG = await getSave(acc.token);
    // G1：整包 PUT 夹带服务端进度真值字段（等级/徽章/成就为服务端只读真值）
    const forge1 = JSON.parse(sG.raw);
    forge1.playerLevel = 99;
    const putF1 = await api('/api/save', { method: 'PUT', token: acc.token, body: { data: JSON.stringify(forge1), revision: sG.revision } });
    S.check('G1 夹带 playerLevel 被拒(400 SAVE_INPUT_FORBIDDEN)', putF1.status === 400 && putF1.data?.code === 'SAVE_INPUT_FORBIDDEN', `status=${putF1.status} code=${putF1.data?.code}`);

    // G3：购买未知道具被拒（先测，避免被后续封号影响）
    const sG2 = await getSave(acc.token);
    const buyBad = await api('/api/actions/shop_buy', {
      method: 'POST', token: acc.token,
      body: { nonce: uid(), save: sG2.raw, revision: sG2.revision, payload: { itemId: 'no_such_item', amount: 1 } },
    });
    S.check('G3 未知道具购买被拒(400)', buyBad.status === 400, `status=${buyBad.status}`);

    // G2：无意图把金币大幅改富 —— 服务端反作弊应拒绝（轻微偏差按单调比对拒，大额直接封号）。
    // 放最后：本账号会被封，不再有后续依赖该账号的调用。
    const forge2 = JSON.parse(sG.raw);
    forge2.money = (forge2.money ?? 0) + 999999;
    const putF2 = await api('/api/save', { method: 'PUT', token: acc.token, body: { data: JSON.stringify(forge2), revision: sG.revision } });
    S.check('G2 改富存档被拒(封号/拦截)', putF2.status !== 200, `status=${putF2.status} code=${putF2.data?.code}`);
  } catch (e) {
    S.check('运行期未抛未捕获异常', false, String(e?.message || e).slice(0, 300));
  } finally {
    if (wsCtx) await closeWs(wsCtx);
    if (created.length) {
      const res = await cleanupAccounts(created);
      console.log(`[CLEANUP] 删除测试账号 ${res.users} 个`);
    }
  }

  S.done();
}

main();
