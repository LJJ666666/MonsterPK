# mobile-server —— 手机内自托管后端，真玩法自测

在一台安卓设备（雷电模拟器或真机）上**同时跑真后端 + 游戏 APK**，游戏通过
`http://localhost:3001` 连同机后端，实现 **L3 等价真自测**：发奖/进化/去重/CD/战斗/房间
全是服务端真实逻辑，零 mock、零漂移。

- **与 `demo-app/`（L1/L2 mock 演示包）平级、互不影响**；主工程源码零改动。
- 全部脚本/文档/产物在本目录内。
- 方案与取证见 [`PLAN.md`](./PLAN.md)。

## 两条设备路线（按架构选）

| 路线 | 设备 | 架构 | 手册 | 状态 |
|---|---|---|---|---|
| **真机** | vivo / 普通 Android 手机 | arm64 | **[`DEVICE.md`](./DEVICE.md)** | 本次新增，产物已就绪，待真机上机验证 |
| 模拟器 | 雷电 emulator-5554 | x86_64 | 本文档 + PLAN.md | 已打通（真注册/真登录/真战斗/服务端裁决） |

两条路线后端核心代码共用（架构无关）；仅架构二进制包（Termux/Node/rootfs）和保活方式不同。
真机走 non-root + tmux 会话；雷电走 root 常驻 proot 会话。

---

## 一、它解决什么

演示包（demo-app）是真 UI + 假数据，战斗能点但不走真发奖。要测真玩法，过去必须开 PC 上的
PG/Redis/后端，手机靠 `adb reverse` 回连——离不开电脑。

本工程把那套后端**整个搬进手机**：Termux → proot Debian → PG + Redis + Node → 后端，
游戏 APK 连 `localhost:3001`（在手机里就是它自己）。**掏出手机即可自测，不依赖 PC。**

---

## 二、适用范围（先读，避免踩坑）

| 条件 | 实测（雷电 emulator-5554，2026-11-18） |
|---|---|
| 架构 | x86_64（原生，PG/Redis/Node 用标准二进制） |
| Android | 14 / SDK 34（无 `USE_LOOPBACK_INTERFACE` 跨应用限制） |
| root | 无（proot 方案不需要 root） |
| 内存/存储 | 6GB / 22G 可用 |
| 外网 | GitHub/npm 可达，F-Droid 不通 |

真机 arm64 也能跑，但要换对应架构的 Termux APK 与 Node/PG 二进制（脚本里的架构守卫会提示）。
**别把游戏 `targetSdk` 升到 37+**，否则 Android 17 的 loopback 权限会拦跨应用通信。

> ⚠️ **雷电实测卡点（2026-11-18）：雷电在文件系统层拦截精确文件名 `su` 的创建**
> （`touch`/`ln -s` 名为 `su` 均报 ENOENT，而 `su2`/`mysu` 正常）。Termux bootstrap 强制要建
> `usr-staging/bin/su`，因此在**当前未 root 的雷电上 bootstrap 必失败**，弹窗
> "Unable to install bootstrap"。**这是雷电防 root 机制，真机 Android 不会出现。**
> 绕法二选一：① 在雷电模拟器「设置 → 其他设置/系统」里打开 root 权限并重启，再重装 Termux；
> ② 直接用真机（arm64，需换 Termux/Node/PG 对应架构包）。不要试图在雷电上手动补 `su` 文件——会被同样拦截。

---

## 三、产物准备（宿主机，一次性）

```bash
# 1. Termux x86_64 APK（35MB；当前网络限速，脚本单连接断点续传，约 10 分钟）
cd E:/Six/MonsterPK/mobile-server
bash scripts/fetch-termux.sh            # 若官方直链过期，重跑 scripts 里的取链步骤

# 2. 真后端游戏 APK（从当前主工程默认 assets 构建，非 mock，约 15 秒）
node scripts/build-game-apk.mjs

# 3. 后端源码包（0.5MB，不含 node_modules，手机内 npm install）
node scripts/pack-backend.mjs

# 4. 一键装进雷电 + push 文件
bash scripts/install.sh
```

> Termux 下载脚本用 GitHub 官方签名直链（`api.github.com` 资产接口 + 单连接断点续传）。
> 签名有时效，过期就重新执行取链命令（见 PLAN.md §4）。别用并发——会被 CDN 限流。

---

## 四、手机内操作（Termux，一次性）

```bash
# 让 Termux 能读共享存储
termux-setup-storage

# 换国内源（加速后面 proot / apt / npm）
termux-change-repo

# 把宿主机 push 的文件拷进 Termux home
cp /sdcard/mpk/backend-src.tar.gz $HOME/
cp /sdcard/mpk/setup-termux.sh $HOME/

# 一条命令跑完全部（装 proot Debian → PG/Redis/Node → 部署 → 迁移 → 起服务）
bash $HOME/setup-termux.sh
```

首次会下载 Debian rootfs（~100MB）+ apt 装 PG/Redis/Node，**约 2–5 分钟**。脚本幂等，
重复执行安全。

---

## 五、每次自测（日常）

```bash
# 在 Termux 里起服务（若上次重启后没自动起）
proot-distro login debian
# Debian 内：
service postgresql start 2>/dev/null || su postgres -c "pg_ctl -D <你的PGDATA> -l /tmp/pg.log -o '-h 127.0.0.1 -p 5432' start"
redis-server --daemonize yes --bind 127.0.0.1 --port 6379
cd ~/backend && nohup npx tsx src/index.ts > /tmp/mpk-backend.log 2>&1 &
curl http://127.0.0.1:3001/api/health    # 应返回 200
exit
```

然后打开游戏 APK → 任意账号登录 → 打一场野战/馆主 → 看经验/金币真变化。
后端日志：`proot-distro login debian` 后 `tail -f /tmp/mpk-backend.log`。

---

## 六、验收

- 雷电里两个 App：Termux + 游戏（真后端版，非 mock）
- 游戏状态灯从"无法连接服务器"变绿，能登录
- 打一场野战，经验/金币真变化；馆主胜利真发徽章、真解锁新城（走服务端逻辑）
- logcat 无 JS 错误、无 mock 痕迹（`grep mock-demo` 无命中）
- 主工程 `git status` 除 `mobile-server/` 外无改动

---

## 七、已知坑（详见 PLAN.md §5）

| 坑 | 对策 |
|---|---|
| Termux 35MB 下载被 CDN 限流 | 官方直链 + 单连接断点续传 + 20 次重试；别并发 |
| F-Droid 不通 | 只用 GitHub release 的 Termux 包 |
| 幽灵进程杀手（杀后台） | 电池白名单 + `termux-wake-lock`；OTA 后重配 |
| PG 跑不了原生 Termux（Bionic≠glibc） | 全在 proot Debian（glibc）内 |
| 跨应用 loopback（Android 17+） | 本机 SDK 34 无此问题；别升 targetSdk 到 37 |
| 签名直链过期 | 重新走 `api.github.com` 资产接口取新链 |

---

## 八、边界与不做

- 不做 L3 的"引擎搬前端"——本工程后端是真的，不是塞进 APK 的假引擎
- 不连公网、不发布、不买云主机——纯同机 loopback
- 不碰 `demo-app/`（那是 mock 演示包）
- 目标是**自测**，非 7×24 生产——保活够用即可
