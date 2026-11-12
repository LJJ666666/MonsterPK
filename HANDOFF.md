# HANDOFF.md — 跨机器交接与接手手册（机器无关）

> **随 git 入库。任意一台机器上第一次打开本仓库，先让 AI 读本文件。**
> 原因：新机器是全新会话，看不到上一次对话；只有写进仓库的东西才能被带过去。
> 配套脚本：`scripts/check_home_env.py`（环境自检，只读）、`scripts/doc_check.py`（文档/记忆验收，只读）、`scripts/sync_memory.py`（记忆镜像同步 / `--check` 校验）。
> **本文件不绑定具体机器、盘符、用户名或提交号**：路径用 `$REPO` 动态取得；当前进度与提交号以 `git log --oneline`、`git ls-remote origin refs/heads/master` 和 `.trae/documents/开发任务优先级_2026-11-04.md` 为准。本文只写「怎么接手」与「不变口径」，会随阶段变化的数字不在这里固化。

## AI 接手必读（优先级最高）

> 读者：任意一台机器上第一次打开本仓库的 AI 编码助手（WorkBuddy 或其他）。
> 目的：动手改代码前，先读懂**为什么这么设计**、**哪些坑不能踩**。

### A. 先读懂意图（Why，比命令重要）

- 项目是浏览器 + Capacitor/Android 的抓怪回合制 RPG（`com.monster.game`）。北极星是**服务端权威 + 实时多人同玩**：客户端只发意图、收全量状态、负责渲染。别为了「省事」把判定搬回前端、加离线降级，或让客户端上报数值当真值。
- 三条不变式：① 每块可变状态只有一个 owner key（个人档 `userId`（F17 单档化后）、战斗态 `battleId`、共享野怪 `areaId`、房间 `roomId`）；② 每处写入只有一个串行化键（`slotLock` / `withRoomLock`）；③ **WS 上行与客户端上报绝不写状态**，个人档唯一写入口是 `commitState()`。P4-2d/e 都把战斗态挂在 `RoomState` 上，没有新增第五个权威源。
- 文档权威源分工（已解耦，别再往一处堆）：`.workbuddy/memory/MEMORY.md` 只放**硬约束 + 索引 + 进度快照**，不复述技术细节；`.trae/documents/` 下的后端规范 / 排期 / 任务表 / bug_log / 未来规划台账才是**权威事实**；`scripts/doc_check.py` 只做结构断言。查数字、查代码符号去权威文档，别靠记忆或推断。改任一侧记忆后跑 `python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 只校验）。
- **产品语义变更（规则、数值、风控策略、离线策略、奖励发放）必须先给评估与方案让杰哥拍板**，不要自行改；工程实现层面的取舍可自行决定。开发阶段没有真实老用户，**不要为兼容留后门、旧链路、开关**，该删直接删干净。
- 以下是**刻意设计，不是 bug，别「顺手修」**：1v1 目前**零产出**（F15 冻结，仅供娱乐）；Boss 讨伐按 **F14 双档奖励**、共斗按 **F16 通关奖励**由服务端发放（客户端无领取入口、伪上报 400）；共斗伤害不写 `BossDamageEvent`、没有共斗伤害榜（F16 只发通关奖）；`pvpSettled` / `coopSettled` 结算幂等；共斗非法意图服务端降级跳过而不是抛异常打崩整间房；`flee` 在入口层 400 `COOP_INTENT_INVALID`；「战力」只是六维之和，不参与任何判定。
- 当前状态：**P0 ~ P4-2e 全部 ✅**，**P4-2 五阶段全部完成（a/b/c/d/e 均已验收）**；台账 **F01/F02 已偿还**（规范 §28）、**F14 Boss 双档奖励已偿还**（规范 §29）、**F16 共斗六房副本已实现并偿还**（规范 §30，世界 Boss 不排期）。**F15 1v1 零产出冻结**（仅供娱乐，未来排位赛再设计）。**F04 召唤师等级 / 徽章 / 成就已实现并偿还**（2026-11-10，规范 §31：人物等级 = 基础 5 + 徽章等级加成，**不写 `SaveData`、不动 `SCHEMA_VERSION`**；等级帽超帽不降级只冻结；捕获不钳等级；宠物经验只来自常规战斗；徽章 / 成就双 Tab 弹窗）。**F17 单档化已实现并偿还**（2026-11-10，规范 §32：删三档、一账号一档、直接进游戏不选档；实测 106 文件横切 `slot`、第 11 条迁移把 `SCHEMA_VERSION` 10→11，**唯一动版本号的阶段**，与 F04 拆开）。**F18 地图内容全阶段已收官**：**F18-a 地图锁已实现并偿还**（规范 §33，服务端权威解锁）、**F18-b 演武堂 ✅**（胜利发 `gym:<locationId>` 徽章）、**F18-c 地图首领 ✅**（独立层、不上榜、每日上限、胜发掉落 + 3×经验/5×金钱、禁捕获）、**F18-d 剧情 ✅**（21 beat 正式文案，占位债务已偿）；验证覆盖含核心循环串联 E2E 与 F18-a/b/c 375px UI 冒烟。**下一步：A 类运行时改造（A1/A2/A4/A5）与 P5-1 W0（接口抽象 + 单实例零行为变更）均已收官验收**（2026-11-12，bug_log §46/§47）；W1 起进入批次 B：**W1 ✅ 2026-11-12 已完成并验收**（provider 切 postgresql、11 条 SQLite 迁移归档、一条 PG 基线 init、`Save.revision` 提列并回填，**产品代码零改动**）。W1 用的是本机自建 PG 16.15 开发实例，正式实例到位只换 `DATABASE_URL`，schema / 迁移链不用再动；**W2 ✅ 2026-11-12 已完成并验收**（`lib/saveCas.ts` + `commitState` 条件更新，409 只由 `updateMany count` 裁决，双进程并发 1 赢 1 409，全量 **48/48 `VERIFY_OK`**，详见 bug_log §52）；**W3 ✅ 2026-11-12 已完成并验收**（本机自建 Redis 5.0.14.1 开发实例；`SET NX PX` 租约锁 + 命名空间 + `AsyncLocalStorage` 重入旁路 + watchdog 续租 + Lua token 安全释放；`REDIS_URL` 配了连不上即拒绝启动、不静默降级；`e2e:w3` 23 项含预占账号锁证明写路径跨进程互斥，全量 **49/49 `VERIFY_OK`**，详见 bug_log §54）；W4~W8 完成前仍不开第二实例做常规服务；接手先做只读核对。前端 dev 端口可用 `MPK_FRONT_PORT` 随时更换（默认 5173，本机 5174），启动服务与跑 verify 须在同一 shell 设同一个值。**P4-3（交易 / 赠送）当前冻结**：玩家↔玩家 C2C 所有权转移，11-09 口径「当前所有资产一律不可交易」，暂无可交付标的，不是删除。**编号口径**：P4-3 只指交易 / 赠送，排期文档 §7 旧文曾误写成周期结算，已修正。硬门槛：野怪 / 房间 / 锁都是单进程内存态，P5-1 多实例部署前统一迁共享存储。**实施层评估（只读稿，供排期拍板）见 `.trae/documents/P5-1_F10_共享存储迁移评估_2026-11-11.md`**：共 8 类进程内状态 + 6 个耦合点，评级 L、建议 8 阶段（1.1 完成前不开第二实例）；该评估修正了台账 F10「只换 adapter」的乐观口径（`revision` 非 DB 独立列、`RoomStorage` 同步且依赖对象引用、两个周期定时器每进程各跑一遍）。**实施设计定稿（2026-11-11，杰哥已拍板选型 B、工作顺序已排）见 `.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`**：实施以定稿为准，上面的评估稿降为初稿并挂 12 处勘误指针（三组独立后端架构专家只读复核，一致「需修正后可用」）。硬结论：切 Postgres 必须归档 11 条 SQLite 方言迁移并重置为一条 PG 基线，`schema.prisma:2` 注释「改 provider 即可」是错的，不存在「第 12 条迁移」；CAS 的 409 只能由 `updateMany count` 裁决；房间 quota `committed` 须改 DB 计数；广播是两频道 + 各实例本地裁剪。**选型 B：Postgres 唯一真值 + Redis 锁/租约/TTL/pub-sub/可重建临时态，Redis 不存任何影响权益的真值**。顺序 W0~W9 四批，W0 接口抽象与单实例零行为变更**无需外部资源、可立即开工**；W2 已完成（跨实例存档 CAS 可用），但房间 / 野怪 / 定时器 / 广播未迁共享态，W3~W8 完成前不开第二实例做常规服务。原「6 项前置输入」已收敛为**仅外部资源一类**（PG/Redis 实例与凭据、域名与 HTTPS、停机窗口），设计层面无待决项；W1 的 PG、W3 的 Redis 均已由本地开发实例解决（见 bug_log §51 / §54），W4/W5 复用同一 Redis，W9 需域名 / HTTPS / 反代。

### B. 最容易踩的坑（含后果与正确做法）

| 坑 | 为什么 / 后果 | 正确做法 |
|---|---|---|
| clone 完直接 `npm run dev` | `backend/.env`、`node_modules` 都被 gitignore（W1 起数据库是外部 Postgres，不再是仓库内的 `dev.db`），新机器 clone 后**根本不存在** | 按第 3 节：`cp backend/.env.example backend/.env` → 换 `JWT_SECRET` → `npx prisma migrate deploy` + `npx prisma generate` → 前后端各 `npm install` |
| 沿用模板 `JWT_SECRET`，或把 `.env` / `*.db` 加进 git | 模板值是 `change-me-in-prod-...`，鉴权形同虚设；入库会泄密钥、污染别人的库 | 随机长字符串；保持忽略规则。改配置相关代码后**必须实测 `process.env.XXX` 有值**——`lib/env.ts` 的 `.env` 路径曾算错，`JWT_SECRET` 长期回落硬编码默认密钥 |
| 全新空库直接点测试菜单 | 管理员只在服务端判定，未授权使用会被反作弊**封号** | 重新注册账号并 `cd backend && npm run admin -- grant <名>`，绝不写死用户名 |
| 用 pnpm 装依赖，或把两套测试混跑 | 锁文件是 npm；前端 vitest 只收 `src/**/*.test.{ts,tsx}`，后端 `node:test` 在 `backend/tests/`，混跑必挂 | 分别跑；整体验收首选 `npm run verify`（唯一权威入口，阶段数与用例数以脚本输出为准） |
| 改 Prisma schema 前没停 3001 | 迁移链会被打断（Windows 下 DLL 文件锁） | 先停后端再改 schema；改完 `migrate deploy` + `generate` |
| 把项目放 exFAT U 盘 / 中文 / 空格 / 盘根目录 | 出现过「大小一致但内容不同」的静默单比特损坏，检索工具也会失效 | NTFS 盘、非根目录、无空格、尽量纯英文 |
| 后台任务报 `exit 4` / `0xC0000142` / `1073807364` 就去查代码 | 这是**宿主回收进程**，不是程序 bug | 先探活 5173 / 3001，无 LISTEN 再重启双服务；换会话后服务**不会自动恢复** |
| 全局代理环境下 `git fetch` 报 502 / `schannel: server closed abruptly` | 多半是 git 默认 HTTP/2 与代理不兼容，不是断网 | `git config --local http.version HTTP/1.1`（只写本机 `.git/config`，不入库）；先拿 GitHub API 或 `git ls-remote` 确认远端真实 HEAD（bug_log §33） |
| 用 `curl http://127.0.0.1:5173/` 探活得到 502 | 全局 `HTTP(S)_PROXY` 连 localhost 也拦，是**假失败** | `curl --noproxy '*' ...`、用 Python socket 直连（自检脚本即如此），或看 `netstat` |
| 改 `src/game/data.ts` 漏了 `};` | 后续 `export` 会落进对象字面量内部，报 `Unexpected keyword 'export'` | 改完立刻 `npm run check` |
| 新增持久化字段不升版本 | 老档 migrate 会丢字段 | 递增 `SCHEMA_VERSION`（同时是 persist `version`）并补 migrate 分支，后端 `EXPECTED_SAVE_VERSION` 同步改 |
| 用 `crypto.randomUUID()` / 靠类型收窄判别联合 | 旧 WebView 没有该 API；项目 `strict:false`、`noUnusedLocals:false`，tsc 不收窄 | 统一用 `rules.ts` 的 `uuid()`；判别用 `'code' in result`；所有 Hook 必须在组件顶层 |
| 不看风格就改前端、引 CDN | 视觉规范在 `.impeccable.md`（复古像素 / 野外手记，内联 SVG、零 CDN） | 移动端优先：375px 实测 `scrollWidth`，弹窗小 `max-w` + `overflow-auto` + `max-h` |
| 提交跳过流程 | 出问题没有回滚点，或误把密钥推上远端 | 验收 → 建 `rollback-YYYYMMDD-<阶段>` tag 并推远端 → `git add -A` 确认无 `.env` / `*.db` → 中文分条 commit（末尾写验收数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净 |

> 第 7 节是完整坑清单；**新增坑同时写进本节 / §7 与 `.trae/documents/bug_log.md`**。

### C. 落地自检（照抄，输出不符就别开工）

```bash
export REPO=$(git rev-parse --show-toplevel)   # 任意机器 / 任意盘符通用
cd "$REPO"
git fetch --all --prune                        # 502 见 B 节 HTTP/1.1 那条
git ls-remote origin refs/heads/master         # 与本地 HEAD 比对，别信缓存的 origin/master
git status --short                             # 必须为空
python scripts/check_home_env.py               # ENV_CHECK_OK（[WARN] 按提示处理）
python scripts/doc_check.py                    # DOC_CHECK_OK
python scripts/sync_memory.py --check          # 镜像 [一致]
npm run verify                                 # VERIFY_OK（阶段数与数字以输出为准）
```

起服务：前端 `npm run dev`（`vite.config.ts` 已固定 `host: '0.0.0.0'` + `strictPort`，端口读 `MPK_FRONT_PORT`，默认 5173）；后端 `cd backend && npm run dev`（3001）。**端口随时可换**：本机 5173 被微信等程序占用时，在**同一个 shell**里设 `MPK_FRONT_PORT=5174` 再起前端与跑 `verify`（`scripts/lib/devConfig.mjs` 是脚本侧单一真值源，backend E2E 与 CORS 默认值读同名 env），并把 `backend/.env` 的 `CORS_ORIGIN` 加上新端口的 origin；不要在命令行再传 `--port`，那会覆盖配置。用户级记忆 `C:\Users\<用户名>\.workbuddy\`（称呼与沟通口径）不随 git 走；项目级 `.workbuddy/memory/`、`.trae/documents/`、`HANDOFF.md` 都随 git 走。**后端依赖外部 Postgres**：`cd backend && npm run dev` 前先确认 `DATABASE_URL` 指向的实例在线；本机自建实例必须以受管前台进程启动（`pg_ctl start` 的 detach 守护进程会被宿主回收）。**W3 起还依赖 Redis**：`REDIS_URL` 配了就必须 PING 通（否则启动失败，不静默降级）；不配则保持进程内锁、**仅允许单实例**。本机 Redis 同样用受管前台进程：`redis-server.exe --port 6379 --bind 127.0.0.1 --save "" --appendonly no --protected-mode no`。

> **验收留痕（2026-11-12，bug_log §48）**：`verify` 每轮把 47 个阶段的完整 stdout/stderr 写到 `.verify-logs/<runId>/`（轮末 `index.json`，`--log-dir=xxx` 可固定目录），失败阶段另在 `.verify-report.json` 留 `outHead` + `outTail`；E2E 断言失败会附印最近 5 条 HTTP，未捕获异常由 `harness.mjs` 顶层 handler 打完整堆栈。**偶发红先看日志再改代码，不要直接重跑掩盖**。别名由 `vite.config.ts` 的 Vite 原生 `resolve.alias` 提供（不再依赖 `vite-tsconfig-paths`），`index.html` 不含内联 module script —— 这两处是 Windows 盘符大小写导致跨轮假红的根因，勿回退。**另一类偶发红已定位并修复**：服务端逃跑 / 捕获有成功率，E2E 必须重试到终态（复用 `fleeUntilDone`），否则 `e2e:f18c` 会因约 25% 的逃跑失败连锁 5 项假红（bug_log §49）；新增玩法分支写 E2E 前先查既有 helper。

## 0. 结论与两种场景

**代码、全部产品文档、项目级记忆都已推到 `origin/master`。** 换机器 `git clone` 后项目记忆会自动注入新会话；只有「用户级记忆 + 本机专属配置」需要补。

| 场景 | 要做什么 |
|---|---|
| **A. 同一台机器续开发** | 基本什么都不用做：项目目录、用户级记忆都在。先 `git fetch` 拉最新，再探活 5173 / 3001，没起就重启双服务。 |
| **B. 新机器首次接手（本手册主线）** | 完整走第 2~6 节。 |

## 1. 仓库里有什么 / 不随 git 走什么

- 远端 `https://github.com/LJJ666666/MonsterPK.git`，分支 `master`。**提交号不在此固化**，用 `git log --oneline -10` 和 `git ls-remote origin refs/heads/master` 看当前事实。
- 回滚点 tag 命名 `rollback-YYYYMMDD-<阶段>`，成对建在阶段前后并推远端；回滚用 `git reset --hard <tag>` 或 `git revert <commit>`。
- **提交规矩（11-07 杰哥定，每次固定执行、不用再问）**：验收通过 → 建并推回滚 tag → 确认无 `.env` / `*.db` 入库 → 中文分条 commit（末尾写验收数字）→ `git push origin master` → 核对 `HEAD == origin/master` 且工作树干净。
- **随 git 走**：全部源码、`backend/`、`.trae/documents/`（PRD / 路线图 / 任务表 / bug_log / 后端规范 / 项目记忆镜像）、`.workbuddy/memory/`（MEMORY.md + 每日日志）、`scripts/`、`.impeccable.md`、`apk_build_guide.md`、锁文件、`HANDOFF.md`。
- **不随 git 走，新机器必须补**：`backend/.env`、`backend/prisma/dev.db`、`save_data.json`、`node_modules/`（前后端各一份）、`.vtmp/`、`C:\Users\<用户名>\.workbuddy\`（用户级记忆）。

## 2. 第 1 步：clone / 拉取（路径有硬约束）

路径必须满足：**NTFS 盘、不能是盘根目录、不能含空格、尽量纯英文**。盘符与目录名由本机决定，别照抄任何一台机器的绝对路径。

```bash
git clone https://github.com/LJJ666666/MonsterPK.git <目标绝对路径>
cd <目标绝对路径>
export REPO=$(git rev-parse --show-toplevel)
git log -3 --oneline
git status --short          # 应为空
```

> 若 clone 报 401/403：GitHub HTTPS 需要凭据（PAT 或凭据管理器 / `gh auth login`），不能用账号密码。
> **不要**把项目放到 exFAT U 盘上——卷健康 Warning，历史上出现过「大小一致但内容不同」的静默单比特损坏；中文目录还会让部分文件检索工具失效。
> 已有仓库的机器跳过 clone，直接 `git fetch --all --prune` + `git merge --ff-only origin/master`。

## 3. 第 2 步：重建环境与本机专属配置（最容易漏）

### 3.1 后端配置与数据库

`dev.db` 不入库。若新机器是**全新空库**：账号要重新注册，管理员要重新授权；若本机已有 `.env` / `dev.db`（场景 A 或曾经建过），**跳过重建，别覆盖**。

```bash
cd "$REPO/backend"
cp .env.example .env          # 仅首次
```

编辑 `backend/.env`：

- `JWT_SECRET` **必须换成随机长字符串**（模板里是 `change-me-in-prod-...`，别直接用）
- `ADMIN_USERNAMES` 可填你的用户名（逗号分隔），或留空之后用 `grant` 命令授权
- `DATABASE_URL="postgresql://mpk@127.0.0.1:5432/monsterpk?schema=public"`（W1 起是外部 Postgres，不再是仓库内 `dev.db`）、`PORT=3001`、`CORS_ORIGIN` 按实际前端端口配
- `REDIS_URL="redis://127.0.0.1:6379"`（W3 起；**不配 = 单实例进程内锁**，配了必须可达，否则后端拒绝启动）

```bash
# W1/W3 起：先启动 Postgres + Redis 并确认 backend/.env 的 DATABASE_URL / REDIS_URL 可连（本机实例见 bug_log §51 / §54）
npx prisma migrate deploy       # 按 PG 基线 init 建表
npx prisma generate             # 生成 Prisma Client
# W2 起：npm run e2e:w2 会临时拉起 :3002 做双进程并发验收
# W3 起：npm run e2e:w3 同样临时拉起 :3002，并额外起 :3003 验证错误 REDIS_URL 拒绝启动
#   （node --import tsx 单进程，收尾自动关闭并释放端口）
```

> **`npm install` 不会自动 `prisma generate`**：只要拉到 `schema.prisma` 或迁移有变化，
> 就要再跑一次 `npx prisma generate`，否则后端 `tsc` 会报新字段 / 新模型不存在（bug_log §33.4）。

### 3.2 依赖（项目用 npm，别混 pnpm）

**每次拉到 `package.json` / lock 有变化都要重装**，`node_modules` 不入库：

```bash
cd "$REPO" && npm install
cd "$REPO/backend" && npm install
```

### 3.3 起双服务（两个终端，或让 WorkBuddy 开后台任务）

```bash
# 终端 1
cd "$REPO" && npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
# 终端 2
cd "$REPO/backend" && npm run dev
```

探活（全局代理环境必须绕过代理，否则是假 502）：

```bash
curl -s --noproxy '*' -o /dev/null -w "front:%{http_code}\n" http://127.0.0.1:5173/
curl -s --noproxy '*' -o /dev/null -w "back:%{http_code}\n"  http://127.0.0.1:3001/api/health
```

### 3.4 注册账号并授权管理员

浏览器打开 `http://localhost:5173` 注册账号，然后：

```bash
cd "$REPO/backend" && npm run admin -- grant <你的用户名>
```

> ⚠️ **不授权就用测试菜单会被风控封号**，这是设计不是 bug。管理员身份只在服务端判定（`User.role='admin'` 或 `.env` 的 `ADMIN_USERNAMES`），前端 `useIsAdmin()` 只是 UI 收敛。
> `save_data.json` 不存在时 dev/preview 的 `/api/save` 返回 404 属正常。

## 4. 第 3 步：记忆恢复（三层，别搞混）

| 层 | 存放位置 | 随 git？ | 换机器怎么办 |
|---|---|---|---|
| 云端 profile / 历史对话 | WorkBuddy 账号 | 跟账号 | **用同一个 WorkBuddy 账号登录**即自动注入；要找回旧讨论用 `conversation_search` |
| 项目级工作记忆 | `<项目>/.workbuddy/memory/` + `.trae/documents/` | ✅ | clone 后自动在，**用 WorkBuddy 打开该项目目录**即注入 |
| 用户级长期记忆 | `C:\Users\<用户名>\.workbuddy\` | ❌ | 手动搬下面 4 个文件，或用第 5 节话术兜底 |

用户级 4 个文件（`<用户名>` 与 `user-*-personal` 目录名以**本机实际生成**的为准）：

```
C:\Users\<用户名>\.workbuddy\MEMORY.md
C:\Users\<用户名>\.workbuddy\IDENTITY.md
C:\Users\<用户名>\.workbuddy\SOUL.md
C:\Users\<用户名>\.workbuddy\user-*-personal\MEMORY.md
```

搬运方式：网盘 / 文件传输 / 公司云盘均可，**不要用 exFAT U 盘**。若只能用 U 盘，传前后各算一次 `sha256sum` 比对，防止静默损坏。目标机器放到对应用户目录，**把内容合并进去，别整文件覆盖**（目标机器可能已有其他项目偏好）。两边记忆镜像改任一侧后跑 `python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 只校验）。

> **兜底**：就算这 4 个文件没带，第 5 节话术里已写全称呼、语气和硬约束，新会话照样能进入状态。

## 5. 第 4 步：打开 WorkBuddy，第一段话术（直接复制）

> 先在 WorkBuddy 里把**工作目录切换 / 打开到本项目目录**，再发下面这段话。

```
杰哥继续开发 MonsterPK。先别动手改代码，按下面顺序做：

1. 读 HANDOFF.md、.workbuddy/memory/MEMORY.md 与最新一天的日志、
   .trae/documents/开发任务优先级_2026-11-04.md。
2. 称呼我「杰哥」，你自称「tx」。中文回复、结论先行、一轮多问就分点逐条答；
   给可复现证据（命令输出、哈希、日志原文），不接受「应该是因为」；
   不要半成品，做不到或不确定就直接说。
3. 如果本机 ~/.workbuddy 下没有用户级记忆，请把第 2 条的偏好写进本机用户级
   MEMORY.md，之后长期遵守。
4. 复述三件事，确认记忆已加载：
   ① 当前做到哪一步、下一步候选是什么（等杰哥排期，别自己开工）；
   ② SCHEMA_VERSION 与后端 EXPECTED_SAVE_VERSION 为什么必须同步递增；
   ③ 改系统时间获取资源的处置口径（是否封号）。
5. 先 git fetch --all --prune 并核对 HEAD == origin/master；再探活双服务
   （5173 / 3001，注意代理环境用 curl --noproxy '*'），没起就按 HANDOFF.md 第 3 节启动。
6. 跑 python scripts/check_home_env.py、python scripts/doc_check.py、
   python scripts/sync_memory.py --check，把输出贴给我。

以上全部只做只读检查。不要重跑任何已完成任务，也不要擅自开始下一阶段，等我排期。
```

## 6. 验收清单

**首选：一条命令跑完全部（自动清理测试账号）**

```bash
cd "$REPO" && npm run verify        # 期望 VERIFY_OK
```

阶段数、分项用例数会随阶段增长，**以脚本输出为准**，不要照抄任何历史数字；分项数字见任务表时间线与当日日志。常用子集：

```bash
npm run verify:quick          # 只跑 check + unit，不需要服务（改完代码先跑这个）
npm run verify:unit           # 只跑单测
npm run verify:e2e            # 只跑 E2E 组
npm run verify:hardening      # 只跑对抗套件
npm run verify:smoke          # 只跑浏览器冒烟
npm run verify -- --only=check,unit     # 任意分组组合
npm run verify -- --skip=smoke          # 跳过浏览器冒烟
npm run verify -- --strict              # CI：服务没起视为失败
npm run verify -- --no-clean            # 保留测试账号便于排查
cd backend && npm run clean:e2e -- --dry   # 看有多少历史测试账号待清
```

不需要服务的分项（便于定位）：

```bash
python scripts/check_home_env.py          # ENV_CHECK_OK（[WARN] 按提示处理）
python scripts/doc_check.py               # DOC_CHECK_OK
python scripts/sync_memory.py --check     # [一致] 且两侧 sha256 相同
npm run check && npm test                 # 前端类型检查 + vitest
cd backend && npm run check && npm test   # 后端类型检查 + node:test
cd backend && npm run check:content       # 内容表与 src/game/data.ts 一致
```

> 测试账号不会累积：`e2e:hardening` 自清理，`verify` 结束统一清一次，只删测试前缀，**永不删 admin**。
> 浏览器打开 5173：能注册登录、Start 页显示「实时通道已连接」（证明 WS 握手与 hello 成功）。
> 若系统没有 `python` 命令，用 WorkBuddy 内置 Python 的绝对路径（`~/.workbuddy/binaries/python/versions/<版本>/python.exe`），或直接让 WorkBuddy 执行脚本。
> **新增 verify 阶段要改两处**（`STAGES` + `GROUPS`），漏 `GROUPS` 会静默少跑（bug_log §32.5）。

## 7. 坑清单（都真踩过）

- exFAT U 盘卷健康 Warning、会静默写坏数据；重要文件别放，也别用它传记忆文件。
- 项目路径须 NTFS、非盘根、无空格、尽量纯英文；中文目录会让 `Glob` 检索失效（改用 `Grep` / PowerShell）。
- **关机或换会话后后台 dev server 不会自动恢复**，新会话先探活再重启。
- **git 默认 HTTP/2 与本机代理不兼容**：`fetch` 报 `schannel: server closed abruptly` / `CONNECT tunnel failed 502`，用 `git config --local http.version HTTP/1.1` 解决；诊断时别一次改两个变量（bug_log §33.1）。
- **全局 `HTTP(S)_PROXY` 连 `127.0.0.1` 也拦**，`curl` 探活得到假 502：用 `curl --noproxy '*'`、Python socket 直连或 `netstat`（bug_log §33.2）。
- `backend/src/lib/env.ts` 的 `.env` 路径曾算错，导致 `JWT_SECRET` 长期回落硬编码默认密钥；改配置相关代码必须实测 `process.env.XXX` 有值。
- 改 Prisma schema 前先停 :3001（Windows 下 `query_engine-windows.dll.node` 文件锁）。
- 新增持久化字段 → 递增 `SCHEMA_VERSION` + persist `version` + migrate 分支，后端 `EXPECTED_SAVE_VERSION` 同步改，否则新档全被拒；**两处当前值以 `src/stores/saveVersion.ts` 与 `backend/src/lib/saveValidator.ts` 为准**（F17 单档化已把 10→11，别照抄历史数字）。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一用 `rules.ts` 的 `uuid()`；所有 Hook 必须在组件顶层。
- `strict:false` 下 `if (!parsed.ok)` 判别联合收窄会失效，改用 `'code' in parsed`。
- 同一文件同一轮发多条 Edit 会互相覆盖：每个文件每轮只发一条，改完立刻校验；批量改动用一次性精确替换脚本。
- `.vtmp/` 被 gitignore，一次性脚本不入库；需要长期复用的固化到 `scripts/` 且 ROOT 动态推导。
- 涉及服务端 RNG 的 E2E 必须**重复跑**，单次全绿不代表成功/失败两条随机分支都覆盖（bug_log §17）。
- 文档别写死本机盘符 / 提交号 / 阶段用例数：这些值换机器或加阶段就过期，写「以命令输出为准」并给索引。
- **拉代码后只跑 `npm install` 不够**：Prisma schema 变了要 `npx prisma generate`，否则 `tsc`
  报 `sessionVersion` / `bossDamageEvent` 不存在；`up to date` 具有误导性（bug_log §33.4）。
- `core.autocrlf=true` 会把生成物检出成 CRLF，按字节比对的 `check:content` 会假报「已过期」；
  `gen-content.ts` 已做换行规范化（真实漂移仍会拦），别回退这段（bug_log §33.4）。

## 8. 当前进度快照

**P0 五项 ✅ / P1-1 ✅ / P1-1b ✅ / P1-2 ✅ / P1-3 ✅ / P2-1 ✅ / P2-2 ✅ / P3-1a·b·c ✅ / P3-2 ✅ / P4-0 ✅ / P4-1 ✅ / P4-2a·b·c·d·e ✅（五阶段全部完成）/ 台账 F01·F02 ✅ + F14 ✅ + F16 ✅（2026-11-09 偿还）+ F04 ✅（2026-11-10 偿还）。** **F15 1v1 零产出冻结**（仅供娱乐，未来排位赛再设计榜单/奖励）；**F16 共斗 6 房副本已实现并偿还**（规范 §30，世界 Boss 不排期）。**F17 单档化已实现并偿还**（2026-11-10，规范 §32，第 11 条迁移把 `SCHEMA_VERSION` 10→11）；**F18 地图内容 a/b/c/d 全部 ✅**（地图锁 / 演武堂 / 地图首领 / 正式剧情 21 beat），核心循环串联 E2E 与 F18-a/b/c 375px 冒烟已补齐；F04 已偿还，等级真值在服务端独立表、**不动 `SCHEMA_VERSION`**；**下一步：等杰哥排期，接手只做只读核对**；**P4-3（交易 / 赠送）当前冻结**（所有资产不可交易，无可交付标的）。硬门槛：野怪 / 房间 / 锁均为单进程内存态，P5-1 前统一迁共享存储。完整时间线见任务表「进度记录」。

北极星方向：**服务端权威 + WebSocket 实时多人同玩**，客户端瘦终端只发意图、收状态、渲染；本地存档是 P3/P5 前的过渡桥接。

反作弊口径：测试菜单级数据只放行管理员；他人改档一律拦截 + 封号弹窗 + 强制登出；**改系统时间不封号，只要求「不生效」**。权威摘要不符 / 增量不符一律 400 + 中文原因，不封号。

> **11-09 补充（跨机器必看）**：`npm install` 只装依赖，`npx prisma generate` 只重生成 Client，
> **都不会给已有 `dev.db` 加列/加表**。换机器或拉到 schema 变更后必须再跑
> `cd backend && npx prisma migrate deploy`；否则注册接口直接 `P2022`，
> `verify --strict` 会出现 20+ 个连锁假红（bug_log §34）。改 schema 前记得先停 :3001 释放 Prisma DLL。

> **接手第一件事（跨机器通用）**：`git fetch && git log --oneline -5`，
> 对照本机 `git log --oneline -5` 与 `git status -sb`。若本机存在**未推送的本地提交**（ahead > 0），
> 先确认远端是否需要它再开工；本机提交即使未推送也不会丢，但新机器拉取不到，别误以为功能没做。

## 验收锚点（doc_check 一致性，勿删）
- F04 不动 `SCHEMA_VERSION` 语义、不写 `SaveData`；F01/F02 已偿还；F17 单档化已实现并偿还；P4-3 C2C（交易/赠送）不打算开放交易系统（阶段冻结）。
