/**
 * 清理历史测试账号（`npm run clean:e2e`）。
 *
 * 背景：每组 E2E / 冒烟都会注册临时账号。正常运行时脚本会自清理，
 * 但中断、`--keep`、失败退出会留下残留，长期跑会让 dev.db 里的 Save 表膨胀。
 *
 * 用法：
 *   npm run clean:e2e                    # 按内置前缀清理
 *   npm run clean:e2e -- --dry           # 只列出将删除的账号
 *   npm run clean:e2e -- --prefix=foo_,bar_   # 临时追加前缀
 *
 * 安全：只按用户名前缀匹配，且**永不删除 role=admin 的账号**。
 */
import { cleanupByPrefix } from '../tests/lib/harness.mjs';

const DRY = process.argv.includes('--dry');
/** 各代 E2E / 冒烟脚本用过的账号前缀（含 P1-2 / P2-1 时期的旧命名）。 */
const BASE_PREFIXES = ['e2e_', 'ui_', 'harden_', 'hd_', 'edge_', 'bt_', 'p12_', 'ws_', 'b3a_', 'b3b_', 'ss_', 'p41_', 'p42a_', 'p42b_', 'p42c_', 'p42d_', 'p42e_', 'f01_', 'f02_', 'f14_', 'f16_', 'f04_', 'f17_', 'f18_', 'core_', 'matrix_', 'ux_'];
const extra = process.argv
  .find((a) => a.startsWith('--prefix='))
  ?.split('=').slice(1).join('=')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean) ?? [];
const PREFIXES = [...new Set([...BASE_PREFIXES, ...extra])];

try {
  const r = await cleanupByPrefix(PREFIXES, { dryRun: DRY });
  if (DRY) {
    console.log(`[dry-run] 命中 ${r.users} 个测试账号：`);
    for (const n of r.names.slice(0, 40)) console.log(`  - ${n}`);
    if (r.names.length > 40) console.log(`  ... 其余 ${r.names.length - 40} 个`);
  } else {
    console.log(`[清理完成] 删除测试账号 ${r.users} 个 / 意图记录 ${r.intents} 条`);
  }
  console.log(`匹配前缀：${PREFIXES.join(', ')}（管理员账号永不删除）`);
} catch (e) {
  console.error('清理失败：', e);
  process.exitCode = 1;
}
