/**
 * F18-b 演武堂挑战接口（2026-11-11）。
 *
 * 权威模型（与 Boss 讨伐对称，但更轻）：
 *  - 开局：只接受 `locationId`；王牌种 / 等级 / 馆主名全由 `game/gyms.ts` 内容表决定。
 *  - 战斗过程：复用 `/api/battle/action`（同一套状态机），无特殊字段、无伤害上报。
 *  - 结算：在 `modules/battle.ts` 的结束分支按 `gymId` 分流到 `settleGymRun`：
 *    胜利 → 经 `grantBadge` 发 `gym:<locationId>` 徽章（唯一写入口、幂等）+ 首次发 `ach_gym_first`；
 *    逃跑 / 全灭 → 不发徽章（冷却已在开局时设置，无需再处理）。
 *  - 防刷：开局即置 20min「馆主休息」冷却（单进程内存，见 `game/gyms.ts`）。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { BattleError, battleView, createBattle } from '../game/battle';
import { GYMS, getGym, gymCooldownUntil, isGymOnCooldown, setGymCooldown } from '../game/gyms';
import { THEME_TABLE } from '../game/content';
import { battles } from './sessionBus';
import { readSave } from './saveRead';
import { badgeIdForLocation } from '../game/badges';
import { readBadgeIds } from './playerProgress';

export const GYM_UNKNOWN_CODE = 'GYM_UNKNOWN';
export const GYM_ON_COOLDOWN_CODE = 'GYM_ON_COOLDOWN';
export const GYM_IN_PROGRESS_CODE = 'GYM_BATTLE_IN_PROGRESS';

// 扁平可选结构：ok 为 false 时带 code/message/status/retryAfterMs；为 true 时带 value。
// 用扁平结构而非判别联合，避免路由层 `!res.ok` 收窄在 union 上不生效（TS 在部分推断路径下会退化）。
type GymResult<T> = {
  ok: boolean;
  value?: T;
  code?: string;
  message?: string;
  status?: number;
  retryAfterMs?: number;
};

function ok<T>(value: T): GymResult<T> { return { ok: true, value }; }
function fail<T>(code: string, message: string, status = 400, retryAfterMs?: number): GymResult<T> {
  return { ok: false, code, message, status, retryAfterMs };
}

export async function applyGymStart(params: {
  userId: string;
  locationId: string;
  now?: number;
}): Promise<GymResult<Record<string, unknown>>> {
  const spec = getGym(params.locationId);
  if (!spec) return fail(GYM_UNKNOWN_CODE, '未知的演武堂');
  const now = params.now ?? Date.now();

  return withSlotLock(slotLockKey(params.userId), async (): Promise<GymResult<Record<string, unknown>>> => {
    if (battles.current(params.userId)) {
      return fail(GYM_IN_PROGRESS_CODE, '已有进行中的战斗', 409);
    }
    if (isGymOnCooldown(params.userId, params.locationId, now)) {
      const remaining = Math.max(0, gymCooldownUntil(params.userId, params.locationId) - now);
      return fail(GYM_ON_COOLDOWN_CODE, '馆主正在休息，请稍后再来', 429, remaining);
    }
    const row = await readSave(params.userId);
    if (!row) return fail('GYM_NO_SAVE', '还没有存档', 404);
    let save: any;
    try { save = JSON.parse(row.raw); } catch { return fail('GYM_SAVE_UNREADABLE', '服务端存档不可用'); }
    const party = Array.isArray(save?.party) ? save.party : [];
    if (party.length === 0) return fail('PARTY_EMPTY', '队伍为空，无法挑战');
    const aliveOne = party.some((m: any) => m && typeof m.hp === 'number' && m.hp > 0);
    if (!aliveOne) return fail('PARTY_FAINTED', '队伍中没有可战斗的幻兽');

    // 开局即置冷却：防「输→立刻重开」刷战斗，也拦住放弃后瞬重开。
    setGymCooldown(params.userId, params.locationId, now);

    const battleId = `gt_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
    try {
      const state = createBattle({
        id: battleId,
        userId: params.userId,
        theme: 'gym',
        areaName: `${spec.leaderName}的演武堂`,
        areaId: null,
        levelMin: 1,
        levelMax: 1,
        party,
        themes: THEME_TABLE,
        now,
        rng: Math.random,
        gym: { locationId: spec.locationId, specId: spec.aceSpeciesId, level: spec.aceLevel },
      });
      battles.create(state);
      return ok({
        battle: battleView(state),
        gym: {
          locationId: spec.locationId,
          leaderName: spec.leaderName,
          aceSpeciesId: spec.aceSpeciesId,
          aceLevel: spec.aceLevel,
        },
        cooldownUntil: gymCooldownUntil(params.userId, spec.locationId),
        readonly: true,
      });
    } catch (err) {
      if (err instanceof BattleError) return fail(err.code, err.message);
      throw err;
    }
  });
}

export async function gymRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/gym/start', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = z.object({ locationId: z.string().min(1).max(40) }).strip().safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' });
    const res = await applyGymStart({ userId, locationId: parsed.data.locationId });
    if (!res.ok) {
      return reply.code(res.status ?? 400).send({
        error: res.message ?? "请求失败",
        code: res.code,
        ...(res.retryAfterMs != null ? { retryAfterMs: res.retryAfterMs } : {}),
      });
    }
    return { ok: true, ...(res.value ?? {}) };
  });

  fastify.get('/api/gym/overview', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const badgeIds = await readBadgeIds(userId);
    const owned = new Set(badgeIds);
    const now = Date.now();
    const list = GYMS.map((g) => {
      const badgeId = badgeIdForLocation(g.locationId);
      const until = gymCooldownUntil(userId, g.locationId);
      return {
        locationId: g.locationId,
        leaderName: g.leaderName,
        aceSpeciesId: g.aceSpeciesId,
        aceLevel: g.aceLevel,
        badgeId,
        badgeOwned: badgeId ? owned.has(badgeId) : false,
        onCooldown: until > now,
        cooldownUntil: until,
      };
    });
    return { ok: true, readonly: true, gyms: list };
  });
}
