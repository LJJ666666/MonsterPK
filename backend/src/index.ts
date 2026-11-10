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
import { gameRoutes } from './modules/game';
import { wildRoutes } from './modules/wild';
import { rankRoutes, rankStats } from './modules/rank';
import { rankPeriodRoutes } from './modules/rankPeriod';
import { roomRoutes, roomStats } from './modules/room';
import { bossRoutes, bossHealthStats } from './modules/boss';
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

const fastify = Fastify({ logger: true });

fastify.register(cors, {
  origin: process.env.CORS_ORIGIN ?? 'http://localhost:5173',
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
