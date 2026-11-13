/**
 * P5-1 W6.2（#183）房间工作单元端到端验收（需后端 :3001 已运行，真 PG）。
 * 运行：cd backend && npm run e2e:w62
 *
 * 与 W6.2 确定性单测的分工：单测用 fake runner 验证「同一事务客户端 / 提交后才
 * 发副作用 / 失败整段丢弃」；本套件在真库上验证行为零回归与原子可见性：
 *  A 建房 + quota hold 同一事务可见
 *  B 同回合双意图并发只推进 1 回合
 *  C room.state 广播在事务提交后送达且与 GET 的已提交状态一致
 *  D nonce 重放不产生半写
 *  E 重复 settle 不双扣 quota（committed 恰好 1）
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W62_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, requireBackend,
  openWs, closeWs, waitMsg, loadBackendEnv, RUN,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W62');
const created = [];
const sockets = [];
const roomIds = [];
const quotaKey = `w62_q_${RUN}`;

const mk = async (suffix) => {
  const acc = await newAccount(`w62_${suffix}`);
  created.push(acc.username);
  return acc;
};
const open = async (token) => {
  const ctx = await openWs({ token });
  sockets.push(ctx);
  return ctx;
};
const post = (token, path, body = {}) => api(path, { method: 'POST', token, body });
const get = (token, path) => api(path, { token });
const drain = (ctx) => { if (ctx?.queue) ctx.queue.length = 0; };
const waitRoom = (ctx, pred, timeout = 5_000) =>
  waitMsg(ctx, (m) => m.type === 'room.state' && pred(m.room), timeout);

/** 房间 / quota 表不随账号级联删除，按本次创建的 id / key 精确清理。 */
async function cleanupRooms() {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    if (roomIds.length > 0) await prisma.room.deleteMany({ where: { roomId: { in: roomIds } } });
    await prisma.roomQuota.deleteMany({ where: { key: quotaKey } });
  } finally {
    await prisma.$disconnect();
  }
}

async function main() {
  const h = await requireBackend();
  suite.check('health 暴露 rooms 状态域（PG 房间态可用）',
    !!h && !!h.rooms && typeof h.rooms.rooms === 'number', JSON.stringify(h?.rooms));

  const A = await mk('a');
  const B = await mk('b');
  const aWs = await open(A.token);
  const bWs = await open(B.token);

  // ── A 建房 + quota hold 原子可见 ──
  const created1 = await post(A.token, '/api/room/create', { mode: 'kernel', quotaKey });
  const roomId = created1.data?.room?.roomId;
  if (roomId) roomIds.push(roomId);
  suite.check('建房 200 forming / revision=1',
    created1.status === 200 && created1.data?.room?.status === 'forming'
    && created1.data.room.revision === 1, JSON.stringify(created1.data).slice(0, 220));

  const q0 = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('quota hold 与房间行同一事务可见（held=1 / committed=0）',
    q0.data?.usage?.held === 1 && q0.data?.usage?.committed === 0, JSON.stringify(q0.data));

  const joined = await post(B.token, `/api/room/${roomId}/join`, {});
  suite.check('加入后 active / 2 座位',
    joined.status === 200 && joined.data?.room?.status === 'active'
    && joined.data.room.seats.length === 2, JSON.stringify(joined.data?.room?.seats));

  // ── B 同回合双意图并发只推进 1 回合 ──
  drain(aWs); drain(bWs);
  const [ra, rb] = await Promise.all([
    post(A.token, `/api/room/${roomId}/action`, { intent: 'move_1', nonce: 'w62_n1' }),
    post(B.token, `/api/room/${roomId}/action`, { intent: 'move_2', nonce: 'w62_n2' }),
  ]);
  const after = await get(A.token, `/api/room/${roomId}`);
  suite.check('并发双意图都 200', ra.status === 200 && rb.status === 200,
    `A=${ra.status} B=${rb.status}`);
  suite.check('只推进一回合 turn=2（不是 3）',
    after.data?.room?.turn === 2, `turn=${after.data?.room?.turn}`);
  suite.check('两个座位 submitted 均已清空',
    Array.isArray(after.data?.room?.seats)
    && after.data.room.seats.every((s) => !s.submitted),
    JSON.stringify(after.data?.room?.seats));

  // ── C 广播在提交后送达，且与已提交状态一致 ──
  const snap = await waitRoom(bWs, (r) => r.roomId === roomId && r.turn === 2, 5_000);
  suite.check('提交后才广播 room.state（turn=2）', !!snap,
    JSON.stringify(snap?.room).slice(0, 220));
  suite.check('广播 revision 不低于 GET 的已提交 revision',
    (snap?.room?.revision ?? -1) >= (after.data?.room?.revision ?? 0),
    `ws=${snap?.room?.revision} get=${after.data?.room?.revision}`);

  // ── D nonce 重放不产生半写 ──
  const replay = await post(A.token, `/api/room/${roomId}/action`, { intent: 'move_9', nonce: 'w62_n1' });
  const afterReplay = await get(A.token, `/api/room/${roomId}`);
  suite.check('nonce 重放 409 INTENT_REPLAY 且 turn 不变',
    replay.status === 409 && replay.data?.code === 'INTENT_REPLAY'
    && afterReplay.data?.room?.turn === 2,
    `${replay.status} ${JSON.stringify(replay.data)} turn=${afterReplay.data?.room?.turn}`);

  // ── E 重复 settle 不双扣 quota ──
  const s1 = await post(A.token, `/api/room/${roomId}/settle`, {});
  const s2 = await post(A.token, `/api/room/${roomId}/settle`, {});
  const q1 = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('正常结算 → settled',
    s1.status === 200 && s1.data?.room?.status === 'settled', JSON.stringify(s1.data?.room?.status));
  suite.check('重复 settle 仍 200 且幂等（不抛事务错误）', s2.status === 200, `status=${s2.status}`);
  suite.check('quota 只扣一次（committed=1 / held=0）',
    q1.data?.usage?.committed === 1 && q1.data?.usage?.held === 0, JSON.stringify(q1.data));
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
  try { await cleanupAccounts(created); } catch (e) { console.warn('[WARN] 账号清理失败', e?.message); }
  try { await cleanupRooms(); } catch (e) { console.warn('[WARN] 房间清理失败', e?.message); }
});
