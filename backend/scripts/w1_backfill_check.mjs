/**
 * P5-1 W1 验收脚本：验证 Save.revision 回填「原值照搬、不跳号、脏数据给 0、可重跑」。
 *
 *   cd backend && node scripts/w1_backfill_check.mjs
 *
 * 需要可连的 Postgres（不进 npm test：CI 只跑无服务单测）。
 * 全程在一个事务里造 4 行假数据、执行 backfill_revision.sql、断言后主动回滚，
 * 不留任何脏数据；输出 `W1_BACKFILL_RESULT pass=N fail=0` 才算通过。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const sqlPath = fileURLToPath(new URL('../prisma/backfill_revision.sql', import.meta.url));
const sql = readFileSync(sqlPath, 'utf8')
  .split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .trim();

let pass = 0;
let fail = 0;
function check(title, ok, detail = '') {
  if (ok) pass += 1;
  else fail += 1;
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${title}${ok ? '' : `  « ${detail}`}`);
}

const { PrismaClient } = await import('@prisma/client');
const prisma = new PrismaClient();
const ROLLBACK = 'W1_BACKFILL_CHECK_ROLLBACK';
const tag = `w1bf_${Date.now()}`;
const cases = [
  { key: 'rev7', authority: JSON.stringify({ expected: {}, revision: 7 }), expected: 7 },
  { key: 'null', authority: null, expected: 0 },
  { key: 'badjson', authority: '{not json', expected: 0 },
  { key: 'emptyobj', authority: '{}', expected: 0 },
];

try {
  await prisma.$transaction(async (tx) => {
    for (const c of cases) {
      await tx.user.create({
        data: { id: `${tag}_${c.key}_u`, username: `${tag}_${c.key}`, password: 'x' },
      });
      await tx.save.create({
        data: {
          id: `${tag}_${c.key}_s`,
          userId: `${tag}_${c.key}_u`,
          data: '{}',
          authority: c.authority,
          revision: 0,
        },
      });
    }

    await tx.$executeRawUnsafe(sql);
    for (const c of cases) {
      const row = await tx.save.findUnique({
        where: { id: `${tag}_${c.key}_s` },
        select: { revision: true },
      });
      check(
        `${c.key}: authority=${c.authority === null ? 'NULL' : c.authority.slice(0, 32)} → revision ${c.expected}（原值照搬，不 +1）`,
        row?.revision === c.expected,
        `got=${row?.revision}`,
      );
    }

    // 幂等：再跑一次，已回填的 7 不能被 WHERE revision=0 的兜底改回 0
    await tx.$executeRawUnsafe(sql);
    const again = await tx.save.findUnique({
      where: { id: `${tag}_rev7_s` },
      select: { revision: true },
    });
    check('重复执行回填幂等（revision 7 不被改写）', again?.revision === 7, `got=${again?.revision}`);

    throw new Error(ROLLBACK); // 主动回滚，假数据不落库
  }, { timeout: 20_000 });
} catch (e) {
  if (e?.message !== ROLLBACK) throw e;
} finally {
  await prisma.$disconnect();
}

console.log(`W1_BACKFILL_RESULT pass=${pass} fail=${fail}`);
process.exit(fail === 0 ? 0 : 1);
