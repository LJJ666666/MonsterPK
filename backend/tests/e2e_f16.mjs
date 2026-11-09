/**
 * F16 共斗 6 房副本 端到端验证（需后端 :3001 已运行）。
 * 运行：cd backend && npm run e2e:f16
 *
 * 分区：
 *  A 接口边界   伪上报六房状态 / 贡献 / 奖励 400；flee 400
 *  B 建房加入   create → join → 六房态生成 → 双端视图裁剪 → quota held
 *  C 全清通关   enter:/move: 推进到 6 房全 cleared → settled / result=win
 *  D 发奖       双人各 +40 金钱 + capsule_basic×1（恰好一次，不双花）
 *  E 最低贡献   队友全程 idle → 一人全清仍通关，但 0 贡献者不发奖
 *  F 每日上限   同一账号每日 3 次通关，第 4 次建房 409 ROOM_QUOTA_EXHAUSTED
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_F16_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save, requireBackend,
  openWs, closeWs, sleep,
} from './lib/harness.mjs';

const suite = new Suite('E2E_F16');
const created = [];
const sockets = [];
const BOSS = 'boss_ember_behemoth';
const BASE_MONEY = 5000;
const BASE_CAPSULE = 2;
const REWARD_MONEY = 40;

const post = (token, path, body = {}) => api(path, { method: 'POST', token, body });
const get = (token, path) => api(path, { token });

/** 强档：6 只 Lv.40 高攻高血，保证一击必杀低等级副本敌人且不会被反杀。 */
function dungeonSave(tag) {
  const base = validSave();
  const m0 = base.party[0] ?? {};
  const party = Array.from({ length: 6 }, (_, i) => ({
    ...m0,
    id: `dng_${tag}_${i}`,
    level: 40, maxHp: 400, hp: 400,
    atk: 500, def: 300, spAtk: 500, spDef: 300, spd: 300,
    status: 'none', moveIds: ['tackle'],
  }));
  return {
    ...base,
    money: BASE_MONEY,
    inventory: { ...(base.inventory ?? {}), capsule_basic: BASE_CAPSULE },
    party,
  };
}

async function accountWithSave(prefix, tag) {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  const r = await save.put(acc.token, dungeonSave(tag));
  if (r.status !== 200) {
    throw new Error(`建档失败 ${prefix} ${r.status}: ${JSON.stringify(r.data).slice(0, 220)}`);
  }
  return acc;
}

/** GET /api/save 的 data 可能是裸存档或带 raw 的包装，两种都兼容。 */
function parseSave(data) {
  if (typeof data !== 'string') return null;
  try {
    const outer = JSON.parse(data);
    return typeof outer?.raw === 'string' ? JSON.parse(outer.raw) : outer;
  } catch {
    return null;
  }
}

async function readSaveData(token) {
  const r = await get(token, '/api/save?slot=1');
  return parseSave(r.data?.data);
}

/** 轮询等结算写档完成（异步结算 + 发奖），避免固定 sleep 抖动。 */
async function waitForMoney(token, expected, tries = 24) {
  for (let i = 0; i < tries; i += 1) {
    const s = await readSaveData(token);
    if (s && s.money === expected) return s;
    await sleep(250);
  }
  return readSaveData(token);
}

/** 按接收者视图挑本回合意图：在大厅认领第一间可进房，在房内出招。 */
function intentFor(coop) {
  if (!coop || coop.finished || coop.self.out) return 'idle';
  if (coop.self.roomIndex >= 0) return 'move:tackle';
  const target = coop.rooms.find(
    (r) => (r.state === 'pending' || r.state === 'defeated') && r.occupantSeat === null,
  );
  return target ? `enter:${target.index}` : 'idle';
}

async function newRoom(host, guest) {
  const c = await post(host.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  if (c.status !== 200) throw new Error(`建房失败 ${c.status}: ${JSON.stringify(c.data)}`);
  const roomId = c.data.room.roomId;
  const j = await post(guest.token, `/api/coop/${roomId}/join`, { slot: 1 });
  if (j.status !== 200) throw new Error(`加入失败 ${j.status}: ${JSON.stringify(j.data)}`);
  return { roomId, created: c.data.room, joined: j.data.room };
}

/** 推进到副本结束；guestIdle=true 时队友全程不进房（验证最低贡献门槛）。 */
async function playToFinish(host, guest, roomId, tag, guestIdle = false) {
  let lastRoom = null;
  for (let round = 0; round < 48; round += 1) {
    const hv = await get(host.token, `/api/room/${roomId}`);
    const hostCoop = hv.data?.room?.coop;
    if (hv.data?.room?.status === 'settled' || hostCoop?.finished) {
      lastRoom = hv.data.room;
      break;
    }
    const gv = await get(guest.token, `/api/room/${roomId}`);
    const guestCoop = gv.data?.room?.coop;
    const hi = intentFor(hostCoop);
    const gi = guestIdle ? 'idle' : intentFor(guestCoop);
    await post(host.token, `/api/room/${roomId}/action`, { intent: hi, nonce: `h_${tag}_${round}` });
    const last = await post(guest.token, `/api/room/${roomId}/action`, { intent: gi, nonce: `g_${tag}_${round}` });
    if (last.data?.room?.coop?.finished || last.data?.room?.status === 'settled') {
      lastRoom = last.data.room;
    }
  }
  return lastRoom;
}

async function main() {
  await requireBackend();

  // ═══ A. 接口边界 ═══
  console.log('\n—— A. 接口边界 ——');
  const probe = await accountWithSave('f16_a', 'a');
  const forgedRooms = await post(probe.token, '/api/coop/create', {
    slot: 1, bossId: BOSS, rooms: [], contribution: 99999, reward: 1,
  });
  suite.check('伪上报六房状态 / 贡献 / 奖励 400 COOP_INPUT_FORBIDDEN',
    forgedRooms.status === 400 && forgedRooms.data?.code === 'COOP_INPUT_FORBIDDEN',
    JSON.stringify(forgedRooms.data));

  // ═══ B. 建房加入 ═══
  console.log('\n—— B. 建房加入 ——');
  const host = await accountWithSave('f16_h', 'h');
  const guest = await accountWithSave('f16_g', 'g');
  sockets.push(await openWs({ token: host.token }));
  sockets.push(await openWs({ token: guest.token }));

  const first = await newRoom(host, guest);
  suite.check('建房 200 forming / mode=coop / 六房态尚未生成 / quota held',
    first.created?.mode === 'coop' && first.created?.status === 'forming'
    && first.created?.coop === null && first.created?.quota?.state === 'held',
    JSON.stringify(first.created).slice(0, 240));
  suite.check('加入后 active / 六房态生成 / total=6 / cleared=0 / 全员在大厅',
    first.joined?.status === 'active' && first.joined?.coop?.rooms?.length === 6
    && first.joined.coop.total === 6 && first.joined.coop.cleared === 0
    && first.joined.coop.self.roomIndex === -1,
    JSON.stringify(first.joined?.coop).slice(0, 260));

  const vh = await get(host.token, `/api/room/${first.roomId}`);
  const vg = await get(guest.token, `/api/room/${first.roomId}`);
  suite.check('双端视图按接收者裁剪：己方完整队伍 / 队友仅公开信息',
    !!vh.data?.room?.coop?.self?.party?.[0]?.moveIds
    && !!vg.data?.room?.coop?.self?.party?.[0]?.moveIds
    && !('moveIds' in (vh.data?.room?.coop?.members?.[1]?.active ?? {})),
    `host self=${!!vh.data?.room?.coop?.self?.party?.[0]?.moveIds}`);

  const flee = await post(host.token, `/api/room/${first.roomId}/action`, { intent: 'flee', nonce: 'f16_flee' });
  suite.check('共斗不支持 flee → 400 COOP_INTENT_INVALID',
    flee.status === 400 && flee.data?.code === 'COOP_INTENT_INVALID',
    `${flee.status} ${JSON.stringify(flee.data)}`);

  // ═══ C/D. 第一场：双人合作全清 + 双方发奖 ═══
  console.log('\n—— C/D. 第一场：双人全清与发奖 ——');
  const s1 = await playToFinish(host, guest, first.roomId, 's1');
  suite.check('六房全清 → settled / result=win / cleared=6',
    !!s1 && s1.status === 'settled' && s1.coop?.result === 'win' && s1.coop?.cleared === 6,
    JSON.stringify(s1?.coop && { result: s1.coop.result, cleared: s1.coop.cleared, rooms: s1.coop.rooms.map((r) => r.state) }));

  const e1h = BASE_MONEY + REWARD_MONEY;
  const e1g = BASE_MONEY + REWARD_MONEY;
  const h1 = await waitForMoney(host.token, e1h);
  const g1 = await waitForMoney(guest.token, e1g);
  suite.check('房主通关奖励：+40 金钱 / +capsule_basic×1（恰好一次，不双花）',
    h1?.money === e1h && (h1?.inventory?.capsule_basic ?? 0) === BASE_CAPSULE + 1,
    `money=${h1?.money} capsule=${h1?.inventory?.capsule_basic}`);
  suite.check('队友（有贡献）同样获发通关奖励',
    g1?.money === e1g && (g1?.inventory?.capsule_basic ?? 0) === BASE_CAPSULE + 1,
    `money=${g1?.money} capsule=${g1?.inventory?.capsule_basic}`);

  // ═══ E. 第二场：队友全程 idle → 一人全清，0 贡献者不发奖 ═══
  console.log('\n—— E. 最低贡献门槛 ——');
  const second = await newRoom(host, guest);
  const s2 = await playToFinish(host, guest, second.roomId, 's2', true);
  suite.check('一人全清仍通关（没规定谁要杀多少个）',
    !!s2 && s2.coop?.result === 'win' && s2.coop?.cleared === 6,
    JSON.stringify(s2?.coop && { result: s2.coop.result, cleared: s2.coop.cleared }));
  const e2h = e1h + REWARD_MONEY;
  const h2 = await waitForMoney(host.token, e2h);
  const g2 = await readSaveData(guest.token);
  suite.check('清房者再获一份奖励（幂等按场计）', h2?.money === e2h, `money=${h2?.money}`);
  // 等一会儿确认服务端确实没给挂机者补发
  await sleep(700);
  const g2b = await readSaveData(guest.token);
  suite.check('全程 idle / 0 贡献者不发奖（最低贡献门槛）',
    g2?.money === e1g && g2b?.money === e1g,
    `money=${g2?.money}→${g2b?.money} expect=${e1g}`);

  // ═══ F. 第三场 + 每日上限 ═══
  console.log('\n—— F. 每日通关上限 ——');
  const third = await newRoom(host, guest);
  const s3 = await playToFinish(host, guest, third.roomId, 's3');
  suite.check('第三场仍可通关并发奖',
    !!s3 && s3.coop?.result === 'win', JSON.stringify(s3?.coop && { result: s3.coop.result }));
  const e3h = e2h + REWARD_MONEY;
  const h3 = await waitForMoney(host.token, e3h);
  suite.check('第三场奖励到账（每日上限内）', h3?.money === e3h, `money=${h3?.money}`);

  const fourth = await post(host.token, '/api/coop/create', { slot: 1, bossId: BOSS });
  suite.check('第 4 次建房被每日上限拦下 409 ROOM_QUOTA_EXHAUSTED',
    fourth.status === 409 && fourth.data?.code === 'ROOM_QUOTA_EXHAUSTED',
    `${fourth.status} ${JSON.stringify(fourth.data)}`);

  // 清理
  for (const c of sockets) await closeWs(c);
  await cleanupAccounts(created);
  suite.done();
}

main().catch((e) => {
  console.error('E2E_F16 异常：', e);
  process.exit(1);
});
