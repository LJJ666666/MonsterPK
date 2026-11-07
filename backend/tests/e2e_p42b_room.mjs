/**
 * P4-2b 房间内核端到端验证（需前后端服务运行；后端 :3001 已起即可）。
 * 运行：cd backend && npm run e2e:p42b
 *
 * 分区：
 *  A 接口边界   health.rooms / 鉴权 / 伪上报状态 / 无 WS 拒绝 / 无整包写入口
 *  B 创建加入   forming→active / 双端 self 视图 / quota hold 不消耗 / 非成员不泄露
 *  C 意图上行   WS room.action 裁决广播 / nonce 重放 / 全员交齐推进 / room.resync
 *  D 超时       服务端注入 RNG 随机代放并推进回合
 *  E 掉线口径   保留座位 → 同 token 重连 → 换设备不转移 → 超窗可选托管
 *  F 全员掉线   解散不扣次数（quota release、committed 仍 0）
 *  G 正常结算   quota commit 扣一次；伪造 room.state 上行被拒并关 1008
 *
 * kernel 档用服务端短阈值（1.2s / 1.8s / 3.5s），不需要真等 20s/30s/60s。
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42B_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, login, cleanupAccounts, requireBackend,
  openWs, closeWs, waitMsg, waitClose, sendRaw, sleep, RUN,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42B');
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
const waitRoom = (ctx, pred, timeout = 5_000) =>
  waitMsg(ctx, (m) => m.type === 'room.state' && pred(m.room), timeout);

async function main() {
  const h = await requireBackend();
  suite.check('health 暴露 rooms 状态域',
    !!h && !!h.rooms && typeof h.rooms.rooms === 'number', JSON.stringify(h?.rooms));

  // ── A 接口边界 ──
  const A = await mk('p42b_a');
  const noAuth = await post(null, '/api/room/create', { mode: 'kernel' });
  suite.check('未登录创建房间 401', noAuth.status === 401, `status=${noAuth.status}`);
  const forged = await post(A.token, '/api/room/create', { mode: 'kernel', status: 'settled' });
  suite.check('上报房间状态字段 400 ROOM_INPUT_FORBIDDEN',
    forged.status === 400 && forged.data?.code === 'ROOM_INPUT_FORBIDDEN', JSON.stringify(forged.data));
  const forgedLimit = await post(A.token, '/api/room/create', { mode: 'kernel', quotaLimit: 999 });
  suite.check('上报次数上限 400（限制只由服务端给）',
    forgedLimit.status === 400 && forgedLimit.data?.code === 'ROOM_INPUT_FORBIDDEN');
  const badMode = await post(A.token, '/api/room/create', { mode: 'hacked' });
  suite.check('未知玩法模式 400', badMode.status === 400, `status=${badMode.status}`);
  const noWs = await post(A.token, '/api/room/create', { mode: 'kernel' });
  suite.check('无实时通道 409 ROOM_WS_REQUIRED',
    noWs.status === 409 && noWs.data?.code === 'ROOM_WS_REQUIRED', JSON.stringify(noWs.data));

  // ── B 创建 / 加入 / 只读 ──
  const aWs = await open(A.token);
  suite.check('hello 声明 room.state 能力',
    aWs.ok && aWs.hello?.capabilities?.includes('room.state'), `ok=${aWs.ok}`);
  const quotaKey = `p42b_q1_${RUN}`;
  const created1 = await post(A.token, '/api/room/create', { mode: 'kernel', quotaKey });
  suite.check('创建房间 200 forming（revision 1）',
    created1.status === 200 && created1.data?.room?.status === 'forming'
    && created1.data.room.revision === 1, JSON.stringify(created1.data).slice(0, 220));
  const roomId = created1.data?.room?.roomId;
  const q1 = await api(`/api/room/quota/${quotaKey}`, { token: A.token });
  suite.check('quota hold 只预留不消耗',
    q1.data?.usage?.held === 1 && q1.data?.usage?.committed === 0, JSON.stringify(q1.data));

  const B = await mk('p42b_b');
  const joinNoWs = await post(B.token, `/api/room/${roomId}/join`, {});
  suite.check('无 WS 加入 409', joinNoWs.status === 409 && joinNoWs.data?.code === 'ROOM_WS_REQUIRED');
  const bWs = await open(B.token);
  const joined = await post(B.token, `/api/room/${roomId}/join`, {});
  suite.check('B 加入后 active / 2 座位 / self 正确',
    joined.status === 200 && joined.data?.room?.status === 'active'
    && joined.data.room.seats.length === 2 && joined.data.room.seats[1].self === true,
    JSON.stringify(joined.data?.room?.seats));
  const viewA = await api(`/api/room/${roomId}`, { token: A.token });
  suite.check('A 的视图只把 seat 0 标为 self',
    viewA.data?.room?.seats?.[0]?.self === true && viewA.data.room.seats[1].self === false);
  const rawView = JSON.stringify(viewA.data?.room ?? {});
  suite.check('视图不泄露 token / connectionId / 他人 userId',
    !rawView.includes('digest') && !rawView.includes('conn_')
    && !rawView.includes(A.username) && !rawView.includes(B.username));
  const C = await mk('p42b_c');
  const outsider = await api(`/api/room/${roomId}`, { token: C.token });
  suite.check('非成员读房间 404 不泄露存在性',
    outsider.status === 404 && outsider.data?.code === 'ROOM_NOT_FOUND');
  const wholePut = await api(`/api/room/${roomId}`, { method: 'PUT', token: A.token, body: { status: 'settled' } });
  suite.check('房间接口没有整包写入口', wholePut.status === 404, `status=${wholePut.status}`);
  const badQuotaKey = await api('/api/room/quota/bad%20key', { token: A.token });
  suite.check('非法次数键 400', badQuotaKey.status === 400, `status=${badQuotaKey.status}`);

  // ── C 意图与 WS 上行 ──
  const cWs = await open(C.token);
  drain(aWs); drain(bWs);
  sendRaw(aWs, JSON.stringify({
    type: 'room.action', roomId, action: 'intent', intent: 'move_1', nonce: 'n1',
    status: 'settled', revision: 999,
  }));
  const m1 = await waitRoom(bWs, (r) => r.lastAction?.seat === 0 && r.lastAction?.kind === 'manual');
  suite.check('WS 意图经服务端裁决并广播全量快照', !!m1, JSON.stringify(m1?.room).slice(0, 220));
  suite.check('意图后 A 座位标记已提交且伪状态未生效',
    m1?.room?.seats?.[0]?.submitted === true && m1.room.status === 'active'
    && m1.room.revision < 999, `status=${m1?.room?.status} rev=${m1?.room?.revision}`);
  sendRaw(aWs, JSON.stringify({ type: 'room.action', roomId, action: 'intent', intent: 'move_2', nonce: 'n1' }));
  const replay = await waitMsg(aWs, (m) => m.type === 'error' && m.code === 'INTENT_REPLAY');
  suite.check('WS nonce 重放被拒', !!replay);
  const dup = await post(A.token, `/api/room/${roomId}/action`, { intent: 'move_2', nonce: 'n2' });
  suite.check('REST 同回合重复提交 409',
    dup.status === 409 && dup.data?.code === 'TURN_ALREADY_SUBMITTED', JSON.stringify(dup.data));
  const bAction = await post(B.token, `/api/room/${roomId}/action`, { intent: 'move_3', nonce: 'n3' });
  suite.check('全员交齐立即推进回合',
    bAction.status === 200 && bAction.data?.room?.turn >= 2
    && bAction.data.room.seats.every((s) => !s.submitted), JSON.stringify(bAction.data?.room).slice(0, 220));
  sendRaw(cWs, JSON.stringify({ type: 'room.action', roomId, action: 'intent', intent: 'move_1', nonce: 'cx1' }));
  const outErr = await waitMsg(cWs, (m) => m.type === 'error' && m.code === 'ROOM_FORBIDDEN');
  suite.check('非成员 WS 意图被拒', !!outErr);
  drain(bWs);
  sendRaw(bWs, JSON.stringify({ type: 'room.resync', roomId, data: 'fake', revision: 999 }));
  const resync = await waitRoom(bWs, (r) => r.roomId === roomId);
  suite.check('room.resync 只重推快照且不采信携带字段',
    !!resync && resync.room.revision < 999 && resync.room.status === 'active');

  // ── D 回合超时 ──
  drain(aWs); drain(bWs);
  await sleep(1_600); // > kernel roundTimeoutMs=1.2s
  const timeoutMsg = await waitRoom(bWs, (r) => r.lastAction?.kind === 'timeout', 4_000);
  suite.check('回合超时由服务端随机代放并广播', !!timeoutMsg, JSON.stringify(timeoutMsg?.room?.lastAction));
  suite.check('超时代放后回合正常推进',
    (timeoutMsg?.room?.turn ?? 0) >= 3, `turn=${timeoutMsg?.room?.turn}`);

  // ── E 掉线 / 重连 / 顶号 / 托管 ──
  drain(bWs);
  await closeWs(aWs);
  const paused = await waitRoom(bWs, (r) => r.status === 'paused' && r.seats[0].online === false);
  suite.check('掉线保留座位与回合态并推 paused 快照',
    !!paused && paused.room.seats.length === 2 && paused.room.turn >= 1,
    JSON.stringify(paused?.room?.seats));
  const aWs2 = await open(A.token);
  const resumed = await waitRoom(bWs, (r) => r.status === 'active' && r.seats[0].online === true);
  suite.check('同一 token 同一设备重连原位恢复', !!resumed, `aWs2.ok=${aWs2.ok}`);

  const relogin = await login(A.username, A.password);
  suite.check('换设备登录签出新 token',
    relogin.status === 200 && !!relogin.data?.token && relogin.data.token !== A.token);
  const oldRest = await api('/api/room', { token: A.token });
  suite.check('旧 token REST 403 SESSION_REPLACED',
    oldRest.status === 403 && oldRest.data?.code === 'SESSION_REPLACED', JSON.stringify(oldRest.data));
  const oldWs = await open(A.token);
  suite.check('旧 token WS 握手 403', !oldWs.ok && oldWs.status === 403, `status=${oldWs.status}`);
  const aWsNew = await open(relogin.data.token);
  await sleep(150);
  const afterTakeover = await api(`/api/room/${roomId}`, { token: relogin.data.token });
  suite.check('换设备不转移座位（座位仍为掉线）',
    afterTakeover.data?.room?.seats?.[0]?.online === false,
    JSON.stringify(afterTakeover.data?.room?.seats));

  const early = await post(B.token, `/api/room/${roomId}/autopilot`, {
    targetSeat: 0, enabled: true, nonce: 'ap1',
  });
  suite.check('重连窗口内不能开托管 409 AUTOPILOT_TOO_EARLY',
    early.status === 409 && early.data?.code === 'AUTOPILOT_TOO_EARLY', JSON.stringify(early.data));
  await sleep(2_000); // > kernel autopilotOfferMs=1.8s
  const late = await post(B.token, `/api/room/${roomId}/autopilot`, {
    targetSeat: 0, enabled: true, nonce: 'ap2',
  });
  suite.check('超窗后房内在线成员可选开启托管',
    late.status === 200 && late.data?.room?.seats?.[0]?.autopilot === true,
    JSON.stringify(late.data?.room?.seats));

  // ── F 全员掉线：解散、不扣次数 ──
  drain(bWs);
  await closeWs(bWs);
  await closeWs(aWsNew);
  await sleep(3_900); // > kernel allOfflineGraceMs=3.5s
  const finalView = await api(`/api/room/${roomId}`, { token: relogin.data.token });
  suite.check('全员掉线解散为 abandoned',
    finalView.data?.room?.status === 'abandoned', JSON.stringify(finalView.data?.room?.status));
  suite.check('解散原因是 all_offline', finalView.data?.room?.endReason === 'all_offline');
  suite.check('quota 标记 released', finalView.data?.room?.quota?.state === 'released');
  const q1After = await api(`/api/room/quota/${quotaKey}`, { token: relogin.data.token });
  suite.check('全员掉线不扣次数（committed 仍 0）',
    q1After.data?.usage?.committed === 0 && q1After.data.usage.held === 0,
    JSON.stringify(q1After.data));

  // ── G 正常结算扣一次 + 伪造上行拒绝 ──
  const D = await mk('p42b_d');
  await open(D.token);
  await open(B.token);
  const quotaKey2 = `p42b_q2_${RUN}`;
  const c2 = await post(B.token, '/api/room/create', { mode: 'kernel', quotaKey: quotaKey2 });
  const room2 = c2.data?.room?.roomId;
  const j2 = await post(D.token, `/api/room/${room2}/join`, {});
  suite.check('第二房间创建并加入成功', c2.status === 200 && j2.status === 200,
    `create=${c2.status} join=${j2.status}`);
  const outsiderSettle = await post(C.token, `/api/room/${room2}/settle`, {});
  suite.check('非成员结算 404', outsiderSettle.status === 404);
  const settled = await post(B.token, `/api/room/${room2}/settle`, {});
  suite.check('正常结算 → settled',
    settled.status === 200 && settled.data?.room?.status === 'settled', JSON.stringify(settled.data?.room?.status));
  const q2 = await api(`/api/room/quota/${quotaKey2}`, { token: B.token });
  suite.check('正常结算扣一次（committed=1 / held=0）',
    q2.data?.usage?.committed === 1 && q2.data.usage.held === 0, JSON.stringify(q2.data));

  sendRaw(cWs, JSON.stringify({
    type: 'room.state', room: { roomId: 'fake', status: 'settled', revision: 999 },
  }));
  const unknown = await waitMsg(cWs, (m) => m.type === 'error' && m.code === 'UNKNOWN_TYPE');
  suite.check('伪造 room.state 上行被拒 UNKNOWN_TYPE', !!unknown);
  const closed = await waitClose(cWs.ws, 4_000);
  suite.check('伪造上行关闭 1008', closed.code === 1008, JSON.stringify(closed));
}

main().then(() => {
  suite.done();
}).catch((e) => {
  console.error('[FATAL]', e);
  suite.check('E2E 未抛未捕获异常', false, String(e?.message ?? e));
  suite.done();
}).finally(async () => {
  for (const s of sockets) {
    try { await closeWs(s); } catch { /* 已断开 */ }
  }
  try { await cleanupAccounts(created); } catch (e) { console.warn('[WARN] 清理失败', e?.message); }
});
