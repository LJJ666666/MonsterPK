# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/bug_log 在 `.trae/documents/` 是权威事实；本文件只放硬约束+索引+进度快照，逐单验收数字以 bug_log/任务表为准，本文不重复。
> 2026-11-14 晚精简：合并重复、删逐单验收数字（权威在 bug_log §58~§70 与当日日志）；§3/§7/§9 硬约束与锚点原样保留。

## 1. 方向 / 进度
- 浏览器+Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；自建 Node+TS 后端，强制登录。北极星：**服务端权威 + 实时多人同玩**，客户端只发意图、收状态、渲染。
- **本地存档 2026-11-13 全部删除**（zustand persist、localStorage 副本、syncPolicy 的 LWW、离线重传队列、rebase 标记）。刷新由 `src/lib/saveBootstrap.ts` 走 `GET /api/save`，`BootGate` 拉到档之前不渲染路由。
- 不变式：每块状态一个 owner key（个人档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号，改系统时间不封号只要求不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e ✅；F18-a/b/c/d ✅；F15 冻结；P4-3 交易/赠送冻结；A1~A6 ✅；**P5-1 W0~W9 全部 ✅**（锁/选主/广播/房间/quota/野怪池/战斗/馆主CD 全迁 PG+Redis 共享存储，W9 起真正开第二实例做常规服务；逐单锚点/验收见 bug_log §58/§64~§70 与当日日志）。
- **2026-11-14 晚：APK 真机联调 + 移动端 UI/连接态优化 ✅**（详见当日日志）：装 JDK21/SDK/Gradle 工具链、dev APK 打包装雷电模拟器 `emulator-5554`、`adb reverse tcp:3001`；修 `CORS_ORIGIN` 放行 `http://localhost` + `wsProtocol.ts` 支持 `*`；登录页改为一屏不滚动 + 安全区、health 持续嗅探（禁缓存）、新增全局 `ConnBanner` 断线重连横幅。**下一步：杰哥拍板后开始测试游戏**；再往后 P5-3 Release 签名与渠道包 + W9 配套 HTTPS/`VITE_API_BASE`/`CORS_ORIGIN` 切云。
- 选型 B：Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/可重建临时态，**Redis 不存权益真值**。实施权威：`.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`。

## 2. 技术栈 / 入口 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`；全局状态 `src/stores/useGameStore.ts`（**无 persist，`save` 只是服务端快照的渲染副本**；`SCHEMA_VERSION`=11；**BattleState 不进存档**）。
- 后端 Fastify4+Prisma5+Postgres16+zod+tsx；模型含 `Room`/`RoomQuotaDaily`/`BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`，迁移链 12 条，**改 schema 前停 :3001**（Windows DLL 文件锁）。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`（node 环境，组件测试用 `react-dom/server` 静态渲染，无 jsdom）；后端 `node:test` 在 `backend/tests/`，两套不混跑。

## 3. 改代码前必读硬约束
- 新增持久化字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `saveValidator.ts` 的 `EXPECTED_SAVE_VERSION` 同步改。**前端已无 migrate**，结构校验只在服务端。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，不留兼容后门/旧链路/开关，删干净。
- 服务端权威：客户端上报一律校验；`battleApi.ts` 不做离线降级、旧意图 `capture` 已删、下线 `battle_reward`。
- 发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（规范 §28）。接新玩法分支显式穷举，别复用普通分支。
- 前端写档只剩两个入口：服务端快照 `importSaveJson`（含 WS `session.state`）与意图通道 `intents.ts`。**不要再引入任何本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部→改完立刻 `npm run check`。前端禁用 `crypto.randomUUID()`，统一 `rules.ts` 的 `uuid()`（旧 WebView 无此 API）；**后端 Node 22 用 `node:crypto` 的 `randomUUID()` 为既定模式**（roomRegistry/sweepLeader/bossQuota 等均如此，rules.ts 无 uuid 导出）。Hook 必须在组件顶层。`strict:false`，判别联合不收窄用 `'code' in result`。
- 前端先读 `.impeccable.md`（复古像素/野外手记，内联 SVG、零 CDN）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，375px 实测 `scrollWidth`。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev -- --host 0.0.0.0 --port $MPK_FRONT_PORT --strictPort`（默认 5173，本机 5174 绕微信占端口）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。
- 校验 `npm run verify`（新增阶段改两处 `STAGES`+`GROUPS`，漏 `GROUPS` 静默少跑）。`cd backend && npm run clean:e2e`（`--dry` 只删测试前缀不删 admin）；`npm run admin`。
- 路径用相对/`git rev-parse --show-toplevel`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master` 且工作树干净；收尾核对本地 tag 全在远端（`TAG_PARITY`）。推送失败先只读探活（`git ls-remote` / `info/refs` 200=通道通），沙箱最多 5 次原样重试（不换代理/不试直连/不改 config），持续 502 交本机终端。
- **配置分层硬约束（§57）**：沙箱层（`HTTPS_PROXY=11811`/`CODEBUDDY_*`）≠ 系统层（注册表 8693、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库；覆盖 env 只用一次性前缀。**项目层是唯一可提交真值**。
- **沙箱出网边界（2026-11-14 实测）**：沙箱与宿主只共享 localhost（PG/Redis 走 127.0.0.1）；出公网只能走注入代理（端口会话可变），关代理直连被防火墙挡。代理对 GitHub **间歇不稳**（200 与 502 交替，同会话数分钟内可翻转），对 npm registry 稳定 200。结论：git push **看窗口**，探活 200 就重试（上限 5 次），持续 502 属环境阻断交本机终端。本机双击 `push-mpk.bat`（仓库根，`cd /d %~dp0`+`git fetch`+`git push origin master --tags`，**不含 add/commit**）走宿主直连最稳，优先用它。
- **本机 PowerShell + GBK（§61，五条勿回退）**：① npm script 不许裸 glob（写 `"tests/**/*.test.ts"` 带引号交 Node 22 glob）；② Python stdout 必须 `reconfigure(errors="replace")`（GBK 遇 ✅ 抛 `UnicodeEncodeError`）；③ 冒烟临时页写 `public/` 会触发 Vite full-reload 打断 dump-dom → 保留 `server.watch.ignored: ['**/public/_*.html']`；④ 不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`（SIGKILL 不执行 shutdown，残留 `lock:sweep:global` 60s TTL 挡 :3001）；⑤ 沙箱冒烟不用 msedge，`EDGE_PATH` 指向 puppeteer 的 `chrome-headless-shell`。另：`authority.expected` 追随落库值，并发测试两路候选值必须相邻递减。

## 5. 本机环境（PG / Redis / Android 工具链）
- **PG = Windows 服务 `PostgreSQL16`**（账户 `NT AUTHORITY\NetworkService` 绕开 PG16 admin 检查，127.0.0.1:5432，`pg_ctl.exe runservice -N PostgreSQL16 -D <安装基>/pg-runtime/data -w -o "-p 5432"`）。管理命令在本机跑：`Start-Service PostgreSQL16` / `sc.exe start`；⚠️ PowerShell 里 `sc` 是 `Set-Content` 别名，**必须写 `sc.exe`**。
- **环境启动约定（杰哥 2026-11-13 定，跨机器）**：PG / Redis 由杰哥双击 `start-mpk-runtime.bat`（仓库外、幂等）启动；脚本自适应 D:/Six 或 E:/Six 安装基、优先 `sc start` 服务、未注册才回退 `postgres.exe` 直启并提示注册、非管理员只提示不自提权、逐项 OK/FAILED。tx 开工前只探活（5432/6379、`health`），缺失**明确告知杰哥去启动**，不自行注册服务或拉进程顶替。后端脱离 AI 会话用 `start-mpk-backend.bat`（仓库根，CRLF）。
- ⚠️ **bat 必须 CRLF + 块内 echo 禁裸 `()`**：`Write` 产出 LF 会让 `cmd.exe` 把 `if (...)` 块解析错→语法错直接退出（连 `pause` 都不到＝闪退）；用 `sed -i 's/\r$//; s/$/\r/'` 转 CRLF。`if (...)` 块内 `echo` 文本含裸 `)` 会被当作块闭合→括号失配中止。沙箱 Bash 禁调 `cmd.exe`，bat 只能静态核 + 交本机跑。
- Redis `X:/Six/redis-runtime/redis-server.exe --port 6379`（X=D 家用 / E 公司）后台起（会话结束被回收），`redis-cli PING` 判活。后端 `.env`：`DATABASE_URL=postgresql://mpk@127.0.0.1:5432/monsterpk`、`REDIS_URL=redis://127.0.0.1:6379`、`PORT=3001`；health 报 `lock/sweep/broadcast` 模式。`postgres.exe` 直启**并非必被拒**（家用 Administrator 实测正常），注册服务属可选优化。
- **Android 工具链（公司机 2026-11-14 装）**：JDK `D:/jdk21/jdk-21.0.10+7`、SDK `D:/android-sdk`（platforms android-36、build-tools 36.0.0）、ADB `D:/game/leidian/LDPlayer14/adb.exe`（雷电 `emulator-5554`，1080×1920）。⚠️ **Gradle 构建必须绕开 wrapper 联网**：`gradlew` 会去 `services.gradle.org` 下 `gradle-8.14.3-all.zip` 卡在 60%；改用已解压缓存 `~/.gradle/wrapper/dists/gradle-8.14.3-all/99x8n45tzh0zr4vi9rz6hydd7/gradle-8.14.3/bin/gradle assembleDebug --offline --console=plain --no-daemon`，并**一次性 export** `JAVA_HOME`/`ANDROID_HOME=D:/android-sdk`（本机无 `local.properties`，勿写仓库）。构建约 8~9s。⚠️ `adb shell` 无 `monkey`，启动用 `am start -n com.monster.game/.MainActivity`。

## 6. 后端架构快照（细节见 bug_log §60/§64~§70）
- 存档三层校验：`saveValidator`→`antiCheat`(`CHEAT_CODES`)→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前 400 拦整包 PUT 夹带真值。
- P4-2a 派生榜 / P4-2b 房间 `withRoomLock` / P4-2c Boss `BossDamageEvent` / P4-2d 1v1 `pvpSettled` 幂等 / P4-2e+F16 共斗 `RoomState.coop`+最低贡献+每日3次 / F18-c 地图首领 `settleMapBossRun`（3×经验/5×金钱）。W6：PG 行版本 CAS + `roomUnitOfWork` 事务边界 + DB 原子 quota 计数 + 租约 token + `normalizeRoom` + 按接收者裁剪视图。WS 监听器必须在**任何 await 之前**挂载。
- W7 野怪池：`wildRegistry.ts` 降为 facade（RNG/内容表/seq 留 Node），`WildStorage` **全 async** 两实现（Memory 基线 / Redis：`wild:*` key + 四组 Lua claim/resolve/release/ensure+append）；`useRedisStorage` 必须在**心跳启动前**装配，health 报 `wild.storage`。内容生成不能进 Lua（查不到 `THEME_TABLE`），补怪是「Node 预生成候选 + 脚本 SCARD 上限原子追加」。
- W8 共享 KV：`kvStore.ts`（`acquire` 走 Lua，两步会算不出剩余冷却）+ memory/redis 两实现（redis `keys` 用 SCAN、**空前缀 `clear()` 拒绝执行**）。`BattleStorage` 四层同构，**物理 TTL=逻辑×2**（否则 `sweepExpired` 拿不到战斗态→Boss 名额泄漏）。馆主 CD 键 `gym:cd:<uid>:<loc>`，原子 `acquire`，放弃/战败不回退。会话**不搬全文**，只修 `hydrate()` 丢弃新 DB 行的根因 + `sess:rev:<uid>` 戳。health 报 `w8.*`。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/测试菜单越权/WS 或房间上行伪造/越权 battleId/旧意图刷奖/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜/Boss/1v1/共斗字段；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`lib/env.ts` `.env` 路径曾算错→改实测 `process.env.XXX`。
- Windows 盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`、模板禁内联 module script、dev 必须 `host:0.0.0.0`。带 RNG 的 E2E（逃跑/捕获）必须重试到 `finished` 或走 `abandon`。
- 通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。**E2E 一律用 `127.0.0.1` 不用 `localhost`**（Windows 上 Node 首选解析 `::1`，后端只听 IPv4 → `fetch` 直接失败、全部 ABORT）；`harness.BASE` 已改默认 127，但 **`ORIGIN` 必须留 `localhost`**（WS 握手 Origin，CORS 精确匹配）。交接 `HANDOFF.md`；接手只读核对，等杰哥排期。
- **APK WebView 联调（2026-11-14）**：`androidScheme: "http"` 使 WebView origin = `http://localhost`（无端口），`API_BASE` 默认 `http://localhost:3001`；CORS 必须精确放行 `http://localhost`（不能只放行 5173），`wsProtocol.ts` 的 `isOriginAllowed` 需认 `*`。dev APK 需 `AndroidManifest` 的 `usesCleartextTraffic="true"`；`capacitor.config.json` 的 StatusBar `overlaysWebView:false` 已由 `MPK_DEV_APK=1 npx cap sync android` 烘焙。设备 `localhost:3001` 靠 `adb reverse` 打通，断连测试要 `--remove-all`（单条 `--remove` 不生效）。
- **健康探测禁缓存（2026-11-14）**：`api.health()` 是 GET，未带 `cache:"no-store"` 时断网后 Chromium 返回缓存 200 → 登录页「持续嗅探」永久假在线（真机截图实证）；现强制 `no-store` + `AbortController` 超时 + 防堆积，单测 `apiHealth.test.ts` 锁死。组件单测 `ConnBanner.test.tsx` 用 `renderToStaticMarkup`（node 环境无 jsdom）。

## 8. W6~W9 收官索引（逐单技术事实/验收数字见 bug_log，本文不重复）
- W6 房间+quota 共享存储（#181~#188，评级 L）✅ 2026-11-14：数据模型→`RoomStorage` 异步化+PG CAS→事务边界→DB 原子计数→租约 token→`normalizeRoom`→按接收者裁剪 + revision→跨实例送达 E2E。
- W7 野怪池搬 Redis（评级 M）✅：三层拆解 + 全量 key + 四组 Lua，调用方 async 化；`e2e:w7wild` 14/14（双实例）。
- W8 战斗/会话/馆主 CD 共享 KV + TTL（评级 M）✅：**没走「userId 粘性路由降级」退路**；`e2e:w8shared` 18/18（双实例）；顺手修 `e2e:game` 间歇红与 `e2e:w4` 残留 leader 租约。
- W9 双实例横向扩展与故障注入 ✅：`tests/lib/reverseProxy.mjs`（HTTP 探活 + WS Upgrade 透传 + Origin 白名单）、`tests/e2e_multi_instance.mjs`（42 断言，6 happy-path + 4 故障注入）、`SWEEP_KEY_PREFIX` 隔离、`gracefulShutdown` 挂 SIGINT/SIGTERM；`e2e:multi` 42/42 + 后端 502/502。**已真正开第二实例做常规服务**。
- 测试脚本坑见 bug_log §67；`e2e:game` 全链路冒烟 42/42。全量 `verify` 曾卡前端 vitest（环境挂起，与后端改动无关），以「后端管线 + 对应 e2e」作验收口径。

## 9. 验收锚点（勿删）
- **P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅** —— P4-2 五阶段全部完成（排期契约 `.trae/documents/P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 写入并发控制（slotLock 串行，规范 §21）；P4-1 ✅ 顶号与共享野怪（`SESSION_REPLACED` 踢旧设备）。
- 台账：F01/F02 已偿还；**F04** 不写 `SaveData`（等级真值在服务端独立表）；**F14** 双档奖励已偿还；**F16** 六房副本已实现；**F17 单档化已实现并偿还**（第 11 条迁移把 `SCHEMA_VERSION` 10→11）。
- 冻结：F15 1v1 零产出（仅供娱乐）；P4-3 C2C **阶段冻结**，**不打算开放交易系统**。
- P5-1 / F10 共享存储迁移评估已完成，已被实施定稿取代；定稿前「不改任何产品代码」的约束自 W0 起解除。
