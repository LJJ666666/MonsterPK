# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**，镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。日志 `YYYY-MM-DD.md` 追加写。`.trae/documents/` 的规范/排期/任务表/bug_log/台账是权威事实；本文件只放**硬约束 + 索引 + 进度快照**，技术细节一律查文档，不复述数字与代码符号。

## 1. 项目与方向
- 浏览器 + Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；11-03 起自建 Node+TS 后端，11-04 强制登录。
- **北极星**：服务端权威 + 实时多人同玩，客户端只发意图、收状态、渲染；本地存档是过渡态，P5 去除。
- **三条不变式**：每块状态一个 owner key（个人档 `userId`（F17 单档化后）、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；**WS 上行绝不写状态**，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号；改系统时间不封号、只要求不生效（§13）。顶号：旧 token REST 403 `SESSION_REPLACED`（§22）。
- **进度**：总表 `开发任务优先级_2026-11-04.md` P0~P4-2e 全 ✅、**P4-2 五阶段全部完成**；台账 `未来规划与技术债_2026-11-07.md` F12、F01/F02 已偿还、F14、F16、F04、F17 均已偿还，F15 1v1 零产出冻结。收官证据见任务表进度记录。
- **F04 已实现并偿还**（11-10，规范 §31）：人物等级 = 基础 5 + 徽章加成；等级帽**不降级只冻结**；捕获不钳等级；宠物经验只来自常规战斗；徽章/成就双 Tab；真值只在服务端 Grant 表，**不写 `SaveData`、不动 `SCHEMA_VERSION`**。旧「`SaveData` 加 `playerLevel` + 三处联动」是作废方案。
- **F17 单档化已实现并偿还**（11-10，规范 §32）：删三档、一账号一档、直接进游戏不选档；第 11 条迁移删 7 表 `slot` 列、`Save.userId @unique`、`SCHEMA_VERSION` 10→11（**唯一动版本号的阶段**）；`/api/save` 带 `?slot=` 400 `SAVE_SLOT_FORBIDDEN`。**F18-a 地图锁 ✅ / F18-d 剧情骨架 ✅（占位文案债务，先支撑后补）/ 下一步 F18-b 演武堂 / F18-c 地图 Boss**。**P4-3 只指交易/赠送**（玩家↔玩家 C2C，不打算开放交易系统，阶段冻结，别当下一步）。

## 2. 技术栈与代码入口
- React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7；路由 `/`、`/camp`、`/arena`、`/auth`。
- 内容唯一源 `src/game/data.ts`；规则 `rules.ts`、遭遇 `gen.ts`、挂机 `idle.ts`。全局状态 `src/stores/useGameStore.ts`（**单档 `{ save }`**，F17 后无槽位），persist `version` 由 `saveVersion.ts` 的 `SCHEMA_VERSION`(=11) 派生、migrate 1→11（10→11 收敛旧三槽）；**BattleState 不进存档**。
- 页面 `Start`/`Auth`/`Camp`(5 Tab)/`Arena`；弹窗 `Mechanics`/`MoveChart`/`MoveLearner`/`Evolution`/`TypeChart`/`RankBoard`/`BossBoard`/`PvpModal`/`CoopModal`/`BadgeModal`。
- 同步 `lib/sync.ts`/`api`/`auth`/`syncErrors`；`App.tsx` 含 `BanGate`/`SessionGate`/Bootstrap；`ws.ts` 转发 `session.state`/`wild.state`/`room.state`；只读层 `sessionReplaced.ts`/`wild.ts`/`lib/rank|room|boss|pvp|coop|playerProgress.ts`。
- **后端模块索引**：房间 `roomTypes|roomRegistry|roomAuth|slotLock|modules/room`；Boss `game/boss|bossRank`、`lib/bossQuota`、`modules/boss|bossReward`、`game/settlement`(F12)、`modules/saveRead`；1v1 `game/pvp|modules/pvp`；共斗 `game/coop|modules/coop|coopReward`；等级 `game/badges|playerLevel`、`modules/playerProgress`；周期 `game/period|rankReward`、`modules/rankSettlement`。
- 测试边界：前端 vitest 只收 `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`，**两套框架不能混跑**（§18）。

## 3. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SCHEMA_VERSION` + 补 migrate 分支，后端 `EXPECTED_SAVE_VERSION` 同步改**；F04 走服务端独立表故意不动；**F17 已把三处联动到 11**（删 `slot` 是结构变更，必须动）。
- **产品语义变更（规则/数值/风控/离线策略/奖励发放）先给评估与方案让杰哥拍板**；工程取舍可自行决定。开发阶段无真实老用户，不留兼容后门/旧链路/开关，该删直接删干净。
- 服务端权威：客户端上报存档/战报/数值/意图一律服务端校验；**`battleApi.ts` 不做离线降级**、旧意图 `capture` 已删、**下线 `battle_reward`**（§19.5/19.6）。
- 发奖顺序固定：占位 → `readSave` → 发奖 → **同步 `authority.expected`** → `commitState`（§28）。**别用「复用普通分支」心态接新玩法**，Boss/共斗产出规则不同，分支显式穷举（§30.1）。
- `data.ts` 是大对象字面量，漏 `};` 会让后续 `export` 落进对象内部；改完立刻 `npm run check`。
- 禁用 `crypto.randomUUID()`，统一 `rules.ts` 的 `uuid()`；所有 Hook 必须在组件顶层。`strict:false` 下判别联合不收窄，用 `'code' in result`（§18）。
- 前端先读 `.impeccable.md`（复古像素/野外手记，内联 SVG、零 CDN）；移动端优先，弹窗小 `max-w` + `overflow-auto` + `max-h`，375px 实测 `scrollWidth`。

## 4. 运行命令与环境
- 前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。**换会话不自动恢复**，先 `curl --noproxy '*'` 探活。
- **校验首选 `npm run verify`**（唯一权威入口，阶段数以 `scripts/verify.mjs` 输出为准；当前 37 阶段 `VERIFY_OK`）；自动前置清理测试账号防污染全服榜（§34）；`--only=`/`--skip=`/`--strict`/`--no-clean`。⚠️ **新增阶段要改两处 `STAGES` + `GROUPS`**，漏 `GROUPS` 静默少跑（§32.5）。
- 清理/账号：`cd backend && npm run clean:e2e`（`--dry`，只删测试前缀、永不删 admin）；`npm run admin -- grant|revoke|ban|unban|list|audit <名>`。不授权用测试菜单会被封号，绝不写死用户名。
- **路径随机器而异**：文档/脚本用相对路径或 `git rev-parse --show-toplevel`，不写死盘符/用户名；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`（换 JWT_SECRET）→ 前后端各 `npm install` → **`prisma migrate deploy` + `generate`**（漏了必 `P2022`，§34）→ `npm run dev`；改 schema 前停 :3001。`.env`/`dev.db` gitignore；代理 502 → `git config --local http.version HTTP/1.1`（§33）。
- **Git 流程（11-07 定）**：验收通过 → 建推 `rollback-YYYYMMDD-<阶段>` tag → `git add -A` 确认无 `.env`/`*.db` → 中文分条 commit（末尾写验收数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净。
- **推送 502 别纠结（11-09 定）**：网络波动常态，直接有限次重试；不做分层诊断、不绕道改协议。未推上去如实写「本地 ahead N」，恢复后重试并核对两端 HEAD。

## 5. 后端架构与风控现状（独立 `backend/`）
- 栈：Fastify 4 + @fastify/jwt + cors + Prisma 5 + SQLite + bcryptjs + zod + tsx。模型 `User`/`Save`(`userId @unique` 单档)/`BanRecord`/`IntentLog`/`BossDamageEvent`/`RankPeriodSnapshot`/`RankReward`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`；迁移链 11 条，改 schema 前停 :3001。API 与错误码详见规范 §13~§31。
- **存档三层**：`saveValidator` → `antiCheat`（`CHEAT_CODES` 白名单）→ `serverClock`（钳未来时间戳）。`digestOf()` 不覆盖任意新增字段 → F04 真值放独立表，整包 PUT 夹带由 `FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前 400 拦下。
- **P1-2** 意图 nonce → 服务端基线 + 掷骰/时钟/价格 → `authority.pending` → 客户端带 `intentNonce` PUT 核对增量（§14）。**P2-1** `upgrade` 五道闸、心跳、上行 4KB·20 条/秒（§15）。**P2-2** `gameSession` 按 `userId` 内存态，`commitState()` 唯一写入口、revision 单调、10min TTL，上行只 `session.resync`（§16）。
- **P3-1/P3-2 服务端战斗与写操作**：`content.generated.ts` + `game/rules.ts`(RNG 注入) + `game/battle.ts`（F04 由服务端注入 `levelCap`）+ `battleSession.ts`；`POST /api/game/:op` 全经 `commitState(source='action')`；`checkPartyStateRegression()` 堵 `digestOf` 不含 HP 盲区（§20）。
- **P4-0 写入并发控制**：PUT 与意图必须带 `revision`（缺 400 `REVISION_REQUIRED`），过期 409 `REVISION_CONFLICT` 回带快照；`slotLock.ts` 按 `userId` 串行（文件名沿用历史）（`commitState()` 不取锁）；前端 409 → `healFromConflict()` 不重试（§21/§26）。
- **P4-1 ✅ 顶号 & 共享野怪**：登录 `sessionVersion`+1 签进 JWT `sv` → REST 与 WS 双校验 → 旧 token 全 403 `SESSION_REPLACED`，`takeover()` 原子接管；`WildRegistry` 每区域 3 只、`claim()` 无 `await` 保原子（§22/§27）。
- **P4-2a 只读派生榜**：落库真值 → `validateSaveData()` → `game/rank.ts` 派生 → `GET /api/rank/:type`；TTL=0、排除封号/管理员、伪上报 400、只有 GET。战力 = 有效六维之和用 `maxHp`，**不代表实战强弱**、不参与判定；召唤师等级榜改读 `BadgeGrant` 真值（§23/§31）。
- **P4-2b 房间内核**：第四状态域 owner `roomId`；quota **hold→commit→release**；座位存 token sha256；REST/WS 共用 `applyRoom*`、全经 `withRoomLock()`（§24/§29）。
- **P4-2c Boss 讨伐**：伤害真值=敌方 HP 差；次数=`BossDamageEvent` + `bossQuota` 在途；**F14 起双档发奖**（§29）；禁捕获、逃跑不上榜不发奖（§25/§30）。**P4-2d 1v1**：战斗态挂 `RoomState.pvp`，`pvpViewFor` 裁剪、`pvpSettled` 幂等；**F15 零产出冻结，只回写 HP/异常**（§26/§31）。
- **P4-2e / F16 共斗 6 房副本**：房间真值 `RoomState.coop.rooms[].enemies`，`withRoomLock(roomId)` 串行；按「优先度→速度→座位」结算、**非法意图服务端降级跳过**；`coopViewFor` 裁剪；每人各一次 `commitState()` + `coopSettled` 幂等；全清通关发奖（最低贡献 + 每日 3 次上限、`CoopRewardGrant` 唯一键、发奖自取账号锁**不传 `alreadyLocked`**）、`flee` 入口层 400（§27/§32/§30.10）。
- **能力边界**：已挡 改档/伪造捕获/白嫖购买/重复领奖/改时间/测试菜单越权/WS 或房间上行伪造/越权 battleId/GG 改内存/旧意图刷奖励/CAS 旧覆盖/顶号后续写/抢野怪/上报榜单数值/伪造 Boss 与 1v1 与共斗字段；未挡 加速器改节奏、改本地展示态。管理员只在服务端判定。

## 6. 已修的坑（详见 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4`/`0xC0000142` 是宿主回收进程。`lib/env.ts` 的 `.env` 路径曾算错 → 改配置代码必须实测 `process.env.XXX` 有值。
- §25~§32 按阶段归档；§34 旧库漏 `migrate deploy` 连锁假红；§35 F01/F02；§36 F14 同锁重入死锁（`alreadyLocked`）；§37 F16（等级上界 `levelMax+6` / `coopViewFor` 不下发 `turn` / 2MB bodyLimit 竞态）；§38 F04（措辞型断言 / `p42c` 强档 HP / 全服榜 `limit=50` 截断）；§39 F17（`admin.ts` 漏网列 / `rebase` 用例写错 / 迁移先删多档行）。均为测试或文档侧修复，产品逻辑零改动。
- 通用：冒烟模板字符串 `\d` 被吃、等「元素可用」而非「元素存在」、非法意图必须降级跳过、verify 漏 `GROUPS` 静默少跑、同文件同轮多条 `Edit` 互相覆盖。

## 7. 进度与遗留
- **P4-1 ✅ / P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅：P4-2 五阶段全部完成**，契约 `P4-2_多人玩法排期_2026-11-07.md`；F01/F02 已偿还、F12/F14/F16/F04/F17 均已偿还；**F15 ⏸ 冻结**（1v1 零产出仅供娱乐，未来排位赛再设计）。
- **F17 单档化已实现并偿还**（删三档、直接进游戏不选档；实测 106 文件横切 `slot`、第 11 条迁移）→ **F18-a 地图锁 ✅ / F18-d 剧情骨架 ✅（占位文案债务）/ 下一步 F18-b 演武堂（徽章唯一来源，胜利发 `gym:<locationId>`）/ F18-c 地图 Boss**。**F18-d 剧情政策（11-10）**：剧情向内容一律先支撑（Schema + 薄触发器 + 占位对话）后补，不影响其他开发。**P4-3 交易/赠送阶段冻结**（不打算开放交易系统，无可交付标的）。
- 硬门槛：野怪/房间/锁均单进程内存态，**P5-1 多实例部署前统一迁共享存储**。
- **Git**：回滚 tag 成对建在阶段前后并推送；两端 HEAD 一律以 `git rev-parse HEAD origin/master` 实测为准，本文件不固化 hash。`dev.db`/`.env` gitignore。
- **交接**：`HANDOFF.md` + `check_home_env.py` / `doc_check.py` / `sync_memory.py --check`；接手话术见 HANDOFF §5（只读核对，等杰哥排期，不擅自开工）。
