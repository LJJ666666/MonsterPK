# mobile-server —— 手机内自托管服务端（L3 等价真自测工程）

> 目标：在**同一台安卓设备**上同时跑「真后端（Fastify+Prisma+PG16+Redis+WS）」和「游戏 APK」，
> 游戏通过 `http://localhost:3001` 连同机后端，实现 **L3 等价的真玩法自测**——
> 全部服务端权威逻辑（发奖/进化/去重/CD/战斗/房间）都是真的，零 mock、零漂移。
>
> **隔离硬约束**：主工程 `src/`、`backend/src/`、`demo-app/` 一律不改一行；
> 本工程的脚本、文档、产物全部落在 `mobile-server/` 内。游戏 APK 用主工程**默认 debug 构建**（非 mock）。

---

## 1. 为什么这条路成立（取证于 2026-11-18，雷电 emulator-5554）

| 探测项 | 实测值 | 对方案的意义 |
|---|---|---|
| Android / SDK | **14 / 34** | 远低于 37，Android 17 的 `USE_LOOPBACK_INTERFACE` 跨应用 loopback 限制**不存在** |
| CPU 架构 | **x86_64**（兼容 arm64） | PG/Redis/Node 直接用标准 x86_64 二进制，**无需交叉编译** |
| root | 无（`adbd cannot run as root`; 无 su） | proot-distro 方案恰好**不需要 root** |
| 内存 / 存储 | 6086 MB / 22G 可用 | 跑 PG+Redis+Node 绰绰有余 |
| 外网 | GitHub API 200、npm 200；F-Droid 000 | 包从 GitHub/npm 拉；**Termux 必须 GitHub 版，不能 Play 版** |
| 游戏 API_BASE | `http://localhost:3001`（`src/lib/api.ts`） | WebView 里 `localhost` = **设备自身**，正是同机后端地址，**零改动** |
| debug 包 | `usesCleartextTraffic=true` + `MPK_DEV_APK=1` 时 scheme=http | 明文 HTTP 请求与 `http://localhost` origin 都已放行 |

**结论**：游戏 WebView 的 `localhost:3001` 与 Termux 容器内后端在同一网络命名空间，天然互通。
不需要 adb reverse、不需要 HTTPS、不需要改前端、不需要 root。

---

## 2. 装什么（两个 App）

| App | 版本/来源 | 作用 |
|---|---|---|
| **Termux** | v0.118.3 **x86_64**（GitHub release，35MB，非 Play 版） | 宿主终端，跑 proot-distro → Debian → PG/Redis/后端 |
| **游戏 APK** | 主工程**默认 debug 构建**，`MPK_DEV_APK=1`，**不注入 mock 重定向** | 客户端，API 指向同机后端 |

下载/构建脚本负责把这两个 APK 准备到 `mobile-server/output/`，再 `adb install` 到雷电。

---

## 3. 目录结构

```
mobile-server/
├── PLAN.md                  # 本文件：方案 + 路线 + 已知坑
├── README.md                # 使用说明（面向操作者）
├── scripts/
│   ├── prepare-assets.mjs   # 下载 Termux x86_64 APK；构建主工程默认 debug 游戏 APK
│   ├── setup-termux.sh      # 推送到手机执行：换源→proot Debian→装 PG/Redis/Node→部署后端→迁移
│   ├── start-server.sh      # 手机内执行：起 PG/Redis/后端 + 保活锁
│   ├── install.sh           # 宿主机执行：adb install 两个 APK + 推脚本进手机
│   └── smoke.mjs            # 宿主机执行：验证游戏能连同机后端并跑通一场
├── output/                  # 生成的 APK（gitignore）
└── reports/                 # logcat / 截图取证（gitignore）
```

---

## 4. 技术路线（分步）

### Phase 0 准备（宿主机）
1. 下载 Termux x86_64 APK → `output/termux-x86_64.apk`
2. 用主工程构建**默认 debug APK**（`MPK_DEV_APK=1`，`-p tsconfig` 正常、无 mock 插件）→ `output/monsterpk-debug.apk`
3. 打包后端交付物：源码 + `node_modules`（x86_64）+ `prisma` schema + `.env`

### Phase 1 装 App（雷电）
4. `adb install` 两个 APK
5. 启动 Termux，`termux-change-repo` 换国内源，`termux-setup-storage`
6. 唤醒锁 `termux-wake-lock` + 电池白名单（adb `device_config`/`dumpsys deviceidle whitelist`）

### Phase 2 搭后端环境（Termux 内）
7. `pkg install proot-distro` → `proot-distro install debian`（x86_64，glibc）
8. Debian 内 `apt install postgresql redis-server nodejs npm`
9. 部署后端：拷交付物、`.env`（`DATABASE_URL=postgresql://...`、`REDIS_URL=...`、`CORS_ORIGIN` 含 `http://localhost`）
10. `prisma migrate deploy` + `prisma generate`

### Phase 3 起服务 + 验证
11. Debian 内起 PostgreSQL(5432) + Redis(6379) + 后端(3001)
12. 雷电打开游戏 APK → 登录 → 打一场野战/馆主 → 看经验/金币变化
13. `adb logcat` 扫 JS 错误；截图取证

---

## 5. 已知坑与对策

| 坑 | 对策 |
|---|---|
| Play 商店 Termux 停更、新安卓崩溃 | **只从 GitHub release 下 x86_64 包** |
| 幽灵进程杀手（Android 12+ 延续到 16） | 电池白名单 + wake-lock + `max_phantom_processes` 调到极大；OTA 后需重配 |
| Bionic libc ≠ glibc，PG 原生跑不了 | PG/Redis/后端**全在 proot Debian 内**，用 glibc 环境 |
| Node 原生模块 glibc/arm64 预编译失配 | x86_64 环境用标准 linux-x64 预编译；Prisma engine 选 `debian-openssl-*` 目标 |
| 跨应用 loopback（Android 17 才有） | 本机 SDK 34 不存在；**切勿升级 targetSdk 到 37**，否则要双方声明 `USE_LOOPBACK_INTERFACE` |
| 端口冲突 | 后端 3001/PG5432/Redis6379 与雷电宿主无冲突（guest 独立网络栈） |
| `.env` 路径 | 用 env 覆盖 + 探测，禁写死绝对路径（项目硬约束） |
| **雷电拦截文件名 `su`** | ⚠️ 实测：雷电 FS 层禁止创建名为 `su` 的文件/软链 → Termux bootstrap 强制建 `bin/su` 必失败（"Unable to install bootstrap"）。**这是雷电特有，真机无此限制**。绕法：① 雷电设置里手动开 root 后重装；② 直接用真机（arm64，换对应架构包）。详见 README §二 |
| GitHub CDN 大文件限流 | 6 段并发续传（`download-termux-v2.sh`），别用单连接（13KB/s）或 24 段（被惩罚）；宿主回收导致 task 报 failed 时以日志 `DONE`+zip 校验为准 |

---

## 6. 验收口径

- 雷电里**两个 App 都在**：Termux + 游戏
- 游戏能登录、能进战斗、能结算（经验/金币真变化），**走的是真后端**（logcat 有 API 请求、无 mock 痕迹）
- 后端日志显示首通/发奖/去重等真实链路被调用
- logcat 无 JS 错误、无断线横幅
- 主工程 `git status` 除 `mobile-server/` 与必要的忽略配置外**无改动**

---

## 7. 边界与不做

- 不做 L3 的"引擎搬前端"——这里后端是真的，不是塞进 APK 的假引擎
- 不连公网、不发布、不买云主机——纯同机 loopback
- 不碰 `demo-app/`（那是 mock 演示包 L1/L2，与本工程定位不同）
- 目标是**自测**，不是 7×24 生产——保活够用即可，不追求地狱级稳定
