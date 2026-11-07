# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**；镜像 `.trae/documents/项目记忆.md`，改完任一侧跑 `python scripts/sync_memory.py`（`--reverse`/`--check`）。
> 日志 `.workbuddy/memory/YYYY-MM-DD.md` 追加写；`.trae/documents/` 的 PRD/任务表/bug_log/规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）：营地→遭遇→战斗→捕获→结算→营地/图鉴。原纯前端；11-03 起自建 Node+TS 后端，11-04 强制登录。
- **北极星（11-04 拍板）**：**服务端权威 + 实时多人同玩**（战斗/捕获/经济服务端结算，客户端只发意图、收状态、渲染）。本地存档是过渡态，P5 去除；P0-3 自动同步为过渡桥接。
- **反作弊（11-05 拍板）**：测试菜单数据**只放行管理员**；改档/GG/加速器一律拦截 + 封号弹窗 + 登出；**改系统时间不封号，只要求「不生效」**。P1-1b 只识别「明显改档」（任务表 §六 / 规范 §13）。
- 总表 `开发任务优先级_2026-11-04.md`：P0~**P4-2a** 全 ✅；**P4-2 b~e 📋 排期已定、代码未开工，下一步 P4-2b 房间内核**；P5 上线去本地。
- **P4-1 口径（11-07 杰哥拍板）**：同账号多端**不合并本地改动、不静默切档**；后来者登录顶号，前者**直接下线**（旧 token 所有 REST 403，非只断 WS）。共享真值全在服务端，客户端不得改共享世界。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由 `/` 首页、`/camp` 营地、`/arena` 训练场、`/auth` 登录（守卫 `App.tsx`）。
- 内容唯一源 `src/game/data.ts`（40 幻兽 / 22 道具 / 7 城镇 / 18 属性 / `TYPE_CHART` / `IDLE_CONFIG` / `INITIAL_INVENTORY` / `STARTERS` / `START_LOCATION_ID`）；规则 `rules.ts`；挂机 `idle.ts`（仅展示换算）；遭遇 `gen.ts`。
- **服务端战斗（P3-1）**：`content.generated.ts`（`gen:content` 派生）+ `game/rules.ts`（RNG 注入）+ `game/battle.ts`（状态机/结算）；`modules/battle.ts` 四接口 + `lib/battleSession.ts`；`battleView` 下发完整个体。前端 `lib/battleApi.ts`，**无本地降级**。
- **服务端写操作（P3-2）**：`game/mutations.ts` 纯函数 + **`POST /api/game/:op`** → `commitState(source='action')` 回整包 `data`，前端 `lib/gameApi.ts` 应用并抑制一次回传；战斗中 `BATTLE_IN_PROGRESS`。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 单一真源派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start`/`Auth`/`Camp`（5 Tab）/`Arena`；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`。
- 同步 `lib/sync.ts`（`ensureRevision`/`healFromConflict`/`stopAutoSync`）、`syncErrors`（409 判 `conflict`）/`api`（`isSessionSuspended()` 硬闸）/`auth`（`setToken` 复位顶号态）。`App.tsx` 含 `BanGate`/`SessionGate`/三个 Bootstrap；`ws.ts` 转发 `session.state`+`wild.state`，`sessionState.ts` 存 revision/在途/下线态。
- **P4-1 只读层**：`sessionReplaced.ts`（顶号通知闸门）、`wild.ts`（`useWildList()` 只读 Hook，REST 首拉 + WS 快照按区域 revision 幂等 + 30s 兜底轮询）；`Arena.tsx` 展示「附近野怪（多人共享）」，点挑战走带 `wildId` 的开局意图。
- **P4-2a 只读层**：后端 `game/power.ts`（有效六维 / `maxHp` / `effectiveStats` 装备扩展）+ `game/rank.ts`（四榜派生、稳定排序）+ `modules/rank.ts`（**`GET /api/rank` 只读**）；前端 `lib/rank.ts` + `RankBoardModal`，`Camp.tsx` 第二行「榜单」入口；**战力不参与任何判定**。
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
- **校验（首选一条命令）**：`npm run verify` —— **22 阶段**（check/test/build + 内容表 + 十组 E2E + 冒烟 ×4 + 文档与镜像），约 **55s**（**22/22** `VERIFY_OK`），自动清测试账号。子集 `--only=` / `--skip=`，CI 用 `--strict`；报告 `.verify-report.json`（gitignore）。
- **分项数字**：前端 `check` 0 / `test`（**105**）/ `build`；后端 `check` 0 / `test`（**249**）/ `check:content` 一致；E2E 依次 **62** / **30** / **41** / **25** / **48** / **50** / **41** / **30** / **39**（`E2E_P42A_OK`）/ 115；headless 375px **15/15** + **15/15** + **13/13**（`UI_SMOKE_P41_OK`）+ **17/17**（`UI_SMOKE_P42A_OK`）；文档自检 66。E2E 需服务已起；RNG 用例须重复跑（§17）；改 `data.ts` 须 `gen:content` 一起提交。
- **清理**：`cd backend && npm run clean:e2e`（`--dry` 预览、`--prefix=` 追加）。只删测试前缀、**永不删 admin**；verify 自动执行一次。
- **账号管理**：`cd backend && npm run admin -- grant|revoke|ban|unban|list|audit <用户名>`。⚠️ 不授权用测试菜单会被封号。**绝不写死用户名**。
- 本机 `D:\MyJob\MonsterPK`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`（换 JWT_SECRET）→ `prisma migrate deploy` → `generate` → `npm run dev`；改 schema 前停 :3001（§12）。`.env`/`dev.db` gitignore。
- **Git 流程（11-07 杰哥定，每次提交执行，不用再问）**：验收通过 → 建 `rollback-YYYYMMDD-<阶段>` tag 推远端 → `git add -A` 确认无 `.env`/`*.db` → commit（中文分条、末尾写数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一, bcrypt hash, `role`/`bannedAt`/`banReason`, **`sessionVersion` 顶号代次**) + `Save`(userId+slot 唯一, data 文本, `schemaVersion`/`clientId`/`updatedAt`/`authority`, 3 槽) + `BanRecord` + `IntentLog`(nonce 唯一防重放)。迁移链 **5 条**；改 schema 前停 :3001。
- API：`auth/{register,login,me}`、`GET|PUT /api/save?slot=`、`POST /api/actions/:type`、`GET /api/session`、`POST /api/game/:op`、`POST /api/battle/{start,action,abandon}` + `GET /api/battle/current`、**`GET /api/wild?areaId=`**、**`GET /api/rank` + `GET /api/rank/:type`**（P4-2a 只读）、`GET /api/health`、`GET /ws`。守卫查封号 → `403 ACCOUNT_BANNED`；旧代次 → `403 SESSION_REPLACED`；CORS 放行 5173。
- **存档三层（P1-1/P1-1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单防误封）→ `serverClock.ts`（未来时间戳钳制，改时间不生效、不封号）。
- **权威裁决（P1-2）**：意图 nonce → 服务端基线 + 掷骰/时钟/价格 → `authority.pending` → 客户端带 `intentNonce` PUT 核对增量（不符 400 不封号）。`PUT` 三分支：rebase / intentNonce / 普通单调比对。见规范 §14。
- **实时通道（P2-1）**：`upgrade` 五道闸（路径/Origin/JWT/查封号/**JWT `sv` 代次**）、心跳、上行 4KB·20 条每秒；封号 `bye` 复用 `<BanGate/>`。见规范 §15。
- **顶号（P4-1a）**：登录 `sessionVersion` +1 签进 JWT `sv` → `authenticate` + WS upgrade 双校验 → 旧 token REST 全 403 `SESSION_REPLACED`；登录即 `kickUserConnections()`，`takeover()` 同步原子接管（单连接），旧连接 `bye` + close 4001。前端 `SessionGate` 只读下线态、传输层拦截、`stopAutoSync()` 清队列、`replacedToken` 禁重连；**不合并、不上传旧档**（§22 / §27）。
- **共享野怪（P4-1b）**：`WildRegistry` 每区域 3 只（TTL 5min / 抢占 30min / 结算留 10s）；**`claim()` 同步无 `await`** 保证原子，`resolve/release` 三键归属，按区域独立 revision。`GET /api/wild` 主题等级只查内容表、忽略客户端 fallback；`battle/start` 带 `wildId` → `createBattle(..., { wild })`；结算/放弃/sweep 经 `broadcastAll()` 发 `wild.state`（§22）。
- **在线权威态（P2-2）**：`gameSession` 按 `userId+slot` 内存态，`commitState()` **唯一写入口**（DB→内存→广播 `session.state`），revision 单调、断线 10min TTL；上行只 `session.resync`（§16）。云同步 `syncOnLogin` 冲突恢复 + 1.5s 防抖 PUT + 离线队列；客户端不能整包把资源改高（§15）。
- **测试底座**：`harness.mjs` + `saveWriter.mjs`（跟踪 revision）；`e2e_hardening.mjs` 115 项；`numericRules.test.ts` 31 项；`verify.mjs` 编排；`clean-test-data.mjs` 清账号。
- **服务端写操作（P3-2）**：`POST /api/game/:op`（heal/use_item/evolve/learn_move 含 `discard`/队伍整理/travel/new_game）全部 `commitState(source='action')`；`checkPartyStateRegression()` 堵住 `digestOf` 不含 HP 的盲区；价格/挂机/初始背包/御三家/出生地全由内容表派生。见 §20。
- **写入并发控制（P4-0）**：PUT 与意图必须带 `revision`（缺 400 `REVISION_REQUIRED`），过期 409 `REVISION_CONFLICT` 回带快照（server-wins），校验在风控/nonce 前；`slotLock.ts` 按 `userId:slot` 串行读→校→写（**`commitState()` 不取锁**）；前端 409 → `healFromConflict()` 不重试、意图后写回新 revision。见 §21 / §26。
- **只读派生榜（P4-2a）**：`Save` 落库真值 → `validateSaveData()` 滤脏档 → `game/rank.ts` 派生 → `GET /api/rank/:type` 只读下发；**实时派生（TTL=0 Read Model）**，不缓存不落库，排除封号/管理员；伪上报 400 `RANK_INPUT_FORBIDDEN`、**只有 GET**。战力六维和用 `maxHp`，召唤师等级派生不加字段；`SCHEMA_VERSION`/迁移未动。规范 §23 / bug_log §28。
- **能力边界**：**已挡**改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/伪造 rebase/测试菜单越权/WS 伪造状态/伪造战斗动作/越权 battleId/GG 改内存/旧意图刷奖励/CAS 旧版本覆盖/顶号后续写/抢已占野怪/改共享世界/上报榜单数值；**未挡**加速器改动画节奏/改本地展示态。管理员只在服务端判定。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4` / `0xC0000142` 是宿主回收进程，非代码崩溃。**`lib/env.ts` `.env` 路径曾算错**（`JWT_SECRET` 回落硬编码默认值，严重安全缺陷）；11-05 改 `../../.env` 实测生效。**改配置代码必须实测 `process.env.XXX` 有值。**
- §25 P3-2 本地权威残留（任意地点回满、**HP 摘要盲区**、死道具、全灭惩罚可逃）；§26 CAS 六坑（6 个 E2E 集体红 → `saveWriter.mjs`；**锁改直通 E2E 仍全绿，只能靠 `slotLock.test.ts` 单测**；并发载荷须「变穷」）。
- §27 P4-1 七坑：只断 WS 会互踢死循环（→ `sessionVersion`/`sv`）/ 四组 E2E 打红**不加兼容开关** / 判别联合复发（`'code' in result`）/ Prisma 迁移先停 :3001 / 全局 wild revision 设计错 / 客户端 fallback 改共享真值 / `setToken()` 忘复位下线态。
- §28 P4-2a 六坑：探针 waitFor 双调度 / **Tab 竞态（真缺陷，cleanup `cancelled` 修）** / E2E 0 分被 limit 截断 / `unknown[]` reduce 须给泛型 / dump-dom PENDING / 实时派生与排除口径。
- §10~§24 见 bug_log（白屏/Hook/EPERM/Prisma 锁/框架混跑/strict 收窄/个体值/MONEY 码等）。

## 7. 进度与遗留
- **已完成**：P1-2/P1-3（nonce；**内容缺口**：仅 `spark_mouse` 有道具进化）、P2-1/P2-2、P3-1a/1b/1c（**不做离线降级**、**下线 `battle_reward`/`capture`**）、P3-2、P4-0（CAS+槽位锁）、P4-1；缺陷修复（个体值 144 项 / money 码，§21/§22）。
- **P4-1 ✅（11-07）**：顶号 + 共享野怪；旧 token REST 403 `SESSION_REPLACED`，`WildRegistry` claim 原子互斥/按区域 revision。证据：`verify` 20/20、后端 230 / 前端 96、`e2e:p41` 30、`ui_smoke_p41` 13/13；四组 E2E 改顶号语义（**不加兼容开关**）。规范 §22 / bug_log §27。
- **P4-2a ✅（11-07）**：四榜只读派生榜落地（实现口径见 §5 / 规范 §23）。战力 = 六维和用 `maxHp`、**不代表实战强弱**、公式仍待定、装备走 `effectiveStats`；只读接口 + 实时派生 + 排除封号/管理员。证据：`verify` **22/22**、后端 **249** / 前端 **105**、`e2e:p42a` **39**、`ui_smoke_p42a` **17/17**；**`SCHEMA_VERSION`/迁移未动**。bug_log §28。
- **P4-2 b~e 📋 排期（代码未开工）**：口径——掉线等待重连、全员掉线不扣次数、超时另一人可选托管、共斗限时 20s 未放技能服务端随机放；五阶段 `a ✅ → b 房间内核 → c 单人 Boss 排名 → d 1v1 PVP → e 共斗/副本`，唯一缺口 `roomId`。阈值 `ROUND_TIMEOUT_MS=20s`/`AUTOPILOT_OFFER_MS=30s`/`ALL_OFFLINE_GRACE_MS=60s` 服务端可调，quota `hold→commit→release`，**只同一 token 同设备算重连**；`pickUsableMove()` 已可超时随机放，`applySettlement()` 私有待抽取，P5-1 前迁共享存储。契约 `P4-2_多人玩法排期_2026-11-07.md`。**下一步 P4-2b 房间内核**。
- **Git**：`fe159eb`→`2f2c8b7`→…→`277c4b2`(排期)→`f7fa187`(战力口径)→**`25b6168`（P4-2a）**均已推送；回滚点 `rollback-20261107-pre-p41`/`rollback-20261107-post-p41` 与 pre/post `p42-plan`/`p42a` 成对在远端，末尾 docs 提交见 `git log`。`dev.db`/`.env` gitignore。
- **回家交接**：`HANDOFF.md` + `check_home_env.py` / `doc_check.py`；11-07 已在 `D:\MyJob\MonsterPK` 重建并 `ENV_CHECK_OK`。
