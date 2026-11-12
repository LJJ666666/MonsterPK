/**
 * F18-c 地图首领：开局 / 概览 / 掉落发放 / 结算（服务端唯一写入口）。
 *
 * 与 P4-2c 每日 Boss（带伤害榜 + F14 双档奖励）**完全独立**：
 *  - 解锁门槛 = 该城在 `unlockedLocations`（持上一城徽章，F18-a 派生）；
 *  - **不上任何榜单**；次数真值记在 `BossDamageEvent`（bossId=mapBossId）行数，
 *    内存 `bossQuota` 仅做在途闸；
 *  - 胜利经 `applyPlayReward` 发掉落（稀有材料 / 特殊道具），复用 `bossRewardGrant`
 *    唯一键幂等，零迁移、不动 `SCHEMA_VERSION`；
 *  - 禁捕获（MAPBOSS_UNCATCHABLE）、逃跑不上榜也不发奖。
 *
 * 写档顺序（与 F02 / F14 同范式，不可颠倒）：唯一键占位 → readSave → applyPlayReward
 * → 同步 authority.expected → commitState → 回填 revision。发放失败只记日志、不阻断结算。
 */
import { prisma } from '../lib/prisma';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { digestOf, type AuthorityState } from '../lib/authority';
import { readSave } from './saveRead';
import { commitState } from './session';
import { battles, bossQuota } from './sessionBus';
import { createBattle, battleView, type BattleState } from '../game/battle';
import { THEME_TABLE } from '../game/content';
import {
  MAP_BOSS_IDS, MAP_BOSSES, getMapBoss, mapBossDailyLimit, mapBossDayKey,
  mapBossQuotaKey, createMapBossEnemy, mapBossView,
} from '../game/mapBosses';
import { unlockedLocations } from '../game/mapLock';
import { playRewardView, applyPlayReward } from '../game/playReward';
import type { FastifyInstance, FastifyRequest } from 'fastify';

type MapBossResult<T> =
  | { ok: true; value: T }
  | { ok: false; code: string; message: string; status?: number };

function ok<T>(value: T): MapBossResult<T> { return { ok: true, value }; }
function fail<T>(code: string, message: string, status = 400): MapBossResult<T> {
  return { ok: false, code, message, status };
}

/** 该账号已解锁的城镇集合（由已持有徽章派生，服务端真值）。 */
async function ownedUnlockedLocations(userId: string): Promise<Set<string>> {
  const grants = await prisma.badgeGrant.findMany({
    where: { userId },
    select: { badgeId: true },
  });
  return unlockedLocations(grants.map((g) => g.badgeId));
}

/** 开局：服务端生成地图首领，占用一次在途名额（不扣次数，结算才扣）。 */
export async function applyMapBossStart(params: {
  userId: string;
  mapBossId: string;
  now?: number;
}): Promise<MapBossResult<Record<string, unknown>>> {
  const spec = getMapBoss(params.mapBossId);
  if (!spec) return fail('MAPBOSS_UNKNOWN', '未知的地图首领');

  return withSlotLock(slotLockKey(params.userId), () =>
    withSlotLock(mapBossLockKey(params.userId), async (): Promise<MapBossResult<Record<string, unknown>>> => {
      if (battles.current(params.userId)) {
        return fail('MAPBOSS_BATTLE_IN_PROGRESS', '已有进行中的战斗', 409);
      }
      const unlocked = await ownedUnlockedLocations(params.userId);
      if (!unlocked.has(spec.locationId)) {
        return fail('MAPBOSS_LOCKED', '该区域尚未解锁', 403);
      }
      const row = await readSave(params.userId);
      if (!row) return fail('MAPBOSS_NO_SAVE', '还没有存档', 404);
      let save: any;
      try {
        save = JSON.parse(row.raw);
      } catch {
        return fail('MAPBOSS_SAVE_UNREADABLE', '服务端存档不可用');
      }
      const party = Array.isArray(save?.party) ? save.party : [];
      if (party.length === 0) return fail('PARTY_EMPTY', '队伍为空，无法挑战');
      const aliveOne = party.some((m: any) => m && typeof m.hp === 'number' && m.hp > 0);
      if (!aliveOne) return fail('PARTY_FAINTED', '队伍中没有可战斗的幻兽');

      const limit = mapBossDailyLimit(spec);
      if (limit <= 0) return fail('MAPBOSS_QUOTA_EXHAUSTED', '挑战次数已关闭', 429);

      const now = params.now ?? Date.now();
      const dayKey = mapBossDayKey(now);
      const key = mapBossQuotaKey(params.userId, spec.mapBossId, dayKey);
      // 已用次数以 DB 事件为准：进程重启不会把次数重置。
      const used = await prisma.bossDamageEvent.count({
        where: { userId: params.userId, bossId: spec.mapBossId, periodKey: dayKey },
      });
      if (!bossQuota.hold(key, used, limit)) {
        return fail('MAPBOSS_QUOTA_EXHAUSTED', '今日挑战次数已用完', 429);
      }

      const battleId = `mb_${now.toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`;
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
          mapBoss: { spec, quotaKey: key },
        });
        battles.create(state);
        return {
          ok: true,
          value: {
            battle: battleView(state),
            mapBoss: mapBossView(spec, limit, true),
            quota: { limit, used, remaining: Math.max(0, limit - used - 1) },
            periodKey: dayKey,
            readonly: true,
          },
        };
      } catch (err) {
        bossQuota.release(key);
        if (err instanceof Error && (err as any).code) {
          return fail((err as any).code, err.message);
        }
        throw err;
      }
    }),
  );
}

/** 地图首领总览：每座首领的解锁态 / 每日余量（只读）。 */
export async function loadMapBossOverview(userId: string, now = Date.now()) {
  const dayKey = mapBossDayKey(now);
  const unlocked = await ownedUnlockedLocations(userId);
  const events = await prisma.bossDamageEvent.findMany({
    where: { userId, periodKey: dayKey },
    select: { bossId: true },
  });
  const bosses = MAP_BOSS_IDS.map((id) => {
    const spec = MAP_BOSSES[id];
    const limit = mapBossDailyLimit(spec);
    const used = events.filter((e) => e.bossId === id).length;
    const held = bossQuota.heldOf(mapBossQuotaKey(userId, id, dayKey));
    return {
      ...mapBossView(spec, limit, unlocked.has(spec.locationId)),
      used,
      held,
      remaining: Math.max(0, limit - used - held),
    };
  });
  return { ok: true, periodKey: dayKey, readonly: true, bosses };
}

/** 地图首领账本锁（与 bossq 锁顺序一致：账号锁 → 本锁，无死锁）。 */
function mapBossLockKey(userId: string): string {
  return `mapbossq:${userId}`;
}

/** 单场掉落发放；调用方已持有账号锁。复用 `bossRewardGrant` 表唯一键幂等。 */
async function grantMapBossDrop(p: {
  userId: string;
  mapBossId: string;
  battleId: string;
  drop: { money: number; items: Record<string, number> };
  nowIso: string;
}): Promise<'granted' | 'skipped' | 'failed'> {
  const { userId, mapBossId, battleId, drop, nowIso } = p;
  const grantKey = `mapboss:run:${battleId}`;
  const existing = await prisma.bossRewardGrant.findUnique({ where: { grantKey } });
  if (existing) return 'skipped';

  let recordId: number;
  try {
    const created = await prisma.bossRewardGrant.create({
      data: {
        userId,
        bossId: mapBossId,
        periodKey: mapBossDayKey(Date.now()),
        tier: 'per_run',
        grantKey,
        battleId,
        reward: JSON.stringify(playRewardView(drop)),
        revision: 0,
      },
    });
    recordId = created.id;
  } catch (e) {
    if (e && typeof e === 'object' && (e as { code?: string }).code === 'P2002') return 'skipped';
    throw e;
  }

  try {
    const row = await readSave(userId);
    if (!row) {
      await prisma.bossRewardGrant.delete({ where: { id: recordId } });
      return 'skipped';
    }
    const raw = applyPlayReward(row.raw, drop, nowIso);
    const authority: AuthorityState = {
      ...row.authority,
      expected: digestOf(raw),
      pending: null,
    };
    const committed = await commitState(userId, {
      data: raw,
      schemaVersion: row.schemaVersion,
      clientId: row.clientId,
      authority,
      source: 'action',
    });
    await prisma.bossRewardGrant.update({
      where: { id: recordId },
      data: { revision: committed.revision },
    });
    return 'granted';
  } catch {
    await prisma.bossRewardGrant.delete({ where: { id: recordId } }).catch(() => undefined);
    return 'failed';
  }
}

/**
 * 结算一场地图首领战。胜利插 `BossDamageEvent`（bossId=mapBossId，计数用）+
 * 经 `applyPlayReward` 发掉落；逃跑 / 全灭不发奖、不计数（已由调用方在 flee 分支释放 hold）。
 * 发奖失败只记日志，不阻断战斗结束响应（占位记录会删除，下次同场结算可补发）。
 */
export async function settleMapBossRun(req: FastifyRequest, userId: string, state: BattleState) {
  const mapBossId = state.mapBossId as string;
  const quotaKey = state.bossQuotaKey ?? null;
  const now = Date.now();
  const dayKey = mapBossDayKey(now);
  const damage = Math.max(0, Math.floor(state.damageDealt ?? 0));
  const spec = getMapBoss(mapBossId);

  if (state.result === 'fled') {
    if (quotaKey) bossQuota.release(quotaKey);
    const limit = spec ? mapBossDailyLimit(spec) : 0;
    return {
      mapBossId,
      periodKey: dayKey,
      recorded: false,
      reason: 'fled',
      quota: { limit, used: 0, remaining: limit },
      drop: null,
    };
  }

  let recorded = false;
  try {
    await prisma.bossDamageEvent.create({
      data: {
        userId,
        bossId: mapBossId,
        periodKey: dayKey,
        damage,
        result: String(state.result ?? 'unknown'),
        battleId: state.id,
      },
    });
    recorded = true;
  } catch (err: any) {
    // P2002 = battleId 已存在：同一场战斗重复结算，视为已记录，不叠加次数。
    if (err?.code !== 'P2002') {
      req.log.error({ event: 'mapboss_damage_persist_failed', userId, mapBossId, battleId: state.id, err },
        'map boss damage event insert failed');
    }
  }
  if (quotaKey) bossQuota.commit(quotaKey);

  const attempts = await prisma.bossDamageEvent.count({
    where: { userId, bossId: mapBossId, periodKey: dayKey },
  });
  const limit = spec ? mapBossDailyLimit(spec) : 0;

  let dropState: 'granted' | 'skipped' | 'failed' = 'skipped';
  if (state.result === 'enemy_fainted' && spec) {
    try {
      dropState = await grantMapBossDrop({
        userId,
        mapBossId,
        battleId: state.id,
        drop: spec.drop,
        nowIso: new Date(now).toISOString(),
      });
    } catch (e) {
      req.log.warn({ userId, mapBossId, battleId: state.id, err: String(e) }, '地图首领掉落发放失败（不阻断结算）');
    }
  }

  return {
    mapBossId,
    periodKey: dayKey,
    recorded,
    attempts,
    quota: { limit, used: attempts, remaining: Math.max(0, limit - attempts) },
    drop: dropState === 'granted' && spec ? playRewardView(spec.drop) : null,
  };
}

export async function mapBossRoutes(fastify: FastifyInstance): Promise<void> {
  const guard = { preHandler: fastify.authenticate };

  /** 地图首领总览（只读）。 */
  fastify.get('/api/mapboss', guard, async (req: any, reply) => {
    return reply.send(await loadMapBossOverview(req.user.userId));
  });

  /** 开局：服务端生成地图首领，占用一次在途名额。 */
  fastify.post('/api/mapboss/start', guard, async (req: any, reply) => {
    const body = req.body ?? {};
    const mapBossId = typeof body?.mapBossId === 'string' ? body.mapBossId : '';
    if (!mapBossId) {
      return reply.code(400).send({ error: '缺少 mapBossId', code: 'MAPBOSS_BAD_REQUEST' });
    }
    const res = await applyMapBossStart({ userId: req.user.userId, mapBossId });
    if ('code' in res) {
      return reply.code(res.status ?? 400).send({ error: res.message, code: res.code });
    }
    return reply.send({ ok: true, ...res.value });
  });
}
