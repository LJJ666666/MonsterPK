/**
 * 榜单周期结算命令行入口（F01/F02）。
 *
 * 用法：
 *   npm run rank:settle --                       # 默认结算上一个已结束周期
 *   npm run rank:settle -- 2026-11-08            # 指定周期（可传多个）
 *   npm run rank:settle -- --recent=3            # 最近 3 个已结束周期
 *
 * 生产用 cron 在周期结束点调用即可，不需要常驻定时器；本脚本只连库、不启 HTTP。
 * 幂等：重复执行不会重复发奖，也不会覆盖首次快照。
 */
import { prisma } from '../src/lib/prisma';
import { settlePeriod } from '../src/modules/rankSettlement';
import { previousPeriodKey, recentClosedPeriodKeys, parsePeriodKey } from '../src/game/period';

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const recentArg = args.find((a) => a.startsWith('--recent='));
  const explicit = args.filter((a) => !a.startsWith('--'));
  let keys: string[];
  if (recentArg) {
    const n = Number(recentArg.slice('--recent='.length));
    keys = recentClosedPeriodKeys(Date.now(), Number.isFinite(n) ? n : 2);
  } else if (explicit.length) {
    keys = explicit;
  } else {
    keys = [previousPeriodKey(Date.now())];
  }

  for (const key of keys) {
    if (!parsePeriodKey(key)) {
      console.error(`[跳过] 非法周期键：${key}（应为 YYYY-MM-DD）`);
      process.exitCode = 1;
      continue;
    }
    const r = await settlePeriod(key);
    console.log(JSON.stringify(r, null, 2));
    if (!r.ok || r.rewardsFailed > 0) process.exitCode = 1;
  }
}

main()
  .catch((e) => {
    console.error('[失败] 榜单周期结算异常：', e);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
