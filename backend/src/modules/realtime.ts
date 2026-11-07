/**
 * 实时通道装配（P2-1 建通道，P2-2 挂在线权威态）。
 *
 * 为什么不用 @fastify/websocket 插件：浏览器原生 WebSocket 不能自定义 Authorization header，
 * JWT 只能放 query；而「未授权拒连」最干净的实现是在 **HTTP upgrade 阶段** 就写回 401/403。
 *
 * 安全要点：
 *  1) Origin 白名单（防跨站 WebSocket 劫持 CSWSH）；
 *  2) JWT 验签 + 实时查库判断账号存在 / 封号（封号必须即时生效，不能等旧 token 过期）；
 *  3) 单账号连接数上限、单条上行消息长度上限、单连接速率限制；
 *  4) 底层 ping/pong 心跳 + 死连接清理；心跳扫描顺带复查会话期封号 + 回收空会话。
 *
 * P2-2：连接建立时 hydrate 该用户的在线权威态并推送 session.state 快照；
 * 状态写入统一走 modules/session.ts 的 commitState()，由它广播给所有在线连接。
 * 上行只有 ping / session.resync（请求重推），没有任何写状态入口。
 */
import type { FastifyInstance } from 'fastify';
import type { Duplex } from 'node:stream';
import { randomUUID } from 'node:crypto';
import { WebSocketServer, type RawData } from 'ws';
import { prisma } from '../lib/prisma';
import { getAccountState, checkSessionVersion, BAN_CODE, SESSION_REPLACED_CODE } from '../lib/account';
import { type WsConnection } from '../lib/wsRegistry';
import { buildSnapshot, SESSION_SLOTS } from '../lib/gameSession';
import {
  WS_PROTOCOL_VERSION,
  WS_CAPABILITIES,
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
import { wsRegistry, gameSessions, wilds, battles, rooms } from './sessionBus';
import { publishWild } from './wild';
import {
  publishRooms, sweepRooms, applyRoomIntent, applyRoomAutopilot,
} from './room';
import { tokenDigest } from '../lib/roomAuth';
import {
  hydrateForUser, detachConnection, dropUserSessions, sweepSessions,
} from './session';

export function getRealtimeStats(): { connections: number; users: number } {
  return { connections: wsRegistry.size, users: wsRegistry.userCount };
}

/**
 * P4-1a：登录成功后立刻把该账号的在线连接全部踢下线。
 *
 * 顶号的触发点是「新会话建立」，不是「新 WS 握手」——后者要等前端建连，
 * 中间有窗口让旧设备继续发请求。服务端主动发 bye 让旧设备即时看到弹窗；
 * onConnected 的 takeover 保留为兜底，防两个并发握手同时通过校验。
 */
export function kickUserConnections(userId: string, reason: string): number {
  const evicted = wsRegistry.listForUser(userId);
  for (const c of evicted) {
    try {
      c.socket.send(encodeServerMessage({
        type: 'bye', code: SESSION_REPLACED_CODE, reason,
      }));
      c.socket.close(4001, SESSION_REPLACED_CODE);
    } catch { /* 已断开 */ }
    wsRegistry.remove(c.id);
    detachConnection(c.id);
  }
  return evicted.length;
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
      // 用 end(data) 一次性写完再关闭：write 后立刻 destroy 可能丢掉尚未 flush 的响应体。
      socket.end(buildRejectResponse(status, { error: reason, code }));
    } catch {
      socket.destroy();
    }
  }

  fastify.server.on('upgrade', (req, socket, head) => {
    if (!isWsUpgradePath(req.url)) {
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
        if (!token) return reject(socket, 401, 'UNAUTHORIZED', '未登录或登录已过期');
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
        const state = await getAccountState(userId);
        if (!state.exists) {
          return reject(socket, 401, 'UNAUTHORIZED', '账号不存在或已被删除', userId);
        }
        if (state.banned) {
          return reject(socket, 403, BAN_CODE, state.banReason ?? '你已被封号', userId);
        }
        // P4-1a：旧设备拿旧 token 重连（例如刷新页面）会在这里被挡住，
        // 否则它会把新设备顶下线，形成两台设备互相踢的死循环。
        const session = checkSessionVersion(payload?.sv, state.sessionVersion);
        if ('code' in session) {
          return reject(socket, 403, session.code, session.reason, userId);
        }
        // P4-2b：把 token 指纹带进连接生命周期，房间座位据此判断「同 token 同设备」。
        wss.handleUpgrade(
          req, socket, head,
          (ws) => onConnected(fastify, ws, userId, heartbeatMs, tokenDigest(token)),
        );
      } catch (err) {
        fastify.log.error({ event: 'ws_upgrade_error', err }, 'ws upgrade failed');
        reject(socket, 500, 'INTERNAL', '服务器内部错误');
      }
    })();
  });

  // —— 心跳扫描：死连接清理 + 会话期封号复查 + 空会话回收 ——
  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      for (const c of wsRegistry.findStale(now, deadAfterMs(heartbeatMs))) {
        fastify.log.warn(
          { event: 'ws_dead', userId: c.userId, connectionId: c.id },
          'ws heartbeat timeout',
        );
        try { c.socket.terminate(); } catch { /* 已断开 */ }
        wsRegistry.remove(c.id);
        detachConnection(c.id);
      }
      for (const c of wsRegistry.all()) {
        c.alive = false;
        try { c.socket.ping(); } catch { /* 已断开，交给 close 事件注销 */ }
      }
      sweepSessions(now);
      // P3-1：活跃战斗也有 TTL，断线挂机不占内存；封号时随会话一起丢弃。
      battles.sweep(now);
      // P4-1b：共享野怪过期换新 / 超时放回池子后，把新列表广播给所有在线客户端。
      for (const areaId of wilds.sweep(now)) {
        const spec = wilds.getAreaSpec(areaId);
        if (spec) publishWild(areaId, spec, now);
      }

      const userIds = Array.from(new Set(wsRegistry.all().map((c) => c.userId)));
      if (userIds.length === 0) return;
      try {
        const banned = await prisma.user.findMany({
          where: { id: { in: userIds }, bannedAt: { not: null } },
          select: { id: true, banReason: true },
        });
        for (const u of banned) {
          for (const c of wsRegistry.listForUser(u.id)) {
            try {
              c.socket.send(
                encodeServerMessage({
                  type: 'bye',
                  code: BAN_CODE,
                  reason: u.banReason ?? '你已被封号',
                }),
              );
              c.socket.close(1008, BAN_CODE);
            } catch { /* 已断开 */ }
            wsRegistry.remove(c.id);
            detachConnection(c.id);
          }
          dropUserSessions(u.id);
          battles.dropUser(u.id);
        }
      } catch (err) {
        fastify.log.error({ event: 'ws_ban_sweep_error', err }, 'ws ban sweep failed');
      }
    })();
  }, heartbeatMs);
  timer.unref?.();

  // P4-2b 房间时间线与 30s 心跳解耦：回合超时是秒级，不能等一个心跳周期才推进。
  // 250ms 扫描纯内存状态，房间稳定时 tick 不产生变更、也不广播。
  const roomTimer = setInterval(() => {
    try {
      sweepRooms(Date.now());
    } catch (err) {
      fastify.log.error({ event: 'room_sweep_error', err }, 'room sweep failed');
    }
  }, 250);
  roomTimer.unref?.();

  fastify.addHook('onClose', async () => {
    clearInterval(timer);
    clearInterval(roomTimer);
    for (const c of wsRegistry.all()) {
      try {
        c.socket.send(encodeServerMessage({ type: 'bye', reason: '服务器正在关闭' }));
        c.socket.close(1001, 'server closing');
      } catch { /* 已断开 */ }
    }
    wsRegistry.clear();
    gameSessions.clear();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}

/** 单条连接建立后的消息循环（控制消息 + 权威态快照下行）。 */
function onConnected(
  fastify: FastifyInstance,
  ws: any,
  userId: string,
  heartbeatMs: number,
  digest: string,
): void {
  const now = Date.now();
  const conn: WsConnection = {
    id: randomUUID(),
    userId,
    socket: ws,
    connectedAt: now,
    lastSeenAt: now,
    alive: true,
  };
  // P4-1a 顶号：新连接原子接管，把同账号的旧连接全部踢下线。
  // 旧连接收到 bye 后由前端停实时 / 停同步 / 清 token，绝不重连、绝不合并本地改动。
  const evicted = wsRegistry.takeover(conn);
  for (const old of evicted) {
    try {
      old.socket.send(encodeServerMessage({
        type: 'bye',
        code: SESSION_REPLACED_CODE,
        reason: '账号已在其他设备登录，本设备已下线',
      }));
      old.socket.close(4001, SESSION_REPLACED_CODE);
    } catch { /* 已断开 */ }
    detachConnection(old.id);
    fastify.log.info(
      { event: 'ws_takeover', userId, evictedConnectionId: old.id, connectionId: conn.id },
      'ws connection replaced by newer device',
    );
  }

  ws.send(
    encodeServerMessage({
      type: 'hello',
      protocol: WS_PROTOCOL_VERSION,
      connectionId: conn.id,
      userId,
      serverTime: now,
      heartbeatMs,
      capabilities: WS_CAPABILITIES,
    }),
  );
  fastify.log.info({ event: 'ws_connected', userId, connectionId: conn.id }, 'ws connected');

  // P4-2b：同一 token 同一设备才算重连 —— 座位按 (userId, tokenDigest) 匹配。
  // 换设备登录会签出新 token（sv 递增）→ 指纹不同 → 座位保持掉线、不转移。
  const rejoined = rooms.reconnect(userId, digest, conn.id, now);
  if (rejoined.length > 0) publishRooms(rejoined);

  // P2-2：连接就绪后把该用户已有槽位的权威快照推下去（重连等于拉最新状态）。
  void (async () => {
    try {
      const snapshots = await hydrateForUser(userId, conn.id);
      for (const snap of snapshots) {
        if (ws.readyState !== 1) return;
        ws.send(encodeServerMessage(snap));
      }
    } catch (err) {
      fastify.log.error({ event: 'session_hydrate_error', userId, err }, 'session hydrate failed');
    }
  })();

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

    const text = Array.isArray(raw)
      ? Buffer.concat(raw).toString('utf8')
      : Buffer.isBuffer(raw)
        ? raw.toString('utf8')
        : Buffer.from(raw).toString('utf8');
    const parsed = parseClientMessage(text);
    // strict:false 下判别联合收窄不可靠，用属性存在性判断（bug_log §18）。
    if ('code' in parsed) {
      ws.send(encodeServerMessage({ type: 'error', code: parsed.code, reason: parsed.reason }));
      ws.close(1008, parsed.code);
      return;
    }

    conn.alive = true;
    conn.lastSeenAt = t;
    const msg = parsed.message;

    // 上行只请求重推快照，不接收任何状态数据；写入口始终在服务端。
    if (msg.type === 'session.resync') {
      for (const slot of SESSION_SLOTS) {
        if (msg.slot !== undefined && slot !== msg.slot) continue;
        const s = gameSessions.get(userId, slot);
        if (s && ws.readyState === 1) ws.send(encodeServerMessage(buildSnapshot(s)));
      }
      return;
    }

    // P4-2b：房间上行只有「意图」与「请求重推」，都不直接写状态。
    if (msg.type === 'room.resync') {
      const list = rooms.listForUser(userId).filter(
        (r) => msg.roomId === undefined || r.roomId === msg.roomId,
      );
      for (const r of list) {
        if (ws.readyState !== 1) break;
        ws.send(encodeServerMessage({ type: 'room.state', room: rooms.view(r, userId) }));
      }
      return;
    }
    if (msg.type === 'room.action') {
      // 与 REST 共用同一套服务层：withRoomLock 串行 → 服务端裁决 → 广播 room.state。
      void (async () => {
        try {
          const res = msg.action === 'intent'
            ? await applyRoomIntent({
                roomId: msg.roomId,
                userId,
                intent: String(msg.intent ?? ''),
                nonce: msg.nonce,
              })
            : await applyRoomAutopilot({
                roomId: msg.roomId,
                userId,
                targetSeat: Number(msg.targetSeat),
                enabled: msg.action === 'autopilot_on',
                nonce: msg.nonce,
              });
          // 业务拒绝只回 error，不断连；协议层伪造类型才关 1008。
          if ('code' in res && ws.readyState === 1) {
            ws.send(encodeServerMessage({ type: 'error', code: res.code, reason: res.reason }));
          }
        } catch (err) {
          fastify.log.error({ event: 'room_action_error', userId, err }, 'room action failed');
        }
      })();
      return;
    }

    const ts = 'ts' in msg ? msg.ts : undefined;
    ws.send(
      encodeServerMessage({
        type: 'pong',
        serverTime: t,
        ...(ts !== undefined ? { echo: ts } : {}),
      }),
    );
  });

  ws.on('close', () => {
    wsRegistry.remove(conn.id);
    detachConnection(conn.id);
    // P4-2b：断线只标记座位、保留回合态；按 connectionId 精确匹配，
    // 新连接先建好、旧连接迟到 close 时不会误标掉线。
    const changed = rooms.markDisconnected(userId, conn.id, Date.now());
    if (changed.length > 0) publishRooms(changed);
    fastify.log.info({ event: 'ws_closed', userId, connectionId: conn.id }, 'ws closed');
  });
  ws.on('error', () => {
    // close 事件会紧随，注销统一放在 close 里
  });
}
