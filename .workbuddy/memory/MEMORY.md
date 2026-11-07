# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**。镜像 `.trae/documents/项目记忆.md`，改完任一侧跑 `python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 校验）。
> 每日日志 `.workbuddy/memory/YYYY-MM-DD.md` 追加写、不改旧内容。`.trae/documents/` 的 PRD / 路线图 / 任务表 / bug_log / 后端规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 的原创抓怪回合制 RPG 原型（`com.monster.game`）。循环：营地 → 遭遇 → 回合战斗 → 捕获 → 结算 → 营地管理/图鉴。原纯前端 localStorage；11-03 起自建 Node+TS 后端，11-04 起强制登录。
- **北极星（11-04 拍板）**：最终 = **服务端权威 + 实时多人同玩**（WebSocket；战斗/捕获/经济服务端结算，客户端只发意图、收状态、渲染）。本地存档是过渡态，P3/P5 后去除；P0-3 自动同步是 P3 前的桥接。
- **反作弊分级（11-05 拍板）**：测试菜单级数据（满属性/高等级/满金币）**只放行管理员账号**；他人用外挂/GG 修改器/加速器/自带 test 改数据一律拦截 + 封号弹窗 + 强制登出；**改系统时间获取资源不封号，只要求「不生效」**。P1-1b 只识别「明显改档」，勿夸大；根治在 P1-2（RNG/结算/时钟上移）与 P3（客户端无真值）。分工表见任务表 §六 / 后端规范 §13。
- 总表 `.trae/documents/开发任务优先级_2026-11-04.md`：P0 五项 ✅ / P1-1 ✅ + P1-1b ✅ / P1-2 ✅ / P1-3 ✅ / **P2-1 ✅** / **P2-2 ✅** / **P3-1a ✅ + P3-1b ✅ + P3-1c ✅** / **下一步 P3-2 瘦终端** / P4 多人 / P5 上线去本地。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由 `/` 首页、`/camp` 营地、`/arena` 训练场、`/auth` 登录（守卫 `App.tsx`）。
- 内容唯一源 `src/game/data.ts`（40 幻兽 / 22 道具 / 7 城镇 / 18 属性，**`TYPE_CHART` 已从 rules.ts 迁入此处**）；规则 `rules.ts`（伤害/异常/捕获/升级/进化/PP）；挂机 `idle.ts`（8h 封顶）；遭遇 `gen.ts`。
- **服务端战斗（P3-1a/b/c）**：`backend/src/game/` = 派生内容表（`content.generated.ts`，源 `data.ts`）+ `rules.ts`（RNG 注入）+ `battle.ts`（状态机/结算）；接口 `modules/battle.ts`、注册表 `lib/battleSession.ts`；`battleView` 下发队伍完整个体 + `levelMin/levelMax`，`applyAdminTestFlags` 仅管理员生效。前端 `lib/battleApi.ts` 封装意图并映射状态，服务端不可达才降级本地战斗。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 单一真源派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start`（账号条/管理员标识/三行状态）、`Auth`、`Camp`（5 Tab，测试菜单仅管理员）、`Arena`（P3-1c 起用 `battle.serverParty` 渲染）；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`。
- 同步链路 `lib/sync.ts`（`attemptUpload`/`commitIntent`/`suppressNextUpload`）、`syncPolicy.ts`、`syncErrors.ts`（4xx 除 429 判永久）、`api.ts`、`intents.ts`（在途 guard）、`rebase.ts`、`auth.ts`、`admin.ts`（`useIsAdmin()` 仅 UI，**不是安全边界**）。`App.tsx` 全局：`UnauthorizedListener`/`BanGate`/`SyncBootstrap`/`SessionBootstrap`/`RealtimeBootstrap`。`lib/ws.ts` 只转发 `session.state`，`lib/session.ts` 幂等应用快照，`lib/sessionState.ts` 存 revision 与在途态（零依赖防循环）。
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
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**交接后后台服务不会自动恢复**，先 curl 探活再重启。
- **校验（首选一条命令）**：`npm run verify` —— 15 个阶段（前后端 check/test/build + 内容表一致性 + 六组 E2E + 375px 冒烟 + 文档与镜像自检），约 35s，跑完自动清理测试账号。子集：`--only=check,unit` / `--only=e2e:hardening` / `--skip=e2e,smoke`；CI 用 `--strict`（服务缺失即失败）。报告落 `.verify-report.json`（已 gitignore）。
- **分项数字**：前端 `check` / `test`（**81**）/ `build`（**586 KB**）；后端 `check` / `test`（**160**）/ `check:content` / `e2e`（**62**）/ `e2e:p12`（**30**）/ `e2e:p21`（**34**）/ `e2e:p22`（**24**）/ `e2e:p31`（**48**）/ **`e2e:hardening`（114 项）**；headless 375px **15/15** + P3-1c 战斗链路 **15/15**。E2E 需服务已起；**RNG 用例必须重复跑**（bug_log §17）。改 `data.ts` 必须 `gen:content` 一起提交。
- **测试数据清理**：`cd backend && npm run clean:e2e`（`--dry` 先看，`--prefix=a_,b_` 临时追加前缀）。只删测试前缀、**永不删 admin**；verify 跑完会自动执行一次。
- **账号管理**：`cd backend && npm run admin -- grant <用户名>` / `revoke` / `ban` / `unban` / `list` / `audit`。⚠️ 不授权就用测试菜单会被风控封号。**绝不写死固定用户名**。
- 本机 `D:\MyJob\MonsterPK`（NTFS，11-07 重建环境）；remote `https://github.com/LJJ666666/MonsterPK.git`；node v22.22.2 / npm 10.9.7。dev/preview 的 `/api/save` 无 `save_data.json` 返回 404 属正常。
- 新机重建后端：`cp .env.example .env`（换 JWT_SECRET）→ `npx prisma migrate deploy` → `npx prisma generate` → `npm run dev`。`.env` 与 `dev.db` 已 gitignore。改 Prisma schema 前先停 :3001（Windows DLL 文件锁，bug_log §12）。
- **Git 提交流程（11-07 杰哥定，每次提交都执行，不用再问）**：全量验收通过 → 建回滚点 `git tag -a rollback-YYYYMMDD-<阶段> -m "..." <HEAD>` 并 `git push origin <tag>`（必须到远端）→ `git add -A` 确认无 `.env`/`*.db` → commit（中文分条、末尾写验收数字）→ `git push origin master` → 核对 `HEAD == origin/master` 且工作树干净。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一, bcrypt hash, `role`/`bannedAt`/`banReason`) + `Save`(userId+slot 复合唯一, data 文本, `schemaVersion`, `clientId`, `updatedAt`, **`authority`**, 3 槽) + `BanRecord` + **`IntentLog`**(userId+slot+nonce 唯一索引防重放)。迁移链 4 条，P2-2 未加新迁移。
- API：`POST /api/auth/register|login`、`GET /api/auth/me`、`GET|PUT /api/save?slot=`、**`POST /api/actions/:type`**、`GET /api/session?slot=`、**`POST /api/battle/{start,action,abandon}` + `GET /api/battle/current`**（P3-1b/c）、`GET /api/health`、**`GET /ws`**。守卫实时查封号 → `403 ACCOUNT_BANNED`；CORS 放行 5173。
- **存档三层（P1-1/P1-1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单防误封）→ `serverClock.ts`（未来时间戳钳制，改时间不生效、不封号）。
- **权威裁决（P1-2 路线 A）**：意图带 nonce → 服务端落基线、掷 RNG/用服务端时钟/查价格表 → 登记 `authority.pending` → 客户端应用后 `commitIntent()` PUT 带 `intentNonce` → 服务端精确核对增量（不符 400，**不封号**）。`PUT /api/save` 三分支：rebase / intentNonce / 普通单调比对。模块 `lib/authority.ts`、`lib/settlements.ts`、`modules/actions.ts`；见任务表 §七 / 规范 §14。
- **实时通道（P2-1）**：`upgrade` 五道闸（路径→Origin 白名单→JWT(query)→实时查封号→连接上限 3）；`WsRegistry` 管登记/心跳/死连接清理；`hello/ping/pong/error/bye`，上行 4KB / 20 条每秒限流；前端指数退避重连，封号 `bye` 复用 `<BanGate/>`。见规范 §15。
- **在线权威态（P2-2）**：`lib/gameSession.ts` 按 `userId+slot` 内存态，`commitState()` 是**唯一写入口**（DB upsert → 内存 → 广播 `session.state`）；`PUT /api/save` 与 `/api/actions/:type` 都走它。`revision` 复用 `authority.revision` 单调递增；断线 10min TTL。下行全量快照，上行只 `session.resync`，**伪造上行 → UNKNOWN_TYPE + 1008**。前端按 revision 幂等应用并抑制一次上传。见规范 §16。
- **云同步（P0-3 桥接）**：`syncOnLogin` 冲突恢复 + `SyncBootstrap` 1.5s 防抖整包 PUT + 离线队列；被拒档不入队。**契约**：客户端不能再整包把资源改高（bug_log §15）。
- **服务端战斗（P3-1a/b）**：敌方/队伍/背包全取自服务端，`captureRate` 读内容表并钳 0.02~0.62，`captureChance` 含稀有度与等级差（`playerAvgLevel` 必填）；RNG 注入可复现；结束 `applySettlement` 覆盖存档 → `commitState(source='battle')`（expected=新档摘要、revision+1、pending=null）并广播 `battle.state`（下行）。**无本地降级**：断网/未登录如实报错。公式与前端 `rules.ts` 的对齐由 `tests/battleEngine.test.ts` 强制校验。
- **测试基础设施（11-07 固化）**：`tests/lib/harness.mjs`（HTTP/账号/存档/WS/断言/清理共用底座）；`e2e_hardening.mjs`（**114 项对抗**，八分区含 B2 格式错不封号，逐例断 status+code，自清理）；`numericRules.test.ts`（**31 项数值矩阵**：伤害不变量/克制单调/PP 全量/捕获率钳制/经验曲线/个体值区间）；`scripts/verify.mjs` 统一编排；`clean-test-data.mjs` 清账号。
- **能力边界**：已挡改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/伪造 rebase/普通账号调测试菜单/WS 伪造状态写入/**伪造战斗动作与越权 battleId**/**GG 改内存（战斗判定全在服务端）**/**旧意图刷奖励（`battle_reward`/`capture` 已从 `INTENT_TYPES` 删除）**；**未挡**加速器改客户端动画节奏（不影响结算）/直接改本地展示态（只影响自己看到什么）。管理员只在服务端判定；服务端价格/挂机参数在 `settlements.ts`，改 `data.ts`/`idle.ts` 时两处同步（`data.ts` 还要 `gen:content`）。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 关机后后台任务报 `exit 4` / `-1073741502`(0xC0000142) 是**进程被宿主回收**，非代码崩溃。
- **`lib/env.ts` 的 `.env` 路径曾算错**（`../.env` → 不存在的 `backend/src/.env`），导致 `JWT_SECRET` 长期回落硬编码默认密钥（严重安全缺陷）。11-05 改 `../../.env` 并实测生效。**改配置相关代码必须实测 `process.env.XXX` 有值。**
- §10~§24 见 bug_log：Router 外 useNavigate 白屏、vitest EPERM、Prisma DLL 锁、测试框架混跑、`.env` 路径、E2E 契约冲突、用户名超长、捕获误拦、strict 收窄、upgrade 丢 body、等级死断言、个体值区间、MONEY 码、快照清战斗+条件 Hook、奖励后门/规则丢失/降级毒丸。

## 7. 进度与遗留
- **P1-2/P1-3 ✅（11-06）**：RNG/结算/时钟上移，nonce 防重放；捕获率补稀有度/等级差、`amulet_coin` 翻倍、`exp_share` 全队经验、进化石可用。**内容缺口**：仅 `spark_mouse` 有 `stone_thunder` 道具进化。
- **P2-1 ✅ / P2-2 ✅（11-06~07）**：WS 通道（鉴权/心跳/重连/限流/状态 UI）+ GameSession 在线权威态（内存+DB+`commitState` 唯一写入口+多端广播，不加迁移、不改 SCHEMA_VERSION）。
- **P3-1a/1b ✅（11-07）**：内容表由 `gen-content.ts` 派生（`check:content` 防漂移）；`game/rules.ts`（RNG 注入）+ `game/battle.ts` 状态机；`battleSession` 三键归属 + 30min TTL；四接口经 `commitState(source='battle')` 写档广播。
- **P3-1c ✅ + 收口（11-07）**：五入口按 `battle.serverId` 分流到 `/api/battle/*`（`src/lib/battleApi.ts`），客户端零数值计算；战斗内我方真值放 `battle.serverParty` **不写 save**。收口：**不做离线降级**（本地战果必被 400 拒且富档留库 → 同步死循环）、**下线 `battle_reward`/`capture`**（采信客户端上报 = 零成本刷奖励）、**补回捕获率稀有度/等级差**（曾静默回退）。详见规范 §19、bug_log §23/§24。证据：前端 81 / 后端 160 / build 586 KB / hardening 114 / 冒烟 15+15。**下一步 P3-2**。
- **11-07 测试体系固化 ✅**：对抗脚本转正为 `e2e:hardening`（**114 项**，八分区，自清理）；`numericRules.test.ts` **31 项**；`npm run verify`（**16 阶段约 53s**，自动清账号 + 报告）；清理历史测试账号 268 个。详见规范 §18。
- **11-07 两项缺陷已修 ✅**：①**个体值**——`initMin` 硬编码 base+2.0~3.2 与内容表 `initStatsMax` 相减，144 项区间反向、带宽均值仅 1.6，`remapByBounds` 恒命中 `oldMax<=oldMin` **使进化清零个体差异**；改为 `initMin=种族值`、`initMax=max(initStatsMax, base+4)`。②**money**——`MONEY` 混装格式错与越界且在白名单，负/小数/null 直接封号；拆 `<FIELD>_FORMAT`(400)/`_RANGE`(封号)。详见 bug_log §21/§22。
- **Git**：`fe159eb`（P0~P1-3）→`bb04998`（P2-1）→`2f2c8b7`（P2-2）→`bbb1853`（P3-1a/1b）→`4acbd53`（缺陷修复）→ 本轮 P3-1c，均已推送。回滚点 tag 用 `git tag -l 'rollback-*'` 查（pre/post 成对，均在远端）。`dev.db`/`.env` 已 gitignore。
- **回家交接**：`HANDOFF.md`（已入库）含 clone / 环境重建 / 记忆恢复 / 话术 / 验收 / 坑；配套 `check_home_env.py`、`doc_check.py`。11-07 已按手册重建环境并 `ENV_CHECK_OK`。
