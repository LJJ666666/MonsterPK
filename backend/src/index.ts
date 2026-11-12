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
import { registerRealtime, getRealtimeStats } from './modules/realtime';
import { getAccountState, checkSessionVersion, BAN_CODE, type AccountState } from './lib/account';

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
  battles: battles.stats(),
  wild: wilds.stats(),
  // P4-2a：榜单是只读派生读模型，health 只报类型数与真值来源，不查库。
  rank: rankStats(),
  // P4-2b：房间状态域统计（纯内存，不查库）。
  rooms: roomStats(),
  // P4-2c：Boss 讨伐（内容表 + 在途次数），不查库。
  boss: bossHealthStats(),
  content: contentStats(),
  // F04：等级 / 徽章 / 成就是服务端只读真值，health 只报来源，不查库。
  progress: progressStats(),
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
registerRealtime(fastify);

const port = Number(process.env.PORT ?? 3001);

fastify.listen({ port, host: '0.0.0.0' }).then(() => {
  fastify.log.info(`MonsterPK backend listening on :${port}`);
}).catch((err) => {
  fastify.log.error(err);
  process.exit(1);
});

process.on('SIGINT', async () => {
  await prisma.$disconnect();
  process.exit(0);
});
