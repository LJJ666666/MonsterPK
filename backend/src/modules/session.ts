/**
 * 在线会话装配（P2-2）：DB ↔ 内存权威态、服务端写入唯一入口、快照广播、在线状态查询。
 *
 * 与 P1-2 的关系：裁决逻辑不变，只是把「裁决 / 整包 PUT 成功后写库」这一步收敛到
 * commitState()，让内存态与 DB 同步更新，并把新快照推给同账号的其它连接。
 * 客户端不能通过 WS 写状态——上行只有 ping / session.resync（请求重推），没有 state 写入。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { parseAuthority, serializeAuthority, type AuthorityState } from '../lib/authority';
import {
  buildSnapshot, monotonicAuthority, SESSION_SLOTS,
  type SessionSource, type SessionSnapshot,
} from '../lib/gameSession';
import { encodeServerMessage } from '../lib/wsProtocol';
import { gameSessions, broadcastToUser, getSessionStats } from './sessionBus';

const querySchema = z.object({
  slot: z.coerce.number().int().min(1).max(3).default(1),
});

/** 连接建立时从 DB 恢复该用户三个槽位的权威态，并返回要推给这条连接的快照。 */
export async function hydrateForUser(userId: string, connectionId: string): Promise<SessionSnapshot[]> {
  const out: SessionSnapshot[] = [];
  for (const slot of SESSION_SLOTS) {
    const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
    const state = gameSessions.hydrate(
      userId,
      slot,
      rec
        ? {
            data: rec.data,
            schemaVersion: rec.schemaVersion,
            clientId: rec.clientId,
            authority: parseAuthority(rec.authority, rec.data),
            updatedAt: new Date(rec.updatedAt).getTime(),
          }
        : null,
    );
    if (!state) continue;
    state.connections.add(connectionId);
    state.source = 'hydrate';
    out.push(buildSnapshot(state));
  }
  return out;
}

/** 断线：把该连接从所有会话的在线登记里摘掉（会话本身按 TTL 保留）。 */
export function detachConnection(connectionId: string): void {
  gameSessions.detach(connectionId);
}

/** 封号 / 登出：立刻丢弃该用户的在线权威态。 */
export function dropUserSessions(userId: string): number {
  return gameSessions.dropUser(userId);
}

/** 心跳扫描顺带回收空会话。 */
export function sweepSessions(now: number): number {
  return gameSessions.sweep(now);
}

/** 当前写入版本号的只读视图（内存权威态优先，回落 DB，无存档视为 0）。 */
export type CurrentState = {
  revision: number;
  data: string;
  schemaVersion: string;
  clientId: string | null;
  updatedAt: number;
};

/**
 * 读取某槽位「服务端当前版本」。P4 的 CAS 校验用它做基准：
 * 在线以内存权威态为准（那就是最后写入的值），离线回 DB，完全没有存档时为 null。
 *
 * 注意：这里不 hydrate 会话——只读校验不该产生副作用，
 * 否则每次冲突探测都会在内存里凭空建出一个会话来。
 */
export async function currentState(userId: string, slot: number): Promise<CurrentState | null> {
  const live = gameSessions.get(userId, slot);
  if (live) {
    return {
      revision: live.authority.revision,
      data: live.data,
      schemaVersion: live.schemaVersion,
      clientId: live.clientId,
      updatedAt: live.updatedAt,
    };
  }
  const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
  if (!rec) return null;
  return {
    revision: parseAuthority(rec.authority, rec.data).revision,
    data: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    updatedAt: new Date(rec.updatedAt).getTime(),
  };
}


/**
 * 服务端写入唯一入口：DB upsert → 更新内存态（revision 单调）→ 广播快照。
 * save.ts / actions.ts 都改调这里，保证「在线权威态」与 DB 永不脱节。
 */
export async function commitState(
  userId: string,
  slot: number,
  input: {
    data: string;
    schemaVersion: string;
    clientId: string | null;
    authority: AuthorityState;
    source: SessionSource;
  },
): Promise<{
  saved: { updatedAt: Date; clientId: string | null; schemaVersion: string };
  revision: number;
}> {
  const authority = monotonicAuthority(gameSessions.get(userId, slot)?.authority, input.authority);
  const authText = serializeAuthority(authority);
  const saved = await prisma.save.upsert({
    where: { userId_slot: { userId, slot } },
    create: {
      userId, slot,
      data: input.data,
      schemaVersion: input.schemaVersion,
      clientId: input.clientId,
      authority: authText,
    },
    update: {
      data: input.data,
      schemaVersion: input.schemaVersion,
      clientId: input.clientId,
      authority: authText,
    },
  });
  const state = gameSessions.apply(userId, slot, {
    ...input,
    authority,
    updatedAt: new Date(saved.updatedAt).getTime(),
  });
  // 广播给该账号所有在线连接（含发起端；前端用 revision 幂等忽略自己的回显）。
  broadcastToUser(userId, encodeServerMessage(buildSnapshot(state)));
  return { saved, revision: authority.revision };
}

/** 只读在线状态：联调 / E2E 用来确认会话已 hydrate、连接已登记。 */
export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/session', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'slot 必须是 1/2/3' });
    const slot = parsed.data.slot;
    const s = gameSessions.get(userId, slot);
    return {
      ok: true,
      slot,
      online: !!s && s.connections.size > 0,
      revision: s?.authority.revision ?? null,
      updatedAt: s ? new Date(s.updatedAt).toISOString() : null,
      connections: s?.connections.size ?? 0,
      source: s?.source ?? null,
      stats: getSessionStats(),
    };
  });
}
