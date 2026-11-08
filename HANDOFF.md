# 跨机器交接手册（公司 ⇄ 家里）

> **这份文件随 git 入库。换机器后打开 WorkBuddy 的第一段话，先让它读本文件。**
> 原因：新机器是全新会话，看不到上一次对话；只有写进仓库的东西才能被带过去。
> 配套脚本：`scripts/check_home_env.py`（环境自检，只读）、`scripts/doc_check.py`（文档/记忆验收，只读）。
> **下方「AI 接手必读」是 2026-11-09 最新增量，优先级高于本文其余内容；第 1 节的提交号与第 8 节的进度快照写于 11-06，仅作历史，勿当现状。**

## AI 接手必读（2026-11-09 家→公司，优先于下文）

> 读者：公司机器上第一次打开本仓库的 AI 编码助手（WorkBuddy 或其他）。
> 目的：动手改代码前，先读懂**为什么这么设计**、**哪些坑不能踩**。本文其余章节是 11-06 写的「公司→家」流程，方向与数据偏旧，只作操作参考。

### A. 先读懂意图（Why，比命令重要）

- 项目是浏览器 + Capacitor/Android 的抓怪回合制 RPG（`com.monster.game`）。北极星是**服务端权威 + 实时多人同玩**：客户端只发意图、收全量状态、负责渲染。别为了「省事」把判定搬回前端、加离线降级，或让客户端上报数值当真值。
- 三条不变式：① 每块可变状态只有一个 owner key（个人档 `userId:slot`、战斗态 `battleId`、共享野怪 `areaId`、房间 `roomId`）；② 每处写入只有一个串行化键（`slotLock` / `withRoomLock`）；③ **WS 上行与客户端上报绝不写状态**，个人档唯一写入口是 `commitState()`。P4-2d/e 都把战斗态挂在 `RoomState` 上，没有新增第五个权威源。
- 文档权威源分工（刚做过解耦，别再往一处堆）：`.workbuddy/memory/MEMORY.md` 只放**硬约束 + 索引 + 进度快照**，不复述技术细节；`.trae/documents/` 下的后端规范 / 排期 / 任务表 / bug_log / 未来规划台账才是**权威事实**；`scripts/doc_check.py` 只做结构断言。查数字、查代码符号去权威文档，别靠记忆或推断。
- **产品语义变更（规则、数值、风控策略、离线策略、奖励发放）必须先给评估与方案让杰哥拍板**，不要自行改；工程实现层面的取舍可自行决定。开发阶段没有真实老用户，**不要为兼容留后门、旧链路、开关**，该删直接删干净。
- 以下是**刻意设计，不是 bug，别「顺手修」**：Boss 讨伐 / 共斗 / 1v1 目前都**不发奖励**（奖励、掉落、剧情门槛登记在台账 F09/F14/F15/F16 待设计）；共斗伤害不写 `BossDamageEvent`、没有共斗榜（F16）；`s.rewards=null`；`pvpSettled` / `coopSettled` 结算幂等；共斗非法意图服务端降级跳过而不是抛异常打崩整间房；`flee` 在入口层 400 `COOP_INTENT_INVALID`；「战力」只是六维之和，不参与任何判定。
- 当前状态：**P4-2 a/b/c/d/e 五阶段全部 ✅**，`master` 为 `70ca1ee`（以 `git ls-remote origin refs/heads/master` 为准），工作树干净。下一步候选：P4-3 交易 / 赠送，或偿还台账 F01/F02/F04/F09/F14/F15/F16。开新阶段前先读排期与任务表，别自己发明阶段号。

### B. 最容易踩的坑（含后果与正确做法）

| 坑 | 为什么 / 后果 | 正确做法 |
|---|---|---|
| clone 完直接 `npm run dev` | `backend/.env`、`backend/prisma/dev.db`、`node_modules` 都被 gitignore，公司 clone 后**根本不存在** | 按第 3 节：`cp backend/.env.example backend/.env` → 换 `JWT_SECRET` → `npx prisma migrate deploy` + `npx prisma generate` → 前后端各 `npm install` |
| 沿用模板 `JWT_SECRET`，或把 `.env` / `*.db` 加进 git | 模板值是 `change-me-in-prod-...`，鉴权形同虚设；入库会泄密钥、污染别人的库 | 随机长字符串；保持忽略规则。改配置相关代码后**必须实测 `process.env.XXX` 有值**——`lib/env.ts` 的 `.env` 路径曾算错，`JWT_SECRET` 长期回落硬编码默认密钥 |
| 全新空库直接点测试菜单 | 管理员只在服务端判定，未授权使用会被反作弊**封号** | 重新注册账号并 `cd backend && npm run admin -- grant <名>`，绝不写死用户名 |
| 用 pnpm 装依赖，或把两套测试混跑 | 锁文件是 npm；前端 vitest 只收 `src/**/*.test.{ts,tsx}`，后端 `node:test` 在 `backend/tests/`，混跑必挂 | 分别跑；整体验收首选 `npm run verify`（29 阶段、约 90~120s、`VERIFY_OK`） |
| 改 Prisma schema 前没停 3001 | 迁移链会被打断 | 先停后端再改 schema；改完 `migrate deploy` + `generate` |
| 把项目放 exFAT U 盘 / 中文 / 空格 / 盘根目录 | 出现过「大小一致但内容不同」的静默单比特损坏，检索工具也会失效 | NTFS 盘、非根目录、无空格、尽量纯英文 |
| 后台任务报 `exit 4` / `0xC0000142` / `1073807364` 就去查代码 | 这是**宿主回收进程**，不是程序 bug | 先 `curl` 探活 5173 / 3001，无 LISTEN 再重启双服务；交接后服务**不会自动恢复** |
| 改 `src/game/data.ts` 漏了 `};` | 后续 `export` 会落进对象字面量内部，报 `Unexpected keyword 'export'` | 改完立刻 `npm run check` |
| 新增持久化字段不升版本 | 老档 migrate 会丢字段 | 递增 `SCHEMA_VERSION`（同时是 persist `version`）并补 migrate 分支，后端 `EXPECTED_SAVE_VERSION` 同步改 |
| 用 `crypto.randomUUID()` / 靠类型收窄判别联合 | 旧 WebView 没有该 API；项目 `strict:false`、`noUnusedLocals:false`，tsc 不收窄 | 统一用 `rules.ts` 的 `uuid()`；判别用 `'code' in result`；所有 Hook 必须在组件顶层 |
| 不看风格就改前端、引 CDN | 视觉规范在 `.impeccable.md`（复古像素 / 野外手记，内联 SVG、零 CDN） | 移动端优先：375px 实测 `scrollWidth`，弹窗小 `max-w` + `overflow-auto` + `max-h` |
| 提交跳过流程 | 出问题没有回滚点，或误把密钥推上远端 | 验收 → 建 `rollback-YYYYMMDD-<阶段>` tag 并推远端 → `git add -A` 确认无 `.env` / `*.db` → 中文分条 commit（末尾写验收数字）→ push master → 核对 `HEAD == origin/master` 且工作树干净 |

> 下文第 7 节是 11-06 版坑清单，保留作历史；**新增坑以本节与 `.trae/documents/bug_log.md` 为准**。

### C. 落地自检（照抄，输出不符就别开工）

```bash
git status --short                      # 必须为空
git log -3 --oneline                    # 应能看到 70ca1ee / cc4fe2b
python scripts/check_home_env.py        # ENV_CHECK_OK（[WARN] 按提示处理）
python scripts/doc_check.py             # DOC_CHECK_OK
curl -s -o /dev/null -w "%{http_code}" http://localhost:3001/api/health   # 200
npm run verify                          # VERIFY_OK
```

起服务：前端 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`；后端 `cd backend && npm run dev`（3001）。用户级记忆 `C:\Users\<用户名>\.workbuddy\`（称呼与沟通口径）不随 git 走；项目级 `.workbuddy/memory/`、`.trae/documents/`、`HANDOFF.md` 都随 git 走。

## 0. 结论与两种场景

**代码、全部产品文档、项目级记忆都已推到 `origin/master`。** 家里 `git clone` 后，项目记忆会自动注入新会话；只有「用户级记忆 + 本机专属配置」需要手动补。按第 2~6 节做即可恢复到和现在一样的工作状态。

| 场景 | 要做什么 |
|---|---|
| **A. 同一台电脑搬回家** | 基本什么都不用做：项目目录、用户级记忆、服务进程都还在。连网后 `curl` 探活 5173 / 3001，没起就重启双服务即可。 |
| **B. 家里另一台电脑（本手册主线）** | 完整走第 2~6 节。 |

## 1. 公司侧已完成的收尾（不用再做）

- 远端 `https://github.com/LJJ666666/MonsterPK.git`，`master` 指向 `bbb1853`（以 `git ls-remote origin refs/heads/master` 为准）。
- 已推送的 commit：
  - `fe159eb` 回滚点：P0~P1-3 全量代码 + 文档 + 记忆（65 文件）
  - `bb04998` P2-1 WebSocket 接入与鉴权（20 文件）
  - `6f78d85` 推送记录文档
  - `834a55a` HANDOFF 手册与跨机器自检脚本
  - `2f2c8b7` P2-2 服务端 GameSession 在线权威态（27 文件，+1595/−260）
  - `616acbe` 提交规矩固化与 P2-2 推送记录回填
  - `bbb1853` P3-1a/P3-1b 服务端战斗内核与权威战斗态（25 文件，+2595/−57）
- 回滚点 tag：`rollback-20261107-pre-p22` → `834a55a`、`rollback-20261107-post-p22` → `2f2c8b7`、`rollback-20261107-pre-p31` → `616acbe`（均已推到远端）。
- **提交规矩（11-07 杰哥定，每次固定执行、不用再问）**：验收通过 → 先建回滚点 `git tag -a rollback-YYYYMMDD-<阶段> <当前HEAD>` 并 `git push origin <tag>` → 确认无 `.env` / `*.db` 入库 → commit → `git push origin master` → 核对 `HEAD == origin/master` 且工作树干净。回滚用 `git reset --hard <tag>` 或 `git revert <commit>`。
- **随 git 走**：全部源码、`backend/`、`.trae/documents/`（PRD / 路线图 / 任务表 / bug_log / 后端规范 / 项目记忆镜像）、`.workbuddy/memory/`（MEMORY.md + 每日日志）、`scripts/`、`.impeccable.md`、`apk_build_guide.md`、锁文件、`HANDOFF.md`。
- **不随 git 走，家里必须补**：`backend/.env`、`backend/prisma/dev.db`、`save_data.json`、`node_modules/`（前后端各一份）、`.vtmp/`、`C:\Users\<用户名>\.workbuddy\`（用户级记忆）。

## 2. 第 1 步：clone（路径有硬约束）

路径必须满足：**NTFS 盘、不能是盘根目录、不能含空格、尽量纯英文**。
推荐 `E:\Six\MonsterPK` 或 `D:\Six\MonsterPK`。

```bash
git clone https://github.com/LJJ666666/MonsterPK.git E:/Six/MonsterPK
cd /e/Six/MonsterPK
git log -3 --oneline
git status --short          # 应为空
```

> 若 clone 报 401/403：GitHub HTTPS 需要凭据（PAT 或凭据管理器 / `gh auth login`），不能用账号密码。
> **不要**把项目放到 `I:` 那个 exFAT U 盘上——它卷健康 Warning，历史上出现过「大小一致但内容不同」的静默单比特损坏；中文目录还会让部分文件检索工具失效。

## 3. 第 2 步：重建环境与本机专属配置（最容易漏）

### 3.1 后端配置与数据库

`dev.db` 不入库，所以家里是**全新空库**：账号要重新注册，管理员要重新授权。

```bash
cd /e/Six/MonsterPK/backend
cp .env.example .env
```

编辑 `backend/.env`：

- `JWT_SECRET` **必须换成随机长字符串**（模板里是 `change-me-in-prod-...`，别直接用）
- `ADMIN_USERNAMES` 可填你的用户名（逗号分隔），或留空之后用 `grant` 命令授权
- `DATABASE_URL="file:./dev.db"`、`PORT=3001`、`CORS_ORIGIN="http://localhost:5173"` 保持默认

```bash
npx prisma migrate deploy       # 按迁移链建表（含 authority / IntentLog）
npx prisma generate             # 生成 Prisma Client
```

### 3.2 依赖（项目用 npm，别混 pnpm）

```bash
cd /e/Six/MonsterPK && npm install
cd /e/Six/MonsterPK/backend && npm install
```

### 3.3 起双服务（两个终端，或让 WorkBuddy 开后台任务）

```bash
# 终端 1
cd /e/Six/MonsterPK && npm run dev -- --host 0.0.0.0 --port 5173 --strictPort
# 终端 2
cd /e/Six/MonsterPK/backend && npm run dev
```

探活：

```bash
curl -s -o /dev/null -w "front:%{http_code}\n" http://127.0.0.1:5173/
curl -s -o /dev/null -w "back:%{http_code}\n"  http://127.0.0.1:3001/api/health
```

### 3.4 注册账号并授权管理员

浏览器打开 `http://localhost:5173` 注册账号，然后：

```bash
cd /e/Six/MonsterPK/backend && npm run admin -- grant <你的用户名>
```

> ⚠️ **不授权就用测试菜单会被风控封号**，这是设计不是 bug。管理员身份只在服务端判定（`User.role='admin'` 或 `.env` 的 `ADMIN_USERNAMES`），前端 `useIsAdmin()` 只是 UI 收敛。
> `save_data.json` 不存在时 dev/preview 的 `/api/save` 返回 404 属正常，store 会回退 localStorage。

## 4. 第 3 步：记忆恢复（三层，别搞混）

| 层 | 存放位置 | 随 git？ | 家里怎么办 |
|---|---|---|---|
| 云端 profile / 历史对话 | WorkBuddy 账号 | 跟账号 | **用同一个 WorkBuddy 账号登录**即自动注入；要找回旧讨论用 `conversation_search` |
| 项目级工作记忆 | `<项目>/.workbuddy/memory/` + `.trae/documents/` | ✅ | clone 后自动在，**用 WorkBuddy 打开该项目目录**即注入 |
| 用户级长期记忆 | `C:\Users\<用户名>\.workbuddy\` | ❌ | 手动搬下面 4 个文件，或用第 5 节话术兜底 |

用户级 4 个文件：

```
C:\Users\Six\.workbuddy\MEMORY.md
C:\Users\Six\.workbuddy\IDENTITY.md
C:\Users\Six\.workbuddy\SOUL.md
C:\Users\Six\.workbuddy\user-2f146fb9-76c5-420d-95cd-5fad8c99318f-personal\MEMORY.md
```

搬运方式：微信文件传输助手 / 网盘 / 公司云盘均可，**不要用 I: U 盘**。若只能用 U 盘，传前后各算一次 `sha256sum` 比对，防止静默损坏。
家里放到 `C:\Users\<家里用户名>\.workbuddy\` 对应位置；`user-*-personal` 目录名以家里实际生成的为准，**把内容合并进去，别整文件覆盖**（家里可能已有其他项目偏好）。
两边记忆镜像改任一侧后要跑：`python scripts/sync_memory.py`（`--reverse` 反向 / `--check` 只校验）。

> **兜底**：就算这 4 个文件没带，第 5 节话术里已写全称呼、语气和硬约束，新会话照样能进入状态。

## 5. 第 4 步：打开 WorkBuddy，第一段话术（直接复制）

> 先在 WorkBuddy 里把**工作目录切换/打开到 clone 出来的 MonsterPK 目录**，再发下面这段话。

```
杰哥回家继续开发 MonsterPK 了。先别动手改代码，按下面顺序做：

1. 读 HANDOFF.md、.workbuddy/memory/MEMORY.md、.workbuddy/memory/2026-11-06.md、
   .trae/documents/开发任务优先级_2026-11-04.md。
2. 称呼我「杰哥」，你自称「tx」。中文回复、结论先行、一轮多问就分点逐条答；
   给可复现证据（命令输出、哈希、日志原文），不接受「应该是因为」；
   不要半成品，做不到或不确定就直接说。
3. 如果本机 ~/.workbuddy 下没有用户级记忆，请把第 2 条的偏好写进本机用户级
   MEMORY.md，之后长期遵守。
4. 复述三件事，确认记忆已加载：
   ① 当前做到哪一步、下一步是什么；
   ② SCHEMA_VERSION 与后端 EXPECTED_SAVE_VERSION 为什么必须同步递增；
   ③ 改系统时间获取资源的处置口径（是否封号）。
5. 探活双服务（5173 / 3001），没起就按 HANDOFF.md 第 3 节启动。
6. 跑 python scripts/check_home_env.py 与 python scripts/doc_check.py，把输出贴给我。

以上全部只做只读检查。不要重跑任何已完成任务，也不要擅自开始 P3-1c（前端切换到服务端战斗），等我排期。
```

## 6. 验收清单

**首选：一条命令跑完全部（约 45s，跑完自动清理测试账号）**

```bash
npm run verify                    # 期望 VERIFY_OK（16 阶段）
```

它等价于下面这些，且会先探活 5173 / 3001、缺服务的阶段自动 SKIP：

```bash
# A. 不需要服务
python scripts/check_home_env.py          # ENV_CHECK_OK（[WARN] 按提示处理）
python scripts/doc_check.py               # DOC_CHECK_OK
python scripts/sync_memory.py --check     # [一致] 且两侧 sha256 相同
npm run check && npm test                 # 前端 0 错误 / 81 passed
cd backend && npm run check && npm test   # 后端 0 错误 / 160 passed
cd backend && npm run check:content       # 内容表与 src/game/data.ts 一致

# B. 需要服务已起（后端 3001 + 前端 5173）
cd backend && npm run e2e               # 62/62 E2E_OK
cd backend && npm run e2e:p12           # 30/30 E2E_P12_OK（capture/battle_reward 已下线）
cd backend && npm run e2e:p21           # 34/34 E2E_P21_OK
cd backend && npm run e2e:p22           # 24/24 E2E_P22_OK（在线权威态）
cd backend && npm run e2e:p31           # 48/48 E2E_P31_OK（服务端战斗 + P3-1c 契约）
cd backend && npm run e2e:hardening     # 114/114 E2E_HARDENING_OK（对抗攻防）
node scripts/ui_smoke_p21.mjs           # 15/15 UI_SMOKE_OK（真实 Edge headless）
node scripts/ui_smoke_p31c.mjs          # 15/15 UI_SMOKE_P31C_OK（前端走服务端战斗）
```

**子集与小技巧**

```bash
npm run verify:quick              # 只跑 check + unit，不需要服务（改完代码先跑这个）
npm run verify:e2e                # 只跑六组 E2E
npm run verify:smoke              # 只跑两个浏览器冒烟（p21 通道 + p31c 战斗链路）
npm run verify:hardening          # 只跑对抗套件
npm run verify -- --skip=smoke    # 跳过浏览器冒烟
npm run verify -- --strict        # CI：服务没起视为失败
npm run verify -- --no-clean      # 保留测试账号便于排查
cd backend && npm run clean:e2e -- --dry   # 看有多少历史测试账号待清
```

> 测试账号会累积吗？不会。`e2e:hardening` 自清理，`verify` 结束统一清一次，
> 且只删 `e2e_/ui_/harden_/hd_/edge_/bt_/p12_/ws_/b3a_/b3b_/ss_` 前缀，**永不删 admin**。

浏览器打开 5173：能注册登录、Start 页显示「实时通道已连接」（证明 WS 握手与 hello 成功）。

> 若系统没有 `python` 命令，用 WorkBuddy 内置 Python 的绝对路径
> `C:\Users\<用户名>\.workbuddy\binaries\python\versions\3.13.12\python.exe`，或直接让 WorkBuddy 执行脚本。

## 7. 坑清单（都真踩过）

- **I: 是 exFAT U 盘**，卷健康 Warning、会静默写坏数据；重要文件别放 I:，也别用它传记忆文件。
- 项目路径须 NTFS、非盘根、无空格、尽量纯英文；中文目录会让 `Glob` 检索失效（改用 `Grep` / PowerShell）。
- **关机或换会话后后台 dev server 不会自动恢复**，新会话先 curl 探活再重启。
- `backend/src/lib/env.ts` 的 `.env` 路径曾算错，导致 `JWT_SECRET` 长期回落硬编码默认密钥；改配置相关代码必须实测 `process.env.XXX` 有值。
- 改 Prisma schema 前先停 :3001（Windows 下 `query_engine-windows.dll.node` 文件锁）。
- 新增持久化字段 → 递增 `SCHEMA_VERSION`(=10) + persist `version` + migrate 分支，后端 `EXPECTED_SAVE_VERSION`(=10) 同步改，否则新档全被拒。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一用 `rules.ts` 的 `uuid()`；所有 Hook 必须在组件顶层。
- `strict:false` 下 `if (!parsed.ok)` 判别联合收窄会失效，改用 `'code' in parsed`。
- 同一文件同一轮发多条 Edit 会互相覆盖：每个文件每轮只发一条，改完立刻校验。
- `.vtmp/` 被 gitignore，一次性脚本不入库；需要长期复用的已固化到 `scripts/`。
- 涉及服务端 RNG 的 E2E 必须**重复跑**，单次全绿不代表成功/失败两条随机分支都覆盖（bug_log §17）。

## 8. 当前进度快照（2026-11-06）

P0 五项 ✅ / P1-1 ✅ / P1-1b ✅ / P1-2 ✅ / P1-3 ✅ / **P2-1 ✅** / **P2-2 ✅（11-07）** / **P3-1a ✅ + P3-1b ✅（11-07）**。
下一步 **P3-1c**：后端已有内容表、战斗内核与权威战斗态（开局/回合/结算/广播全在服务端，`e2e:p31` 39 例），但**前端还没切换**——`startEncounter`/`useMove`/`useItem`/`switchTo`/`flee` 仍走本地战斗。P3-1c 把这几个入口改调 `/api/battle/*`，玩家才真正走服务端战斗；之后 P3-2 去本地权威、P4 多人、P5 去本地存档才安全。P1-4（榜单/成就派生）优先级低，不必抢跑。

北极星方向：**服务端权威 + WebSocket 实时多人同玩**，客户端瘦终端只发意图、收状态、渲染；本地存档是 P3/P5 前的过渡桥接。

反作弊口径：测试菜单级数据只放行管理员；他人改档一律拦截 + 封号弹窗 + 强制登出；**改系统时间不封号，只要求「不生效」**。权威摘要不符 / 增量不符一律 400 + 中文原因，不封号。
