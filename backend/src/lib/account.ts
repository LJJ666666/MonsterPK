/**
 * 账号风控视图（P1-1b）：管理员判定、封号状态查询与封号执行。
 *
 * 管理员有两个来源，取并集：
 *  1) 数据库 `User.role === 'admin'`（持久化，便于审计与管理端扩展）；
 *  2) `.env` 的 `ADMIN_USERNAMES` 逗号分隔白名单（服务端配置，客户端不可伪造）。
 * 白名单用于「不改库即可授权」，role 用于「授权可持久化、可查询」。
 *
 * 设计原则：管理员身份**只能由服务端判定**，绝不从请求体 / JWT 声明里读取，
 * 否则客户端伪造一个 role=admin 就能绕过风控。
 */
import { prisma } from './prisma';

/** 封号响应的机器码，前端据此弹出封号弹窗并强制登出。 */
export const BAN_CODE = 'ACCOUNT_BANNED';

/** 解析 ADMIN_USERNAMES：逗号分隔、去空白、忽略空项、大小写不敏感。 */
export function parseAdminUsernames(raw: string | undefined): Set<string> {
  return new Set(
    (raw ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter((s) => s.length > 0),
  );
}

/** 纯函数：用户名是否命中管理员白名单（便于单测，不连库）。 */
export function isAdminUsername(
  username: string | null | undefined,
  raw: string | undefined = process.env.ADMIN_USERNAMES,
): boolean {
  if (!username) return false;
  return parseAdminUsernames(raw).has(username.trim().toLowerCase());
}

/** 一次请求所需的账号风控视图。 */
export type AccountState = {
  exists: boolean;
  userId: string;
  username: string | null;
  isAdmin: boolean;
  banned: boolean;
  banReason: string | null;
};

/**
 * 按 userId 取账号状态。认证守卫与路由都会调用（每个请求一次轻量主键查询）。
 * 上云后可加短 TTL 缓存降低 DB 压力，但不能缓存封号状态过久，否则解封不即时生效。
 */
export async function getAccountState(userId: string): Promise<AccountState> {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: { id: true, username: true, role: true, bannedAt: true, banReason: true },
  });
  if (!user) {
    return { exists: false, userId, username: null, isAdmin: false, banned: false, banReason: null };
  }
  return {
    exists: true,
    userId: user.id,
    username: user.username,
    isAdmin: user.role === 'admin' || isAdminUsername(user.username),
    banned: user.bannedAt !== null,
    banReason: user.banReason ?? null,
  };
}

/** 封号参数：审计记录只存摘要，不存完整存档。 */
export type BanParams = {
  userId: string;
  reason: string;
  codes: string[];
  slot?: number;
  stats?: Record<string, unknown>;
};

/**
 * 执行封号：在同一个事务里写审计记录 + 更新账号状态，避免「封了但没留痕」。
 * 重复触发时仍追加一条审计，便于统计反复作弊；账号状态保持已封。
 */
export async function banAccount(params: BanParams): Promise<void> {
  const now = new Date();
  await prisma.$transaction([
    prisma.banRecord.create({
      data: {
        userId: params.userId,
        slot: params.slot ?? null,
        codes: JSON.stringify(params.codes),
        reason: params.reason,
        stats: params.stats ? JSON.stringify(params.stats) : null,
      },
    }),
    prisma.user.update({
      where: { id: params.userId },
      data: { bannedAt: now, banReason: params.reason },
    }),
  ]);
}
