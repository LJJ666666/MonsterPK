/**
 * 性能基线 §6 的 adb 真机补测（雷电模拟器 14 / emulator-5558）。
 *
 * 设计约束（来自 .trae/documents/雷电模拟器_adb操作规范_2026-11-11.md）：
 *  - 全程命令行取证，**不发任何 input tap**（桌面 Dock 是广告位，盲点会静默装游戏）。
 *  - 每次启动后用 `mCurrentFocus` 校验前台确实是 com.monster.game。
 *  - 唯一按键是 keyevent 3（HOME），用于后台恢复测试，不涉坐标。
 *  - 冷启动用 am force-stop；本项目 APK 没有无障碍服务，不存在 03 篇「force-stop 摘权限」的坑。
 *
 * 用法：node scripts/perf-adb.mjs [--device emulator-5558] [--out <json路径>]
 * 前置：APK 已安装、宿主机 3001 后端在跑、雷电模拟器已启动。
 */
import { execFileSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';

const ADB = 'D:/game/leidian/LDPlayer14/adb.exe';
const PKG = 'com.monster.game';
const ACT = `${PKG}/.MainActivity`;
const arg = (k, d) => {
  const i = process.argv.indexOf(k);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : d;
};
const DEVICE = arg('--device', 'emulator-5558');
const OUT = arg('--out', '.trae/documents/性能基线_adb_真机数据_2026-11-11.json');

function adb(args, { quiet = false } = {}) {
  try {
    return execFileSync(ADB, ['-s', DEVICE, ...args], {
      encoding: 'utf8',
      timeout: 60_000,
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (e) {
    if (quiet) return '';
    throw new Error(`adb ${args.join(' ')} 失败: ${e.message}`);
  }
}
const shell = (cmd, opt) => adb(['shell', cmd], opt);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const num = (s) => {
  const m = String(s ?? '').match(/-?\d+(?:\.\d+)?/);
  return m ? Number(m[0]) : null;
};

function parseStart(text) {
  const pick = (k) => {
    const m = text.match(new RegExp(`${k}:\\s+(\\d+)`));
    return m ? Number(m[1]) : null;
  };
  return { thisTime: pick('ThisTime'), totalTime: pick('TotalTime'), waitTime: pick('WaitTime') };
}

function focusOk() {
  const f = shell('dumpsys window displays | grep mCurrentFocus', { quiet: true });
  return f.includes(PKG);
}

const result = {
  collectedAt: new Date().toISOString(),
  device: DEVICE,
  pkg: PKG,
  environment: {},
  coldStart: [],
  gfx: {},
  memory: {},
  resume: {},
  consoleErrors: [],
  checks: [],
};
const check = (name, ok, evidence) => {
  result.checks.push({ name, ok: !!ok, evidence });
  console.log(`${ok ? '[OK]' : '[FAIL]'} ${name}${evidence ? ' :: ' + String(evidence).slice(0, 160) : ''}`);
};

async function main() {
  // 0. 环境与前置
  const devices = adb(['devices', '-l']);
  check('设备在线', devices.includes(DEVICE) && devices.includes('device'), devices.split('\n').slice(1).join(' | '));
  result.environment.model = shell('getprop ro.product.model', { quiet: true });
  result.environment.android = shell('getprop ro.build.version.release', { quiet: true });
  result.environment.sdk = shell('getprop ro.build.version.sdk', { quiet: true });
  result.environment.screen = shell('wm size', { quiet: true }).replace(/\s+/g, ' ');
  result.environment.density = shell('wm density', { quiet: true }).replace(/\s+/g, ' ');
  const installed = shell(`pm list packages ${PKG}`, { quiet: true });
  check('APK 已安装', installed.includes(PKG), installed);
  // 宿主机 IP 随网络变化，跨机器复用时用 MPK_API_BASE 覆盖（默认本机实测值）。
  const apiBase = process.env.MPK_API_BASE ?? 'http://192.168.111.47:3001';
  const health = shell(`curl -s --max-time 4 ${apiBase}/api/health`, { quiet: true });
  check('设备可直连宿主机后端', health.includes('"ok":true'), health.slice(0, 120));

  // 1. APK 冷启动到首帧（x3）
  for (let i = 1; i <= 3; i++) {
    shell(`am force-stop ${PKG}`, { quiet: true });
    shell('logcat -c', { quiet: true });
    await sleep(500);
    const started = shell(`am start -W -n ${ACT}`, { quiet: true });
    const t = parseStart(started);
    await sleep(1600);
    const focus = focusOk();
    // WebView 首屏渲染证据：uiautomator dump 能取到文本节点即说明首帧已绘制
    shell('uiautomator dump /sdcard/_mpk_ui.xml >/dev/null 2>&1', { quiet: true });
    const ui = shell('cat /sdcard/_mpk_ui.xml', { quiet: true });
    const hasAppText = /兽域手记|继续游戏|登录|营地/.test(ui);
    result.coldStart.push({ run: i, ...t, focusOk: focus, firstFrameNodes: hasAppText, raw: started.split('\n').filter((l) => /Time|Status|Activity/.test(l)).join(' | ') });
    console.log(`  冷启动 #${i}: ThisTime=${t.thisTime}ms TotalTime=${t.totalTime}ms WaitTime=${t.waitTime}ms focus=${focus} 首帧=${hasAppText}`);
  }
  check('冷启动 x3 均成功且前台正确', result.coldStart.every((r) => r.totalTime != null && r.focusOk), JSON.stringify(result.coldStart.map((r) => r.totalTime)));
  check('WebView 首帧已渲染（控件树含应用文案）', result.coldStart.some((r) => r.firstFrameNodes), JSON.stringify(result.coldStart.map((r) => r.firstFrameNodes)));

  // 2. WebView 实际 FPS / 掉帧分布（dumpsys gfxinfo framestats）
  // 实测口径（雷电 14 / Android 14）：静态登录页静置 4s 时 Total frames rendered = 0
  // —— 无持续重绘，此时读 framestats 拿到的是空数据。因此 FPS 采样窗口必须覆盖
  // 「冷启动渲染」，并在结果里同时保留静置对照，避免把 0 帧误读为性能结果。
  shell(`dumpsys gfxinfo ${PKG} reset`, { quiet: true });
  await sleep(4000);
  const idle = shell(`dumpsys gfxinfo ${PKG} framestats`, { quiet: true });
  const idleFrames = num((idle.match(/Total frames rendered:\s*(\d+)/) || [])[1] ?? '');

  shell(`am force-stop ${PKG}`, { quiet: true });
  shell(`dumpsys gfxinfo ${PKG} reset`, { quiet: true });
  const winStart = shell(`am start -W -n ${ACT}`, { quiet: true });
  await sleep(3000);
  const gfx = shell(`dumpsys gfxinfo ${PKG} framestats`, { quiet: true });
  const grab = (label) => {
    const m = gfx.match(new RegExp(`${label}[^\\d]*([\\d.]+)`));
    return m ? Number(m[1]) : null;
  };
  result.gfx = {
    idleFrames,
    sampleWindow: '冷启动渲染窗口（force-stop → am start -W → 3s）',
    windowStartTotalTime: parseStart(winStart).totalTime,
    focusOkAfterWindow: focusOk(),
    framesRendered: grab('Total frames rendered'),
    jankyFrames: grab('Janky frames'),
    jankyPercent: grab('Janky frames') != null && grab('Total frames rendered') ? +(grab('Janky frames') / grab('Total frames rendered') * 100).toFixed(2) : null,
    percentile50: grab('50th percentile'),
    percentile90: grab('90th percentile'),
    percentile95: grab('95th percentile'),
    percentile99: grab('99th percentile'),
    missedVsync: grab('Number Missed Vsync'),
    slowUI: grab('Number Slow UI thread'),
    rawTail: gfx.split('\n').slice(-28).join('\n'),
    sample: gfx.slice(0, 700),
  };
  check('静置对照：静态页面无持续重绘（idle 0 帧）', idleFrames === 0, `idleFrames=${idleFrames}`);
  check('冷启动渲染窗口采到帧数据', result.gfx.framesRendered != null && result.gfx.framesRendered > 0, JSON.stringify({ frames: result.gfx.framesRendered, janky: result.gfx.jankyFrames, p90: result.gfx.percentile90 }));
  check('帧采样时前台仍是本应用', result.gfx.focusOkAfterWindow, `focus=${result.gfx.focusOkAfterWindow}`);
  console.log('  gfxinfo:', JSON.stringify({ idleFrames, frames: result.gfx.framesRendered, janky: result.gfx.jankyFrames, pct: result.gfx.jankyPercent, p90: result.gfx.percentile90 }));

  // 3. 内存 / WebView OOM 观测
  const mem = shell(`dumpsys meminfo ${PKG}`, { quiet: true });
  const memNum = (label) => {
    const line = mem.split('\n').find((l) => l.trim().startsWith(label));
    return line ? num(line.replace(label, '')) : null;
  };
  result.memory = {
    totalPss: memNum('TOTAL'),
    dalvikHeap: memNum('Dalvik Heap'),
    nativeHeap: memNum('Native Heap'),
    views: (mem.match(/Views:\s+(\d+)/) || [])[1] ?? null,
    activities: (mem.match(/Activities:\s+(\d+)/) || [])[1] ?? null,
    raw: mem.slice(0, 1400),
  };
  const logs = shell('logcat -d -v time', { quiet: true });
  const bad = logs.split('\n').filter((l) => /FATAL|OutOfMemoryError|SIGABRT|WebView.*crash|ANR/i.test(l));
  result.memory.oomSignals = bad.slice(0, 10);
  result.consoleErrors = logs.split('\n').filter((l) => /Console|TypeError|Uncaught|net::ERR|ERR_CLEARTEXT|mixed content/i.test(l)).slice(0, 20);
  check('无 OOM / 崩溃 / ANR 信号', bad.length === 0, bad.slice(0, 2).join(' | ') || 'clean');
  check('内存采样有效', result.memory.totalPss != null, JSON.stringify({ pss: result.memory.totalPss, dalvik: result.memory.dalvikHeap }));
  console.log('  meminfo:', JSON.stringify({ pss: result.memory.totalPss, dalvik: result.memory.dalvikHeap, views: result.memory.views }));

  // 4. 后台切回恢复耗时
  shell('input keyevent 3', { quiet: true }); // HOME，非坐标点击
  await sleep(2200);
  const focusAfterHome = focusOk();
  shell('logcat -c', { quiet: true });
  const restarted = shell(`am start -W -n ${ACT}`, { quiet: true });
  const rt = parseStart(restarted);
  await sleep(1200);
  result.resume = { ...rt, homeTookBackground: !focusAfterHome, focusAfterResume: focusOk(), raw: restarted.split('\n').filter((l) => /Time|Status|Activity/.test(l)).join(' | ') };
  check('HOME 后确实进入后台', result.resume.homeTookBackground, `focusAfterHome=${focusAfterHome}`);
  // 雷电 14 的 `am start -W` 不输出 ThisTime 行（冷启动与 resume 均无），
  // 且 resume 场景会打印 "Activity not started, its current task has been brought to the front"。
  // 因此恢复耗时以 TotalTime 为准，判据用 TotalTime + 前台校验，不用 thisTime。
  check('后台恢复成功且前台正确', result.resume.totalTime != null && result.resume.focusAfterResume, JSON.stringify({ totalTime: result.resume.totalTime, waitTime: result.resume.waitTime, focus: result.resume.focusAfterResume, thisTime: '雷电不输出' }));
  console.log('  后台恢复:', JSON.stringify(rt));

  // 5. 收尾：只清理本脚本自己写的前缀文件（白名单法，绝不 rm -rf /sdcard/*）
  shell('rm -f /sdcard/_mpk_ui.xml', { quiet: true });

  const pass = result.checks.filter((c) => c.ok).length;
  console.log(`\nPERF_ADB_RESULT ${pass}/${result.checks.length}`);
  console.log(JSON.stringify({ coldStartMs: result.coldStart.map((r) => r.totalTime), gfx: { frames: result.gfx.framesRendered, janky: result.gfx.jankyFrames, p90: result.gfx.percentile90 }, memPss: result.memory.totalPss, resumeMs: result.resume.totalTime }, null, 2));
  writeFileSync(OUT, JSON.stringify(result, null, 2), 'utf8');
  console.log(`结果已写入 ${OUT}`);
  if (pass !== result.checks.length) process.exitCode = 1;
}

main().catch((e) => {
  console.error('PERF_ADB_FATAL', e.message);
  process.exitCode = 1;
});
