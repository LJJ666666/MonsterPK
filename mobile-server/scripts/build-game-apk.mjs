#!/usr/bin/env node
/**
 * mobile-server：构建「连真后端」的默认 debug 游戏 APK（非 mock）。
 *
 * 与 demo-app/build-apk.mjs 的区别：不做 mock 构建、不替换 assets。
 * 直接确认当前主工程 assets 是真前端（无 mock 痕迹），走 gradle assembleDebug，
 * 把 APK 拷到 mobile-server/output/。主工程源码与 assets 零改动。
 *
 * 用法：node mobile-server/scripts/build-game-apk.mjs [--install]
 * env：MPK_JAVA_HOME / MPK_ANDROID_HOME / MPK_GRADLE / MPK_GRADLE_USER_HOME / MPK_ADB
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));      // mobile-server/scripts
const msDir = path.resolve(here, '..');                          // mobile-server/
const repo = path.resolve(msDir, '..');                          // 主工程根
const pub = path.join(repo, 'android/app/src/main/assets/public');
const apkDebug = path.join(repo, 'android/app/build/outputs/apk/debug/app-debug.apk');
const apkOut = path.join(msDir, 'output/monsterpk-debug.apk');
const install = process.argv.includes('--install');

function pick(label, envKeys, candidates, test) {
  for (const k of envKeys) { const v = process.env[k]; if (v && fs.existsSync(v) && test(v)) return v; }
  for (const c of candidates) if (c && fs.existsSync(c) && test(c)) return c;
  throw new Error(`[mobile-server] 找不到 ${label}，请设置 ${envKeys.join(' / ')}`);
}
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };
const run = (cmd, args, opts = {}) => {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || repo,
    shell: opts.shell ?? /\.bat$/i.test(cmd), ...opts });
};

// 0. 守卫：确认当前 assets 是真前端（无 mock 痕迹），否则拒绝出包。
const jsFiles = fs.readdirSync(path.join(pub, 'assets')).filter((f) => f.endsWith('.js'));
const bundled = jsFiles.map((f) => fs.readFileSync(path.join(pub, 'assets', f), 'utf8')).join('\n');
if (/mock-demo|"12860"|演示账号|api\.mock/.test(bundled)) {
  throw new Error('[mobile-server] 当前 assets 含 mock 痕迹，拒绝构建！请先恢复主工程默认 assets。');
}
if (!/localhost:3001/.test(bundled)) {
  throw new Error('[mobile-server] 当前 assets 未指向 localhost:3001，API_BASE 异常，拒绝构建。');
}
console.log('[mobile-server] assets 守卫通过：真前端，API_BASE=localhost:3001');

// 1. 探测工具链（路径 env 覆盖 → 常见位置探测，禁写死单机绝对路径）。
const javaHome = pick('JDK21', ['MPK_JAVA_HOME'],
  ['E:/Six/jdk/jdk-21', 'D:/jdk21', process.env.JAVA_HOME].filter(Boolean), isDir);
const androidHome = pick('Android SDK', ['MPK_ANDROID_HOME', 'ANDROID_HOME'],
  ['E:/Six/android-sdk', 'D:/android-sdk'], isDir);
const bash = pick('Git Bash', ['MPK_BASH'], [
  'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe',
  'D:/software/WorkBuddy/resources/vendor/PortableGit/usr/bin/bash.exe',
  'D:/software/WorkBuddy/resources/vendor/PortableGit/bin/bash.exe',
], (p) => fs.existsSync(p));
const gradle = pick('Gradle 8.14.3', ['MPK_GRADLE'],
  ['E:/Six/gradle-dist/gradle-8.14.3/bin/gradle', 'D:/Six/gradle-dist/gradle-8.14.3/bin/gradle'],
  (p) => fs.existsSync(p));
const gradleUserHome = pick('Gradle user home', ['MPK_GRADLE_USER_HOME'],
  ['E:/Six/gradle-user-home', 'D:/Six/gradle-user-home'], isDir);
const toPosix = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());
const q = (s) => `"${s}"`;

// 2. gradle assembleDebug（真前端 assets，JDK21）。
const gradleCmd = [
  `JAVA_HOME=${q(toPosix(javaHome))}`,
  `ANDROID_HOME=${q(toPosix(androidHome))}`,
  `GRADLE_USER_HOME=${q(toPosix(gradleUserHome))}`,
  `${q(toPosix(gradle))} -p ${q(toPosix(path.join(repo, 'android')))} assembleDebug --offline --console=plain --no-daemon`,
].join(' ');
run(bash, ['-c', gradleCmd], { cwd: repo });
if (!fs.existsSync(apkDebug)) throw new Error(`[mobile-server] gradle 后无 APK: ${apkDebug}`);

fs.mkdirSync(path.dirname(apkOut), { recursive: true });
fs.copyFileSync(apkDebug, apkOut);
console.log(`\n[mobile-server] 真后端 debug APK: ${apkOut} (${(fs.statSync(apkOut).size/1048576).toFixed(1)} MB)`);

if (install) {
  const adb = pick('adb', ['MPK_ADB'],
    ['D:/game/leidian/LDPlayer14/adb.exe', 'E:/Six/platform-tools/adb.exe'], (p) => fs.existsSync(p));
  run(adb, ['install', '-r', apkOut], { cwd: repo });
  console.log('[mobile-server] 游戏 APK 已安装到设备。');
}
