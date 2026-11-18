#!/usr/bin/env node
/**
 * L1/L2 演示包出包脚本（demo-app）。
 *
 * 一键完成：构建 mock 前端 → 拷入 Android assets → gradle assembleDebug → 恢复主工程默认 assets。
 * 所有工具链路径 env 覆盖 → 常见位置探测 → 明确报错，不写死单机绝对路径。
 *
 * 用法：
 *   node demo-app/build-apk.mjs
 *   MPK_ADB=/path/to/adb node demo-app/build-apk.mjs --install   # 出包后装到设备
 *
 * env:
 *   MPK_JAVA_HOME / JAVA_HOME, MPK_ANDROID_HOME / ANDROID_HOME,
 *   MPK_GRADLE, MPK_GRADLE_USER_HOME, MPK_ADB
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));   // demo-app/
const repo = path.resolve(here, '..');                        // 主工程根
const dist = path.join(here, 'dist');
const pub = path.join(repo, 'android/app/src/main/assets/public');
const apkDebug = path.join(repo, 'android/app/build/outputs/apk/debug/app-debug.apk');
const apkOut = path.join(here, 'output/兽域手记_演示包.apk');
const install = process.argv.includes('--install');

function pick(label, envKeys, candidates, test) {
  for (const k of envKeys) {
    const v = process.env[k];
    if (v && fs.existsSync(v) && test(v)) return v;
  }
  for (const c of candidates) {
    if (c && fs.existsSync(c) && test(c)) return c;
  }
  throw new Error(`[demo-app] 找不到 ${label}。请设置环境变量：${envKeys.join(' / ')}。已探测：${candidates.join(', ')}`);
}
const exists = (p) => fs.existsSync(p);
const isDir = (p) => { try { return fs.statSync(p).isDirectory(); } catch { return false; } };

function run(cmd, args, opts = {}) {
  console.log(`\n$ ${cmd} ${args.join(' ')}`);
  // Node 22 起 Windows .bat/.cmd 必须 shell:true，否则 spawnSync EINVAL/-4071。
  const shell = opts.shell ?? /\.bat$/i.test(cmd);
  execFileSync(cmd, args, { stdio: 'inherit', cwd: opts.cwd || repo, shell, ...opts });
}

// 0. 探测工具链 + 备份当前 android assets（默认版），出完包无论成功失败都要恢复。
// 注意：系统层 JAVA_HOME 常被注入成 JDK17（本机实测），不能当默认；项目用 JDK21。
// 只有显式 MPK_JAVA_HOME 才优先，普通 JAVA_HOME 放到候选之后。
const javaHome = pick('JDK21', ['MPK_JAVA_HOME'],
  ['E:/Six/jdk/jdk-21', 'D:/jdk21', process.env.JAVA_HOME].filter(Boolean), isDir);
const androidHome = pick('Android SDK', ['MPK_ANDROID_HOME', 'ANDROID_HOME'],
  ['E:/Six/android-sdk', 'D:/android-sdk'], isDir);
// Gradle 是无扩展名 sh 脚本：Node spawnSync 直调会 ENOENT / .bat 会走 cmd 用错 JVM。
// 统一用 Git Bash 执行 POSIX 命令（项目惯例：绕开 gradlew 用 bin/gradle）。
const bash = pick('Git Bash', ['MPK_BASH'], [
  'C:/Program Files/Git/bin/bash.exe', 'C:/Program Files/Git/usr/bin/bash.exe',
  'D:/software/WorkBuddy/resources/vendor/PortableGit/usr/bin/bash.exe',
  'D:/software/WorkBuddy/resources/vendor/PortableGit/bin/bash.exe',
], exists);
const gradle = pick('Gradle 8.14.3', ['MPK_GRADLE'],
  ['E:/Six/gradle-dist/gradle-8.14.3/bin/gradle', 'D:/Six/gradle-dist/gradle-8.14.3/bin/gradle'], exists);
const gradleUserHome = pick('Gradle user home', ['MPK_GRADLE_USER_HOME'],
  ['E:/Six/gradle-user-home', 'D:/Six/gradle-user-home'], isDir);
// Windows 绝对路径 → POSIX（/e/Six/...），供 bash 内部使用。
const toPosixPath = (p) => p.replace(/\\/g, '/').replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase());

const backup = fs.mkdtempSync(path.join(os.tmpdir(), 'mpk-assets-'));
for (const name of fs.readdirSync(pub)) {
  fs.cpSync(path.join(pub, name), path.join(backup, name), { recursive: true });
}
console.log(`[demo-app] 已备份默认 assets → ${backup}`);

function restoreAssets() {
  // 清掉 mock 版文件，再拷回默认版，保证主工程工作区不被污染。
  for (const name of fs.readdirSync(pub)) {
    fs.rmSync(path.join(pub, name), { recursive: true, force: true });
  }
  for (const name of fs.readdirSync(backup)) {
    fs.cpSync(path.join(backup, name), path.join(pub, name), { recursive: true });
  }
  fs.rmSync(backup, { recursive: true, force: true });
  console.log('[demo-app] 已恢复主工程默认 assets。');
}

try {
  // 1. 构建 mock 前端（用 demo-app 自己的 config，输出到 demo-app/dist）。
  const viteBin = pick('Vite', ['MPK_VITE_BIN'], [path.join(repo, 'node_modules/vite/bin/vite.js')], exists);
  run(process.execPath, [viteBin, 'build', '--config', path.join(here, 'vite.config.ts')], { cwd: repo });

  if (!fs.existsSync(path.join(dist, 'index.html'))) throw new Error('[demo-app] mock 构建未产出 dist/index.html');

  // 2. 把 mock 产物拷进 android assets（覆盖默认版；cordova.js 等 Capacitor 文件保留）。
  const copyInto = (srcDir, dstDir) => {
    for (const name of fs.readdirSync(srcDir)) {
      const s = path.join(srcDir, name), d = path.join(dstDir, name);
      if (isDir(s)) { fs.mkdirSync(d, { recursive: true }); copyInto(s, d); }
      else fs.copyFileSync(s, d);
    }
  };
  // 先清 assets/ 子目录里的旧 chunk（默认版与 mock 版文件名不同，避免残留）。
  fs.rmSync(path.join(pub, 'assets'), { recursive: true, force: true });
  copyInto(dist, pub);
  console.log('[demo-app] mock 产物已拷入 android assets。');

  // 3. gradle assembleDebug（经 Git Bash，POSIX env，JVM=21）。
  const q = (s) => `"${s}"`;
  const gradleCmd = [
    `JAVA_HOME=${q(toPosixPath(javaHome))}`,
    `ANDROID_HOME=${q(toPosixPath(androidHome))}`,
    `GRADLE_USER_HOME=${q(toPosixPath(gradleUserHome))}`,
    `${q(toPosixPath(gradle))} -p ${q(toPosixPath(path.join(repo, 'android')))} assembleDebug --offline --console=plain --no-daemon`,
  ].join(' ');
  run(bash, ['-c', gradleCmd], { cwd: repo });
  if (!fs.existsSync(apkDebug)) throw new Error(`[demo-app] gradle 成功但没找到 APK: ${apkDebug}`);

  // 4. 输出明确命名的 APK 副本（gitignore 忽略）。
  fs.mkdirSync(path.dirname(apkOut), { recursive: true });
  fs.copyFileSync(apkDebug, apkOut);
  console.log(`[demo-app] APK 已输出: ${apkOut} (${(fs.statSync(apkOut).size / 1048576).toFixed(1)} MB)`);

  // 5. 可选：安装到设备。
  if (install) {
    const adb = pick('adb', ['MPK_ADB'],
      ['D:/game/leidian/LDPlayer14/adb.exe', 'E:/Six/platform-tools/adb.exe', 'D:/android-sdk/platform-tools/adb.exe'], exists);
    run(adb, ['devices'], { cwd: repo });
    run(adb, ['install', '-r', apkOut], { cwd: repo });
    console.log('[demo-app] 已安装到设备。可 `adb shell am start -n com.monster.game/.MainActivity` 启动。');
  }
} finally {
  // 无论构建成功与否，都恢复主工程默认 assets —— 隔离的最后一道闸。
  restoreAssets();
}
