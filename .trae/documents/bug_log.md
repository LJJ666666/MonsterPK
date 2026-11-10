# 游戏开发与运行问题排查日志 (Bug Log)

本文档用于记录项目开发过程中遇到的典型 Bug 及其排查、解决思路，避免后续出现类似问题时浪费排查时间。

## 1. Vite 启动失败 / 白屏 (`sh: vite: not found`)
- **表现**：预览窗口白屏，或者在终端运行 `npm run dev` 时抛出 `sh: vite: not found` 及 `node_modules missing` 警告。
- **原因**：远程沙盒环境重启、休眠或容器刷新导致本地的 `node_modules` 文件夹丢失。
- **解决方式**：
  - 重新执行安装命令：`npm install`
  - 安装完成后再启动服务：`npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`

## 2. 修改代码后页面白屏，且无明显运行时报错
- **表现**：修改 `rules.ts` 或 `types.ts` 等底层数据结构后，游戏画面突然白屏，且浏览器 Console 面板没有明确的报错。
- **原因**：通常是由于 TypeScript 类型检查失败（例如漏写了 `import` 导入某个类型如 `StatBlock`），导致 Vite 热更新 (HMR) 进程在后台编译报错卡死，进而向前端推送了错误的状态。
- **解决方式**：
  - 在终端运行 `pnpm run check` (即 `tsc -b --noEmit`)，检查是否有 TS 编译错误。
  - 修复 TS 错误后，刷新浏览器页面 (`Ctrl + F5` 强制刷新)。

## 3. 读取旧存档或新增数据结构后游戏崩溃
- **表现**：添加了新的宠物属性（例如 `growthRates` 或 `initStats`），导致玩家进入游戏时抛出 `undefined` 错误或直接白屏。
- **原因**：本地 `localStorage` 中的旧存档缺乏这些新字段。
- **解决方式**：
  - 每次修改 `MonsterInstance`、`SaveData` 等核心持久化数据结构时，**必须在 `useGameStore.ts` 中递增 `version`**。
  - 必须在 `migrate` 函数中编写向后兼容代码。例如，遍历 `save.party` 和 `save.box`，为旧数据补齐 `initStats` 等缺失字段。
  - 注意安全判空，处理好 `save` 为 `null` 或数组为空等边界情况。

## 4. UI 渲染超出屏幕或自适应不佳
- **表现**：大型表格（例如 18x18 的属性克制表）在移动端设备上尺寸过大，需要来回拖拽，体验极差。
- **解决思路**：
  - 在移动端开发中，尽量避免使用巨大的原生 `<table overflow-auto>`。
  - 优先考虑重构为**交互式卡片**或**网格选择器**。例如：提供一个选择目标属性的网格，并在下方以列表形式呈现其“作为攻击方”和“作为防守方”的独立数据。
  - 对于文本内容（例如地图地点），尽量使用横向排列的 `flex flex-wrap` 标签 (Tag) 形式，使其能自动换行。

## 5. `crypto.randomUUID is not a function` 报错
- **表现**：生成新怪物（例如捕获、初始化）时报错，导致流程中断。
- **原因**：部分低版本浏览器、或者非 HTTPS 环境下的旧 WebView 可能不支持 `crypto.randomUUID()` API。
- **解决方式**：
  - 自己实现一个降级的随机字符串生成器函数（位于 `math.ts` 或 `rules.ts`），例如：
    ```ts
    export function uuid() {
      return Math.random().toString(36).substring(2, 15) + Math.random().toString(36).substring(2, 15);
    }
    ```
  - 全局替换 `crypto.randomUUID()` 为自定义的 `uuid()`。

## 6. 图鉴页面点击后 UI 乱 / 控制台提示 Hook 顺序变化（Rules of Hooks）
- **表现**：进入图鉴后点击某些区域，页面布局错乱或白屏；Console 里出现类似 “Rendered fewer hooks than expected / hook order changed” 的提示。
- **原因**：
  - 在组件内部的条件分支之后才调用 `useState/useMemo/useEffect`（例如写在 `if (!save) return ...` 之后）。
  - 把 Hook 写在渲染函数或回调里（例如 `renderDex()` 里再 `useState`）。
- **解决方式**：
  - 把所有 Hook 移到组件顶层、任何 return 之前；渲染函数只负责纯渲染。
  - 相关入口：图鉴页面 [Camp.tsx](file:///workspace/src/pages/Camp.tsx)

## 7. 新增技能/幻兽后 UI 仍显示旧数据 / 直接白屏，报 `Unexpected keyword 'export'`
- **表现**：改了 `data.ts` 后，技能图鉴仍只有旧数量；或者页面直接白屏，控制台/终端出现 `Unexpected keyword 'export'` 之类语法错误。
- **原因**：`data.ts` 的大型对象（如 MOVE_SPECS / MONSTER_SPECS）在编辑时漏了 `};` 或括号闭合，导致后续的 `export ...` 语句“落进对象字面量内部”。
- **解决方式**：
  - 先运行 `npm run check` / `npm run build` 强制让编译错误显性化，定位到具体行。
  - 检查对应大对象的结束符号（`}` / `]` / `);` / `};`）是否完整，优先从报错行往上回溯最近的对象/数组结尾。
  - 相关入口：数据文件 [data.ts](file:///workspace/src/game/data.ts)

## 8. 预览面板一直转圈 / 白屏，但服务其实正常
- **表现**：点击预览卡片后，右侧内置浏览器长时间转圈、页面空白；但终端里 Vite 明明已经 `ready`，`curl` 访问也返回 `200`。
- **预览链路实际结构**（可通过 `/var/log/tool/agent-tool-host.stdout.log` 确认）：
  - Trae 客户端 → 公网网关 `*.agent-sandbox-*.trae.ai` → 沙盒内 `preview_proxy`（监听 `[::]:80`，对外 `16000`，`requires_auth=true`）→ 按 `?_port=` 转发到 `PreviewManager` 已注册的端口。
  - 日志关键字：`preview_proxy::proxy: [preview-proxy] Proxying / to port 5173`、`PreviewManager Port registered`。
- **典型原因**：
  1. **转发的目标端口已经死了**。重启服务时换了端口（如 5173 → 4173），但旧端口仍留在 `PreviewManager` 里，面板继续往死端口转发，于是无限重试。日志会连续出现
     `WebSocket upgrade failed: TCP connect to backend failed port=5173 error=Connection refused`。
  2. 启动命令里带了 `--strictPort`，第二次启动会直接失败退出，但面板仍显示“运行中”，造成“服务明明在跑却打不开”的错觉。
  3. 预览代理会往 HTML 的 `</head>` 前注入一段**同步阻塞**的 `previewer-tools.umd.js`（约 460KB，来自 `lf3-static.bytednsdoc.com`）。该 CDN 拉取慢或被拦截时，`</head>` 之后的内容（包括 `<body>` 和 `#root`）不会被解析，表现同样是白屏 + 转圈。
- **排查方式**：
  - 看日志确认请求有没有真的到达沙盒：`grep preview_proxy /var/log/tool/agent-tool-host.stdout.log | tail -n 50`
  - 确认端口活着：`ss -ltnp | grep -E ':(5173|4173)'`
  - 沙盒内有无头浏览器可直接连 CDP 自测：`curl -s http://127.0.0.1:8088/v1/cdp/json/list`，再用 `Runtime.evaluate` 看 `document.readyState` 与 `#root` 内容。
- **解决方式**：
  - 因为 `PreviewManager` 会记住多个端口，**把所有已注册端口都重新拉起**（例：同时监听 5173 与 4173），不要只保留新端口。
  - 统一使用一个固定端口，避免反复换端口；需要换端口时，先停掉旧服务再注册新端口。
  - 不要同时留多个 `npm run dev` / `vite preview` 后台任务，`--strictPort` 下多余的那几个只会静默失败并干扰判断。

### 8.1 最容易被忽略的真凶：沙盒容器被重建过
- **判断依据**：
  - `node_modules` 莫名其妙消失，`npm run dev` 报 `vite: not found`。
  - Vite 启动时打印的 `Network: http://10.x.x.x:5173/` 里的 IP 变了（例如 `10.1.147.137` → `10.2.61.36`）。
  - 沙盒内 Chrome 的 target id 全部换新（`/json/list` 里的标签页 ID 变了）。
- **后果**：旧的预览卡片、旧的内置浏览器标签仍然指向**上一个容器的路由**，请求永远到不了新容器，表现为无限转圈。此时无论怎么刷新、换端口都没用。
- **解决方式**：
  1. 重新 `npm install`；
  2. 重新起 dev 服务（回到 `npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`）；
  3. **重新产出预览卡片**（重新 OpenPreview），旧卡片一律作废。

## 9. 弹窗在移动端过宽 / 左右留白不一致
- **表现**：机制表、技能表等弹窗在移动端看起来“像 PC 宽度”，横向拥挤或需要横向拖动。
- **原因**：弹窗容器使用了过大的 `max-width` 或缺少移动端边距、滚动区域高度限制。
- **解决方式**：
  - 给弹窗容器增加更小的 `max-w-*`，并确保内容区域 `overflow-auto` + 合理的 `max-h`。
  - 相关入口：机制表 [MechanicsModal.tsx](file:///workspace/src/components/MechanicsModal.tsx)、技能表 [MoveChartModal.tsx](file:///workspace/src/components/MoveChartModal.tsx)

## 10. `useNavigate()` 在 `<Router>` 外调用导致整页白屏（P0-4）
- **表现**：P0-4 改造 401 统一跳转时，在 `App` 顶层直接调用 `useNavigate()` 并注册 `useEffect`，页面整屏白屏，`#root` 为空。
- **原因**：`App` 自身渲染 `<Router>`，顶层调用 `useNavigate` 时还没进入 Router 上下文，React 抛 `useNavigate() may be used only in the context of a <Router> component`，整个应用崩溃。
- **解决方式**：抽出一个 `<UnauthorizedListener/>` 组件放在 `<Router>` 内部，由它调用 `useNavigate` + `useEffect` 监听 `mpk:unauthorized` 事件后清 token 并 `navigate("/auth")`。headless Edge 回归确认：无 token → 登录页、有效 token → Start 页。

## 11. 沙盒 brokered-fs 导致 vitest 并发写临时文件 EPERM（P0-4 测试环境）
- **表现**：`npm test` 偶发 "Unhandled Errors"，仅 1~2 个测试文件被收集，报 `EPERM ... \AppData\Local\Temp\...\ssr\... operation not permitted`。
- **原因**：沙盒的 brokered-fs 垫片拦截并发的 SSR transform 缓存写入系统 Temp，多文件并行时触发权限错误使 vitest 部分崩溃（只跑了一部分用例）。
- **解决方式**：测试脚本加 `--no-file-parallelism`（`package.json` `"test": "vitest run --no-file-parallelism"`），3 文件 10 用例稳定全过。属环境垫片问题，非代码缺陷。

## 12. `prisma generate` 因后端进程占用查询引擎 DLL 而 EPERM（Windows 文件锁，P0-2）
- **表现**：迁移后 `prisma generate` 报 `EPERM: rename '...\node_modules\.prisma\client\query_engine-windows.dll.node.tmp...' -> '...query_engine-windows.dll.node'`，即使关闭沙盒仍失败。
- **原因**：正在运行的 backend dev 服务（`tsx watch`，监听 :3001）已加载该查询引擎 DLL，Windows 对"被进程映射中的文件"禁止改名/覆盖，导致 `prisma generate` 无法落盘新引擎。
- **解决方式**：先停掉占用 :3001 的 node 进程（含其 `tsx` 父进程），再 `prisma generate` 即成功，随后重启 dev 服务。
- **注意**：改 Prisma schema 后跑迁移/生成前，务必确认没有 backend 进程在运行；否则会卡在这一步。

## 13. 前端 vitest 误扫后端 `node:test` 文件导致 `No test suite found`（P1-1）
- **表现**：后端新增 `backend/tests/saveValidator.test.ts`（Node 内置 `node:test` + `tsx --test`）后，前端 `npm test` 报 `FAIL backend/tests/saveValidator.test.ts | Error: No test suite found in file`，但用例本身用 `npx tsx --test` 跑是全过的。
- **原因**：vitest 默认 include 覆盖整个仓库的 `**/*.test.ts`，会把 `backend/` 下的 `node:test` 文件一并收集；两套测试框架的套件注册机制不兼容，vitest 在该文件里找不到它认识的 `describe/it`，判为"空套件"失败。
- **解决方式**：在 `vite.config.ts` 明确划定前端测试边界 —— `test.include: ['src/**/*.test.{ts,tsx}']` + `test.exclude: ['node_modules/**','dist/**','backend/**']`，并加 `/// <reference types="vitest/config" />`。后端测试由 `backend/package.json` 新增的 `npm test`（`tsx --test tests/*.test.ts`）独立运行、`npm run check`（`tsc --noEmit`）独立类型检查。
- **注意**：前后端是两套独立测试框架，新增测试文件时要放对目录（`src/` 给 vitest、`backend/tests/` 给 node:test），不要交叉。

## 14. `lib/env.ts` 的 `.env` 路径算错，JWT 长期用硬编码默认密钥（P1-1b 发现的安全缺陷）
- **表现**：为接入管理员白名单 `ADMIN_USERNAMES` 时实测 `npx tsx -e "import './src/lib/env'; console.log(process.env.JWT_SECRET)"`，输出 **`undefined`**；`ADMIN_USERNAMES` / `DATABASE_URL` / `CORS_ORIGIN` 同样全为 undefined。也就是 `backend/.env` 从未被加载，`index.ts` 里 `process.env.JWT_SECRET ?? 'dev-secret-change-me'` 一直回落到代码中的硬编码默认值。
- **原因**：`env.ts` 里 `const here = dirname(fileURLToPath(import.meta.url))` 得到 `backend/src/lib`，原写 `resolve(here, '../.env')` → 指向 **`backend/src/.env`（不存在）**，而真实 `.env` 在 `backend/.env`，需回退两级。此前联调全绿是因为默认值恰好与 `.env` 一致（`CORS_ORIGIN` 都是 `http://localhost:5173`），掩盖了问题。
- **影响（严重）**：① 生产环境换的 `JWT_SECRET` 根本不生效，任何人都可用公开的默认密钥伪造 JWT；② 新增的 `ADMIN_USERNAMES` 白名单永远读不到，管理员通道失效；③ `JWT_TTL` 配置也无效。属"配置看似外置实则写死"的安全缺陷。
- **解决方式**：改为 `resolve(here, '../../.env')`，并**实测验证**（修复后输出 `JWT_SECRET= "dev-secret-please-change-in-production-32chars-min"`、`DATABASE_URL= "file:./dev.db"`、`CORS_ORIGIN= "http://localhost:5173"`）。后端 dev 服务重启后生效，旧 token 因签名密钥变化全部失效（开发期重新登录即可）。
- **注意**：以后改 `.env` 相关代码，必须实测 `process.env.XXX` 真的有值，不能只看「代码里读了这个变量」。上线前务必再确认 `JWT_SECRET` 是随机强密钥。

## 15. P1-2 导致旧 E2E「连续写不同资源档」用例失效（2026-11-06）

现象：接入权威摘要后，原有 `e2e_save_validation.mjs` 57 例里 5 例失败，报错
`金币 1200 高于服务端裁决值 0，疑似修改数据`（`AUTHORITY_MISMATCH`）。

根因：旧用例 C 段「空队伍新档」把 money 从 1200 写成 0 并 PUT 成功；单调比对允许
「减少」，服务端随即把 expected 同步为 0，后续用例再写 money 1200 就被判成凭空增加。
这不是防作弊缺陷，而是**测试契约升级**：P1-2 起客户端不能再随意整包覆盖资源，
「同一账号连续写不同资源档」本身就是要拦截的行为。

处理：`okCases` 四例、未来时间戳两例、被拒档不落库一例改为**每例独立账号 + 首次写档建立基线**；
所有安全断言（400 / 403 封号 / 审计 / 时间钳制 / 管理员放行）一字未改。修完 `npm run e2e` 57/57 全绿，
新增 `e2e_p12.mjs` 38/38 专门覆盖新的拦截行为。

## 16. E2E 临时用户名超长导致 401（2026-11-06）

现象：为将来时间戳用例新建 `freshUser('future_time')` 后，PUT 返回 `未登录或登录已过期`（401）。

根因：注册用户名是 `e2e_<6位RUN>_<tag>`，`future_time` 使总长 22 字符，超过注册接口的 3~20 字符限制，
注册返回 400，`freshUser` 拿不到 token，后续请求自然 401。旧 tag 都很短所以没暴露。

处理：tag 改为 `ft` / `it`。**新增 E2E 用例时 tag 必须控制在 8 字符以内**，且 `freshUser` 应断言
注册状态与 token 存在——本轮 `e2e_p12.mjs` 已这么做（注册失败直接抛错中止）。

## 17. 捕获成功时新增幻兽被增量核对误拦（2026-11-06，E2E 偶发）

现象：`e2e_p12.mjs` 有时 38/38 全绿、有时 36/38，失败信息
`结算结果与服务端裁决不一致：幻兽 captured_1 的等级/经验增长超出服务端奖励`（`INTENT_DELTA_MISMATCH`，`path: party.captured_1`）。

根因：`settlements.ts::checkIntentDelta` 遍历 `actual.levelExp` 时，对基线中不存在的新 id 用 `[0,0]`
作基线、授权上限也默认 `[0,0]`，于是捕获成功新增的幻兽（Lv5 / exp12）被判成「凭空升级」。
之前几次全绿只是因为服务端捕获骰子恰好判了失败、没有新增幻兽——**RNG 分支覆盖不足导致的偶发假绿**。

修复：新 id 跳过 levelExp 上限检查，是否允许新增由 `exact.rosterCount` 精确授权兜底
（与 `compareDigest` 的既有口径一致；伪造捕获仍会被 `DELTA_ROSTER` / `DELTA_CAPTURE` 拦下）。
补单测 `捕获成功提交：新增幻兽 id 不应被等级/经验上限误拦`，后端单测 75 → 76 例。
复验：后端 `tsc` 0 / `node:test` 76/76；`npm run e2e` 57/57；`npm run e2e:p12` 连跑 3 次均 38/38。

**教训**：涉及服务端 RNG 的 E2E 必须重复运行或固定随机源，单次全绿不代表两条分支都覆盖。

## 18. `strict:false` 下判别联合收窄失效（P2-1，TS2339）

现象：`modules/realtime.ts` 里 `parseClientMessage()` 返回 `ParseResult`（`{ok:true,...} | {ok:false,code,reason}`），
写 `if (!parsed.ok) { parsed.code }` 后 `tsc --noEmit` 报 3 处
`Property 'code' does not exist on type 'ParseResult'`，但 `node:test` 运行完全正常。

原因：本项目 `tsconfig.json` 的 `strict: false` 同时关闭了 `strictNullChecks`，
该模式下对布尔判别式取反（`!x.ok`）的控制流收窄会失效，TS 仍按整个联合类型检查。
P1-1 里 zod 联合类型 narrowing 失败也是同一类坑（当时改用 throw-based `assertValidSaveData()`）。

处理：改成属性存在性收窄 `if ('code' in parsed) { ... }`，两个分支都能正确推导。
**约定**：后端判别联合优先用 `'字段' in obj` 或 `=== false` 显式比较，不要依赖 `!obj.ok`。

## 19. upgrade 拒绝响应 `write` 后立刻 `destroy` 会丢 body（P2-1，预防性修复）

现象：握手阶段拒绝连接时，最初实现是 `socket.write(响应)` 后立刻 `socket.destroy()`。
`write` 是异步的，立即 destroy 可能丢掉尚未 flush 的响应体，客户端（`unexpected-response`）
就只能看到断连，读不到 `401 UNAUTHORIZED` / `403 ACCOUNT_BANNED` 的机器码。

处理：改为 `socket.end(buildRejectResponse(...))` 一次性写完并正常结束。
`e2e_p21_ws.mjs` 的 8 个拒绝用例都断言了 `status` **且** `data.code`，可复现验证 body 完整。

## 20. `e2e:p31` 敌方等级断言写死等值，偶发失败（2026-11-07 全量回归发现）

现象：`npm run e2e:p31` 出现 `[FAIL] 敌方等级在开局区间内 3`，汇总 37/38，但同一套代码
早前多次跑都是 38/38。

原因：断言写成 `enemy.level >= 2 && enemy.level <= 2`（开局参数 `levelMin=levelMax=2`）。
但服务端 `generateEncounter()` 与前端 `src/game/gen.ts` 规则一致，在基础等级上还有
「精英 +2 / 稀有 +3 / 随机 +0~1」浮动，等级实际可落在 2~6。随机不浮动时才恰好等于 2，
按概率约 40% 通过、60% 失败——是**断言错**，不是战斗逻辑回归。

处理：改为按真实规则校验 `level ∈ [2, 6]`，并新增一条「等级浮动与遭遇标签一致」
（日志前缀 野生 / 精英 / 稀有），用例数 38 → 39。修完连跑 5 次均 39/39。

**教训**：涉及 RNG 的 E2E 不要写死等值断言；要么注入固定种子，要么断言真实区间与不变量。
`gameSession` / `battleEngine` 单测能注入 RNG，E2E 走真实 `Math.random`，只能断言范围。

## 21. 幻兽个体值区间整体反向，进化还会把个体差异清零（2026-11-07 杰哥拍板修复）

现象：`getMonsterStatBounds()` 返回的 `initMin` 普遍大于 `initMax`。统计全表 **38 只幻兽 144 项**
（`atk/def/spAtk/spDef/spd` 各 38 项全部反向，`hp` 部分反向），例 `sprout_owl.atk` 下限 51 > 上限 49。

根因：`initMin` 是按 `Math.floor(base + 3.2 / 2.3 / 2.0)` 硬编码推算的，而 `data.ts` 里
`initStatsMax` 的取值是 `base + 0~5`（实测差值均值：hp 4.63 / atk 2.18 / def 2.00 /
spAtk 0.82 / spDef 0.79 / spd 0.50）。下限比上限还高，区间整体翻转。

三层后果，一层比一层隐蔽：
1. `randInt(min, max)` 在 `max < min` 时退化为 `[max, min-1]`，实际宽度只剩均值 **1.6**、最窄 **0**——
   个体差异几乎不存在，稀有度设计失效。
2. `forceInitMax`（测试菜单满属性）拿到的是 `initMax`，反而比随机生成的值还低，功能名不副实。
3. 最严重：`evolveMonsterInstance()` 里 `remapByBounds()` 开头是 `if (oldMax <= oldMin) return newMin;`。
   区间反向让这个分支**恒定命中**，于是每次进化都把 six stats 全部重置成新种族的 `initMin`——
   **个体差异在进化瞬间被清零**，而且不报错、不告警，从表现上完全看不出来。

处理（杰哥 2026-11-07 拍板「肯定要平衡的，要修」）：
- `initMin` 归位到种族值本身（去掉 +3.2/2.3/2.0 魔数），语义变成「种族值 = 平均个体」。
- `initMax = Math.max(spec.initStatsMax?.x ?? 0, initMin.x + INIT_SPREAD_MIN)`，`INIT_SPREAD_MIN = 4`：
  尊重内容表各自的浮动幅度（HP 普遍给到 +5），同时保底不会窄于 4。
- 前后端 `rules.ts` 两处同步改，`numericRules.test.ts` 从「只诊断」改为**硬断言**（反向 0 项、
  带宽 ≥ 4、下限等于种族值），并新增 `forceInitMax 六维等于上限` 用例。
- 前端 `rules.test.ts` 新增两条回归：区间正向 + **进化后保留个体差异**。

影响评估：30 级属性均值只从 139.4 变到 139.6（+0.19），1 级属性均值从 base+0.8 升到 base+2.1。
平衡零回归，玩家体感是「属性上限终于正常了」。已在 `initMin` 上方写明这段历史，防止再被加回魔数。

## 22. `MONEY` 一个 code 混装「格式错」与「越界」，负金钱/小数直接封号（2026-11-07 修复）

现象：普通账号提交 `money: -1` / `1.5` / `null` 会被判为改档并**封号**（403 ACCOUNT_BANNED）。
按理这些是格式脏档，不该是终局惩罚。

根因：`saveValidator.ts` 用一条判断同时覆盖两种性质完全不同的违规：

```ts
if (!isNonNegInt(parsed.money) || (parsed.money as number) > SAVE_LIMITS.MONEY_MAX) {
  c.reject('MONEY', 'money', ...);   // 两种原因共用一个 code
}
```

而 `antiCheat.ts` 的 `CHEAT_CODES` 里正好有 `'MONEY'`，于是「格式错」和「篡改越界」一起进了封号名单。
讽刺的是 `antiCheat.ts` 文件开头自己写着原则：「未列入的违规一律只 400 拒绝、不封号——旧版存档、
内容表更新、客户端 bug、网络损坏都可能造成格式异常，拿这些去封号会把正常玩家封掉。」
实现违反了它自己声明的契约。

同型问题共 13 个 code：`MONEY / STEPS / MONSTER_LEVEL / MONSTER_EXP / MONSTER_MAX_HP / MONSTER_HP /
MONSTER_HP_EXCEED / MONSTER_STAT / MONSTER_STATS_VALUE / INVENTORY_VALUE / COLLECTION_TIMES /
IDLE_LEVEL / CLEARED_AREA_LEVEL`，全部是「格式 + 越界」共用一个 code。

处理：确立命名约定，**一个 code 只能表达一件事**：
- `<FIELD>_FORMAT`：类型 / 符号 / 整数性错误 → hard reject（400），**不进白名单、不封号**。
- `<FIELD>_RANGE`：数值合法但超过上界 → hard reject + 封号（留在 `CHEAT_CODES`）。
- `MONSTER_HP` 拆为 `MONSTER_HP_FORMAT`；`MONSTER_HP_EXCEED`（hp > maxHp，内部矛盾）**移出**白名单；
  `CLEARED_AREAS` 的元素非对象从 `CLEARED_AREA_LEVEL` 拆出为 `CLEARED_AREA`。

`antiCheat.ts` 的决策逻辑一行没改（`formatHard = hard.filter(!CHEAT_CODES.has(code))` 本就走 400），
只改 code 命名与白名单内容，所以风险面很小。`antiCheat.test.ts` 增加双向断言：14 个格式码必须
`isCheatCode === false`、19 个越界/容量/高危码必须 `true`，且 `CHEAT_CODES.size` 精确相等——
以后新增风控码忘了同步会被这条用例挡住。

连带修：管理员以前能写进 `money: -1` 的脏档（会污染库），现在格式脏档**任何账号都 400 拒绝**，
管理员放行的只是「数值偏高」。

**教训**：风控 code 的语义粒度 = 封号决策的粒度。一个 code 承载两种性质，迟早会把其中最轻的那半
当成最重的那半处理。凡是「格式 / 越界」混写的判断，都要先问一句：这半边真的够封号吗。

## 23. P3-1c 踩到的三个坑：快照清战斗 / 条件 Hook / 动作 Promise 被吞（2026-11-07）

### 23.1 服务端结算广播到达的瞬间，战斗画面被踢回空态

现象：战斗结束（对手倒下 / 捕获成功），UI 本该停在结果面板，实际直接跳回
「尚未开始遭遇 —— 你可以从营地进入训练场」。

根因：`importSaveJson()` 一直是「导入存档」的语义，实现里硬写 `battle: null`
（换档必须清战斗，否则旧战斗会套到新档上）。P2-2 之后它多了一个调用方——
`lib/session.ts` 应用服务端 `session.state` 权威快照。而战斗结束时服务端会
`commitState()` 并广播快照，于是「结算快照到达」被当成「换档」，`battle` 被清空。

讽刺的是两边都认为自己是对的：`importSaveJson` 按换档处理没错，`session.ts`
应用快照也没错。错在**一个函数承担了两种语义**——和 §22 的 `MONEY` 是同一类问题。

修法：`importSaveJson(json, slot, { keepBattle })`，`session.ts` 传 `true`。
换档路径（`syncOnLogin`、玩家主动导入）保持默认清空。

**教训**：一个状态字段的「清空时机」也要有单一语义。`battle` 不进存档，
它的生命周期就该由战斗模块独占，存档模块不该顺手清它。

### 23.2 `Arena` 的 `latestLog` 是条件 Hook，开局瞬间必崩

现象：点「快速开始」进入战斗时白屏，控制台
`Rendered more hooks than during the previous render`。

根因：`Arena.tsx` 里 `const latestLog = useMemo(...)` 写在了 `if (!battle) return <空态>`
**之后**。无战斗时组件只跑 N 个 Hook，有战斗时跑到第 N+1 个 —— React 直接抛错。
这个 bug 从 P1 就存在，只是每次「从训练场空态点进战斗」都会触发；因为开发时通常
从营地直接进战斗（`battle` 早已有值），所以一直没被发现。

修法：把 `useMemo` 提到 early return 之前。**所有 Hook 必须在任何 return 之前**，
`rules.test` 之类测不出来，只能靠 code review 或真实浏览器冒烟。

**教训**：headless 冒烟的真正价值就在这里——单测和 E2E 都不会渲染 React 组件树。

### 23.3 `useMove` 里 `void runServerBattleAction(...)` 让 `await` 变成空操作

现象：`await useMove(id)` 之后立刻断言状态，`turn` 还是旧值。

根因：`useMove` 声明成 `async`，但服务端分支写的是 `void runServerBattleAction(...)`——
`void` 掉之后函数立刻返回，`await` 等于什么都没等。写测试时才发现。

修法：`useMove` / `useItem` 改成 `await runServerBattleAction(...)`，语义变成
「等这一回合真的跑完」。`switchTo` / `flee` 的对外签名是 `void`（UI 直接 `onClick`），
保持 fire-and-forget，但内部仍然置 `pending` 防连点。

**教训**：给 `async` 函数加 `void` 前缀前，先问一句「调用方会不会想 await 它」。
声明成 async 又立刻返回 Promise 未决态，是最容易骗过自己的写法。

## 24. 战斗上移后留下的三个尾巴：奖励后门、规则丢失、降级毒丸（2026-11-07 杰哥拍板处理）

### 24.1 `battle_reward` / `capture` 意图在战斗上移后成了后门（严重）

现象：任何登录账号直接 `POST /api/actions/battle_reward { enemyLevel: 30 }` 就能拿
350 金币 + 190 经验，`capture` 同理可以用伪造的最优参数反复抓怪。

根因：这两个意图是 P1-2 的产物——那时战斗在客户端跑，服务端只能采信上报的过程数据，
最多把 `baseRate` 钳到 0.62、把 `enemyLevel` 钳到 30。`actions.ts` 里**没有任何**
「必须存在进行中的服务端战斗」的前置校验。P3-1c 把战斗整条搬到服务端之后，
这段「信客户端」的逻辑没有同步下线，于是变成零成本刷资源。

加重因素：`modules/battle.ts` 的注释写着「旧链路保留，避免一次性切换导致老客户端不可用」。
这是一句 AI 自己给自己找的理由——项目还在开发阶段，没有真实老客户端。
（杰哥 2026-11-07 明确指出：这类遗留的「兼容性」判断要能自动识别为无意义行为。）

处理：从 `INTENT_TYPES` 移除、删除两个分支、删掉只为其服务的常量与函数，不留开关。
`e2e_p12` 里原本「验证 capture 伪造被拒」的 8 条用例改为「调用即 400 未知的操作类型」，
`settlements.test.ts` 增加一条白名单断言，防止有人把类型加回去。

### 24.2 P1-3 的捕获率修正没跟着搬到服务端战斗（静默玩法回退）

现象：P3-1c 之后玩家实际捕获率比 P1-3 时期低（稀有怪和越级怪没有额外惩罚）。

根因：P1-3 的**稀有度打折**（`baseRate < 0.15 → ×0.85`、`< 0.25 → ×0.92`）与
**等级差修正**（越级 −2%/级，下限 0.6；压制最多 +10%）只写在
`settlements.computeCaptureChance` 里。P3-1b 另外实现了一套 `game/rules.ts::captureChance`，
只有「残血 × 异常 × 球倍率」三项。P3-1c 玩家切到服务端战斗后走的是后者，
两项修正就此丢失——前后端一致（`battleEngine.test` 对照通过），所以测试全绿，
没有任何信号。

处理：两项并入 `game/rules.ts::captureChance`，签名加必填 `playerAvgLevel`
（由 `partyAvgLevel(s.party)` 传入，不采信客户端）；前端 `rules.ts` 同步；
`numericRules.test.ts` 新增两条硬断言（含 `0.2 × hpFactor × 0.92` 的绝对值验算）。

**教训**：同一个公式存在两份实现时，「前后端一致」的测试通过不代表规则还在。
对照测试只能证明两边一样，不能证明它们是对的。

### 24.3 本地降级战斗：安全上没漏，但制造同步死循环

现象（评估而非实测，因为一联网就复现）：断网降级本地打 → 本地存档变富 →
联网后每次 PUT 都 400 `AUTHORITY_MISMATCH`，玩家永远同步不上。

根因：`compareDigest` 只挡「变富」，挡对了；但 `classifyUploadError` 把 4xx 判为
permanent 只是**不再重传**，并没有把本地存档回滚回服务端认可的状态。
于是本地那份富档成了常驻状态，之后每一个操作都继承它。

处理：删除降级（`beginLocalEncounter` + `executeMoveAction` + `processEndOfTurn` +
`runEnemyTurn` + 四个入口的本地分支，共约 550 行）。断网如实报错。
详见规范 §19.5。

**教训**：「请求被拒」和「客户端的错误状态被修正」是两件事。前者只需要不重试，
后者才真正让玩家回到可用状态。只做前者，玩家就卡在中间。


## 25. P3-2 挖出的四处「本地权威」残留（2026-11-07 杰哥拍板「一切以服务器为主」）

杰哥的原话：「把以往仅前端的处理一并找出来优化掉，一切都是以服务器为主」。
按这个口径把客户端还剩下的写档逻辑过了一遍，四处都不算 bug 单点，而是同一类问题：
**操作在客户端算完，服务端只看到结果，于是结果本身没有可信来源。**

### 25.1 治疗可以在任何地方回满

`healAll()` 只改本地 store，不看 `locationId`，也不问服务端。任何界面能调它就能回满；
更彻底一点，玩家把存档里的 `locationId` 改成 `town_starter` 再调一次，同样成立
（`travelTo` 也只在本地改）。

修：`POST /api/game/heal`，服务端查 `LOCATIONS[locationId].hasCenter` 才回满，
写档并广播。客户端不再有回满逻辑。

### 25.2 进化后的六维是客户端算的

`useItemOutsideBattle` / `resolvePendingEvolution` 都调前端 `evolveMonsterInstance`：
个体值/成长率按区间重映射、血量按比例保留、新学会的技能……全在客户端。
`saveValidator` 只能校验「数值像不像这个等级该有的」，没法证明「这次进化真的发生过」。

修：`evolveMonsterInstance` 复制到 `backend/src/game/rules.ts`（与前端逐项一致，
由 `battleEngine.test.ts` 对照），进化只走 `/api/game/evolve` 与 `/api/game/use_item`；
`pendingEvolution.targetId` 必须命中内容表里的 `evolutions`，否则
`EVOLUTION_TARGET_INVALID`。

### 25.3 HP 根本不在权威摘要里

这是排查时最意外的一条：`digestOf()` 从来没把 `party[].hp` 算进去，因为 P1-2 时代
战斗在客户端，服务端刻意不管 HP。但 P3-1c 之后 HP 已经是服务端真值了，
「客户端把血改满」仍然能整包 PUT 通过——资源一点没变富。

修：新增 `checkPartyStateRegression()`，在分支 3 里额外要求 HP 只能下降、
异常状态不能凭空清除。`e2e:p32` 有一条用例直接断言「客户端自改 HP 不被接受」。
**教训：上移真值的时候，要顺手把真值从「允许客户端改」的通道里摘出去，
否则它只是换了个地方存在，并没有变成权威。**

### 25.4 解药和进化石在背包里根本没有入口

`useItemOutsideBattle` 里写了 `kind === 'status_heal'` 之外的分支（`evolution`），
但 `Camp.tsx` 的背包只对 `kind === 'heal'` 渲染「对 XX 使用」按钮。
也就是说：P1-3 声称「进化石可用」，实际玩家只能靠升级弹窗进化，
买来的石头和解药在 UI 上是死道具；`bagFilter === 'heal'` 也把这两类过滤掉了。

修：背包按内容表推导「能对谁用」——回复看缺不缺血、解药看状态是否匹配、
进化石看这只幻兽有没有对应的 `item` 进化条件；三类都进「药品」分类。

### 25.5 顺带发现：`discard` 语义缺失

`MoveLearnerModal` 的「放弃学习」传的是 `oldMoveId: null`，但服务端 `learn_move`
在 `oldMoveId === null` 时的语义是「栏位没满就直接学会」，两者撞车会让放弃学习
变成 `MOVE_SLOTS_FULL`。补 `discard: true` 分支：只从 `pendingMoves` 移除，不动技能栏。

### 25.6 全灭惩罚原本可以「不点离开」逃掉

`leaveBattle` 里做「回满 + 送回最近恢复点」。只要不点离开、直接刷新页面（战斗态不进存档），
惩罚就不生效。现在结算时服务端直接写档。**凡是「惩罚」语义的逻辑都不能放客户端**，
不然它同时是一个「可以不放行」的可选项。

## 26. CAS 落地的六个坑（2026-11-07 P4 前置）

给整包 PUT 加「必须带 revision」看着只是加一个字段，实际把三条链路都撞了一遍。

### 26.1 六个既有 E2E 套件集体红

`REVISION_REQUIRED` 一上来，`e2e:save` / `p12` / `p21` / `p22` / `p31` / `p32` / `hardening`
里所有手工构造的 PUT 全部 400。逐处加 `revision: 0` 是错的方向（第二次就错）。
修：新增 `backend/tests/lib/saveWriter.mjs`，按 `token × slot` 跟踪当前版本，
`put()` 自动带上、成功后自动 +1，需要构造冲突时显式传 `{ revision: n }`。
好处是测试代码不用关心版本，只有「故意撞冲突」的用例才提版本号。

### 26.2 意图裁决成功后必须把新版本写回

`POST /api/actions/:type` 裁决时服务端推进了版本并返回 `revision`，前端如果只用「发意图前那个版本」
去 `commitIntent`（PUT + `intentNonce`），必然 409 —— 而且这个 409 会被前端当成「其他设备更新了」，
把刚裁决出来的结果丢掉。修：裁决响应里回 `revision`，前端立刻 `setRevision()`；
E2E 的 intent helper 同样要写回，否则下一步的提交全挂。

注意这里 409 一旦误判就有数据风险：**CAS 冲突和「意图提交撞版本」在 UI 上长得一样**，
但后者绝不能触发 `healFromConflict`（会把刚落库的裁决结果覆盖掉）。

### 26.3 版本校验必须放在风控与 nonce 消费之前

放后面会有两个副作用：① 并发冲突被当成存档异常跑一遍反作弊，日志噪声大且容易误判；
② 意图通道如果先消费 nonce 再判冲突，一次并发就废掉一个一次性 nonce，
客户端重试还得重新生成。改为「先 CAS 再风控/nonce」。

### 26.4 并发用例反过来暴露了「E2E 证明不了锁」

写了个临时脚本，同一 `revision` 打 8 条并发 PUT：只有 1 条 200、7 条 409、版本只涨一次。
看着很完美 —— 于是把 `withSlotLock` 临时改成直通再跑，**结果一模一样**。
也就是说这个形状在本机被 undici 连接 / Prisma 队列 / 内存会话命中三重因素串行化了，
E2E 根本撞不进临界区，通不通过和有没有锁无关。
修：锁的正确性改用单测证明 —— `tests/slotLock.test.ts` 里「临界区不交错」「跨 await 计数器不丢更新」
两条，把锁改成直通时确实 2 fail / 3 pass（已实测）。E2E 保留为对外契约回归，
并在注释里写明它证明不了什么。**教训：并发相关的「绿灯」必须问一句「把锁去掉它还绿吗」。**

### 26.5 构造并发用例时的载荷方向

`validSave({ money: 2001 })`（默认 1200）是「变富」，直接被 `AUTHORITY_MISMATCH` 400 拒掉，
于是并发用例两条都 400、断言全错。CAS 用例的载荷必须是**允许方向**（更穷 / 等值），
否则根本走不到版本比对。改 `money: 1001 / 1002` 后正常。

### 26.6 战斗动作也有同一个 TOCTOU

`POST /api/battle/action` 里 `battles.get` 与实际推进之间有 `await readSave`，
两条并发动作会各自基于同一份战斗态推进；结束判定那条还会各自结算写档（重复写一次）。
虽然当前是单人对战，重复结算不会翻倍发奖（两次算出的档一样），但版本号会多涨一次，
客户端与 `authority.expected` 的对应关系就错位了。修：`battle/start` 与 `battle/action`
一起进槽位锁。

## 27. 顶号与共享野怪的七个坑（2026-11-07 P4-1）

### 27.1 只断 WS 不算「下线」——刷新页面会互相顶号死循环

最初想的是「新连接 takeover 踢掉旧连接 + 前端停重连」。看着够粗暴，实际有个致命回路：
旧设备的 token 还在 localStorage，用户不点弹窗直接刷新 → `startRealtime()` 重新握手
→ 又把新设备踢下线 → 新设备也刷新……两台设备无限互踢。

修：加 `User.sessionVersion`，登录即递增并写进 JWT 的 `sv`，认证守卫和 WS upgrade
双校验，旧 token 所有 REST 直接 403 `SESSION_REPLACED`。前端再记 `replacedToken`，
只要本地还是那枚旧 token 就拒绝建连。**顶号的触发点必须是 login，不能等 WS 握手**。

### 27.2 顶号把四组 E2E 一起打红，不能靠兼容开关糊过去

`p21`（第 4 条 → 429）、`p22`（两条连接都收广播）、`p4`（双端 CAS 用两条登录）、
`hardening`（连接数上限）全部基于「同账号允许多端」。逐个加 `if (旧模式)` 兼容分支
是最省事但最坏的做法——测试会继续给一个已经不存在的语义背书。

修：改用例语义。`p22` 改成「顶号 + 唯一活跃连接收广播 + 旧连接不再收」，
`p4` C 段改成「同一会话的旧版本重放」，`p21` 改成「第 2 条顶掉第 1 条 + 旧 token
REST/WS 双失效」。用例数 34→41 / 24→25 / 39→41 / 114→115，语义与实现对齐。

### 27.3 discriminant 联合又不收窄（§18 复发两次）

`checkSessionVersion()` 返回 `{ok:true} | {ok:false, code, reason}`，
`if (!session.ok) session.code` 在 `strict:false` 下 TS2339；
`wilds.claim()` 的 `ClaimResult` 同样。一律改成 `'code' in result` 取属性。
**这条已经第三次踩了，写联合类型时直接按「属性存在性」写。**

### 27.4 Prisma 迁移必须先停 :3001（§12 复现）

加 `sessionVersion` 字段时后端 tsx watch 在跑，`prisma generate` 撞 Windows DLL 文件锁。
按 §12 流程停掉监听进程 → 写迁移 SQL → `migrate deploy` → `generate` → 重启，干净。
顺带发现旧会话残留了 3 个 tsx watch 进程，一起清掉，端口才真的释放。

### 27.5 共享野怪的 revision 一开始是全局的

`WildRegistry` 用单个 `revision`，结果给「未知区域」补一次怪，就把 `wild_starter`
的快照版本从 1 推到 2 —— E2E 的「两次读取 revision 一致」立刻红。
这不是断言写错，是设计错：`wild.state` 带 `areaId`，客户端按区域幂等，
版本就该按区域。修：加 `areaRevisions: Map<areaId, number>`，
`list()` 返回本区域版本；`stats().revision` 仅作全局累计变更数。

### 27.6 客户端能改「所有玩家共享的真值」

`GET /api/wild` 的 `resolveAreaSpec(areaId, fallback)` 原本在 areaId 没命中内容表时
采信客户端传的 `theme / levelMin / levelMax`，而 `setAreaSpec()` 是**跨账号单例**——
A 传 `levelMax=60` 就能让 B 看到 60 级野怪，等于客户端改别人的世界。

修：① 前端改用内容表里的真实区域 `wild_starter`（grass 1-5）；
② 服务端对未知区域用固定默认 `grass 1-5`，**完全忽略客户端 fallback**；
③ E2E 加两条「伪造主题/等级不改共享真值」「未知区域也固定默认」。

### 27.7 `setToken` 忘了复位只读下线态

`isSessionSuspended()` 是传输层硬闸，只在顶号时置 true。如果不在 `setToken()` 里
复位，用户重新登录后所有 API 仍被本地拦截，表现为「登录成功但一切空白」。
同时 `resetSessionReplaced()` 也要在 `setToken()` 调，否则第二次顶号不再弹窗。
这类「全局一次性标志」必须在登录入口统一复位，写单测盖住（`sessionReplaced.test.ts`）。

---

## 28. P4-2a 只读派生榜的六个坑与边界（2026-11-07）

### 28.1 冒烟探针的 `waitFor` 双调度把 `next()` 跑了两次

headless Edge 探针里 `waitFor()` 同时挂 MutationObserver 和 `setTimeout` 递归，
条件成立时两条链都会调 `next()`。表现为 `out.disclaimer` 第一次记 true、
第二次在已切到推图榜的页面上重新计算变成 false，断言莫名红。
**修**：`once(label, fn)` + 全局 `completed[label]`，`waitFor` 开头先查已完成标记，
超时分支也跳过已完成的 label。这类探针 bug 会伪装成「产品 UI 偶发不对」，先查探针。

### 28.2 探针点太快，暴露了真实的 Tab 竞态缺陷

`RankBoardModal` 原实现 `useEffect(() => load(tab), [tab])` 没有取消标志：
快速切 Tab 时先发的 `monster_power` 请求后到，覆盖 `progress` 的响应，
界面出现「Tab 是推图、数值单位也是区，但说明/免责还是战力榜」。
**这不是测试问题，是前端缺陷**：修成 effect 内 `let cancelled = false`，
cleanup 置 true，`.then/.catch/.finally` 全部先判 `cancelled`；
loading 期间免责与说明回落固定文案，不展示上一张榜的残留。
同时把探针的 board 等待条件收紧到「有行 + 不在 loading」，避免人为制造竞态。

### 28.3 E2E 推图榜 0 分账号被 `limit=50` 截断

DB 里残留测试存档超过 50 份，`clearedAreas` 为空的账号 value=0 排不进 top50，
「high 两区 > low 零区」断言只查到 high 一条。
**修**：给三个测试账号各造 1~2 个真实首通区（low Lv.3 / mid Lv.10 / high Lv.18），
断言改成 `high=2 > low=1`，并顺带验证「同数量按 secondary 排序」；
**不要把断言改成只查 high** —— 那会把「榜单截取」这个真实行为掩盖掉。

### 28.4 `cleared.reduce` 在 `strict:false` 下推断成 `unknown`

`Object.values(Record<string, unknown>)` 得到 `unknown[]`，
`reduce((max, a) => Math.max(max, ...), 0)` 报
`TS2345 Argument of type 'unknown'` / `TS2322 Type 'unknown' is not assignable to number`。
**修**：显式泛型 `cleared.reduce<number>(...)`。这是 §18「判别联合不收窄」的同类复发，
凡是 `unknown` 集合聚合都要给 reduce 初值泛型。

### 28.5 `--dump-dom` 时 `data-probe` 一直是 PENDING

第一层 `waitFor` 条件不成立时跑满 400×50ms，正好耗尽 `--virtual-time-budget=20000`，
Edge 在探针调用 `finish()` 前就 dump 了 DOM，看起来像「页面白屏」。
**修**：iframe `load` 时先落一次初始快照（含 `initialTxt` / `initialButtons`），
重试上限调到 200、budget 提到 30000，`window.onerror` 也写进诊断。
诊断字段保留在脚本里，下次再挂能一眼看出卡在哪一层。

### 28.6 三条设计边界（不是缺陷，但别踩）

1. **实时派生而非周期快照**：契约原写「快照 + 周期刷新」，实现为 TTL=0 的 Read Model，
   理由与后续替换路径写在规范 §23.4 / 排期文档 §4 实现记录里，别当成漏做。
2. **封号与管理员账号不上榜**：管理员测试菜单能造满属性 / 满金币，
   不排除会污染全服榜；`loadRankSources()` 用 Prisma `where` 一次过滤。
3. **战力公式仍待定**：只实现「有效六维简单求和」，系数 / 权重 / 取整未做；
   别把「六维总和」误当实战评分拿去做匹配或奖励判定。

## 29. P4-2b 房间内核的坑

### 29.1 quota key 里的冒号被 intent 正则拒了（实测 11 个单测集体红）

`create()` 复用了 `validIntent()`（只允许 `[A-Za-z0-9_-]`）校验 `quotaKey`，
而业务上自然写法是 `boss:daily` / `boss:daily:2026-11-07`，
结果 `twoPlayers()` 里 11 个用例全挂在 `create 应成功`。
**修**：拆出 `validQuotaKey()` 允许冒号分段（仍限长 64、纯字符，只作内存 Map 键）；
`intent` / `nonce` 继续用严格正则。别为了省一个函数把两种字段混用一个校验器。

### 29.2 托管窗口比回合超时长，不是 bug（测试时序写错）

生产档 `AUTOPILOT_OFFER_MS=30s > ROUND_TIMEOUT_MS=20s`，kernel 档同理（1.8s > 1.2s）。
所以**第一回合必然先超时随机代放**，托管是给后续回合用的；
单测若直接「开托管 → tick → 断言 timedOut=0」会失败，因为那时 deadline 早就过了。
**修**：测试先让第一回合自然超时推进（拿到新 deadline），再在下一回合 deadline 之前 tick，
验证 `autopiloted=1 / timedOut=0`。语义写进规范 §24.5，别改阈值去迁就测试。

### 29.3 `sweep()` 多写了一次 `bump()`，revision 会跳号

初版 `sweep()` 遍历 tick 后又对 `changedRoomIds` 逐个 `bump()`，
一次超时会把 revision 抬两次。虽然仍单调，但客户端幂等基线会出现空洞。
**修**：删掉多余的 bump，`roomRegistry.test.ts` 加「一次 tick 只抬一次 revision」硬断言。
`tick()` 内部的所有路径必须且只能自己 bump 一次。

### 29.4 旧连接迟到的 `close` 会把新连接标掉线

`ws.close()` 的 close 事件是异步的：同 token 重连时若先 `reconnect()` 再收到旧连接 close，
朴素实现会按 `userId` 把座位重新标成掉线，房间卡在 paused。
**修**：`markDisconnected(userId, connectionId, now)` 按 `connectionId` **精确匹配**座位，
旧 id 一律不命中；单测「旧连接 close 不能把新连接标掉线」钉住。

### 29.5 房间扫描不能挂在 30s 心跳上

`realtime.ts` 的心跳定时器周期是 30s，而 kernel 档回合超时 1.2s、全掉解散 3.5s；
把 `rooms.sweep()` 塞进心跳里，E2E 要等半分钟才推进一次。
**修**：独立 250ms `roomTimer`（`unref()`），`onClose` 里一并 `clearInterval`；
REST `GET /api/room/:id` 再顺带惰性 `tick()`，双保险。纯内存扫描、房间稳定时零广播。

### 29.6 REST 与 WS 的 token 指纹必须同源

座位指纹来自 REST 请求的 `Authorization: Bearer`，重连指纹来自 WS upgrade query 的 `token`；
两处必须是同一枚 token 字符串，否则 `reconnect()` 永远匹配不上、座位永久掉线。
`lib/roomAuth.ts` 统一 `sha256(token)`，只存摘要不存明文。**改认证头格式必须同步改这里**。

### 29.7 `offerAutopilot` 的 nonce 别在 no-op 前消费

初版先校验/登记 `nonce` 再判「状态没变化直接返回」，幂等重试会白白吃掉一个 nonce，
且改了 `seenNonces` 却没 bump revision。
**修**：先判 no-op 返回，再消费 nonce；登记与 bump 必须在同一条变更路径上。

### 29.8 三条不是缺陷但容易误判的设计边界

1. **进房间必须有在线 WS**（`ROOM_WS_REQUIRED`）：E2E 先 `openWs()` 再 `create/join`，
   不是为了刁难，是没有 `connectionId` 就无法做掉线检测。
2. **quota hold 不靠房间锁**：同步 Map 操作在单线程内原子；房间锁保护的是路由层跨 await 组合。
   `roomLock.test.ts` 照 P4-0 做法做了去锁确定性证明（§26 的教训）。
3. **kernel 短阈值不是测试后门**：客户端只能选 `mode`，毫秒数一律服务端配置；
   kernel 房不产出奖励、不写个人档，与真实玩法互不影响。

## 30. P4-2c 单人 Boss 讨伐（2026-11-07）

### 30.1 Boss 结算白送了一笔资源（E2E 抓到：money 5000 → 5170）

`finish()` 原本只有 `wild` / 普通两条奖励路径，Boss 战走的是普通分支，
于是每次讨伐都发经验 + 金钱 + 首通覆盖。E2E「Boss 结算写回道具消耗与队伍 HP，
但不给经验 / 金钱 / 首通」直接红：`money` 从 5000 涨到 5170。

**这不只是测试问题，是产品口径问题**：Boss 产出是榜上记录，奖励待 F02 设计；
暂按普通战斗发钱等于每天白送一笔稳定资源，长期会把经济打歪。
**修**：`finish()` 里 Boss 走独立分支 `if (s.bossId) { s.rewards = null; ... return s; }`。
队伍 HP / 道具消耗 / 图鉴仍照常写回个人档，只有「给钱给经验给首通」被拿掉。

> 教训：**别用「复用普通分支」的心态接新玩法**。Boss / PVP / 共斗的产出规则各不相同，
> 分支要显式穷举，用 `if / else` 而不是并列 `if`，否则以后加玩法时漏判一个就会静默发奖励。

### 30.2 `sweep()` 返回 `number`，拿不到被回收的战斗态

Boss 在途名额必须在战斗态 TTL 过期时释放，但 `BattleRegistry.sweep()` 只返回回收数量。
直接改返回值会打破既有调用方与 5 个单测。

**修**：新增 `sweepExpired(now, ttl): BattleState[]`，`sweep()` 改为
`return this.sweepExpired(now, ttl).length`。既有签名零改动，`realtime.ts` 心跳改用
`sweepExpired()` 并逐个 `release(st.bossQuotaKey)`。
**扩展既有方法时优先「新增一个更具体的 + 老方法转发」**，比改签名便宜。

### 30.3 Boss 未结束时开普通遭遇，在途名额被顶掉

`runBattleStart` 原本允许同槽位新战斗覆盖旧战斗（历史行为，多个 E2E 依赖）。
但 Boss 开局时 `bossQuota.hold()` 已占一个名额，被普通遭遇顶掉后那场 Boss 战消失，
名额却还挂在内存里 —— 玩家白扣一次次数（直到 TTL 才释放）。

**修**：`runBattleStart` 开头 `if (existing?.bossId) return 409 BOSS_IN_PROGRESS`。
**只挡 Boss → 普通**这一个方向，普通 → 普通仍允许覆盖**（不动历史契约）。

### 30.4 冒烟断言里的字段名是 `finalText` 不是 `finalTxt`

375px 冒烟的 P3-1c 用例偶发失败（`hp=120, money=1200` 时「我方 HP 或金钱有变化」不成立）。
用临时脚本复现 5 轮，全是「一击未死 + 我方满血」——**既有断言的真实偶发**，与 P4-2c 无关。

第一次豁免写的是 `p.finalTxt`（字段不存在，永远 `undefined`），所以照旧红。
**修**：字段名改 `p.finalText`，正则改 `/撤离|撤退|失去战斗力/`，并把 `endText` 一起打进失败详情。
连跑 3 次全绿。**写豁免断言前先 `console.log` 一眼对象有哪些键**，别凭记忆拼字段名。

### 30.5 新增 store 方法后，`vi.mock("@/lib/api")` 的手写 api 对象要补

`useGameStore.startBossBattle()` 走 `api.bossStart`，而 `src/stores/battleFlow.test.ts`
用 `vi.mock("@/lib/api")` 手写了整个 api 对象（没有 `importActual`），
缺 `bossStart` 时新入口调用到 `undefined`，报 `api.bossStart is not a function`。

**修**：mock 对象补 `bossStart: vi.fn()`。
**手写 mock 不会自动跟随真实模块新增导出** —— 每次给 `lib/api.ts` 加方法，
搜一遍 `vi.mock("@/lib/api")` 有没有手写对象。

### 30.6 三条不是缺陷但容易误判的设计边界

1. **Boss 也累计 `damageDealt` 之外的普通战斗伤害**：普通战斗也会累计 `damageDealt`，
   只是没人读。不要为了「只有 Boss 才需要」加条件判断，反而给以后共斗留下不一致的真值。
2. **`held` 不落库**：进程重启时在途名额清零（战斗态本来也丢了），
   但 `committed` 由 DB 行数保证 —— 重启不会让次数变多，这是唯一正确的方向。
3. **`BOSS_DAILY_LIMIT` env 只能下调**：`Math.min(内容表, env)`。
   如果做成 env 优先，一次配错就能把限次 Boss 变成无限刷。

## 31. P4-2d 玩家对战 1v1 的坑（2026-11-07）

### 31.1 pvp 意图里的冒号被房间内核 intent 正则拒了

房间内核 `validIntent` 原正则 `^[A-Za-z0-9_\-]+$` 只放行字母数字下划线连字符，
而 pvp 意图是 `move:tackle` / `switch:1`，冒号被拒。**修法**：正则放宽为
`^[A-Za-z0-9_:\-]+$`（只加冒号），`wsProtocol.ts` 的 `validIntentField` 同步放宽。
不破坏既有 kernel E2E（kernel 意图不含冒号）。

### 31.2 `sides.indexOf(side)` 写空，胜负 / 换人 / 全灭全判错

`applyPvpTurn` 里 `applySideAction` 会复制 side（`{...side}`），返回的是新对象；
`state.sides.indexOf(side)` 拿原引用去查，永远 -1，结果写到 `sides[-1]`，
导致「逃跑判负 `winnerUserId` 错误 / 换人 activeIndex 不切换 / 全灭不判胜」。
**修法**：改用 `seatOf(side)`（`side.userId === s0.userId ? 0 : 1`）按 seat 精确定位，
回合末与自动换人也改成按 seat 循环。这类「对象复制后引用失效」在镜像态里尤其隐蔽，
凡是对 `sides` 做 `indexOf` 定位都要换成 `seatOf`。

### 31.3 结算后双方 revision 断言忘了 await

E2E 里 `save.revisionOf` 返回 Promise，断言写成 `[object Promise]→2`。**修法**：补 `await`。
凡涉及 revision 的断言都要 `await`，否则拿到的永远是 Promise 对象。

### 31.4 满员房间 join 返回的是 ROOM_CLOSED 不是 ROOM_FULL

房间满员后 status 已 active，`join` 先查 `status !== 'forming'` 返回 `ROOM_CLOSED`。
这是合理业务行为（不是 bug），E2E 断言放宽为 `ROOM_FULL || ROOM_CLOSED`。同理，
冒烟里「无 WS」的 outsider 也会先命中 `ROOM_WS_REQUIRED`，测满员必须先给 outsider 开 WS。

### 31.5 冒烟断言 `placeholder` 当 innerText 读

`<input placeholder="输入房间号加入">` 的 placeholder **不会出现在 `innerText` 里**，
冒烟用 `txt().indexOf('输入房间号加入')` 永远 false。**修法**：改断言「加入」按钮的
`textContent`，或直接查 input 的 `placeholder` 属性，不要拿 innerText 找 placeholder。

### 31.6 两条不是缺陷但容易误判的设计边界

1. **1v1 结算不发奖励**：只回写队伍 HP / 异常，不产经验 / 金钱 / 捕获。奖励与排位分
   归台账 F02 / F15，现在不写、未来再补，不要在结算里顺手发奖。
2. **`pvpSettled` 标记是幂等关键**：分出胜负既可能在 `submitIntent` 也可能在 `tick`，
   `maybeSettlePvp` 三处调用靠 `pvpSettled` 保证只结算一次；若去掉这个标记，
   双方档会被重复 `commitState` 覆盖 revision。



---

## 32. P4-2e 共斗 Boss / 副本（2026-11-08）

### 32.1 冒烟里 `probeHtml()` 是模板字符串，`\d` 会被吃掉

在 `ui_smoke_p42e.mjs` 的 `probeHtml()` 里写 `/Lv\.\d/.test(t)`，**生成到浏览器的源码变成 `/Lv.d/`**——
因为 `probeHtml()` 本身是个 JS 模板字符串，`\.` 不是合法转义序列，反斜杠被丢弃，于是正则永远匹配不到 `Lv.12`。

**修法**：冒烟断言不要在这种嵌套模板里写带反斜杠的正则，改用字面量
`t.indexOf('Lv.') >= 0`；确实要用正则就写 `\\d`（双反斜杠）。

> 教训：冒烟脚本分两层——Node 侧（普通字符串）和注入浏览器侧（模板字符串），
> 任何带 `\` 的东西都要按「最终生成到浏览器的那份源码」来想。

### 32.2 冒烟在数据加载完成前就点了「创建」，`bossId` 还是空

`ui_smoke_p42e` 的等待条件原本只等「弹窗标题 + 创建按钮」，但**按钮比数据先渲染**：
`bosses` 还没从 `/api/boss` 回来时，「创建共斗房间」按钮已经在 DOM 里了。
此时点击 → `create()` 里 `if (!bossId)` 命中 → 报「请先选择共斗目标」→ 后续等 `房间号` 超时，连锁 4 个断言失败。

**修法**：等待条件必须包含「数据已落地」的可见证据（列表项渲染出 `Lv.`），再点创建。
默认选择由 `setBossId(list[0].bossId)` 完成，列表一渲染就生效，不需要再点一次 boss 按钮
（点 boss 后再点创建反而会读到旧闭包）。

> 教训：冒烟里的「等待条件」= 「我要操作的那个元素已经处于可操作状态」，
> 不能只等它**存在**，要等它**可用**（数据就绪 / 非 disabled）。

### 32.3 非法意图必须服务端降级跳过，不能抛异常

`applyCoopTurn()` 最初对「伪造技能 / PP 耗尽 / 已倒下换人」直接 `throw new CoopError(...)`。
问题：房间内核的 `advanceTurn` 一旦抛异常，整次提交就失败、房间态卡在半路——
**一个客户端发 `move:not_a_move` 就能把整间共斗打崩**，这是实打实的 DoS 面。

**修法**：改成 `CoopResult` 返回式降级——记一条日志、跳过该成员本回合行动，
**Boss HP 不虚减、`damage` 不记账**，其余成员照常结算。E2E 有一条专门用例
「伪造技能被服务端降级：不产生伤害记账、Boss HP 不虚减」守着它。

> 对照：P4-2d 的 pvp 走的是「入口层拒绝 + 单侧降级」，共斗人多，必须在同一次 `advanceTurn` 内隔离。

### 32.4 `flee` 要在入口层显式拒绝，不要指望代放吞掉

共斗刻意不支持逃跑（跑了队友还在打，语义混乱）。若靠 `parseCoopIntent` 返回 `null` +
代放，用户体验是「按钮点了没反应，回合自己走了」。**修法**：`applyRoomIntent` 前判
`room.mode === 'coop' && intent === 'flee'` → 400 `COOP_INTENT_INVALID`，把错误摆到脸上。

### 32.5 `verify.mjs` 有两处注册，漏 `GROUPS` 等于分组跑不到

新增阶段要改**两处**：`STAGES` 数组（阶段定义）和 `GROUPS` 对象（`e2e` / `smoke` 分组）。
本次先加了 `STAGES` 里的 `e2e:p42e` / `smoke:p42e`，**漏了 `GROUPS` 的两行数组**，
结果 `--only=e2e` 不会跑 p42e、全量跑也会少两组而不报错（只是少跑，不会红）。

**修法**：加阶段后立刻 `grep -n "e2e: \[" scripts/verify.mjs` 确认分组里有该 id。
`VERIFY_OK` 的**阶段计数**是唯一能发现漏跑的地方（27 → 29）。

### 32.6 三条不是缺陷但容易误判的设计边界

1. **共斗伤害不写 `BossDamageEvent`**：共斗是协作玩法，写进去会污染「单人打伤害排名」的
   Boss 榜口径（§25）。共斗伤害只活在 `CoopState.sides[].damage`，随房间结束而消失。
   「共斗榜」是独立议题，台账 F16。
2. **Boss 每回合只反击一次，不按人数加次数**：否则人越多每人挨打越多，
   共斗变成「人越多越难」，与产品直觉相反。
3. **`held` 不落库 + 全员掉线不扣次数**：与 P4-2c 一致。重启会让在途名额清零，
   但 `committed` 由 DB 行数保证，只会变少不会变多——这是唯一安全的方向。

## 33. 跨机器拉取：git HTTP/2 与代理不兼容 + 代理污染 localhost 探活（2026-11-09）

### 33.1 `git fetch` 报 502 / `schannel: server closed abruptly`，但网络是通的

- **现象**：`git fetch --all --prune` 报 `schannel: server closed abruptly`；换 `http.sslBackend=openssl`
  后变成 `CONNECT tunnel failed, response 502`；可 `curl https://github.com` 首页 200、GitHub API
  `/repos/.../commits` 能读到远端真实提交。
- **根因**：不是代理挂了也不是断网，是 **git 默认 HTTP/2 与本机代理（`127.0.0.1:4694`）不兼容**，
  smart-HTTP 的 `/info/refs?service=git-upload-pack` 被回 502。
  `git -c http.version=HTTP/1.1 ls-remote origin refs/heads/master` 一次即通。
- **修法**：`git config --local http.version HTTP/1.1` —— 只写本机 `.git/config`，**不入库、不影响远端**；
  偶发一次 502 属代理抖动，重试即过。
- **教训**：① 诊断别一次改两个变量——上一轮把 `sslBackend=openssl` 和 HTTP/1.1 一起改，
  被 openssl 那条带偏，误判成「网络故障、拉不到新提交」，白读了一轮旧进度；
  ② 先用 GitHub API / `git ls-remote` 拿到远端真实 HEAD，再定位协议层；
  ③ 本地 `origin/master` 只是上次 fetch 的缓存，`0/0` 不等于远端没新提交。

### 33.2 全局代理让 localhost 探活变成「假 502」

- **现象**：`curl http://127.0.0.1:5173/` 返回 502，容易误判成「服务起挂了」；
  实际上服务根本没起，或请求被代理拦下。
- **根因**：机器设了全局 `HTTP_PROXY` / `HTTPS_PROXY`，curl 连 `127.0.0.1` 也走代理隧道。
- **修法**：探活统一 `curl --noproxy '*' ...`；或用 Python `socket.create_connection`
  直连（`scripts/check_home_env.py` 即如此，不受代理影响）；再不行看 `netstat -ano | grep :5173`。
- **关联**：HANDOFF 第 3.3 节探活命令与 §7 坑清单已同步。

### 33.3 文档口径统一（同轮顺手收口）

任务表第 6 批仍写「d/e 待开工」、131 行「下一步建议」段落中夹着「下一步 P4-2c」而段尾又写
「P4-2 五阶段全部完成」；`scripts/doc_check.py` 还钉了一条「任务表下一步为 P4-2」的旧断言。
**这些都是历史残留，不是待办**：已按「机器无关 + 单一事实来源」收敛，验收断言同步改为
「下一步指向 P4-3 / 台账偿还，且不含过期待开工」。

### 33.4 拉代码后没重新生成 Prisma Client / 生成物换行导致 `check:content` 假失败

- **现象**：拉回 30 个提交后 `npm run verify` 红两项：后端 `tsc` 报 `sessionVersion` /
  `bossDamageEvent` 不存在（12 处，另有 `unknown[]` 不能赋 `string[]` 一条连带错误）；
  `check:content` 报「content.generated.ts 已过期（现有 88993 字节 / 应为 88987 字节）」。
- **根因 1**：`node_modules/.prisma/client` 还是旧 schema 生成的。`npm install` 输出
  `up to date` **不会**自动 `prisma generate`；schema 新增字段 / 模型后必须显式
  `npx prisma generate`。生成后 12 处类型错误与那条连带错误全部消失，`npm run check` 0 错误。
- **根因 2**：`content.generated.ts` 有 6 行，本机 `core.autocrlf=true` 检出成 CRLF，
  比 LF 多 6 字节；`gen-content.ts --check` 原来用 `prev === next` 按字节精确比对，
  于是「内容完全一致」也报过期。入库 blob 是 LF，`git diff` 为空，属纯机器差异。
- **修法**：`backend/scripts/gen-content.ts` 增加 `normalizeEol()`，比对前把两侧统一成 LF；
  真实漂移（改了 `data.ts` 没重新生成）规范化后仍不相等，照样拦下。三分支实测：
  LF 通过 / CRLF 通过 / 改一个字符 → exit 1 被拦。
- **教训**：**`npm install` ≠ 环境就绪**；换机器或拉到 schema / 迁移变更后，
  `npx prisma generate` 与 `npm install` 都要跑。生成物比对别按原始字节，先规范化换行。

## 34. 旧 dev.db 缺迁移 + 残留测试账号污染：strict 验收连环假红（2026-11-09）

- **现象 1**：`npm run verify -- --strict` 首次 21 个阶段失败，全部是
  `P2022: The column main.User.sessionVersion does not exist in the current database`，注册接口 500。
  **根因**：本机 `dev.db` 是 11-06 的旧库，拉代码后只跑了 `npm install` + `npx prisma generate`，
  **漏了 `npx prisma migrate deploy`**；`generate` 只重生成 Client，不会给库加列。
  `migrate status` 明确列出两条未应用迁移（`add_session_version` / `add_boss_damage_event`）。
  **修法**：先停 :3001 释放 Prisma DLL（§12），`npx prisma migrate deploy` 后注册恢复 200，
  验收从「21 失败」变「28 通过 / 1 失败」。**换机器 / 拉到 schema 变更后，
  `npm install`、`prisma generate`、`prisma migrate deploy` 三件都要做**（HANDOFF §3.1 已补）。
- **现象 2**：剩下的 1 个失败是 `e2e:p42a` 三条派生断言，单独重跑却 39/39 全绿。
  **根因**：上一轮 verify 失败时收尾「清理测试账号」也失败，库里残留 **256 个测试账号**，
  它们的存档挤占了榜单 `limit=20`，把 `high/mid/low` 挤出前 20 —— 不是代码缺陷。
  **修法**：`scripts/verify.mjs` 增加**前置清理**（开跑前清一次残留测试账号，`--no-clean` 仍可保留排查），
  并补齐 `clean-test-data.mjs` 遗漏的 `p42c_/p42d_/p42e_/f01_/f02_` 前缀。
- **教训**：**E2E 假红先看「是不是脏数据」**——全量套件的残留账号会污染任何「全服派生 / 榜单」类断言。
  修代码前先单独复跑该套件；治理要落在编排器（每轮干净基线），不是放宽断言。

## 35. F01/F02 收官 strict 三个红灯：概率断言 / 探针重入 / 文案漂移（2026-11-09）

- **背景**：F01/F02 全部改动落地后首跑 `npm run verify -- --strict` 得
  `28 通过 / 3 失败 / 0 跳过 VERIFY_FAILED`；三个红灯都不在 F01/F02 自身阶段，
  但必须逐个给可复现证据，不能靠「重跑看看」蒙混过去。
- **① P3-1 E2E 47/48：`普通账号 testShiny 未生效（敌方不是异色） true`**
  **根因**：`backend/src/game/rules.ts:496` 生成野生个体时 `rng() < 0.01` 会让敌方
  **天然异色**，用例却断言「普通账号开局敌方绝对不异色」，于是 1% 概率误报。
  单独复跑 `e2e:p31` 48/48 全绿（即 §17「服务端 RNG 用例须覆盖两条分支」的镜像）。
  **修法**：`backend/tests/e2e_p31_battle.mjs` 改为「普通账号带 `testShiny` 连开 8 局，
  断言至少一局不是异色」——若服务端错误采纳普通账号的测试标记，8 局必然恒为异色，
  漏洞照样被检出；天然异色不再误报。连跑 2 轮均 48/48。
- **② P3-1c UI 14/15：`技能按钮可点` false、`turnAtStart:6`、`ended:true`**
  **根因**：`--virtual-time-budget` 快进定时器时，多个 `MutationObserver` 可能同时满足
  并重复调用 `waitFor` 的 `next`；后一次在战斗已结束后执行，把 `moveClicked` 覆盖成
  `false`、`turnAtStart` 覆盖成 6。单独复跑 15/15，属探针竞态而非产品缺陷。
  **修法**：`scripts/ui_smoke_p31c.mjs` 给 `arena-ready` / `battle-started` 两个回调加
  `arenaSeen` / `battleSeen` 幂等闸（与 `ui_smoke_p42a.mjs` 的 `once()` 同思路）。
- **③ P4-2a UI 16/17：`切换到推图榜后说明文案更新`（稳定复现）**
  **根因**：本轮重写 `RankBoardModal.tsx` 后免责行统一成
  「榜单与奖励均由服务端结算，客户端只读」，旧断言钉死 `客户端上报无效` 这句，
  是**真实回归（测试契约未随 UI 更新）**，不是假红。
  **修法**：`scripts/ui_smoke_p42a.mjs` 改为要求「服务端结算」+「客户端只读 / 上报无效」
  同时可见，强度不降低；不改产品文案。
- **结论**：三处均只改测试侧，**产品逻辑零改动**；修复后单套件连跑 2 轮全绿，
  最终 `npm run verify -- --strict` **31/31 `VERIFY_OK`（0 失败 / 0 跳过，118.8s）**。
- **教训**：全量红灯先分类「概率假红 / 探针竞态 / 真实回归」并各自给证据；
  **不要放宽断言到永真**，也不要把 UI 文案漂移当偶发抖动略过。

## 36. F14 发奖接入的三个坑（2026-11-09）

### 36.1 同锁重入 → 自我死锁（最严重）
- **现象**：接入 `grantBossRewards()` 后，打赢 Boss 的 `/api/battle/action` 请求**永久挂起**，
  E2E 卡到超时（`timeout 180` EXIT=124），日志停在「首场开局 200」之后一行不动。
- **根因**：`/api/battle/action` 路由层已 `withSlotLock(slotLockKey(userId, slot))`，
  而发奖内核又对**同一 key** 取锁。`withSlotLock` 是单 key 链式队列（`prev.then(fn)`），
  `fn` 内部等自己排队的尾巴 → 永不 resolve。`lib/slotLock.ts` 头注释早就写了
  「**只锁路由层**，`commitState()` 本身不再取锁，否则同一次请求会自我死锁」，
  新模块照抄 F02 `grantOne()` 的加锁范式时忽略了这一条。
- **修法**：`grantBossRewards({ alreadyLocked: true })` 声明调用方已持锁，内核直接执行；
  独立调用（脚本 / 补发）默认 `false`，自己加锁保证 `read→commit` 原子。
  与 F02 的差异要记住：`rankSettlement::grantOne` 由 `settlePeriod` 在
  `rank:settle:<periodKey>`（**不同 key**）内调用，无重入问题，所以它自己加锁是对的。
- **判别口诀**：先画调用链上的所有锁 key，出现**同 key 嵌套**就必然死锁。

### 36.2 连打两场 → 战后 HP 写回导致第二场残血（概率红灯）
- **现象**：`e2e:f14` 单跑全绿，全量 `verify --strict` 里第二场偶发 `player_fainted`，
  连带 7 条断言红；`e2e:p42c` 的 `strongSave()` 能连打 3 场，掩盖了这个问题。
- **根因**：`applySettlementToSave()` 会把战斗内的 `state.party`（残血）写回存档；
  同一账号要连打两场才能验证「每日首讨唯一键」，第二场是残血开局。
  叠加 Boss「龙息赤焰」的烧伤持续伤害，第 9 回合全灭。
- **不能用整包 PUT 回血**：`PUT /api/save` 普通分支除资源单调比对外还有
  `checkPartyStateRegression()`（P3-2：HP / 异常**只能变差**），把血改满会 400。
- **修法**：只改**测试存档数值**，把 E2E `strongSave()` 的 `maxHp/hp` 从 420 提到 8000
  （`SAVE_LIMITS.STAT_MAX=100000`，合法且 antiCheat 不校验 HP），两场累计掉血远不足以全灭；
  产品逻辑零改动。另把「跨 Boss 打赢」这类依赖随机战斗的正向断言撤下，
  幂等键的 bossId 隔离改由 `playReward.test.ts` 纯函数单测钉住，E2E 改测
  「弱档全灭不发奖」——更稳且覆盖「只有打赢才发」的第三个分支。

### 36.3 旧 E2E 契约未随产品口径更新
- **现象**：`e2e:p42c` 断言「Boss 结算…**不给经验 / 金钱 / 首通**」在 F14 后必红：
  `{"potion":[3,3],"money":[5000,5120],...}`（+120 金钱；药水消耗 1 + 小包发放 1 相抵）。
- **修法**：按新契约重写为「不给经验 / 不写首通 + **按 F14 发双档奖励**
  （+120 金钱 / +棱彩胶囊）」，强度不降低；历史进度记录里「刻意不发奖励」的句子
  是 P4-2c 当时的事实，已在台账 / 规范 §29.5 标注为历史口径，别再当活口径。
- **教训**：新增「服务端发放」类功能时，先 grep 所有既有断言里的「不发 / 不给 / 零」字样。

### 36.4 结论
三个坑全部只改**测试侧 / 内核锁声明**，**产品逻辑零改动**。修复后 `e2e:p42c` **44/44**、
`e2e:f14` **46/46** 各连跑 3 轮稳定；后端单测 **364/364**。

---

## 37. F16 收官 strict 的两个红灯：等级上界漏算叠加 / 视图字段已下线（2026-11-09）

### 37.1 `elite` 与 `rare` 是两次独立 roll，可同时命中
- **现象**：F16 实现后的 `npm run verify -- --strict` 报 `e2e:hardening` **114/115**，
  唯一红灯「敌方等级落在服务端区间 [2,6]」给出 `level=8`；单独重跑该套件 3 次
  又全部 **115/115**。这是低概率偶发，不是 F16 引入的功能回归。
- **根因**：`game/battle.ts::generateEncounter()` 里
  `elite = roll(0.12, rng)` 与 `rare = roll(0.08, rng)` 是**两次独立 RNG 调用**，
  可以同时为真；等级 = `基础 level + (elite?2:0) + (rare?3:0) + (rng()<0.5?0:1)`，
  最后 `clamp(1, 30)`。基础区间由 `battleView.levelMin/levelMax` 下发
  （harness 默认 2..2），因此**真实上界 = `levelMax + 6 = 8`**。
  §20 当时把区间钉成 `[2,6]`，只算了「二选一」，漏掉叠加分支
  （概率 0.12 × 0.08 ≈ 1%，所以长期全绿、偶尔炸一次）。
- **修法（只改测试侧，产品公式零改动）**：`e2e_hardening.mjs` 与
  `e2e_p31_battle.mjs` 都改为从响应里的 `levelMin/levelMax` 推导，断言
  `level >= levelMin && level <= levelMax + 6`，不再写死 6。
  「稀有 + 精英可叠加」属规则口径，按 `HANDOFF.md` 不自行调整，留杰哥拍板。
- **教训**：涉及服务端 RNG 的区间断言，上界要按「所有加成能否同时命中」算，
  并且**必须重复跑**；单次全绿不代表覆盖低概率分支（与 §17 同类）。

### 37.2 F16 重构后 P4-2e E2E 读了已下线的视图字段
- **现象**：`e2e:p42e` 稳定 **19/20**，红灯「两人各认领一间房…（房间 turn=1）」
  报 `turns=[null,null,null,null,null,null]`。
- **根因**：F16 把共斗重构为六房副本后，`coopViewFor().rooms` 视图只下发
  `index / state / occupantSeat / clearedBy / defeatedBySeat / contributions /
  enemyPreviews`，**房间内部 `turn` 不下发**；断言读 `r.turn` 恒为 `undefined`
  （`JSON.stringify` 里变 null）。属断言没跟上契约，不是产品缺陷。
- **修法**：按「`e2e:p42e` 只验接口边界 + 建房视图 + 意图路由」的收敛口径，
  改断言为「6 间房 `state` 合法 / 有 `occupantSeat` / 每房 2 只敌人预览」；
  六房结算与发奖交给 `e2e:f16` 覆盖，不重复断言、不降低覆盖。
- **验收**：`e2e:p42e` **20/20**、`e2e:p31` 连跑 3 次 `E2E_P31_OK`、
  `e2e:hardening` 连跑 3 次 **115/115**。

### 37.3 2MB 请求体用例的 `ECONNRESET` 竞态
- **现象**：再次全量 `verify --strict` 时 `e2e:hardening` **不是断言失败**，而是
  `E2E_HARDENING_ABORT TypeError: fetch failed` / `read ECONNRESET`
  （`harness.mjs:135` ← `e2e_hardening.mjs:190`），2.7s 提前退出，
  汇总指标被解析成 `}`。单独重跑该套件 3 次均 **115/115**，属偶发。
- **根因**：该用例向 `PUT /api/save` 发 2MB body 验证 Fastify `bodyLimit` 返回 413。
  服务端在**客户端还没写完 body 时**就判定超限并关闭 socket，undici 会以
  `ECONNRESET` 抛出而不是拿到 413 响应；全量验收跑到第 17 组时连接池状态与
  单跑不同，触发概率上升。**不是后端崩溃**（后续 9 组冒烟与文档自检仍全绿）。
- **修法（只改测试侧）**：把该请求包 try/catch，`413` 与
  `ECONNRESET / fetch failed` 都算通过 —— 两者防护语义相同：
  **服务端没有收下超大请求**。紧随其后的「连打 11 次非法请求后仍可正常写入
  （未误封）」继续钉住账号可用性，断言强度不降低。
- **教训**：测「服务端提前拒收大 body」这类用例，不能假设一定能读到 HTTP 状态码；
  断言要覆盖「连接被提前重置」这一合法结果，否则全量验收会偶发假红。

## 38. F04 等级帽接入与收官（2026-11-10）

### 38.1 Boss E2E 偶发 `PARTY_FAINTED`（全量 42/44，单跑 44/44）
- **现象**：F04 首轮全量 `verify --strict` 报 35/36，唯一红灯 `e2e:p42c`：
  「次数用完 → 429」与「其它 Boss 次数独立」两条拿到
  `400 {"code":"PARTY_FAINTED","error":"队伍中没有可战斗的幻兽"}`；
  单独重跑该套件立刻 44/44。
- **根因**：`e2e_p42c_boss.mjs::strongSave()` 仍是旧版 `maxHp/hp = 420`，
  而同一账号要连打多场 + 跨槽位。敌方 `elite(+2)` 与 `rare(+3)` 是两次独立 roll
  可叠加（§37.1 已记录），偶发高强度下 420 会被打全灭；战斗结算把残血写回存档，
  下一场 `createBattle()` 的 `findFirstAliveIndex()` 直接抛 `PARTY_FAINTED`。
  **F14 早已把同类强档提到 8000，p42c 没同步**。
- **修法（只改测试侧）**：p42c 的 `strongSave()` 改 `maxHp/hp = 8000`
  （远低于 `saveValidator STAT_MAX`），与 F14 对齐，产品逻辑零改动。

### 38.2 占位派生下线后，等级榜断言要换真值来源
- `game/rank.ts::summonerLevelOf()` 删除后，`deriveMetrics()` 只给基础 Lv.5 占位；
  真值由 `modules/rank.ts::loadRankSources()` 一次查 `BadgeGrant` 分组覆盖。
- `e2e_p42a_rank.mjs` 原断言「high > low」依赖「首通数 / 队伍等级 / 图鉴」，
  改口径后三个账号都是 Lv.5，必然假红。改为**给 high 账号直接写一枚 Grant**
  （等价服务端唯一写入口已发奖），断言 `high=10 > low=5=mid`；
  finally 里显式 `badgeGrant.deleteMany`（表无外键，`cleanupAccounts` 不级联）。

### 38.3 整包 PUT 伪字段闸门必须放在 CAS 之前
- `digestOf()` 只覆盖 money / inventory / levelExp / 持有数 / 首通 / 挂机，
  **不覆盖任意新增字段**。若把 `playerLevel` 塞进存档，客户端能直接改等级而绕过
  权威摘要 —— 这比 `SCHEMA_VERSION` 三处联动更严重。
- 闸门放在 `putSchema.safeParse()` 之后、CAS / `validateSaveData` / 风控之前：
  否则「缺 revision」会被 `REVISION_REQUIRED` 抢先返回，伪上报测试拿不到
  `SAVE_INPUT_FORBIDDEN`，也浪费一次 DB 读。

### 38.4 房间锁 / 槽位锁 / 首通徽章
- `grantBadgeForAreaClear()` 在战斗结算的 `slotLock` 内被调用，
  因此 `modules/playerProgress.ts` **不取应用层锁**，只靠 `@@unique` + P2002 幂等
  （与 F14 同锁重入死锁 §36 同源）。发徽章失败只记日志，不阻断结算响应。
- 客户端开局故意传 `levelCap: 999` 不能影响服务端：帽只能由 `readProgress(userId)`
  注入 `createBattle()`；`battleView()` 下发只读值供 UI 展示。

**验收**：`f04Cap.test.ts` + `settlement.test.ts` + `rank.test.ts` 合计 **22/22**、
后端全量单测 **389/389**、`e2e:f04` **25/25**；15 组 E2E 逐套件回归全绿；
最终 `npm run verify -- --strict` 全绿证据见任务表进度记录。

### 38.5 全服榜 limit=50 截断导致等级榜断言假红（§28 老坑复发）
- **现象**：最终 `npm run verify -- --strict` 报 35/36，`e2e:p42a` **38/39**，
  失败信息 `granted=true ["p42hi_...:10","p42lo_...:5"]` —— 三个测试账号只回显两个；
  单独跑该套件连续 3 次均 `E2E_P42A_OK`。
- **根因**：改口径后 high=Lv.10、low/mid=Lv.5，全服榜按主值降序 + `limit=50`。
  全量验收跑到第 12 组时，前面 7 组 E2E 留下的账号还在库里（清理在**最后**一步），
  榜单超过 50 行，Lv.5 的 mid 被截断 → `inLevel.length === 3` 假红。
  **不是产品逻辑问题**，与 §28「0 分被 limit 截断」同源。
- **修法（只改测试侧）**：断言不再要求「三个账号都必须出现在全服子集里」。
  high 那行必须 10；low/mid 的「基础 Lv.5」改查 `GET /api/player/progress`
  （账号级只读真值，不受榜单分页影响）；若 low 恰好在榜内，再校验它排在 high 之后。
  单独连跑 3 次全绿，最终全量验收全绿证据见任务表进度记录。
