/**
 * 实时通道装配（P2-1）：把 WebSocket 挂在 Fastify 底层 HTTP server 的 upgrade 上。
 *
 * 为什么不用 @fastify/websocket 插件：浏览器原生 WebSocket 不能自定义 Authorization header，
 * JWT 只能放 query；而「未授权拒连」最干净的实现是在 **HTTP upgrade 阶段** 就写回 401/403，
 * 而不是先建立连接再关掉。直接持有 upgrade 事件可以完全控制握手响应与状态码。
 *
 * 安全要点：
 *  1) Origin 白名单（防跨站 WebSocket 劫持 CSWSH）；
 *  2) JWT 验签 + 实时查库判断账号存在 / 封号（封号必须即时生效，不能等旧 token 过期）；
 *  3) 单账号连接数上限、单条消息长度上限、单连接速率限制；
 *  4) 底层 ping/pong 心跳 + 死连接清理；心跳扫描顺带复查会话期封号。
 *
 * P2-1 只建通道，不承载任何游戏状态；业务消息与状态广播留到 P2-2 GameSession。
 */
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData } from 'ws';
import { prisma } from '../lib/prisma';
import { getAccountState, BAN_CODE } from '../lib/account';
import { WsRegistry, type WsConnection, type WsLike } from '../lib/wsRegistry';
import {
  WS_PROTOCOL_VERSION,
  WS_HEARTBEAT_MS,
  WS_MAX_MESSAGE_BYTES,
  WS_RATE_WINDOW_MS,
  WS_RATE_MAX_MESSAGES,
  extractWsToken,
  isWsUpgradePath,
  isOriginAllowed,
  parseClientMessage,
  encodeServerMessage,
  buildRejectResponse,
  deadAfterMs,
} from '../lib/wsProtocol';

/** 进程级单例：health 接口与后续 P2-2 广播都从这里读在线状态。 */
const registry = new WsRegistry();

export function getRealtimeStats(): { connections: number; users: number } {
  return { connections: registry.size, users: registry.userCount };
}

/** 心跳周期可由 .env 覆盖（便于联调），但钳制在 5s~120s，防止配置失误打爆服务。 */
function heartbeatIntervalMs(): number {
  const raw = Number(process.env.WS_HEARTBEAT_MS ?? WS_HEARTBEAT_MS);
  if (!Number.isFinite(raw)) return WS_HEARTBEAT_MS;
  return Math.min(Math.max(raw, 5_000), 120_000);
}

export function registerRealtime(fastify: FastifyInstance): void {
  const heartbeatMs = heartbeatIntervalMs();
  const wss = new WebSocketServer({ noServer: true, maxPayload: WS_MAX_MESSAGE_BYTES });

  /** upgrade 阶段拒绝：手写 HTTP 响应，让客户端拿到明确的 401/403/429 与机器码。 */
  function reject(
    socket: Duplex,
    status: number,
    code: string,
    reason: string,
    userId?: string,
  ): void {
    fastify.log.warn({ event: 'ws_rejected', status, code, userId }, reason);
    try {
      // 用 end(data) 一次性写完再关闭：write 后立刻 destroy 可能丢掉尚未 flush 的响应体，
      // 客户端就只能看到断连、拿不到 401/403 的机器码。
      socket.end(buildRejectResponse(status, { error: reason, code }));
    } catch {
      socket.destroy();
    }
  }

  fastify.server.on('upgrade', (req, socket, head) => {
    if (!isWsUpgradePath(req.url)) {
      // 目前没有别的 upgrade handler；非 /ws 直接断开，避免请求一直挂起。
      // 将来若引入第二个 upgrade 监听器，这里让位给它处理。
      if (fastify.server.listenerCount('upgrade') <= 1) socket.destroy();
      return;
    }

    void (async () => {
      try {
        const allowedOrigin = process.env.CORS_ORIGIN ?? 'http://localhost:5173';
        if (!isOriginAllowed(req.headers.origin, allowedOrigin)) {
          return reject(socket, 403, 'ORIGIN_DENIED', '连接来源不被允许');
        }

        const token = extractWsToken(req.url);
        if (!token) {
          return reject(socket, 401, 'UNAUTHORIZED', '未登录或登录已过期');
        }

        let payload: any;
        try {
          payload = (fastify.jwt as any).verify(token);
        } catch {
          return reject(socket, 401, 'UNAUTHORIZED', '未登录或登录已过期');
        }
        const userId: unknown = payload?.userId;
        if (!userId || typeof userId !== 'string') {
          return reject(socket, 401, 'UNAUTHORIZED', '未登录或登录已过期');
        }

        // 与 HTTP 认证守卫同一口径：实时查库，封号立刻生效。
        const state = await getAccountState(userId);
        if (!state.exists) {
          return reject(socket, 401, 'UNAUTHORIZED', '账号不存在或已被删除', userId);
        }
        if (state.banned) {
          return reject(socket, 403, BAN_CODE, state.banReason ?? '你已被封号', userId);
        }
        if (!registry.canAccept(userId)) {
          return reject(socket, 429, 'TOO_MANY_CONNECTIONS', '同一账号连接数过多', userId);
        }

        wss.handleUpgrade(req, socket, head, (ws) => onConnected(fastify, ws, userId, heartbeatMs));
      } catch (err) {
        fastify.log.error({ event: 'ws_upgrade_error', err }, 'ws upgrade failed');
        reject(socket, 500, 'INTERNAL', '服务器内部错误');
      }
    })();
  });

  // —— 心跳扫描：死连接清理 + 会话期封号复查 ——
  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      for (const c of registry.findStale(now, deadAfterMs(heartbeatMs))) {
        fastify.log.warn(
          { event: 'ws_dead', userId: c.userId, connectionId: c.id },
          'ws heartbeat timeout',
        );
        try {
          c.socket.terminate();
        } catch {
          // 已断开
        }
        registry.remove(c.id);
      }
      for (const c of registry.all()) {
        c.alive = false;
        try {
          c.socket.ping();
        } catch {
          // 已断开，交给 close 事件注销
        }
      }

      // 账号可能在连接建立之后才被封（HTTP 侧改档触发）；一次批量查询即可踢掉。
      const userIds = Array.from(new Set(registry.all().map((c) => c.userId)));
      if (userIds.length === 0) return;
      try {
        const banned = await prisma.user.findMany({
          where: { id: { in: userIds }, bannedAt: { not: null } },
          select: { id: true, banReason: true },
        });
        for (const u of banned) {
          for (const c of registry.listForUser(u.id)) {
            try {
              c.socket.send(
                encodeServerMessage({
                  type: 'bye',
                  code: BAN_CODE,
                  reason: u.banReason ?? '你已被封号',
                }),
              );
              c.socket.close(1008, BAN_CODE);
            } catch {
              // 已断开
            }
            registry.remove(c.id);
          }
        }
      } catch (err) {
        fastify.log.error({ event: 'ws_ban_sweep_error', err }, 'ws ban sweep failed');
      }
    })();
  }, heartbeatMs);
  timer.unref?.();

  fastify.addHook('onClose', async () => {
    clearInterval(timer);
    for (const c of registry.all()) {
      try {
        c.socket.send(encodeServerMessage({ type: 'bye', reason: '服务器正在关闭' }));
        c.socket.close(1001, 'server closing');
      } catch {
        // 已断开
      }
    }
    registry.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}

/** 单条连接建立后的消息循环（控制协议，不含业务状态）。 */
function onConnected(
  fastify: FastifyInstance,
  ws: any,
  userId: string,
  heartbeatMs: number,
): void {
  const now = Date.now();
  const conn: WsConnection = {
    id: randomUUID(),
    userId,
    socket: ws as WsLike,
    connectedAt: now,
    lastSeenAt: now,
    alive: true,
  };
  if (!registry.add(conn)) {
    // 竞态：握手查过上限，但同一账号另一个连接刚好先插入
    ws.close(1008, 'too many connections');
    return;
  }

  ws.send(
    encodeServerMessage({
      type: 'hello',
      protocol: WS_PROTOCOL_VERSION,
      connectionId: conn.id,
      userId,
      serverTime: now,
      heartbeatMs,
    }),
  );
  fastify.log.info(
    { event: 'ws_connected', userId, connectionId: conn.id },
    'ws connected',
  );

  let windowStart = now;
  let windowCount = 0;

  ws.on('pong', () => {
    conn.alive = true;
    conn.lastSeenAt = Date.now();
  });

  ws.on('message', (raw: RawData) => {
    const t = Date.now();
    if (t - windowStart >= WS_RATE_WINDOW_MS) {
      windowStart = t;
      windowCount = 0;
    }
    windowCount += 1;
    if (windowCount > WS_RATE_MAX_MESSAGES) {
      fastify.log.warn(
        { event: 'ws_rate_limited', userId, connectionId: conn.id },
        'ws rate limited',
      );
      ws.send(encodeServerMessage({ type: 'error', code: 'RATE_LIMITED', reason: '消息过于频繁' }));
      ws.close(1008, 'rate limited');
      return;
    }

    // ws 的 RawData 可能是 Buffer / ArrayBuffer / Buffer[]，统一转成字符串再交给纯函数。
    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.from(raw).toString('utf8');
    const parsed = parseClientMessage(text);
    // 用属性存在性收窄：本项目 strict:false（strictNullChecks 关闭），
    // 对 `if (!parsed.ok)` 的判别联合收窄会失效，TS 会报 code/reason 不存在。
    // 与 P1-1 里 zod 联合类型改用 assert 抛错是同一类坑（见 bug_log §18）。
    if ('code' in parsed) {
      ws.send(encodeServerMessage({ type: 'error', code: parsed.code, reason: parsed.reason }));
      ws.close(1008, parsed.code);
      return;
    }

    conn.alive = true;
    conn.lastSeenAt = t;
    ws.send(
      encodeServerMessage({
        type: 'pong',
        serverTime: t,
        ...(parsed.message.ts !== undefined ? { echo: parsed.message.ts } : {}),
      }),
    );
  });

  ws.on('close', () => {
    registry.remove(conn.id);
    fastify.log.info(
      { event: 'ws_closed', userId, connectionId: conn.id },
      'ws closed',
    );
  });
  ws.on('error', () => {
    // close 事件会紧随，注销统一放在 close 里，避免重复移除
  });
}
