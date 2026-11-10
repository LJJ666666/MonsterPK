/**
 * F04 召唤师等级 / 徽章 / 成就：服务端真值读写（规范 §31.5）。
 *
 * - 等级 / 帽 / 加成**完全只读派生**于两张 Grant 表，没有第二份真值、没有宽表、
 *   也不需要停机回填：老账号无记录即基础 Lv.5。
 * - `@@unique` + P2002 天然幂等，**不取应用层锁**：调用链可能在战斗结算的
 *   `slotLock` 内，自己再取同 key 会重演 F14 的同锁重入死锁（bug_log §36）。
 * - 客户端**只有 GET**：没有领取 / 上报 / 写入口；显式带上真值字段的查询一律 400。
 * - 新表按 `userId` 账号级，与账号单档一致。
 */
import type { FastifyInstance } from 'fastify';
import { prisma } from '../lib/prisma';
import { LOCATIONS } from '../game/content';
import { BADGE_BY_ID, ACHIEVEMENT_BY_ID, badgeIdForWildArea } from '../game/badges';
import { buildPlayerProgress, allBadgeViews, type PlayerProgressView } from '../game/playerLevel';
import { unlockedLocations } from '../game/mapLock';

export const PROGRESS_INPUT_FORBIDDEN_CODE = 'PROGRESS_INPUT_FORBIDDEN';

/** 客户端若在 GET 查询里显式带这些字段，视为「试图上报进度真值」。 */
export const FORBIDDEN_PROGRESS_QUERY_KEYS = [
  'level', 'playerLevel', 'cap', 'badgeBonus', 'badgeCount', 'badges',
  'achievements', 'bonuses', 'levelBonus', 'progress', 'data', 'userId',
] as const;

export type GrantState = 'granted' | 'already' | 'invalid';
export type AreaGrantResult = { state: GrantState; badgeId: string | null };

function isUniqueViolation(e: unknown): boolean {
  return !!e && typeof e === 'object' && (e as { code?: string }).code === 'P2002';
}
function safeSource(s: unknown): string {
  return typeof s === 'string' && s.trim() ? s.trim().slice(0, 80) : 'server';
}

/** 只读：账号已获得的徽章 id（按获得时间稳定排序）。 */
export async function readBadgeIds(userId: string): Promise<string[]> {
  const rows = await prisma.badgeGrant.findMany({
    where: { userId }, select: { badgeId: true }, orderBy: { grantedAt: 'asc' },
  });
  return rows.map((r) => r.badgeId);
}

/** 只读：账号已获得的成就 id。 */
export async function readAchievementIds(userId: string): Promise<string[]> {
  const rows = await prisma.achievementGrant.findMany({
    where: { userId }, select: { achievementId: true }, orderBy: { grantedAt: 'asc' },
  });
  return rows.map((r) => r.achievementId);
}

/** 只读进度投影：`GET /api/player/progress` 与 WS 共用同一形状。 */
export async function readProgress(userId: string): Promise<PlayerProgressView> {
  const [badges, achievements] = await Promise.all([
    readBadgeIds(userId), readAchievementIds(userId),
  ]);
  return buildPlayerProgress(badges, achievements);
}

/** 发徽章（服务端唯一写入口）。未知 id 拒绝；重复发放返回 already，不抛异常。 */
export async function grantBadge(p: {
  userId: string; badgeId: string; source?: string;
}): Promise<GrantState> {
  if (!p.userId || !BADGE_BY_ID[p.badgeId]) return 'invalid';
  try {
    await prisma.badgeGrant.create({
      data: { userId: p.userId, badgeId: p.badgeId, source: safeSource(p.source) },
    });
    return 'granted';
  } catch (e) {
    if (isUniqueViolation(e)) return 'already';
    throw e;
  }
}

/** 发成就（服务端唯一写入口），语义同 grantBadge。 */
export async function grantAchievement(p: {
  userId: string; achievementId: string; source?: string;
}): Promise<GrantState> {
  if (!p.userId || !ACHIEVEMENT_BY_ID[p.achievementId]) return 'invalid';
  try {
    await prisma.achievementGrant.create({
      data: {
        userId: p.userId, achievementId: p.achievementId, source: safeSource(p.source),
      },
    });
    return 'granted';
  } catch (e) {
    if (isUniqueViolation(e)) return 'already';
    throw e;
  }
}

/**
 * V1 过渡口径（规范 §31.9）：演武堂挑战玩法（F18）上线前，
 * 复用服务端 `clearedAreas` 首通真值 —— 某城镇任一野区首通即幂等发对应徽章。
 * 演武堂上线后把 source 收窄为 `gym:<locationId>` 即可，表与 UI 零改动。
 */
export async function grantBadgeForAreaClear(userId: string, areaId: string): Promise<AreaGrantResult> {
  const badgeId = badgeIdForWildArea(areaId, LOCATIONS);
  if (!badgeId) return { state: 'invalid', badgeId: null };
  const state = await grantBadge({ userId, badgeId, source: `cleared:${areaId}` });
  return { state, badgeId };
}

/** health 用：纯常量统计，不查库。 */
export function progressStats() {
  return { readonly: true, source: 'server_grants', badgeCount: Object.keys(BADGE_BY_ID).length };
}

export async function playerProgressRoutes(fastify: FastifyInstance): Promise<void> {
  /** 只读进度：等级 / 徽章 / 成就 / 总等级加成 / 属性加成。 */
  fastify.get('/api/player/progress', { preHandler: fastify.authenticate }, async (req, reply) => {
    const q = (req.query ?? {}) as Record<string, unknown>;
    const bad = FORBIDDEN_PROGRESS_QUERY_KEYS.find((k) => k in q);
    if (bad) {
      return reply.code(400).send({
        error: '进度为服务端只读真值，不接受任何上报字段',
        code: PROGRESS_INPUT_FORBIDDEN_CODE,
        field: bad,
      });
    }
    const userId = (req.user as any)?.userId as string | undefined;
    if (!userId) return reply.code(401).send({ error: '未登录或登录已过期' });
    const badgeIds = await readBadgeIds(userId);
    const progress = await readProgress(userId);
    const owned = new Set(progress.badges.map((b) => b.id));
    const catalog = allBadgeViews().map((b) => ({ ...b, owned: owned.has(b.id) }));
    const unlockedLocationsList = [...unlockedLocations(badgeIds)];
    return { ok: true, readonly: true, progress, catalog, unlockedLocations: unlockedLocationsList };
  });
}
