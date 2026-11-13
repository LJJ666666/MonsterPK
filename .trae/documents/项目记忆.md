# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/bug_log/台账在 `.trae/documents/` 是权威事实；本文件只放硬约束+索引+进度快照。

## 1. 方向 / 进度
- 浏览器+Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；11-03 起自建 Node+TS 后端，11-04 强制登录。北极星：服务端权威+实时多人同玩，客户端只发意图、收状态、渲染；本地存档过渡态，P5 去除。
- 不变式：每块状态一个 owner key（个人档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号，改系统时间不封号只要求不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 阶段：P0~P4-2e ✅；F18-a/b/c/d ✅（地图首领独立层不上榜、每日上限梯度 `3,3,2,2,2,1,1`、胜发 3×经验/5×金钱、逃跑不发奖）；F15 1v1 零产出冻结；P4-3 交易/赠送冻结；A 类（A1~A6）✅；P5-1 W0~W5 ✅（W1 PG基线 / W2 存档CAS / W3 Redis锁 / W4 sweep选主（P5-1 W4 ✅ 50/50）/ W5 广播顶号）。P5-1 / F10 共享存储迁移评估（只读初稿）已被实施设计定稿取代，定稿：`.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`。**W6.1（#182）已收官**（2026-11-13 本机 `npm run verify` **51/0**、453s、`VERIFY_OK`，含 14 套 UI 冒烟全绿；本轮另清掉 5 处只在 Windows 本机暴露的脚本/编排缺陷，见 bug_log §61）；**下一步 W6.2（#183 事务边界）**。
- P5 选型 B = Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/可重建临时态，Redis 不存权益真值。实施权威：`.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`（三组专家复核「需修正后可用」）。W6 路线见 §8。

## 2. 技术栈 / 入口 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`；全局状态 `src/stores/useGameStore.ts`（单档，`SCHEMA_VERSION`=11，migrate 1→11；**BattleState 不进存档**）。
- 后端 Fastify4+Prisma5+Postgres16+zod+tsx；模型含 `BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`，迁移链 11 条，**改 schema 前停 :3001**（Windows DLL 文件锁）。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`，两套不混跑。

## 3. 改代码前必读硬约束
- 新增持久化字段 → 递增 `SCHEMA_VERSION`+补 migrate，后端 `EXPECTED_SAVE_VERSION` 同步。F04 走独立表故意不动；F17 已到 11。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，不留兼容后门/旧链路/开关，删干净。
- 服务端权威：客户端上报一律校验；`battleApi.ts` 不做离线降级、旧意图 `capture` 已删、下线 `battle_reward`。
- 发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（§28）。接新玩法分支显式穷举，别复用普通分支。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部→改完立刻 `npm run check`。禁用 `crypto.randomUUID()`，统一 `rules.ts` 的 `uuid()`；Hook 必须在组件顶层。`strict:false`，判别联合不收窄用 `'code' in result`。
- 前端先读 `.impeccable.md`（复古像素/野外手记，内联 SVG、零 CDN）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，375px 实测 `scrollWidth`。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev -- --host 0.0.0.0 --port 5173(or MPK_FRONT_PORT) --strictPort`；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。
- 校验 `npm run verify`（新增阶段改两处 `STAGES`+`GROUPS`，漏 `GROUPS` 静默少跑）。`cd backend && npm run clean:e2e`（`--dry` 只删测试前缀不删 admin）；`npm run admin`。
- 路径用相对/`git rev-parse --show-toplevel`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master` 且工作树干净。推送前先单次 curl 实测三通道（沙箱 11811 / 系统 8693 / 直连 no-proxy）选 200，**§56 旧「恒用 8693」已证伪，以实测为准**。
- **配置分层硬约束（§57，勿再犯）**：沙箱层（会话注入 `HTTPS_PROXY=11811`/`CODEBUDDY_*`）≠ 系统层（注册表 `ProxyServer=8693`、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`+`.env.example`）。沙箱值禁写仓库；覆盖 env 仅用一次性命令前缀；本地探活 `curl --noproxy '*'`，PG/Redis 用 `redis-cli PING` / `/api/health` 判活。
- **本机 PowerShell + GBK 兼容（§61，五条都已踩过，勿回退）**：① npm script **不许裸 glob**（`tests/*.test.ts` 在 PowerShell 不展开，node 也不补 → 写 `"tests/**/*.test.ts"` 带引号交给 Node 22 自带 glob）；② Python 脚本 stdout 必须 `reconfigure(errors="replace")`（本机 GBK，遇 ✅ 抛 `UnicodeEncodeError` 整段崩）；③ 冒烟临时页写 `public/` 会触发 Vite **full-reload 打断 dump-dom**（表现：`<div id="root"></div>` 空、`textLen:0`、probe 卡 `PENDING`）→ `vite.config.ts` 必须保留 `server.watch.ignored: ['**/public/_*.html']`；④ 不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`（SIGKILL 硬杀不执行 shutdown，残留 `lock:sweep:global` 60s TTL 会挡住 :3001 → W4 A1/A2/F0 与 p42b 超时代放同源红）；⑤ 沙箱跑冒烟不用 msedge（被沙箱拦），`EDGE_PATH` 指向 `C:\Users\Six\.cache\puppeteer\chrome-headless-shell\win64-131.0.6778.204\chrome-headless-shell-win64\chrome-headless-shell.exe`。另：服务端 `authority.expected` 追随落库值，**并发测试两路候选值必须相邻递减**，差 100 会在弱方赢后被 `AUTHORITY_MISMATCH` 400 抢先拦掉（§61 ⑤）。

## 5. 本机 PG / Redis 启动（实测关键，2026-11-13）
- **PG 已配置为 Windows 服务 `PostgreSQL16`（已验证 ✅）**：服务账户 `NT AUTHORITY\NetworkService`（非管理员，恰好绕开 PG16 的 admin 检查）；`StartType=Automatic`（开机自启）；`PathName="E:\Six\pg-runtime\package\native\bin\pg_ctl.exe" runservice -N PostgreSQL16 -D "E:\Six\pg-runtime\data" -w -o "-p 5432"`；监听 `127.0.0.1:5432` + `::1`。**沙箱后端实测可连**（登录探测 401 正常鉴权、非 `Can't reach database`）。会话结束 PG 不再随沙箱回收，是持久化方案。
- **管理命令（在本机 PowerShell/cmd 跑，agent 不参与、不受沙箱黑名单限制）**：`Start-Service PostgreSQL16` / `sc.exe start PostgreSQL16` / `net start PostgreSQL16`；停=`Stop-Service`/`sc.exe stop`/`net stop`。⚠️ **PowerShell 里 `sc` 是 `Set-Content` 别名** → 必须写 `sc.exe`（带后缀）才调得到真正的服务控制程序；否则 `sc start X` 会静默在 bin 目录写成同名文件（已踩坑，已清）。
- **沙箱命名空间共享（已实测澄清）**：沙箱与本机是**同一网络命名空间**（本机进程列表含沙箱起的 postgres/redis/node，两侧都能看到 4 端口）。早期"命名空间隔离、后端连不上本机 PG"是误判，真相是那次 PG 进程已死（挂在脚本控制台被回收）。故"本机服务 PG → 沙箱后端"这条路**走得通**，已验证。
- ❌ 旧 `pg_ctl + exec sleep 100000000` 保活 hack 已弃用（保留仅作无服务时的兜底）：`pg_ctl start` 命令返回后沙箱回收进程树，必须 `run_in_background` + `sleep` 兜底；`postgres.exe` 直启被 admin 检查拒（exit 1），`pg_ctl` 能绕开。`runas /trustlevel` 从 Bash 被沙箱静默丢弃。
- Redis：`E:/Six/redis-runtime/redis-server.exe --port 6379 ...` 后台起（`run_in_background`），`redis-cli PING` 判活。会话结束会被回收，下次需重起（同后端/前端）。
- 后端 `.env`：`DATABASE_URL=postgresql://mpk@127.0.0.1:5432/monsterpk`、`REDIS_URL=redis://127.0.0.1:6379`、`PORT=3001`；health 路由 `/api/health`（报 `lock/sweep/broadcast` 模式）。

## 6. 后端架构快照
- 存档三层：`saveValidator`→`antiCheat`(`CHEAT_CODES`)→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前 400 拦整包 PUT 夹带真值。
- P4-2a 只读派生榜；P4-2b 房间 `roomId`+`withRoomLock`；P4-2c Boss 伤害=敌方HP差+`BossDamageEvent`+F14双档；P4-2d 1v1/`pvpViewFor`+`pvpSettled` 幂等；P4-2e/F16 共斗 `RoomState.coop`+`withRoomLock(roomId)`+最低贡献+每日3次；F18-c 地图首领 `game/mapBosses.ts`+`modules/mapBoss.ts`+`settleMapBossRun`（`finish()` 给 3×经验/5×金钱）。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/测试菜单越权/WS或房间上行伪造/越权battleId/GG改内存/旧意图刷奖/CAS旧覆盖/顶号后续写/抢野怪/伪造榜/Boss/1v1/共斗字段；未挡 加速器改节奏、改本地展示态。管理员只在服务端判定。

## 7. 已修坑 / 交接（详 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4`/`0xC0000142` 宿主回收；`lib/env.ts` `.env` 路径曾算错→改实测 `process.env.XXX`。
- Windows 下 `vite-tsconfig-paths` 与 `vite:html-inline-proxy` 因盘符大小写静默失配 → 别名走 Vite 原生 `resolve.alias`、模板禁内联 module script、dev 必须 `host:0.0.0.0`（只监听 ::1 时 IPv4 探活 000）。
- 带 RNG 的 E2E（逃跑/捕获）必须重试到 `finished` 或走 `abandon`；改 vite 配置会重启 dev server，重启后先探活再跑 verify。
- 通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、非法意图降级跳过、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。
- F18-d 剧情只改 `src/game/story.ts`（`placeholder:false`+替换 `lines`）；硬门槛：野怪/房间/锁单进程内存态，**P5-1 多实例前统一迁共享存储**。交接 `HANDOFF.md`；接手只读核对，等杰哥排期。

## 8. W6 路线（房间+quota 共享存储迁移，评级 L；任务 #181~#188）
依赖 W2/W4/W5（PG+Redis），当前 4 服务已全起。设计定稿 §3.3/§3.6。顺序：
- #181 W6.0 数据模型与迁移 ✅（2026-11-13：新增 `Room`+`RoomQuotaDaily` 模型，迁移 `20261113020739_w6_room_storage` 已 apply，client 已 regenerate，表已落库，产品代码零改动先行验收）
- #182 W6.1 RoomStorage 异步化 + PG 行版本 CAS ✅（2026-11-13 收官，零行为变更）：`pgRoomStorage.ts`（PG 行版本 CAS）+`roomRegistry.ts` 全 async 重写（load-once/set-once、`bump` 冲突抛错）、`sessionBus.ts` 注入；全部调用方（room/coop/pvp/realtime）await 化、单测 await 化（转换脚本 `scripts/w6_await_transform.cjs` 括号感知 v2）。**顺带修三处 W6.1 引入/暴露的回归，勿回退**：① `setSettledFlag` 改走新增 `writeBack` 原语（同 revision 条件写回，不 bump revision，W0 钉住口径；`RoomStorage` 接口/两存储实现/测试 CopyStorage 同步加）；② 新增 `retryCas` 整段重试（loadAndMutate/withUserRooms/attachPvp/attachCoop/tick 全包，5 次）——WS 掉线标记不持房间锁，CAS 冲突曾把进程打死；③ realtime `onConnected` 事件监听提取为 `attachWsHandlers` 且在**任何 await 之前**挂载——reconnect 变 async 后监听器晚挂载会静默丢 hello 后立即上行的消息（对抗攻防 ping/限流用例实证）。验收：后端单测 453/453、房间 E2E p42b 43/p42d 16/p42e 20/F16 14、core_loop 49、W2~W5 E2E 25/23/27/23、hardening 122/122 全绿。
- #183 W6.2 room+quota+结算/发奖 收进同一事务边界
- #184 W6.3 房间 `committed` 改 DB 计数 + 结算事务二次 count
- #185 W6.4 quota 租约 token + 幂等释放 + TTL≥30min + 补齐 10 处 release 分支
- #186 W6.5 序列化 3 障碍修复（pvpSettled/coopSettled/contributions/optional）
- #187 W6.6 保留按接收者裁剪视图 + `RoomState.revision`/`Save.revision` 区分
- #188 W6.7 双实例 E2E 验收（含跨实例 room 送达，此前 W5 边界无法构造）
收官：核对代理分层→建推 `rollback` tag→归档 bug_log/HANDOFF/任务表→`git add -A`（无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master` 且工作树干净。

## 9. 验收锚点（勿删）
- P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅，P4-2 五阶段全部完成（排期契约：`.trae/documents/P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 写入并发控制（slotLock 串行，细节规范 §21）；P4-1 ✅ 顶号与共享野怪（SESSION_REPLACED 踢旧设备）。
- F04 不写 `SaveData`；F17 单档化已实现并偿还；F01/F02 已偿还。F15 1v1 零产出冻结、P4-3 C2C 阶段冻结，**不打算开放交易系统**（1v1 对战定位仅供娱乐）。
