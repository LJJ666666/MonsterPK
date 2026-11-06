import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { hashPassword, verifyPassword } from '../lib/password';
import { BAN_CODE } from '../lib/account';

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
      data: { username, password: hashPassword(password) },
    });
    // 签发带过期时间的 token；过期后 Authenticate 守卫会自动拒绝（401）
    const token = fastify.jwt.sign(
      { userId: user.id },
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
    const user = await prisma.user.findUnique({ where: { username } });
    if (!user || !verifyPassword(password, user.password)) {
      return reply.code(401).send({ error: '用户名或密码错误' });
    }
    // 封号账号禁止重新登录（否则换个设备/清 localStorage 就能绕开封禁）
    if (user.bannedAt) {
      return reply.code(403).send({
        error: '你已被封号',
        code: BAN_CODE,
        reason: user.banReason ?? '检测到异常游戏数据',
      });
    }
    const token = fastify.jwt.sign(
      { userId: user.id },
      { expiresIn: process.env.JWT_TTL ?? "30d" }
    );
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
