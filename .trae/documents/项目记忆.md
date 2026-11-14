# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/bug_log 在 `.trae/documents/` 是权威事实；本文只放硬约束+索引+进度快照，逐单验收数字以 bug_log 为准。

## 1. 方向 / 进度
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`），Node+TS 后端、强制登录。北极星：**服务端权威 + 实时多人同玩**，客户端只发意图、收状态、渲染。
- **本地存档 2026-11-13 全删**（persist、localStorage 副本、LWW、离线重传、rebase）。刷新走 `saveBootstrap.ts` 的 `GET /api/save`，`BootGate` 拉到档前不渲染路由。
- 不变式：每块状态一个 owner key（档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态；个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号；改系统时间不封号但不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e、F18-a/b/c/d、A1~A6、**P5-1 W0~W9 全 ✅**（PG+Redis，W9 起真正开第二实例）；F15、P4-3 交易/赠送冻结。逐单锚点 bug_log §58/§64~§70。
- **2026-11-14~15 真机与 UI ✅**（bug_log §71~§73）：Android 工具链 → dev APK 装雷电 → 修 CORS/WS origin → 登录页一屏+持续嗅探+`ConnBanner` → 真机走通登录→建档→野外→战斗→捕获→冷启动拉服务端存档 → 删 `wsProtocol.ts` 的 `*` 通配（fail-closed）→ 全站 UI/UE。验收：后端 503/503、前端 154/154、CDP 360dp/240dp 无横向溢出。
- **2026-11-15 追加（bug_log §74）✅**：注册页紧凑态一屏（687→616）、删 `.safe-top` 24px 兜底、修换账号残留旧渲染副本（404 清空 + `signOut()`）；`npm test` 158/158，真机换账号全流程 + UI 建档复验通过。
- **下一步：P5-3 Release 签名渠道包 + W9 配套 HTTPS/`VITE_API_BASE`/`CORS_ORIGIN` 切云**；待排期 UX：剧情 intro 每次进 Camp 重播（`Camp.tsx:167`）。
- 选型 B：Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/临时态，**Redis 不存权益真值**。权威 `P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`。

## 2. 技术栈 / 入口 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`；`useGameStore.ts` **无 persist**，`save` 只是服务端快照的渲染副本，`SCHEMA_VERSION`=11，**BattleState 不进存档**。
- 后端 Fastify4+Prisma5+Postgres16+zod+tsx；模型含 `Room`/`RoomQuotaDaily`/`BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`，迁移链 12 条，**改 schema 前停 :3001**（Windows DLL 文件锁）。`Save.data` 存 JSON 文本、`revision` 独立列。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`（node 环境、`renderToStaticMarkup`、无 jsdom）；后端 `node:test` 在 `backend/tests/`，两套不混跑。

## 3. 改代码前必读硬约束
- 新增持久化字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `saveValidator.ts` 的 `EXPECTED_SAVE_VERSION`。**前端已无 migrate**，结构校验只在服务端。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，**不留兼容后门/旧链路/开关**。
- 服务端权威：客户端上报一律校验；`battleApi.ts` 不做离线降级、旧意图 `capture` 已删、下线 `battle_reward`。发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（规范 §28）；新玩法分支显式穷举。
- 前端写档入口：快照 `importSaveJson`（含 WS `session.state`）与意图 `intents.ts`；`resetLocalSave()` 只用于**丢弃**内存副本（换账号/404），不是写入口。**不要引入任何本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部 → 改完立刻 `npm run check`。前端禁用 `crypto.randomUUID()`（`rules.ts` 的 `uuid()`）；后端 Node 22 用 `node:crypto`。`strict:false`，判别联合不收窄用 `'code' in result`；Hook 必须在组件顶层。
- UI 口径（2026-11-15）：页面根 `.page-shell`+`.safe-top`（**只用真实 `env(safe-area-inset-top)`，禁 24px 兜底**：非 overlay WebView 状态栏已在 WebView 外）；弹窗一律 `ModalShell`；页头 `GameHeader`；**禁远程字体/CDN**，像素字走本地 woff2；小按钮 `button:not([class*="min-h-"])` 兜底 36px。先读 `.impeccable.md`（复古像素/野外手记、内联 SVG）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，实测 `scrollWidth`。
- 账号边界：换账号/退出必须 `signOut()`（停 WS/写通道 + 清 store `save`/`battle` + 清 revision），`bootstrapSave()` 收 404 必须清空旧渲染副本；否则新账号顶着旧档进 Camp，写操作全被 `SAVE_NOT_FOUND` 拒（2026-11-15 真机复现）。
- 工作流：结论先行、中文、可复现证据；**不用等待/猜测代替一次取证**；构建前一条命令核工具链，构建后核 APK mtime + bundle 新字符串；**后台任务退出码不是成功判据**；长命令禁裸 `&&` 串 `grep`；截图字节相同要怀疑操作未生效；验收只认源码/产物。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev -- --host 0.0.0.0 --port $MPK_FRONT_PORT --strictPort`（默认 5173，本机 5174）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。校验 `npm run verify`（新增阶段改两处 `STAGES`+`GROUPS`，漏 `GROUPS` 静默少跑）；`npm run clean:e2e`；`npm run admin`。node 22.22.2，remote `LJJ666666/MonsterPK.git`。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master`、工作树干净、tag 全在远端。推送失败只读探活 + 最多 5 次原样重试（不换代理/不改 config），持续 502 交本机 `push-mpk.bat`（`fetch`+`push master --tags`，**不含 add/commit**）。**Git 状态汇报只给一句话**。
- **配置分层（§57）**：沙箱层（`HTTPS_PROXY`/`CODEBUDDY_*`）≠ 系统层（注册表、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库，覆盖 env 只用一次性前缀，**项目层是唯一可提交真值**。出公网只能走注入代理（直连被墙），代理对 GitHub 间歇 502、对 npm 稳定；只共享 localhost（PG/Redis 用 127.0.0.1）。
- **本机 PowerShell + GBK（§61，勿回退）**：① npm script 不许裸 glob（`"tests/**/*.test.ts"` 带引号交 Node 22 glob）；② Python stdout 必须 `reconfigure(errors="replace")`；③ 保留 `server.watch.ignored: ['**/public/_*.html']`；④ 不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`（残留 `lock:sweep:global` 60s TTL 挡 :3001）；⑤ 沙箱冒烟用 puppeteer 的 `chrome-headless-shell`（`EDGE_PATH`）。`authority.expected` 追随落库值，并发测试两路候选值必须相邻递减。

## 5. 本机环境（PG / Redis / Android）
- **PG = Windows 服务 `PostgreSQL16`**（127.0.0.1:5432），本机 `Start-Service PostgreSQL16` / `sc.exe start`（⚠️ PowerShell 里 `sc` 是 `Set-Content` 别名）。Redis `X:/Six/redis-runtime/redis-server.exe --port 6379`（X=D 家用 / E 公司），`redis-cli PING` 用 `127.0.0.1`。
- **启动约定（杰哥 2026-11-13 定）**：PG/Redis 由杰哥双击 `start-mpk-runtime.bat`（仓库外、幂等）启动；tx 开工前只探活（5432/6379、`health`），缺失**明确告知杰哥去启动**，不自行注册服务或拉进程顶替。后端脱离 AI 会话用 `start-mpk-backend.bat`（仓库根，CRLF）。
- ⚠️ **bat 必须 CRLF + 块内 echo 禁裸 `()`**：`Write` 产出 LF 会让 `cmd.exe` 把 `if (...)` 解析错→闪退；用 `sed -i 's/\r$//; s/$/\r/'` 转 CRLF。沙箱 Bash 禁调 `cmd.exe`。
- 后端 `.env`：`DATABASE_URL=postgresql://mpk@127.0.0.1:5432/monsterpk`、`REDIS_URL=redis://127.0.0.1:6379`、`PORT=3001`、`CORS_ORIGIN=http://localhost:5173,http://localhost`。
- **Android 工具链**：JDK `D:/jdk21/jdk-21.0.10+7`、SDK `D:/android-sdk`（android-36）、ADB `D:/game/leidian/LDPlayer14/adb.exe`（雷电 `emulator-5554`，1080×1920 / 360dp）。⚠️ **绕开 gradlew 联网**（下 zip 卡 60%）：直调 `~/.gradle/wrapper/dists/gradle-8.14.3-all/99x8n45tzh0zr4vi9rz6hydd7/gradle-8.14.3/bin/gradle assembleDebug --offline --console=plain --no-daemon`，一次性 export `JAVA_HOME`/`ANDROID_HOME=D:/android-sdk`（勿写 `local.properties`），约 8~9s。⚠️ `adb shell` 无 `monkey`，用 `am start -n com.monster.game/.MainActivity`。真机取证：`adb forward tcp:9222 localabstract:webview_devtools_remote_<pid>` + CDP `Runtime.evaluate`。

## 6. 后端架构快照（细节 bug_log §60/§64~§70）
- 存档三层校验 `saveValidator`→`antiCheat`→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前拦整包 PUT 夹带真值。W6 PG 行版本 CAS + `roomUnitOfWork` 事务 + DB 原子 quota + 租约 token（WS 监听器必须在**任何 await 之前**挂载）；W7 `WildStorage` 全 async + 四组 Lua（`useRedisStorage` 须在心跳启动前装配，内容生成不能进 Lua）；W8 `kvStore` TTL（空前缀 `clear()` 拒绝执行）、`BattleStorage` **物理 TTL=逻辑×2**、馆主 CD 原子 `acquire`、会话修 `hydrate()` + `sess:rev:*`。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/越权写/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 bug_log.md、HANDOFF.md）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`lib/env.ts` `.env` 路径曾算错 → 用实测 `process.env.XXX`。Windows 盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`、模板禁内联 module script、dev 必须 `host:0.0.0.0`。带 RNG 的 E2E 必须重试到 `finished` 或 `abandon`。
- 通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。**E2E 一律 `127.0.0.1` 不用 `localhost`**（Node 首选 ::1，后端只听 IPv4 → 全 ABORT）；`harness.BASE` 默认 127，但 **`ORIGIN` 必须留 `localhost`**（WS 握手 Origin，CORS 精确匹配）。
- **APK WebView 联调**：`androidScheme:"http"` → WebView origin = `http://localhost`（无端口），`API_BASE` 默认 `http://localhost:3001`；`CORS_ORIGIN` 必须精确列 `http://localhost`，`isOriginAllowed` **精确匹配 fail-closed**（杰哥 2026-11-15 拍板删 `*`）。dev APK 需 `usesCleartextTraffic="true"`；StatusBar 由 `MPK_DEV_APK=1 npx cap sync android` 烘焙（`Style.Dark="DARK"` = 深底浅图标，勿按 README 改 LIGHT）。设备 `localhost:3001` 靠 `adb reverse`，断连测试 `--remove-all`。
- **健康探测禁缓存**：`api.health()` 不带 `cache:"no-store"` 时断网后 Chromium 返回缓存 200 → 假在线；现强制 `no-store` + `AbortController` 超时 + 防堆积，`apiHealth.test.ts` 锁死。流程踩坑复盘 §71/§73。

## 8. 收官索引与验收锚点（勿删）
- W6 房间+quota（#181~#188）✅；W7 `e2e:w7wild` 14/14 ✅；W8 `e2e:w8shared` 18/18（**没走 userId 粘性路由降级**）✅；W9 `reverseProxy.mjs` + `e2e:multi` 42/42 + `gracefulShutdown`，**已真正开第二实例** ✅；`e2e:game` 42/42，测试脚本坑 §67。全量 `verify` 曾卡前端 vitest，以「后端管线 + 对应 e2e」作验收口径。
- **P4-2a/b/c/d/e 全 ✅**（排期契约 `P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 slotLock 串行（规范 §21）；P4-1 ✅ 顶号与共享野怪。
- 台账：F01/F02、F14 已偿还；**F04** 不写 `SaveData`（等级真值在服务端独立表）；**F16** 六房副本已实现；**F17 单档化已偿还**（第 11 条迁移 `SCHEMA_VERSION` 10→11）。
- 冻结：F15 1v1 零产出；P4-3 C2C **阶段冻结，不打算开放交易系统**。P5-1/F10 评估已被实施定稿取代，「不改任何产品代码」约束自 W0 起解除。
