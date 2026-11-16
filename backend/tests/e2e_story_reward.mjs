/**
 * 剧情发奖端到端验收（W4，2026-11-16）。
 *
 * 验证杰哥拍板：第三关馆主剧情（gym_town_leafy）**看完对话后**服务端幂等发学习装置：
 *  - 用 new_game 建真实档（避免 validSave 版本与 EXPECTED_SAVE_VERSION 漂移）；
 *  - POST /api/story/seen gym_town_leafy → 存档 inventory.exp_share 从 0 变 1、revision +1；
 *  - 重复上报 → exp_share 仍为 1（幂等、不重复发）、revision 不再因发奖变化；
 *  - 其它 beat（arrival_town_starter）不发道具、不改 revision。
 *
 * 运行：cd backend && npm run e2e:story_reward（需要 :3001 后端在线）
 */
import { Suite, api, newAccount, cleanupAccounts, requireBackend } from './lib/harness.mjs';

const suite = new Suite('E2E_STORY_REWARD');
const accounts = [];

function inventoryOf(saveRes) {
  const raw = saveRes?.data?.data;
  if (!raw) return null;
  try {
    const obj = typeof raw === 'string' ? JSON.parse(raw) : raw;
    return obj?.inventory ?? null;
  } catch {
    return null;
  }
}

try {
  await requireBackend();
  const acc = await newAccount('e2e_story_reward');
  accounts.push(acc.username);

  // 建立真实新档（服务端生成，版本正确）
  const ng = await api('/api/game/new_game', {
    method: 'POST', token: acc.token, body: { playerName: '剧情测试', starterSpecId: 'sprout_owl' },
  });
  suite.check('new_game 建档成功', ng.status === 200, `${ng.status} ${ng.text.slice(0, 120)}`);

  const before = await api('/api/save', { token: acc.token });
  const invBefore = inventoryOf(before);
  const revBefore = before.data?.revision;
  suite.check('初始背包无学习装置', invBefore && (invBefore.exp_share ?? 0) === 0, JSON.stringify(invBefore));
  suite.check('拿到初始 revision', typeof revBefore === 'number', `rev=${revBefore}`);

  // 标记「其它」剧情：不应发道具、不改 revision
  await api('/api/story/seen', { method: 'POST', token: acc.token, body: { beatId: 'arrival_town_starter' } });
  const afterOther = await api('/api/save', { token: acc.token });
  suite.check('其它剧情不发道具、不改 revision',
    (inventoryOf(afterOther)?.exp_share ?? 0) === 0 && afterOther.data?.revision === revBefore,
    `rev=${afterOther.data?.revision} inv=${JSON.stringify(inventoryOf(afterOther))}`);

  // 标记第三关馆主剧情：应发学习装置
  const post = await api('/api/story/seen', {
    method: 'POST', token: acc.token, body: { beatId: 'gym_town_leafy' },
  });
  suite.check('标记第三关馆主剧情 → 200', post.status === 200 && post.data?.ok === true,
    `${post.status} ${post.text.slice(0, 120)}`);

  const afterReward = await api('/api/save', { token: acc.token });
  const invAfter = inventoryOf(afterReward);
  suite.check('看完剧情后获得学习装置 ×1', invAfter && invAfter.exp_share === 1, JSON.stringify(invAfter));
  suite.check('发奖使 revision +1', afterReward.data?.revision === revBefore + 1,
    `before=${revBefore} after=${afterReward.data?.revision}`);
  const revAfterReward = afterReward.data?.revision;

  // 重复上报：幂等，不重复发
  await api('/api/story/seen', { method: 'POST', token: acc.token, body: { beatId: 'gym_town_leafy' } });
  const afterDup = await api('/api/save', { token: acc.token });
  suite.check('重复看完不重复发（exp_share 仍为 1）',
    inventoryOf(afterDup)?.exp_share === 1, JSON.stringify(inventoryOf(afterDup)));
  suite.check('重复上报不再写档（revision 不变）',
    afterDup.data?.revision === revAfterReward,
    `after=${revAfterReward} dup=${afterDup.data?.revision}`);
} catch (e) {
  suite.check('执行未抛异常', false, String(e?.stack ?? e).slice(0, 600));
} finally {
  // 先清剧情已读行（有 userId 外键语义），再清账号。
  try {
    const { PrismaClient } = await import('@prisma/client');
    const prisma = new PrismaClient();
    const users = await prisma.user.findMany({
      where: { username: { in: accounts } }, select: { id: true },
    });
    const ids = users.map((u) => u.id);
    if (ids.length) {
      await prisma.storyBeatSeen.deleteMany({ where: { userId: { in: ids } } });
    }
    await prisma.$disconnect();
  } catch { /* 清理失败不掩盖断言结果 */ }
  await cleanupAccounts(accounts);
}

suite.done();
