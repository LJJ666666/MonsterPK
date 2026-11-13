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
import { buildSnapshot } from '../lib/gameSession';
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
import { wsRegistry, gameSessions, wilds, battles, rooms, bossQuota } from './sessionBus';
import { publishWild } from './wild';
import {
  publishRooms, sweepRooms, applyRoomIntent, applyRoomAutopilot,
} from './room';
import { tokenDigest } from '../lib/roomAuth';
import { runInRoomUnit } from '../lib/roomUnitOfWork';
import { getSweepLeader, guardedCommit, type SweepContext } from '../lib/sweepLeader';
import { publishTakeover, shutdownBroadcast } from '../lib/connectionControl';
import {
  hydrateForUser, detachConnection, dropUserSessions, sweepSessions,
} from './session';

/**
 * W0：本地心跳段 —— 每个进程各跑一份，只管「本进程登记的连接」。
 * 死连接清理 + ping 探活；W5 还会在这里补 `sessionVersion` 比对（顶号残留兜底）。
 */
export function runLocalHeartbeat(
  fastify: FastifyInstance,
  now: number,
  heartbeatMs: number,
): void {
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
}

/** guardedCommit 抽到 lib/sweepLeader.ts，供单测 / E2E 直接 import 同一实现。 */

/**
 * W0：全局 sweep 段 —— W4 起只由 leader 调用。
 *
 * 无 ctx 时走「单实例直通」路径，行为与 W0 拆分前逐字一致（单测 / 本地无 Redis 用）；
 * 有 ctx 时按心跳 bucket 加幂等键：sessions / battles / wilds 每个 bucket 只处理一次，
 * quota.release 按 battleId、wild 广播按 (areaId, bucket) 各只发一次。
 *
 * 注意：W6/W7 才会把房间与野怪状态机迁到共享存储，本阶段的幂等键防的是
 * 「leader 切换重叠窗口内的重复推进」，不是跨实例共享真值。
 */
export async function runGlobalSweep(
  now: number,
  heartbeatMs: number,
  ctx?: SweepContext | null,
): Promise<void> {
  // W6.4：回收因进程长期挂起 / 重启而未能及时释放的 Boss 在途租约（token 已过期），
  // 避免开局后服务异常挂起导致名额永久泄漏。与战斗回收都按 token 幂等，互不干扰。
  bossQuota.reapExpired(now);
  if (!ctx) {
    sweepSessions(now);
    for (const st of battles.sweepExpired(now)) {
      if (st.bossQuotaToken) bossQuota.release(st.bossQuotaToken);
    }
    for (const areaId of wilds.sweep(now)) {
      const spec = wilds.getAreaSpec(areaId);
      if (spec) publishWild(areaId, spec, now);
    }
    return;
  }

  const bucket = Math.floor(now / Math.max(1, heartbeatMs));
  await guardedCommit(ctx, `sweep:sessions:${bucket}`, () => { sweepSessions(now); });

  // 每个被回收的 Boss 战只放行一次 quota.release；重复 sweep 不会把名额多还。
  const expired = battles.sweepExpired(now);
  for (const st of expired) {
    if (!st.bossQuotaToken) continue;
    const token = st.bossQuotaToken;
    await guardedCommit(ctx, `quota:release:${st.id}`, () => { bossQuota.release(token); });
  }

  // wilds.sweep 本身会补怪，必须整段只由一个 leader 在一个 bucket 内跑一次；
  // 广播再按 (areaId, bucket) 二次幂等，重复订阅/切换不重复推快照。
  const wildToken = (await ctx.guard()) ? await ctx.claim(`sweep:wilds:${bucket}`) : null;
  if (wildToken) {
    for (const areaId of wilds.sweep(now)) {
      const spec = wilds.getAreaSpec(areaId);
      if (!spec) continue;
      await guardedCommit(ctx, `wild:${areaId}:${bucket}`, () => { publishWild(areaId, spec, now); });
    }
  }
}

/**
 * W0：封号复查属于「本进程连接」范畴（踢的是自己手里的连接），但要查 DB，故独立成段。
 * W4：同一次查询顺带比对 `sessionVersion` —— 旧 token 的 WS 就算一直 pong 也不能
 * 无限存活（顶号 / 封号残留兜底）。无在线账号时直接短路。
 */
export async function runBanSweep(fastify: FastifyInstance): Promise<void> {
  const userIds = Array.from(new Set(wsRegistry.all().map((c) => c.userId)));
  if (userIds.length === 0) return;
  try {
    const accounts = await prisma.user.findMany({
      where: { id: { in: userIds } },
      select: { id: true, banReason: true, bannedAt: true, sessionVersion: true },
    });
    const byId = new Map(accounts.map((a) => [a.id, a]));
    for (const c of wsRegistry.all()) {
      const acc = byId.get(c.userId);
      if (!acc) continue;
      const banned = acc.bannedAt !== null;
      const replaced = c.sessionVersion !== undefined && c.sessionVersion !== acc.sessionVersion;
      if (!banned && !replaced) continue;
      const code = banned ? BAN_CODE : SESSION_REPLACED_CODE;
      const reason = banned
        ? (acc.banReason ?? '你已被封号')
        : '账号已在其他设备登录，本设备已下线';
      try {
        c.socket.send(encodeServerMessage({ type: 'bye', code, reason }));
        c.socket.close(banned ? 1008 : 4001, code);
      } catch { /* 已断开 */ }
      wsRegistry.remove(c.id);
      detachConnection(c.id);
      if (banned) {
        dropUserSessions(c.userId);
        battles.dropUser(c.userId);
      }
    }
  } catch (err) {
    fastify.log.error({ event: 'ws_ban_sweep_error', err }, 'ws ban sweep failed');
  }
}

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
export function heartbeatIntervalMs(): number {
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
        const allowedOrigin = process.env.CORS_ORIGIN ?? `http://localhost:${process.env.MPK_FRONT_PORT || 5173}`;
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
          (ws) => onConnected(fastify, ws, userId, heartbeatMs, tokenDigest(token), payload?.sv),
        );
      } catch (err) {
        fastify.log.error({ event: 'ws_upgrade_error', err }, 'ws upgrade failed');
        reject(socket, 500, 'INTERNAL', '服务器内部错误');
      }
    })();
  });

  // W4（设计定稿 §3.4）：W0 拆出的三段里，本地心跳与封号复查每进程各跑；
  // 全局 sweep 只有 leader 跑，且每段动作都带「guard → 幂等键 → 提交成功才 publish」。
  const timer = setInterval(() => {
    void (async () => {
      const now = Date.now();
      runLocalHeartbeat(fastify, now, heartbeatMs);
      try {
        await getSweepLeader().run(async (ctx) => {
          await runGlobalSweep(now, heartbeatMs, ctx);
        });
      } catch (err) {
        fastify.log.error({ event: 'sweep_leader_error', err }, 'global sweep failed');
      }
      await runBanSweep(fastify);
    })();
  }, heartbeatMs);
  timer.unref?.();

  // P4-2b 房间时间线与 30s 心跳解耦：回合超时是秒级，不能等一个心跳周期才推进。
  // W4：用本地 leader 缓存（不每 250ms 打 Redis），跨实例互斥由
  // `withRoomLock` + `idem:room:<roomId>:<rev>` 短期 claim 共同裁决。
  const roomTimer = setInterval(() => {
    const ctx = getSweepLeader().lightContext();
    if (!ctx) return; // 本进程不是 leader：不推进、不广播，避免双推进
    void sweepRooms(Date.now(), ctx).catch((err) => {
      fastify.log.error({ event: 'room_sweep_error', err }, 'room sweep failed');
    });
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
    await getSweepLeader().shutdown();
    await shutdownBroadcast();
    await new Promise<void>((resolve) => wss.close(() => resolve()));
  });
}

/** 单条连接建立后的消息循环（控制消息 + 权威态快照下行）。 */
async function onConnected(
  fastify: FastifyInstance,
  ws: any,
  userId: string,
  heartbeatMs: number,
  digest: string,
  sessionVersion?: number,
): Promise<void> {
  // W6.1：本函数内有 await（reconnect / hydrate），而 ws 发射错误走 nextTick、
  // 先于微任务执行——超大帧的 1009（WS_ERR_UNSUPPORTED_MESSAGE_LENGTH）可能赶在
  // 后面的事件挂载之前到达。error 监听必须最先挂，否则无人接住会打死整个进程。
  ws.on('error', () => {
    // close 事件会紧随，注销统一放在 close 里
  });
  const now = Date.now();
  const conn: WsConnection = {
    id: randomUUID(),
    userId,
    socket: ws,
    connectedAt: now,
    lastSeenAt: now,
    alive: true,
    // W4：握手时的 sv 存进连接，本地心跳复查 DB 发现代次变化就踢旧连接。
    sessionVersion: typeof sessionVersion === 'number' ? sessionVersion : undefined,
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
  // W5：跨实例顶号 —— 本地 takeover 踢掉了本进程旧连接；再广播 takeover 事件，
  // 让其它实例上该账号的旧连接也收到 bye。新连接（sv 匹配）会被自身忽略，不会收到自己的 bye。
  if (typeof sessionVersion === 'number') publishTakeover(userId, sessionVersion);

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

  // W6.1：reconnect 已是 async（W6 存储异步化），事件监听必须先于任何 await 挂好——
  // 客户端在 hello 后立即上行的消息/关闭可能赶在监听器挂载前到达而被静默丢弃
  // （原同步实现天然同 tick 挂载；e2e_hardening 的 ping/限流用例实证过此回归，勿回退）。
  attachWsHandlers(fastify, ws, conn, userId, now);

  // P4-2b：同一 token 同一设备才算重连 —— 座位按 (userId, tokenDigest) 匹配。
  // 换设备登录会签出新 token（sv 递增）→ 指纹不同 → 座位保持掉线、不转移。
  // W6.2：多房掉线/重连写与 room.state 广播一起纳入工作单元，提交成功才发。
  await runInRoomUnit(async () => {
    const ids = await rooms.reconnect(userId, digest, conn.id, now);
    if (ids.length > 0) await publishRooms(ids);
  });

  // P2-2：连接就绪后把该用户的账号单档权威快照推下去（重连等于拉最新状态）。
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
}

/**
 * W6.1：WS 事件监听挂载。必须在 onConnected 的任何 await 之前调用——
 * reconnect/hydrate 异步化后，晚挂载会在窗口期静默丢消息（详见调用点注释）。
 */
function attachWsHandlers(
  fastify: FastifyInstance,
  ws: any,
  conn: { id: string; alive: boolean; lastSeenAt: number },
  userId: string,
  now: number,
): void {
  let windowStart = now;
  let windowCount = 0;

  ws.on('pong', () => {
    conn.alive = true;
    conn.lastSeenAt = Date.now();
  });

  ws.on('message', async (raw: RawData) => {
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
      const s = gameSessions.get(userId);
      if (s && ws.readyState === 1) ws.send(encodeServerMessage(buildSnapshot(s)));
      return;
    }

    // P4-2b：房间上行只有「意图」与「请求重推」，都不直接写状态。
    if (msg.type === 'room.resync') {
      const list = (await rooms.listForUser(userId)).filter(
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

  ws.on('close', async () => {
    wsRegistry.remove(conn.id);
    detachConnection(conn.id);
    try {
      // P4-2b：断线只标记座位、保留回合态；按 connectionId 精确匹配，
      // 新连接先建好、旧连接迟到 close 时不会误标掉线。
      await runInRoomUnit(async () => {
        const ids = await rooms.markDisconnected(userId, conn.id, Date.now());
        if (ids.length > 0) await publishRooms(ids);
      });
    } catch (err) {
      // W6.1：CAS 重试耗尽等异常绝不允许打死进程；掉线标记下轮 sweep/心跳自然补齐。
      fastify.log.error({ event: 'ws_close_mark_failed', userId, err }, 'ws close 标记掉线失败');
    }
    fastify.log.info({ event: 'ws_closed', userId, connectionId: conn.id }, 'ws closed');
  });
}
