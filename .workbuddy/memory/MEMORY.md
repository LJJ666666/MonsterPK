# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**，镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`，`--reverse`/`--check`）。日志 `YYYY-MM-DD.md` 追加写；`.trae/documents/` 的 PRD/任务表/bug_log/规范是**产品文档**，不被本文件覆盖。

## 1. 项目与方向
浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）：营地→遭遇→战斗→捕获→结算→营地/图鉴。原纯前端；11-03 起自建 Node+TS 后端，11-04 强制登录。
- **北极星（11-04 拍板）**：**服务端权威 + 实时多人同玩**（服务端结算，客户端只发意图、收状态、渲染）。本地存档过渡态，P5 去除；P0-3 自动同步为桥接。
- **反作弊（11-05 拍板）**：测试菜单数据**只放行管理员**；改档/GG/加速器拦截 + 封号 + 登出；**改系统时间不封号，只要求「不生效」**（§13）。
- 总表 `开发任务优先级_2026-11-04.md`：P0~**P4-2c** 全 ✅；**P4-2 d~e 📋 排期已定，下一步 P4-2d 1v1 PVP**。
- **P4-1 口径（11-07 杰哥拍板）**：同账号多端**不合并本地改动、不静默切档**；后来者顶号，前者**直接下线**（旧 token 所有 REST 403，非只断 WS）。共享真值全在服务端。
- **未来规划台账（11-07「最终是要设计偿还的」）**：`未来规划与技术债_2026-11-07.md` **F01~F14**，状态 `📋/🔨/✅`；**F12 已偿还**。F01/F02「会有，未来再设计」；F03 管理员污染「**先不用纠结**」；**F04**：召唤师等级 = **人物/账号等级 + 宠物等级帽**（`L` 级→宠物上限 `L`，未来或 `L+5`），**P4-2a 派生公式是占位偏差**，偿还需 `playerLevel` + 迁移联动 + 等级写入口加帽 + 榜单读真值，**偿还前不得声称已实现**。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7；路由 `/`、`/camp`、`/arena`、`/auth`。
- 内容唯一源 `src/game/data.ts`（40 幻兽/22 道具/7 城镇/`TYPE_CHART`/`IDLE_CONFIG`/初始背包/御三家）；规则 `rules.ts`、遭遇 `gen.ts`、挂机 `idle.ts`。
- 全局状态 `src/stores/useGameStore.ts`（最核心）：3 槽；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start`/`Auth`/`Camp`(5 Tab)/`Arena`；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`/`RankBoard`/`BossBoard`。
- 同步 `lib/sync.ts`（`ensureRevision`/`healFromConflict`/`stopAutoSync`）、`syncErrors`（409 判 `conflict`）/`api`（`isSessionSuspended()` 硬闸）/`auth`（`setToken` 复位顶号态）。`App.tsx` 含 `BanGate`/`SessionGate`/三个 Bootstrap；`ws.ts` 转发 `session.state`+`wild.state`+`room.state`。
- 只读层：`sessionReplaced.ts`（顶号闸门）、`wild.ts`（区域 revision 幂等 + 30s 兜底）、`lib/rank.ts`、`lib/room.ts`（`(roomId,revision)` 幂等）、`lib/boss.ts`（Boss/榜首防御性解析）。
- **P4-2 新模块**：房间 `roomTypes`/`roomRegistry`/`roomAuth`/`slotLock::withRoomLock`/`modules/room`；Boss `game/boss`/`game/bossRank`/`lib/bossQuota`/`modules/boss`/`game/settlement`（F12）/`modules/saveRead`。
- **测试边界**：前端 vitest 只收 `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`。两套框架不能混跑（§13）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION`（= persist `version`）并补 migrate 分支**，老存档必须能玩；后端 `EXPECTED_SAVE_VERSION`(=10) 同步改，否则新档全被拒。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部 → `Unexpected keyword 'export'`。改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一 `rules.ts` 的 `uuid()`；**后端**可用 `node:crypto`。所有 Hook 必须在组件顶层。
- `strict:false` / `noUnusedLocals:false` —— tsc 宽松，别指望兜逻辑；判别联合不收窄，用 `'code' in result`（§18）。
- 移动端优先：弹窗小 `max-w` + `overflow-auto` + `max-h`；禁止大表格横向滚动；375px 实测 `scrollWidth`。
- **服务端权威原则**：客户端上报的存档/战报/数值/意图，服务端必须校验；写个人档唯一入口是 `commitState()`；**WS 上行绝不写状态**（房间意图由服务端裁决后写房间态）。
- **别用「复用普通分支」的心态接新玩法**：Boss 产出规则与普通战斗不同，分支要显式穷举（`if/else` 不用并列 `if`），否则静默发奖励（§30.1）。
- 前端设计先读 `.impeccable.md`（复古像素/野外手记；内联 SVG、零 CDN）。打包见 `apk_build_guide.md`。

## 4. 运行命令与环境
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**交接后不自动恢复**，先 curl 探活。
- **校验（首选一条命令）**：`npm run verify` —— **25 阶段**（check/test/build + 内容表 + 十二组 E2E + 冒烟 ×5 + 文档与镜像），约 **85~110s**（**25/25** `VERIFY_OK`），自动清测试账号；子集 `--only=`/`--skip=`。
- **分项数字**：前端 `check` 0 / `test`（**122**）/ `build`；后端 `check` 0 / `test`（**306**）/ `check:content` 一致；E2E 依次 **62** / **30** / **41** / **25** / **48** / **50** / **41** / **30** / **39**（`E2E_P42A_OK`）/ **43**（`E2E_P42B_OK`）/ **44**（`E2E_P42C_OK`）/ 115；headless 375px **15/15** + **15/15** + **13/13** + **17/17**（`UI_SMOKE_P42A_OK`）+ **19/19**（`UI_SMOKE_P42C_OK`）。E2E 需服务已起；RNG 用例须重复跑（§17）；改 `data.ts` 须 `gen:content` 一起提交。
- **清理/账号**：`cd backend && npm run clean:e2e`（`--dry` 预览；只删测试前缀、**永不删 admin**）；`npm run admin -- grant|revoke|ban|unban|list|audit <名>`。⚠️ 不授权用测试菜单会被封号，**绝不写死用户名**。
- 本机 `D:\MyJob\MonsterPK`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`（换 JWT_SECRET）→ `prisma migrate deploy` → `generate` → `npm run dev`；改 schema 前停 :3001（§12）。`.env`/`dev.db` gitignore。
- **Git 流程（11-07 杰哥定，每次提交执行，不用再问）**：验收通过 → 建 `rollback-YYYYMMDD-<阶段>` tag 推远端 → `git add -A` 确认无 `.env`/`*.db` → commit（中文分条、末尾写数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型：`User`(username 唯一 / bcrypt / `role`/`bannedAt`/`banReason` / **`sessionVersion` 顶号代次**) + `Save`(userId+slot 唯一 / data / `schemaVersion`/`clientId`/`authority` / 3 槽) + `BanRecord` + `IntentLog`(nonce 唯一) + **`BossDamageEvent`**(`battleId @unique`)。迁移链 **6 条**；改 schema 前停 :3001。
- API：`auth/{register,login,me}`、`GET|PUT /api/save?slot=`、`POST /api/actions/:type`、`GET /api/session`、`POST /api/game/:op`、`/api/battle/{start,action,abandon}` + `current`、`GET /api/wild`、`GET /api/rank[/:type]`、`/api/room[...]`、**`GET /api/boss` + `POST /api/boss/start` + `GET /api/boss/:bossId/rank`**、`GET /api/health`、`GET /ws`。查封号 → `403 ACCOUNT_BANNED`；旧代次 → `403 SESSION_REPLACED`。
- **存档三层（P1-1/1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单）→ `serverClock.ts`（钳未来时间戳）。
- **权威裁决（P1-2）**：意图 nonce → 服务端基线 + 掷骰/时钟/价格 → `authority.pending` → 客户端带 `intentNonce` PUT 核对增量（不符 400 不封号）；`PUT` 三分支 rebase / intentNonce / 单调比对（§14）。
- **实时通道（P2-1）**：`upgrade` 五道闸（路径/Origin/JWT/查封号/**`sv` 代次**）、心跳、上行 4KB·20 条每秒；封号 `bye` 复用 `<BanGate/>`（§15）。
- **顶号 & 共享野怪（P4-1）**：登录 `sessionVersion` +1 签进 JWT `sv` → REST 与 WS upgrade 双校验 → 旧 token 全 403 `SESSION_REPLACED`，`takeover()` 原子接管、旧连接 `bye`+4001；前端只读下线、`stopAutoSync()` 清队列、**不合并不上传旧档**。`WildRegistry` 每区域 3 只（TTL 5min/抢占 30min），**`claim()` 无 `await`** 保原子，结算/放弃/sweep 发 `wild.state`（§22/§27）。
- **在线权威态（P2-2）**：`gameSession` 按 `userId+slot` 内存态，`commitState()` **唯一写入口**（DB→内存→广播 `session.state`），revision 单调、断线 10min TTL；上行只 `session.resync`；云同步冲突恢复 + 防抖 PUT + 离线队列，客户端不能整包把资源改高（§16）。
- **服务端战斗/写操作（P3-1/P3-2）**：`content.generated.ts`（`gen:content`）+ `game/rules.ts`（RNG 注入）+ `game/battle.ts`（状态机/结算）+ `battleSession.ts`；前端 `battleApi.ts` **不做离线降级**；旧意图 `capture` 已删、**下线 `battle_reward`**。`POST /api/game/:op`（`game/mutations.ts` 纯函数）全 `commitState(source='action')`；`checkPartyStateRegression()` 堵 `digestOf` 不含 HP 的盲区（§20）。
- **写入并发控制（P4-0）**：PUT 与意图必须带 `revision`（缺 400 `REVISION_REQUIRED`），过期 409 `REVISION_CONFLICT` 回带快照（server-wins），校验在风控/nonce 前；`slotLock.ts` 按 `userId:slot` 串行读→校→写（**`commitState()` 不取锁**）；前端 409 → `healFromConflict()` 不重试（§21/§26）。
- **只读派生榜（P4-2a）**：落库真值 → `validateSaveData()` 滤脏档 → `game/rank.ts` 派生 → `GET /api/rank/:type`；**实时派生（TTL=0）**，排除封号/管理员；伪上报 400 `RANK_INPUT_FORBIDDEN`、**只有 GET**。战力 = 有效六维之和用 `maxHp`、**不代表实战强弱**、不参与任何判定、公式待定、装备走 `effectiveStats`；**「召唤师等级」是占位派生（台账 F04）**（§23/§28）。
- **房间内核（P4-2b）**：第四个状态域 owner `roomId`。`forming→active→paused→abandoned|settled`；quota **hold→commit→release**（全掉 `release` 不扣次数）；座位存 token sha256，**只同 token 同设备重连**；阈值**按 mode 分档**（kernel 供 CI，生产 20/30/60s）；`room.state` 全量快照、`room.action` 上行意图、伪造上行 → `UNKNOWN_TYPE`+1008；REST 与 WS 共用 `applyRoom*`、全经 `withRoomLock()`；`RoomStorage` 可替换（P5-1 时 quota 须加 key 级锁，F10）（§24/§29）。
- **Boss 讨伐（P4-2c）**：不新增状态域（owner 仍是 `battleId`）。**伤害唯一真值 = 敌方 HP 差** —— `applyBattleAction` 外层包 `applyBattleActionInner` 累计（不在 4 处公式打点，中毒回合末伤害天然包含、溢出被钳不虚高）。**次数 = `BossDamageEvent` 行数（真值）+ `bossQuota` 内存在途**（账号级、按自然日、重启不重置；`battleId @unique` 防重复；三条释放：结算 `commit()` / abandon `release()` / `sweepExpired()` 回收）。`periodKey` 手算 UTC+8（`dayKeyOf`）。**不发奖励**（`s.rewards = null`，待 F02/F14）、**禁止捕获**（`BOSS_UNCATCHABLE` 不扣道具）、**逃跑=放弃不上榜**。锁序 `slot:` → `bossq:`。伪上报 400 `BOSS_INPUT_FORBIDDEN`；榜按账号合并多槽位、排除封号/管理员；`BOSS_DAILY_LIMIT` 只能下调（§25/§30）。
- **测试底座**：`harness.mjs`/`saveWriter.mjs`、`verify.mjs` 编排、`clean-test-data.mjs`（含 `bossDamageEvent`）。
- **能力边界**：**已挡**改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/测试菜单越权/WS 或房间上行伪造/伪造战斗动作与越权 battleId/GG 改内存/旧意图刷奖励/CAS 旧覆盖/顶号后续写/抢野怪/上报榜单数值/**伪造 Boss 伤害与次数**；**未挡**加速器改节奏、改本地展示态。管理员只在服务端判定。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4` / `0xC0000142` 是宿主回收进程。**`lib/env.ts` `.env` 路径曾算错**（`JWT_SECRET` 回落硬编码，严重安全缺陷）；11-05 改 `../../.env` 实测生效。**改配置代码必须实测 `process.env.XXX` 有值。**- §25 P3-2（**HP 摘要盲区**/死道具/全灭惩罚可逃）；§26 CAS（**锁改直通 E2E 仍全绿 → 靠 `slotLock.test.ts`**）；§27 P4-1（只断 WS 互踢死循环/四组 E2E 打红**不加兼容开关**/迁移先停 :3001/`setToken()` 忘复位）。

- §28 P4-2a（**Tab 竞态真缺陷，cleanup `cancelled` 修**/0 分被 limit 截断）；§29 P4-2b 八坑（quota key 冒号被 intent 正则拒/**托管窗口 > 回合超时不是 bug**/`sweep()` 多 bump 跳号/迟到 close 误标掉线/扫描不能挂心跳/REST 与 WS 指纹同源/nonce 别在 no-op 前消费）。
- §30 P4-2c 六坑（**Boss 走普通分支白送 money**/`sweep()` 拿不到态 → 新增 `sweepExpired()`/`BOSS_IN_PROGRESS` 只挡 Boss→普通/**`finalText` 不是 `finalTxt`**/手写 `vi.mock("@/lib/api")` 缺 `bossStart`/`held` 不落库是正确方向）。

## 7. 进度与遗留
- **P4-1 ✅**：顶号 + 共享野怪（§22/§27）。
- **P4-2a ✅ / P4-2b ✅**：四榜只读派生（`e2e:p42a` **39** / `ui_smoke_p42a` **17/17**）；房间内核（`RoomRegistry` + `withRoomLock` + `room.state` + quota 三段式 + 同 token 重连 + 可选托管 + 超时随机代放；`e2e:p42b` **43** + `roomRegistry` 18 + `roomLock` 5 去锁 + `roomProtocol` 8 + 前端 9）。均未动 schema（§23/§24/§28/§29）。
- **P4-2c ✅（11-07）**：单人 Boss 讨伐 + 只读伤害榜 + 每日次数。先还 **F12**（`game/settlement.ts::applySettlementToSave()`，普通战斗与 Boss 共用）；`BossDamageEvent` append-only（`battleId @unique`）；三只占位 Boss（倍率只抬 HP）。证据：`verify` **25/25 `VERIFY_OK`**、后端 **306** / 前端 **122**、`e2e:p42c` **44**、`ui_smoke_p42c` **19/19**；**`SCHEMA_VERSION` 未动**，仅加一条迁移（§25/§30）。
- **P4-2 d~e 📋**：`d 1v1 PVP（房间态 + 双方意图仲裁，复用 b 的托管/超时，结算写双方档各一次 commitState）→ e 共斗/副本（Boss HP 是房间真值）`。野怪/房间/锁单进程内存态，**P5-1 前统一迁共享存储**。契约 `P4-2_多人玩法排期_2026-11-07.md`。**下一步 P4-2d**。
- **Git**：`fe159eb`→`2f2c8b7`→…→`25b6168`(P4-2a)→`d73624e`(P4-2b) 均已推送；`rollback-20261107-pre-p41`/`rollback-20261107-post-p41` 与 pre/post `p42-plan`/`p42a`/`p42b` 成对在远端。`dev.db`/`.env` gitignore。
- **交接**：`HANDOFF.md` + `check_home_env.py` / `doc_check.py`；11-07 已重建并 `ENV_CHECK_OK`。
