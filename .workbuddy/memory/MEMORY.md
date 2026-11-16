# MEMORY.md — MonsterPK（兽域手记）
> 权威源本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。细节以 `.trae/documents/` 的规范/排期/bug_log 为准。

## 1. 方向 / 进度
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`），Node+TS 后端、强制登录。北极星：**服务端权威 + 实时多人同玩**，客户端只发意图、收状态、渲染。
- **本地存档 11-13 全删**（persist / localStorage 副本 / LWW / 离线重传 / rebase）；刷新走 `saveBootstrap.ts` 的 `GET /api/save`，`BootGate` 拉到档前不渲染路由。
- 不变式：每块状态一个 owner key（档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态；个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号；改时间不封号但不生效；顶号旧 token 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e、F18-a/b/c/d、A1~A6、**P5-1 W0~W9 全 ✅**（PG+Redis，W9 起真开第二实例）、P5-3 本机部分 ✅、**F18-d 剧情已读 ✅（11-16，§80）**。
- **P4 台账（锚点，勿删）**：**P4-2 五阶段全部完成**（P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅，契约 `P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 写入并发控制（规范 §21）；**P4-1 ✅** 顶号与共享野怪（§22）。**下一步**见末条。
- P5-1 锚点（勿删）：**P5-1 W4 ✅（50/50，§58）**；W6.1 异步化+CAS §60/§61；**W6.2 事务边界**（`roomUnitOfWork`，§64）；**W6.3 DB 计数**（quota 原子条件更新，§65）；W6.4~W9 见 §66~§70。
- 选型 B：PG 唯一真值 + Redis 锁/租约/TTL/pub-sub/临时态，**Redis 不存权益真值**。权威 `P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`（**实施设计定稿**，自 **W0** 起「不改产品代码」解除）；原 `P5-1 / F10 共享存储迁移评估` 已被它取代。
- 债务：**F01/F02 已偿还**；**F14** 已偿还、**F16** 六房副本已实现；F04 真值在服务端独立表、**不写 `SaveData`**；**F17 单档化已实现并偿还**（`SCHEMA_VERSION` 10→11）。冻结：F15 1v1 零产出；P4-3 C2C **阶段冻结**，**不打算开放交易系统**。
- **下一步（三条线，需杰哥推进/拍板）**：① P5-3 切云 —— 阻塞于域名+TLS+正式 keystore+托管 PG/Redis；② 玩法缺口 `玩法缺口评估_进化石与关键道具_2026-11-15.md` P1~P5（进化石无适配物种最实、`exp_share` 口径未定），零产品语义改动；③ 内容扩充。**欠一单**：p42e nonce 竞态（§82，先设计后动手）。
- 里程碑索引：11-14~15 真机+UI §71~§74；P5-3 本机 §75；测试资产 §76/§77；交接 §78/§79（`HANDOFF.md` + `带回公司_交接清单_2026-11-16.md`，换机器先看这两份）；F18-d §80；bat 误报 §81。

## 2. 技术栈 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`（剧情 `src/game/story.ts`）；`useGameStore.ts` **无 persist**，`save` 只是服务端快照的渲染副本，`SCHEMA_VERSION`=11，**BattleState 不进存档**。
- 后端 Fastify4+Prisma5+PG16+zod+tsx；关键模型 `Room`/`RoomQuota*`/`Boss*Grant`/`BadgeGrant`/`AchievementGrant`/`StoryBeatSeen`；**改 schema 前停 :3001**（Windows DLL 锁）→ `migrate dev` → `generate`；`Save.data` 存 JSON 文本、`revision` 独立列。
- 测试：前端 vitest（node 环境、`renderToStaticMarkup`、无 jsdom）；后端 `node:test` 在 `backend/tests/`，两套不混跑。
- 资产：`verify.mjs` **63 阶段 / 6 分组**（`check:inventory` 门禁排最前，**34 条**）；前端 **161**、后端 **509**、E2E **38** 套、冒烟 **16** 套、doc_check **232**。**新增阶段必须同改 `STAGES` + `GROUPS`**。

## 3. 硬约束
- 新增**存档**字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `saveValidator.ts` 的 `EXPECTED_SAVE_VERSION`；**前端已无 migrate**。
- **展示类/去重类状态不塞存档**（F04、F18-d）：服务端独立表 + `@@unique` + upsert 幂等 + 专用 GET/POST。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，**不留兼容后门/旧链路/开关**。
- 服务端权威：上报一律校验；`battleApi.ts` **不做离线降级**、旧意图 `capture` 已删、**下线 `battle_reward`**。发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（§28）；新玩法分支显式穷举。
- 写档入口只有「快照 `importSaveJson`（含 WS `session.state`）」与「意图 `intents.ts`」；`resetLocalSave()` 只用于**丢弃**内存副本。**不引入本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部 → 改完立刻 `npm run check`。前端禁用 `crypto.randomUUID()`（用 `rules.ts` 的 `uuid()`）；`strict:false`，判别联合用 `'code' in result`；Hook 在组件顶层。
- UI（11-15）：页面根 `.page-shell`+`.safe-top`（**只用真实 `env(safe-area-inset-top)`，禁 24px 兜底**）；弹窗一律 `ModalShell`；页头 `GameHeader`；**禁远程字体/CDN**；小按钮 36px 兜底。先读 `.impeccable.md`；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，实测 `scrollWidth`。
- 账号边界：换账号/退出必须 `signOut()`（停 WS/写通道 + 清 `save`/`battle` + 清 revision），`bootstrapSave()` 收 404 必须清空旧渲染副本；否则写操作全被 `SAVE_NOT_FOUND` 拒（11-15 真机复现）。
- 工作流：结论先行、中文、可复现证据；**不用等待/猜测代替一次取证**；**后台任务退出码不是成功判据**；长命令禁裸 `&&` 串 `grep`；截图字节相同要怀疑操作未生效；验收只认源码/产物。
- **文档/脚本禁写死单机绝对路径**（11-16）：一律「env 覆盖 → 常见位置探测 → 明确报错」，示范 `apk_build_guide.md §1`、`check_home_env.py`、`perf-adb.mjs` 的 `MPK_ADB`。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev`（端口只由 `MPK_FRONT_PORT` 控制，默认 5173；**勿再传 `--host/--port`**）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。node 22.22.2，remote `LJJ666666/MonsterPK.git`。新机：`cp .env.example .env`→两侧 `npm install`→`migrate deploy`+`generate`→`npm run dev`。
- **verify 口径**：全量 `npm run verify -- --strict`（前后端在线、**62 阶段含 16 套冒烟**）；服务缺失默认 FAIL，只有 `--allow-missing-services` 退 SKIP；`--skip=smoke` 只用于离线排查，**不得当默认**（门禁锁死）；离线跑 `--only=check,unit,docs --strict`。改 `vite.config.ts` 后必须真跑 `--only=smoke`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push→核对 `HEAD==origin/master`、工作树干净、tag 在远端。推送失败：只读探活 + 最多 5 次原样重试（不换代理/不改 config），持续 502 交本机 `push-mpk.bat`。**Git 汇报只给一句话**。
- **配置分层硬约束（§57，勿回退）**：沙箱层（`HTTPS_PROXY`/`CODEBUDDY_*`）≠ 系统层（注册表 `ProxyServer=8693`、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库，覆盖 env 只用一次性前缀，**项目层是唯一可提交真值**。
- **PowerShell + GBK（§61）**：npm script 不许裸 glob；Python stdout 必须 `reconfigure(errors="replace")`；保留 `server.watch.ignored: ['**/public/_*.html']`；不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`；冒烟无头浏览器**统一走 `scripts/lib/browser.mjs` 的 `resolveBrowser()`**（禁写死 msedge，门禁 34 条锁死；沙箱内自动命中 puppeteer 的 `chrome-headless-shell`），`waitFor` 每 4 轮挂真实 `fetch`。

## 5. 本机环境
- **PG = Windows 服务 `PostgreSQL16`**（127.0.0.1:5432），`Start-Service PostgreSQL16`（⚠️ PowerShell 里 `sc` 是 `Set-Content`，沙箱拦 `sc.exe`）。Redis `X:\Six\redis-runtime\redis-server.exe --port 6379`（X=D 家 / E 公司）。
- ⚠️ **`pg-runtime` 布局两台不同**：家里 `native\bin`，公司 `package\native\bin`，bat 两处都探。**判 PG 活没活只看 5432 端口，不看 `pg_ctl status`**（服务态 pid 归 NetworkService，status 恒非 0 → 误报 FAILED，§81）。
- **启动约定（11-13）**：PG/Redis 由杰哥双击 `start-mpk-runtime.bat`（仓库外、幂等）；tx 开工前只探活（5432/6379/health），缺失**明确告知杰哥去启动**，不自行注册服务或拉进程顶替。后端脱离会话用 `start-mpk-backend.bat`。
- ⚠️ **bat 必须 CRLF + 块内 echo 禁裸 `()`**：`Write` 产出 LF 会让 `cmd.exe` 解析 `if (...)` 出错→闪退；写完转 CRLF 再数 `\r\n` 取证。沙箱 Bash 禁调 `cmd.exe`。
- 后端 `.env`：`postgresql://mpk@127.0.0.1:5432/monsterpk`、`redis://127.0.0.1:6379`、`PORT=3001`、`CORS_ORIGIN` 列 5173/5174/localhost（正式包还要 `https://localhost`）。
- **Android（路径因机而异，先探再用）**：JDK **必须 21**（PATH 上的 Temurin 17 报「无效的目标发行版 21」）；公司全在 `E:/Six` 下（`jdk/jdk-21`、`android-sdk` android-36 / build-tools 仅 35.0.0、`gradle-dist/gradle-8.14.3`、`gradle-user-home`）；家里是 `D:/jdk21` + `D:/android-sdk` + `~/.gradle/wrapper/dists`；雷电 adb 两台都在 `D:/game/leidian/LDPlayer14/adb.exe`（`MPK_ADB` 可覆盖）。⚠️ **绕开 gradlew 联网**：直调 `bin/gradle assembleDebug --offline --console=plain --no-daemon`，一次性 export `JAVA_HOME`/`ANDROID_HOME`（勿写 `local.properties`）；`adb shell` 无 `monkey`，用 `am start -n com.monster.game/.MainActivity`。清单见 `apk_build_guide.md §1`。

## 6. 后端架构快照（细节 §60/§64~§70/§80）
- 存档三层校验 `saveValidator`→`antiCheat`→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前拦整包 PUT 夹带真值。W6 PG 行版本 CAS + `roomUnitOfWork` 事务 + DB 原子 quota + 租约 token（WS 监听器必须在**任何 await 之前**挂载）；W7 `WildStorage` 全 async + 四组 Lua（`useRedisStorage` 须在心跳启动前装配，内容生成不能进 Lua）；W8 `kvStore` TTL（空前缀 `clear()` 拒绝执行）、`BattleStorage` 物理 TTL=逻辑×2、馆主 CD 原子 `acquire`、会话 `hydrate()` + `sess:rev:*`。
- F18-d：`StoryBeatSeen` + `GET/POST /api/story/seen`，白名单来自 `CONTENT.storyBeatIds`（`gen-content` 从 `src/game/story.ts` 生成，`check:content` 防漂移），校验纯函数 `game/storyBeats.ts`。
- ⚠️ **p42e/§85~§88 房间内核**：nonce 竞态定案＝断言假定顺序（产品成立），已改语义断言 + 新增 `e2e:nonce`；**P1 配额重复计数已修**（`finishQuota` → `markQuota` 只改内存态 + `applyQuota` 在 bump 之后落计数，`loadAndMutate` 加 `afterCas`）；**P3 被拒不烧 nonce 已修**（先 push nonce + `persistEvenIfFailed`，原来 `loadAndMutate` 只在 `res.ok` 时 bump 才是真根因）。**留白**：P4 nonce 未绑座位（需数据迁移）、P5 `normalizeRoom` 缺数组、P6 注释。
- 已挡：改档/伪造捕获/白嫖购买/重复领奖/改时间/越权写/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜/伪造剧情 id；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 bug_log、HANDOFF）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`.env` 路径曾算错 → 用实测 `process.env.XXX`；盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`；带 RNG 的 E2E 必须重试到 `finished`/`abandon`。
- 通用：等「元素可用」非「存在」；**由周期任务/外部进程推进的状态禁 `sleep`+短窗口，改「先挂监听再等条件」**（§83/§87 同一坑三次）；verify 漏 `GROUPS`；同文件同轮多 Edit 互相覆盖（改落盘脚本批量替换）。**E2E 一律 `127.0.0.1`**；`harness.BASE` 默认 127，**`ORIGIN` 必须留 `localhost`**（WS 握手）。进程内监听必须在任何 `await` 之前挂载（`attachWsHandlers`、`BootGate` 的 `startSessionSync` 先于 `startRealtime`）。
- **APK WebView**：`androidScheme:"http"` → origin `http://localhost`（无端口），dev APK 需 `usesCleartextTraffic="true"`；正式包 `https://localhost` 必须进 CORS；`isOriginAllowed` **精确匹配 fail-closed**；设备 `localhost:3001` 靠 `adb reverse`。
- **健康探测禁缓存**：`api.health()` 必须 `cache:"no-store"` + 超时，否则断网后 Chromium 返回缓存 200 假在线（`apiHealth.test.ts` 锁死）。
- **冒烟宿主（§76）**：Vite 6 把任意 `*.html` 当 SPA 入口，`public/_*.html` 的 seed/probe 页必须由 `devProbePlugin` 原样返回；`Arena.tsx` 的「回程」只在空态/结算态渲染，别拿它判「进入战斗」。
