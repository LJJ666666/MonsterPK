# MEMORY.md — MonsterPK（兽域手记）
> 权威源：本文件；镜像 `.trae/documents/项目记忆.md`（改完跑 `python scripts/sync_memory.py`）。规范/排期/bug_log 在 `.trae/documents/` 是权威事实；本文件只放硬约束+索引+进度快照。

## 1. 方向 / 进度
- 浏览器+Capacitor/Android 抓怪回合制 RPG（`com.monster.game`）；自建 Node+TS 后端，强制登录。北极星：**服务端权威 + 实时多人同玩**，客户端只发意图、收状态、渲染。
- **本地存档 2026-11-13 全部删除**（zustand persist、localStorage 副本、syncPolicy 的 LWW、离线重传队列、rebase 标记）。刷新由 `src/lib/saveBootstrap.ts` 走 `GET /api/save`，`BootGate` 拉到档之前不渲染路由。
- 不变式：每块状态一个 owner key（个人档 `userId`、战斗 `battleId`、野怪 `areaId`、房间 `roomId`）；每处写入一个串行键；WS 上行绝不写状态，个人档唯一写入口 `commitState()`。
- 反作弊：测试菜单只放行管理员；改档/GG/加速器拦截+封号，改系统时间不封号只要求不生效；顶号旧 token REST 403 `SESSION_REPLACED`。
- 进度：P0~P4-2e ✅；F18-a/b/c/d ✅；F15 冻结；P4-3 交易/赠送冻结；A1~A6 ✅；**P5-1 W4 ✅ 2026-11-12**（sweep 选主 / fencing / 幂等键，50/50）、W0~W3/W5 ✅；W6.0/W6.1 ✅；本地存档删除 ✅；**W6.2 事务边界 ✅ 2026-11-13**（52/52）、**W6.3 DB 计数 ✅ 2026-11-13**（53/53）、**W6.4 quota 租约 ✅ 2026-11-14**（#185：token 幂等+TTL30min+补齐 8 处 release/commit，tsc 0 错 / bossQuota 单测 11/11 / 纯逻辑单测 143/143）、**W6.5 序列化归一化 ✅ 2026-11-14**（#186：`normalizeRoom` 在 `PgRoomStorage.get/all` 将共斗 `contributions` 的 string key 转 number、缺省 `pvpSettled/coopSettled` 补显式 false；注 pvpSettled 初始化+settled 显式写回+optional 显式布尔已在 W0/W6.1/2 顺手修掉，本次仅剩 contributions 一项；tsc 0 错 / roomNormalize 单测 4/4 / 后端单测 477/477 / e2e:p42c+f18c+p42e 98/98）**。下一步 **W6.6（#187 按接收者裁剪视图 + RoomState.revision/Save.revision 区分）** / **W6.7（#188 双实例 E2E 验收，含跨实例 room 送达）**。
- 选型 B：Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/可重建临时态，**Redis 不存权益真值**。实施权威：`.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`。

## 2. 技术栈 / 入口 / 测试
- 前端 React18+TS+Vite6+Tailwind3+zustand5+react-router7；内容唯一源 `src/game/data.ts`；全局状态 `src/stores/useGameStore.ts`（**无 persist，`save` 只是服务端快照的渲染副本**；`SCHEMA_VERSION`=11；**BattleState 不进存档**）。
- 后端 Fastify4+Prisma5+Postgres16+zod+tsx；模型含 `Room`/`RoomQuotaDaily`/`BossDamageEvent`/`BossRewardGrant`/`CoopRewardGrant`/`BadgeGrant`/`AchievementGrant`，迁移链 12 条，**改 schema 前停 :3001**（Windows DLL 文件锁）。
- 测试：前端 vitest `src/**/*.test.{ts,tsx}`；后端 `node:test` 在 `backend/tests/`，两套不混跑。

## 3. 改代码前必读硬约束
- 新增持久化字段 → 递增 `SCHEMA_VERSION`（`src/stores/saveVersion.ts`）+ 后端 `saveValidator.ts` 的 `EXPECTED_SAVE_VERSION` 同步改。**前端已无 migrate**，结构校验只在服务端。
- 产品语义变更先给评估让杰哥拍板；工程取舍自行决定。无老用户，不留兼容后门/旧链路/开关，删干净。
- 服务端权威：客户端上报一律校验；`battleApi.ts` 不做离线降级、旧意图 `capture` 已删、下线 `battle_reward`。
- 发奖顺序：占位→`readSave`→发奖→同步 `authority.expected`→`commitState`（规范 §28）。接新玩法分支显式穷举，别复用普通分支。
- 前端写档只剩两个入口：服务端快照 `importSaveJson`（含 WS `session.state`）与意图通道 `intents.ts`。**不要再引入任何本地缓存真值**。
- `data.ts` 大对象漏 `};` 会让后续 `export` 落进对象内部→改完立刻 `npm run check`。前端禁用 `crypto.randomUUID()`，统一 `rules.ts` 的 `uuid()`（旧 WebView 无此 API）；**后端 Node 22 用 `node:crypto` 的 `randomUUID()` 为既定模式**（roomRegistry/sweepLeader/bossQuota 等均如此，rules.ts 无 uuid 导出）。Hook 必须在组件顶层。`strict:false`，判别联合不收窄用 `'code' in result`。
- 前端先读 `.impeccable.md`（复古像素/野外手记，内联 SVG、零 CDN）；移动端优先，弹窗 `max-w`+`overflow-auto`+`max-h`，375px 实测 `scrollWidth`。

## 4. 运行 / 环境 / Git
- 前端 `npm run dev -- --host 0.0.0.0 --port $MPK_FRONT_PORT --strictPort`（默认 5173，本机 5174 绕微信占端口）；后端 `cd backend && npm run dev`（3001）。换会话不自动恢复，先 `curl --noproxy '*'` 探活。
- 校验 `npm run verify`（新增阶段改两处 `STAGES`+`GROUPS`，漏 `GROUPS` 静默少跑）。`cd backend && npm run clean:e2e`（`--dry` 只删测试前缀不删 admin）；`npm run admin`。
- 路径用相对/`git rev-parse --show-toplevel`；remote `LJJ666666/MonsterPK.git`；node 22.22.2。新机：`cp .env.example .env`→前后端 `npm install`→`prisma migrate deploy`+`generate`→`npm run dev`。
- Git：验收通过→建推 `rollback-YYYYMMDD-<阶段>` tag→`git add -A`（确认无 `.env`/`*.db`）→中文分条 commit（末尾写验收数字）→push master→核对 `HEAD==origin/master` 且工作树干净。推送失败先做一次只读探活（`git ls-remote` / `info/refs` 200 = 通道通），沙箱内最多 **5 次**原样重试（不换代理/不试直连/不改 git config）；探活也失败或 502 恒现才交杰哥本机终端（§63，11-13 23:40 上限由 1 改 5）。别做长篇诊断，收尾核对本地 tag 是否全在远端。
- **配置分层硬约束（§57）**：沙箱层（`HTTPS_PROXY=11811`/`CODEBUDDY_*`）≠ 系统层（注册表 8693、本机 PG/Redis/JDK 路径）≠ 项目层（`MPK_FRONT_PORT`→`devConfig.mjs`；`DATABASE_URL`/`REDIS_URL`/`CORS_ORIGIN`→`backend/.env`）。沙箱值禁写仓库；覆盖 env 只用一次性前缀。**项目层是唯一可提交真值**。
- **沙箱出网边界（实测 2026-11-14，已修正）**：沙箱与宿主**只共享 localhost**（PG/Redis 在 127.0.0.1 才通），**出公网被防火墙限制成只能走 WorkBuddy 注入的代理**（会话端口会变，如 `127.0.0.1:1136`）。`env -u HTTPS_PROXY` 关代理后 `curl github.com:443` **直接超时（exit 124）**= 直连被挡，所以"关掉代理走本机通道推送"**行不通**。**代理按目标地址挑着放行、且对 GitHub 间歇不稳**：同代理下 `registry.npmjs.org` 实测 **HTTP 200（npm install 可用）**；GitHub 实测 **HTTP 200 与 000/502 交替**——同一次会话内几分钟就从 200 翻到 502（上游 CONNECT 时通时断）。结论：沙箱内 git push **不是硬阻断，是看窗口**：命令照跑，出网包到 GitHub 被代理间歇挡；遇到 200 窗口重试即能推（2026-11-14 实测推成 commit `07b2ba7` + tag `rollback-20261114-netdoc`，推送后数分钟又翻 502 致 `ls-remote` 复核失败＝假阴性，非真缺失）。本机终端在宿主防火墙外直连最稳。既定口径：沙箱最多原样重试 5 次，**探活 200 就抓住窗口重试**；持续 502 属环境阻断，交本机终端推。文件写入/本地进程（浏览器/模拟器）均不依赖该出口，故正常可用。github skill（gh CLI）未装在沙箱，且推送本就用 git 而非 gh——装 skill 不改变出网，本次能推纯属撞上 200 窗口。
- **本机推送 bat（2026-11-14 新增）**：为绕开沙箱代理间歇性阻断，仓库根放 `push-mpk.bat`（`cd /d %~dp0` 便携，只做 `git fetch`+状态+`git push origin master --tags`，**不含 add/commit** 以免误提交 `.env`/半成品）。用户在本机双击即用宿主直连网络推送，比沙箱重试稳。约定：tx 在沙箱 commit + 打 rollback tag，用户双击 bat 推；bat 自身也已提交进仓库以便带到公司。后续推送优先走此 bat，沙箱仅作 200 窗口重试兜底。
- **本机 PowerShell + GBK（§61，五条勿回退）**：① npm script 不许裸 glob（PowerShell 不展开，写 `"tests/**/*.test.ts"` 带引号交给 Node 22 glob）；② Python stdout 必须 `reconfigure(errors="replace")`（GBK 遇 ✅ 抛 `UnicodeEncodeError`）；③ 冒烟临时页写 `public/` 触发 Vite full-reload 打断 dump-dom → 保留 `server.watch.ignored: ['**/public/_*.html']`；④ 不测选主的双实例 E2E 子进程必须 `MPK_DISABLE_SWEEP=1`（SIGKILL 不执行 shutdown，残留 `lock:sweep:global` 60s TTL 挡住 :3001）；⑤ 沙箱跑冒烟不用 msedge，`EDGE_PATH` 指向 `C:\Users\Six\.cache\puppeteer\chrome-headless-shell\win64-131.0.6778.204\chrome-headless-shell-win64\chrome-headless-shell.exe`。另：`authority.expected` 追随落库值，并发测试两路候选值必须相邻递减。

## 5. 本机环境（PG / Redis）
- **PG = Windows 服务 `PostgreSQL16`**（账户 `NT AUTHORITY\NetworkService` 绕开 PG16 admin 检查，`StartType=Automatic`，127.0.0.1:5432，`pg_ctl.exe runservice -N PostgreSQL16 -D E:\Six\pg-runtime\data -w -o "-p 5432"`），会话结束不回收。管理命令在**本机**跑：`Start-Service PostgreSQL16` / `sc.exe start` / `net start`；⚠️ PowerShell 里 `sc` 是 `Set-Content` 别名，**必须写 `sc.exe`**。
- **环境启动约定（杰哥 2026-11-13 定，跨机器通用）**：PG / Redis 由杰哥双击 `start-mpk-runtime.bat`（**仓库外、幂等：已运行则 skip**）启动。脚本 2026-11-14 升级为 robust 版：**自适应 D:/Six 或 E:/Six 安装基**（家用机 D、公司机 E，同一份文件两机通用，放各自 `X:/Six/` 下即可）；**优先 `PostgreSQL16` Windows 服务 `sc start`**（服务以 NetworkService 跑，绕开 Administrator 下 `postgres.exe` 直启被 PG16 admin 检查拒 exit 1 的坑），服务未注册才回退 `postgres.exe` 直启并提示注册命令；非管理员时**提示**右键以管理员运行（**不自提权**，避免双击闪退）；逐项 `OK/FAILED` 校验。tx 开工前只探活（5432 / 6379、`health`），发现缺失**明确告知杰哥去启动**，不要自行注册系统服务或拉前台进程顶替。
- ⚠️ **bat 必须用 CRLF 换行（致命坑）**：WorkBuddy 的 `Write` 写出的是 **LF**，而 `cmd.exe` 对纯 LF 的 `.bat` 会把嵌套括号块（`if (...) ( ... )`）解析错 → 语法错误直接退出，**连末尾 `pause` 都执行不到 = 双击/管理员运行都「闪退」**。修法：`Write` 写 LF 后，用 Bash `sed -i 's/\r$//; s/$/\r/' <file>` 转 CRLF（或 PowerShell `Set-Content -Encoding ascii`，但 PowerShell 工具会扫描 cmd 语法、遇到 `if exist` 等内容直接拦截写入，故 bat 改写走「Write→Bash sed 转 CRLF」最稳）。另：沙箱 Bash **禁止调 `cmd.exe`**（"bypasses command validation"），无法实跑 bat 验证语法，只能静态分析 + 交本机跑。⚠️ **块内 echo 禁用裸括号**：`if (...) (...)` 块内的 `echo` 文本若含裸 `)`（如 `echo ... (direct), skip`），cmd 会把它当成该 `if` 块的**闭合括号**，导致整段括号失配、报「此时不应有 skip。」并中止脚本（**连 `pause` 都执行不到 = 窗口闪退**）。避坑：块内 echo 不用裸 `()`，改方括号或直接去掉括号；排查用 `grep -o '('` / `')'` 计数是否平衡。
- 沙箱与本机**同一网络命名空间**（实测），"本机 PG → 沙箱后端"走得通。⚠️ 关于 `postgres.exe` 直启：原记"被 PG16 admin 检查拒 exit 1"**并非绝对**——2026-11-14 家用机（账户 `C:\Users\Administrator`）实测 `start-mpk-runtime.bat` 走 direct launch 分支，`postgres.exe -D ... -p 5432` 正常起、探活 `[PG] OK`，无需注册服务。故服务注册是**可选优化**而非必做；若某机直启被拒再按 bat 内 `pg_ctl register` 提示注册。
- Redis `X:/Six/redis-runtime/redis-server.exe --port 6379`（X=D 家用 / E 公司）后台起（会话结束被回收），`redis-cli PING` 判活。后端 `.env`：`DATABASE_URL=postgresql://mpk@127.0.0.1:5432/monsterpk`、`REDIS_URL=redis://127.0.0.1:6379`、`PORT=3001`；health 报 `lock/sweep/broadcast` 模式。

## 6. 后端架构快照
- 存档三层校验：`saveValidator`→`antiCheat`(`CHEAT_CODES`)→`serverClock`；`FORBIDDEN_PROGRESS_SAVE_FIELDS` 在 CAS 前 400 拦整包 PUT 夹带真值。
- P4-2a 派生榜 / P4-2b 房间 `withRoomLock` / P4-2c Boss `BossDamageEvent` / P4-2d 1v1 `pvpSettled` 幂等 / P4-2e+F16 共斗 `RoomState.coop`+最低贡献+每日3次 / F18-c 地图首领 `settleMapBossRun`（3×经验/5×金钱）；W6.1 `lib/pgRoomStorage.ts` 行版本 CAS + `retryCas`/`writeBack`，WS 监听器必须在**任何 await 之前**挂载。
- 能力边界：已挡改档/伪造捕获/白嫖购买/重复领奖/改时间/测试菜单越权/WS 或房间上行伪造/越权 battleId/旧意图刷奖/CAS 旧覆盖/顶号后续写/抢野怪/伪造榜/Boss/1v1/共斗字段；未挡加速器改节奏、改本地展示态。

## 7. 已修坑 / 交接（详 `.trae/documents/bug_log.md`）
- 后台任务 `exit 4`/`0xC0000142` = 宿主回收；`lib/env.ts` `.env` 路径曾算错→改实测 `process.env.XXX`。
- Windows 盘符大小写让 `vite-tsconfig-paths` 静默失配 → 别名走 Vite 原生 `resolve.alias`、模板禁内联 module script、dev 必须 `host:0.0.0.0`。带 RNG 的 E2E（逃跑/捕获）必须重试到 `finished` 或走 `abandon`。
- 通用：冒烟 `\d` 被吃、等「元素可用」非「存在」、verify 漏 `GROUPS`、同文件同轮多 Edit 互相覆盖。交接 `HANDOFF.md`；接手只读核对，等杰哥排期。

## 8. W6 路线（房间+quota 共享存储迁移，评级 L；#181~#188）
- #181 W6.0 数据模型与迁移 ✅（`Room`+`RoomQuotaDaily`，迁移 `20261113020739_w6_room_storage`）
- #182 W6.1 RoomStorage 异步化 + PG 行版本 CAS ✅（零行为变更，bug_log §60）
- #183 W6.2 room+quota+结算/发奖 收进同一事务边界 ✅（`lib/roomUnitOfWork.ts`：`AsyncLocalStorage` 事务客户端 `roomDb()` + 提交后副作用 `onRoomCommit()` + `withRoomUnit()`=房间锁+事务；结算改事务内 await、失败整包回滚；四类存储层共用 tx；`w62RoomUnit.test.ts` 8 例 + `e2e:w62` 13 项）
- #184 W6.3 房间 `committed` 改 DB 计数 + 结算事务二次 count ✅（`RoomQuotaDaily` 首次启用；`tryHoldQuota` 一条条件 UPDATE，`settleQuota` 二次 count→在途账→每日累计账三段裁决，超限抛 `RoomQuotaExceededError` 整包回滚；`w63RoomQuota.test.ts` 9 例 + `e2e:w63` 13 项）
- #185 W6.4 quota 租约 token + 幂等释放 + TTL≥30min + 补齐 8 处 release/commit 分支 ✅（token 防 ABA；reapExpired 接入 runGlobalSweep；tsc 0 错 / bossQuota 单测 11/11 / 纯逻辑单测 143/143）
- #186 W6.5 序列化归一化 ✅（contributions key 转 number + settled 显式布尔；pvpSettled 初始化/写回/optional 显式布尔已在 W0/W6.1/2 修掉，本次仅剩 contributions 一项）
- #187 W6.6 按接收者裁剪视图 + `RoomState.revision`/`Save.revision` 区分
- #188 W6.7 双实例 E2E 验收（含跨实例 room 送达）
- 收官：核对代理分层→建推 `rollback` tag→归档 bug_log/HANDOFF/任务表→`git add -A`→中文分条 commit→push master→核对 `HEAD==origin/master` 且工作树干净。

## 9. 验收锚点（勿删）
- **P4-2a ✅ / P4-2b ✅ / P4-2c ✅ / P4-2d ✅ / P4-2e ✅** —— P4-2 五阶段全部完成（排期契约 `.trae/documents/P4-2_多人玩法排期_2026-11-07.md`）；P3-2 写操作上移服务端；P4-0 写入并发控制（slotLock 串行，规范 §21）；P4-1 ✅ 顶号与共享野怪（`SESSION_REPLACED` 踢旧设备）。
- 台账：F01/F02 已偿还；**F04** 不写 `SaveData`（等级真值在服务端独立表）；**F14** 双档奖励已偿还；**F16** 六房副本已实现；**F17 单档化已实现并偿还**（第 11 条迁移把 `SCHEMA_VERSION` 10→11）。**下一步**等杰哥排期，接手只读核对。
- 冻结：F15 1v1 零产出（仅供娱乐）；P4-3 C2C **阶段冻结**，**不打算开放交易系统**。
- P5-1 / F10 共享存储迁移评估已完成，已被实施定稿取代；定稿前「不改任何产品代码」的约束自 W0 起解除。
