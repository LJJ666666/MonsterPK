/**
 * 服务端存档写操作接口（P3-2 瘦终端）。
 *
 * `POST /api/game/:op` —— 客户端只发意图 ID，服务端查内容表判定、自己算、自己落库，
 * 然后把新存档整包返回（同时由 `commitState` 广播 `session.state` 给该账号所有连接）。
 *
 * 与 P1-2 `POST /api/actions/:type` 的区别：
 *   · `actions` 是「客户端算完 → 服务端核对增量」，一次性授权 + nonce + 精确增量比对；
 *   · 本模块是「服务端算完 → 客户端收结果」，没有非对称的中间态，也不需要 nonce。
 * 战斗（`/api/battle/*`）已按同样思路收口，两者共用 `commitState` 这个唯一写入口。
 *
 * 拒绝策略：全部是 400 + 业务码，不封号——玩家点错按钮和服务端判定不符不是作弊。
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { LOCATIONS } from '../game/content';
import { readBadgeIds } from './playerProgress';
import { isLocationUnlocked, requiredBadgeFor } from '../game/mapLock';
import { parseAuthority, digestOf, freshAuthority, type AuthorityState } from '../lib/authority';
import { MUTATION_OPS, applyMutation, createNewSave, MutationError, type MutationOp } from '../game/mutations';
import { EXPECTED_SAVE_VERSION } from '../lib/saveValidator';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { commitState } from './session';
import { isSessionStale } from '../lib/sessionRevision';
import { battles, gameSessions } from './sessionBus';

const bodySchema = z.object({
  itemId: z.string().min(1).max(60).optional(),
  monsterId: z.string().min(1).max(80).optional(),
  partyIndex: z.coerce.number().int().min(0).max(5).optional(),
  boxIndex: z.coerce.number().int().min(0).max(999).optional(),
  accept: z.boolean().optional(),
  oldMoveId: z.string().max(60).nullish(),
  newMoveId: z.string().min(1).max(60).optional(),
  discard: z.boolean().optional(),
  locationId: z.string().min(1).max(60).optional(),
  // new_game 专用
  playerName: z.string().min(1).max(12).optional(),
  starterSpecId: z.string().min(1).max(40).optional(),
  overwrite: z.boolean().optional(),
}).strip();

type SaveRow = {
  raw: string;
  schemaVersion: string;
  clientId: string | null;
  authority: AuthorityState;
};

async function readSave(userId: string): Promise<SaveRow | null> {
  const mem = gameSessions.get(userId);
  // W8.2：与 `saveRead.ts::readSave` 同口径——内存副本落后就回库。
  if (mem && !(await isSessionStale(userId, mem.authority.revision))) {
    return { raw: mem.data, schemaVersion: mem.schemaVersion, clientId: mem.clientId, authority: mem.authority };
  }
  const rec = await prisma.save.findUnique({ where: { userId } });
  if (!rec) return null;
  return {
    raw: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    authority: parseAuthority(rec.authority, rec.data),
  };
}

function fail(reply: FastifyReply, err: unknown) {
  if (err instanceof MutationError) {
    return reply.code(400).send({ error: err.message, code: err.code });
  }
  throw err;
}

export async function gameRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.post('/api/game/:op', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const opRaw = String((req.params as any).op ?? '');
    // new_game 走同一入口但不属于「对已有存档的修改」，单独分支处理。
    if (opRaw !== 'new_game' && !MUTATION_OPS.includes(opRaw as MutationOp)) {
      return reply.code(400).send({ error: '未知的操作', code: 'OP_UNKNOWN' });
    }
    const parsed = bodySchema.safeParse(req.body ?? {});
    if (!parsed.success) return reply.code(400).send({ error: '请求参数不正确', code: 'BAD_REQUEST' });

    // 账号单档的「读档 → 判定 → 写档」必须串行：这一段里有 await（读库 / commitState 落库），
    // 并发请求能各自读到同一份旧档再分别写回，后落库的一方静默覆盖前一方。
    // 与 PUT / 意图的 CAS 属同一类竞态，共用同一把账号锁。
    return withSlotLock(slotLockKey(userId), () =>
      handleGameOp(req, reply, userId, opRaw, parsed.data),
    );
  });
}

/** 写操作主体；调用方已持有该账号的互斥锁。 */
async function handleGameOp(
  req: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  opRaw: string,
  body: z.infer<typeof bodySchema>,
) {

    // —— P3-2b：新档由服务端生成（客户端不再自己掷初始幻兽）——
    if (opRaw === 'new_game') {
      const battle = await battles.current(userId);
      if (battle && !battle.finished) {
        return reply.code(400).send({ error: '战斗进行中，无法创建新档', code: 'BATTLE_IN_PROGRESS' });
      }
      const existing = await prisma.save.findUnique({ where: { userId } });
      if (existing && body.overwrite !== true) {
        return reply.code(409).send({ error: '已存在存档', code: 'SAVE_EXISTS' });
      }
      try {
        const save = createNewSave(
          { playerName: body.playerName, starterSpecId: body.starterSpecId },
          { rng: Math.random, schemaVersion: String(EXPECTED_SAVE_VERSION), nowIso: new Date().toISOString() },
        );
        const raw = JSON.stringify(save);
        const committed = await commitState(userId, {
          data: raw,
          schemaVersion: String(EXPECTED_SAVE_VERSION),
          clientId: null,
          authority: freshAuthority(raw),
          source: 'action',
        });
        req.log.info({ userId, starter: body.starterSpecId }, '服务端已生成新档');
        return { ok: true, op: opRaw, revision: committed.revision, data: raw };
      } catch (err) {
        return fail(reply, err);
      }
    }

    // 战斗进行中不允许动存档：治疗/换道具会绕过服务端战斗的 HP 真值。
    const battle = await battles.current(userId);
    if (battle && !battle.finished) {
      return reply.code(400).send({ error: '战斗进行中，无法执行该操作', code: 'BATTLE_IN_PROGRESS' });
    }

    const row = await readSave(userId);
    if (!row) return reply.code(404).send({ error: '还没有存档，请先开始游戏', code: 'SAVE_NOT_FOUND' });

    // F18-a 地图锁：travel 前置校验（服务端权威，基于 BadgeGrant 真值派生解锁集合）。
    // 未知地点交下游 applyMutation 抛 LOCATION_UNKNOWN；这里只拦「已知但未解锁」的跳转。
    if (opRaw === 'travel') {
      const target = String(body.locationId ?? '');
      if (LOCATIONS[target]) {
        const badgeIds = await readBadgeIds(userId);
        if (!isLocationUnlocked(target, badgeIds)) {
          return reply.code(400).send({
            error: '该地区尚未解锁',
            code: 'LOCATION_LOCKED',
            locationId: target,
            requiredBadge: requiredBadgeFor(target),
          });
        }
      }
    }

    let save: any;
    try {
      save = JSON.parse(row.raw);
    } catch {
      return reply.code(400).send({ error: '服务端存档不可用', code: 'SAVE_UNREADABLE' });
    }

    const op = opRaw as MutationOp;
    try {
      const result = applyMutation(op, save, body);
      const raw = JSON.stringify(result.save);
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
      req.log.info({ userId, op, code: 'ok' }, '服务端存档写操作已生效');
      return {
        ok: true,
        op,
        revision: committed.revision,
        data: raw,
        effect: result.effect,
      };
    } catch (err) {
      req.log.info({ userId, op, code: (err as any)?.code }, '服务端存档写操作被拒绝');
      return fail(reply, err);
    }
}
