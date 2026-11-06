# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**。镜像 `.trae/documents/项目记忆.md`，改完任一侧跑 `python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 校验）。
> 每日日志 `.workbuddy/memory/YYYY-MM-DD.md` 追加写、不改旧内容。`.trae/documents/` 的 PRD / 路线图 / 任务表 / bug_log / 后端规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 的原创抓怪回合制 RPG 原型（`com.monster.game`）。循环：营地 → 遭遇 → 回合战斗 → 捕获 → 结算 → 营地管理/图鉴。原纯前端 localStorage；11-03 起自建 Node+TS 后端，11-04 起强制登录。
- **北极星（11-04 拍板）**：最终 = **服务端权威 + 实时多人同玩**（WebSocket；战斗/捕获/经济服务端结算，客户端只发意图、收状态、渲染）。本地存档是过渡态，P3/P5 后去除；P0-3 自动同步是 P3 前的桥接。
- **反作弊分级（11-05 拍板）**：测试菜单级数据（满属性/高等级/满金币）**只放行管理员账号**；他人用外挂/GG 修改器/加速器/自带 test 改数据一律拦截 + 封号弹窗 + 强制登出；**改系统时间获取资源不封号，只要求「不生效」**。P1-1b 只识别「明显改档」，勿夸大；根治在 P1-2（RNG/结算/时钟上移）与 P3（客户端无真值）。分工表见任务表 §六 / 后端规范 §13。
- 总表 `.trae/documents/开发任务优先级_2026-11-04.md`：P0 五项 ✅ / P1-1 ✅ + P1-1b ✅ / P1-2 ✅ / P1-3 ✅ / **P2-1 ✅** / **下一步 P2-2 GameSession** / P3 服务端模拟 / P4 多人 / P5 上线去本地。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由 `/` 首页、`/camp` 营地、`/arena` 训练场、`/auth` 登录（守卫 `App.tsx`）。
- 内容唯一源 `src/game/data.ts`（40 幻兽 / 22 道具 / 7 城镇 / 18 属性）；规则 `rules.ts`（伤害/异常/捕获/升级/进化/PP）；挂机 `idle.ts`（8h 封顶）；遭遇 `gen.ts`。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 单一真源派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start.tsx`（账号条 + 管理员标识 + 同步状态行）、`Auth.tsx`、`Camp.tsx`（5 Tab，测试菜单仅管理员可见）、`Arena.tsx`；弹窗 `MechanicsModal` / `MoveChartModal` / `MoveLearnerModal` / `EvolutionModal` / `TypeChartModal`。
- 同步链路 `lib/sync.ts`（`attemptUpload`/`commitIntent`/`getSyncDiagnostics`）、`syncPolicy.ts`、`syncErrors.ts`（4xx 除 429 判永久失败）、`api.ts`（401→`mpk:unauthorized`、403 封号→`mpk:banned`）、`intents.ts`、`rebase.ts`、`auth.ts`、`admin.ts`（`useIsAdmin()` 仅 UI 收敛，**不是安全边界**）。`App.tsx` 全局组件：`<UnauthorizedListener/>`、`<BanGate/>`、`<SyncBootstrap/>`、`<RealtimeBootstrap/>`（P2-1，按路由变化幂等重连）。`lib/ws.ts` 是实时通道客户端（指数退避重连 / 心跳 / 状态订阅），**不承载游戏状态**。
- **测试边界**：前端 vitest 只收 `src/**/*.test.{ts,tsx}`（`vite.config.ts` 的 `test.include`）；后端 `node:test` 独立在 `backend/tests/`。两套框架不能混跑（bug_log §13）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION`（= persist `version`）并补 migrate 分支**，老存档必须能玩；后端 `EXPECTED_SAVE_VERSION`(=10) 必须同步改，否则新档全被拒。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部 → `Unexpected keyword 'export'`。改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一 `rules.ts` 的 `uuid()`。所有 Hook 必须在组件顶层。
- 移动端优先：弹窗小 `max-w` + `overflow-auto` + `max-h`；禁止大表格横向滚动；375px 实测 `scrollWidth`。
- `strict:false` / `noUnusedLocals:false` —— tsc 很宽松，别指望它兜逻辑。
- **服务端权威原则**：客户端上报的存档/战报/数值/意图，服务端必须校验；关键 RNG、结算、时钟逐步上移服务端。
- 前端设计先读 `.impeccable.md`（复古像素 / 野外手记；内联 SVG、零 CDN）。Capacitor 打包见 `apk_build_guide.md`。

## 4. 运行命令与环境
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**关机/会话交接后后台服务不会自动恢复**，新会话先 curl 探活（5173 / 3001）再重启。
- 校验：前端 `check` / `build`（602.63 KB / gzip 142.17 KB）/ `test`（**37**）；后端 `check` / `test`（**92**）/ `e2e`（**57** `E2E_OK`）/ `e2e:p12`（**38** `E2E_P12_OK`）/ `e2e:p21`（**34** `E2E_P21_OK`）；headless 375px **13/13**（`scripts/ui_smoke_p21.mjs`，含「实时通道已连接」）。E2E 需服务已起；**涉及服务端 RNG 的用例必须重复跑**，单次全绿不代表覆盖成功/失败两条分支（bug_log §17）。
- **账号管理**：`cd backend && npm run admin -- grant <用户名>` / `revoke` / `ban` / `unban` / `list` / `audit`。⚠️ 不授权就用测试菜单会被风控封号。**绝不写死固定用户名**。
- 本机 `E:\Six\MonsterPK`（NTFS）；remote `https://github.com/LJJ666666/MonsterPK.git`；node v22.22.2 / npm 10.9.7。dev/preview 的 `/api/save` 无 `save_data.json` 返回 404 属正常。
- 新机重建后端：`cp .env.example .env`（换 JWT_SECRET）→ `npx prisma migrate deploy` → `npx prisma generate` → `npm run dev`。`.env` 与 `dev.db` 已 gitignore。改 Prisma schema 前先停 :3001（Windows DLL 文件锁，bug_log §12）。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一, bcrypt hash, `role`/`bannedAt`/`banReason`) + `Save`(userId+slot 复合唯一, data 文本, `schemaVersion`, `clientId`, `updatedAt`, **`authority`**, 3 槽) + `BanRecord` + **`IntentLog`**(userId+slot+nonce 唯一索引防重放)。迁移链 `..._init` → `..._add_save_meta` → `20261105101951_add_account_moderation` → `20261106073502_add_authority_and_intent_log`。
- API：`POST /api/auth/register|login`（JWT，已封号 403）、`GET /api/auth/me`（`isAdmin`/`banned`）、`GET|PUT /api/save?slot=1|2|3`、**`POST /api/actions/:type`**、`GET /api/health`（带 `ws` 在线数）、**`GET /ws`**（WebSocket）。守卫实时查封号 → `403 ACCOUNT_BANNED`；CORS 放行 5173。
- **存档三层（P1-1/P1-1b）**：`saveValidator.ts`（hard/soft/stats，结构+数值契约，刻意不硬编码内容白名单，ID 真值留 P3）→ `antiCheat.ts`（`decideSaveAction` → allow/reject/ban，`CHEAT_CODES` 白名单防误封：格式/旧档/版本错配只 400 不封号，管理员放行改档但坏结构仍拒）→ `serverClock.ts`（未来时间戳钳制为服务端时间，改时间不生效、不封号）。日志 `save_rejected`/`save_banned`/`admin_override`/`save_clock_clamped`。
- **权威裁决（P1-2 路线 A）**：意图带 nonce → 服务端落可信基线、掷 RNG/用服务端时钟/查价格表 → 登记 `authority.pending` → 客户端应用结果后 `commitIntent()` 立即 PUT 带 `intentNonce` → 服务端精确核对增量（不符 400，**不封号**）。`PUT /api/save` 三分支：rebase / intentNonce / 普通单调比对（资源不得更富）。意图类型 `idle_start|claim|cancel`、`capture`、`battle_reward`、`shop_buy`、`admin_test`。模块 `lib/authority.ts`、`lib/settlements.ts`、`modules/actions.ts`。**完整机制见任务表 §七 / 后端规范 §14**。
- **实时通道（P2-1）**：`ws` 挂 `upgrade`；握手五道闸 = 路径 `/ws` → Origin 白名单（防 CSWSH）→ JWT(query) → 实时查库拒封号 → 单账号连接上限 3；`WsRegistry` 按用户登记，底层 ping 心跳 + 死连接清理 + 会话期封号复查；控制协议 `hello/ping/pong/error/bye`，4KB / 20 条每秒限流；前端指数退避重连、token 失效不重连、封号 `bye` 复用 `<BanGate/>`。模块 `modules/realtime.ts`、`lib/wsProtocol.ts`、`lib/wsRegistry.ts`、`src/lib/ws.ts`；规范见后端规范 §15。**只建通道，游戏状态仍走整包存档 + 意图裁决**，在线权威态待 P2-2。
- **云同步（P0-3 桥接）**：`syncOnLogin` 冲突恢复 + `SyncBootstrap` 1.5s 防抖整包 PUT + 离线队列；被拒档不入队。**契约**：客户端不能再整包把资源改高；旧 E2E 已改独立账号基线（bug_log §15）。
- **能力边界**：已挡改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/伪造 rebase/普通账号调测试菜单；**未挡** GG 改内存、加速器、战斗中间态 HP/PP、`captureRate` ID 真值（只钳 0.62 上界）——根治在 P3。管理员只在服务端判定（`User.role='admin'` 或 `.env` 的 `ADMIN_USERNAMES`）；封号事务写 `BanRecord` + `User.bannedAt`。服务端价格/挂机参数在 `settlements.ts`，改 `data.ts`/`idle.ts` 时两处同步。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- `tsconfig.json` 的 `ignoreDeprecations:"6.0"` 是 TS 5.8 非法值（TS5103），已删；`rules.ts::createInstance` 残留 `console.log`、空壳 `Home.tsx` 已删。
- 关机后后台任务报 `exit 4` / `-1073741502`(0xC0000142) 是**进程被宿主回收**，非代码崩溃，重开会话重启即可。
- **`lib/env.ts` 的 `.env` 路径曾算错**（`../.env` → 不存在的 `backend/src/.env`），导致 `JWT_SECRET` 长期回落硬编码默认密钥、`ADMIN_USERNAMES` 读不到（严重安全缺陷）。11-05 改 `../../.env` 并实测生效；旧 token 因签名变化失效。**改配置相关代码必须实测 `process.env.XXX` 有值。**
- §10 useNavigate 在 Router 外白屏 / §11 vitest EPERM / §12 Prisma DLL 锁 / §13 两套测试框架混跑 / §14 `.env` 路径 / §15 旧 E2E 契约冲突 / §16 E2E 用户名超长 401 / §17 捕获新增幻兽误拦 / §18 `strict:false` 判别联合收窄失效 / §19 upgrade 拒绝响应 `write`+`destroy` 丢 body。

## 7. 进度与遗留
- **P1-2 ✅ / P1-3 ✅（11-06，路线 A、a~d 全做；P1-3 拆开嵌入对应步骤，不真并行）**：RNG/结算/时钟上移，nonce 防重放，改系统时间不生效且不封号；捕获率补稀有度/等级差、`amulet_coin` 翻倍、`exp_share` 全队经验、进化石可用。证据：后端 76/76、E2E 57/57 + 38/38、前端 27/27 + build、headless 10/10。**内容缺口**：只有 `spark_mouse` 配了 `stone_thunder` 道具进化，其余三种进化石暂无目标。
- **P2-1 ✅（11-06）**：WebSocket 通道打通（鉴权 / 心跳 / 重连 / 限流 / 状态 UI），证据：后端 92/92、`e2e:p21` 34/34、前端 37/37 + build、headless 13/13。**下一步 P2-2 服务端 GameSession 实时态**：通道已有但无在线权威态，游戏数据仍靠整包存档 + 意图裁决；P2-2 收敛后 P3 才能把战斗模拟整体搬上服务端。
- **Git（11-06）**：杰哥要求先建回滚点再做 P2-1、完成后再提交，随后拍板「先推送」→ 两个本地 commit `fe159eb`（P0~P1-3，65 文件）、`bb04998`（P2-1，20 文件）已 `git push origin master`（`703fe1b..bb04998`）。推送时两端 HEAD 同为 `bb04998`、ahead/behind 0/0、工作树干净；本条回填另以文档 commit 入库。`dev.db`/`.env` 已 gitignore，仅 `.env.example` 占位模板入库（无真实密钥）。换机器 clone 后补 `.env` + Prisma 迁移即可续开发，文档/记忆随 commit 入库。
