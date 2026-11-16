/**
 * F18-d 剧情已读进度：服务端真值读写（2026-11-16）。
 *
 * 背景：`src/lib/story.ts` 早期用模块级 Set 去重，`firedSession` 重载即清，
 * 于是每次冷启动进 Camp 都会把已经看过的「到达 intro」按 3 行台词重播一遍
 * （bug_log §72 观察点 1）。修法不是把进度塞进 SaveData —— 那是玩家存档，
 * 且会逼着升 SCHEMA_VERSION；这里沿用 F04 徽章/成就的范式：**独立表 + 只读投影**。
 *
 * 口径：
 *  - 只记「看过」这一事实，没有任何权益/数值，故不需要 `source` 列，也不参与结算；
 *  - 写入幂等：`@@unique([userId, beatId])` + upsert，不取应用层锁（同 F04，避免与
 *    slotLock 同锁重入）；
 *  - 客户端上报的 `beatId` 由 `game/storyBeats.ts` 按内容表白名单校验，
 *    任意字符串一律 400，避免脏数据进表。
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';
import { STORY_BEAT_UNKNOWN_CODE, validateStoryBeatId } from '../game/storyBeats';
import { decideStoryReward } from '../game/storyRewards';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { digestOf, type AuthorityState } from '../lib/authority';
import { readSave } from './saveRead';
import { commitState } from './session';
import { applyPlayReward, type PlayReward } from '../game/playReward';

/**
 * W4（2026-11-16）：看完带权益的剧情后，服务端幂等发放道具。
 *
 * 幂等闸门 = `StoryBeatSeen.rewardGranted`：用条件更新（where rewardGranted=false）
 * 抢占发放权，只有抢到的那一次才写档；失败则回滚闸门，下次可重试。
 * 与 F02/F18-c 同范式：slotLock 串行 → readSave → applyPlayReward → 同步 authority
 * → commitState，全程客户端不可伪造（只认服务端白名单 beatId）。
 */
async function grantStoryReward(userId: string, beatId: string, nowIso: string): Promise<void> {
  const itemId = decideStoryReward(beatId);
  if (!itemId) return; // 该 beat 不带权益
  await withSlotLock(slotLockKey(userId), async () => {
    // 抢占发放权：rewardGranted 由 false→true 只有一次成功。
    const claimed = await prisma.storyBeatSeen.updateMany({
      where: { userId, beatId, rewardGranted: false },
      data: { rewardGranted: true },
    });
    if (claimed.count !== 1) return; // 已发过 / 无该已读行
    try {
      const row = await readSave(userId);
      if (!row) throw new Error('存档不存在，跳过剧情发奖');
      const reward: PlayReward = { money: 0, items: { [itemId]: 1 } };
      const raw = applyPlayReward(row.raw, reward, nowIso);
      const authority: AuthorityState = { ...row.authority, expected: digestOf(raw), pending: null };
      await commitState(userId, {
        data: raw,
        schemaVersion: row.schemaVersion,
        clientId: row.clientId,
        authority,
        source: 'action',
      });
    } catch (e) {
      // 发放失败：回滚闸门，允许下次看完/重试时再发（不重复、不丢失）。
      await prisma.storyBeatSeen.updateMany({
        where: { userId, beatId, rewardGranted: true },
        data: { rewardGranted: false },
      }).catch(() => undefined);
      throw e;
    }
  });
}

export async function storyRoutes(fastify: FastifyInstance): Promise<void> {
  /** 已读集合：客户端启动时拉一次，用于「已看过的不再重播」。 */
  fastify.get('/api/story/seen', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any)?.userId as string | undefined;
    if (!userId) return reply.code(401).send({ error: '未登录或登录已过期' });
    const rows = await prisma.storyBeatSeen.findMany({
      where: { userId },
      select: { beatId: true },
      orderBy: { seenAt: 'asc' },
    });
    return { ok: true, seen: rows.map((r) => r.beatId) };
  });

  /** 标记某条剧情已看完（幂等，重复上报不报错、不改 seenAt）。 */
  fastify.post('/api/story/seen', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any)?.userId as string | undefined;
    if (!userId) return reply.code(401).send({ error: '未登录或登录已过期' });

    const body = (req.body ?? {}) as Record<string, unknown>;
    const checked = validateStoryBeatId(body.beatId);
    if ('code' in checked) {
      const payload: Record<string, unknown> = { error: checked.error, code: checked.code };
      if (checked.code === STORY_BEAT_UNKNOWN_CODE && typeof body.beatId === 'string') {
        payload.beatId = body.beatId;
      }
      return reply.code(400).send(payload);
    }

    await prisma.storyBeatSeen.upsert({
      where: { userId_beatId: { userId, beatId: checked.beatId } },
      create: { userId, beatId: checked.beatId },
      update: {},
    });
    // W4：看完带权益的剧情（第三关馆主）后，服务端幂等发放学习装置。
    // 发奖失败不阻断剧情已读回应（与 F18-c 掉落发放同口径：已读事实先落）。
    try {
      await grantStoryReward(userId, checked.beatId, new Date().toISOString());
    } catch (e) {
      req.log.warn({ userId, beatId: checked.beatId, err: String(e) }, '剧情奖励发放失败（不阻断已读）');
    }
    return { ok: true, beatId: checked.beatId };
  });
}
