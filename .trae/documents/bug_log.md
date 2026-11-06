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
