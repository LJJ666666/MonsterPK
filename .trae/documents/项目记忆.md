# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/bug_log 在 `.trae/documents/` 是权威事实；本文只放硬约束+索引+进度快照，逐单验收数字以 bug_log 为准。

## 1. 方向 / 进度
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`），Node+TS 后端、强制登录。北极星：**服务端权威 + 实时多人同玩**，客户端只发意图、收状态、渲染。
- **本地存档 2026-11-13 全删**（persist、localStorage 副本、LWW、离线重传、rebase）。刷新走 `saveBootstrap.ts` 的 `GET /api/save`，`BootGate` 拉到档前不渲染路由。
- 不变式：每块状态一个 owner key（档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态；个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号；改系统时间不封号但不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e、F18-a/b/c/d、A1~A6、**P5-1 W0~W9 全 ✅**（PG+Redis，W9 起真正开第二实例）、P5-3 本机可做部分 ✅、**F18-d 剧情已读进度 ✅（2026-11-16，bug_log §80）**；F15、P4-3 交易/赠送冻结。逐单锚点 bug_log §58/§60~§81。
- 选型 B：Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/临时态，**Redis 不存权益真值**。权威 `P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`。
- **下一步（三条线，均需杰哥推进或拍板）**：① P5-3 切云出正式包 —— 阻塞于域名 + TLS + 正式 keystore + 托管 PG/Redis；② 玩法缺口 —— `玩法缺口评估_进化石与关键道具_2026-11-15.md` 的 P1~P5 待拍板（3 种进化石无适配物种最实、`exp_share` 经验全额复制口径未定），**零产品语义改动**；③ 内容扩充（训练师战 / 携带道具），roadmap P2 大项，单独立阶段。
- 里程碑索引（细节全在 bug_log，不在此复制）：11-14~15 真机+UI §71~§74；P5-3 本机部分 §75（release 签名 fail-closed、版本号走 `gradle.properties`、明文只在 `src/debug`、`VITE_API_BASE` 一处覆盖 REST+WS，权威 `apk_build_guide.md`）；测试资产审核 §76/§77；交接文档 §78/§79（`HANDOFF.md` + `带回公司_交接清单_2026-11-16.md`，换机器先看这两份）；F18-d §80；bat 误报 §81。
- P5-1 逐单收官锚点（doc_check 断言，勿删）：**P5-1 W4 ✅（50/50，bug_log §58）**；W6.1 RoomStorage 异步化+CAS §60/§61；**W6.2 事务边界**（`roomUnitOfWork`，§64）；**W6.3 DB 计数**（quota 原子条件更新，§65）；W6.4~W6.7、W7、W8、W9 见 §66~§70。
- P4 收官台账（doc_check 锚点，勿删）：**P4-2 五阶段全部完成**（P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅，排期契约 `P4-2_多人玩法排期_2026-11-07.md`；下一步 F16 → F04）；P3-2 写操作上移服务端；P4-0 写入并发控制（规范 §21）；**P4-1 ✅** 顶号与共享野怪（规范 §22）。
- 债务台账：**F01/F02 已偿还**；F14 已偿还、F16 六房副本已实现；**F04 不写 `SaveData`**（等级/徽章/成就真值在服务端独立表，与 F18-d 同范式）；**F17 单档化已实现并偿还**（`SCHEMA_VERSION` 10→11）。冻结：F15 1v1 零产出；P4-3 C2C **阶段冻结，不打算开放交易系统**。P5-1 / F10 共享存储迁移评估已被实施定稿取代，「不改任何产品代码」约束自 W0 起解除。

## 2. 技术栈 / 入口 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`（剧情 `src/game/story.ts`）；`useGameStore.ts` **无 persist**，`save` 只是服务端快照的渲染副本，`SCHEMA_VERSION`=11，**BattleState 不进存档**。
- 后端 Fastify4+Prisma5+Postgres16+zod+tsx；模型含 `Room`/`RoomQuotaDaily`/`RoomQuota`/`BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`/`StoryBeatSeen`，**改 schema 前停 :3001**（Windows DLL 文件锁）→ `prisma migrate dev` → `prisma generate`。`Save.data` 存 JSON 文本、`revision` 独立列。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`（node 环境、`renderToStaticMarkup`、无 jsdom）；后端 `node:test` 在 `backend/tests/`，两套不混跑。
- 测试资产：`verify.mjs` **62 阶段 / 6 分组**（`check:inventory` 纯静态门禁排最前，**32 条**）；前端 **161**、后端 **509**、E2E **37** 套（都共享 `Suite.done()` 范式，失败置 exitCode=1）、UI 冒烟 **16** 套（15 套 375px + `ui_smoke_auth` 360×616）、doc_check **232**。`scripts/test_inventory.mjs` 锁编排对齐 / 防假绿 / P5-3 发布配置 / 冒烟宿主 / 默认口径；**新增阶段必须改 `STAGES`+`GROUPS` 两处**。

## 3. 改代码前必读硬约束
- 新增**存档**字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `saveValidator.ts` 的 `EXPECTED_SAVE_VERSION`。**前端已无 migrate**，结构校验只在服务端。
- **展示类/去重类状态不要塞存档**（F04 徽章、F18-d 剧情已读都是这么做的）：开服务端独立表 + `@@unique` + upsert 幂等 + 客户端只走专用 GET/POST，成本更低且不污染存档契约。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，**不留兼容后门/旧链路/开关**。
- 服务端权威：客户端上报一律校验；`battleApi.ts` **不做离线降级**、旧意图 `capture` 已删、**下线 `battle_reward`**。发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（规范 §28）；新玩法分支显式穷举。
- 前端写档入口：快照 `importSaveJson`（含 WS `session.state`）与意图 `intents.ts`；`resetLocalSave()` 只用于**丢弃**内存副本（换账号/404），不是写入口。**不要引入任何本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部 → 改完立刻 `npm run check`。前端禁用 `crypto.randomUUID()`（`rules.ts` 的 `uuid()`）；后端 Node 22 用 `node:crypto`。`strict:false`，判别联合不收窄用 `'code' in result`；Hook 必须在组件顶层。
- UI 口径（2026-11-15）：页面根 `.page-shell`+`.safe-top`（**只用真实 `env(safe-area-inset-top)`，禁 24px 兜底**）；弹窗一律 `ModalShell`；页头 `GameHeader`；**禁远程字体/CDN**，像素字走本地 woff2；小按钮 `button:not([class*="min-h-"])` 兜底 36px。先读 `.impeccable.md`（复古像素/野外手记、内联 SVG）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，实测 `scrollWidth`。
- 账号边界：换账号/退出必须 `signOut()`（停 WS/写通道 + 清 store `save`/`battle` + 清 revision），`bootstrapSave()` 收 404 必须清空旧渲染副本；否则新账号顶着旧档进 Camp，写操作全被 `SAVE_NOT_FOUND` 拒（2026-11-15 真机复现）。
- 工作流：结论先行、中文、可复现证据；**不用等待/猜测代替一次取证**；构建前一条命令核工具链，构建后核 APK mtime + bundle 新字符串；**后台任务退出码不是成功判据**；长命令禁裸 `&&` 串 `grep`；截图字节相同要怀疑操作未生效；验收只认源码/产物。
- **文档 / 脚本禁写死单机绝对路径**（2026-11-16 杰哥指出：公司机器 JDK/SDK 与家里盘符不同）：路径一律「env 覆盖 → 常见位置探测 → 明确报错」三段式，示范 `apk_build_guide.md §1`、`check_home_env.py`、`perf-adb.mjs` 的 `MPK_ADB`。命令示例用 `$JAVA_HOME` / `$ANDROID_HOME` / `$GRADLE_BIN` / `%USERPROFILE%`，不写具体盘符与用户名。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev`（端口只由 `MPK_FRONT_PORT` 控制，默认 5173，勿再传 `--host/--port` 覆盖 `devConfig.mjs`）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。校验 `npm run verify`；`npm run clean:e2e`；`npm run admin`。node 22.22.2，remote `LJJ666666/MonsterPK.git`。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- **verify 口径**：全量用 `npm run verify -- --strict`，前后端都要在线，**62 阶段含 16 套冒烟**；服务缺失默认判 FAIL，只有 `--allow-missing-services` 才退回 SKIP；`--skip=smoke` 仅用于明确离线排查，**不得当默认**（HANDOFF / apk_build_guide / 上线部署清单三处同口径，门禁锁死）；离线只跑 `--only=check,unit,docs --strict`。改 `vite.config.ts` 后必须真跑一次 `--only=smoke`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master`、工作树干净、tag 全在远端。推送失败只读探活 + 最多 5 次原样重试（不换代理/不改 config），持续 502 交本机 `push-mpk.bat`（`fetch`+`push master --tags`，**不含 add/commit**）。**Git 状态汇报只给一句话**。
- **配置分层硬约束（§57，勿回退）**：沙箱层（`HTTPS_PROXY=11811/3935` / `CODEBUDDY_*`）≠ 系统层（注册表 `ProxyServer=8693`、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库，覆盖 env 只用一次性前缀，**项目层是唯一可提交真值**；git 502 恒现交本机 `push-mpk.bat`。
- **本机 PowerShell + GBK（§61，勿回退）**：① npm script 不许裸 glob（`"tests/**/*.test.ts"` 带引号交 Node 22 glob）；② Python stdout 必须 `reconfigure(errors="replace")`；③ 保留 `server.watch.ignored: ['**/public/_*.html']`；④ 不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`；⑤ 沙箱冒烟用 puppeteer 的 `chrome-headless-shell`（`EDGE_PATH`）；⑥ 冒烟的 `waitFor` 每 4 轮要挂真实 `fetch`，否则 `--virtual-time-budget` 会把 WS 握手窗口跨过去。

## 5. 本机环境（PG / Redis / Android）
- **PG = Windows 服务 `PostgreSQL16`**（127.0.0.1:5432），本机 `Start-Service PostgreSQL16` / `sc.exe start`（⚠️ PowerShell 里 `sc` 是 `Set-Content` 别名；沙箱黑名单还会拦 `sc.exe`，只用 `netstat` 探端口）。Redis `X:/Six/redis-runtime/redis-server.exe --port 6379`（X=D 家用 / E 公司），`redis-cli -h 127.0.0.1 PING`。
- ⚠️ **`pg-runtime` 布局两台不同**：家里 `native\bin`，公司 `package\native\bin`；`start-mpk-runtime.bat` 两处都探，探不到明确报错。**判 PG 活没活只看 5432 端口，不看 `pg_ctl status`**（服务态下 pid 归 NetworkService，status 恒非 0 → 误报 FAILED，§81）。
- **启动约定（杰哥 2026-11-13 定）**：PG/Redis 由杰哥双击 `start-mpk-runtime.bat`（仓库外、幂等，放 `E:\Six` 与 `pg-runtime\`/`redis-runtime\` 同级）；tx 开工前只探活（5432/6379、`health`），缺失**明确告知杰哥去启动**，不自行注册服务或拉进程顶替。后端脱离 AI 会话用 `start-mpk-backend.bat`。
- ⚠️ **bat 必须 CRLF + 块内 echo 禁裸 `()`**：`Write` 产出 LF 会让 `cmd.exe` 把 `if (...)` 解析错→闪退；用 `sed -i 's/\r$//; s/$/\r/'` 转 CRLF 后用 python 数 `\r\n` 取证。沙箱 Bash 禁调 `cmd.exe`。
- 后端 `.env`：`DATABASE_URL=postgresql://mpk@127.0.0.1:5432/monsterpk`、`REDIS_URL=redis://127.0.0.1:6379`、`PORT=3001`、`CORS_ORIGIN` 列 5173/5174/localhost（正式包还要 `https://localhost`）。
- **Android 工具链（路径因机而异，先探再用）**：JDK **必须 21**（系统 PATH 上的 Temurin 17 会报「无效的目标发行版: 21」）；公司实测 `E:/Six/jdk/jdk-21`、SDK `E:/Six/android-sdk`（android-36，build-tools 只有 **35.0.0**）、Gradle `E:/Six/gradle-dist/gradle-8.14.3`、`GRADLE_USER_HOME=E:/Six/gradle-user-home`；家里是 `D:/jdk21/...` + `D:/android-sdk` + `~/.gradle/wrapper/dists/...`。雷电 adb 两台都在 `D:/game/leidian/LDPlayer14/adb.exe`（`perf-adb.mjs` 支持 `MPK_ADB`）。⚠️ **绕开 gradlew 联网**：直调解压好的 `bin/gradle assembleDebug --offline --console=plain --no-daemon`，一次性 export `JAVA_HOME`/`ANDROID_HOME`（勿写 `local.properties`）；⚠️ `adb shell` 无 `monkey`，用 `am start -n com.monster.game/.MainActivity`；真机取证 `adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + CDP。路径权威清单见 `apk_build_guide.md §1`。

## 6. 后端架构快照（细节 bug_log §60/§64~§70/§80）
- 存档三层校验 `saveValidator`→`antiCheat`→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前拦整包 PUT 夹带真值。W6 PG 行版本 CAS + `roomUnitOfWork` 事务 + DB 原子 quota + 租约 token（WS 监听器必须在**任何 await 之前**挂载）；W7 `WildStorage` 全 async + 四组 Lua（`useRedisStorage` 须在心跳启动前装配，内容生成不能进 Lua）；W8 `kvStore` TTL（空前缀 `clear()` 拒绝执行）、`BattleStorage` **物理 TTL=逻辑×2**、馆主 CD 原子 `acquire`、会话修 `hydrate()` + `sess:rev:*`。
- F18-d：`StoryBeatSeen` + `GET/POST /api/story/seen`，白名单来自 `CONTENT.storyBeatIds`（`gen-content` 从 `src/game/story.ts` 生成，`check:content` 防漂移）；校验纯函数在 `game/storyBeats.ts`。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/越权写/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜/伪造剧情 id；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 bug_log.md、HANDOFF.md）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`lib/env.ts` `.env` 路径曾算错 → 用实测 `process.env.XXX`。Windows 盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`、模板禁内联 module script。带 RNG 的 E2E 必须重试到 `finished` 或 `abandon`。
- 通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。**E2E 一律 `127.0.0.1` 不用 `localhost`**（Node 首选 ::1，后端只听 IPv4）；`harness.BASE` 默认 127，但 **`ORIGIN` 必须留 `localhost`**（WS 握手 Origin）。进程内事件监听必须在任何 `await` 之前挂载，否则首条消息被 `dispatchEvent` 丢弃（前后端各踩一次：`attachWsHandlers`、`BootGate` 里的 `startSessionSync` 先于 `startRealtime`）。
- **APK WebView 联调**：`androidScheme:"http"` → origin `http://localhost`（无端口），dev APK 需 `usesCleartextTraffic="true"`；正式包 `https://localhost` 必须进 CORS；`isOriginAllowed` **精确匹配 fail-closed**；设备 `localhost:3001` 靠 `adb reverse`。
- **健康探测禁缓存**：`api.health()` 不带 `cache:"no-store"` 时断网后 Chromium 返回缓存 200 → 假在线；现强制 `no-store` + `AbortController` 超时，`apiHealth.test.ts` 锁死。
- **冒烟宿主（§76，勿回退）**：Vite 6 会把任意 `*.html` 当 SPA 入口 transform，`public/_*.html` 的 seed/probe 页必须由 `devProbePlugin` 原样返回（dev/preview 双挂载）；UI 文案变更要同步检查依赖该文案的冒烟断言；`Arena.tsx` 的「回程」只在空态/结算态渲染，别拿它判定「进入战斗」。
