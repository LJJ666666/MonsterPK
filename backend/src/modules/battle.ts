/**
 * 服务端战斗接口（P3-1）。
 *
 * 客户端只能做三件事：开一场战斗、发一个动作、查当前战斗。
 * HP / PP / 伤害 / 敌方选招 / 捕获成败 / 经验金钱全部由服务端裁决，
 * 战斗结束由服务端把结果写回存档并广播（source='battle'）。
 *
 * 与 P1-2 的关系：P1-2 是「客户端跑完再上报，服务端核对增量」；
 * 本模块把过程也接管了。`battle_reward` / `capture` 意图已于 2026-11-07 从
 * `settlements.ts` 删除——它们采信客户端上报的 `enemyLevel` / `baseRate`，
 * 战斗上移后等于零成本刷奖励的口子，不再保留兼容开关。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { digestOf, type AuthorityState } from '../lib/authority';
import { BATTLE_TTL_MS } from '../lib/battleSession';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import {
  applyBattleAction, applyAdminTestFlags, battleView, BattleError, createBattle,
  type BattleAction, type BattleState,
} from '../game/battle';
import { LOCATIONS, THEME_TABLE, contentStats } from '../game/content';
import { bossDailyLimit, dayKeyOf, getBoss } from '../game/boss';
import { encodeServerMessage } from '../lib/wsProtocol';
import { commitState } from './session';
import { readSave } from './saveRead';
// F12：结算写档已抽成 `game/settlement.ts` 的纯函数，普通战斗与单人 Boss 共用。
import { applySettlementToSave } from '../game/settlement';
// F14：Boss 双档奖励发放（服务端唯一写入口，客户端无领取入口）。
import { grantBossRewards, type BossRewardResult } from './bossReward';
import { broadcastToUser, battles, wilds, bossQuota } from './sessionBus';
import { publishWild, resolveAreaSpec } from './wild';
// F04：宠物等级帽由服务端进度真值注入；常规战斗首通野区幂等发对应徽章（§31.9）。
import { readProgress, grantBadgeForAreaClear } from './playerProgress';
import type { WildAreaSpec, WildInstance } from '../lib/wildRegistry';

const startSchema = z.object({
  theme: z.string().min(1).max(40),
  areaName: z.string().min(1).max(60),
  areaId: z.string().min(1).max(60).nullish(),
  levelMin: z.coerce.number().int().min(1).max(60).default(1),
  levelMax: z.coerce.number().int().min(1).max(60).default(3),
  /**
   * P4-1b：指定要挑战的共享野怪实例。命中时敌方种族/等级取自实例，
   * 且由服务端原子抢占 —— 别人再抢同一只只会拿到 409 WILD_CLAIMED。
   */
  wildId: z.string().min(1).max(80).optional(),
  /**
   * P3-1c：管理员测试标记。普通账号传了也**静默忽略**（不报错、不封号），
   * 避免把「客户端硬编码了测试开关」这种误用升级成风控事件。
   */
  testFlags: z.object({
    testShiny: z.boolean().optional(),
    testMaxStats: z.boolean().optional(),
    testOHKO: z.boolean().optional(),
  }).optional(),
}).strip();

const actionSchema = z.object({
  battleId: z.string().min(1).max(80),
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('move'), moveId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('item'), itemId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('capture'), itemId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('switch'), partyIndex: z.coerce.number().int().min(0).max(5) }),
    z.object({ type: z.literal('flee') }),
  ]),
}).strip();

function broadcastBattle(userId: string, state: BattleState) {
  broadcastToUser(userId, encodeServerMessage({
    type: 'battle.state',
    battleId: state.id,
    turn: state.turn,
    finished: state.finished,
    result: state.result,
  }));
}

function fail(reply: any, err: unknown) {
  if (err instanceof BattleError) return reply.code(err.code === 'BATTLE_FINISHED' ? 409 : 400).send({ error: err.message, code: err.code });
  throw err;
}

/** 用服务端内容表还原区域真值后广播野怪列表（跨账号）。 */
function publishArea(
  areaId: string,
  fallback: WildAreaSpec,
): void {
  publishWild(areaId, resolveAreaSpec(areaId, fallback));
}

/** 战斗结果 → 共享野怪的公开结算结果。 */
function wildResultOf(result: BattleState['result']): 'captured' | 'defeated' | 'fled' {
  if (result === 'captured') return 'captured';
  if (result === 'enemy_fainted') return 'defeated';
  return 'fled';
}

/**
 * P4-2c：Boss 结算。**伤害只取 `state.damageDealt`**（服务端按敌方 HP 差累计），
 * 客户端回包里没有任何可写入路径。
 *
 * 规则：
 *  - 逃跑成功 = 放弃：释放次数、不写事件、不上榜（防止「打一半跑」反复刷最高伤害）；
 *  - 击败 / 全灭 = 有效挑战：写一条 append-only 事件（`battleId` 唯一，重复结算不叠加），
 *    并把在途名额转成已用（已用真值就是事件行数）；
 *  - 事件写入失败不阻断响应：存档已经落库，玩家这一场照常结束；失败会记录日志便于排查。
 */
async function settleBossRun(
  req: FastifyRequest,
  userId: string,
  state: BattleState,
) {
  const quotaKey = state.bossQuotaKey ?? null;
  const now = Date.now();
  const dayKey = dayKeyOf(now);
  const bossId = state.bossId as string;
  const damage = Math.max(0, Math.floor(state.damageDealt ?? 0));

  if (state.result === 'fled') {
    if (quotaKey) bossQuota.release(quotaKey);
    const spec = getBoss(bossId);
    const limit = spec ? bossDailyLimit(spec) : 0;
    return {
      bossId,
      periodKey: dayKey,
      damageDealt: damage,
      recorded: false,
      reason: 'fled',
      total: 0,
      best: 0,
      attempts: 0,
      quota: { limit, used: 0, remaining: limit },
      // F14：逃跑不发奖励；字段恒定存在，客户端不需要判 undefined。
      reward: null,
    };
  }

  let recorded = false;
  try {
    await prisma.bossDamageEvent.create({
      data: {
        userId,
        bossId,
        periodKey: dayKey,
        damage,
        result: String(state.result ?? 'unknown'),
        battleId: state.id,
      },
    });
    recorded = true;
  } catch (err: any) {
    // P2002 = battleId 已存在：同一场战斗重复结算，视为已记录，不叠加伤害。
    if (err?.code !== 'P2002') {
      req.log.error({ event: 'boss_damage_persist_failed', userId, bossId, battleId: state.id, err },
        'boss damage event insert failed');
    }
  }
  if (quotaKey) bossQuota.commit(quotaKey);

  const agg = await prisma.bossDamageEvent.aggregate({
    where: { userId, bossId, periodKey: dayKey },
    _sum: { damage: true },
    _max: { damage: true },
    _count: { _all: true },
  });
  const spec = getBoss(bossId);
  const limit = spec ? bossDailyLimit(spec) : 0;
  const attempts = agg._count?._all ?? 0;

  // F14：双档奖励（每场小包 + 每日首讨大包）。只打赢才发；
  // 幂等由 BossRewardGrant.grantKey 唯一键保证，重复结算同一场必然跳过。
  // 发放异常不阻断战斗结束响应（与 BossDamageEvent 写入失败同口径），
  // 内核已删除占位记录，可重跑补发。
  let reward: BossRewardResult | null = null;
  try {
    reward = await grantBossRewards({
      userId, bossId, periodKey: dayKey,
      battleId: state.id, result: String(state.result ?? 'unknown'), now,
      // `/api/battle/action` 路由层已持有账号锁；不可重入。
      alreadyLocked: true,
    });
  } catch (err) {
    req.log.error({ event: 'boss_reward_grant_failed', userId, bossId, battleId: state.id, err },
      'boss reward grant failed');
  }

  return {
    bossId,
    periodKey: dayKey,
    damageDealt: damage,
    recorded,
    total: agg._sum?.damage ?? 0,
    best: agg._max?.damage ?? 0,
    attempts,
    quota: { limit, used: attempts, remaining: Math.max(0, limit - attempts) },
    reward,
  };
}

export async function battleRoutes(fastify: FastifyInstance): Promise<void> {
  /** 开局：敌方由服务端生成，客户端只说明「在哪打」。 */
  fastify.post('/api/battle/start', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '开局参数不合法' });
    // 开局要拿队伍快照，与写操作串行，避免读到半途的存档。
    return withSlotLock(slotLockKey(userId), () =>
      runBattleStart(reply, userId, parsed.data),
    );
  });

  /** 开局主体；调用方已持有账号锁。 */
  async function runBattleStart(reply: FastifyReply, userId: string, params: z.infer<typeof startSchema>) {
    const { theme, areaName, areaId, levelMin, levelMax, testFlags, wildId } = params;

    if (!THEME_TABLE[theme]) return reply.code(400).send({ error: '该区域没有可遭遇的幻兽' });

    // P4-2c：Boss 战未结束时不允许用它顶掉 —— 否则这次「在途次数」会一直挂到 TTL。
    // 普通战斗之间仍然允许覆盖（历史行为，E2E 依赖），只拦 Boss。
    const existing = battles.current(userId);
    if (existing?.bossId) {
      return reply.code(409).send({ error: '讨伐尚未结束，请先完成或放弃', code: 'BOSS_IN_PROGRESS' });
    }

    const row = await readSave(userId);
    if (!row) return reply.code(404).send({ error: '还没有存档' });

    let save: any;
    try {
      save = JSON.parse(row.raw);
    } catch {
      return reply.code(400).send({ error: '存档不可用' });
    }
    const party = Array.isArray(save?.party) ? save.party : [];
    if (party.length === 0) return reply.code(400).send({ error: '队伍为空' });

    // 区域真值校准：areaId 能对上服务端地图时，等级区间以服务端为准
    let lvMin = Math.min(levelMin, levelMax);
    let lvMax = Math.max(levelMin, levelMax);
    let finalTheme = theme;
    let finalName = areaName;
    if (areaId) {
      for (const loc of Object.values(LOCATIONS) as any[]) {
        const area = (loc.wildAreas ?? []).find((a: any) => a.id === areaId);
        if (!area) continue;
        lvMin = Math.max(1, Math.round(area.levelMin ?? lvMin));
        lvMax = Math.max(lvMin, Math.round(area.levelMax ?? lvMax));
        finalTheme = area.encounters?.[0] ?? finalTheme;
        finalName = area.name ?? finalName;
        break;
      }
      if (!THEME_TABLE[finalTheme]) finalTheme = theme;
    }

    const now = Date.now();
    const battleId = `bt_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    // P4-1b：指定野怪时先原子抢占。claim 是同步纯函数，没有 await，
    // 同一实例的两个并发开局请求只有第一个能拿到（捕获互斥的语言级保证）。
    let claimed: WildInstance | null = null;
    let claimedAreaId: string | null = null;
    let claimedSpec: WildAreaSpec | null = null;
    if (wildId) {
      if (battles.current(userId)) {
        return reply.code(409).send({ error: '已有进行中的战斗', code: 'BATTLE_IN_PROGRESS' });
      }
      const areaKey = areaId ?? theme;
      const spec = resolveAreaSpec(areaKey, { theme: finalTheme, levelMin: lvMin, levelMax: lvMax });
      const claim = wilds.claim(wildId, userId, battleId, now);
      if (!claim.ok) {
        // strict:false 下判别联合不收窄，用属性存在性取值（bug_log §18）。
        const code = 'code' in claim ? claim.code : 'WILD_CLAIMED';
        const status = code === 'WILD_NOT_FOUND' ? 404 : 409;
        return reply.code(status).send({
          error: code === 'WILD_NOT_FOUND' ? '野怪不存在或已刷新'
            : code === 'WILD_ON_COOLDOWN' ? '已有正在挑战的野怪'
              : '这只野怪已被其他玩家抢先挑战',
          code,
        });
      }
      claimed = claim.instance;
      claimedAreaId = claim.instance.areaId;
      claimedSpec = spec;
    }

    try {
      const levelCap = (await readProgress(userId)).cap;
      const state = createBattle({
        id: battleId,
        levelCap,
        userId,
        theme: finalTheme,
        areaName: finalName,
        areaId: areaId ?? null,
        levelMin: lvMin,
        levelMax: lvMax,
        party,
        themes: THEME_TABLE,
        now,
        rng: Math.random,
        ...(claimed ? {
          wild: {
            wildId: claimed.id,
            speciesId: claimed.speciesId,
            level: claimed.level,
            label: claimed.label,
          },
        } : {}),
      });
      // 测试标记只对管理员生效：身份由服务端查库判定，客户端自称不算数。
      // 只在客户端真的传了标记时才多查一次库，普通玩家开局没有额外开销。
      if (testFlags && Object.values(testFlags).some(Boolean)) {
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (me?.role === 'admin') applyAdminTestFlags(state, testFlags);
      }
      battles.create(state);
      if (claimed && claimedAreaId && claimedSpec) {
        // 抢占成功立刻广播：其他客户端马上看到「已被挑战」，不会继续排队点同一只。
        publishWild(claimedAreaId, resolveAreaSpec(claimedAreaId, claimedSpec), now);
      }
      return {
        ok: true,
        battle: battleView(state),
        content: contentStats(),
        ttlMs: BATTLE_TTL_MS,
        wild: claimed ? { id: claimed.id, areaId: claimedAreaId } : null,
      };
    } catch (err) {
      // 开局失败（队伍全灭 / 内容表异常）必须把刚抢占的实例放回去，
      // 否则这只野怪会永久卡在 claimed，谁都打不了。
      if (claimed && claimedAreaId && claimedSpec) {
        wilds.release(battleId, now);
        publishWild(claimedAreaId, resolveAreaSpec(claimedAreaId, claimedSpec), now);
      }
      return fail(reply, err);
    }
  }

  /** 动作：服务端推进一回合；结束则结算写档并广播。 */
  fastify.post('/api/battle/action', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = actionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '动作参数不合法' });
    // 同一账号串行：动作流程里有 await 读档，并发两条动作会各自基于同一份战斗态推进，
    // 结束判定还会重复结算写档。与 PUT / 存档写操作共用同一把账号锁。
    return withSlotLock(slotLockKey(userId), () =>
      runBattleAction(req, reply, userId, parsed.data),
    );
  });

  /** 动作主体；调用方已持有账号锁。 */
  async function runBattleAction(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    params: z.infer<typeof actionSchema>,
  ) {
    const { battleId, action } = params;

    const state = battles.get(userId, battleId);
    if (!state) return reply.code(404).send({ error: '战斗不存在或已结束', code: 'BATTLE_NOT_FOUND' });
    if (state.actions > 500) return reply.code(429).send({ error: '战斗回合过多，请重新开局' });

    const row = await readSave(userId);
    if (!row) return reply.code(404).send({ error: '还没有存档' });

    let save: any;
    try {
      save = JSON.parse(row.raw);
    } catch {
      return reply.code(400).send({ error: '存档不可用' });
    }
    const inventory: Record<string, number> = save?.inventory ?? {};

    let next: BattleState;
    try {
      next = applyBattleAction(state, action as BattleAction, {
        inventory,
        rng: Math.random,
        now: Date.now(),
      });
    } catch (err) {
      return fail(reply, err);
    }

    battles.update(next);
    broadcastBattle(userId, next);

    // 结束：服务端结算写档（这一步之后客户端再 PUT 也只能与原档一致）
    if (next.finished) {
      try {
        const raw = applySettlementToSave(row.raw, next);
        const authority: AuthorityState = {
          ...row.authority,
          expected: digestOf(raw),
          revision: row.authority.revision + 1,
          pending: null,
        };
        const committed = await commitState(userId, {
          data: raw,
          schemaVersion: row.schemaVersion,
          clientId: row.clientId,
          authority,
          source: 'battle',
        });
        battles.drop(userId);

        // F04 §31.9：常规战斗首通野区 → 幂等发对应徽章（V1 过渡口径）。
        // 只认服务端结算出的 areaId / result；Boss 战 areaId 为 null 不参与。
        // 发奖失败只记日志，不阻断战斗结算响应（徽章表无外键、唯一键天然幂等）。
        if (!next.bossId && next.areaId
          && (next.result === 'enemy_fainted' || next.result === 'captured')) {
          try { await grantBadgeForAreaClear(userId, next.areaId); }
          catch (e) {
            req.log.warn({ userId, areaId: next.areaId, err: String(e) }, '首通徽章发放失败（不阻断结算）');
          }
        }

        // P4-2c：Boss 战分流。Boss 战没有 wildId，两者互斥；用 if/else 而不是并列，
        // 避免以后加玩法时漏判「两个结算都跑了」。
        if (next.bossId) {
          const boss = await settleBossRun(req, userId, next);
          return {
            ok: true,
            battle: battleView(next),
            revision: committed.revision,
            settled: true,
            boss,
          };
        }

        // P4-1b：共享野怪结算。归属两键由 WildRegistry 复核，结果跨账号广播，
        // 其他客户端会看到这只野怪变成 resolved（已捕获 / 已击败 / 已逃走）。
        const wild = next.wildId ? wilds.findByBattle(next.id) : undefined;
        if (wild) {
          wilds.resolve(wild.id, userId, next.id, wildResultOf(next.result), Date.now());
          publishArea(wild.areaId, {
            theme: next.theme, levelMin: next.levelMin, levelMax: next.levelMax,
          });
        }
        return {
          ok: true,
          battle: battleView(next),
          revision: committed.revision,
          settled: true,
        };
      } catch (err) {
        return fail(reply, err);
      }
    }

    return { ok: true, battle: battleView(next), settled: false };
  }

  /** 查当前战斗：重连 / 刷新后用，避免把战斗态存到客户端。 */
  fastify.get('/api/battle/current', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const state = battles.current(userId);
    if (!state) return { ok: true, battle: null };
    return { ok: true, battle: battleView(state) };
  });

  /** 放弃战斗：不结算奖励，仅丢弃会话（撤离走 action.type='flee' 才有成功率）。 */
  fastify.post('/api/battle/abandon', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = z.object({ battleId: z.string().min(1).max(80) }).strip().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' });
    const state = battles.get(userId, parsed.data.battleId);
    if (!state) return reply.code(404).send({ error: '战斗不存在', code: 'BATTLE_NOT_FOUND' });
    battles.drop(userId);
    // P4-2c：放弃 Boss 战 = 不扣次数（release 在途名额），也不写伤害事件。
    if (state.bossId && state.bossQuotaKey) bossQuota.release(state.bossQuotaKey);
    // P4-1b：放弃不等于捕获，野怪放回池子让别人还能抢；并广播状态变化。
    const released = wilds.release(parsed.data.battleId, Date.now());
    for (const areaId of released) {
      publishArea(areaId, { theme: state.theme, levelMin: state.levelMin, levelMax: state.levelMax });
    }
    return { ok: true, dropped: true };
  });
}
