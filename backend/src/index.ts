import './lib/env'; // 必须最先执行，加载 .env 后再初始化其他模块
import Fastify from 'fastify';
import { randomUUID } from 'node:crypto';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { prisma } from './lib/prisma';
import { authRoutes } from './modules/auth';
import { saveRoutes } from './modules/save';
import { actionRoutes } from './modules/actions';
import { sessionRoutes } from './modules/session';
import { battleRoutes } from './modules/battle';
import { gameRoutes } from './modules/game';
import { wildRoutes } from './modules/wild';
import { rankRoutes, rankStats } from './modules/rank';
import { rankPeriodRoutes } from './modules/rankPeriod';
import { roomRoutes, roomStats } from './modules/room';
import { bossRoutes, bossHealthStats } from './modules/boss';
import { gymRoutes } from './modules/gym';
import { mapBossRoutes } from './modules/mapBoss';
import { pvpRoutes } from './modules/pvp';
import { coopRoutes } from './modules/coop';
import { playerProgressRoutes, progressStats } from './modules/playerProgress';
import { contentStats } from './game/content';
import { getSessionStats, battles, wilds } from './modules/sessionBus';
import { registerRealtime, getRealtimeStats, heartbeatIntervalMs } from './modules/realtime';
import { getAccountState, checkSessionVersion, BAN_CODE, type AccountState } from './lib/account';
import { initializeLockProvider, shutdownLockProvider, getLockDiagnostics, getLockRedisClient } from './lib/lockBootstrap';
import { initializeSweepLeader, getSweepDiagnostics, getSweepLeader } from './lib/sweepLeader';
import { initW5Broadcast, shutdownBroadcast, getBroadcastMode } from './lib/connectionControl';
import { RedisKvStore } from './lib/redisKvStore';
import { setGymCooldownStore, getGymCooldownStoreKind } from './game/gyms';
import { useSessionRevisionStore, getSessionRevisionMode } from './lib/sessionRevision';

// 声明 authenticate 装饰器类型与请求上的账号风控视图（运行时由下方 decorate 注入）
declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (req: any, reply: any) => Promise<void> | void;
  }
  interface FastifyRequest {
    /** 由认证守卫写入：账号是否存在 / 是否管理员 / 是否已封号。 */
    account?: AccountState;
  }
}

const REQUEST_ID_HEADER = 'x-request-id';
// 只接受短且无空白的可见字符：客户端若能传换行/超长串进日志，就能伪造日志行。
const SAFE_REQUEST_ID = /^[A-Za-z0-9._:-]{1,64}$/;

const fastify = Fastify({
  logger: true,
  // 默认 req.id 是进程内自增数字，重启即重复、多实例也无法串联日志。
  // 优先透传客户端 X-Request-Id（严格校验），否则生成一个随机 id。
  genReqId: (req) => {
    const incoming = req.headers[REQUEST_ID_HEADER];
    return typeof incoming === 'string' && SAFE_REQUEST_ID.test(incoming)
      ? incoming
      : randomUUID();
  },
});

// A2 请求追踪：所有访问日志共享同一个 requestId，前端带上这个 id 报错时
// 可以直接在服务端日志里找到对应的完整请求链路。id 同时回写到响应头。
fastify.addHook('onRequest', async (req, reply) => {
  reply.header('X-Request-Id', req.id);
  req.log.info({ event: 'request_in', requestId: req.id, method: req.method, url: req.url }, 'request in');
});
fastify.addHook('onResponse', async (req, reply) => {
  req.log.info({
    event: 'request_out',
    requestId: req.id,
    method: req.method,
    url: req.url,
    status: reply.statusCode,
    ms: Math.round(Number((reply as any).elapsedTime ?? 0)),
  }, 'request out');
});

// CORS_ORIGIN 与 wsProtocol.isOriginAllowed 共用一份逗号分隔配置：
// 单值时保持原行为（字符串精确匹配），多值时传数组让 @fastify/cors 逐个匹配。
// 本地调试 APK 的 WebView origin 是 http://localhost，与前端 dev 不同端口，必须同时放行。
// 前端 dev 端口由 MPK_FRONT_PORT 控制（默认 5173），与 scripts/lib/devConfig.mjs 同源。
const defaultFrontOrigin = `http://localhost:${process.env.MPK_FRONT_PORT || 5173}`;
const corsOrigins = (process.env.CORS_ORIGIN ?? defaultFrontOrigin)
  .split(',')
  .map((s) => s.trim())
  .filter((s) => s.length > 0);
fastify.register(cors, {
  origin: corsOrigins.length <= 1 ? (corsOrigins[0] ?? defaultFrontOrigin) : corsOrigins,
  // 让浏览器 / WebView 能读到回写的 X-Request-Id（自定义响应头默认不暴露）。
  exposedHeaders: ['X-Request-Id'],
});

fastify.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
});

// 认证守卫：JWT 校验 → 会话代次（P4-1a 顶号）→ 实时查库封号。
// 顺序有讲究：顶号与封号都要即时生效，不能等旧 token 过期；会话代次放在封号之前，
// 因为「已在别处登录」比「被封」更常见，且不需要跑后续风控。
fastify.decorate('authenticate', async (req: any, reply: any) => {
  try {
    await req.jwtVerify();
  } catch {
    return reply.code(401).send({ error: '未登录或登录已过期' });
  }
  const userId = req.user?.userId;
  if (!userId) return reply.code(401).send({ error: '未登录或登录已过期' });
  const state = await getAccountState(userId);
  if (!state.exists) return reply.code(401).send({ error: '账号不存在或已被删除' });
  const session = checkSessionVersion(req.user?.sv, state.sessionVersion);
  // strict:false 下判别联合不收窄，用属性存在性取值（bug_log §18）。
  if ('code' in session) {
    return reply.code(403).send({ error: session.reason, code: session.code });
  }
  if (state.banned) {
    return reply.code(403).send({
      error: '你已被封号',
      code: BAN_CODE,
      reason: state.banReason ?? '检测到异常游戏数据',
    });
  }
  req.account = state;
});

// health 附带实时通道在线数（P2-1）、在线权威态统计（P2-2）与活跃战斗 / 内容表规模（P3-1）。
fastify.get('/api/health', async () => ({
  ok: true,
  ts: Date.now(),
  ws: getRealtimeStats(),
  sessions: getSessionStats(),
  battles: await battles.stats(),
  // W7：野怪池诊断。storage=redis 表示已切共享实现（跨实例同一份真值）。
  wild: { ...(await wilds.stats()), storage: wilds.kind },
  // P4-2a：榜单是只读派生读模型，health 只报类型数与真值来源，不查库。
  rank: rankStats(),
  // P4-2b：房间状态域统计（纯内存，不查库）。
  rooms: await roomStats(),
  // P4-2c：Boss 讨伐（内容表 + 在途次数），不查库。
  boss: bossHealthStats(),
  content: contentStats(),
  // F04：等级 / 徽章 / 成就是服务端只读真值，health 只报来源，不查库。
  progress: progressStats(),
  // W3：锁模式诊断。in-process 只允许单实例；redis 为跨进程租约锁。
  lock: getLockDiagnostics(),
  // W4：全局 sweep 选主诊断。current 会查一次 Redis，区分「本地缓存」与「真 leader」。
  sweep: { ...getSweepDiagnostics(), current: await getSweepLeader().verifyCurrent() },
  // W5：广播模式诊断。local 为单实例直发；redis 为跨实例 pub/sub 双频道 + 顶号。
  broadcast: getBroadcastMode(),
  // W8：战斗态 / 馆主 CD / 会话版本戳的共享存储模式。
  // 三者 memory 表示单实例内存真值（不可开第二实例），redis 表示跨实例共享。
  w8: {
    battleStorage: battles.kind,
    gymCooldown: getGymCooldownStoreKind(),
    sessionRevision: getSessionRevisionMode(),
  },
}));

fastify.register(authRoutes);
fastify.register(saveRoutes);
fastify.register(actionRoutes);
fastify.register(sessionRoutes);
fastify.register(battleRoutes);
fastify.register(gameRoutes);
fastify.register(wildRoutes);
fastify.register(rankRoutes);
fastify.register(rankPeriodRoutes);
fastify.register(roomRoutes);
fastify.register(bossRoutes);
fastify.register(gymRoutes);
fastify.register(mapBossRoutes);
fastify.register(pvpRoutes);
fastify.register(coopRoutes);
fastify.register(playerProgressRoutes);

// P2-1：实时通道挂在底层 HTTP server 的 upgrade 上，必须在 listen 之前装配。
// W4：定时器必须在 Redis 选主装配之后启动，否则前几个心跳会用进程内 leader 跑全局 sweep。
const port = Number(process.env.PORT ?? 3001);

// W3：先装配分布式锁再监听端口。REDIS_URL 已配置却连不上时启动直接失败，
// 绝不带着进程内锁去接多实例流量（口径见 lib/lockBootstrap.ts）。
initializeLockProvider()
  .then(async () => {
    // W7：REDIS_URL 已配置（锁已是 redis 模式）时，把野怪池切到 Redis + Lua 共享实现。
    // 必须早于心跳启动：否则第一轮全局 sweep 会把补怪写进本进程内存态，跨实例看不到。
    // 未配 REDIS_URL 时保持 MemoryWildStorage（单实例开发 / 单测），行为与 W7 前一致。
    const sharedClient = getLockRedisClient();
    if (sharedClient) wilds.useRedisStorage(sharedClient);

    // W8：战斗态 / 馆主 CD / 会话版本戳同样切共享实现。
    // 三者都必须在 `registerRealtime()`（心跳 + WS）之前装配：
    // 心跳第一轮 sweep 就会读写战斗态，装晚了这一轮还会写进本进程内存。
    // 未配 REDIS_URL 时全部保持内存实现（单实例开发 / 单测），行为与 W8 前一致。
    if (sharedClient) {
      battles.useRedisStorage(sharedClient);
      setGymCooldownStore(new RedisKvStore({ client: sharedClient }));
      useSessionRevisionStore(new RedisKvStore({ client: sharedClient }));
    }

    // E2E 临时实例（W2/W3/W5 这类不测选主的套件）用 MPK_DISABLE_SWEEP=1 不参与选主。
    // 原因：它们被 SIGTERM/SIGKILL 硬杀（Windows 下等同直接杀进程，shutdown handler 不执行），
    // lock:sweep:global 租约只能等 60s TTL 过期；这窗口内常驻 :3001 抢不回 leader，
    // 全局 sweep + 房间 tick 停摆 → W4 的 A1/A2/F0 与 p42b 超时代放间歇红。生产不设该变量。
    if (process.env.MPK_DISABLE_SWEEP === '1') {
      fastify.log.warn('[W4] MPK_DISABLE_SWEEP=1：本实例不参与全局 sweep 选主（仅测试临时实例使用）');
    } else {
      await initializeSweepLeader(getLockRedisClient(), heartbeatIntervalMs());
    }
    // W5：REDIS_URL 已配置时装配跨实例广播 + 顶号；否则保持 LocalBroadcastTransport。
    if (sharedClient) initW5Broadcast(sharedClient);
    registerRealtime(fastify);
    return fastify.listen({ port, host: '0.0.0.0' });
  })
  .then(() => {
    fastify.log.info(`MonsterPK backend listening on :${port}`);
  })
  .catch((err) => {
    fastify.log.error(err);
    process.exit(1);
  });

process.on('SIGINT', async () => {
  // 先交出 leader 租约（要用 Redis 客户端），再关闭广播订阅与锁连接，让其它实例立即接管。
  await getSweepLeader().shutdown();
  await shutdownBroadcast();
  await shutdownLockProvider();
  await prisma.$disconnect();
  process.exit(0);
});
