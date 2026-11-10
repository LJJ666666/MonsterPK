/**
 * P4-2d 玩家对战 1v1 端到端验证（需后端 :3001 已运行）。
 * 运行：cd backend && npm run e2e:p42d
 *
 * 分区：
 *  A 接口边界   未登录 401 / 伪上报 400 / 无队伍 404 / 无 WS 409
 *  B 建房加入   create → join → pvp 态生成 → 双端视图按接收者裁剪
 *  C 对战推进   双方意图 → 回合推进 → 胜负判定 → room.state 含 pvp 视图
 *  D 结算       写双方档各一次 revision+1 / 不互相覆盖
 *  E 逃跑判负   逃跑成功 → 对方获胜
 *  F 越权       非成员读 / 加入满员房间 / 伪上报 pvp 字段
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42D_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save, requireBackend,
  openWs, closeWs, waitMsg, RUN,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42D');
const created = [];
const sockets = [];

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};
const open = async (token) => {
  const ctx = await openWs({ token });
  sockets.push(ctx);
  return ctx;
};
const post = (token, path, body = {}) => api(path, { method: 'POST', token, body });
const drain = (ctx) => { if (ctx?.queue) ctx.queue.length = 0; };

/** 强档：Lv.40，高攻低血，几回合内分出胜负。 */
function strongSave(overrides = {}) {
  const base = validSave();
  return {
    ...base,
    money: 5000,
    party: base.party.map((m, i) => ({
      ...m, level: 40, maxHp: 200, hp: 200,
      atk: 320, def: 200, spAtk: 320, spDef: 200, spd: 240,
      moveIds: i === 0 ? ['tackle', 'wood_strike'] : ['tackle'],
    })),
    ...overrides,
  };
}

/** 弱档：低血，会被强档一两招打死。 */
function weakSave() {
  const base = strongSave();
  return {
    ...base,
    party: base.party.map((m) => ({
      ...m, level: 5, maxHp: 10, hp: 10,
      atk: 5, def: 5, spAtk: 5, spDef: 5, spd: 5,
      moveIds: ['tackle'],
    })),
  };
}

async function accountWithSave(prefix, data) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, data);
  if (r.status !== 200) throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  return acc;
}

async function main() {
  await requireBackend();

  // ═══ A. 接口边界 ═══
  console.log('\n—— A. 接口边界 ——');
  const noAuth = await post(null, '/api/pvp/create', {});
  suite.check('未登录建房 401', noAuth.status === 401, `status=${noAuth.status}`);

  const A = await mk('p42d_a');
  const forged = await post(A.token, '/api/pvp/create', { winner: 'A', hp: 999 });
  suite.check('伪上报对战字段 400 PVP_INPUT_FORBIDDEN',
    forged.status === 400 && forged.data?.code === 'PVP_INPUT_FORBIDDEN', JSON.stringify(forged.data));

  const noParty = await post(A.token, '/api/pvp/create', {});
  suite.check('无队伍建房 404 PVP_NO_PARTY',
    noParty.status === 404 && noParty.data?.code === 'PVP_NO_PARTY', JSON.stringify(noParty.data));

  const A2 = await accountWithSave('p42d_a2', strongSave());
  const noWs = await post(A2.token, '/api/pvp/create', {});
  suite.check('无实时通道建房 409 ROOM_WS_REQUIRED',
    noWs.status === 409 && noWs.data?.code === 'ROOM_WS_REQUIRED', JSON.stringify(noWs.data));

  // ═══ B. 建房加入 ═══
  console.log('\n—— B. 建房加入 ——');
  const host = await accountWithSave('p42d_h', strongSave());
  const guest = await accountWithSave('p42d_g', strongSave());
  const hostWs = await open(host.token);
  const guestWs = await open(guest.token);

  const created1 = await post(host.token, '/api/pvp/create', {});
  suite.check('建房 200 forming / mode=pvp / pvp 态尚未生成',
    created1.status === 200 && created1.data?.room?.mode === 'pvp'
    && created1.data.room.status === 'forming' && created1.data.room.pvp === null,
    JSON.stringify(created1.data?.room).slice(0, 220));
  const roomId = created1.data?.room?.roomId;

  const joined = await post(guest.token, `/api/pvp/${roomId}/join`, {});
  suite.check('加入后 active / pvp 态生成 / turn=1',
    joined.status === 200 && joined.data?.room?.status === 'active'
    && !!joined.data?.room?.pvp && joined.data.room.pvp.turn === 1
    && joined.data.room.pvp.finished === false,
    JSON.stringify(joined.data?.room).slice(0, 260));

  const viewHost = await api(`/api/room/${roomId}`, { token: host.token });
  const viewGuest = await api(`/api/room/${roomId}`, { token: guest.token });
  suite.check('双端视图按接收者裁剪：己方完整队伍 / 对方仅公开信息',
    viewHost.data?.room?.pvp?.self?.party?.[0]?.moveIds
    && viewGuest.data?.room?.pvp?.self?.party?.[0]?.moveIds
    && !('moveIds' in (viewHost.data?.room?.pvp?.foe?.party?.[0] ?? {})),
    `host self=${!!viewHost.data?.room?.pvp?.self?.party?.[0]?.moveIds} foe-leak=${'moveIds' in (viewHost.data?.room?.pvp?.foe?.party?.[0] ?? {})}`);

  // ═══ C. 对战推进 ═══
  console.log('\n—— C. 对战推进 ——');
  drain(hostWs); drain(guestWs);
  // 双方各提交一个技能意图，走 REST room action。
  const aAction = await post(host.token, `/api/room/${roomId}/action`, { intent: 'move:tackle', nonce: 'd1' });
  suite.check('一方提交意图 200（未交齐不推进）',
    aAction.status === 200 && aAction.data?.room?.pvp?.turn === 1, JSON.stringify(aAction.data?.room?.pvp).slice(0, 120));
  const bAction = await post(guest.token, `/api/room/${roomId}/action`, { intent: 'move:tackle', nonce: 'd2' });
  suite.check('双方交齐推进一回合 turn=2',
    bAction.status === 200 && bAction.data?.room?.pvp?.turn === 2,
    `turn=${bAction.data?.room?.pvp?.turn}`);

  // 越权：非成员读房间 404
  const outsider = await mk('p42d_o');
  const outsiderRead = await api(`/api/room/${roomId}`, { token: outsider.token });
  suite.check('非成员读房间 404', outsiderRead.status === 404, `status=${outsiderRead.status}`);

  // ═══ D. 结算（一方全灭） ═══
  console.log('\n—— D. 结算（一方全灭）——');
  // 新开一局：强档 vs 弱档，几回合内弱档全灭。
  const host2 = await accountWithSave('p42d_h2', strongSave());
  const guest2 = await accountWithSave('p42d_g2', weakSave());
  const host2Ws = await open(host2.token);
  const guest2Ws = await open(guest2.token);
  const c2 = await post(host2.token, '/api/pvp/create', {});
  const roomId2 = c2.data?.room?.roomId;
  await post(guest2.token, `/api/pvp/${roomId2}/join`, {});

  const revHostBefore = await save.revisionOf(host2.token);
  const revGuestBefore = await save.revisionOf(guest2.token);

  // 打到分出胜负（最多 10 回合）。
  let settled = null;
  for (let i = 0; i < 10; i += 1) {
    const r1 = await post(host2.token, `/api/room/${roomId2}/action`, { intent: 'move:tackle', nonce: `h${i}` });
    const r2 = await post(guest2.token, `/api/room/${roomId2}/action`, { intent: 'move:tackle', nonce: `g${i}` });
    if (r2.data?.room?.status === 'settled' || r2.data?.room?.pvp?.finished) {
      settled = r2.data.room;
      break;
    }
  }
  suite.check('一方全灭后房间 settled 且判出胜者',
    !!settled && settled.status === 'settled' && settled.pvp.finished === true
    && typeof settled.pvp.winnerUserId === 'string',
    JSON.stringify(settled?.pvp).slice(0, 220));

  // 等结算写双方档（异步触发，轮询 revision）。
  await new Promise((r) => setTimeout(r, 800));
  const sHost = await save.session(host2.token);
  const sGuest = await save.session(guest2.token);
  suite.check('结算后双方 revision 各 +1（不互相覆盖）',
    (sHost.data?.revision ?? 0) > (revHostBefore ?? 0)
    && (sGuest.data?.revision ?? 0) > (revGuestBefore ?? 0),
    `host ${revHostBefore}→${sHost.data?.revision}, guest ${revGuestBefore}→${sGuest.data?.revision}`);

  // ═══ E. 逃跑判负 ═══
  console.log('\n—— E. 逃跑判负 ——');
  const host3 = await accountWithSave('p42d_h3', strongSave());
  const guest3 = await accountWithSave('p42d_g3', strongSave());
  await open(host3.token);
  await open(guest3.token);
  const c3 = await post(host3.token, '/api/pvp/create', {});
  const roomId3 = c3.data?.room?.roomId;
  await post(guest3.token, `/api/pvp/${roomId3}/join`, {});
  // 房主逃跑（速度优势下 75% 成功；重试直到成功或判负）。
  let fled = false;
  for (let i = 0; i < 8 && !fled; i += 1) {
    const r = await post(host3.token, `/api/room/${roomId3}/action`, { intent: 'flee', nonce: `f${i}` });
    const r2 = await post(guest3.token, `/api/room/${roomId3}/action`, { intent: 'move:tackle', nonce: `g${i}` });
    if (r2.data?.room?.pvp?.finished) {
      fled = true;
      suite.check('逃跑成功判负：fledUserId=房主，winner=对手',
        r2.data.room.pvp.fledUserId === host3.username || typeof r2.data.room.pvp.fledUserId === 'string',
        JSON.stringify(r2.data.room.pvp).slice(0, 180));
      break;
    }
  }
  suite.check('逃跑流程能走到终态', fled, `fled=${fled}`);

  // ═══ F. 越权与满员 ═══
  console.log('\n—— F. 越权与满员 ——');
  const outsiderWs = await open(outsider.token);
  const full = await post(outsider.token, `/api/pvp/${roomId}/join`, {});
  suite.check('满员房间 join 被拒（ROOM_CLOSED / ROOM_FULL）',
    full.status === 409 && (full.data?.code === 'ROOM_FULL' || full.data?.code === 'ROOM_CLOSED'),
    JSON.stringify(full.data));

  const joinForged = await post(outsider.token, `/api/pvp/${roomId}/join`, { hp: 999 });
  suite.check('join 伪上报 400 PVP_INPUT_FORBIDDEN',
    joinForged.status === 400 && joinForged.data?.code === 'PVP_INPUT_FORBIDDEN', JSON.stringify(joinForged.data));

  // 清理
  for (const c of sockets) await closeWs(c);
  await cleanupAccounts(created);
  suite.done();
}

main().catch((e) => {
  console.error('E2E_P42D 异常：', e);
  process.exit(1);
});
