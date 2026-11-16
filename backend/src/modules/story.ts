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
    return { ok: true, beatId: checked.beatId };
  });
}
