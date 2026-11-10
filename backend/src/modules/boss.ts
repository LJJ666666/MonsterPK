/**
 * P4-2c 单人 Boss 讨伐接口。
 *
 * 权威模型：
 *  - **开局**：只接受 `bossId`；等级 / HP 倍率 / 每日次数全部由服务端内容表与 env 决定。
 *  - **战斗过程**：复用 `/api/battle/action`（同一个 `battleId`、同一个战斗状态机），
 *    伤害由 `applyBattleAction()` 按敌方 HP 差累计，客户端**没有任何伤害上报字段**。
 *  - **结算**：`modules/battle.ts` 的结束分支按 `bossId` 分流：
 *    写档（队伍 HP / 道具消耗，无奖励） → 插 `BossDamageEvent`（append-only，battleId 唯一）
 *    → 释放 quota 在途名额。逃跑 = 放弃（release，不写事件、不上榜）。
 *  - **榜**：只读聚合 `BossDamageEvent`，按账号合并，排除封号 / 管理员。
 *
 * 次数：`BossQuotaLedger` 只记在途，已用次数真值来自 DB 行数，
 * 所以「进程重启重置次数」不成立（与房间 quota 的差异见 `lib/bossQuota.ts` 头注释）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import {
  BOSSES, BOSS_IDS, bossDailyLimit, bossQuotaKey, bossStats, bossView, dayKeyOf, getBoss,
} from '../game/boss';
import { buildBossBoard, summarizeRuns, type BossRunRow } from '../game/bossRank';
import { BattleError, battleView, createBattle } from '../game/battle';
import { THEME_TABLE } from '../game/content';
import { battles, bossQuota } from './sessionBus';
import { readSave } from './saveRead';

export const BOSS_INPUT_FORBIDDEN_CODE = 'BOSS_INPUT_FORBIDDEN';
export const BOSS_UNKNOWN_CODE = 'BOSS_UNKNOWN';

const startSchema = z.object({
  bossId: z.string().min(1).max(60),
}).strip();

const rankQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
}).strip();

/**
 * 客户端若显式带这些字段，视为「试图上报伤害 / 次数 / 排名」，直接 400。
 * 这与 `modules/rank.ts` 的 `RANK_INPUT_FORBIDDEN` 同一口径：不是静默忽略。
 */
const FORBIDDEN_BOSS_FIELDS = [
  'damage', 'damageDealt', 'score', 'total', 'rank', 'rankScore',
  'hp', 'enemyHp', 'maxHp', 'level', 'hpMultiplier',
  'quota', 'quotaLimit', 'dailyLimit', 'used', 'remaining', 'periodKey', 'entries',
  // F14：奖励由服务端发放，客户端显式带任何奖励 / 领取 / 档位字段一律 400。
  'reward', 'rewards', 'money', 'items', 'grant', 'grantKey', 'claim', 'claimed', 'tier',
] as const;

function forgedField(obj: unknown): string | undefined {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return undefined;
  return FORBIDDEN_BOSS_FIELDS.find((k) => k in (obj as Record<string, unknown>));
}

/** 账号级次数锁：一账号一档共享每日次数，hold 必须串行。 */
function bossLockKey(userId: string): string {
  return `bossq:${userId}`;
}

type BossResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; reason: string; status: number };

const fail = (code: string, reason: string, status = 400): BossResult<never> => ({
  ok: false, code, reason, status,
});

/** health 用：Boss 数量与真值来源，不查库。 */
export function bossHealthStats() {
  return { ...bossStats(), quotas: bossQuota.stats() };
}

/**
 * 开局主体。锁顺序固定为 **账号锁 → 账号次数锁**，
 * 结算 / 放弃走同一条顺序（都在账号锁内操作 quota），因此不会互相死锁。
 */
export async function applyBossStart(params: {
  userId: string;
  bossId: string;
  now?: number;
}): Promise<BossResult<Record<string, unknown>>> {
  const spec = getBoss(params.bossId);
  if (!spec) return fail(BOSS_UNKNOWN_CODE, '未知的讨伐目标');
  const now = params.now ?? Date.now();

  return withSlotLock(slotLockKey(params.userId), () =>
    withSlotLock(bossLockKey(params.userId), async (): Promise<BossResult<Record<string, unknown>>> => {
      if (battles.current(params.userId)) {
        return fail('BOSS_BATTLE_IN_PROGRESS', '已有进行中的战斗', 409);
      }
      const row = await readSave(params.userId);
      if (!row) return fail('BOSS_NO_SAVE', '还没有存档', 404);
      let save: any;
      try {
        save = JSON.parse(row.raw);
      } catch {
        return fail('BOSS_SAVE_UNREADABLE', '服务端存档不可用');
      }
      const party = Array.isArray(save?.party) ? save.party : [];
      if (party.length === 0) return fail('PARTY_EMPTY', '队伍为空，无法挑战');
      const aliveOne = party.some((m: any) => m && typeof m.hp === 'number' && m.hp > 0);
      if (!aliveOne) return fail('PARTY_FAINTED', '队伍中没有可战斗的幻兽');

      const limit = bossDailyLimit(spec);
      if (limit <= 0) return fail('BOSS_QUOTA_EXHAUSTED', '讨伐次数已关闭', 429);

      const dayKey = dayKeyOf(now);
      const key = bossQuotaKey(params.userId, spec.bossId, dayKey);
      // 已用次数以 DB 事件为准：进程重启不会把次数重置。
      const used = await prisma.bossDamageEvent.count({
        where: { userId: params.userId, bossId: spec.bossId, periodKey: dayKey },
      });
      if (!bossQuota.hold(key, used, limit)) {
        return fail('BOSS_QUOTA_EXHAUSTED', '今日讨伐次数已用完', 429);
      }

      const battleId = `bt_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
      try {
        const state = createBattle({
          id: battleId,
          userId: params.userId,
          theme: spec.theme,
          areaName: spec.name,
          levelMin: 1,
          levelMax: 1,
          party,
          themes: THEME_TABLE,
          now,
          rng: Math.random,
          boss: { spec, quotaKey: key },
        });
        battles.create(state);
        return {
          ok: true,
          value: {
            battle: battleView(state),
            boss: bossView(spec, limit),
            quota: { limit, used, remaining: Math.max(0, limit - used - 1) },
            periodKey: dayKey,
            readonly: true,
          },
        };
      } catch (err) {
        // 开局失败必须放回名额，否则这次 hold 会一直占到服务重启。
        bossQuota.release(key);
        if (err instanceof BattleError) return fail(err.code, err.message);
        throw err;
      }
    }),
  );
}

/** 我今日的讨伐概览：每个 Boss 的已用 / 在途 / 余量 + 我的累计伤害。 */
export async function loadBossOverview(userId: string, now = Date.now()) {
  const dayKey = dayKeyOf(now);
  const events = await prisma.bossDamageEvent.findMany({
    where: { userId, periodKey: dayKey },
    select: { bossId: true, damage: true },
  });
  const bosses = BOSS_IDS.map((id) => {
    const spec = BOSSES[id];
    const limit = bossDailyLimit(spec);
    const mine = events.filter((e) => e.bossId === id);
    const held = bossQuota.heldOf(bossQuotaKey(userId, id, dayKey));
    let total = 0;
    let best = 0;
    for (const e of mine) {
      const d = Math.max(0, Math.floor(e.damage));
      total += d;
      best = Math.max(best, d);
    }
    return {
      ...bossView(spec, limit),
      used: mine.length,
      held,
      remaining: Math.max(0, limit - mine.length - held),
      my: { total, best, attempts: mine.length },
    };
  });
  return { ok: true, periodKey: dayKey, readonly: true, bosses };
}

/** 只读伤害榜：只取当日、只认事件表，客户端参数只有 limit。 */
export async function loadBossRank(params: {
  bossId: string;
  viewerUserId?: string;
  limit?: number;
  now?: number;
}) {
  const spec = getBoss(params.bossId);
  if (!spec) return null;
  const dayKey = dayKeyOf(params.now ?? Date.now());
  const events = await prisma.bossDamageEvent.findMany({
    where: { bossId: spec.bossId, periodKey: dayKey },
    select: { userId: true, damage: true, createdAt: true },
  });
  const ids = Array.from(new Set(events.map((e) => e.userId)));
  // 排除封号 / 管理员：与 P4-2a 榜单同一口径（管理员测试数据不污染线上榜）。
  const users = ids.length
    ? await prisma.user.findMany({
        where: { id: { in: ids }, bannedAt: null, role: { not: 'admin' } },
        select: { id: true, username: true },
      })
    : [];
  const nameOf = new Map(users.map((u) => [u.id, u.username]));
  const rows: BossRunRow[] = events
    .filter((e) => nameOf.has(e.userId))
    .map((e) => ({
      userId: e.userId,
      username: nameOf.get(e.userId)!,
      damage: e.damage,
      createdAt: e.createdAt.getTime(),
    }));
  return {
    ok: true,
    bossId: spec.bossId,
    bossName: spec.name,
    periodKey: dayKey,
    readonly: true,
    source: 'boss_damage_events',
    generatedAt: new Date().toISOString(),
    entries: buildBossBoard(rows, params.limit ?? 20, params.viewerUserId),
    me: params.viewerUserId ? summarizeRuns(rows, params.viewerUserId) : { total: 0, best: 0, attempts: 0 },
  };
}

export async function bossRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  /** 讨伐列表 + 我的次数与伤害（只读）。 */
  fastify.get('/api/boss', guard, async (req: any, reply) => {
    const forged = forgedField(req.query);
    if (forged) {
      return reply.code(400).send({
        error: '讨伐接口只接受只读查询，伤害 / 次数 / 排名由服务端产出',
        code: BOSS_INPUT_FORBIDDEN_CODE,
        fields: [forged],
      });
    }
    return reply.send(await loadBossOverview(req.user.userId));
  });

  /** 开局：服务端生成强化 Boss，占用一次在途名额（不扣次数，结算才扣）。 */
  fastify.post('/api/boss/start', guard, async (req: any, reply) => {
    const forged = forgedField(req.body);
    if (forged) {
      return reply.code(400).send({
        error: '客户端不得上报伤害 / 次数 / Boss 数值',
        code: BOSS_INPUT_FORBIDDEN_CODE,
        fields: [forged],
      });
    }
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      return reply.code(400).send({ error: '开局参数不合法', code: 'BOSS_BAD_REQUEST' });
    }
    const res = await applyBossStart({
      userId: req.user.userId,
      bossId: parsed.data.bossId,
    });
    if ('code' in res) {
      return reply.code(res.status).send({ error: res.reason, code: res.code });
    }
    return reply.send({ ok: true, ...res.value });
  });

  /** 只读伤害榜（当日）。 */
  fastify.get('/api/boss/:bossId/rank', guard, async (req: any, reply) => {
    const forged = forgedField(req.query);
    if (forged) {
      return reply.code(400).send({
        error: '伤害榜只接受 limit 参数，伤害值由服务端战斗结算产出',
        code: BOSS_INPUT_FORBIDDEN_CODE,
        fields: [forged],
      });
    }
    const q = rankQuerySchema.safeParse(req.query ?? {});
    if (!q.success) {
      return reply.code(400).send({ error: 'limit 必须是 1~50 的整数', code: 'BOSS_BAD_REQUEST' });
    }
    const bossId = String(req.params?.bossId ?? '');
    const data = await loadBossRank({
      bossId,
      viewerUserId: req.user.userId,
      limit: q.data.limit,
    });
    if (!data) {
      return reply.code(400).send({ error: '未知的讨伐目标', code: BOSS_UNKNOWN_CODE });
    }
    return reply.send(data);
  });
}
