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
import { parseAuthority, digestOf, type AuthorityState } from '../lib/authority';
import { BATTLE_TTL_MS } from '../lib/battleSession';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import {
  applyBattleAction, applyAdminTestFlags, battleView, BattleError, createBattle,
  type BattleAction, type BattleState,
} from '../game/battle';
import { LOCATIONS, THEME_TABLE, contentStats } from '../game/content';
import { encodeServerMessage } from '../lib/wsProtocol';
import { commitState } from './session';
import { broadcastToUser, gameSessions, battles } from './sessionBus';

const slotSchema = z.coerce.number().int().min(1).max(3).default(1);

const startSchema = z.object({
  slot: slotSchema,
  theme: z.string().min(1).max(40),
  areaName: z.string().min(1).max(60),
  areaId: z.string().min(1).max(60).nullish(),
  levelMin: z.coerce.number().int().min(1).max(60).default(1),
  levelMax: z.coerce.number().int().min(1).max(60).default(3),
  /**
   * P3-1c：管理员测试标记。普通账号传了也**静默忽略**（不报错、不封号），
   * 避免把「客户端硬编码了测试开关」这种误用升级成风控事件。
   */
  testFlags: z.object({
    testShiny: z.boolean().optional(),
    testMaxStats: z.boolean().optional(),
    testOHKO: z.boolean().optional(),
  }).optional(),
});

const actionSchema = z.object({
  battleId: z.string().min(1).max(80),
  slot: slotSchema,
  action: z.discriminatedUnion('type', [
    z.object({ type: z.literal('move'), moveId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('item'), itemId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('capture'), itemId: z.string().min(1).max(60) }),
    z.object({ type: z.literal('switch'), partyIndex: z.coerce.number().int().min(0).max(5) }),
    z.object({ type: z.literal('flee') }),
  ]),
});

type SaveRow = {
  raw: string;
  schemaVersion: string;
  clientId: string | null;
  authority: AuthorityState;
};

/** 在线时读内存权威态（最新），否则回库；两者都没有说明还没建号。 */
async function readSave(userId: string, slot: number): Promise<SaveRow | null> {
  const mem = gameSessions.get(userId, slot);
  if (mem) {
    return { raw: mem.data, schemaVersion: mem.schemaVersion, clientId: mem.clientId, authority: mem.authority };
  }
  const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
  if (!rec) return null;
  return {
    raw: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    authority: parseAuthority(rec.authority, rec.data),
  };
}

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/**
 * 把战斗结果写回存档：队伍 HP/经验、金钱、道具消耗、捕获入队、图鉴、首通记录。
 * 只信任服务端战斗态，不读客户端任何数值。
 */
function applySettlement(row: SaveRow, state: BattleState): string {
  let save: any;
  try {
    save = JSON.parse(row.raw);
  } catch {
    throw new BattleError('SAVE_UNREADABLE', '服务端存档不可用');
  }
  if (!save || typeof save !== 'object' || Array.isArray(save)) {
    throw new BattleError('SAVE_UNREADABLE', '服务端存档结构异常');
  }

  const next: any = { ...save };

  // 队伍：战斗内的 HP / 经验 / 等级 / 技能变化以服务端为准
  next.party = state.party;

  if (state.rewards) next.money = num(next.money) + state.rewards.moneyGain;

  if (Object.keys(state.consumed).length > 0) {
    const inv: Record<string, number> = { ...(next.inventory ?? {}) };
    for (const [itemId, used] of Object.entries(state.consumed)) {
      inv[itemId] = Math.max(0, num(inv[itemId]) - num(used));
    }
    next.inventory = inv;
  }

  // 图鉴：见过；捕获成功再记一次
  const seenId = state.enemy.specId;
  const seenPrev = next.collection?.[seenId] ?? {};
  next.collection = {
    ...(next.collection ?? {}),
    [seenId]: {
      seen: true,
      captured: seenPrev.captured ?? false,
      timesCaptured: num(seenPrev.timesCaptured),
      seenLocations: seenPrev.seenLocations,
    },
  };

  if (state.captured) {
    const party = Array.isArray(next.party) ? next.party.slice() : [];
    const box = Array.isArray(next.box) ? next.box.slice() : [];
    if (party.length < 6) party.push(state.captured);
    else box.push(state.captured);
    next.party = party;
    next.box = box;
    const prev = next.collection[seenId] ?? {};
    next.collection[seenId] = {
      seen: true,
      captured: true,
      timesCaptured: num(prev.timesCaptured) + 1,
      seenLocations: prev.seenLocations,
    };
  }

  // 首通：与前端 markAreaCleared 同规则（更高难度的区域才覆盖）
  if ((state.result === 'enemy_fainted' || state.result === 'captured') && state.areaId) {
    const prev = next.clearedAreas?.[state.areaId];
    if (!prev || prev.level < state.levelMax) {
      next.clearedAreas = {
        ...(next.clearedAreas ?? {}),
        [state.areaId]: {
          name: state.areaName,
          level: state.levelMax,
          theme: state.theme,
          clearedAt: new Date().toISOString(),
        },
      };
    }
  }

  // 全灭：送回最近的恢复点并回满。此前这是客户端 `leaveBattle` 里的本地逻辑——
  // 意味着「不点离开按钮」或「改客户端」就能避免惩罚，而且回满结果由客户端写进存档。
  // P3-2 起由服务端在结算时直接落档，客户端只负责关掉战斗界面。
  if (state.result === 'player_fainted') {
    const heal = typeof next.lastHealLocationId === 'string' && next.lastHealLocationId
      ? next.lastHealLocationId
      : next.locationId;
    next.party = (Array.isArray(next.party) ? next.party : []).map((m: any) => ({
      ...m,
      hp: m.maxHp,
      status: 'none',
    }));
    if (typeof heal === 'string' && heal) next.locationId = heal;
  }

  next.lastSavedAt = new Date().toISOString();
  return JSON.stringify(next);
}

function broadcastBattle(userId: string, slot: number, state: BattleState) {
  broadcastToUser(userId, encodeServerMessage({
    type: 'battle.state',
    slot,
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

export async function battleRoutes(fastify: FastifyInstance): Promise<void> {
  /** 开局：敌方由服务端生成，客户端只说明「在哪打」。 */
  fastify.post('/api/battle/start', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = startSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '开局参数不合法' });
    // 开局要拿队伍快照，与写操作串行，避免读到半途的存档。
    return withSlotLock(slotLockKey(userId, parsed.data.slot), () =>
      runBattleStart(reply, userId, parsed.data),
    );
  });

  /** 开局主体；调用方已持有槽位锁。 */
  async function runBattleStart(reply: FastifyReply, userId: string, params: z.infer<typeof startSchema>) {
    const { slot, theme, areaName, areaId, levelMin, levelMax, testFlags } = params;

    if (!THEME_TABLE[theme]) return reply.code(400).send({ error: '该区域没有可遭遇的幻兽' });

    const row = await readSave(userId, slot);
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

    try {
      const state = createBattle({
        id: `bt_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e9).toString(36)}`,
        userId,
        slot,
        theme: finalTheme,
        areaName: finalName,
        areaId: areaId ?? null,
        levelMin: lvMin,
        levelMax: lvMax,
        party,
        themes: THEME_TABLE,
        now: Date.now(),
        rng: Math.random,
      });
      // 测试标记只对管理员生效：身份由服务端查库判定，客户端自称不算数。
      // 只在客户端真的传了标记时才多查一次库，普通玩家开局没有额外开销。
      if (testFlags && Object.values(testFlags).some(Boolean)) {
        const me = await prisma.user.findUnique({ where: { id: userId }, select: { role: true } });
        if (me?.role === 'admin') applyAdminTestFlags(state, testFlags);
      }
      battles.create(state);
      return {
        ok: true,
        battle: battleView(state),
        content: contentStats(),
        ttlMs: BATTLE_TTL_MS,
      };
    } catch (err) {
      return fail(reply, err);
    }
  }

  /** 动作：服务端推进一回合；结束则结算写档并广播。 */
  fastify.post('/api/battle/action', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = actionSchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '动作参数不合法' });
    // 同一槽位串行：动作流程里有 await 读档，并发两条动作会各自基于同一份战斗态推进，
    // 结束判定还会重复结算写档。与 PUT / 存档写操作共用同一把槽位锁。
    return withSlotLock(slotLockKey(userId, parsed.data.slot), () =>
      runBattleAction(req, reply, userId, parsed.data),
    );
  });

  /** 动作主体；调用方已持有槽位锁。 */
  async function runBattleAction(
    req: FastifyRequest,
    reply: FastifyReply,
    userId: string,
    params: z.infer<typeof actionSchema>,
  ) {
    const { battleId, slot, action } = params;

    const state = battles.get(userId, slot, battleId);
    if (!state) return reply.code(404).send({ error: '战斗不存在或已结束', code: 'BATTLE_NOT_FOUND' });
    if (state.actions > 500) return reply.code(429).send({ error: '战斗回合过多，请重新开局' });

    const row = await readSave(userId, slot);
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
    broadcastBattle(userId, slot, next);

    // 结束：服务端结算写档（这一步之后客户端再 PUT 也只能与原档一致）
    if (next.finished) {
      try {
        const raw = applySettlement(row, next);
        const authority: AuthorityState = {
          ...row.authority,
          expected: digestOf(raw),
          revision: row.authority.revision + 1,
          pending: null,
        };
        const committed = await commitState(userId, slot, {
          data: raw,
          schemaVersion: row.schemaVersion,
          clientId: row.clientId,
          authority,
          source: 'battle',
        });
        battles.drop(userId, slot);
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
    const slot = slotSchema.safeParse((req.query as any)?.slot ?? 1);
    if (!slot.success) return reply.code(400).send({ error: 'slot 必须是 1/2/3' });
    const state = battles.current(userId, slot.data);
    if (!state) return { ok: true, battle: null };
    return { ok: true, battle: battleView(state) };
  });

  /** 放弃战斗：不结算奖励，仅丢弃会话（撤离走 action.type='flee' 才有成功率）。 */
  fastify.post('/api/battle/abandon', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = z.object({ battleId: z.string().min(1).max(80), slot: slotSchema }).safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '参数不合法' });
    const state = battles.get(userId, parsed.data.slot, parsed.data.battleId);
    if (!state) return reply.code(404).send({ error: '战斗不存在', code: 'BATTLE_NOT_FOUND' });
    battles.drop(userId, parsed.data.slot);
    return { ok: true, dropped: true };
  });
}
