/**
 * F17 单档化 E2E（2026-11-10）。
 *
 * 验证口径：一账号一档、直接进游戏不选档；所有 HTTP/WS 契约不再出现 slot。
 *  - 带 ?slot= 的 /api/save 一律 400 SAVE_SLOT_FORBIDDEN（不是静默忽略）；
 *  - 存档响应、会话、榜单、奖励记录都不含 slot 字段；
 *  - 数据库层 Save.userId 唯一，插第二档必被唯一约束挡下，7 张表无 slot 列。
 *
 * 运行：cd backend && npm run e2e:f17（需要 :3001 后端在线）
 */
import {
  Suite, api, asText, newAccount, cleanupAccounts, requireBackend,
  validSave, save, loadBackendEnv, formatFatal } from './lib/harness.mjs';

const s = new Suite('E2E_F17');
const names = [];
const SLOTLESS_TABLES = [
  'Save', 'BanRecord', 'IntentLog', 'BossDamageEvent',
  'RankReward', 'BossRewardGrant', 'CoopRewardGrant',
];

function hasSlot(res) {
  return /"slot"\s*:/.test(JSON.stringify(res?.data ?? {}));
}

async function main() {
  await requireBackend();
  const a = await newAccount('f17_');
  names.push(a.username);
  const token = a.token;

  // —— 闸门：任何形式的 slot 查询参数都不得进入存档接口 ——
  const empty = await save.get(token);
  s.check('新账号 GET /api/save 无参 → 404（尚无一档）', empty.status === 404,
    `${empty.status} ${asText(empty.data).slice(0, 120)}`);

  for (const q of ['slot=1', 'slot=2', 'slot=9']) {
    const r = await api(`/api/save?${q}`, { token });
    s.check(`GET /api/save?${q} → 400 SAVE_SLOT_FORBIDDEN`,
      r.status === 400 && r.data?.code === 'SAVE_SLOT_FORBIDDEN',
      `${r.status} ${asText(r.data).slice(0, 160)}`);
  }
  const putWithSlot = await api('/api/save?slot=1', {
    method: 'PUT', token,
    body: { data: JSON.stringify(validSave({ version: '11' })), revision: 0 },
  });
  s.check('PUT /api/save?slot=1 → 400 SAVE_SLOT_FORBIDDEN',
    putWithSlot.status === 400 && putWithSlot.data?.code === 'SAVE_SLOT_FORBIDDEN',
    `${putWithSlot.status} ${asText(putWithSlot.data).slice(0, 160)}`);

  // —— 正常单档读写 ——
  // 不带 rebase：首次写入由服务端从 data 派生权威基线（rebase 只用于「重置」且要求初始金币）。
  const first = await save.put(token, validSave({ version: '11' }));
  s.check('PUT /api/save 无参写入 v11 存档 → 200', first.status === 200 && first.data?.ok === true,
    `${first.status} ${asText(first.data).slice(0, 160)}`);
  s.check('PUT 响应体不再含 slot 字段', !hasSlot(first), asText(first.data).slice(0, 160));

  const got = await save.get(token);
  s.check('GET /api/save 无参 → 200 且带回存档', got.status === 200 && typeof got.data?.data === 'string',
    `${got.status} ${asText(got.data).slice(0, 120)}`);
  s.check('GET 响应体不再含 slot 字段', !hasSlot(got), asText(got.data).slice(0, 160));
  let parsed = null;
  try { parsed = JSON.parse(got.data?.data ?? 'null'); } catch { /* 下面断言会失败 */ }
  s.check('存档内部 version === "11"', parsed?.version === '11', `version=${parsed?.version}`);

  // 二次 PUT 用「合法消耗」（money 减少），不能加钱——服务端单调比对会拒绝凭空变富。
  const again = await save.put(token, validSave({ version: '11', money: 1100 }));
  const revOk = again.status === 200
    && typeof again.data?.revision === 'number'
    && again.data.revision > (first.data?.revision ?? -1);
  s.check('再次 PUT 覆盖同一档且 revision 单调递增', revOk,
    `${again.status} rev=${again.data?.revision} first=${first.data?.revision}`);

  // —— 只读接口一律不带 slot ——
  for (const [label, path] of [
    ['会话态', '/api/session'],
    ['召唤师等级榜', '/api/rank/summoner_level'],
    ['榜单奖励', '/api/rank/rewards'],
    ['在途战斗', '/api/battle/current'],
  ]) {
    const r = await api(path, { token });
    s.check(`${label} ${path} 响应不含 slot 字段`, r.status < 500 && !hasSlot(r),
      `${r.status} ${asText(r.data).slice(0, 160)}`);
  }

  // —— 数据库层白盒：一账号一档 + 物理删列 ——
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUnique({ where: { username: a.username }, select: { id: true } });
    const rows = await prisma.save.findMany({ where: { userId: user.id }, select: { id: true } });
    s.check('DB：该账号只有 1 条 Save', rows.length === 1, `rows=${rows.length}`);

    let duplicateBlocked = false;
    try {
      await prisma.save.create({ data: { userId: user.id, data: '{}' } });
    } catch {
      duplicateBlocked = true;
    }
    s.check('DB：插入第二档被 userId 唯一约束拒绝', duplicateBlocked,
      duplicateBlocked ? 'P2002 / unique constraint' : '意外插入成功');

    const stillOne = await prisma.save.count({ where: { userId: user.id } });
    s.check('DB：尝试插第二档后仍只有 1 条', stillOne === 1, `count=${stillOne}`);

    for (const t of SLOTLESS_TABLES) {
      // W1 起 provider=postgresql：SQLite 的 PRAGMA 表信息查询不可用，改用标准
      // information_schema.columns。Prisma 模型名映射为保留大小写的 PG 标识符。
      const cols = await prisma.$queryRawUnsafe(
        `SELECT column_name AS name FROM information_schema.columns
         WHERE table_schema = current_schema() AND table_name = $1`, t);
      const namesInTable = cols.map((c) => c.name);
      s.check(`DB：${t} 表已无 slot 列`, !namesInTable.includes('slot'), namesInTable.join(','));
    }
  } finally {
    await prisma.$disconnect();
  }
}

try {
  await main();
} catch (e) {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  s.check('套件执行未抛异常', false, formatFatal(e).replace(/\s+/g, ' ').slice(0, 1200));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
