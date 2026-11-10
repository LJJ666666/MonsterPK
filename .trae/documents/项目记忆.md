# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/任务表/bug_log/台账在 `.trae/documents/` 是权威事实；本文件只放硬约束+索引+进度快照。

## 1. 方向 / 进度快照
- 浏览器+Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；11-03 起自建 Node+TS 后端，11-04 强制登录。北极星：服务端权威+实时多人同玩，客户端只发意图、收状态、渲染；本地存档过渡态，P5 去除。
- 不变式：每块状态一个 owner key（个人档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号，改系统时间不封号只要求不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e 全 ✅。台账 F01/F02/F12/F14/F16/F04/F17 已偿还；F15 1v1 零产出冻结；F17 单档化（`SCHEMA_VERSION` 10→11，`Save.userId @unique`）。
- F18：a 地图锁 ✅ / b 演武堂 ✅ / **c 地图首领 ✅（2026-11-10：独立层、不上榜、胜发掉落+3×经验/5×金钱、每日上限 `BossDamageEvent` 计真值、禁捕获 `MAPBOSS_UNCATCHABLE`、逃跑不发奖）** / **d 剧情 ✅（2026-11-10：21 beat 正式文案——7 到达 intro + 7 演武堂贺词 + 7 地图首领讨伐胜利 `on_mapboss_clear`；占位债务已偿）**。P4-3 交易/赠送阶段冻结。

## 2. 技术栈 / 入口 / 测试
- React18+TS+Vite6+Tailwind3+zustand5+react-router7；路由 `/` `/camp` `/arena` `/auth`。内容唯一源 `src/game/data.ts`；全局状态 `src/stores/useGameStore.ts`（单档，`SCHEMA_VERSION`=11，migrate 1→11）；**BattleState 不进存档**。
- 后端 Fastify4+Prisma5+SQLite+zod+tsx；模型含 `BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`，迁移链 11 条，改 schema 前停 :3001。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`，两套不混跑。

## 3. 改代码前必读硬约束
- 新增持久化字段 → 递增 `SCHEMA_VERSION`+补 migrate，后端 `EXPECTED_SAVE_VERSION` 同步。F04 走独立表故意不动；F17 已到 11。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，不留兼容后门/旧链路/开关，删干净。
- 服务端权威：客户端上报一律校验；`battleApi.ts` 不做离线降级、旧意图 `capture` 已删、下线 `battle_reward`。
- 发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（§28）。接新玩法分支显式穷举，别复用普通分支。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部→改完立刻 `npm run check`。禁用 `crypto.randomUUID()`，统一 `rules.ts` 的 `uuid()`；Hook 必须在组件顶层。`strict:false`，判别联合不收窄用 `'code' in result`。
- 前端先读 `.impeccable.md`（复古像素/野外手记，内联 SVG、零 CDN）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，375px 实测 `scrollWidth`。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。
- 校验首选 `npm run verify`（新增阶段改两处 `STAGES`+`GROUPS`，漏 `GROUPS` 静默少跑）。`cd backend && npm run clean:e2e`（`--dry` 只删测试前缀不删 admin）；`npm run admin`。
- 路径用相对/`git rev-parse --show-toplevel`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master` 且工作树干净。推送 502 别纠结，有限次重试。

## 5. 后端架构快照
- 存档三层：`saveValidator`→`antiCheat`(`CHEAT_CODES`)→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前 400 拦整包 PUT 夹带真值。
- P1-2 意图 nonce；P2-2 `commitState()` 唯一写入口、revision 单调。P3-1/2 服务端战斗 `game/battle.ts`+`battleSession.ts`。P4-0 PUT/意图带 `revision`（缺 400/过期 409），`slotLock` 按 `userId` 串行。P4-1 顶号+共享野怪(`WildRegistry`每区3只，`claim()`无await)。
- P4-2a 只读派生榜；P4-2b 房间 `roomId`+`withRoomLock`；P4-2c Boss 伤害=敌方HP差+`BossDamageEvent`+F14双档；P4-2d 1v1/`pvpViewFor`+`pvpSettled`幂等；P4-2e/F16 共斗 `RoomState.coop`+`withRoomLock(roomId)`+最低贡献+每日3次；F18-b 演武堂 `settleGymRun`发 `gym:<loc>` 徽章；**F18-c 地图首领 `game/mapBosses.ts`+`modules/mapBoss.ts`+`settleMapBossRun`（`finish()` 给 3×经验/5×金钱）**。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/测试菜单越权/WS或房间上行伪造/越权battleId/GG改内存/旧意图刷奖/CAS旧覆盖/顶号后续写/抢野怪/伪造榜/Boss/1v1/共斗字段；未挡 加速器改节奏、改本地展示态。管理员只在服务端判定。

## 6. 已修坑 / 交接（详 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4`/`0xC0000142` 宿主回收；`lib/env.ts` `.env` 路径曾算错→改配置实测 `process.env.XXX`。
- §34 漏 `migrate deploy` 假红；§36 F14 同锁重入死锁(`alreadyLocked`)；§37 F16（`levelMax+6`/`coopViewFor` 不下发 `turn`/2MB bodyLimit）；§39 F17（`admin.ts` 漏列/`rebase`/迁移先删多档行）。通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、非法意图降级跳过、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。
- F18-d 剧情：真剧情补全只改 `src/game/story.ts`（置 `placeholder:false`+替换 `lines`），不动触发器/弹窗。硬门槛：野怪/房间/锁单进程内存态，**P5-1 多实例前统一迁共享存储**。交接：`HANDOFF.md`；接手只读核对，等杰哥排期。
