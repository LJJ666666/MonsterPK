# DEVICE.md —— 真机（vivo / Android 16）自托管部署手册

> 目标：在 vivo 真机上**不连电脑**跑真后端 + 游戏 APK，达到 L3 等价真自测（真注册/真存档/真战斗，服务端裁决）。
> 架构：arm64。Termux 原生跑 PG(5432)+Redis(6379)，proot Debian 跑 Node20+Prisma+后端(3001)，游戏 WebView 连 `http://localhost:3001`。
> 与 `demo-app/`（L1/L2 mock）、雷电那套（x86_64）**完全隔离**，主工程源码零改动。

---

## 0. 可行性结论（已取证，2026-11-19）

| 关注点 | 结论 | 证据 |
|---|---|---|
| Android 16 能否跑 proot | ✅ 能 | ColorOS(Android16) 已实证 proot-distro 跑 Ubuntu；proot 靠 ptrace 模拟，Android 16 未禁 |
| Prisma engine arm64 | ✅ 支持 | 官方系统要求：ARM64 + Debian glibc 2.24+ + OpenSSL 3.x 支持；trixie(glibc 2.41/OpenSSL3) 符合。`schema.prisma` 未写死 `binaryTargets`，generate 自动选 |
| `http://localhost:3001` 跨 App | ✅ 不受 LNP 影响 | Android 16 LNP 管的是 LAN 地址（WiFi/以太网广播域）；`127.0.0.1` loopback 不算 LAN，游戏 targetSdk 34 也不在 LNP 强制范围 |
| 最大风险 | ⚠️ 后台被杀 | Android 12+ phantom process killer + vivo FuntouchOS 激进内存管理 → 必须做 §4 保活 |
| Termux 来源 | 只用 GitHub 版 | Play 版停更、新安卓崩溃；用 v0.118.3 **arm64-v8a**（不是 aarch64 命名，实际资产名） |

---

## 1. 宿主机一次性准备（电脑，约 10-20 分钟下载）

```bash
cd E:/Six/MonsterPK/mobile-server

# 1) 下 arm64 三件套（Termux arm64-v8a APK + Node arm64 + Debian aarch64 rootfs）
bash scripts/fetch-arm64.sh

# 2) 构建真后端游戏 APK（真前端 assets，非 mock；需 JDK21/SDK/Gradle）
node scripts/build-game-apk.mjs

# 3) 打后端源码包（纯源码，不含 node_modules）
node scripts/pack-backend.mjs

# 4) 连上手机（USB 调试），装 App + push 全部文件
MPK_ADB=<你的adb路径> bash scripts/install-device.sh
```

> 下载脚本走 ghfast 镜像 + npmmirror，带断点续传和大小校验；三个包：35MB / 25MB / 35MB。
> 若 `fetch-arm64.sh` 报大小不符，删掉对应文件重跑（脚本会自动断点续传）。
> 无线调试：`adb connect 手机IP:端口` 后也可跑 install-device.sh，不必插线。

产物落在 `mobile-server/output/`：`termux-arm64-v8a.apk`、`monsterpk-debug.apk`、三个 `*.tar.gz`/`*.tar.xz`。

---

## 2. 手机端一次性部署

打开 Termux（GitHub 版），依次执行：

```bash
# 授权存储访问（弹窗点允许）
termux-setup-storage

# 换国内源（镜像菜单选 Tsinghua 或 Aliyun，加速后续下载）
termux-change-repo

# 一次性部署：装 proot-distro/tmux + 原生 PG/Redis + proot Debian(Node+Prisma+后端)
bash /sdcard/mpk/device-setup.sh
```

`device-setup.sh` 会做：initdb 建库 `monsterpk`、起 5432/6379、从本地 aarch64 rootfs 装 Debian、解压 Node arm64、`npm install`、`prisma generate`（自动选 arm64 engine）+ `migrate deploy`。首次约 3-8 分钟（proot 走 ptrace，比原生慢）。

看到 `=== DEVICE_SETUP_DONE ===` 即成功。失败看 `~/logs/device-setup.log` 和 `~/logs/device-bootstrap.log`。

---

## 3. 日常启动 + 自检

```bash
# 起服务（唤醒锁 + PG/Redis + tmux 会话前台持有后端）
bash /sdcard/mpk/device-start.sh

# 自检：health 应为 HTTP=200
bash /sdcard/mpk/device-check.sh
```

看到 `HEALTH=200 后端已就绪` 后，打开游戏 APK → 注册任意账号 → 登录 → 打一场野战/馆主，经验/金币真变化即验收通过。

- 看日志：`tail -f /sdcard/mpk/backend-device.log`
- 停服务：`bash /sdcard/mpk/device-stop.sh`（PG/Redis 保留；下次 `device-start.sh` 直接起后端）
- 进后端会话排查：`tmux attach -t mpk`（`Ctrl+b` 然后 `d` 退出但保持运行）

> **为什么用 tmux**：雷电上验证过——proot 子进程会随发起它的 shell 退出而被回收，`nohup`/`setsid` 都挡不住。真机改用 tmux 会话让 proot **前台常驻**，tmux daemon 由 Termux 持有，切到游戏 App 后端不断。

---

## 4. ⚠️ vivo Android 16 保活（不做会半夜被杀，必配）

Android 12+ 的 phantom process killer（单个 App 子进程超 32 个就 SIGKILL）+ vivo FuntouchOS 的激进内存管理，是最大风险。四层全配：

**① 电池不优化**
设置 → 应用 → Termux → 电池 → 选「无限制 / 允许后台运行 / 不优化」（不要选智能控制）。

**② 自启动 + 后台活动（vivo/FuntouchOS 特有）**
设置 → 应用 → Termux → 允许「自启动」「后台活动」；i管家/手机管家 → 权限隐私 → 自启动管理 → Termux 打开。

**③ 锁定后台任务**
打开 Termux → 最近任务界面 → Termux 卡片下拉/长按 → 点「锁定」（小锁图标），一键清理内存时不会误杀。

**④ 开发者选项关幽灵进程杀手**
设置 → 系统/关于手机 → 连点「版本号」7 次开开发者选项 → 找到「**禁用子进程限制 / Disable child process restrictions**」打开（Android 14+ 有此开关）。
若无此开关，可用无线调试 ADB（无需电脑，手机本地执行）：
```
setprop debug.app_process_limit 65536
settings put global phantom_process_killer 0
```
> 另：`device-start.sh` 已调 `termux-wake-lock` 防 CPU 深睡；如需更强，装 `termux-api` 后加前台通知常驻。

---

## 5. 已知坑与对策

| 坑 | 对策 |
|---|---|
| Termux 下载被限流 | fetch-arm64.sh 断点续传 + 大小校验；只从 GitHub 资产 + ghfast，别用 Play 版 |
| `/sdcard` noexec，脚本不能直接执行 | 一律 `bash /sdcard/mpk/xxx.sh`，不要 `./xxx.sh` |
| 截图/点击看着一样但没生效 | 先确认 health 真 200 再看 UI，别用字节相同截图判断 |
| Prisma engine 找不到 arm64 | `device-setup.sh` 里 generate 后会自动 `ls` 校验；若 WARN，删 `node_modules` 重跑 generate |
| apt/npm 中断留半装状态 | 重跑 `device-setup.sh`（幂等）；Debian 内 `dpkg --configure -a` |
| 游戏升 targetSdk 到 37+ | 别升，Android 17 的 USE_LOOPBACK_INTERFACE 会拦跨 App loopback |
| OTA 后保活失效 | 国产 ROM 大版本更新会重置电池/自启动设置，按 §4 重配 |
| 断电重启后服务没起 | Termux 被杀后需重开 Termux 跑 `device-start.sh`；要自动起可装 Termux:Boot 插件（进阶，本手册不强制） |

---

## 6. 验收口径

- [ ] 两个 App 装好：Termux（arm64-v8a）+ 游戏（真后端 debug 包）
- [ ] `device-check.sh` 显示 PG ready / Redis ready / **API health HTTP=200**
- [ ] 游戏状态灯变绿、“服务器在线”，能真注册真登录
- [ ] 打一场野战/馆主，经验、金币、徽章真变化（服务端裁决）
- [ ] 后端日志 `/sdcard/mpk/backend-device.log` 有 `POST /api/battle/action 200`
- [ ] 熄屏 10 分钟后回来看 health 仍 200（验证保活 §4 生效）
- [ ] 主工程 `git status` 除 `mobile-server/` 外无改动
