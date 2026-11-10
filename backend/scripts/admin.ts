/**
 * 账号管理命令行工具（P1-1b）：授权管理员、撤销、封号、解封、查看。
 *
 * 用法（在 backend/ 目录下）：
 *   npm run admin -- list
 *   npm run admin -- grant <用户名>     # 设为管理员并顺带解封
 *   npm run admin -- revoke <用户名>    # 撤销管理员
 *   npm run admin -- unban <用户名>     # 解封
 *   npm run admin -- ban <用户名> [原因] # 手动封号（联调用）
 *   npm run admin -- audit <用户名>     # 查看封号审计记录
 *
 * ⚠️ 安全：本脚本只能在本机有文件系统访问权限时运行，绝不暴露成 HTTP 接口。
 */
import '../src/lib/env'; // 先加载 .env，确保 DATABASE_URL 就绪
import { prisma } from '../src/lib/prisma';
import { parseAdminUsernames } from '../src/lib/account';

function usage(): void {
  console.log([
    '用法: npm run admin -- <命令> [参数]',
    '  list                    列出全部账号及角色/封号状态',
    '  grant <用户名>          设为管理员（同时解封）',
    '  revoke <用户名>         撤销管理员',
    '  unban <用户名>          解封',
    '  ban <用户名> [原因]      手动封号',
    '  audit <用户名>          查看该账号的封号审计记录',
  ].join('\n'));
}

async function main(): Promise<void> {
  const [cmd, ...args] = process.argv.slice(2);
  if (!cmd || cmd === 'help' || cmd === '-h') {
    usage();
    return;
  }

  if (cmd === 'list') {
    const users = await prisma.user.findMany({
      orderBy: { createdAt: 'asc' },
      select: { id: true, username: true, role: true, bannedAt: true, banReason: true },
    });
    const whitelist = parseAdminUsernames(process.env.ADMIN_USERNAMES);
    console.log(`ADMIN_USERNAMES 白名单: ${whitelist.size ? [...whitelist].join(', ') : '(未配置)'}`);
    console.log(`共 ${users.length} 个账号：`);
    for (const u of users) {
      const admin = u.role === 'admin' || whitelist.has(u.username.toLowerCase());
      const state = u.bannedAt ? `已封号(${u.banReason ?? '无原因'})` : '正常';
      console.log(`  ${u.username.padEnd(24)} role=${u.role.padEnd(6)} admin=${admin ? 'Y' : 'N'} ${state}`);
    }
    return;
  }

  const username = args[0];
  if (!username) {
    console.error('缺少用户名参数');
    usage();
    process.exitCode = 1;
    return;
  }
  const user = await prisma.user.findUnique({ where: { username } });
  if (!user) {
    console.error(`账号不存在: ${username}`);
    process.exitCode = 1;
    return;
  }

  switch (cmd) {
    case 'grant': {
      await prisma.user.update({
        where: { id: user.id },
        data: { role: 'admin', bannedAt: null, banReason: null },
      });
      console.log(`OK: ${username} 已设为管理员并解封`);
      break;
    }
    case 'revoke': {
      await prisma.user.update({ where: { id: user.id }, data: { role: 'player' } });
      console.log(`OK: ${username} 已撤销管理员`);
      break;
    }
    case 'unban': {
      await prisma.user.update({
        where: { id: user.id },
        data: { bannedAt: null, banReason: null },
      });
      console.log(`OK: ${username} 已解封`);
      break;
    }
    case 'ban': {
      const reason = args.slice(1).join(' ') || '管理员手动封号';
      await prisma.$transaction([
        prisma.banRecord.create({
          data: { userId: user.id, codes: '["MANUAL"]', reason, stats: null },
        }),
        prisma.user.update({
          where: { id: user.id },
          data: { bannedAt: new Date(), banReason: reason },
        }),
      ]);
      console.log(`OK: ${username} 已封号（${reason}）`);
      break;
    }
    case 'audit': {
      const records = await prisma.banRecord.findMany({
        where: { userId: user.id },
        orderBy: { createdAt: 'desc' },
      });
      console.log(`${username} 共 ${records.length} 条封号记录：`);
      for (const r of records) {
        console.log(`  ${r.createdAt.toISOString()} codes=${r.codes} reason=${r.reason}`);
      }
      break;
    }
    default: {
      console.error(`未知命令: ${cmd}`);
      usage();
      process.exitCode = 1;
    }
  }
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
