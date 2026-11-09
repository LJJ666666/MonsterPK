# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**，镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。日志 `YYYY-MM-DD.md` 追加写；`.trae/documents/` 的 PRD/任务表/bug_log/规范是**产品文档**，不被本文件覆盖。
> 本文件定位：**硬约束 + 状态域/锁 + 进度快照 + 文档索引**。技术细节留在规范/排期/任务表/台账，这里只留指针与一句话结论，不复述数字与代码符号。

## 1. 项目与方向
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）：营地→遭遇→战斗→捕获→结算→营地/图鉴。原纯前端；11-03 起自建 Node+TS 后端，11-04 强制登录。
- **北极星（11-04）**：服务端权威 + 实时多人同玩（服务端结算，客户端只发意图、收状态、渲染）。本地存档过渡态，P5 去除；P0-3 自动同步为桥接。
- **反作弊（11-05）**：测试菜单数据只放行管理员；改档/GG/加速器拦截+封号+登出；改系统时间不封号、只要求不生效（§13）。
- **P4-1 口径（11-07）**：同账号多端不合并本地改动、不静默切档；后来者顶号，前者直接下线（旧 token 所有 REST 403）。共享真值全在服务端。
- **F01/F02（11-09）**：`game/period.ts` UTC+8 周期单一真源（`dayKeyOf` 委托它）；`RankPeriodSnapshot` 幂等快照 + `RankReward` 唯一键防重复；奖励表纯函数 `game/rankReward.ts`；`modules/rankSettlement.ts` 结算+发奖（占位→`readSave`→`applyRankReward`→**同步 `authority.expected`**→`commitState`，顺序不可颠倒）；`npm run rank:settle` 供 cron。四派生榜按结算时刻落库真值定格（Save 无历史版本），Boss 榜按 `periodKey` 精确归档（§28）。
- 总表 `开发任务优先级_2026-11-04.md`：**P0~P4-2e 全 ✅，P4-2 五阶段全部完成**；**台账 F01/F02 已偿还**（11-09，周期结算+榜单奖励，规范 §28）。下一步待定（F04/F09/F14/F15/F16 台账偿还）。**P4-3 只指交易/赠送，别再当周期结算**；**P4-3 = 玩家↔玩家 C2C，11-09 口径「当前所有资产不可交易」→ 阶段冻结，别当下一步**（编号冲突已修）；**收官 `verify --strict` 31/31 `VERIFY_OK`**，三处测试侧红灯见 bug_log §35。
- **未来规划台账** `未来规划与技术债_2026-11-07.md` **F01~F15**（📋/🔨/✅）；**F12、F01/F02 已偿还**。F04 召唤师等级=账号等级+宠物等级帽（占位偏差，偿还前不得声称已实现）；**F15** 1v1 奖励/排位分待设计。

## 2. 技术栈与代码入口
- React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7；路由 `/`、`/camp`、`/arena`、`/auth`。
- 内容唯一源 `src/game/data.ts`（40 幻兽/22 道具/7 城镇/`TYPE_CHART`/`IDLE_CONFIG`/御三家）；规则 `rules.ts`、遭遇 `gen.ts`、挂机 `idle.ts`。
- 全局状态 `src/stores/useGameStore.ts`（3 槽）；persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=10) 派生，migrate 1→10。**BattleState 不进存档**。
- 页面 `Start`/`Auth`/`Camp`(5 Tab)/`Arena`；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`/`RankBoard`/`BossBoard`/`PvpModal`。
- 同步 `lib/sync.ts`、`syncErrors`/`api`/`auth`；`App.tsx` 含 `BanGate`/`SessionGate`/Bootstrap；`ws.ts` 转发 `session.state`+`wild.state`+`room.state`。
- 只读层 `sessionReplaced.ts`、`wild.ts`、`lib/rank.ts`、`lib/room.ts`、`lib/boss.ts`、`lib/pvp.ts`。
- **P4-2 新模块**：房间 `roomTypes`/`roomRegistry`/`roomAuth`/`slotLock::withRoomLock`/`modules/room`；Boss `game/boss`/`game/bossRank`/`lib/bossQuota`/`modules/boss`/`game/settlement`(F12)/`modules/saveRead`；1v1 `game/pvp`/`modules/pvp`（挂 `pvp` 态 + `modules/room::maybeSettlePvp`）。
- 测试边界：前端 vitest 只收 `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`。两套框架不能混跑（§13）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION`（= persist `version`）并补 migrate 分支**；后端 `EXPECTED_SAVE_VERSION`(=10) 同步改。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部 → `Unexpected keyword 'export'`。改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一 `rules.ts` 的 `uuid()`；所有 Hook 必须在组件顶层。
- `strict:false` / `noUnusedLocals:false` —— tsc 宽松；判别联合不收窄，用 `'code' in result`（§18）。
- 移动端优先：弹窗小 `max-w` + `overflow-auto` + `max-h`；375px 实测 `scrollWidth`。
- **服务端权威原则**：客户端上报存档/战报/数值/意图必须服务端校验；写个人档唯一入口 `commitState()`；**WS 上行绝不写状态**。
- **别用「复用普通分支」心态接新玩法**：Boss 产出规则不同，分支显式穷举（`if/else`），否则静默发奖励（§30.1）。
- 前端设计先读 `.impeccable.md`（复古像素/野外手记；内联 SVG、零 CDN）。

## 4. 运行命令与环境
- 起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**交接后不自动恢复**，先 curl 探活。
- **校验首选 `npm run verify`** —— 31 阶段（含 `e2e:f01f02` / `smoke:f01f02`，**全绿 `VERIFY_OK`**）；开跑前**前置清理**残留测试账号，避免污染全服榜断言（§34），自动清测试账号；`--only=`/`--skip=` 跑子集。⚠️ 新增阶段要改**两处**（`STAGES` + `GROUPS`），漏 `GROUPS` 会静默少跑（§32）。分项数字见任务表时间线，本文件不复述。
- 清理/账号：`cd backend && npm run clean:e2e`（`--dry` 预览；只删测试前缀、永不删 admin）；`npm run admin -- grant|revoke|ban|unban|list|audit <名>`。⚠️ 不授权用测试菜单会被封号，绝不写死用户名。
- **项目路径随机器而异**：文档与脚本一律用相对路径 / 动态 ROOT（`git rev-parse --show-toplevel`），不写死盘符或用户名；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`（换 JWT_SECRET）→ 前后端各 `npm install` → **`prisma migrate deploy`**（给已有库加列/加表，漏了必 `P2022`，§34）→ `generate` → `npm run dev`；改 schema 前停 :3001（§12）。`.env`/`dev.db` gitignore。**git 走代理报 502 → `git config --local http.version HTTP/1.1`**（§33）；探活加 `curl --noproxy '*'` 防假 502。
- **Git 流程（11-07 杰哥定）**：验收通过 → 建 `rollback-YYYYMMDD-<阶段>` tag 推远端 → `git add -A` 确认无 `.env`/`*.db` → commit（中文分条、末尾写数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净。
- **推送 502 别纠结（11-09 杰哥定）**：网络波动报 `CONNECT tunnel failed, response 502` 属常态，**直接多试几次**（本次第 1 次重试即成功）；不做分层诊断、不绕道改协议/换通道/走 API。未推上去时如实写「本地 ahead N、远端仍 <hash>」，恢复后重试并核对两端 HEAD。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + @fastify/cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。
- 模型 `User`(username 唯一/bcrypt/`role`/`bannedAt`/`banReason`/`sessionVersion`) + `Save`(userId+slot 唯一/`schemaVersion`/`clientId`/`authority`/3 槽) + `BanRecord` + `IntentLog`(nonce 唯一) + `BossDamageEvent`(`battleId @unique`) + `RankPeriodSnapshot`(`periodKey+boardKey` 唯一) + `RankReward`(`periodKey+boardKey+userId+slot` 唯一)。迁移链 **7 条**；改 schema 前停 :3001。
- API：`auth/{register,login,me}`、`GET|PUT /api/save?slot=`、`POST /api/actions/:type`、`GET /api/session`、`POST /api/game/:op`、`/api/battle/{start,action,abandon}`+`current`、`GET /api/wild`、`GET /api/rank[/:type]` + `/api/rank/periods[/:key]` + `/api/rank/rewards`（只读）+ `POST /api/rank/admin/settle`（仅管理员）、`/api/room[...]`、`GET /api/boss`+`POST /api/boss/start`+`GET /api/boss/:id/rank`、`POST /api/pvp/create`+`POST /api/pvp/:roomId/join`、`GET /api/health`、`GET /ws`。查封号→`403 ACCOUNT_BANNED`；旧代次→`403 SESSION_REPLACED`。
- **存档三层（P1-1/1b）**：`saveValidator.ts`（hard/soft/stats）→ `antiCheat.ts`（allow/reject/ban，`CHEAT_CODES` 白名单）→ `serverClock.ts`（钳未来时间戳）。
- **权威裁决（P1-2）**：意图 nonce → 服务端基线 + 掷骰/时钟/价格 → `authority.pending` → 客户端带 `intentNonce` PUT 核对增量（不符 400 不封号）；`PUT` 三分支 rebase/intentNonce/单调比对（§14）。
- **实时通道（P2-1）**：`upgrade` 五道闸（路径/Origin/JWT/查封号/`sv` 代次）、心跳、上行 4KB·20 条每秒；封号 `bye` 复用 `<BanGate/>`（§15）。
- **顶号 & 共享野怪（P4-1）**：登录 `sessionVersion`+1 签进 JWT `sv` → REST 与 WS 双校验 → 旧 token 全 403 `SESSION_REPLACED`，`takeover()` 原子接管、旧连接 `bye`+4001；前端只读下线、`stopAutoSync()` 清队列。`WildRegistry` 每区域 3 只（TTL 5min/抢占 30min），`claim()` 无 `await` 保原子（§22/§27）。
- **在线权威态（P2-2）**：`gameSession` 按 `userId+slot` 内存态，`commitState()` **唯一写入口**（DB→内存→广播 `session.state`），revision 单调、断线 10min TTL；上行只 `session.resync`（§16）。
- **服务端战斗/写操作（P3-1/P3-2）**：`content.generated.ts`(`gen:content`)+`game/rules.ts`(RNG 注入)+`game/battle.ts`(状态机/结算)+`battleSession.ts`；前端 `battleApi.ts` **不做离线降级**；旧意图 `capture` 已删、**下线 `battle_reward`**。`POST /api/game/:op`（`game/mutations.ts` 纯函数）全 `commitState(source='action')`；`checkPartyStateRegression()` 堵 `digestOf` 不含 HP 盲区（§20）。
- **写入并发控制（P4-0）**：PUT 与意图必须带 `revision`（缺 400 `REVISION_REQUIRED`），过期 409 `REVISION_CONFLICT` 回带快照（server-wins），校验在风控/nonce 前；`slotLock.ts` 按 `userId:slot` 串行（`commitState()` 不取锁）；前端 409 → `healFromConflict()` 不重试（§21/§26）。
- **只读派生榜（P4-2a）**：落库真值 → `validateSaveData()` 滤脏档 → `game/rank.ts` 派生 → `GET /api/rank/:type`；实时派生（TTL=0）、排除封号/管理员、伪上报 400、只有 GET。战力 = 有效六维之和用 `maxHp`、**不代表实战强弱**、不参与判定、公式待定、装备走 `effectiveStats`；「召唤师等级」占位派生（F04）（§23/§28）。
- **房间内核（P4-2b）**：第四个状态域 owner `roomId`。`forming→active→paused→abandoned|settled`；quota **hold→commit→release**（全掉 `release` 不扣次数）；座位存 token sha256，只同 token 同设备重连；阈值按 mode 分档（kernel 供 CI，生产 20/30/60s）；`room.state` 全量快照、`room.action` 上行意图、伪造上行→`UNKNOWN_TYPE`+1008；REST 与 WS 共用 `applyRoom*`、全经 `withRoomLock()`（§24/§29）。
- **Boss 讨伐（P4-2c）**：不新增状态域（owner 仍 `battleId`）。伤害真值=敌方 HP 差；次数=`BossDamageEvent` 行数+`bossQuota` 在途（账号级、按自然日、重启不重置、`battleId @unique` 防重复、三路释放）；`periodKey` 手算 UTC+8。**不发奖励**（`s.rewards=null`）、禁止捕获、逃跑=放弃不上榜；伪上报 400 `BOSS_INPUT_FORBIDDEN`；`BOSS_DAILY_LIMIT` 只能下调（§25/§30）。
- **玩家对战 1v1（P4-2d）**：不新增状态域，战斗态挂 `RoomState.pvp`（`sides` 双方镜像），复用 `rules.ts` 公式 + 房间内核 `submitIntent`/`advanceTurn`/`tick`/`autoSubmit`；意图 `move:<id>`/`switch:<n>`/`flee`，intent 正则放宽冒号；`pvpViewFor` 按接收者裁剪。结算写双方档各一次 `commitState()`、各自 CAS/revision 不覆盖、`pvpSettled` 幂等；**只回写 HP/异常不发奖励**（F15）；`maybeSettlePvp` 三处触发，`room.ts`↔`pvp.ts` 动态 `import` 规避循环；伪上报 400 `PVP_INPUT_FORBIDDEN`（§26/§31）。
- **共斗 Boss / 副本（P4-2e）**：**Boss HP 是 `RoomState.coop.boss.hp` 的房间真值**，`withRoomLock(roomId)` 串行，不新增状态域也不写 `BossDamageEvent`（不污染单人伤害榜，共斗榜归 F16）。`game/coop.ts` 按「优先度→速度→座位」排序结算、**Boss 回合末统一反击一次**、**非法意图服务端降级跳过**（不抛异常，否则一间房能被一个伪造意图打崩）；`coopViewFor` 按接收者裁剪（队友仅 damage/out）；结算**每人各一次 `commitState()`** + `coopSettled` 幂等、不发奖励（F09/F14）；`flee` 入口层 400 `COOP_INTENT_INVALID`；伪上报 400 `COOP_INPUT_FORBIDDEN`（§27/§32）。
- **能力边界**：已挡 改档加资源/伪造捕获/白嫖购买/重复领奖/改时间刷挂机/测试菜单越权/WS 或房间上行伪造/伪造战斗动作与越权 battleId/GG 改内存/旧意图刷奖励/CAS 旧覆盖/顶号后续写/抢野怪/上报榜单数值/伪造 Boss 伤害与次数/伪造 1v1 字段与越权 roomId/伪造共斗伤害与 Boss HP/伪造共斗意图；未挡 加速器改节奏、改本地展示态。管理员只在服务端判定。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4` / `0xC0000142` 是宿主回收进程。**`lib/env.ts` `.env` 路径曾算错**（`JWT_SECRET` 回落硬编码，严重安全缺陷）；11-05 改 `../../.env` 实测生效。改配置代码必须实测 `process.env.XXX` 有值。
- §25 P3-2（HP 摘要盲区/死道具/全灭惩罚可逃）；§26 CAS（锁改直通 E2E 仍全绿→靠 `slotLock.test.ts`）；§27 P4-1（只断 WS 互踢死循环/迁移先停 :3001/`setToken()` 忘复位）。
- §28 P4-2a（Tab 竞态真缺陷 `cancelled` 修/0 分被 limit 截断）；§29 P4-2b（quota key 冒号被 intent 正则拒/`sweep()` 多 bump 跳号/迟到 close 误标掉线/扫描不能挂心跳/nonce 别在 no-op 前消费）。
- §30 P4-2c（Boss 走普通分支白送 money/`sweep()` 拿不到态→`sweepExpired()`/`finalText` 不是 `finalTxt`/手写 `vi.mock` 缺 `bossStart`/`held` 不落库是正确方向）。
- §31 P4-2d（pvp 意图冒号被 intent 正则拒→放宽 `^[A-Za-z0-9_:\-]+$`/`sides.indexOf(side)` 因 side 复制引用失效写空→用 `seatOf` 按 userId 定位/revision 断言忘 await/满员 join 返回 `ROOM_CLOSED` 非 `ROOM_FULL`（合理）/别拿 `innerText` 找 placeholder/1v1 结算不发奖励是刻意、`pvpSettled` 幂等关键）。
- §32 P4-2e（**冒烟 `probeHtml()` 是模板字符串，`\d` 反斜杠被吃掉**→生成到浏览器变成 `/Lv.d/`，改用字面量/`\\d`／**冒烟在数据加载完成前点「创建」**→`bossId` 还空、连锁超时，等待条件要等「元素可用」不是「元素存在」／**非法意图必须服务端降级跳过不能抛异常**→否则一个伪造意图能打崩整间房／`flee` 入口层显式 400／**verify 漏 `GROUPS` 静默少跑**／共斗伤害不写 `BossDamageEvent`、Boss 每回合只反击一次）。

## 7. 进度与遗留
- **P4-1 ✅**：顶号 + 共享野怪（§22/§27）。
- **P4-2a ✅ / P4-2b ✅**：四榜只读派生；房间内核。均未动 schema（§23/§24/§28/§29）。
- **P4-2c ✅（11-07）**：单人 Boss 讨伐 + 只读伤害榜 + 每日次数；先还 **F12**（`game/settlement.ts::applySettlementToSave()`）。`SCHEMA_VERSION` 未动，仅加一条迁移（§25/§30）。
- **P4-2d ✅（11-07）**：1v1 玩家对战（见 §5）。`SCHEMA_VERSION` 未动、未加迁移（§26/§31）。
- **P4-2e ✅（2026-11-08）**：共斗 Boss/副本（见 §5）。**P4-2 五阶段全部完成**。证据：`verify` **29/29**、后端 **336**/前端 **122**、`e2e:p42e` **22/22**、`ui_smoke_p42e` **16/16**；`SCHEMA_VERSION` 未动、未加迁移（§27/§32）。
- **F01/F02 ✅（11-09）**：`e2e:f01f02` **31/31**、`ui_smoke_f01f02` **17/17**、后端 **350**/前端 **129** 单测；`SCHEMA_VERSION` 未动、新增一条迁移（§28/§34）。
- **下一步待定**：**P4-3 交易/赠送阶段冻结**（玩家↔玩家 C2C；当前所有资产不可交易、无可交付标的，将来开放标的表再排），改为偿还台账 **F04**（账号等级）、**F09/F14**（Boss/共斗产出规则）、**F15**（1v1 奖励排位）、**F16**（共斗榜）。野怪/房间/锁单进程内存态，**P5-1 前统一迁共享存储**。契约 `P4-2_多人玩法排期_2026-11-07.md`（已走完）。
- **Git**：`fe159eb`→`2f2c8b7`→…→`d73624e`(P4-2b)→`c837f33`(P4-2c) 已推送；`rollback-20261107-pre/post-p41` 与 pre/post `p42-plan`/`p42a`/`p42b`/`p42c` 成对在远端；**11-09 F01/F02 `5b5cc5e` + `292fba2` + 口径文档 `067cf87` 与 `rollback-20261109-pre/post-f01f02` 均已推送，远端 HEAD `067cf87`**。`dev.db`/`.env` gitignore。
- **交接**：`HANDOFF.md` + `check_home_env.py`/`doc_check.py`；11-07 已重建并 `ENV_CHECK_OK`。
