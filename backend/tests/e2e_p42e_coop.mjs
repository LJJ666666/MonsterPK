/**
 * P4-2e / F16 共斗接口边界与房间意图 端到端验证（需后端 :3001 已运行）。
 * 运行：cd backend && npm run e2e:p42e
 *
 * F16 起共斗升级为 6 房副本，本套件只管「接口边界 / 建房加入 / 六房视图裁剪 /
 * 并发意图只推进一回合 / 意图边界 / 越权与放弃」；
 * 全清通关、发奖、最低贡献门槛、每日上限由 `e2e:f16` 覆盖，避免重复断言。
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42E_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save, requireBackend,
  openWs, closeWs,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42E');
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
const get = (token, path) => api(path, { token });
const BOSS = 'boss_ember_behemoth';

/** 强档：Lv.40 高攻高血，几回合内打倒副本低等级敌人。 */
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

async function accountWithSave(prefix, data) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, data);
  if (r.status !== 200) throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  return acc;
}

/** 建房 + 开 WS + 加入，返回 { host, guest, roomId }。 */
async function makeRoom(hPrefix, gPrefix) {
  const host = await accountWithSave(hPrefix, strongSave());
  const guest = await accountWithSave(gPrefix, strongSave());
  await open(host.token);
  await open(guest.token);
  const c = await post(host.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  if (c.status !== 200) throw new Error(`建房失败 ${c.status}: ${JSON.stringify(c.data)}`);
  const roomId = c.data.room.roomId;
  const j = await post(guest.token, `/api/coop/${roomId}/join`, { slot: 1 });
  if (j.status !== 200) throw new Error(`加入失败 ${j.status}: ${JSON.stringify(j.data)}`);
  return { host, guest, roomId };
}

async function main() {
  await requireBackend();

  // ═══ A. 接口边界 ═══
  console.log('\n—— A. 接口边界 ——');
  const noAuth = await post(null, '/api/coop/create', { slot: 1, bossId: BOSS });
  suite.check('未登录建房 401', noAuth.status === 401, `status=${noAuth.status}`);

  const A = await mk('p42e_a');
  const forged = await post(A.token, '/api/coop/create', { slot: 1, bossId: BOSS, hp: 999, damage: 10000 });
  suite.check('伪上报共斗状态 400 COOP_INPUT_FORBIDDEN',
    forged.status === 400 && forged.data?.code === 'COOP_INPUT_FORBIDDEN', JSON.stringify(forged.data));

  const unknown = await post(A.token, '/api/coop/create', { slot: 1, bossId: 'boss_not_exist' });
  suite.check('未知共斗目标 400 COOP_BOSS_UNKNOWN',
    unknown.status === 400 && unknown.data?.code === 'COOP_BOSS_UNKNOWN', JSON.stringify(unknown.data));

  const noParty = await post(A.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  suite.check('无队伍建房 404 COOP_NO_PARTY',
    noParty.status === 404 && noParty.data?.code === 'COOP_NO_PARTY', JSON.stringify(noParty.data));

  const A2 = await accountWithSave('p42e_a2', strongSave());
  const noWs = await post(A2.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  suite.check('无实时通道建房 409 ROOM_WS_REQUIRED',
    noWs.status === 409 && noWs.data?.code === 'ROOM_WS_REQUIRED', JSON.stringify(noWs.data));

  // ═══ B. 建房加入 ═══
  console.log('\n—— B. 建房加入 ——');
  const host = await accountWithSave('p42e_h', strongSave());
  const guest = await accountWithSave('p42e_g', strongSave());
  await open(host.token);
  await open(guest.token);

  const created1 = await post(host.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  suite.check('建房 200 forming / mode=coop / 六房态尚未生成 / quota held',
    created1.status === 200 && created1.data?.room?.mode === 'coop'
    && created1.data.room.status === 'forming' && created1.data.room.coop === null
    && created1.data.room.quota?.state === 'held',
    JSON.stringify(created1.data?.room).slice(0, 240));
  const roomId = created1.data?.room?.roomId;

  const joined = await post(guest.token, `/api/coop/${roomId}/join`, { slot: 1 });
  suite.check('加入后 active / 六房态生成 / turn=1 / total=6 / 全员在大厅',
    joined.status === 200 && joined.data?.room?.status === 'active'
    && !!joined.data?.room?.coop && joined.data.room.coop.turn === 1
    && joined.data.room.coop.finished === false
    && joined.data.room.coop.rooms.length === 6
    && joined.data.room.coop.total === 6
    && joined.data.room.coop.self.roomIndex === -1,
    JSON.stringify(joined.data?.room?.coop).slice(0, 260));

  const viewHost = await get(host.token, `/api/room/${roomId}`);
  const viewGuest = await get(guest.token, `/api/room/${roomId}`);
  suite.check('双端视图按接收者裁剪：己方完整队伍 / 队友仅公开信息',
    !!viewHost.data?.room?.coop?.self?.party?.[0]?.moveIds
    && !!viewGuest.data?.room?.coop?.self?.party?.[0]?.moveIds
    && !('moveIds' in (viewHost.data?.room?.coop?.members?.[1]?.active ?? {})),
    `host self=${!!viewHost.data?.room?.coop?.self?.party?.[0]?.moveIds}`);

  // ═══ C. 并发意图（只推进一回合 / 两间房各认领一次）═══
  console.log('\n—— C. 并发意图 ——');
  const one = await post(host.token, `/api/room/${roomId}/action`, { intent: 'enter:0', nonce: 'e1' });
  suite.check('一方提交意图 200（未交齐不推进 turn=1）',
    one.status === 200 && one.data?.room?.coop?.turn === 1,
    `turn=${one.data?.room?.coop?.turn}`);

  // A/B 同时提交：withRoomLock 串行，全员交齐只 advanceTurn 一次。
  const [ra, rb] = await Promise.all([
    post(guest.token, `/api/room/${roomId}/action`, { intent: 'enter:1', nonce: 'e2' }),
    post(guest.token, `/api/room/${roomId}/action`, { intent: 'enter:1', nonce: 'e2' }),
  ]);
  const after = await get(host.token, `/api/room/${roomId}`);
  const coopAfter = after.data?.room?.coop;
  suite.check('并发提交只推进一回合 turn=2（不是 3）',
    coopAfter?.turn === 2, `turn=${coopAfter?.turn} ra=${ra.status} rb=${rb.status}`);
  suite.check('重复 nonce 被拒 409 INTENT_REPLAY',
    rb.status === 409 && rb.data?.code === 'INTENT_REPLAY', `${rb.status} ${JSON.stringify(rb.data)}`);
  // F16 后 coopViewFor().rooms 只下发 state / occupantSeat / enemyPreviews 等视图字段，
  // 房间内部 turn 不下发（原断言读 r.turn 恒为 undefined）。结算态由 e2e:f16 覆盖，
  // 本套件按收敛口径只验「接口边界 + 建房视图 + 意图路由」。
  suite.check('六房视图按 F16 契约下发（state / 占领者 / 每房 2 只敌人预览）',
    coopAfter?.rooms?.length === 6
    && coopAfter.rooms.every((r) => ['pending', 'fighting', 'cleared', 'defeated'].includes(r.state))
    && coopAfter.rooms.every((r) => 'occupantSeat' in r
      && Array.isArray(r.enemyPreviews) && r.enemyPreviews.length === 2),
    `states=${JSON.stringify(coopAfter?.rooms?.map((r) => r.state))}`);
  suite.check('贡献记账来自服务端 HP 差（不是客户端上报）',
    coopAfter?.members?.reduce((n, m) => n + (m.contribution ?? 0), 0) > 0,
    `contributions=${JSON.stringify(coopAfter?.members?.map((m) => m.contribution))}`);
  suite.check('POST 返回的快照与随后 GET 的回合一致',
    ra.data?.room?.coop?.turn === coopAfter?.turn || rb.data?.room?.coop?.turn === coopAfter?.turn,
    `ra=${ra.data?.room?.coop?.turn} rb=${rb.data?.room?.coop?.turn} get=${coopAfter?.turn}`);

  // ═══ D. 意图边界 ═══
  console.log('\n—— D. 意图边界 ——');
  const flee = await post(host.token, `/api/room/${roomId}/action`, { intent: 'flee', nonce: 'e3' });
  suite.check('共斗不支持 flee → 400 COOP_INTENT_INVALID',
    flee.status === 400 && flee.data?.code === 'COOP_INTENT_INVALID', `${flee.status} ${JSON.stringify(flee.data)}`);

  const beforeContrib = coopAfter.members.map((m) => m.contribution ?? 0);
  await post(host.token, `/api/room/${roomId}/action`, { intent: 'move:not_a_real_move', nonce: 'e4' });
  await post(guest.token, `/api/room/${roomId}/action`, { intent: 'move:not_a_real_move', nonce: 'e5' });
  const fakeView = await get(host.token, `/api/room/${roomId}`);
  const afterContrib = fakeView.data?.room?.coop?.members?.map((m) => m.contribution ?? 0) ?? [];
  suite.check('伪造技能被服务端降级：不产生新的伤害记账',
    afterContrib.every((n, i) => n === beforeContrib[i]),
    `before=${JSON.stringify(beforeContrib)} after=${JSON.stringify(afterContrib)}`);

  // ═══ E. 越权与放弃 ═══
  console.log('\n—— E. 越权与放弃 ——');
  const outsider = await mk('p42e_o');
  const outsiderRead = await get(outsider.token, `/api/room/${roomId}`);
  suite.check('非成员读房间 404', outsiderRead.status === 404, `status=${outsiderRead.status}`);

  await open(outsider.token);
  const full = await post(outsider.token, `/api/coop/${roomId}/join`, { slot: 1 });
  suite.check('满员房间 join 被拒（ROOM_CLOSED / ROOM_FULL）',
    full.status === 409 && (full.data?.code === 'ROOM_FULL' || full.data?.code === 'ROOM_CLOSED'),
    JSON.stringify(full.data));

  const outsiderIntent = await post(outsider.token, `/api/room/${roomId}/action`, { intent: 'move:tackle', nonce: 'o1' });
  suite.check('非成员发意图 403 ROOM_FORBIDDEN',
    outsiderIntent.status === 403 && outsiderIntent.data?.code === 'ROOM_FORBIDDEN',
    `${outsiderIntent.status} ${JSON.stringify(outsiderIntent.data)}`);

  const r3 = await makeRoom('p42e_h3', 'p42e_g3');
  const abandoned = await post(r3.host.token, `/api/room/${r3.roomId}/abandon`, {});
  suite.check('放弃房间 quota release（不扣次数，全员掉线同路径）',
    abandoned.status === 200 && abandoned.data?.room?.quota?.state === 'released',
    `${abandoned.status} ${JSON.stringify(abandoned.data?.room?.quota)}`);

  // 清理
  for (const c of sockets) await closeWs(c);
  await cleanupAccounts(created);
  suite.done();
}

main().catch((e) => {
  console.error('E2E_P42E 异常：', e);
  process.exit(1);
});
