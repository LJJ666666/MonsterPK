/**
 * P5-1 W6.3（#184）房间 quota 每日上限端到端验收（需后端 :3001 已运行，真 PG）。
 * 运行：cd backend && npm run e2e:w63
 *
 * 与确定性单测的分工：单测用 fake 验证调用形态（条件更新 / 二次 count / 回滚钩子）；
 * 本套件在**真库并发**下验证 DB 裁决，这是唯一能证明「不超卖」的一层：
 *  A 同一 quotaKey 并发建 6 房 → 恰好 limit(3) 房成功，其余 ROOM_QUOTA_EXHAUSTED
 *  B 故障注入：每日累计账置满 → settle 失败，且 room / RoomQuota / Daily 整包回滚
 *  C 恢复后并发结算 3 房 → committed=3 / held=0 / Daily=3 / 再建房被拒
 *  D 重复 settle 幂等，不多扣
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W63_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, requireBackend, loadBackendEnv, RUN,
  openWs, closeWs,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W63');
const quotaKey = `w63_q_${RUN}`;
const periodKey = new Date(Date.now() + 480 * 60_000).toISOString().slice(0, 10);
const created = [];
const roomIds = [];
const sockets = [];

const post = (token, path, body = {}) => api(path, { method: 'POST', token, body });
const get = (token, path) => api(path, { token });

async function db() {
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  return new PrismaClient();
}
const dailyWhere = { quotaKey_periodKey: { quotaKey, periodKey } };

async function cleanup() {
  const p = await db();
  try {
    if (roomIds.length > 0) await p.room.deleteMany({ where: { roomId: { in: roomIds } } });
    await p.roomQuota.deleteMany({ where: { key: quotaKey } });
    await p.roomQuotaDaily.deleteMany({ where: { quotaKey } });
  } finally {
    await p.$disconnect();
  }
}

async function main() {
  const h = await requireBackend();
  suite.check('health 暴露 rooms 状态域（PG 房间态可用）',
    !!h && !!h.rooms && typeof h.rooms.rooms === 'number', JSON.stringify(h?.rooms));

  const A = await newAccount('w63_a');
  created.push(A.username);
  // 房间内核要求实时通道在线（ROOM_WS_REQUIRED），与 w62 套件同前置。
  sockets.push(await openWs({ token: A.token }));

  // ── A 近阈值并发开局：不同 roomId 不共享房间锁，只有 DB 条件更新能挡住 ──
  const rs = await Promise.all(Array.from({ length: 6 }, () =>
    post(A.token, '/api/room/create', { mode: 'kernel', quotaKey })));
  for (const r of rs) {
    const id = r.data?.room?.roomId;
    if (id) roomIds.push(id);
  }
  const okIds = rs.filter((r) => r.status === 200).map((r) => r.data.room.roomId);
  const exhausted = rs.filter((r) => r.data?.code === 'ROOM_QUOTA_EXHAUSTED');
  suite.check('并发 6 房恰好 3 房成功（每日上限 3）', okIds.length === 3,
    `ok=${okIds.length} statuses=${rs.map((r) => r.status).join(',')}`);
  suite.check('其余 3 房返回 ROOM_QUOTA_EXHAUSTED', exhausted.length === 3,
    `exhausted=${exhausted.length}`);

  const q0 = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('占额后 held=3 / committed=0（无覆盖写）',
    q0.data?.usage?.held === 3 && q0.data?.usage?.committed === 0,
    JSON.stringify(q0.data));

  // ── B 故障注入：每日累计账置满，settle 必须失败且整包回滚 ──
  const p = await db();
  await p.roomQuotaDaily.upsert({
    where: dailyWhere,
    create: { quotaKey, periodKey, committed: 3 },
    update: { committed: 3 },
  });
  const blocked = await post(A.token, `/api/room/${okIds[0]}/settle`, {});
  suite.check('二次 count 已满 → settle 被拒（>=400）', blocked.status >= 400,
    `status=${blocked.status} ${JSON.stringify(blocked.data).slice(0, 200)}`);

  const qRollback = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('事务整包回滚：RoomQuota 仍 held=3 / committed=0',
    qRollback.data?.usage?.held === 3 && qRollback.data?.usage?.committed === 0,
    JSON.stringify(qRollback.data));
  const roomRollback = await get(A.token, `/api/room/${okIds[0]}`);
  suite.check('事务整包回滚：房间未被标记 settled',
    roomRollback.data?.room?.status !== 'settled',
    `status=${roomRollback.data?.room?.status}`);
  const dailyRollback = await p.roomQuotaDaily.findUnique({ where: dailyWhere });
  suite.check('事务整包回滚：Daily 仍是注入值 3（未被 +1）',
    dailyRollback?.committed === 3, `committed=${dailyRollback?.committed}`);

  // 恢复：把注入值清回 0，继续正常链路。
  await p.roomQuotaDaily.update({ where: dailyWhere, data: { committed: 0 } });
  await p.$disconnect();

  // ── C 并发结算 3 房 ──
  const ss = await Promise.all(okIds.map((id) => post(A.token, `/api/room/${id}/settle`, {})));
  suite.check('并发 settle 3 房全部 200', ss.every((r) => r.status === 200),
    ss.map((r) => r.status).join(','));
  const q1 = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('结算后 committed=3 / held=0（不超卖）',
    q1.data?.usage?.committed === 3 && q1.data?.usage?.held === 0,
    JSON.stringify(q1.data));

  const p2 = await db();
  const daily = await p2.roomQuotaDaily.findUnique({ where: dailyWhere });
  await p2.$disconnect();
  suite.check('RoomQuotaDaily 每日累计账 = 3 且周期键正确',
    daily?.committed === 3 && daily?.periodKey === periodKey,
    JSON.stringify(daily));

  const extra = await post(A.token, '/api/room/create', { mode: 'kernel', quotaKey });
  if (extra.data?.room?.roomId) roomIds.push(extra.data.room.roomId);
  suite.check('上限已满后再建房被拒',
    extra.data?.code === 'ROOM_QUOTA_EXHAUSTED',
    `status=${extra.status} ${JSON.stringify(extra.data).slice(0, 200)}`);

  // ── D 重复 settle 幂等 ──
  await Promise.all(okIds.map((id) => post(A.token, `/api/room/${id}/settle`, {})));
  const q2 = await get(A.token, `/api/room/quota/${quotaKey}`);
  suite.check('重复 settle 不多扣（committed 仍为 3）',
    q2.data?.usage?.committed === 3, JSON.stringify(q2.data));
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
  try { await cleanup(); } catch (e) { console.warn('[WARN] 房间清理失败', e?.message); }
});
