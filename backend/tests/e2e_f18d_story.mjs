/**
 * F18-d 剧情已读进度 端到端验收（2026-11-16）。
 *
 * 背景：`src/lib/story.ts` 早期只用模块级 Set 去重，重载即清 → 每次冷启动
 * 都把已看过的「到达 intro」重播一遍。修法是把「看过没有」记进服务端独立表
 * `StoryBeatSeen`（不写 SaveData、不升 SCHEMA_VERSION）。
 *
 * 覆盖：
 *  A 区 鉴权：未登录 GET/POST 均 401；新账号 seen 为空
 *  B 区 写入：合法 id 落库、重复上报幂等、多 id 累积
 *  C 区 校验：未知 id / 空值 / 非字符串 / 超长 全部 400 且不落库
 *  D 区 边界：跨账号隔离；**不碰存档**（revision 前后一致）
 */
import {
  Suite, api, newAccount, cleanupAccounts, validSave, save,
} from './lib/harness.mjs';

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const suite = new Suite('E2E_F18D_STORY');
const accounts = [];

const BEAT_A = 'arrival_town_starter';
const BEAT_B = 'gym_city_pebble';

const seenGet = (token) => api('/api/story/seen', { token });
const seenPost = (token, beatId) =>
  api('/api/story/seen', { method: 'POST', token, body: { beatId } });

async function seenOf(token) {
  const res = await seenGet(token);
  return Array.isArray(res.data?.seen) ? res.data.seen : null;
}

async function dbCount(username) {
  const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
  if (!u) return -1;
  return prisma.storyBeatSeen.count({ where: { userId: u.id } });
}

try {
  // ───────────────────────────── A 区：鉴权 ─────────────────────────────
  const anonGet = await api('/api/story/seen');
  suite.check('未登录 GET /api/story/seen → 401', anonGet.status === 401, `${anonGet.status} ${anonGet.text.slice(0, 120)}`);

  const anonPost = await api('/api/story/seen', { method: 'POST', body: { beatId: BEAT_A } });
  suite.check('未登录 POST /api/story/seen → 401', anonPost.status === 401, `${anonPost.status} ${anonPost.text.slice(0, 120)}`);

  const a = await newAccount('f18d');
  accounts.push(a.username);
  const seen0 = await seenOf(a.token);
  suite.check('新账号已读集合为空数组', Array.isArray(seen0) && seen0.length === 0, JSON.stringify(seen0));

  // ───────────────────────────── B 区：写入与幂等 ─────────────────────────────
  const post1 = await seenPost(a.token, BEAT_A);
  suite.check('标记已看完（合法 id）→ 200', post1.status === 200 && post1.data?.ok === true, `${post1.status} ${post1.text.slice(0, 120)}`);

  const seen1 = await seenOf(a.token);
  suite.check('GET 包含刚标记的 beat', Array.isArray(seen1) && seen1.includes(BEAT_A) && seen1.length === 1, JSON.stringify(seen1));

  const dup = await seenPost(a.token, BEAT_A);
  const seen2 = await seenOf(a.token);
  const dbAfterDup = await dbCount(a.username);
  suite.check('重复上报幂等：仍 200 且 GET 不重复', dup.status === 200 && Array.isArray(seen2) && seen2.length === 1, `status=${dup.status} seen=${JSON.stringify(seen2)}`);
  suite.check('重复上报不新增 DB 行', dbAfterDup === 1, `rows=${dbAfterDup}`);

  const post2 = await seenPost(a.token, BEAT_B);
  const seen3 = await seenOf(a.token);
  suite.check('标记另一条 beat 后累积为 2 条', post2.status === 200 && Array.isArray(seen3) && seen3.length === 2 && seen3.includes(BEAT_B), JSON.stringify(seen3));

  const dbAfterTwo = await dbCount(a.username);
  suite.check('DB 行数与已读集合一致（2）', dbAfterTwo === 2, `rows=${dbAfterTwo}`);

  // ───────────────────────────── C 区：上报校验 ─────────────────────────────
  const beforeBad = await dbCount(a.username);
  const unknown = await seenPost(a.token, 'arrival_atlantis');
  suite.check('未知 beatId → 400 STORY_BEAT_UNKNOWN',
    unknown.status === 400 && unknown.data?.code === 'STORY_BEAT_UNKNOWN',
    `${unknown.status} ${unknown.text.slice(0, 160)}`);

  const emptyId = await seenPost(a.token, '');
  suite.check('空 beatId → 400 STORY_BEAT_INVALID',
    emptyId.status === 400 && emptyId.data?.code === 'STORY_BEAT_INVALID',
    `${emptyId.status} ${emptyId.text.slice(0, 160)}`);

  const longId = await seenPost(a.token, 'x'.repeat(80));
  suite.check('超长 beatId → 400 STORY_BEAT_INVALID',
    longId.status === 400 && longId.data?.code === 'STORY_BEAT_INVALID',
    `${longId.status} ${longId.text.slice(0, 160)}`);

  const numId = await seenPost(a.token, 12345);
  suite.check('非字符串 beatId → 400 STORY_BEAT_INVALID',
    numId.status === 400 && numId.data?.code === 'STORY_BEAT_INVALID',
    `${numId.status} ${numId.text.slice(0, 160)}`);

  const missing = await api('/api/story/seen', { method: 'POST', token: a.token, body: {} });
  suite.check('缺少 beatId 字段 → 400',
    missing.status === 400 && missing.data?.code === 'STORY_BEAT_INVALID',
    `${missing.status} ${missing.text.slice(0, 160)}`);

  const afterBad = await dbCount(a.username);
  suite.check('非法上报一律不落库', afterBad === beforeBad, `before=${beforeBad} after=${afterBad}`);

  // ───────────────────────────── D 区：隔离与存档不受影响 ─────────────────────────────
  const b = await newAccount('f18d');
  accounts.push(b.username);
  const seenB = await seenOf(b.token);
  suite.check('跨账号隔离：B 看不到 A 的已读', Array.isArray(seenB) && seenB.length === 0, JSON.stringify(seenB));

  // 不污染存档：先建档拿到 revision，写一次剧情已读，再看 revision 是否变化
  await save.put(a.token, validSave());
  const revBefore = (await save.get(a.token)).data?.revision;
  await seenPost(a.token, BEAT_A);
  const revAfter = (await save.get(a.token)).data?.revision;
  suite.check('写剧情已读不改存档 revision（不写 SaveData）',
    typeof revBefore === 'number' && revBefore === revAfter,
    `before=${revBefore} after=${revAfter}`);

  const saveData = (await save.get(a.token)).data?.data;
  const saveText = typeof saveData === 'string' ? saveData : JSON.stringify(saveData ?? '');
  suite.check('存档里不存在剧情已读字段', !/storySeen|seenBeats|seenStory/i.test(saveText), saveText.slice(0, 160));
} catch (e) {
  suite.check('执行未抛异常', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  try {
    const ids = await prisma.user.findMany({
      where: { username: { in: accounts } }, select: { id: true },
    });
    const userIds = ids.map((u) => u.id);
    if (userIds.length) await prisma.storyBeatSeen.deleteMany({ where: { userId: { in: userIds } } });
  } catch { /* 清理失败不掩盖断言结果 */ }
  await cleanupAccounts(accounts);
  await prisma.$disconnect();
}

suite.done();
