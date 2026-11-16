/**
 * p42e nonce 去重：确定性复现 / 定性用例（需后端 :3001 已运行）。
 * 运行：cd backend && npm run e2e:nonce
 *
 * 背景（bug_log §82 / §82 订正）：`e2e:p42e` 的「重复 nonce 被拒 409」在全量 verify
 * 并行、机器慢的时候偶尔变红，单跑稳定绿。原断言假定「并发两路里**第二路**必须被拒」，
 * 这个假定在 HTTP 并发下并不成立 —— 谁先拿到房间锁是随机的。
 *
 * 本套件不再假定顺序，只验证两条**语义**：
 *   S1（确定性）：同一个 nonce 在串行重放时**必然** 409 INTENT_REPLAY（跑 3 次都判）。
 *   S2（并发）：同一 nonce 两路并发时，**恰好一路 200、另一路 409**，且 turn 只推进一格。
 * 同时统计「409 落在第一路 / 第二路」的出现次数：若两种顺序都出现过，就证明
 * `e2e:p42e` 原来那条断言本身就是不稳定源（而不是产品去重失效）。
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_P42E_NONCE_OK；任一失败 exit 1。
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save, requireBackend,
  openWs, closeWs,
} from './lib/harness.mjs';

const suite = new Suite('E2E_P42E_NONCE');
const created = [];
const sockets = [];
const ROUNDS = 20;

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

function strongSave() {
  const base = validSave();
  return {
    ...base,
    money: 5000,
    party: base.party.map((m, i) => ({
      ...m, level: 40, maxHp: 200, hp: 200,
      atk: 320, def: 200, spAtk: 320, spDef: 200, spd: 240,
      moveIds: i === 0 ? ['tackle', 'wood_strike'] : ['tackle'],
    })),
  };
}

async function accountWithSave(prefix) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, strongSave());
  if (r.status !== 200) throw new Error(`建档失败 ${prefix} ${r.status}`);
  return acc;
}

/** 建房 + 开 WS + 加入，返回 { host, guest, roomId }。 */
async function makeRoom(hPrefix, gPrefix) {
  const host = await accountWithSave(hPrefix);
  const guest = await accountWithSave(gPrefix);
  await open(host.token);
  await open(guest.token);
  const c = await post(host.token, '/api/coop/create', { bossId: BOSS });
  if (c.status !== 200) throw new Error(`建房失败 ${c.status}: ${JSON.stringify(c.data).slice(0, 200)}`);
  const roomId = c.data.room.roomId;
  const j = await post(guest.token, `/api/coop/${roomId}/join`, {});
  if (j.status !== 200) throw new Error(`加入失败 ${j.status}: ${JSON.stringify(j.data).slice(0, 200)}`);
  return { host, guest, roomId };
}

const act = (token, roomId, intent, nonce) => post(token, `/api/room/${roomId}/action`, { intent, nonce });
const tag = (r) => `${r.status}${r.data?.code ? '/' + r.data.code : ''}`;

async function main() {
  await requireBackend();
  const { host, guest, roomId } = await makeRoom('nonce_h', 'nonce_g');

  // ═══ S1. 确定性：串行重放同一个 nonce，必然 409 ═══
  console.log('\n—— S1. 串行重放（确定性）——');
  const first = await act(host.token, roomId, 'enter:0', 'seq_1');
  suite.check('首提 200（同回合本方第一次提交）', first.status === 200, tag(first));

  for (let i = 1; i <= 3; i++) {
    const again = await act(host.token, roomId, 'enter:0', 'seq_1');
    suite.check(`第 ${i} 次串行重放 409 INTENT_REPLAY（顺序确定性，不该偶发）`,
      again.status === 409 && again.data?.code === 'INTENT_REPLAY', tag(again));
  }

  // 换一个 nonce 但本回合已提交 → 需明确是 TURN_ALREADY_SUBMITTED（不是静默接受）
  const otherNonce = await act(host.token, roomId, 'enter:0', 'seq_2');
  suite.check('本回合已提交 + 新 nonce → 409 TURN_ALREADY_SUBMITTED',
    otherNonce.status === 409 && otherNonce.data?.code === 'TURN_ALREADY_SUBMITTED', tag(otherNonce));

  // 收尾这一回合：guest 补交，让 turn 前进到 2
  const fill = await act(guest.token, roomId, 'enter:1', 'seq_g1');
  suite.check('guest 补交 200（本回合交齐，turn→2）', fill.status === 200, tag(fill));

  // 回合推进后，上一回合的 nonce 仍必须判重（seenNonces 不随回合清空）
  const afterAdvance = await act(host.token, roomId, 'enter:0', 'seq_1');
  suite.check('跨回合重放旧 nonce 仍 409 INTENT_REPLAY（去重窗口不随回合清空）',
    afterAdvance.status === 409 && afterAdvance.data?.code === 'INTENT_REPLAY', tag(afterAdvance));

  // §88 P3：上回合被判 TURN_ALREADY_SUBMITTED 的 nonce 也必须记账，
  // 否则它在新回合重放会被当成合法首提（迟到意图落到错回合）。
  const lateReplay = await act(host.token, roomId, 'enter:0', 'seq_2');
  suite.check('被拒（TURN_ALREADY_SUBMITTED）的 nonce 下回合重放仍 409 INTENT_REPLAY',
    lateReplay.status === 409 && lateReplay.data?.code === 'INTENT_REPLAY', tag(lateReplay));

  // ═══ S2. 并发：恰好一路 200、一路 409 ═══
  console.log('\n—— S2. 并发同一 nonce（不假定顺序）——');
  const firstWin = { first: 0, second: 0 };  // 409 落在第 1 路 / 第 2 路 的次数
  const bothOk = [];
  let turnOk = true;

  for (let r = 1; r <= ROUNDS; r++) {
    const before = (await get(host.token, `/api/room/${roomId}`)).data?.room?.coop?.turn;
    const h = await act(host.token, roomId, 'enter:0', `race_h${r}`);
    if (h.status !== 200) throw new Error(`第 ${r} 轮 host 提交异常 ${tag(h)}`);

    const [ra, rb] = await Promise.all([
      act(guest.token, roomId, 'enter:1', `race_g${r}`),
      act(guest.token, roomId, 'enter:1', `race_g${r}`),
    ]);

    const oks = [ra, rb].filter((x) => x.status === 200).length;
    const replays = [ra, rb].filter((x) => x.status === 409 && x.data?.code === 'INTENT_REPLAY').length;
    if (ra.status === 409) firstWin.first += 1;
    if (rb.status === 409) firstWin.second += 1;
    if (oks !== 1 || replays !== 1) {
      bothOk.push({ r, ra: tag(ra), rb: tag(rb), body: JSON.stringify(ra.data ?? rb.data).slice(0, 200) });
    }

    const after = (await get(host.token, `/api/room/${roomId}`)).data?.room?.coop?.turn;
    if (after !== before + 1) turnOk = false;
  }

  suite.check(`${ROUNDS} 轮并发：每轮恰好一路 200 + 一路 409 INTENT_REPLAY`,
    bothOk.length === 0,
    bothOk.length === 0 ? `${ROUNDS}/${ROUNDS}` : `异常轮次=${JSON.stringify(bothOk.slice(0, 3))}`);
  suite.check(`${ROUNDS} 轮并发：turn 每轮只推进一格（不多推也不少推）`,
    turnOk, turnOk ? `turn=+${ROUNDS}` : '存在异常轮次');

  // 这不是断言，是「为什么原用例会偶发红」的直接证据
  console.log(`\n[INFO] 409 落点统计：第一路 ${firstWin.first} 次 / 第二路 ${firstWin.second} 次（共 ${ROUNDS} 轮）`);
  suite.check('并发 409 落点可统计（语义与落点无关）',
    firstWin.first + firstWin.second === ROUNDS,
    `第一路=${firstWin.first} 第二路=${firstWin.second}`);

  // ═══ S3. 顺序反转：把「第二路」故意变成先到者 ═══
  // 并发下谁先拿到房间锁取决于谁先到服务端。全量 verify 并行、机器慢时，
  // 后发出的那路反而可能先到 —— 这正是 `e2e:p42e` 偶发红的构造。
  // 这里把「第一路」延迟 30ms，让「第二路」稳定先到：语义仍必须成立，
  // 而原用例那条 `rb.status === 409` 在这种构造下**必然**失败。
  console.log('\n—— S3. 顺序反转（把偶发变必现）——');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  let oldAssertionWouldFail = 0;
  let semanticsHold = true;
  const REVERSED = 3;

  for (let r = 1; r <= REVERSED; r++) {
    const h = await act(host.token, roomId, 'enter:0', `rev_h${r}`);
    if (h.status !== 200) throw new Error(`第 ${r} 轮 host 提交异常 ${tag(h)}`);

    const [ra, rb] = await Promise.all([
      sleep(30).then(() => act(guest.token, roomId, 'enter:1', `rev_g${r}`)),  // 名义第一路，故意后到
      act(guest.token, roomId, 'enter:1', `rev_g${r}`),                          // 名义第二路，先到
    ]);
    const oks = [ra, rb].filter((x) => x.status === 200).length;
    const replays = [ra, rb].filter((x) => x.status === 409 && x.data?.code === 'INTENT_REPLAY').length;
    if (oks !== 1 || replays !== 1) semanticsHold = false;
    // 旧断言 = 「rb 必须是 409 INTENT_REPLAY」。rb 若是先到者就会拿到 200 → 旧断言失败。
    const oldAssertionFails = !(rb.status === 409 && rb.data?.code === 'INTENT_REPLAY');
    if (oldAssertionFails) oldAssertionWouldFail += 1;
    console.log(`  [round ${r}] ra=${tag(ra)} rb=${tag(rb)}  旧断言${oldAssertionFails ? '红' : '绿'}`);
  }

  suite.check('顺序反转后语义仍成立：恰好一路 200 + 一路 409（产品去重没坏）',
    semanticsHold, semanticsHold ? `${REVERSED}/${REVERSED}` : '存在语义破坏轮次');
  suite.check('原用例断言（第二路必须 409）在顺序反转下必然不成立 —— 已复现为确定性红灯',
    oldAssertionWouldFail === REVERSED,
    `旧断言在 ${REVERSED} 轮里失败 ${oldAssertionWouldFail} 次（期望全部失败，即必然红）`);

  // ═══ S4. §88 P4：去重键绑定座位，不同座位可用同一个 nonce ═══
  console.log('\n—— S4. 跨座位相同 nonce（P4）——');
  const seatA = await act(host.token, roomId, 'enter:0', 'seat_shared');
  const seatB = await act(guest.token, roomId, 'enter:1', 'seat_shared');
  suite.check('不同座位用同一个 nonce 同回合提交，两路都 200（旧实现必红）',
    seatA.status === 200 && seatB.status === 200,
    `host=${tag(seatA)} guest=${tag(seatB)}`);

  // ═══ S5. §92 B：nonce 唯一表无淘汰窗口，跨窗口重放永久判重 ═══
  // 旧实现 seenNonces 限长 64、shift() 淘汰最早 —— 烧 65 个后再重放最早的那个，
  // 会被当成合法首提直接 200（旧意图落到新回合）。唯一表下必须仍 INTENT_REPLAY。
  console.log('\n—— S5. 65 个 nonce 后重放最早（B：唯一表无窗口）——');
  const windowFirst = await act(host.token, roomId, 'enter:0', 'win_000');
  suite.check('窗口用例首个 nonce 200', windowFirst.status === 200, tag(windowFirst));
  let burnRejected = 0;
  for (let i = 1; i < 65; i++) {
    const burn = await act(host.token, roomId, 'enter:0', `win_${String(i).padStart(3, '0')}`);
    if (burn.status === 409 && burn.data?.code === 'TURN_ALREADY_SUBMITTED') burnRejected += 1;
    else throw new Error(`第 ${i + 1} 个 nonce 预期被拒烧号，实际 ${tag(burn)}`);
  }
  const fillS5 = await act(guest.token, roomId, 'enter:1', 'win_g0');
  suite.check('65 个 nonce 已烧（1 提交 + 64 被拒）+ guest 补交推进回合',
    burnRejected === 64 && fillS5.status === 200, `burnRejected=${burnRejected} fill=${tag(fillS5)}`);
  const windowReplay = await act(host.token, roomId, 'enter:0', 'win_000');
  suite.check('跨 65 个 nonce 的窗口重放仍 409 INTENT_REPLAY（旧实现必红）',
    windowReplay.status === 409 && windowReplay.data?.code === 'INTENT_REPLAY', tag(windowReplay));

  for (const c of sockets) await closeWs(c);
  await cleanupAccounts(created);
  suite.done();
}

main().catch((e) => {
  console.error('[E2E_P42E_NONCE] 异常：', e?.stack ?? e);
  process.exitCode = 1;
  for (const c of sockets) { try { closeWs(c); } catch { /* ignore */ } }
});
