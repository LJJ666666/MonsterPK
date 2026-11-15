#!/usr/bin/env node
/**
 * 测试资产静态门禁（2026-11-15，纯静态、不需要任何服务）。
 *
 * 起因：全量验收长期用 `--skip=smoke`，14 个浏览器冒烟静默失效两个月没被发现；
 * 而 verify 的 STAGES / GROUPS 必须两处同时登记（漏 GROUPS 会静默少跑）、
 * 36 套 E2E 全靠共享 Suite.done() 设置失败退出码（被改坏就会假绿）。
 * 本脚本把「编排完整性 / 防假绿 / 发布构建配置」三类不变量固化成断言，
 * 由 `npm run verify` 的 check:inventory 阶段每轮自动核对。
 *
 * 运行：node scripts/test_inventory.mjs
 * 输出：TEST_INVENTORY_RESULT pass=N fail=N；有失败时 exitCode=1。
 */
import { readFileSync, existsSync, readdirSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
const BACKEND = join(ROOT, 'backend');
const results = [];

function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name}${ok ? '' : ` « ${detail}`}`);
}
function read(rel, base = ROOT) {
  return readFileSync(resolve(base, rel), 'utf8');
}
function has(rel, needle, base = ROOT) {
  return read(rel, base).includes(needle);
}

// ─────────────────────── 1. verify 编排完整性 ───────────────────────
const verify = read('scripts/verify.mjs');
const stageBlock = verify.slice(verify.indexOf('const STAGES = ['), verify.indexOf('const GROUPS = {'));
const groupBlock = verify.slice(verify.indexOf('const GROUPS = {'), verify.indexOf('// —————————————————————————— 参数'));
const stageLines = stageBlock.split('\n').filter((l) => /^\s*\{ id: '/.test(l));
const ids = stageLines.map((l) => l.match(/id: '([^']+)'/)[1]);

const groups = {};
for (const m of groupBlock.matchAll(/^\s*(\w+): \[([^\]]*)\]/gm)) {
  groups[m[1]] = m[2].split(',').map((s) => s.trim().replace(/^'|'$/g, '')).filter(Boolean);
}
const grouped = groups ? Object.values(groups).flat() : [];

check('STAGES 无重复 id', new Set(ids).size === ids.length, `ids=${ids.length} unique=${new Set(ids).size}`);
check('每个 STAGE 都登记在某个 GROUPS 分组（漏登记＝静默少跑）',
  ids.every((id) => grouped.includes(id)),
  ids.filter((id) => !grouped.includes(id)).join(', '));
check('GROUPS 里没有指向不存在阶段的幽灵 id',
  grouped.every((id) => ids.includes(id)),
  grouped.filter((id) => !ids.includes(id)).join(', '));
check('GROUPS 内部无重复阶段', new Set(grouped).size === grouped.length,
  `grouped=${grouped.length} unique=${new Set(grouped).size}`);

const rootPkg = JSON.parse(read('package.json'));
const backPkg = JSON.parse(read('package.json', BACKEND));
const missingScript = [];
const missingFile = [];
const npmRun = [];
for (const line of stageLines) {
  const id = line.match(/id: '([^']+)'/)[1];
  const cwdIsBackend = /cwd: BACKEND/.test(line);
  const args = (line.match(/args: \[([^\]]*)\]/)?.[1] ?? '')
    .split(',').map((s) => s.trim().replace(/^'|'$/g, ''));
  const pkg = cwdIsBackend ? backPkg : rootPkg;
  let target = null;
  if (args[0] === 'run') {
    const key = args[1];
    npmRun.push(key);
    const cmd = pkg.scripts?.[key];
    if (!cmd) missingScript.push(`${id} -> ${key}`);
    else {
      // 只核命令里第一个实体脚本；glob（"tests/**/*.test.ts"）由下方单独断言。
      const m = cmd.match(/(?:--import\s+\w+\s+|node\s+|tsx\s+)([^\s"']+\.(?:mjs|js|ts|cjs))/);
      if (m) target = m[1];
    }
  } else if (args[0]?.startsWith('scripts/')) {
    target = args[0];
  }
  if (target && !existsSync(resolve(cwdIsBackend ? BACKEND : ROOT, target))) {
    missingFile.push(`${id} -> ${target}`);
  }
}
check('每个阶段引用的 npm script 都存在', missingScript.length === 0, missingScript.join(', '));
check('每个阶段引用的脚本文件都存在', missingFile.length === 0, missingFile.join(', '));

const e2eScripts = Object.keys(backPkg.scripts).filter((k) => k === 'e2e' || k.startsWith('e2e:'));
check('后端全部 e2e npm scripts 都进 verify（防漏跑）',
  e2eScripts.every((k) => npmRun.includes(k)),
  e2eScripts.filter((k) => !npmRun.includes(k)).join(', '));

const smokeFiles = readdirSync(join(ROOT, 'scripts')).filter((f) => /^ui_smoke_.*\.mjs$/.test(f));
const smokeRegistered = stageLines
  .filter((l) => /^smoke:/.test(l.match(/id: '([^']+)'/)[1]))
  .map((l) => l.match(/scripts\/(ui_smoke_[\w]+\.mjs)/)?.[1])
  .filter(Boolean);
check('全部 UI 冒烟脚本都登记在 verify（防僵尸脚本）',
  smokeFiles.length === smokeRegistered.length && smokeFiles.every((f) => smokeRegistered.includes(f)),
  `files=${smokeFiles.length} registered=${smokeRegistered.length}`);

check('前端 vitest include 覆盖 src/**/*.test.{ts,tsx}',
  has('vite.config.ts', "include: ['src/**/*.test.{ts,tsx}']"));
check('后端 node:test glob 仍为 tests/**/*.test.ts',
  backPkg.scripts.test.includes('tests/**/*.test.ts'));
check('前端 / 后端单测文件都非空',
  readdirSync(join(ROOT, 'src/lib')).some((f) => f.endsWith('.test.ts'))
  && readdirSync(join(BACKEND, 'tests')).some((f) => f.endsWith('.test.ts')));

// ─────────────────────── 2. 防假绿：结果汇总与失败退出码 ───────────────────────
const harness = read('tests/lib/harness.mjs', BACKEND);
check('共享 Suite.done() 失败时仍会置 process.exitCode = 1',
  /done\(\)[\s\S]{0,600}process\.exitCode = 1/.test(harness));

const e2eDir = join(BACKEND, 'tests');
const e2eFiles = readdirSync(e2eDir).filter((f) => /^e2e_.*\.mjs$/.test(f));
// E2E 有两代合法范式：老 6 套是自定义 function check() + E2E_*_RESULT/[SUMMARY]
// + process.exit(1)，新 30 套用共享 Suite 的 s.check() / suite.done()。两者都要认，
// 但「零断言」「没有结果汇总或失败退出」一律判红 —— 否则 verify 会把空套件当通过。
const noAssert = [];
const noExit = [];
for (const f of e2eFiles) {
  const t = read(`tests/${f}`, BACKEND);
  const checkCalls = (t.match(/\bcheck\(/g) || []).length
    - (t.match(/function\s+check\(/g) || []).length;
  if (checkCalls < 3) noAssert.push(`${f}(${checkCalls})`);
  const suiteDone = /\.done\(\)/.test(t);
  const legacyResult = /E2E\w*_RESULT pass=|\[SUMMARY\]/.test(t)
    && /process\.exit\(|process\.exitCode = 1/.test(t);
  if (!suiteDone && !legacyResult) noExit.push(f);
}
check('每套 E2E 至少 3 条断言（两代 check 范式都计数）', noAssert.length === 0, noAssert.join(', '));
check('每套 E2E 有 Suite.done() 或旧式汇总+失败退出码', noExit.length === 0, noExit.join(', '));

const smokeNoResult = [];
const smokeNoExit = [];
for (const f of smokeFiles) {
  const t = read(`scripts/${f}`);
  if (!/UI_SMOKE\w*_RESULT pass=/.test(t)) smokeNoResult.push(f);
  if (!/process\.exit\(1\)|process\.exitCode = 1/.test(t)) smokeNoExit.push(f);
}
check('每个 UI 冒烟都打印 UI_SMOKE_*_RESULT 汇总', smokeNoResult.length === 0, smokeNoResult.join(', '));
check('每个 UI 冒烟失败时都会非零退出', smokeNoExit.length === 0, smokeNoExit.join(', '));
check('verify 的 summarize 能识别静态门禁结果',
  /TEST_INVENTORY_RESULT/.test(verify));

// ─────────────────────── 3. 发布构建配置（P5-3）不变量 ───────────────────────
const mainManifest = read('android/app/src/main/AndroidManifest.xml');
const debugManifest = read('android/app/src/debug/AndroidManifest.xml');
const gradle = read('android/app/build.gradle');
const props = read('android/gradle.properties');
const capCfg = read('capacitor.config.ts');
const envExample = read('backend/.env.example');

check('main manifest 不全局放行明文（release 泄漏点）',
  !/usesCleartextTraffic/.test(mainManifest));
check('明文只在 debug sourceSet 放行',
  /usesCleartextTraffic="true"/.test(debugManifest));
check('release 签名只从四个 MPK_KEYSTORE_* 变量取材料',
  ['MPK_KEYSTORE_FILE', 'MPK_KEYSTORE_PASSWORD', 'MPK_KEY_ALIAS', 'MPK_KEY_PASSWORD']
    .every((k) => gradle.includes(k)));
check('缺签名材料时 assembleRelease fail-closed',
  /taskGraph\.whenReady/.test(gradle) && /assembleRelease/.test(gradle) && /GradleException/.test(gradle));
check('版本号由 gradle.properties 提供且可 -P 覆盖',
  /mpkVersionCode/.test(props) && /mpkVersionName/.test(props)
  && /findProperty\('mpkVersionCode'\)/.test(gradle) && /findProperty\('mpkVersionName'\)/.test(gradle));
check('正式包不带 dev server 段：http/明文只在 MPK_DEV_APK 分支',
  /MPK_DEV_APK/.test(capCfg) && /\?\s*\{\s*server:/s.test(capCfg)
  && /androidScheme: 'http'/.test(capCfg));
check('生产 CORS 示例含 Capacitor 正式包 origin https://localhost',
  /https:\/\/localhost/.test(envExample));
check('dev APK origin http://localhost 仍在 CORS 示例',
  /http:\/\/localhost(?!:)/.test(envExample));
check('API_BASE 由 VITE_API_BASE 一处注入（REST + WS 共用）',
  /VITE_API_BASE/.test(read('src/lib/api.ts')));

// ─────────────────────── 4. 冒烟宿主：public/_*.html 原样返回 ───────────────────────
const viteCfg = read('vite.config.ts');
check('Vite 已移除本地存档时代的 /api/save 文件读写',
  !/localSaveMiddleware|save_data\.json/.test(viteCfg));
check('Vite 提供 public/_*.html 原样返回中间件且 dev/preview 都挂载',
  /devProbePlugin/.test(viteCfg)
  && /Content-Type', 'text\/html; charset=utf-8'/.test(viteCfg)
  && (viteCfg.match(/middlewares\.use\(devProbeMiddleware\)/g) || []).length === 2);
check('public/_*.html 仍被 watch 忽略（HMR 不得打断冒烟采样）',
  /ignored: \['\*\*\/public\/_\*\.html'\]/.test(viteCfg));

// ─────────────────────── 汇总 ───────────────────────
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
console.log(`\nTEST_INVENTORY_RESULT pass=${pass} fail=${fail}`);
if (fail > 0) {
  console.log('TEST_INVENTORY_FAILED');
  process.exitCode = 1;
} else {
  console.log('TEST_INVENTORY_OK');
}
