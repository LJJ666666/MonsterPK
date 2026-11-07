# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**；镜像 `.trae/documents/项目记忆.md`，改完任一侧跑 `python scripts/sync_memory.py`（`--reverse`/`--check`）。
> 日志 `.workbuddy/memory/YYYY-MM-DD.md` 追加写；`.trae/documents/` 的 PRD/任务表/bug_log/规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）：营地→遭遇→战斗→捕获→结算→营地/图鉴。原纯前端；11-03 起自建 Node+TS 后端，11-04 强制登录。
- **北极星（11-04 拍板）**：**服务端权威 + 实时多人同玩**（战斗/捕获/经济服务端结算，客户端只发意图、收状态、渲染）。本地存档是过渡态，P5 去除；P0-3 自动同步为过渡桥接。
- **反作弊（11-05 拍板）**：测试菜单数据**只放行管理员**；改档/GG/加速器一律拦截 + 封号弹窗 + 登出；**改系统时间不封号，只要求「不生效」**。P1-1b 只识别「明显改档」（任务表 §六 / 规范 §13）。
- 总表 `.trae/documents/开发任务优先级_2026-11-04.md`：P0 五项 ✅ / P1 全部 ✅ / **P2-1 ✅ P2-2 ✅** / **P3-1a/1b/1c ✅** / **P3-2 ✅** / **P4-0 ✅（CAS + 槽位锁）** / **P4-1 ✅（顶号 + 共享野怪）** / **下一步 P4-2 联机对战 / 共斗** / P5 上线去本地。
- **P4-1 口径（11-07 杰哥拍板）**：同账号多端**不合并本地改动、不静默切档**；后来者登录顶号，前者**直接下线**（旧 token 所有 REST 403，非只断 WS）。共享真值全在服务端，客户端不得改共享世界。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由 `/` 首页、`/camp` 营地、`/arena` 训练场、`/auth` 登录（守卫 `App.tsx`）。
- 内容唯一源 `src/game/data.ts`（40 幻兽 / 22 道具 / 7 城镇 / 18 属性 / `TYPE_CHART` / `IDLE_CONFIG` / `INITIAL_INVENTORY` / `STARTERS` / `START_LOCATION_ID`）；规则 `rules.ts`；挂机 `idle.ts`（仅展示换算）；遭遇 `gen.ts`。
- **服务端战斗（P3-1）**：`content.generated.ts`（`gen:content` 派生）+ `game/rules.ts`（RNG 注入）+ `game/battle.ts`（状态机/结算）；`modules/battle.ts` 四接口 + `lib/battleSession.ts` 注册表；`battleView` 下发队伍完整个体与 `levelMin/levelMax`。前端 `lib/battleApi.ts`，**无本地降级**。
- **服务端写操作（P3-2）**：`game/mutations.ts` 纯函数 + **`POST /api/game/:op`** → `commitState(source='action')` 回整包 `data`，前端 `lib/gameApi.ts` 应用并抑制一次回传；战斗中 `BATTLE_IN_PROGRESS`。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 单一真源派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start`/`Auth`/`Camp`（5 Tab）/`Arena`；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`。
- 同步链路 `lib/sync.ts`（`attemptUpload`/`ensureRevision`/`healFromConflict`/`commitIntent`/`suppressNextUpload`/`stopAutoSync`）、`syncErrors`（4xx 除 429 永久，**409 判 `conflict`**）/`api`（**`isSessionSuspended()` 传输层硬闸**）/`auth`（`setToken` 复位顶号态）/`admin`（仅 UI）。`App.tsx` 全局含 `BanGate`/**`SessionGate`**/`SyncBootstrap`/`SessionBootstrap`/`RealtimeBootstrap`；`ws.ts` 转发 `session.state`+`wild.state`，`sessionState.ts` 存 revision/在途/下线态（零依赖）。
- **P4-1 只读层**：`sessionReplaced.ts`（顶号通知闸门）、`wild.ts`（`useWildList()` 只读 Hook，REST 首拉 + WS 快照按区域 revision 幂等 + 30s 兜底轮询）；`Arena.tsx` 展示「附近野怪（多人共享）」，点挑战走带 `wildId` 的开局意图。
- **测试边界**：前端 vitest 只收 `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`。两套框架不能混跑（§13）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION`（= persist `version`）并补 migrate 分支**，老存档必须能玩；后端 `EXPECTED_SAVE_VERSION`(=10) 必须同步改，否则新档全被拒。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部 → `Unexpected keyword 'export'`。改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一 `rules.ts` 的 `uuid()`。所有 Hook 必须在组件顶层。
- 移动端优先：弹窗小 `max-w` + `overflow-auto` + `max-h`；禁止大表格横向滚动；375px 实测 `scrollWidth`。
- `strict:false` / `noUnusedLocals:false` —— tsc 很宽松，别指望它兜逻辑。
- **服务端权威原则**：客户端上报的存档/战报/数值/意图，服务端必须校验；状态写入唯一入口是 `commitState()`；**WS 上行绝不写状态**。
- 前端设计先读 `.impeccable.md`（复古像素 / 野外手记；内联 SVG、零 CDN）。Capacitor 打包见 `apk_build_guide.md`。

## 4. 运行命令与环境
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**交接后服务不自动恢复**，先 curl 探活。
- **校验（首选一条命令）**：`npm run verify` —— **20 阶段**（check/test/build + 内容表 + 九组 E2E + 冒烟 ×3 + 文档与镜像），约 **51s**（**20/20** `VERIFY_OK`），自动清测试账号。子集 `--only=` / `--skip=`，CI 用 `--strict`；报告 `.verify-report.json`（gitignore）。
- **分项数字**：前端 `check` 0 / `test`（**96**）/ `build`；后端 `check` 0 / `test`（**230**）/ `check:content` 一致；E2E 依次 **62** / **30** / **41** / **25** / **48** / **50** / **41** / **30**（`E2E_P41_OK`）/ 115；headless 375px **15/15** + **15/15** + **13/13**（`UI_SMOKE_P41_OK`）；文档自检 51。E2E 需服务已起；RNG 用例须重复跑（§17）；改 `data.ts` 须 `gen:content` 一起提交。
- **清理**：`cd backend && npm run clean:e2e`（`--dry` 预览、`--prefix=` 追加）。只删测试前缀、**永不删 admin**；verify 自动执行一次。
- **账号管理**：`cd backend && npm run admin -- grant|revoke|ban|unban|list|audit <用户名>`。⚠️ 不授权用测试菜单会被封号。**绝不写死用户名**。
- 本机 `D:\MyJob\MonsterPK`（NTFS，11-07 重建）；remote `https://github.com/LJJ666666/MonsterPK.git`；node v22.22.2/npm 10.9.7。新机重建：`cp .env.example .env`（换 JWT_SECRET）→ `prisma migrate deploy` → `prisma generate` → `npm run dev`；改 schema 前停 :3001（DLL 锁 §12）。`.env`/`dev.db` 已 gitignore；dev/preview 无 `save_data.json` 时 `/api/save` 404 属正常。
- **Git 流程（11-07 杰哥定，每次提交执行，不用再问）**：验收通过 → `git tag -a rollback-YYYYMMDD-<阶段> <HEAD>` 推远端 → `git add -A` 确认无 `.env`/`*.db` → commit（中文分条、末尾写数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一, bcrypt hash, `role`/`bannedAt`/`banReason`, **`sessionVersion` 顶号代次**) + `Save`(userId+slot 复合唯一, data 文本, `schemaVersion`, `clientId`, `updatedAt`, **`authority`**, 3 槽) + `BanRecord` + **`IntentLog`**(userId+slot+nonce 唯一防重放)。迁移链 **5 条**（P4-1 加 `20261107164000_add_session_version`；改 schema 前停 :3001）。
- API：`auth/{register,login,me}`、`GET|PUT /api/save?slot=`、`POST /api/actions/:type`、`GET /api/session`、`POST /api/game/:op`、`POST /api/battle/{start,action,abandon}` + `GET /api/battle/current`、**`GET /api/wild?areaId=`**、`GET /api/health`、`GET /ws`。守卫查封号 → `403 ACCOUNT_BANNED`；旧代次 → `403 SESSION_REPLACED`；CORS 放行 5173。
- **存档三层（P1-1/P1-1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单防误封）→ `serverClock.ts`（未来时间戳钳制，改时间不生效、不封号）。
- **权威裁决（P1-2）**：意图 nonce → 服务端基线 + 掷骰/时钟/价格 → `authority.pending` → 客户端带 `intentNonce` PUT 核对增量（不符 400 不封号）。`PUT` 三分支：rebase / intentNonce / 普通单调比对。见规范 §14。
- **实时通道（P2-1）**：`upgrade` 五道闸（路径/Origin/JWT/查封号/**JWT `sv` 代次**）、心跳、上行 4KB·20 条每秒；封号 `bye` 复用 `<BanGate/>`。见规范 §15。
- **顶号（P4-1a）**：登录 `sessionVersion` +1 签进 JWT `sv` → `authenticate` 与 WS upgrade 双校验（`checkSessionVersion()`）→ 旧 token REST 全 403 `SESSION_REPLACED`；登录即 `kickUserConnections()`，`WsRegistry.takeover()` 同步原子接管（单账号连接上限 1），旧连接 `bye SESSION_REPLACED` + close 4001。前端 `SessionGate` 只读下线态：传输层拦非 `/api/auth/` 请求、`stopAutoSync()` 清队列、`replacedToken` 禁重连；**不合并、不上传旧档**（§22.1~22.4 / §27）。
- **共享野怪（P4-1b）**：`WildRegistry`（`lib/wildRegistry.ts`）纯内存每区域 3 只（TTL 5min / 抢占 30min / 结算留 10s）；**`claim()` 同步无 `await`**，Node 单线程保证捕获/挑战互斥；`resolve/release` 复核 `(userId, slot, battleId)`；**按区域独立 revision**。`GET /api/wild` 主题/等级**只查内容表 `LOCATIONS.wildAreas`**，未知区域固定 `grass 1-5`，忽略客户端 fallback。`battle/start` 带 `wildId` → `createBattle(..., { wild })`；结算/放弃/`sweep` 经 `broadcastAll()` 发跨账号 `wild.state`（上行无写入口，§22.5~22.7）。
- **在线权威态（P2-2）**：`gameSession` 按 `userId+slot` 内存态，`commitState()` **唯一写入口**（DB→内存→广播 `session.state`），revision 单调、断线 10min TTL；上行只 `session.resync`（§16）。**云同步（P0-3 桥接）**：`syncOnLogin` 冲突恢复 + 1.5s 防抖 PUT + 离线队列，被拒档不入队；客户端不能整包把资源改高（bug_log §15）。
- **服务端战斗（P3-1a/b）**：敌方/队伍/背包全取自服务端，`captureChance` 含稀有度与等级差，RNG 注入可复现；结束 `applySettlement` → `commitState(source='battle')` + 广播；公式与前端 `rules.ts` 由 `battleEngine.test.ts` 对照。
- **测试底座**：`tests/lib/harness.mjs`（HTTP/账号/存档/WS/断言/清理）+ `saveWriter.mjs`（按 token×slot 跟踪 revision）；`e2e_hardening.mjs` 115 项对抗（逐例断 status+code）；`numericRules.test.ts` 31 项数值矩阵；`scripts/verify.mjs` 编排；`clean-test-data.mjs` 清账号。
- **服务端写操作（P3-2）**：`POST /api/game/:op`（heal/use_item/evolve/learn_move 含 `discard`/队伍整理/travel/new_game）全部 `commitState(source='action')`；`checkPartyStateRegression()` 堵住 `digestOf` 不含 HP 的盲区；价格/挂机/初始背包/御三家/出生地全由内容表派生。见 §20。
- **写入并发控制（P4-0）**：PUT 与意图**必须带 `revision`**（缺 400 `REVISION_REQUIRED`），过期 409 `REVISION_CONFLICT` 回带快照（server-wins），校验在风控/nonce 前；`slotLock.ts` 按 `userId:slot` 串行读→校→写（**`commitState()` 不取锁**）；前端 409 → `healFromConflict()` **不重试**、意图裁决后写回新 revision。见 §21、bug_log §26。
- **能力边界**：**已挡**改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/伪造 rebase/普通账号调测试菜单/WS 伪造状态写入/伪造战斗动作与越权 battleId/GG 改内存/旧意图刷奖励/旧版本整包覆盖（CAS 409）/**顶号后旧设备继续写（REST 403）**/**抢已占野怪**/**改共享世界主题等级**；**未挡**加速器改动画节奏（不影响结算）/改本地展示态（只影响自己）。管理员只在服务端判定。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 后台任务报 `exit 4` / `0xC0000142` 是**进程被宿主回收**，非代码崩溃。
- **`lib/env.ts` `.env` 路径曾算错**（`../.env` → `backend/src/.env`），`JWT_SECRET` 长期回落硬编码默认值（严重安全缺陷）；11-05 改 `../../.env` 实测生效。**改配置代码必须实测 `process.env.XXX` 有值。**
- §25 P3-2 本地权威残留（任意地点回满、**HP 摘要盲区**、死道具、全灭惩罚可逃）；§26 CAS 六坑（6 个 E2E 集体红 → `saveWriter.mjs`；**锁改直通 E2E 仍全绿，只能靠 `slotLock.test.ts` 单测**；并发载荷须「变穷」）。
- §27 P4-1 七坑：只断 WS 会刷新互踢死循环（→ `sessionVersion`/JWT `sv`）/ 四组 E2E 打红**不加兼容开关** / 判别联合第三次复发（`'code' in result`）/ Prisma 迁移先停 :3001 / **全局 wild revision 设计错** / 客户端 fallback 改跨账号共享真值 / `setToken()` 忘复位下线态。
- §10~§24 见 bug_log：白屏/Hook、vitest EPERM、Prisma 锁、框架混跑、`.env` 路径、E2E 契约、用户名超长、strict 收窄、丢 body、死断言、个体值、MONEY 码、奖励后门。

## 7. 进度与遗留
- **已完成**：P1-2/P1-3（RNG/结算/时钟/nonce，捕获率含稀有度与等级差；**内容缺口**：仅 `spark_mouse` 有道具进化）；P2-1/P2-2（WS 通道 + GameSession）；P3-1a/1b（`gen-content.ts` 派生 + 战斗状态机 + 三键 30min TTL）；P3-1c（五入口分流 `/api/battle/*`，**不做离线降级**、**下线 `battle_reward`/`capture`**）；P3-2（写操作/新档/内容双源上移）；P4-0（CAS + 槽位锁）；缺陷修复（个体值 144 项 / money 码拆分，bug_log §21/§22）。
- **P4-1 ✅（11-07）**：顶号下线 + 共享野怪。`WildRegistry` 每区域 3 只、claim 原子互斥、按区域 revision；旧 token REST 403 `SESSION_REPLACED`，前端只读下线态不合并本地改动。证据：`verify` **20/20** `VERIFY_OK`（51.1s）、后端 **230** / 前端 **96** / `e2e:p41` **30** / `ui_smoke_p41` **13/13**；`p21` **41**、`p22` **25**、`p4` **41**、`hardening` 115 四组用例改顶号语义（**不加兼容开关**）。文档：规范 §22、bug_log §27、任务表时间线。**下一步 P4-2 联机对战 / 共斗**（需操作级同步；野怪池单进程内存态，P5-1 多实例要换共享存储 + 分布式抢占，§22.7）。
- **Git**：`fe159eb`→`bb04998`→`2f2c8b7`→`bbb1853`→`4acbd53`→`61a37c9`→`fd6d36b`→`04a35a8`→`93c1c50`→`d6205a8`（P0~P4-0）均已推送；P4-1 回滚点 `rollback-20261107-pre-p41`（→`d6205a8`）/ `rollback-20261107-post-p41` 已在远端。`dev.db`/`.env` 已 gitignore。
- **回家交接**：`HANDOFF.md` + `check_home_env.py` / `doc_check.py`；11-07 已在 `D:\MyJob\MonsterPK` 重建并 `ENV_CHECK_OK`。
