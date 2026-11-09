/**
 * F01/F02 榜单周期接口（唯一写接口是管理员结算，其余全部只读）。
 *
 * 防伪口径与 P4-2a 一致：客户端显式带任何「名次 / 分数 / 奖励 / 已领取」字段
 * 一律 400 并回显字段，而不是静默忽略后悄悄生效。
 * 普通账号没有触发结算的权限；结算也可以由 `npm run rank:settle` 在服务端跑。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { getAccountState } from '../lib/account';
import { FORBIDDEN_RANK_QUERY_KEYS, RANK_INPUT_FORBIDDEN_CODE } from './rank';
import {
  periodKeyOf, previousPeriodKey, parsePeriodKey, RANK_PERIOD_GRANULARITY,
} from '../game/period';
import {
  SETTLE_BOARDS, boardLabel, rewardFor, rewardView, REWARD_MAX_RANK,
} from '../game/rankReward';
import {
  settlePeriod, listSettledPeriods, loadPeriodBoards, loadMyRewards,
} from './rankSettlement';

/** 历史榜 / 奖励 / 结算接口都不接受真值上报。 */
const FORBIDDEN_PERIOD_KEYS = [
  ...FORBIDDEN_RANK_QUERY_KEYS,
  'claim', 'claimed', 'reward', 'rewards', 'money', 'items', 'granted',
  'settle', 'settled', 'userId', 'username', // periodKey 是结算接口的合法入参，不列黑名单
] as const;

function forgedIn(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return FORBIDDEN_PERIOD_KEYS.find((k) => k in (obj as Record<string, unknown>));
}

const settleBodySchema = z.object({
  periodKey: z.string().length(10),
}).strip();

export async function rankPeriodRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  /** 已结算周期清单 + 当前周期 + 奖励规则（只读，前端据此渲染历史视图）。 */
  fastify.get('/api/rank/periods', guard, async (req: any, reply) => {
    const forged = forgedIn(req.query);
    if (forged) {
      return reply.code(400).send({
        error: '周期榜只接受只读查询，名次 / 奖励由服务端结算产出',
        code: RANK_INPUT_FORBIDDEN_CODE, fields: [forged],
      });
    }
    const now = Date.now();
    return {
      ok: true,
      readonly: true,
      granularity: RANK_PERIOD_GRANULARITY,
      currentPeriodKey: periodKeyOf(now),
      previousPeriodKey: previousPeriodKey(now),
      rewardMaxRank: REWARD_MAX_RANK,
      boards: SETTLE_BOARDS.map((key) => ({
        boardKey: key,
        label: boardLabel(key),
        rewardTiers: [1, 2, 3, 4].map((rank) => ({
          rank, reward: rewardView(rewardFor(key, rank)!),
        })),
      })),
      periods: await listSettledPeriods(),
    };
  });

  /** 某周期的全部历史榜（只读）；未结算返回 404 + 明确机器码。 */
  fastify.get('/api/rank/periods/:periodKey', guard, async (req: any, reply) => {
    const forged = forgedIn(req.query);
    if (forged) {
      return reply.code(400).send({
        error: '历史榜只接受只读查询，名次 / 奖励由服务端结算产出',
        code: RANK_INPUT_FORBIDDEN_CODE, fields: [forged],
      });
    }
    const key = String(req.params?.periodKey ?? '');
    if (!parsePeriodKey(key)) {
      return reply.code(400).send({ error: '周期键格式应为 YYYY-MM-DD', code: 'RANK_PERIOD_INVALID' });
    }
    const acc = await getAccountState(req.user.userId);
    const data = await loadPeriodBoards(key, acc.username ?? undefined);
    if (!data) {
      return reply.code(404).send({ error: '该周期尚未结算', code: 'RANK_PERIOD_NOT_SETTLED' });
    }
    return data;
  });

  /** 我的获奖记录（只读，永远没有"领取"入口）。 */
  fastify.get('/api/rank/rewards', guard, async (req: any, reply) => {
    const forged = forgedIn(req.query);
    if (forged) {
      return reply.code(400).send({
        error: '奖励记录只读，客户端不得上报领取 / 奖励数值',
        code: RANK_INPUT_FORBIDDEN_CODE, fields: [forged],
      });
    }
    return loadMyRewards(req.user.userId);
  });

  /**
   * 管理员 / 服务端脚本触发结算。普通账号 403，不封号（误点按钮不是作弊）。
   * 幂等可重跑：同一周期重复调用不会重复发奖。
   */
  fastify.post('/api/rank/admin/settle', guard, async (req: any, reply) => {
    const forged = forgedIn(req.body);
    if (forged) {
      return reply.code(400).send({
        error: '结算请求只接受 periodKey，名次 / 奖励由服务端产出',
        code: RANK_INPUT_FORBIDDEN_CODE, fields: [forged],
      });
    }
    const parsed = settleBodySchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: 'periodKey 格式应为 YYYY-MM-DD', code: 'RANK_PERIOD_INVALID' });
    }
    const acc = await getAccountState(req.user.userId);
    if (!acc.isAdmin) {
      return reply.code(403).send({ error: '只有管理员可以触发周期结算', code: 'RANK_SETTLE_FORBIDDEN' });
    }
    const result = await settlePeriod(parsed.data.periodKey);
    if (!result.ok) {
      return reply.code(400).send({ error: result.reason, code: result.code });
    }
    req.log.info({
      event: 'rank_period_settled', periodKey: result.periodKey,
      boards: result.boards, snapshots: result.snapshotsCreated,
      rewards: result.rewardsGranted,
    }, '榜单周期结算完成');
    return { ok: true, ...result };
  });
}
