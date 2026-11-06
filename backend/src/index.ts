import './lib/env'; // 必须最先执行，加载 .env 后再初始化其他模块
import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import { prisma } from './lib/prisma';
import { authRoutes } from './modules/auth';
import { saveRoutes } from './modules/save';
import { actionRoutes } from './modules/actions';
import { sessionRoutes } from './modules/session';
import { battleRoutes } from './modules/battle';
import { contentStats } from './game/content';
import { getSessionStats, battles } from './modules/sessionBus';
import { registerRealtime, getRealtimeStats } from './modules/realtime';
import { getAccountState, BAN_CODE, type AccountState } from './lib/account';

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

const fastify = Fastify({ logger: true });

fastify.register(cors, {
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
});

fastify.register(jwt, {
  secret: process.env.JWT_SECRET ?? 'dev-secret-change-me',
});

// 认证守卫：除 JWT 校验外实时查库判断封号，封号必须即时生效（不能等旧 token 过期）。
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
  content: contentStats(),
}));

fastify.register(authRoutes);
fastify.register(saveRoutes);
fastify.register(actionRoutes);
fastify.register(sessionRoutes);
fastify.register(battleRoutes);

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
