import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../lib/password';
import { BAN_CODE } from '../lib/account';
import { loginRateLimiter } from '../lib/loginRateLimit';
import { kickUserConnections } from './realtime';

const registerSchema = z.object({
  username: z.string().min(3).max(20),
  password: z.string().min(6).max(64),
});

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function authRoutes(fastify: FastifyInstance) {
  // 注册
  fastify.post('/api/auth/register', async (req, reply) => {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '用户名需 3-20 位、密码需 6-64 位' });
    }
    const { username, password } = parsed.data;
    const exists = await prisma.user.findUnique({ where: { username } });
    if (exists) {
      return reply.code(409).send({ error: '用户名已存在' });
    }
    const user = await prisma.user.create({
      data: { username, password: hashPassword(password), sessionVersion: 1 },
    });
    // P4-1a：JWT 带登录代次 sv，注册即从 1 起；之后每次登录递增，旧 token 立刻失效。
    const token = fastify.jwt.sign(
      { userId: user.id, sv: user.sessionVersion },
      { expiresIn: process.env.JWT_TTL ?? "30d" }
    );
    return { token, username: user.username };
  });

  // 登录
  fastify.post('/api/auth/login', async (req, reply) => {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: '请输入用户名和密码' });
    }
    const { username, password } = parsed.data;
    const ip = req.ip;
    // A5：只拦「连续猜密码」。限流检查不消耗配额，只有校验失败才累计；
    // 正常登录（含 verify 里 25 组 E2E 的高频登录）成功即清空该账号记录。
    const limit = loginRateLimiter.check(ip, username);
    if (!limit.allowed) {
      return reply.code(429)
        .header('Retry-After', String(limit.retryAfter))
        .send({
          error: '尝试过于频繁，请稍后再试',
          code: 'LOGIN_RATE_LIMITED',
          retryAfter: limit.retryAfter,
        });
    }
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.password)) {
      loginRateLimiter.recordFailure(ip, username);
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    // 封号账号禁止重新登录（否则换个设备/清 localStorage 就能绕开封禁）
    // 封号拦截本身不计入失败次数，避免风控状态被误当成撞库。
    if (user.bannedAt) {
      return reply.code(403).send({
        error: '你已被封号',
        code: BAN_CODE,
        reason: user.banReason ?? '检测到异常游戏数据',
      });
    }
    // P4-1a 顶号：登录即递增代次，前一个设备（含刚注册那次）的 token 全部作废。
    // 用 increment 的返回值签发，避免「先读后写」在高并发登录时签出同一个 sv。
    const rotated = await prisma.user.update({
      where: { id: user.id },
      data: { sessionVersion: { increment: 1 } },
      select: { sessionVersion: true },
    });
    const token = fastify.jwt.sign(
      { userId: user.id, sv: rotated.sessionVersion },
      { expiresIn: process.env.JWT_TTL ?? "30d" }
    );
    loginRateLimiter.clear(ip, username);
    // 顶号即时生效：不等新设备建 WS，先把旧设备的实时通道断掉。
    // 旧 token 的 REST 请求则由认证守卫按 sv 拒绝（403 SESSION_REPLACED）。
    kickUserConnections(user.id, '账号已在其他设备登录，本设备已下线');
    return { token, username: user.username };
  });

  // 取当前登录用户（前端启动时校验 token，并据此决定测试菜单是否可见）。
  // isAdmin 由服务端判定后下发；客户端即使伪造这个值，后端风控也不认。
  fastify.get('/api/auth/me', { preHandler: fastify.authenticate }, async (req) => {
    const state = req.account;
    return {
      id: state?.userId ?? (req.user as any).userId,
      username: state?.username ?? null,
      isAdmin: state?.isAdmin ?? false,
      banned: state?.banned ?? false,
    };
  });
}
