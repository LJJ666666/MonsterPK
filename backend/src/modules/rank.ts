/**
 * P4-2a 只读派生榜接口。
 *
 * 权威源：`Save` 表的落库存档（唯一写入口是 commitState()，写内存必落 DB），
 * 经过 validateSaveData 过滤脏档后由 game/rank.ts 纯函数派生。
 * 客户端**只发 GET、只收只读视图**：没有写路由、没有意图、没有 WS 上行，
 * 显式伪造的战力 / 等级 / 进度 / 分数字段一律 400，而不是「忽略后悄悄生效」。
 *
 * 实现口径（与排期文档 §4 对应）：P4-2a 先做**每次请求实时派生**的读模型，
 * 相当于 TTL=0 的 Read Model。理由：原型规模小、写档后立刻可见、不会出现
 * 「刚打完一仗榜单还是 30 秒前」的陈旧态；后续有规模再换周期快照，接口不变。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validateSaveData } from '../lib/saveValidator';
import {
  RANK_META, RANK_TYPES, parseRankType, deriveMetrics, buildBoard,
  type RankSource, type RankType,
} from '../game/rank';
import { POWER_DISCLAIMER } from '../game/power';
import { playerLevelOf } from '../game/playerLevel';

export const RANK_INPUT_FORBIDDEN_CODE = 'RANK_INPUT_FORBIDDEN';
export const RANK_TYPE_UNKNOWN_CODE = 'RANK_TYPE_UNKNOWN';

/**
 * 客户端若显式带这些字段，视为「试图上报榜单真值」，直接拒绝。
 * 未知其它字段不做处理（zod strip），不会进派生链路。
 */
export const FORBIDDEN_RANK_QUERY_KEYS = [
  'power', 'score', 'value', 'rank', 'level', 'playerLevel',
  'monsterPower', 'teamPower', 'summonerLevel', 'clearedAreas',
  'progress', 'rankScore', 'data',
] as const;

const querySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strip();

const typeSchema = z.object({ type: z.string().min(1).max(40) });

/** health 用：纯常量统计，不查库，避免健康检查被榜单拖慢。 */
export function rankStats() {
  return {
    types: RANK_TYPES.length,
    readonly: true,
    source: 'server_save',
  };
}

/**
 * 读全服合格存档并派生榜单输入。
 * 排除封号账号与管理员：管理员可用测试菜单造满属性/满金币，
 * 让它进全服榜会污染榜单（反作弊分级见任务表 §六）。
 */
export async function loadRankSources(): Promise<{
  sources: RankSource[];
  eligible: number;
  skipped: number;
}> {
  const rows = await prisma.save.findMany({
    where: {
      user: {
        bannedAt: null,
        role: { not: 'admin' },
      },
    },
    select: {
      userId: true,
      slot: true,
      data: true,
      user: { select: { username: true } },
    },
  });

  // F04 §31：召唤师等级真值在 BadgeGrant，不在存档 JSON。
  // 一次查全表按 userId 分组，避免每个存档再查一次（榜单是实时派生的读模型）。
  // 老账号无 Grant 记录 → playerLevelOf([]) 返回基础 Lv.5，不会显示 0 级。
  const grants = await prisma.badgeGrant.findMany({
    select: { userId: true, badgeId: true },
  });
  const badgesByUser = new Map<string, string[]>();
  for (const g of grants) {
    const list = badgesByUser.get(g.userId) ?? [];
    list.push(g.badgeId);
    badgesByUser.set(g.userId, list);
  }

  const sources: RankSource[] = [];
  let skipped = 0;
  for (const row of rows) {
    // 脏档不上榜：结构校验是服务端已有闸门，不另造一套宽松解析。
    if (!validateSaveData(row.data).ok) {
      skipped += 1;
      continue;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(row.data);
    } catch {
      skipped += 1;
      continue;
    }
    const metrics = deriveMetrics(parsed);
    if (!metrics) {
      skipped += 1;
      continue;
    }
    // 覆盖纯函数层的占位值：存档里塞 playerLevel / badges 一律不影响榜单。
    metrics.summonerLevel = playerLevelOf(badgesByUser.get(row.userId) ?? []);
    sources.push({
      userId: row.userId,
      username: row.user.username,
      slot: row.slot,
      metrics,
    });
  }
  return { sources, eligible: sources.length, skipped };
}

export async function rankRoutes(fastify: FastifyInstance): Promise<void> {
  /** 榜单类型清单（只读），前端据此渲染四个 Tab。 */
  fastify.get('/api/rank', { preHandler: fastify.authenticate }, async () => ({
    ok: true,
    types: RANK_TYPES.map((t) => RANK_META[t]),
    disclaimer: POWER_DISCLAIMER,
    readonly: true,
  }));

  /** 单张榜：按账号 + 槽位作为一条记录，同账号多槽各自上榜。 */
  fastify.get('/api/rank/:type', { preHandler: fastify.authenticate }, async (req, reply) => {
    const params = typeSchema.safeParse(req.params);
    if (!params.success) {
      return reply.code(400).send({ error: '榜单类型不合法', code: RANK_TYPE_UNKNOWN_CODE });
    }
    const type = parseRankType(params.data.type) as RankType | null;
    if (!type) {
      return reply.code(400).send({
        error: '未知榜单类型',
        code: RANK_TYPE_UNKNOWN_CODE,
        types: RANK_TYPES,
      });
    }

    // 显式防伪：客户端上报的任何真值字段都不允许出现在查询里。
    const raw = (req.query ?? {}) as Record<string, unknown>;
    const forged = FORBIDDEN_RANK_QUERY_KEYS.filter((k) => k in raw);
    if (forged.length > 0) {
      return reply.code(400).send({
        error: '榜单只接受 limit 参数，战力 / 等级 / 进度 / 分数由服务端派生',
        code: RANK_INPUT_FORBIDDEN_CODE,
        fields: forged,
      });
    }
    const q = querySchema.safeParse(raw);
    if (!q.success) {
      return reply.code(400).send({ error: 'limit 必须是 1~50 的整数' });
    }

    const { sources, eligible, skipped } = await loadRankSources();
    const viewerUserId = (req.user as any)?.userId as string | undefined;
    const entries = buildBoard(type, sources, q.data.limit, viewerUserId);
    return {
      ok: true,
      type,
      ...RANK_META[type],
      readonly: true,
      source: 'server_save',
      generatedAt: new Date().toISOString(),
      eligible,
      skipped,
      entries,
    };
  });
}
