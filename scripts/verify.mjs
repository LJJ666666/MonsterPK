#!/usr/bin/env node
/**
 * 一键全量验收编排器（2026-11-07）。
 *
 * 背景：项目此前要手动按顺序敲 8~10 条命令（前后端 check/test/build、内容表、
 * 六组 E2E、浏览器冒烟、文档自检），漏跑、顺序错、看错结果都很常见。
 * 本脚本把它们收敛成一条命令，并给出机器可读报告。
 *
 * 用法：
 *   node scripts/verify.mjs                  # 全量（需要前后端服务已启动）
 *   node scripts/verify.mjs --only=check,unit # 只跑类型检查与单测（无需服务）
 *   node scripts/verify.mjs --skip=e2e,smoke  # 跳过需要服务的阶段
 *   node scripts/verify.mjs --only=e2e:hardening
 *   node scripts/verify.mjs --strict          # 服务没起时视为失败（CI 用）
 *
 * 分组别名：
 *   check  前端/后端类型检查 + 内容表一致性
 *   unit   前端 vitest + 后端 node:test
 *   build  前端构建
 *   e2e    后端端到端（含对抗套件，阶段数以脚本输出为准）
 *   smoke  375px 浏览器冒烟
 *   docs   文档与记忆镜像自检
 *
 * 退出码：0 全绿（允许 SKIP）；1 有失败。
 * 报告：`.verify-report.json`（已 gitignore），供排查与趋势对比。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createLogSession } from './lib/verifyLogger.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = resolve(ROOT, 'backend');
const IS_WIN = process.platform === 'win32';
const NPM = IS_WIN ? 'npm.cmd' : 'npm';
const PY = IS_WIN ? 'python' : 'python3';

// —————————————————————————— 阶段定义 ——————————————————————————

/** @typedef {{id:string,name:string,cwd:string,cmd:string,args:string[],need?:'backend'|'front'|'both',timeout?:number}} Stage */

/** @type {Stage[]} */
const STAGES = [
  { id: 'front:check', name: '前端类型检查', cwd: ROOT, cmd: NPM, args: ['run', 'check'] },
  { id: 'front:test', name: '前端单测（vitest）', cwd: ROOT, cmd: NPM, args: ['test'], timeout: 300_000 },
  { id: 'front:build', name: '前端构建', cwd: ROOT, cmd: NPM, args: ['run', 'build'], timeout: 300_000 },
  { id: 'back:check', name: '后端类型检查', cwd: BACKEND, cmd: NPM, args: ['run', 'check'] },
  { id: 'back:test', name: '后端单测（node:test）', cwd: BACKEND, cmd: NPM, args: ['test'], timeout: 300_000 },
  { id: 'back:content', name: '服务端内容表一致性', cwd: BACKEND, cmd: NPM, args: ['run', 'check:content'] },
  { id: 'e2e:save', name: 'E2E 存档校验与风控', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p12', name: 'E2E 权威裁决（P1-2）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p12'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p21', name: 'E2E 实时通道（P2-1）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p21'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p22', name: 'E2E 在线权威态（P2-2）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p22'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p31', name: 'E2E 服务端战斗（P3-1）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p31'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p32', name: 'E2E 服务端存档写操作（P3-2）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p32'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p4', name: 'E2E 写入并发控制（P4）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p4'], need: 'backend', timeout: 300_000 },
  // W2：DB 条件更新是 409 的唯一裁决；脚本会临时拉起 :3002 做双进程并发。
  { id: 'e2e:w2', name: 'E2E W2 DB 条件更新 CAS（含双进程并发）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:w2'], need: 'backend', timeout: 300_000 },
  // W3：Redis 租约锁；脚本会临时拉起 :3002 并预占账号锁证明写路径确实跨进程互斥。
  { id: 'e2e:w3', name: 'E2E W3 Redis 分布式锁（含双进程并发）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:w3'], need: 'backend', timeout: 300_000 },
  // W4：全局 sweep 选主 + fencing + 幂等键；真 Redis 双 leader 模拟双实例，不抢常驻 :3001 的租约。
  { id: 'e2e:w4', name: 'E2E W4 定时器选主与幂等（真 Redis）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:w4'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p41', name: 'E2E 顶号与共享野怪（P4-1）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p41'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p42a', name: 'E2E 只读派生榜（P4-2a）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p42a'], need: 'backend', timeout: 300_000 },
  // P4-2b：房间内核 E2E（backend/tests/e2e_p42b_room.mjs），双账号掉线 / 重连 / 托管 / 全掉不扣次数。
  { id: 'e2e:p42b', name: 'E2E 房间内核（P4-2b）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p42b'], need: 'backend', timeout: 300_000 },
  // P4-2c：单人 Boss 讨伐 + 伤害榜 E2E（伤害只认服务端结算、次数按账号、榜只读）。
  { id: 'e2e:p42c', name: 'E2E 单人 Boss 讨伐（P4-2c）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p42c'], need: 'backend', timeout: 300_000 },
  // P4-2d：1v1 玩家对战 E2E（双方意图服务端裁决、结算写双方档各一次）。
  { id: 'e2e:p42d', name: 'E2E 1v1 玩家对战（P4-2d）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p42d'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:p42e', name: 'E2E 共斗 Boss / 副本（P4-2e）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:p42e'], need: 'backend', timeout: 300_000 },
  // F01/F02：周期结算幂等 + 服务端发奖 + 历史榜只读（远古周期键，重复运行安全）。
  { id: 'e2e:f01f02', name: 'E2E 周期结算与榜单奖励（F01/F02）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f01f02'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:f14', name: 'E2E Boss 双档奖励（F14）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f14'], need: 'backend', timeout: 300_000 },
  // F16：六房副本 E2E（全清发奖 / 最低贡献门槛 / 幂等 / 每日 3 次上限）。
  { id: 'e2e:f16', name: 'E2E 六房副本发奖（F16）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f16'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:f04', name: 'E2E 徽章 / 成就 / 等级（F04）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f04'], need: 'backend', timeout: 300_000 },
  // F17：单档化闸门（?slot= 400）+ 一账号一档 + 响应/DB 均无 slot。
  { id: 'e2e:f17', name: 'E2E 单档化（F17）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f17'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:f18a', name: 'E2E 地图锁（F18-a）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f18a'], need: 'backend', timeout: 300_000 },
  // F18-b：演武堂挑战（胜发徽章 + 20min 馆主休息 CD + 禁捕获 + 逃跑不发奖）。
  { id: 'e2e:f18b', name: 'E2E 演武堂挑战（F18-b）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f18b'], need: 'backend', timeout: 300_000 },
  // F18-c：地图首领（不上榜 + 每日次数上限 + 解锁门槛 + 胜发掉落 / 逃跑不发奖）。
  { id: 'e2e:f18c', name: 'E2E 地图首领（F18-c）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f18c'], need: 'backend', timeout: 300_000 },
  // F18-c 防御性：伪造/越权/顶号/超上限/跨用户/幂等/放弃泄漏回归。
  { id: 'e2e:f18c_security', name: 'E2E 地图首领防御性越权（F18-c）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:f18c_security'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:core_loop', name: 'E2E 核心循环串联（野怪→演武堂→Boss→地图首领→共斗）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:core_loop'], need: 'backend', timeout: 300_000 },
  // 回归 B/E：内容完整度矩阵 + 边界 + 5 个只读接口伪上报闸门对照（不重复 hardening / f18c_security）。
  { id: 'e2e:content_matrix', name: 'E2E 内容完整度 / 边界 / 只读闸门矩阵（回归 B·E）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:content_matrix'], need: 'backend', timeout: 300_000 },
  { id: 'e2e:hardening', name: 'E2E 对抗攻防（115 项）', cwd: BACKEND, cmd: NPM, args: ['run', 'e2e:hardening'], need: 'backend', timeout: 300_000 },
  { id: 'smoke:ui', name: '375px 浏览器冒烟', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p21.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p31c', name: '375px 前端服务端战斗链路（P3-1c）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p31c.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p41', name: '375px 共享野怪 UI（P4-1）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p41.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p42a', name: '375px 只读派生榜 UI（P4-2a）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p42a.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p42c', name: '375px 讨伐 UI（P4-2c）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p42c.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p42d', name: '375px 1v1 对战 UI（P4-2d）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p42d.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:p42e', name: '375px 共斗 UI（P4-2e）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_p42e.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:f01f02', name: '375px 周期榜与奖励 UI（F01/F02）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f01f02.mjs'], need: 'both', timeout: 300_000 },
  // F16：六房地图四态 + 进房按钮 + 375px 无横向溢出。
  { id: 'smoke:f16', name: '375px 六房副本 UI（F16）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f16.mjs'], need: 'both', timeout: 300_000 },
  { id: 'smoke:f04', name: '375px 徽章 / 成就 UI（F04）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f04.mjs'], need: 'both', timeout: 300_000 },
  // F18-a：营地地图 Tab 地区锁定提示（前置城镇徽章，修复循环依赖）+ 375px 无横向溢出。
  { id: 'smoke:f18a', name: '375px 地图地区锁定 UI（F18-a）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f18a.mjs'], need: 'both', timeout: 300_000 },
  // F18-b：演武堂弹窗 + 点首城馆主「挑战馆主」真进战斗（/arena）+ 375px 无横向溢出。
  { id: 'smoke:f18b', name: '375px 演武堂 UI（F18-b）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f18b.mjs'], need: 'both', timeout: 300_000 },
  // F18-c：地图首领弹窗 + 掉落预览 + 点首城首领「挑战」真进战斗（/arena）+ 375px 无横向溢出。
  { id: 'smoke:f18c', name: '375px 地图首领 UI（F18-c）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_f18c.mjs'], need: 'both', timeout: 300_000 },
  // 回归 C：Start 页三种状态文案 + 剧情/徽章弹窗 + 全局封号/顶号弹窗的滚动、换行与可关闭。
  { id: 'smoke:ux', name: '375px 全局状态与弹窗 UX（回归 C）', cwd: ROOT, cmd: 'node', args: ['scripts/ui_smoke_ux.mjs'], need: 'both', timeout: 300_000 },
  { id: 'docs:doc', name: '文档一致性自检', cwd: ROOT, cmd: PY, args: ['scripts/doc_check.py'] },
  { id: 'docs:memory', name: '记忆镜像校验', cwd: ROOT, cmd: PY, args: ['scripts/sync_memory.py', '--check'] },
];

const GROUPS = {
  check: ['front:check', 'back:check', 'back:content'],
  unit: ['front:test', 'back:test'],
  build: ['front:build'],
  e2e: ['e2e:save', 'e2e:p12', 'e2e:p21', 'e2e:p22', 'e2e:p31', 'e2e:p32', 'e2e:p4', 'e2e:w2', 'e2e:w3', 'e2e:w4', 'e2e:p41', 'e2e:p42a', 'e2e:p42b', 'e2e:p42c', 'e2e:p42d', 'e2e:p42e', 'e2e:f01f02', 'e2e:f14', 'e2e:f16', 'e2e:f04', 'e2e:f17', 'e2e:f18a', 'e2e:f18b', 'e2e:f18c', 'e2e:f18c_security', 'e2e:core_loop', 'e2e:content_matrix', 'e2e:hardening'],
  smoke: ['smoke:ui', 'smoke:p31c', 'smoke:p41', 'smoke:p42a', 'smoke:p42c', 'smoke:p42d', 'smoke:p42e', 'smoke:f01f02', 'smoke:f16', 'smoke:f04', 'smoke:f18a', 'smoke:f18b', 'smoke:f18c', 'smoke:ux'],
  docs: ['docs:doc', 'docs:memory'],
};

// —————————————————————————— 参数 ——————————————————————————

const argv = process.argv.slice(2);
const valueOf = (flag) => argv.find((a) => a.startsWith(`--${flag}=`))?.split('=').slice(1).join('=');
/** 每轮完整日志目录；默认 .verify-logs/<runId>/，可用 --log-dir=xxx 指定固定目录便于多轮对照。 */
const logDirRaw = valueOf('log-dir');
const logger = createLogSession(ROOT, logDirRaw ? { dir: logDirRaw } : {});
if (!argv.includes('--quiet')) console.log(`本轮日志：${logger.base}`);
const onlyRaw = valueOf('only');
const skipRaw = valueOf('skip');
const strict = argv.includes('--strict');
const quiet = argv.includes('--quiet');
/** 默认在跑完 E2E 后统一清理测试账号；--no-clean 可保留以便排查。 */
const noClean = argv.includes('--no-clean');

/** 把组别名或 stage id 解析成 stage id 集合。 */
function expand(raw) {
  const set = new Set();
  if (!raw) return set;
  for (const token of raw.split(',').map((s) => s.trim()).filter(Boolean)) {
    if (GROUPS[token]) GROUPS[token].forEach((id) => set.add(id));
    else set.add(token);
  }
  return set;
}

const onlySet = expand(onlyRaw);
const skipSet = expand(skipRaw);
let stages = STAGES.filter((s) => (onlySet.size === 0 || onlySet.has(s.id)) && !skipSet.has(s.id));

if (stages.length === 0) {
  console.error('没有匹配的阶段。可用分组：check / unit / build / e2e / smoke / docs');
  process.exit(2);
}
const unknown = [...onlySet].filter((id) => !STAGES.some((s) => s.id === id));
if (unknown.length > 0) {
  console.error(`未知阶段：${unknown.join(', ')}`);
  console.error(`可用阶段：${STAGES.map((s) => s.id).join(', ')}`);
  process.exit(2);
}

// —————————————————————————— 工具 ——————————————————————————

/** Windows 控制台可能是 GBK，先按 UTF-8 解，出现替换字符再退 GBK。 */
function decode(buf) {
  if (!buf || buf.length === 0) return '';
  const utf8 = buf.toString('utf8');
  if (!utf8.includes('\uFFFD')) return utf8;
  try { return new TextDecoder('gbk').decode(buf); } catch { return utf8; }
}

/** 从输出里提炼一行关键指标，失败时也便于判断原因。 */
function summarize(out) {
  // 后端 E2E：两代格式并存（E2E_RESULT pass=N / [SUMMARY] 39/39 通过）
  const mE2E = out.match(/E2E\w*_RESULT pass=(\d+) fail=(\d+)/);
  if (mE2E) return `${mE2E[1]} 项通过${Number(mE2E[2]) ? `，${mE2E[2]} 失败` : ''}`;
  const mSummary = out.match(/\[SUMMARY\] (\d+)\/(\d+) 通过/);
  if (mSummary) return `${mSummary[1]}/${mSummary[2]} 通过`;

  // 前端 375px 冒烟（UI_SMOKE_RESULT / UI_SMOKE_P31C_RESULT 等带后缀的变体）
  const mUI = out.match(/UI_SMOKE(?:_\w+)?_RESULT pass=(\d+) fail=(\d+)/);
  if (mUI) return `${mUI[1]} 项通过${Number(mUI[2]) ? `，${mUI[2]} 失败` : ''}`;

  // 后端 node:test
  const mNodePass = out.match(/^# pass (\d+)$/m);
  if (mNodePass) {
    const mNodeFail = out.match(/^# fail (\d+)$/m);
    return `${mNodePass[1]} 项通过${mNodeFail && Number(mNodeFail[1]) ? `，${mNodeFail[1]} 失败` : ''}`;
  }

  // 前端 vitest
  const mVitest = out.match(/Tests\s+(\d+)\s+passed/);
  if (mVitest) return `${mVitest[1]} 项通过`;

  // 文档自检：统计 [OK] 行数
  if (/DOC_CHECK_OK/.test(out)) {
    const ok = (out.match(/^\[OK\]/gm) || []).length;
    return `${ok} 项通过`;
  }

  // 记忆镜像：输出形如 [一致] workbuddy sha256=xxx  trae sha256=xxx
  const mMirror = out.match(/\[一致\] workbuddy sha256=(\w+)/);
  if (mMirror) return `镜像一致 sha256=${mMirror[1]}`;

  // 内容表一致性
  if (/\[一致\] content\.generated\.ts/.test(out)) return '内容表一致';

  const mBuilt = out.match(/built in ([\d.]+m?s)/);
  if (mBuilt) return `构建完成（${mBuilt[1]}）`;

  // 类型检查成功时通常只有 npm 回显：过滤掉 banner 后为空即视为无告警
  const meaningful = out
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && !l.startsWith('>') && !/^npm (warn|notice|error)/i.test(l));
  if (meaningful.length === 0) return '通过（无告警）';

  return meaningful[meaningful.length - 1].slice(0, 120);
}

/** 失败时摘出最有信息量的几行，避免整屏刷。 */
function tail(out, n = 12) {
  const lines = out.trim().split('\n').filter((l) => l.trim().length > 0);
  return lines.slice(-n).join('\n');
}

async function probe(url, timeoutMs = 3_000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: ctrl.signal });
    return res.ok || (res.status >= 200 && res.status < 500);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function runStage(stage) {
  const started = Date.now();
  const r = spawnSync(stage.cmd, stage.args, {
    cwd: stage.cwd,
    shell: IS_WIN,
    encoding: 'buffer',
    timeout: stage.timeout ?? 600_000,
    env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' },
  });
  const ms = Date.now() - started;
  let out = decode(r.stdout) + decode(r.stderr);
  // spawn 级错误（命令不存在 / 阶段超时 / 被宿主回收）原本只表现为「空输出 + 非零退出码」，
  // 复盘时看不出是脚本失败还是进程被杀，故显式写进输出与日志。
  const notes = [];
  if (r.error) notes.push(`[SPAWN_ERROR] ${String(r.error?.message || r.error)} code=${r.error?.code ?? 'unknown'}`);
  if (r.signal) notes.push(`[SIGNAL] ${r.signal}`);
  if (notes.length) out += `\n${notes.join('\n')}\n`;
  return {
    code: r.status ?? 1,
    out,
    ms,
    signal: r.signal ?? null,
    error: r.error ? String(r.error?.message || r.error) : null,
    timedOut: r.error?.code === 'ETIMEDOUT',
  };
}

// —————————————————————————— 主流程 ——————————————————————————

const needService = stages.some((s) => s.need);
import { FRONT_PORT, FRONT_PROBE } from './lib/devConfig.mjs';
let backendUp = true;
let frontUp = true;
if (needService) {
  if (!quiet) console.log('检查服务可用性…');
  [backendUp, frontUp] = await Promise.all([
    probe('http://127.0.0.1:3001/api/health'),
    probe(FRONT_PROBE),
  ]);
  if (!quiet) {
    console.log(`  后端 :3001 ${backendUp ? '在线' : '离线'} / 前端 :${FRONT_PORT} ${frontUp ? '在线' : '离线'}`);
  }
}

// —————————————————————————— 前置清理 ——————————————————————————
// 上一轮 verify 若中途失败，收尾清理可能没跑到，残留测试账号的存档会进入全服榜 /
// 派生统计并挤占 limit，让下一轮 E2E 假红（2026-11-09 实测：256 个残留账号导致
// e2e:p42a 三条派生断言失败，单独重跑却 39/39 全绿）。因此开跑前先清一次，
// 保证每轮都从干净基线开始；--no-clean 仍可保留排查能力。
let preCleaned = null;
if (!noClean && backendUp && stages.some((s) => s.id.startsWith('e2e:'))) {
  process.stdout.write('▶ 前置清理残留测试账号 … ');
  const c = runStage({ cwd: BACKEND, cmd: NPM, args: ['run', 'clean:e2e'], timeout: 120_000 });
  const m = c.out.match(/删除测试账号 (\d+) 个/);
  preCleaned = m ? Number(m[1]) : null;
  console.log(c.code === 0 ? `✓ 删除 ${preCleaned ?? '?'} 个` : '⚠ 清理失败（继续验收）');
}

const results = [];
for (const stage of stages) {
  const missing =
    (stage.need === 'backend' && !backendUp) ||
    (stage.need === 'front' && !frontUp) ||
    (stage.need === 'both' && !(backendUp && frontUp));

  if (missing) {
    const reason = stage.need === 'both'
      ? `需要前端 ${FRONT_PORT} 与后端 3001 同时在线`
      : `需要${stage.need === 'front' ? `前端 ${FRONT_PORT}` : '后端 3001'}在线`;
    if (strict) {
      results.push({ id: stage.id, name: stage.name, status: 'FAIL', ms: 0, metric: reason, out: '' });
      console.log(`✗ ${stage.name} — ${reason}`);
    } else {
      results.push({ id: stage.id, name: stage.name, status: 'SKIP', ms: 0, metric: reason, out: '' });
      console.log(`- ${stage.name} — 跳过（${reason}）`);
    }
    continue;
  }

  process.stdout.write(`▶ ${stage.name} … `);
  const { code, out, ms, signal, error, timedOut } = runStage(stage);
  const ok = code === 0;
  const metric = summarize(out);
  const logFile = logger.write(stage, { code, out, ms, signal, error, timedOut });
  results.push({ id: stage.id, name: stage.name, status: ok ? 'PASS' : 'FAIL', ms, metric, out, logFile });

  const seconds = (ms / 1000).toFixed(1);
  console.log(`${ok ? '✓' : '✗'} ${metric || ''} (${seconds}s)`);
  if (!ok && !quiet) {
    console.log('  ── 输出末尾 ──');
    for (const line of tail(out, 30).split('\n')) console.log(`  ${line}`);
    console.log(`  ── 完整日志：${logFile}`);
    console.log('  ──────────────');
  }
}

// —————————————————————————— 测试账号清理 ——————————————————————————

// 旧 E2E 脚本（p12 / p21 / p22 / p31）不自清理，长期跑会让 数据库 里堆满临时账号。
// 统一在这里收尾：只删测试前缀账号，管理员账号永不删除。
let cleaned = null;
if (!noClean && stages.some((s) => s.id.startsWith('e2e:'))) {
  process.stdout.write('▶ 清理测试账号 … ');
  const c = runStage({ cwd: BACKEND, cmd: NPM, args: ['run', 'clean:e2e'], timeout: 120_000 });
  const m = c.out.match(/删除测试账号 (\d+) 个/);
  cleaned = m ? Number(m[1]) : null;
  if (c.code === 0) {
    console.log(`✓ 删除 ${cleaned ?? '?'} 个（--no-clean 可保留排查）`);
  } else {
    // 清理失败不影响验收结论，但要让人看见
    console.log('⚠ 清理失败，可手动 npm run clean:e2e');
  }
}

// —————————————————————————— 汇总 ——————————————————————————

const passed = results.filter((r) => r.status === 'PASS').length;
const failed = results.filter((r) => r.status === 'FAIL').length;
const skipped = results.filter((r) => r.status === 'SKIP').length;
const totalMs = results.reduce((a, r) => a + r.ms, 0);

console.log('\n══ 验收汇总 ══');
for (const r of results) {
  const mark = r.status === 'PASS' ? '✓' : r.status === 'SKIP' ? '-' : '✗';
  const time = r.ms >= 1000 ? ` ${(r.ms / 1000).toFixed(1)}s` : '';
  console.log(`${mark} ${r.name.padEnd(24, ' ')} ${r.metric}${time}`);
}
console.log(`\n通过 ${passed} / 失败 ${failed} / 跳过 ${skipped}，合计 ${(totalMs / 1000).toFixed(1)}s`);

const report = {
  at: new Date().toISOString(),
  runId: logger.runId,
  logDir: logger.base,
  totals: { passed, failed, skipped, ms: totalMs },
  services: { backend: backendUp, front: frontUp },
  cleanedTestAccounts: cleaned,
  preCleanedTestAccounts: preCleaned,
  // 失败阶段把输出首尾都存进报告 + 指向落盘的完整日志：跨套件偶发失败
  // （共享野怪池 / 在途名额 / 心跳相位等进程内残留）只靠 metric 无法定位。
  stages: results.map((r) => ({
    id: r.id, name: r.name, status: r.status, ms: r.ms, metric: r.metric,
    ...(r.logFile ? { logFile: r.logFile } : {}),
    ...(r.status === 'FAIL' ? {
      outHead: String(r.out ?? '').slice(0, 4000),
      outTail: String(r.out ?? '').slice(-32000),
    } : {}),
  })),
};
try {
  writeFileSync(resolve(ROOT, '.verify-report.json'), `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  logger.writeIndex({
    at: report.at,
    totals: report.totals,
    services: report.services,
    preCleanedTestAccounts: preCleaned,
    cleanedTestAccounts: cleaned,
    reportStages: report.stages.map((r) => ({ id: r.id, status: r.status, metric: r.metric })),
  });
} catch {
  // 报告写不进去不影响验收结论
}

if (failed > 0) {
  console.log('VERIFY_FAILED');
  process.exitCode = 1;
} else if (skipped > 0 && strict) {
  console.log('VERIFY_INCOMPLETE');
  process.exitCode = 1;
} else {
  console.log('VERIFY_OK');
}
