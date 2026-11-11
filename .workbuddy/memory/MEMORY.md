# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/任务表/bug_log/台账在 `.trae/documents/` 是权威事实；本文件只放硬约束+索引+进度快照。

## 1. 方向 / 进度快照
- 浏览器+Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；11-03 起自建 Node+TS 后端，11-04 强制登录。北极星：服务端权威+实时多人同玩，客户端只发意图、收状态、渲染；本地存档过渡态，P5 去除。
- 不变式：每块状态一个 owner key（个人档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号，改系统时间不封号只要求不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e 全 ✅。台账 F01/F02/F12/F14/F16/F04/F17 已偿还；F15 1v1 零产出冻结；F17 单档化已实现并偿还（`SCHEMA_VERSION` 10→11，`Save.userId @unique`）。
- F18-a 地图锁 ✅ / b 演武堂 ✅ / **c 地图首领 ✅（2026-11-10：独立层、不上榜、胜发掉落+3×经验/5×金钱、每日上限 `BossDamageEvent` 计真值、禁捕获 `MAPBOSS_UNCATCHABLE`、逃跑不发奖）** + **防御性 E2E `e2e_f18c_security.mjs`（35 项全绿，2026-11-11）**；同日修 abandon 名额泄漏（原 `battle.ts` 释放守卫漏放 mapBoss 在途名额，改 `if (state.bossQuotaKey)` 与 `realtime.ts:174` 口径一致） / **d 剧情 ✅（2026-11-10：21 beat 正式文案——7 到达 intro + 7 演武堂贺词 + 7 地图首领讨伐胜利 `on_mapboss_clear`；占位债务已偿）**。P4-3 交易/赠送阶段冻结。
- 验证覆盖补齐（2026-11-11）：核心循环串联 E2E `backend/tests/e2e_core_loop.mjs`（49 项全绿，verify `e2e:core_loop`）+ F18-a/b/c 375px headless Edge UI 冒烟 `scripts/ui_smoke_f18a/b/c.mjs`（9/15/18 全绿，verify `smoke:f18a/b/c`）；顺带修 `Camp.tsx` 地图锁提示循环依赖 bug（展示上一城镇徽章名而非本城自身）。
- 回归 B/C/E 补齐（2026-11-11）：`backend/tests/e2e_content_matrix.mjs`（47 项，内容完整度 7 城/7 徽章/7 馆/7 首/6 房/21 beat + 边界 + 5 个只读接口伪上报闸门对照，verify `e2e:content_matrix`）+ `scripts/ui_smoke_ux.mjs`（26 项，Start 三状态文案 + 剧情/徽章弹窗 + 全局封号/顶号弹窗，verify `smoke:ux`）。**只读闸门口径差异（属产品语义，别擅改）**：`progress`/`rank/:type`/`boss` 显式 400 `*_INPUT_FORBIDDEN`；`gym/overview` 与 `mapboss` 忽略夹带字段、返回值不变。同步订正 `HANDOFF.md`：F18 全阶段收官、`SCHEMA_VERSION` 不再写死 10（F17 已升 11，改以 `saveVersion.ts`/`saveValidator.ts` 为准）。下一步等杰哥排期，接手只读核对。
- P5-1 / F10 共享存储迁移评估（2026-11-11，只读评估稿，**未改产品代码**）：`.trae/documents/P5-1_F10_共享存储迁移评估_2026-11-11.md`。三处修正台账乐观口径：① `revision` 藏在 `Save.authority` JSON 而非独立列、CAS 基线取内存权威态 → 规范 §21.3 的 `UPDATE ... WHERE revision=?` 当前做不了，须先提列 + DB 条件更新；② `RoomStorage` 是同步接口且 `get()` 返回同一对象引用 → 换共享存储是约 600 行状态机同步→异步重写，不是薄替换；③ `realtime.ts:154/216` 两个定时器每进程各跑、`sweepRooms()` 不持锁 → 必须选主 + 共享态 CAS 幂等。共 8 类进程内状态 / 6 耦合点，评级 L，建议 8 阶段（1.1 完成前不开第二实例）。选型推荐 Postgres(真值)+Redis(锁/TTL/pub-sub)，**Redis 不存真值**。另：`SCHEMA_VERSION`(11) 与 Prisma 迁移链(11 条) 是两回事，第 12 条迁移加 `Save.revision` 列不动前者；发奖幂等靠 `grantKey @unique` 已天然跨实例安全。6 项前置输入未定前不开工。
- **P5-1 / F10 实施设计定稿（2026-11-11，杰哥拍板选型 B）**：`.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md` 为实施唯一权威，评估稿降为初稿并挂 12 处勘误指针。三组独立后端架构专家只读复核（并发一致性 / 分布式状态机 / 实时系统）一致「需修正后可用」。硬结论：① 切 Postgres 须归档 11 条 SQLite 方言迁移并重置为一条 PG 基线，`schema.prisma:2` 注释「改 provider 即可」是错的，不存在「第 12 条迁移」；② `commitState` 是 upsert 带 create 分支，409 只能由 `updateMany count` 裁决，存档写无需 fencing token；③ 房间 quota `committed` 是纯内存真值须改 DB 计数、`coopQuotaKey` 有 `slice(-8)` 截断、release 分支实为 10 处；④ `broadcastToMany` 是死代码、room 频道只发 roomId 且各实例本地裁剪、心跳不查 `sessionVersion` 致旧 WS 可无限存活。**选型 B = Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/可重建临时态，Redis 不存任何影响权益的真值**。顺序 W0~W9 四批：W0 接口抽象与单实例零行为变更**无需外部资源、可立即开工**；W2 完成前不开第二实例。6 项前置输入收敛为「仅外部资源」一类（PG/Redis 实例与凭据、域名 HTTPS、停机窗口），设计层面已无待决项；P5-2/P5-3 不同期。
- A 类改造开工（2026-11-11）：交付 A3 `.github/workflows/ci.yml`（CI 只跑无服务静态/单测，E2E 与 375px 冒烟仍归本地 `npm run verify`）+ A6 台账补 F19~F26 与「单机时代设想须按服务端权威重评」提醒（`doc_check` 173 项）。**A1 vite 分包 / A2 requestId 日志 / A4 ErrorBoundary / A5 登录限流 会触发 Vite 或后端 tsx 重启，须等杰哥 `localhost:5173` 自测结束再落地**。雷电 `emulator-5558` 可通信（Android 14 / 1260x2800），但本机无 APK、无 Android SDK / Gradle 链（`gradle-wrapper.properties` 仍指沙盒 `file:///workspace/...`、JDK 17），性能基线 §6 四项真机补测暂不可执行。

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
- **测试脚本编写坑（375px Edge UI 冒烟 / 后端 E2E 复用，非应用 bug）**：① Node 模板字符串里 `\/` 会被吞成 `/`，写正则（如 `/每日余量 3\/3/`）到 HTML 会变成 `/每日余量 3/3/` 致语法错误、整段内联脚本不执行、`data-probe` 恒 PENDING → 改用 `.indexOf()`；② `buttonInRow(text)` 在弹窗里因祖先链含 boss 名会命中错误按钮 → 用 `buttons().filter(b=>b.textContent.trim()==='挑战'|'挑战馆主')[0]` 精确匹配；③ intro 剧情弹窗(`z-50`)会遮挡营地，探针先 `dismissStory` 再点开战；④ 地图首领 UI 冒烟发起战斗后 `held=1` → `remaining=dailyLimit-held`，断言别硬写 `===3`；⑤ 存档顶层无 `badges`/`level`，读 `/api/player/progress`；⑥ 野生捕获不发经验/金钱但捕获即发 `badge_sprout`（首通口径）；⑦ 宠物超 `levelCap=5+5×徽章数` 冻结升级，只断言计算奖励数值；⑧ 地图首领每日上限是梯度 `3,3,2,2,2,1,1`（不是统一 3，从 `mapBosses.ts` 读期望序列）；⑨ 榜单类型是 `monster_power/team_power/summoner_level/progress`（不是 `power`），未知类型先 `RANK_TYPE_UNKNOWN` 才轮到伪字段闸门；⑩ UI 探针只等「兽域手记」会在**骨架阶段**提前返回、intro 剧情 `useEffect` 未挂载 → 等入口按钮出现 + 延后 350ms；⑪ 全局封号/顶号弹窗要在 **iframe 的 `contentWindow`** 派发 `mpk:banned` / `mpk:session-replaced`；⑫ 新增 verify 阶段要改 `STAGES` + 对应 `GROUPS`（新增冒烟归 `GROUPS.smoke`），漏一处静默少跑。

## 7. 验收锚点（doc_check 一致性，勿删）
- P4-2 五阶段全部完成（P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅）；下一步 F16 → F04 均已落地，排期见 `P4-2_多人玩法排期_2026-11-07.md`。
- P3-2 写操作上移服务端（细节规范 §20）；P4-0 写入并发控制（§21，slotLock 串行）；P4-1 ✅ 顶号与共享野怪（§22，SESSION_REPLACED 踢旧设备）。
- F04 不写 `SaveData`，F17 单档化已实现并偿还（不动 `SCHEMA_VERSION` 语义）；F01/F02 已偿还。
- F15 1v1 零产出冻结，P4-3 C2C（交易/赠送）不打算开放交易系统（阶段冻结）。
