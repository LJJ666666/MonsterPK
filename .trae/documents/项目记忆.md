# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**。镜像 `.trae/documents/项目记忆.md`，改完任一侧跑 `python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 校验）。
> 每日日志 `.workbuddy/memory/YYYY-MM-DD.md` 追加写、不改旧内容。`.trae/documents/` 的 PRD / 路线图 / 任务表 / bug_log / 后端规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 的原创抓怪回合制 RPG 原型（`com.monster.game`）。循环：营地 → 遭遇 → 回合战斗 → 捕获 → 结算 → 营地管理/图鉴。原纯前端 localStorage；11-03 起自建 Node+TS 后端，11-04 起强制登录。
- **北极星（11-04 拍板）**：最终 = **服务端权威 + 实时多人同玩**（WebSocket；战斗/捕获/经济服务端结算，客户端只发意图、收状态、渲染）。本地存档是过渡态，P3/P5 后去除；P0-3 自动同步是 P3 前的桥接。
- **反作弊分级（11-05 拍板）**：测试菜单级数据（满属性/高等级/满金币）**只放行管理员账号**；他人用外挂/GG 修改器/加速器/自带 test 改数据一律拦截 + 封号弹窗 + 强制登出；**改系统时间获取资源不封号，只要求「不生效」**。P1-1b 只识别「明显改档」，勿夸大；根治在 P1-2（RNG/结算/时钟上移）与 P3（客户端无真值）。分工表见任务表 §六 / 后端规范 §13。
- 总表 `.trae/documents/开发任务优先级_2026-11-04.md`：P0 五项 ✅ / P1-1 ✅ + P1-1b ✅ / P1-2 ✅ / P1-3 ✅ / **P2-1 ✅** / **P2-2 ✅** / **下一步 P3-1 服务端模拟** / P4 多人 / P5 上线去本地。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由 `/` 首页、`/camp` 营地、`/arena` 训练场、`/auth` 登录（守卫 `App.tsx`）。
- 内容唯一源 `src/game/data.ts`（40 幻兽 / 22 道具 / 7 城镇 / 18 属性）；规则 `rules.ts`（伤害/异常/捕获/升级/进化/PP）；挂机 `idle.ts`（8h 封顶）；遭遇 `gen.ts`。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 单一真源派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start.tsx`（账号条 + 管理员标识 + 同步/通道/权威态三行状态）、`Auth.tsx`、`Camp.tsx`（5 Tab，测试菜单仅管理员可见）、`Arena.tsx`；弹窗 `MechanicsModal` / `MoveChartModal` / `MoveLearnerModal` / `EvolutionModal` / `TypeChartModal`。
- 同步链路 `lib/sync.ts`（`attemptUpload`/`commitIntent`/`suppressNextUpload`）、`syncPolicy.ts`、`syncErrors.ts`（4xx 除 429 判永久失败）、`api.ts`、`intents.ts`（意图在途 guard）、`rebase.ts`、`auth.ts`、`admin.ts`（`useIsAdmin()` 仅 UI 收敛，**不是安全边界**）。`App.tsx` 全局组件：`<UnauthorizedListener/>`、`<BanGate/>`、`<SyncBootstrap/>`、`<SessionBootstrap/>`、`<RealtimeBootstrap/>`。`lib/ws.ts` 只转发 `session.state`；`lib/session.ts` 幂等应用快照，`lib/sessionState.ts` 存 revision 与意图在途态（零依赖，避免循环导入）。
- **测试边界**：前端 vitest 只收 `src/**/*.test.{ts,tsx}`；后端 `node:test` 独立在 `backend/tests/`。两套框架不能混跑（bug_log §13）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION`（= persist `version`）并补 migrate 分支**，老存档必须能玩；后端 `EXPECTED_SAVE_VERSION`(=10) 必须同步改，否则新档全被拒。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部 → `Unexpected keyword 'export'`。改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一 `rules.ts` 的 `uuid()`。所有 Hook 必须在组件顶层。
- 移动端优先：弹窗小 `max-w` + `overflow-auto` + `max-h`；禁止大表格横向滚动；375px 实测 `scrollWidth`。
- `strict:false` / `noUnusedLocals:false` —— tsc 很宽松，别指望它兜逻辑。
- **服务端权威原则**：客户端上报的存档/战报/数值/意图，服务端必须校验；状态写入唯一入口是 `commitState()`；**WS 上行绝不写状态**。
- 前端设计先读 `.impeccable.md`（复古像素 / 野外手记；内联 SVG、零 CDN）。Capacitor 打包见 `apk_build_guide.md`。

## 4. 运行命令与环境
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**关机/会话交接后后台服务不会自动恢复**，新会话先 curl 探活（5173 / 3001）再重启。
- 校验：前端 `check` / `build`（606.75 KB / gzip 142.93 KB）/ `test`（**47**）；后端 `check` / `test`（**107**）/ `e2e`（**57**）/ `e2e:p12`（**38**）/ `e2e:p21`（**34**）/ `e2e:p22`（**24** `E2E_P22_OK`）；headless 375px **15/15**（`scripts/ui_smoke_p21.mjs`，含「实时通道已连接」「在线权威态 rev=N」）。E2E 需服务已起；**涉及服务端 RNG 的用例必须重复跑**（bug_log §17）。
- **账号管理**：`cd backend && npm run admin -- grant <用户名>` / `revoke` / `ban` / `unban` / `list` / `audit`。⚠️ 不授权就用测试菜单会被风控封号。**绝不写死固定用户名**。
- 本机 `D:\MyJob\MonsterPK`（NTFS，11-07 重建环境）；remote `https://github.com/LJJ666666/MonsterPK.git`；node v22.22.2 / npm 10.9.7。dev/preview 的 `/api/save` 无 `save_data.json` 返回 404 属正常。
- 新机重建后端：`cp .env.example .env`（换 JWT_SECRET）→ `npx prisma migrate deploy` → `npx prisma generate` → `npm run dev`。`.env` 与 `dev.db` 已 gitignore。改 Prisma schema 前先停 :3001（Windows DLL 文件锁，bug_log §12）。
- **Git 提交流程（11-07 杰哥定，每次提交都执行，不用再问）**：全量验收通过 → **先建回滚点**：`git tag -a rollback-YYYYMMDD-<阶段> -m "..." <当前HEAD>` 且 `git push origin <tag>`（回滚点必须到远端）→ `git add -A` 并确认无 `.env` / `*.db` 入库 → commit（中文、按模块分条、末尾写验收数字）→ `git push origin master` → 收尾核对 `HEAD == origin/master` 且工作树干净。已建回滚点：`rollback-20261107-pre-p22`（→ `834a55a`）。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一, bcrypt hash, `role`/`bannedAt`/`banReason`) + `Save`(userId+slot 复合唯一, data 文本, `schemaVersion`, `clientId`, `updatedAt`, **`authority`**, 3 槽) + `BanRecord` + **`IntentLog`**(userId+slot+nonce 唯一索引防重放)。迁移链 4 条，P2-2 未加新迁移。
- API：`POST /api/auth/register|login`、`GET /api/auth/me`、`GET|PUT /api/save?slot=1|2|3`、**`POST /api/actions/:type`**、`GET /api/session?slot=`（在线权威态）、`GET /api/health`（`ws` + `sessions` 统计）、**`GET /ws`**。守卫实时查封号 → `403 ACCOUNT_BANNED`；CORS 放行 5173。
- **存档三层（P1-1/P1-1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单防误封）→ `serverClock.ts`（未来时间戳钳制，改时间不生效、不封号）。
- **权威裁决（P1-2 路线 A）**：意图带 nonce → 服务端落可信基线、掷 RNG/用服务端时钟/查价格表 → 登记 `authority.pending` → 客户端应用结果后 `commitIntent()` 立即 PUT 带 `intentNonce` → 服务端精确核对增量（不符 400，**不封号**）。`PUT /api/save` 三分支：rebase / intentNonce / 普通单调比对。模块 `lib/authority.ts`、`lib/settlements.ts`、`modules/actions.ts`；见任务表 §七 / 后端规范 §14。
- **实时通道（P2-1）**：`ws` 挂 `upgrade`；五道闸 = 路径 `/ws` → Origin 白名单 → JWT(query) → 实时查库拒封号 → 单账号连接上限 3；`WsRegistry` 按用户登记 + 心跳 + 死连接清理 + 封号复查；`hello/ping/pong/error/bye`，上行 4KB / 20 条每秒限流；前端指数退避重连、封号 `bye` 复用 `<BanGate/>`。见后端规范 §15。
- **在线权威态（P2-2）**：`lib/gameSession.ts` 按 `userId+slot` 维护内存态（data + authority + revision + 连接登记），`modules/sessionBus.ts` 放共享单例消除循环依赖，`modules/session.ts` 的 **`commitState()` 是唯一写入口**（DB upsert → 内存更新 → 广播 `session.state`）。`PUT /api/save` 与 `POST /api/actions/:type` 都改调它；`GET /api/save` 在线时直接读内存。`revision` 复用 `authority.revision`，每次写入单调递增；连接建立时从 DB hydrate 并推快照，断线按 10min TTL 保留，封号清理。协议：下行 `session.state`（全量快照，不受上行 4KB 限制）、上行 `session.resync`（只请求重推），**伪造 `session.state` 上行 → UNKNOWN_TYPE + 关闭 1008**。前端按 revision 幂等应用并抑制一次自动上传，意图在途期间暂存快照。见后端规范 §16。
- **云同步（P0-3 桥接）**：`syncOnLogin` 冲突恢复 + `SyncBootstrap` 1.5s 防抖整包 PUT + 离线队列；被拒档不入队。**契约**：客户端不能再整包把资源改高（bug_log §15）。
- **能力边界**：已挡改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/伪造 rebase/普通账号调测试菜单/WS 伪造状态写入；**未挡** GG 改内存、加速器、战斗中间态 HP/PP、`captureRate` ID 真值 —— 根治在 P3（客户端瘦终端）。管理员只在服务端判定；服务端价格/挂机参数在 `settlements.ts`，改 `data.ts`/`idle.ts` 时两处同步。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- `tsconfig.json` 的 `ignoreDeprecations:"6.0"` 是 TS 5.8 非法值（TS5103），已删；`rules.ts::createInstance` 残留 `console.log`、空壳 `Home.tsx` 已删。
- 关机后后台任务报 `exit 4` / `-1073741502`(0xC0000142) 是**进程被宿主回收**，非代码崩溃。
- **`lib/env.ts` 的 `.env` 路径曾算错**（`../.env` → 不存在的 `backend/src/.env`），导致 `JWT_SECRET` 长期回落硬编码默认密钥（严重安全缺陷）。11-05 改 `../../.env` 并实测生效。**改配置相关代码必须实测 `process.env.XXX` 有值。**
- §10 useNavigate 在 Router 外白屏 / §11 vitest EPERM / §12 Prisma DLL 锁 / §13 两套测试框架混跑 / §14 `.env` 路径 / §15 旧 E2E 契约冲突 / §16 E2E 用户名超长 401 / §17 捕获新增幻兽误拦 / §18 `strict:false` 判别联合收窄失效 / §19 upgrade 拒绝响应丢 body。

## 7. 进度与遗留
- **P1-2 ✅ / P1-3 ✅（11-06）**：RNG/结算/时钟上移，nonce 防重放；捕获率补稀有度/等级差、`amulet_coin` 翻倍、`exp_share` 全队经验、进化石可用。证据：后端 76/76、E2E 57/57 + 38/38、前端 27/27、headless 10/10。**内容缺口**：仅 `spark_mouse` 配了 `stone_thunder` 道具进化。
- **P2-1 ✅（11-06）**：WebSocket 通道（鉴权/心跳/重连/限流/状态 UI），证据：后端 92/92、`e2e:p21` 34/34、前端 37/37、headless 13/13。
- **P2-2 ✅（11-07，杰哥排期开工）**：服务端 GameSession 在线权威态，内存态 + DB 持久化 + 状态变更服务端写入 + 多端广播；不加 Prisma 迁移、不改 SCHEMA_VERSION。证据：后端 `check` 0 / `node:test` **107/107**、新增 `e2e:p22` **24/24 `E2E_P22_OK`**、原 57/57 + 38/38×2 + 34/34 无回归；前端 `check` 0 / `test` **47/47** / `build` 606.75 KB、headless **15/15**（含权威快照 rev）。**下一步 P3-1**：战斗/捕获/挂机逻辑与中间态上移服务端，客户端只发意图收状态；P3-2 才能去本地真值。P1-4 榜单/成就优先级低。
- **Git（11-06 / 11-07）**：`fe159eb`（P0~P1-3）、`bb04998`（P2-1）、`834a55a`（HANDOFF）已推送；**`2f2c8b7`（P2-2，27 文件 +1595/−260）已 `git push origin master`（`834a55a..2f2c8b7`）**，推送后 HEAD 与 `origin/master` 一致、工作树干净。回滚点 tag `rollback-20261107-pre-p22` → `834a55a` 已同步远端。`dev.db`/`.env` 已 gitignore，仅 `.env.example` 入库。
- **回家交接（11-06）**：`HANDOFF.md`（项目根，已入库）含 clone / 环境重建 / 三层记忆恢复 / 首段话术 / 验收 / 坑；配套 `scripts/check_home_env.py`、`scripts/doc_check.py`。**11-07 已在 `D:\MyJob\MonsterPK` 按手册重建环境**：装依赖、随机 JWT_SECRET、4 条迁移、起双服务、建 `admin/adminJJ` 本地管理员、补用户级记忆、全量验收 `ENV_CHECK_OK`（日志未提交时为 WARN）。
