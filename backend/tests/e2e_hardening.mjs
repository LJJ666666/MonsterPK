/**
 * 对抗与攻防套件（2026-11-07 由一次性脚本转正）。
 *
 * 运行：cd backend && npm run e2e:hardening      （需后端已在 :3001）
 *       cd backend && npm run e2e:hardening -- --keep   保留测试账号便于排查
 *
 * 与五组常规 E2E 的分工：
 *  - e2e / p12 / p21 / p22 / p31 覆盖「正常路径与功能完整性」；
 *  - 本套件覆盖「攻击面」：伪造凭证、越权访问、改档、重放、协议滥用，
 *    断言的是「必须被拒绝 / 必须不生效 / 必须不误封」。
 *
 * 七个分区：
 *  A 认证与会话     B 存档结构校验     C 风控封号与封号后封锁
 *  D 权威增量与意图  E WebSocket 攻防   F 战斗接口伪造   G 数值边界（成对：放行 / 封号）
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_HARDENING_OK；失败 exit 1。
 * 收尾自动清理本轮创建的账号（除非 --keep），避免 dev.db 无限膨胀。
 */
import {
  Suite, api, newAccount, login, setRole, cleanupAccounts, forgeToken, loadContent,
  validSave, asText, save, battle, health,
  openWs, waitMsg, waitClose, closeWs, sendRaw, requireBackend, RUN,
} from './lib/harness.mjs';

const KEEP = process.argv.includes('--keep');
const suite = new Suite('E2E_HARDENING');
/** 运行期异常标记：中断时不能打成 _OK，否则 CI 会把「跑挂」当「通过」。 */
let aborted = false;
/** 本轮创建的账号，收尾精确清理（只删自己，不动他人数据）。 */
const created = [];
const keepAlive = [];

const mk = async (prefix) => {
  const acc = await newAccount(prefix);
  created.push(acc.username);
  return acc;
};
/** 新账号 + 写入基线存档，返回账号。 */
async function accountWithSave(prefix, overrides = {}) {
  const acc = await mk(prefix);
  const r = await save.put(acc.token, validSave(overrides));
  if (r.status !== 200) throw new Error(`基线存档失败 ${r.status}: ${r.text.slice(0, 200)}`);
  return acc;
}
/**
 * P4：意图请求统一入口。带 revision（CAS），裁决成功后把新版本号写回跟踪表，
 * 后面的 commitIntent（PUT 带 intentNonce）才能基于裁决后的版本提交。
 */
async function intentReq(token, type, body) {
  const revision = await save.revisionOf(token);
  const res = await api(`/api/actions/${type}`, {
    method: 'POST',
    token,
    body: { ...body, revision },
  });
  if (res.status === 200 && typeof res.data?.revision === 'number') {
    save.setRevision(token, res.data.revision);
  }
  return res;
}

const nonceOf = (tag) => `${tag}${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
const jsonOf = (res) => {
  try { return JSON.parse(res.data.data); } catch { return null; }
};

const content = loadContent();
const MOVE_IDS = Object.keys(content.moves);
const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
/** 造 N 只合法幻兽（用于队伍上限用例）。 */
const manyMonsters = (n) => Array.from({ length: n }, (_, i) => ({
  id: `m${i}`, specId: 'sprout_owl', level: 5, exp: 0, element: 'grass',
  maxHp: 60, hp: 60, atk: 60, def: 55, spAtk: 65, spDef: 58, spd: 70,
  status: 'none', moveIds: ['tackle'], initStats: STATS, growthRates: GROWTH, isShiny: false,
}));

async function main() {
  const h = await requireBackend();
  suite.check('后端就绪且内容表已加载',
    h?.content?.moves > 0 && h?.content?.monsters > 0,
    JSON.stringify(h?.content));

  // ═══════════════════ A. 认证与会话 ═══════════════════
  console.log('\n—— A. 认证与会话 ——');

  const authAcc = await accountWithSave('hd_auth');
  suite.check('合法账号可写入基线存档（后续用例的前提）', true);

  const noToken = await api('/api/save');
  suite.check('无 token 读存档 → 401', noToken.status === 401, `status=${noToken.status}`);

  const junkToken = await api('/api/save', { token: 'not-a-jwt' });
  suite.check('乱码 token → 401', junkToken.status === 401, `status=${junkToken.status}`);

  const tampered = `${authAcc.token.slice(0, -4)}AAAA`;
  const tamperedRes = await api('/api/save', { token: tampered });
  suite.check('篡改签名 → 401', tamperedRes.status === 401, `status=${tamperedRes.status}`);

  const expired = await forgeToken({ userId: 'someone', username: 'someone' }, { expiresInMs: -600_000 });
  if (!expired) {
    suite.skip('过期 token → 401', '读不到 JWT_SECRET（.env 缺失）');
  } else {
    const r = await api('/api/save', { token: expired });
    suite.check('过期 token → 401', r.status === 401, `status=${r.status}`);
  }

  const ghost = await forgeToken({ userId: 'ghost_user_id_000000000000', username: 'ghost' });
  if (!ghost) {
    suite.skip('签名合法但账号不存在 → 401', '读不到 JWT_SECRET');
  } else {
    const r = await api('/api/save', { token: ghost });
    suite.check('签名合法但账号不存在 → 401', r.status === 401, `status=${r.status}`);
  }

  // 跨账号隔离：A 的 token 只能读到 A 的档
  const isoB = await accountWithSave('hd_iso', { playerName: 'B玩家' });
  const readA = await save.get(authAcc.token);
  suite.check('A 的 token 只读到自己的存档',
    readA.status === 200 && jsonOf(readA)?.playerName === '测试员',
    `status=${readA.status} playerName=${jsonOf(readA)?.playerName}`);

  const readB = await save.get(isoB.token);
  suite.check('B 的 token 只读到自己的存档',
    readB.status === 200 && jsonOf(readB)?.playerName === 'B玩家',
    `playerName=${jsonOf(readB)?.playerName}`);

  const emptyAccount = await mk('hd_empty');
  const emptySave = await save.get(emptyAccount.token);
  suite.check('新账号未写入存档 → 404（不泄露存在性）', emptySave.status === 404, `status=${emptySave.status}`);

  const shortName = await api('/api/auth/register', { method: 'POST', body: { username: 'ab', password: 'abcdef' } });
  suite.check('注册用户名过短 → 400', shortName.status === 400, `status=${shortName.status}`);

  const shortPw = await api('/api/auth/register', { method: 'POST', body: { username: `hd_pw_${RUN}`, password: '123' } });
  suite.check('注册密码过短 → 400', shortPw.status === 400, `status=${shortPw.status}`);

  const dup = await api('/api/auth/register', { method: 'POST', body: { username: authAcc.username, password: 'abcdef' } });
  suite.check('重复注册同名账号 → 409', dup.status === 409, `status=${dup.status}`);

  const wrongPw = await login(authAcc.username, 'definitely-wrong');
  suite.check('错误密码登录 → 401', wrongPw.status === 401, `status=${wrongPw.status}`);

  // ── A2：requestId 回显 / 自动生成 / 日志注入防护 ──
  // harness 的 api() 只回传 status/data/text，响应头断言必须走原始 fetch。
  const rawBase = process.env.E2E_BASE || 'http://localhost:3001';
  const ridOk = await fetch(`${rawBase}/api/health`, {
    headers: { 'X-Request-Id': 'hd-a2-abc_123' },
  });
  suite.check('A2 合法 X-Request-Id 原样回显',
    ridOk.headers.get('x-request-id') === 'hd-a2-abc_123',
    `got=${ridOk.headers.get('x-request-id')}`);

  const ridAuto = await fetch(`${rawBase}/api/health`);
  const ridAutoVal = ridAuto.headers.get('x-request-id') || '';
  suite.check('A2 未带 id 时自动生成合法短 id',
    /^[A-Za-z0-9._:-]{1,64}$/.test(ridAutoVal), `got=${ridAutoVal.slice(0, 80)}`);

  // 换行会被 undici 直接拒绝，这里用「含空白 + 超长」验证服务端侧的校验。
  const forgedId = `bad id ${'x'.repeat(90)}`;
  const ridForged = await fetch(`${rawBase}/api/health`, {
    headers: { 'X-Request-Id': forgedId },
  });
  const ridForgedVal = ridForged.headers.get('x-request-id') || '';
  suite.check('A2 非法 id 被替换，不回显原值',
    ridForgedVal !== forgedId && /^[A-Za-z0-9._:-]{1,64}$/.test(ridForgedVal),
    `got=${ridForgedVal.slice(0, 80)}`);

  const ridCors = await fetch(`${rawBase}/api/health`, {
    headers: { Origin: 'http://localhost:5173' },
  });
  suite.check('A2 CORS 暴露 X-Request-Id 给浏览器 / WebView',
    (ridCors.headers.get('access-control-expose-headers') || '').includes('X-Request-Id'),
    `got=${ridCors.headers.get('access-control-expose-headers')}`);

  // ── A5：登录失败限流 ──
  // 用独立的不存在账号名，组合键隔离；本用例 7 次失败远低于 IP 兜底阈值 60，
  // 不会波及后续 25 组 E2E 与 375px 冒烟的正常登录。
  const rlName = `hd_rl_${RUN}`;
  const rlStatuses = [];
  let rlLast = null;
  for (let i = 0; i < 6; i += 1) {
    const r = await login(rlName, 'wrong-password');
    rlStatuses.push(r.status);
    if (i === 5) rlLast = r;
  }
  suite.check('A5 前 5 次错误密码 401、第 6 次 429',
    rlStatuses.slice(0, 5).every((s) => s === 401) && rlStatuses[5] === 429,
    JSON.stringify(rlStatuses));
  suite.check('A5 429 带限流码与 Retry-After',
    rlLast?.data?.code === 'LOGIN_RATE_LIMITED' && Number(rlLast?.data?.retryAfter) > 0,
    JSON.stringify(rlLast?.data));
  const rlOther = await login(`hd_rl_other_${RUN}`, 'wrong-password');
  suite.check('A5 组合键隔离：换账号仍 401，IP 兜底未误触发',
    rlOther.status === 401, `status=${rlOther.status}`);

  const me = await api('/api/auth/me', { token: authAcc.token });
  suite.check('普通账号 /me 的 isAdmin=false 且 banned=false',
    me.data?.isAdmin === false && me.data?.banned === false,
    JSON.stringify(me.data));

  // 客户端自称管理员无效：JWT 里塞 role 也不认
  const selfAdmin = await forgeToken({ userId: 'x', username: 'x', role: 'admin', isAdmin: true });
  if (selfAdmin) {
    const r = await api('/api/auth/me', { token: selfAdmin });
    suite.check('JWT 伪造 role/isAdmin 声明 → 不生效（401 账号不存在）',
      r.status === 401, `status=${r.status} isAdmin=${r.data?.isAdmin}`);
  } else {
    suite.skip('JWT 伪造 role 声明不生效', '读不到 JWT_SECRET');
  }

  // ═══════════════════ B. 存档结构校验（400 且不封号）═══════════════════
  console.log('\n—— B. 存档结构校验 ——');

  const noVersion = validSave();
  delete noVersion.version;
  const badStructs = [
    ['非 JSON 文本', 'this is definitely not json'],
    ['顶层是数组', [1, 2, 3]],
    ['缺 version 字段', noVersion],
    ['party 不是数组', validSave({ party: 'party' })],
    ['inventory 不是对象', validSave({ inventory: 'bag' })],
    ['幻兽属性非法', validSave({ party: [{ ...validSave().party[0], element: 'plasma' }] })],
    ['moveIds 不是数组', validSave({ party: [{ ...validSave().party[0], moveIds: 'tackle' }] })],
    ['playerName 超长（65）', validSave({ playerName: 'x'.repeat(65) })],
  ];
  for (const [label, payload] of badStructs) {
    const r = await save.put(authAcc.token, payload);
    suite.check(`结构非法「${label}」→ 400 拒绝`, r.status === 400, `status=${r.status} code=${r.data?.code ?? ''}`);
  }

  const tooNew = await save.put(authAcc.token, validSave({ version: '12' }));
  suite.check('存档版本高于服务端 → 400 VERSION_TOO_NEW',
    tooNew.status === 400 && tooNew.data?.code === 'VERSION_TOO_NEW',
    `status=${tooNew.status} code=${tooNew.data?.code}`);

  // 带正确 revision 才能测到「空文本」这一层（否则先被 REVISION_REQUIRED 拦下）。
  const emptyData = await api('/api/save', {
    method: 'PUT', token: authAcc.token,
    body: { data: '', revision: await save.revisionOf(authAcc.token) },
  });
  suite.check('空存档字符串 → 400（zod 拦截）', emptyData.status === 400, `status=${emptyData.status}`);

  // Fastify bodyLimit 会在客户端还没写完 2MB body 时就返回 413 并关闭 socket，
  // undici 侧偶发抛 ECONNRESET 而不是拿到 413（竞态，见 bug_log §37.3）。
  // 两种结果的防护语义相同：服务端没有收下超大请求。
  let hugeStatus = 0;
  let hugeErr = '';
  try {
    const hugeBody = await api('/api/save', {
      method: 'PUT', token: authAcc.token,
      bodyText: JSON.stringify({ data: 'x'.repeat(2 * 1024 * 1024) }),
    });
    hugeStatus = hugeBody.status;
  } catch (e) {
    hugeErr = String(e?.cause?.code ?? e?.message ?? e);
  }
  suite.check('2MB 请求体 → 413 或连接被提前重置（bodyLimit 兜底）',
    hugeStatus === 413 || /ECONNRESET|fetch failed/i.test(hugeErr),
    `status=${hugeStatus} err=${hugeErr}`);

  const afterBad = await save.put(authAcc.token, validSave());
  suite.check('连打 11 次非法请求后仍可正常写入（未误封）', afterBad.status === 200, `status=${afterBad.status}`);

  // ═══════════════════ B2. 格式错误必须「拒绝但不封号」 ═══════════════════
  // 这类值脏档、旧版迁移失败、客户端算术 bug 都能产生，不是改档证据。
  // 契约（2026-11-07 起）：<FIELD>_FORMAT → 400，<FIELD>_RANGE / 容量类 → 403 封号。
  console.log('\n—— B2. 格式错误不封号 ——');

  const formatCases = [
    ['金币为负', () => validSave({ money: -1 }), 'MONEY_FORMAT'],
    ['金币为小数', () => validSave({ money: 1.5 }), 'MONEY_FORMAT'],
    ['金币为 null', () => validSave({ money: null }), 'MONEY_FORMAT'],
    ['HP 超过 maxHp（内部矛盾）', () => validSave({ party: [{ ...validSave().party[0], hp: 999 }] }), 'MONSTER_HP_EXCEED'],
    ['幻兽等级为字符串', () => validSave({ party: [{ ...validSave().party[0], level: '30' }] }), 'MONSTER_LEVEL_FORMAT'],
  ];
  {
    const acc = await mk('hd_fmt');
    for (const [label, build, expectCode] of formatCases) {
      const r = await save.put(acc.token, build());
      suite.check(`格式错误「${label}」→ 400 ${expectCode} 且不封号`,
        r.status === 400 && r.data?.code === expectCode,
        `status=${r.status} code=${r.data?.code ?? ''}`);
    }
    const after = await save.put(acc.token, validSave());
    suite.check('连续 5 次格式错误后账号仍可正常写入（未误封）',
      after.status === 200, `status=${after.status} code=${after.data?.code ?? ''}`);
  }

  // ═══════════════════ C. 风控封号与封号后封锁 ═══════════════════
  console.log('\n—— C. 风控封号 ——');

  const banCases = [
    // 合法但高到只有测试菜单/外挂能造出（软告警升级为封号，阈值见 SAVE_LIMITS.MONEY_WARN）。
    ['金币 5,000,000（超软线 MONEY_HIGH）', () => validSave({ money: 5_000_000 })],
    ['队伍 7 只（上限 6）', () => validSave({ party: manyMonsters(7) })],
    ['技能 5 个（上限 4）', () => validSave({ party: [{ ...validSave().party[0], moveIds: MOVE_IDS.slice(0, 5) }] })],
    ['道具堆叠 1,000,001（上限 1,000,000）', () => validSave({ inventory: { capsule_basic: 1_000_001 } })],
    ['幻兽等级 150（告警线 100）', () => validSave({ party: [{ ...validSave().party[0], level: 150 }] })],
  ];
  let bannedAcc = null;
  for (const [label, build] of banCases) {
    const acc = await mk('hd_ban');
    const r = await save.put(acc.token, build());
    const ok = r.status === 403 && r.data?.code === 'ACCOUNT_BANNED';
    suite.check(`改档特征「${label}」→ 403 封号`, ok, `status=${r.status} code=${r.data?.code ?? ''}`);
    if (!bannedAcc && ok) bannedAcc = acc;
  }

  if (bannedAcc) {
    const getBanned = await save.get(bannedAcc.token);
    suite.check('封号后读存档 → 403 ACCOUNT_BANNED',
      getBanned.status === 403 && getBanned.data?.code === 'ACCOUNT_BANNED',
      `status=${getBanned.status} code=${getBanned.data?.code}`);

    const putBanned = await save.put(bannedAcc.token, validSave());
    suite.check('封号后写存档（合法数据也不放行）→ 403', putBanned.status === 403, `status=${putBanned.status}`);

    const loginBanned = await login(bannedAcc.username, bannedAcc.password);
    suite.check('封号后重新登录 → 403（换设备/清缓存也绕不过）',
      loginBanned.status === 403 && loginBanned.data?.code === 'ACCOUNT_BANNED',
      `status=${loginBanned.status} code=${loginBanned.data?.code ?? ''}`);

    const meBanned = await api('/api/auth/me', { token: bannedAcc.token });
    suite.check('封号后 /me → 403 ACCOUNT_BANNED',
      meBanned.status === 403 && meBanned.data?.code === 'ACCOUNT_BANNED',
      `status=${meBanned.status}`);

    const wsBanned = await openWs({ token: bannedAcc.token });
    suite.check('封号后建 WS 连接 → 403 拒绝',
      wsBanned.ok === false && wsBanned.status === 403,
      `status=${wsBanned.status}`);

    const actBanned = await intentReq(bannedAcc.token, 'shop_buy', { nonce: nonceOf('banned'), save: asText(validSave()), payload: { itemId: 'capsule_basic', amount: 1 } });
    suite.check('封号后调意图接口 → 403', actBanned.status === 403, `status=${actBanned.status}`);
  } else {
    suite.skip('封号后封锁链路', '本批次没有触发封号的用例');
  }

  // ═══════════════════ D. 权威增量与意图 ═══════════════════
  console.log('\n—— D. 权威增量与意图 ——');

  const authz = await accountWithSave('hd_authz'); // money 1200 / capsule 6 / potion 3

  const addMoney = await save.put(authz.token, validSave({ money: 2200 }));
  suite.check('整包 PUT 凭空加钱 → 400 AUTHORITY_MISMATCH',
    addMoney.status === 400 && addMoney.data?.code === 'AUTHORITY_MISMATCH',
    `status=${addMoney.status} code=${addMoney.data?.code}`);

  const addItem = await save.put(authz.token, validSave({ inventory: { capsule_basic: 7, potion_small: 3 } }));
  suite.check('整包 PUT 凭空加道具 → 400 AUTHORITY_MISMATCH',
    addItem.status === 400 && addItem.data?.code === 'AUTHORITY_MISMATCH',
    `status=${addItem.status} code=${addItem.data?.code}`);

  const legitSpend = await save.put(authz.token, validSave({ money: 700, inventory: { capsule_basic: 6, potion_small: 2 } }));
  suite.check('合法消耗（更穷）→ 200 放行', legitSpend.status === 200, `status=${legitSpend.status}`);

  const rollback = await save.put(authz.token, validSave({ money: 1200, inventory: { capsule_basic: 6, potion_small: 3 } }));
  suite.check('消耗后再把资源改回去（撤销消耗）→ 400',
    rollback.status === 400 && rollback.data?.code === 'AUTHORITY_MISMATCH',
    `status=${rollback.status} code=${rollback.data?.code}`);

  const forgedNonce = await save.put(authz.token, validSave({ money: 9999 }), { intentNonce: nonceOf('forged') });
  suite.check('伪造 intentNonce + 加钱 → 400（落到普通分支被拒）',
    forgedNonce.status === 400 && forgedNonce.data?.code === 'AUTHORITY_MISMATCH',
    `status=${forgedNonce.status} code=${forgedNonce.data?.code}`);

  const unknownType = await intentReq(authz.token, 'nuke_everything', { nonce: nonceOf('unknown'), save: asText(validSave({ money: 700, inventory: { capsule_basic: 6, potion_small: 2 } })), payload: {} });
  suite.check('未知意图类型 → 400', unknownType.status === 400, `status=${unknownType.status}`);

  // shop_buy 正常链路：裁决 → 提交 → 重放
  const buyBase = validSave({ money: 700, inventory: { capsule_basic: 6, potion_small: 2 } });
  const buyNonce = nonceOf('buy');
  const buy = await intentReq(authz.token, 'shop_buy', { nonce: buyNonce, save: asText(buyBase), payload: { itemId: 'capsule_basic', amount: 1 } });
  suite.check('shop_buy 裁决成功且服务端给出价格（200 金币）',
    buy.status === 200 && buy.data?.result?.cost === 200,
    `status=${buy.status} cost=${buy.data?.result?.cost}`);

  const applied = validSave({ money: 500, inventory: { capsule_basic: 7, potion_small: 2 } });
  const commit = await save.put(authz.token, applied, { intentNonce: buyNonce });
  suite.check('按裁决结果提交（钱 -200、道具 +1）→ 200', commit.status === 200, `status=${commit.status}`);

  const replay = await intentReq(authz.token, 'shop_buy', { nonce: buyNonce, save: asText(buyBase), payload: { itemId: 'capsule_basic', amount: 1 } });
  suite.check('同一 intentNonce 重放 → 409 INTENT_REPLAY',
    replay.status === 409 && replay.data?.code === 'INTENT_REPLAY',
    `status=${replay.status} code=${replay.data?.code}`);

  const overBuy = await intentReq(authz.token, 'shop_buy', { nonce: nonceOf('poor'), save: asText(validSave({ money: 0, inventory: { capsule_basic: 7, potion_small: 2 } })), payload: { itemId: 'capsule_master', amount: 1 } });
  suite.check('金币不足购买 → 400 INTENT_REJECTED',
    overBuy.status === 400 && overBuy.data?.code === 'INTENT_REJECTED',
    `status=${overBuy.status} code=${overBuy.data?.code}`);

  const normalAdminTest = await intentReq(authz.token, 'admin_test', { nonce: nonceOf('adm'), save: asText(validSave({ money: 500, inventory: { capsule_basic: 7, potion_small: 2 } })), payload: {} });
  suite.check('普通账号调测试菜单意图 → 400（且不封号）',
    normalAdminTest.status === 400 && normalAdminTest.data?.code === 'INTENT_REJECTED',
    `status=${normalAdminTest.status} code=${normalAdminTest.data?.code}`);

  const stillAlive = await save.get(authz.token);
  suite.check('越权调用测试菜单后账号仍可用（未误封）', stillAlive.status === 200, `status=${stillAlive.status}`);

  // 管理员：意图授权 → 提交大额档
  const adminAcc = await accountWithSave('hd_admin');
  await setRole(adminAcc.username, 'admin');
  const adminMe = await api('/api/auth/me', { token: adminAcc.token });
  suite.check('服务端判定管理员（role=admin）→ isAdmin=true', adminMe.data?.isAdmin === true, JSON.stringify(adminMe.data));

  const adminTest = await intentReq(adminAcc.token, 'admin_test', { nonce: nonceOf('admx'), save: asText(validSave()), payload: {} });
  suite.check('管理员调测试菜单意图 → 200 并下发一次性授权 nonce',
    adminTest.status === 200 && typeof adminTest.data?.nonce === 'string',
    `status=${adminTest.status} nonce=${adminTest.data?.nonce}`);

  const adminPut = await save.put(adminAcc.token, validSave({ money: 5_000_000, inventory: { capsule_basic: 6, potion_small: 3 } }), {
    intentNonce: adminTest.data?.nonce,
  });
  suite.check('管理员带授权提交测试档（金币 5,000,000）→ 200 且不封号',
    adminPut.status === 200, `status=${adminPut.status} code=${adminPut.data?.code ?? ''}`);

  const adminAfter = await api('/api/auth/me', { token: adminAcc.token });
  suite.check('管理员提交测试档后未被封号', adminAfter.data?.banned === false, JSON.stringify(adminAfter.data));

  // 普通账号伪造 rebase 标记
  const fakeRebase = await save.put(authz.token, validSave({ money: 1, steps: 0, inventory: {}, collection: {} }), { rebase: true });
  suite.check('普通账号伪造 rebase 清档 → 400 REBASE_REJECTED',
    fakeRebase.status === 400 && fakeRebase.data?.code === 'REBASE_REJECTED',
    `status=${fakeRebase.status} code=${fakeRebase.data?.code}`);

  // ═══════════════════ E. WebSocket 攻防 ═══════════════════
  console.log('\n—— E. WebSocket 攻防 ——');

  const wsAcc = await accountWithSave('hd_ws');

  const wsNoToken = await openWs({ token: undefined });
  suite.check('WS 无 token → 401 拒绝', wsNoToken.ok === false && wsNoToken.status === 401, `status=${wsNoToken.status}`);

  const wsBadToken = await openWs({ token: 'garbage-token' });
  suite.check('WS 伪造 token → 401 拒绝', wsBadToken.ok === false && wsBadToken.status === 401, `status=${wsBadToken.status}`);

  const wsBadOrigin = await openWs({ token: wsAcc.token, origin: 'http://evil.example.com' });
  suite.check('WS 非法 Origin → 403 拒绝', wsBadOrigin.ok === false && wsBadOrigin.status === 403, `status=${wsBadOrigin.status}`);

  const wsWrongPath = await openWs({ token: wsAcc.token, path: '/api/health' });
  suite.check('WS 非 /ws 路径 upgrade → 拒绝', wsWrongPath.ok === false, `status=${wsWrongPath.status}`);

  const ws1 = await openWs({ token: wsAcc.token });
  keepAlive.push(ws1);
  suite.check('WS 正常握手并收到 hello',
    ws1.ok === true && ws1.hello?.protocol >= 1 && typeof ws1.hello?.connectionId === 'string',
    `status=${ws1.status}`);
  suite.check('hello.capabilities 声明 session.state 与 battle.state',
    Array.isArray(ws1.hello?.capabilities)
      && ws1.hello.capabilities.includes('session.state')
      && ws1.hello.capabilities.includes('battle.state'),
    JSON.stringify(ws1.hello?.capabilities));

  // 伪造下行消息类型上行：必须拒绝并断开
  sendRaw(ws1, JSON.stringify({ type: 'session.state', revision: 99999, data: '{}' }));
  const forgedErr = await waitMsg(ws1, (m) => m.type === 'error');
  suite.check('上行伪造 session.state → error UNKNOWN_TYPE',
    forgedErr?.code === 'UNKNOWN_TYPE', JSON.stringify(forgedErr));
  const forgedClose = await waitClose(ws1.ws);
  suite.check('上行伪造 session.state → 以 1008 关闭连接', forgedClose.code === 1008, `code=${forgedClose.code}`);

  // 超长帧
  const wsBig = await openWs({ token: wsAcc.token });
  keepAlive.push(wsBig);
  sendRaw(wsBig, 'x'.repeat(5_000));
  const bigClose = await waitClose(wsBig.ws);
  suite.check('超过 4KB 的帧 → 1009 关闭', bigClose.code === 1009, `code=${bigClose.code}`);

  // ping / resync 正常（协议用 ts 字段，服务端在 pong.echo 回显）
  const ws2 = await openWs({ token: wsAcc.token });
  keepAlive.push(ws2);
  ws2.ws.send(JSON.stringify({ type: 'ping', ts: 4242 }));
  const pong = await waitMsg(ws2, (m) => m.type === 'pong');
  suite.check('上行 ping(ts) → pong 且回显 echo',
    pong?.echo === 4242 && typeof pong?.serverTime === 'number', JSON.stringify(pong));

  ws2.ws.send(JSON.stringify({ type: 'session.resync' }));
  const snap = await waitMsg(ws2, (m) => m.type === 'session.state');
  suite.check('上行 session.resync → 重推 session.state 权威快照',
    !!snap && typeof snap.revision === 'number' && typeof snap.data === 'string',
    snap ? `revision=${snap.revision}` : 'no message');

  // P4-1a 顶号：第 2 条连接不再被 429 拒绝，而是把前一条踢下线
  const ws3 = await openWs({ token: wsAcc.token });
  keepAlive.push(ws3);
  const bye2 = await waitMsg(ws2, (m) => m.type === 'bye' && m.code === 'SESSION_REPLACED', 2_000);
  suite.check('同账号第 2 条连接顶掉前一条（bye SESSION_REPLACED）',
    ws3.ok === true && !!bye2, `status=${ws3.status} bye=${bye2?.code}`);

  const ws4 = await openWs({ token: wsAcc.token });
  keepAlive.push(ws4);
  const bye3 = await waitMsg(ws3, (m) => m.type === 'bye' && m.code === 'SESSION_REPLACED', 2_000);
  suite.check('连续顶号：始终只有最新一条连接在线',
    ws4.ok === true && !!bye3, `status=${ws4.status} bye=${bye3?.code}`);

  // 断开后可重连
  await closeWs(ws4);
  const ws6 = await openWs({ token: wsAcc.token });
  suite.check('关闭连接后可重新连接', ws6.ok === true, `status=${ws6.status}`);
  keepAlive.push(ws6);

  // 限流：顶号后单账号只有一条连接，不必再「腾名额」（新连接会顶掉 ws6）
  for (const c of [ws2, ws3, ws6]) await closeWs(c);

  // 限流：1 秒内 25 条
  const wsRl = await openWs({ token: wsAcc.token });
  keepAlive.push(wsRl);
  suite.check('限流用例的连接已建立', wsRl.ok === true, `status=${wsRl.status}`);
  for (let i = 0; i < 25; i += 1) wsRl.ws.send(JSON.stringify({ type: 'ping', ts: i }));
  const rlErr = await waitMsg(wsRl, (m) => m.type === 'error' && m.code === 'RATE_LIMITED', 4_000);
  suite.check('单连接 1 秒内超 20 条 → RATE_LIMITED', !!rlErr, JSON.stringify(rlErr));
  const rlClose = await waitClose(wsRl.ws);
  suite.check('限流后以 1008 关闭连接', rlClose.code === 1008, `code=${rlClose.code}`);

  // ═══════════════════ F. 战斗接口伪造 ═══════════════════
  console.log('\n—— F. 战斗接口 ——');

  const noSaveAcc = await mk('hd_bt0');
  const noSaveStart = await battle.start(noSaveAcc.token);
  suite.check('没有存档就开局 → 404', noSaveStart.status === 404, `status=${noSaveStart.status}`);

  const btAcc = await accountWithSave('hd_bt');
  const badTheme = await battle.start(btAcc.token, { theme: 'nowhere_land' });
  suite.check('伪造主题开局 → 400', badTheme.status === 400, `status=${badTheme.status}`);

  const started = await battle.start(btAcc.token);
  const st = started.data?.battle;
  suite.check('正常开局：敌方由服务端生成 + 返回 battleId',
    started.status === 200 && typeof st?.battleId === 'string' && !!st?.enemy?.specId && Array.isArray(st?.party),
    `status=${started.status} enemy=${st?.enemy?.specId}`);
  // 上界 = levelMax + 6：elite(+2) 与 rare(+3) 是两次独立 roll，可同时命中，
  // 再加 0~1 抖动。原先写死 <= 6 漏了叠加分支（约 1% 概率偶发红），见 bug_log §37。
  const lvMin = Number(st?.levelMin ?? 2);
  const lvMax = Number(st?.levelMax ?? 2);
  suite.check('敌方等级落在服务端区间（含精英/稀有叠加与抖动）',
    Number.isInteger(st?.enemy?.level) && st.enemy.level >= lvMin && st.enemy.level <= lvMax + 6,
    `level=${st?.enemy?.level} range=[${lvMin},${lvMax}+6]`);
  suite.check('开局返回 PP 表（服务端持有真值）',
    st?.ppByMonster && Object.keys(st.ppByMonster).length > 0, JSON.stringify(st?.ppByMonster));

  const bid = st?.battleId;
  const fakeBattle = await battle.action(btAcc.token, 'bt_forged_000', { type: 'move', moveId: MOVE_IDS[0] });
  suite.check('伪造 battleId → 404 BATTLE_NOT_FOUND',
    fakeBattle.status === 404 && fakeBattle.data?.code === 'BATTLE_NOT_FOUND',
    `status=${fakeBattle.status} code=${fakeBattle.data?.code}`);

  const otherAcc = await accountWithSave('hd_bt2');
  const crossBattle = await battle.action(otherAcc.token, bid, { type: 'move', moveId: MOVE_IDS[0] });
  suite.check('越权操作他人 battleId → 404（三键归属校验）',
    crossBattle.status === 404, `status=${crossBattle.status}`);

  const badMove = await battle.action(btAcc.token, bid, { type: 'move', moveId: 'move_that_does_not_exist' });
  suite.check('使用未掌握技能 → 400 MOVE_UNKNOWN',
    badMove.status === 400 && badMove.data?.code === 'MOVE_UNKNOWN',
    `status=${badMove.status} code=${badMove.data?.code}`);

  const badSwitch = await battle.action(btAcc.token, bid, { type: 'switch', partyIndex: 5 });
  suite.check('越界换人 → 400 PARTY_INDEX_INVALID',
    badSwitch.status === 400 && badSwitch.data?.code === 'PARTY_INDEX_INVALID',
    `status=${badSwitch.status} code=${badSwitch.data?.code}`);

  const badItem = await battle.action(btAcc.token, bid, { type: 'item', itemId: 'potion_that_does_not_exist' });
  suite.check('使用不存在的道具 → 400 ITEM_UNKNOWN',
    badItem.status === 400 && badItem.data?.code === 'ITEM_UNKNOWN',
    `status=${badItem.status} code=${badItem.data?.code}`);

  // 客户端塞伤害 / HP 字段：必须被忽略
  const maxHpBefore = st?.party?.[st?.playerActiveIndex ?? 0]?.maxHp;
  const hacked = await battle.action(btAcc.token, bid, {
    type: 'move', moveId: MOVE_IDS[0],
    damage: 99999, hp: 99999, maxHp: 99999, enemyHp: 0, captured: true, money: 999999,
  });
  const hackedView = hacked.data?.battle;
  suite.check('客户端伪造 damage/hp/maxHp/captured 字段 → 被忽略',
    hacked.status === 200
      && hackedView?.party?.every((m) => m.maxHp !== 99999)
      && hackedView?.enemy?.maxHp !== 99999,
    `status=${hacked.status} maxHp=${hackedView?.party?.[0]?.maxHp}/${maxHpBefore}`);
  suite.check('伪造字段未直接改写金钱或结算结果',
    !hackedView?.rewards || typeof hackedView.rewards.money !== 'number' || hackedView.rewards.money < 999999,
    JSON.stringify(hackedView?.rewards));

  // 放弃后动作
  const abandon = await battle.abandon(btAcc.token, bid);
  suite.check('放弃战斗 → 200', abandon.status === 200, `status=${abandon.status}`);
  const afterAbandon = await battle.action(btAcc.token, bid, { type: 'move', moveId: MOVE_IDS[0] });
  suite.check('放弃后再发动作 → 404', afterAbandon.status === 404, `status=${afterAbandon.status}`);

  // 再次开局覆盖
  const s1 = await battle.start(btAcc.token);
  const s2 = await battle.start(btAcc.token);
  const oldId = s1.data?.battle?.battleId;
  const covered = await battle.action(btAcc.token, oldId, { type: 'move', moveId: MOVE_IDS[0] });
  suite.check('再次开局覆盖旧战斗（旧 battleId → 404）',
    covered.status === 404, `status=${covered.status}`);
  suite.check('覆盖后当前战斗是新开的那场',
    s2.data?.battle?.battleId !== oldId, `${oldId} -> ${s2.data?.battle?.battleId}`);
  const cur = await battle.current(btAcc.token);
  suite.check('GET /api/battle/current 返回最新战斗',
    cur.status === 200 && cur.data?.battle?.battleId === s2.data?.battle?.battleId,
    `status=${cur.status}`);

  // 战斗结束写档后，客户端整包 PUT 不能抹掉结果
  const revBefore = (await save.session(btAcc.token)).data?.revision;
  let finished = false;
  let guard = 0;
  while (!finished && guard < 60) {
    guard += 1;
    const r = await battle.action(btAcc.token, s2.data?.battle?.battleId, { type: 'move', moveId: MOVE_IDS[0] });
    if (r.status !== 200) break;
    finished = r.data?.battle?.finished === true;
  }
  if (finished) {
    const revAfter = (await save.session(btAcc.token)).data?.revision;
    suite.check('战斗结束由服务端写档并提升 revision',
      typeof revBefore === 'number' && typeof revAfter === 'number' && revAfter > revBefore,
      `rev ${revBefore} -> ${revAfter}`);
    const gotAfter = await save.get(btAcc.token);
    const afterSave = jsonOf(gotAfter);
    if (afterSave) {
      // P4：战斗结算推进了版本号，先把跟踪基线对齐，否则这一发 PUT 会先撞 409，
      // 测不到「资源变富被权威摘要拒绝」这一层。
      if (typeof revAfter === 'number') save.setRevision(btAcc.token, revAfter);
      // 「更穷」是合法消耗（服务端允许），真正要挡的是「变富」——那才等于抹掉/改写战斗结果。
      afterSave.money = (afterSave.money ?? 0) + 10_000;
      const enriched = await save.put(btAcc.token, afterSave);
      suite.check('战斗后客户端整包 PUT 加钱 → 400（改不动服务端结算结果）',
        enriched.status === 400 && enriched.data?.code === 'AUTHORITY_MISMATCH',
        `status=${enriched.status} code=${enriched.data?.code ?? ''}`);
    } else {
      suite.skip('战斗后整包 PUT 加钱被拒', '读不到存档');
    }
  } else {
    suite.skip('战斗结算写档断言', '本轮未在 60 回合内结束（随机分支）');
  }

  // ═══════════════════ G. 数值边界（成对：合法线放行 / 一线之隔封号）═══════════════════
  console.log('\n—— G. 数值边界 ——');

  const boundaries = [
    ['金币', { money: 999_999 }, { money: 1_000_000 }],
    ['幻兽等级', { party: [{ ...validSave().party[0], level: 100 }] }, { party: [{ ...validSave().party[0], level: 101 }] }],
    ['步数', { steps: 1_000_000_000 }, { steps: 1_000_000_001 }],
    ['队伍数量', { party: manyMonsters(6) }, { party: manyMonsters(7) }],
    ['技能数量', { party: [{ ...validSave().party[0], moveIds: MOVE_IDS.slice(0, 4) }] }, { party: [{ ...validSave().party[0], moveIds: MOVE_IDS.slice(0, 5) }] }],
    ['单格道具堆叠', { inventory: { capsule_basic: 1_000_000 } }, { inventory: { capsule_basic: 1_000_001 } }],
    ['捕获次数', { collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1_000 } } }, { collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1_001 } } }],
  ];
  for (const [label, okCase, banCase] of boundaries) {
    const okAcc = await mk('hd_edge');
    const okRes = await save.put(okAcc.token, validSave(okCase));
    suite.check(`边界「${label}」合法线上值 → 200 放行`, okRes.status === 200, `status=${okRes.status} code=${okRes.data?.code ?? ''}`);

    const banAcc2 = await mk('hd_edge');
    const banRes = await save.put(banAcc2.token, validSave(banCase));
    suite.check(`边界「${label}」超一线 → 403 封号`,
      banRes.status === 403 && banRes.data?.code === 'ACCOUNT_BANNED',
      `status=${banRes.status} code=${banRes.data?.code ?? ''}`);
  }

  // 改系统时间：不生效、不封号
  const clockAcc = await mk('hd_clock');
  const future = new Date('2099-01-01T00:00:00.000Z').toISOString();
  const futurePut = await save.put(clockAcc.token, validSave({ lastSavedAt: future }));
  suite.check('提交 2099 年的时间戳 → 200（不封号）', futurePut.status === 200, `status=${futurePut.status}`);

  const clockBack = await save.get(clockAcc.token);
  const savedTs = jsonOf(clockBack)?.lastSavedAt;
  const driftMs = Math.abs(Date.parse(savedTs) - Date.now());
  suite.check('未来时间戳被钳制为服务端时间（改时间不生效）',
    Number.isFinite(driftMs) && driftMs < 5 * 60 * 1000,
    `savedTs=${savedTs} drift=${Math.round(driftMs / 1000)}s`);

  const clockMe = await api('/api/auth/me', { token: clockAcc.token });
  suite.check('改系统时间不会被封号', clockMe.data?.banned === false, JSON.stringify(clockMe.data));
}

try {
  await main();
} catch (e) {
  aborted = true;
  console.error('\nE2E_HARDENING_ABORT', e);
  process.exitCode = 1;
} finally {
  for (const c of keepAlive) { try { c.ws?.terminate?.(); } catch { /* 忽略 */ } }
  if (!KEEP && created.length > 0) {
    try {
      const r = await cleanupAccounts(created);
      console.log(`\n[清理] 删除测试账号 ${r.users} 个 / 意图记录 ${r.intents} 条（--keep 可保留）`);
    } catch (e) {
      console.error('[清理失败] 可手动执行 npm run clean:e2e', String(e?.message || e));
    }
  } else if (KEEP) {
    console.log(`\n[保留] 本轮创建 ${created.length} 个测试账号（--keep）`);
  }
  // 中断时只报进度，不打 _OK；已完成的分区仍然有价值。
  if (aborted) {
    console.log(`\nE2E_HARDENING_ABORTED pass=${suite.pass} fail=${suite.fail} skipped=${suite.skipped}`);
    process.exitCode = 1;
  } else {
    suite.done();
  }
}
