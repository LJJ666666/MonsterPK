# MEMORY.md — MonsterPK（兽域手记）
> 权威源本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。细节以 `.trae/documents/` 规范/排期/bug_log 为准。

## 1. 方向 / 进度
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`），Node+TS 后端、强制登录。北极星：**服务端权威 + 实时多人同玩**：客户端只发意图、收状态、渲染。
- 本地存档 11-13 全删；刷新走 `GET /api/save`，`BootGate` 拉到档前不渲染路由。
- 不变式：每块状态一个 owner key（档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态；个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单仅管理员；改档/GG/加速器拦截+封号；改时间不封号但不生效；顶号旧 token 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e、F18-a/b/c/d、A1~A6、P5-1 W0~W9、P5-3 本机部分 ✅；F15 零产出、P4-3 C2C **阶段冻结**、**不打算开放交易系统**。
- **P4 台账（勿删）**：**P4-2 五阶段全部完成**（P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅，契约 `P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 写入并发控制；**P4-1 ✅** 顶号与共享野怪。**下一步**见末条。
- P5-1 锚点（勿删）：**P5-1 W4 ✅**；W6.1 异步化+CAS；**W6.2 事务边界**；**W6.3 DB 计数**；W6.4~W9 见 §66~§70。
- 选型 B：PG 唯一真值 + Redis 锁/租约/TTL/pub-sub/临时态，**Redis 不存权益真值**。权威 `P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`（**实施设计定稿**，W0 起「不改产品代码」解除）；`P5-1 / F10 共享存储迁移评估` 已被取代。
- 债务：**F01/F02 已偿还**；**F14 已偿还**、**F16** 六房副本已实现；F04 真值在服务端独立表、**不写 `SaveData`**；**F17 单档化已实现并偿还**。
- **下一步**：① 玩法重做 W1~W5 已全部完成上线（§90，提交 `97a4144`）；② 演武堂入口已迁回各自地图（§91）；③ P5-3 切云（域名+TLS+正式 keystore+托管 PG/Redis）；④ 房间内核 A/B 评估见 `房间内核AB项_当前适配性评估_2026-11-16.md`：A（normalizeRoom 补数组）低价值可顺手、B（64 窗口→唯一表）是真缺陷值得单开；⑤ 钻石商店（广告/充值买进化道具，本轮明确不做）。
- 里程碑索引：11-14~15 真机+UI §71~§74；P5-3 本机 §75；测试资产 §76/§77；交接 §78/§79（`HANDOFF.md` + 带回公司清单）；F18-d §80；bat §81；p42e §85~§88；P4 §89；玩法重做 §90；演武堂入口迁移+A/B评估 §91。
- **演武堂入口口径（§91）**：馆主挑战**不在 `GameHeader`**，而在每张城镇地图详情页的本城馆主卡片（7 城 ↔ 7 馆主一一对应），只发 `startGymBattle(currentLocation.id)`；`GymModal.tsx` 已删。`smoke:f18b` 探针用「地图列表整行 button（含城名+进入）」进入详情，非独立"进入" button。

## 2. 技术栈 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`（剧情 `src/game/story.ts`）；`useGameStore.ts` 无 persist，`save` 只是服务端快照的渲染副本，`SCHEMA_VERSION`=**12**（W2 加 `expShareOn` 升版；后端 `EXPECTED_SAVE_VERSION` 同步），BattleState 不进存档。
- 后端 Fastify4+Prisma5+PG16+zod+tsx；模型 `Room`/`RoomQuota*`/`Boss*Grant`/`BadgeGrant`/`AchievementGrant`/`StoryBeatSeen`；改 schema 前停 :3001（Windows DLL 锁）→ migrate dev → generate；`Save.data` 存 JSON 文本、`revision` 独立列。
- 测试：前端 vitest（node 环境、`renderToStaticMarkup`、无 jsdom）；后端 `node:test` 在 `backend/tests/`，两套不混跑。`verify.mjs` **64 阶段 / 6 分组**（`check:inventory` 门禁 34 条排最前）；前端 161、后端 **534**、E2E **39 套**（新增 `e2e:story_reward`）、冒烟 16 套、doc_check 232。**新增阶段必须同改 `STAGES` + `GROUPS`**。

## 3. 硬约束
- 新增**存档**字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `EXPECTED_SAVE_VERSION`；前端已无 migrate。
- **展示类/去重类状态不塞存档**（F04、F18-d）：服务端独立表 + `@@unique` + upsert 幂等 + 专用 GET/POST。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，**不留兼容后门/旧链路/开关**。
- 服务端权威：上报一律校验；`battleApi.ts` **不做离线降级**、旧意图 `capture` 已删、**下线 `battle_reward`**。发奖顺序：占位→readSave→发奖→同步 `authority.expected`→`commitState`（§28）；新玩法分支显式穷举。
- 写档入口只有「快照 `importSaveJson`（含 WS `session.state`）」与「意图 `intents.ts`」；`resetLocalSave()` 只用于丢弃内存副本。**不引入本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让 `export` 落进对象内部 → 改完立刻 `npm run check`。禁 `crypto.randomUUID()`；`strict:false`，判别联合用 `'code' in result`；Hook 在组件顶层。
- UI：页面根 `.page-shell`+`.safe-top`（**只用真实 `env(safe-area-inset-top)`，禁 24px 兜底**）；弹窗 `ModalShell`；页头 `GameHeader`；**禁远程字体/CDN**；小按钮 36px 兜底。先读 `.impeccable.md`；移动端优先，`max-w`+`overflow-auto`+`max-h`，实测 `scrollWidth`。
- 账号边界：换账号/退出必须 `signOut()`（停 WS/写通道 + 清 `save`/`battle` + 清 revision），`bootstrapSave()` 收 404 必须清空旧渲染副本。
- 工作流：结论先行、中文、可复现证据；**不用等待/猜测代替一次取证**；后台任务退出码不是成功判据；长命令禁裸 `&&` 串 `grep`；截图字节相同要怀疑操作未生效；验收只认源码/产物。
- **文档/脚本禁写死单机绝对路径**：一律「env 覆盖 → 常见位置探测 → 明确报错」（示范 `apk_build_guide.md §1`、`check_home_env.py`、`perf-adb.mjs` 的 `MPK_ADB`）。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev`（端口只由 `MPK_FRONT_PORT` 控制，默认 5173；**勿传 `--host/--port`**）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。node 22.22.2，remote `LJJ666666/MonsterPK.git`。新机：`cp .env.example .env`→两侧 `npm install`→`migrate deploy`+`generate`→`npm run dev`。
- **verify 口径**：全量 `npm run verify -- --strict`（63 阶段含 16 套冒烟）；服务缺失默认 FAIL，仅 `--allow-missing-services` 退 SKIP；`--skip=smoke` 只用于离线排查，**不得当默认**；离线 `--only=check,unit,docs --strict`。改 `vite.config.ts` 后必须真跑 `--only=smoke`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾验收数字）→push→核对 `HEAD==origin/master`、工作树干净、tag 在远端。推送失败：只读探活 + 最多 5 次原样重试（不换代理/不改 config），持续 502 交本机 `push-mpk.bat`。**Git 汇报只给一句话**。
- **配置分层硬约束（§57，勿回退）**：沙箱层（`HTTPS_PROXY`/`CODEBUDDY_*`）≠ 系统层（注册表 `ProxyServer=8693`、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库；覆盖 env 只用一次性前缀；**项目层是唯一可提交真值**。
- **PowerShell + GBK（§61）**：npm script 禁裸 glob；Python stdout `reconfigure(errors="replace")`；保留 `server.watch.ignored`；不测选主的双实例 E2E 加 `MPK_DISABLE_SWEEP=1`；冒烟统一走 `scripts/lib/browser.mjs` 的 `resolveBrowser()`（禁写死 msedge，门禁 34 条），`waitFor` 每 4 轮挂真实 `fetch`。

## 5. 本机环境
- **PG = Windows 服务 `PostgreSQL16`**（127.0.0.1:5432），`Start-Service PostgreSQL16`（⚠️ PowerShell 里 `sc` 是 `Set-Content`）。Redis `X:\Six\redis-runtime\redis-server.exe --port 6379`（X=D 家 / E 公司）。
- ⚠️ `pg-runtime` 布局两台不同：家里 `native\bin`、公司 `package\native\bin`，bat 两处都探。**判 PG 活只看 5432 端口，不看 `pg_ctl status`**（服务态 pid 归 NetworkService，status 恒非 0 → 误报 §81）；绑定地址无关 + 15 次重试。
- **启动约定**：PG/Redis 由杰哥双击 `start-mpk-runtime.bat`（仓库外、幂等）；tx 开工前只探活（5432/6379/health），缺失**明确告知杰哥**，不自行拉进程顶替。后端脱离会话用 `start-mpk-backend.bat`。
- ⚠️ bat 必须 CRLF + 块内 echo 禁裸 `()`（LF 会让 `cmd.exe` 解析错→闪退），写完转 CRLF 取证；沙箱 Bash 禁调 `cmd.exe`。
- 后端 `.env`：`postgresql://mpk@127.0.0.1:5432/monsterpk`、`redis://127.0.0.1:6379`、`PORT=3001`、`CORS_ORIGIN` 列 5173/5174/localhost（正式包加 `https://localhost`）。
- **Android（路径因机而异，先探再用）**：JDK **必须 21**；公司 `E:/Six/{jdk/jdk-21,android-sdk,gradle-dist/gradle-8.14.3,gradle-user-home}`（android-36 / build-tools 35.0.0），家里 `D:/jdk21`+`D:/android-sdk`；adb `D:/game/leidian/LDPlayer14/adb.exe`（`MPK_ADB` 覆盖）。绕开 gradlew：`bin/gradle assembleDebug --offline --console=plain --no-daemon`；无 `monkey`，用 `am start -n com.monster.game/.MainActivity`。清单 `apk_build_guide.md §1`。

## 6. 后端架构快照（细节 §60/§64~§70/§80/§88）
- 存档三层校验 `saveValidator`→`antiCheat`→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前拦整包 PUT 夹带真值。W6 PG 行版本 CAS + `roomUnitOfWork` 事务 + DB 原子 quota + 租约 token（WS 监听器必须在**任何 await 之前**挂载）；W7 `WildStorage` 全 async + 四组 Lua；W8 `kvStore` TTL、`BattleStorage` 物理 TTL=逻辑×2、馆主 CD 原子 `acquire`、会话 `hydrate()` + `sess:rev:*`。
- F18-d：`StoryBeatSeen` + `GET/POST /api/story/seen`，白名单来自 `CONTENT.storyBeatIds`（`gen-content` 生成，`check:content` 防漂移）。
- ⚠️ **p42e/§85~§88**：定案＝测试断言假定顺序（产品成立），已改语义断言 + 新增 `e2e:nonce`；**P1 配额重复计数已修**（`finishQuota`→`markQuota` 只改内存态 + `applyQuota` 在 bump 之后落计数，`loadAndMutate` 加 `afterCas`）；**P3 被拒不烧 nonce 已修**（先 push nonce + `persistEvenIfFailed`）；**P4 nonce 绑定座位已修**（§89：键 `${seat}:${nonce}`，两处判定同改，零 schema/迁移，旧裸串一次性失效）。**留白**：P5 `normalizeRoom` 缺数组、P6 注释、64 窗口淘汰。
- 已挡：改档/伪造捕获/白嫖购买/重复领奖/改时间/越权写/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜/伪造剧情 id；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 bug_log、HANDOFF）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`.env` 路径曾算错 → 用实测 `process.env.XXX`；盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`。
- 通用：等「元素可用」非「存在」；**周期任务/外部进程推进的状态禁 `sleep`+短窗口，改「先挂监听再等条件」**（§83/§87 同一坑三次）；verify 漏 `GROUPS`；同文件同轮多 Edit 互相覆盖。**E2E 一律 `127.0.0.1`**，`ORIGIN` 必须留 `localhost`；进程内监听必须在任何 `await` 之前挂载。
- **APK WebView**：`androidScheme:"http"` → origin `http://localhost`（dev APK 需 `usesCleartextTraffic`）；正式包 `https://localhost` 必须进 CORS；`isOriginAllowed` 精确匹配 fail-closed；设备 `localhost:3001` 靠 `adb reverse`。
- **健康探测禁缓存**：`api.health()` 必须 `cache:"no-store"` + 超时，否则断网后 Chromium 返回缓存 200 假在线（`apiHealth.test.ts` 锁死）。
- **冒烟宿主（§76）**：Vite 6 把任意 `*.html` 当 SPA 入口，`public/_*.html` 探针页由 `devProbePlugin` 原样返回；`Arena.tsx` 的「回程」只在空态/结算态渲染，别拿它判「进入战斗」。
