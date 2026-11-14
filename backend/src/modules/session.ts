/**
 * 在线会话装配（P2-2 / W2）：DB ↔ 内存只读缓存、服务端写入唯一入口、快照广播。
 *
 * W2 起 `Save.revision` 列是版本号的唯一 +1 源：commitState 用条件 UPDATE 裁决，
 * 内存权威态降级为「只读缓存 + 失效广播」，不参与 CAS、不自己递增 version。
 * 客户端不能通过 WS 写状态——上行只有 ping / session.resync（请求重推）。
 */
import type { FastifyInstance } from 'fastify';
import { roomDb, onRoomCommit } from '../lib/roomUnitOfWork';
import { parseAuthority, serializeAuthority, type AuthorityState } from '../lib/authority';
import { buildSnapshot, type SessionSource, type SessionSnapshot } from '../lib/gameSession';
import {
  casWriteSave, RevisionConflictError,
  type SaveCasPatch, type SaveCasRow, type SaveCasStore,
} from '../lib/saveCas';
import { encodeServerMessage } from '../lib/wsProtocol';
import { publishSessionRevision } from '../lib/sessionRevision';
import { gameSessions, broadcastToUser, getSessionStats } from './sessionBus';

export { RevisionConflictError } from '../lib/saveCas';

/** 连接建立时从 DB 恢复该用户的账号单档权威态，并返回要推给这条连接的快照。 */
export async function hydrateForUser(userId: string, connectionId: string): Promise<SessionSnapshot[]> {
  const rec = await roomDb().save.findUnique({ where: { userId } });
  const state = gameSessions.hydrate(
    userId,
    rec
      ? {
          data: rec.data,
          schemaVersion: rec.schemaVersion,
          clientId: rec.clientId,
          // W2：DB 列是真值，authority JSON 里的 revision 只是下行镜像，以列为准。
          authority: { ...parseAuthority(rec.authority, rec.data), revision: rec.revision },
          updatedAt: new Date(rec.updatedAt).getTime(),
        }
      : null,
  );
  if (!state) return [];
  state.connections.add(connectionId);
  state.source = 'hydrate';
  return [buildSnapshot(state)];
}

/** 断线：把该连接从所有会话的在线登记里摘掉（会话本身按 TTL 保留）。 */
export function detachConnection(connectionId: string): void {
  gameSessions.detach(connectionId);
}

/** 封号 / 登出：立刻丢弃该用户的在线权威态（只读缓存，DB 不受影响）。 */
export function dropUserSessions(userId: string): number {
  return gameSessions.dropUser(userId);
}

/** 心跳扫描顺带回收空会话。 */
export function sweepSessions(now: number): number {
  return gameSessions.sweep(now);
}

/** 当前写入版本号的只读视图（W2：只认 DB 列，无存档视为 null）。 */
export type CurrentState = {
  revision: number;
  data: string;
  schemaVersion: string;
  clientId: string | null;
  updatedAt: number;
};

/**
 * 读取账号单档「服务端当前版本」。W2 起只读 DB 列——内存态可能滞后于其它实例，
 * 让它参与 CAS 会把旧版本当基线，正是 W1 之前跨实例分叉的根因。
 * 只读、不 hydrate，避免冲突探测凭空建会话。
 */
export async function currentState(userId: string): Promise<CurrentState | null> {
  const rec = await roomDb().save.findUnique({ where: { userId } });
  if (!rec) return null;
  return {
    revision: rec.revision,
    data: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    updatedAt: new Date(rec.updatedAt).getTime(),
  };
}

/** Prisma 适配成可注入的 CAS store；唯一 +1 由 updateMany 的 where 条件保证。 */
function prismaSaveCasStore(): SaveCasStore {
  const toRow = (rec: {
    revision: number; data: string; schemaVersion: string;
    clientId: string | null; updatedAt: Date;
  }): SaveCasRow => ({
    revision: rec.revision,
    data: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    updatedAt: new Date(rec.updatedAt),
  });

  return {
    async find(userId) {
      const rec = await roomDb().save.findUnique({ where: { userId } });
      return rec ? toRow(rec) : null;
    },
    async updateIfRevision(userId, baseRevision, write) {
      const res = await roomDb().save.updateMany({
        where: { userId, revision: baseRevision },
        data: {
          data: write.data,
          schemaVersion: write.schemaVersion,
          clientId: write.clientId,
          authority: write.authority,
          updatedAt: write.updatedAt,
          revision: write.revision,
        },
      });
      return res.count;
    },
    async create(userId, write) {
      await roomDb().save.create({
        data: {
          userId,
          data: write.data,
          schemaVersion: write.schemaVersion,
          clientId: write.clientId,
          authority: write.authority,
          updatedAt: write.updatedAt,
          revision: write.revision,
        },
      });
    },
  };
}

/**
 * 服务端写入唯一入口：DB 条件更新 → 更新内存只读缓存 → 广播快照。
 *
 * `baseRevision` 必须来自 `readRevision()`（即快速拒绝时读到的 DB 列值），
 * 且**不能用重读的当前值替代**：若并发写把列推高，重读会让基于旧版的客户端写入
 * 意外覆盖新版；条件未命中才应由调用方转成 409，让客户端拉回新版重放。
 *
 * 服务端内部写（发奖 / 战斗结算）没有客户端版本声明，可省略 baseRevision：
 * 此时读 DB 当前列作基线，条件未命中最多重读重试 2 次（它只是要追加一版，
 * 不会覆盖别人的写入）；仍失败才抛冲突，绝不静默覆盖。
 *
 * 冲突（含首档 create 的 P2002）一律抛 RevisionConflictError，
 * 且在抛错前**不 apply 内存、不广播**。
 */
export async function commitState(
  userId: string,
  input: {
    data: string;
    schemaVersion: string;
    clientId: string | null;
    authority: AuthorityState;
    source: SessionSource;
    /** 客户端 CAS 写必传；服务端内部写可省略。 */
    baseRevision?: number;
  },
): Promise<{
  saved: { updatedAt: Date; clientId: string | null; schemaVersion: string };
  revision: number;
}> {
  const store = prismaSaveCasStore();
  const strict = typeof input.baseRevision === 'number';
  const attempts = strict ? 1 : 3;
  let baseRevision = input.baseRevision;

  for (let attempt = 0; attempt < attempts; attempt += 1) {
    if (typeof baseRevision !== 'number') {
      const row = await store.find(userId);
      baseRevision = row?.revision ?? 0;
    }
    const nextRevision = baseRevision + 1;
    const patch: SaveCasPatch = {
      data: input.data,
      schemaVersion: input.schemaVersion,
      clientId: input.clientId,
      authority: serializeAuthority({ ...input.authority, revision: nextRevision }),
      updatedAt: new Date(),
    };

    try {
      await casWriteSave(store, { userId, baseRevision, write: patch });
    } catch (err) {
      if (err instanceof RevisionConflictError && !strict && attempt + 1 < attempts) {
        baseRevision = undefined; // 下一轮重读 DB 当前列
        continue;
      }
      throw err;
    }

    const saved = {
      updatedAt: patch.updatedAt,
      clientId: input.clientId,
      schemaVersion: input.schemaVersion,
    };
    // W6.2：内存权威态与 WS 广播属于「提交后副作用」。放在事务内执行会在回滚时
    // 污染内存 / 让客户端看到不存在的状态，故统一挂到工作单元的 after-commit 钩子。
    onRoomCommit(() => {
      const state = gameSessions.apply(userId, {
        data: input.data,
        schemaVersion: input.schemaVersion,
        clientId: input.clientId,
        authority: { ...input.authority, revision: nextRevision },
        source: input.source,
        updatedAt: patch.updatedAt.getTime(),
      });
      // 广播给该账号所有在线连接（含发起端；前端用 revision 幂等忽略自己的回显）。
      broadcastToUser(userId, encodeServerMessage(buildSnapshot(state)));
      // W8.2：把最新 revision 写到共享戳，让其它实例的内存副本能被判为「落后」。
      // 挂在 after-commit 钩子里：事务回滚时戳不该前进（否则别的实例会反复回源）。
      // fire-and-forget：写戳失败不影响本次提交（读档路径会退化成多读一次 DB）。
      void publishSessionRevision(userId, nextRevision);
    });
    return { saved, revision: nextRevision };
  }

  throw new RevisionConflictError(await store.find(userId));
}

/** 只读在线状态：联调 / E2E 用来确认会话已 hydrate、连接已登记。 */
export async function sessionRoutes(fastify: FastifyInstance): Promise<void> {
  fastify.get('/api/session', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const s = gameSessions.get(userId);
    return {
      ok: true,
      online: !!s && s.connections.size > 0,
      revision: s?.authority.revision ?? null,
      updatedAt: s ? new Date(s.updatedAt).toISOString() : null,
      connections: s?.connections.size ?? 0,
      source: s?.source ?? null,
      stats: getSessionStats(),
    };
  });
}
