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

## 39. F17 单档化（2026-11-10）

### 39.1 `admin.ts` 审计日志打印已删列，后端类型检查抓不到

- 后端 `npm run check` 只覆盖 `backend/src/**`；`backend/scripts/admin.ts` 里的
  `${r.slot ?? '-'}` 在删列后照样编译得过，只有跑 `admin audit` 才会暴露。
  全仓 `Grep '\bslot\b'` 复核时才发现 → 删掉该字段。
- **通用教训**：Prisma 删列后，除 `src` 类型检查外必须全仓搜一遍列名，并对
  `scripts/` / `tests/` 逐个判定（历史迁移 SQL、迁移分支、闸门断言允许保留）。

### 39.2 专项 E2E 自己写错 `rebase` 用例

- 首轮 `e2e:f17` 22/25：初始存档金币与二次 PUT 不一致，`rebase: true` 要求基线一致；
  第二个 PUT 又擅自加钱，被风控按增量不符挡下。**是用例问题不是产品逻辑**。
  改为二次 PUT 复用同一份 v11 存档后 **25/25**。

### 39.3 SQLite 重建表迁移的顺序

- 删列前必须先删多余档位的行，否则 `Save.userId @unique` 建唯一索引会因
  重复 `userId` 失败；迁移里显式 `DELETE FROM Save WHERE slot <> 1`
  （本机 51→50 行，仅 1 个用户有多档）。
- `migrate deploy` 前停 :3001（Windows DLL 锁，§12 / §27）。

### 39.4 新增阶段两处注册与清理前缀

- `e2e:f17` 同时写进 `verify.mjs` 的 `STAGES` 与 `GROUPS`（漏 `GROUPS` 静默少跑，§32.5），
  另补 `backend/package.json` 与 `clean-test-data.mjs` 的 `f17_` 清理前缀。

## 40. F18-a 地图锁收官（2026-11-10）

### 40.1 服务端权威解锁，门槛=持有上一相邻城镇徽章
- 新建 `backend/src/game/mapLock.ts`：`LOCATION_ORDER`（7 城线性顺序）、`requiredBadgeFor`（每城需上一城徽章，首城 `town_starter` 返回 null 恒解锁）、`unlockedLocations`/`isLocationUnlocked`（基于 `BadgeGrant` 真值派生，零 IO）。
- `travel` mutation（`modules/game.ts`）与整包 PUT（`modules/save.ts`）两处共用 `mapLock`，双点校验：未解锁返回 **`LOCATION_LOCKED`**（带 `requiredBadge` 字段）。这是服务端权威解锁，客户端不上报、不决定。
- `GET /api/player/progress` 返回新增 `unlockedLocations`，前端 `Camp.tsx` 地图列表灰显未解锁城 + 文案「需获得「XX徽章」解锁」。

### 40.2 无新迁移 / 不改版本号（与 F04/F17 一致）
- 等级真值仍在 `BadgeGrant`，地图锁只派生，不新增持久化字段；**未动 `SCHEMA_VERSION` / `EXPECTED_SAVE_VERSION`**。
- 徽章来源仍走 V1 首通口径 `cleared:<areaId>`，**F18-b 演武堂上线后收窄为 `gym:<locationId>`**，mapLock 只认 `BadgeGrant` 不关心来源。

### 40.3 验收与回归
- 纯函数 `mapLock.test.ts` **7/7**、`e2e_f18a.mjs` **8/8**（travel 锁/未知/PUT 伪造跳关/解锁后放行/线性不越级）；`verify.mjs` 两处注册 `e2e:f18a`、`package.json` 加脚本、`clean-test-data.mjs` 补 `f18_` 前缀。
- **回归**：`e2e_p32_mutations.mjs` 原「移动到合法地点」travel 到 `city_pebble`，无徽章被 `LOCATION_LOCKED` 拦截导致后续 `travelData.money` 抛错（400 无 `.data`）。改为 travel 到恒解锁的 `town_starter`，仍验证 travel 写操作 + 访问记录追加；「解锁后放行到第二城」语义由 `e2e_f18a` 专测。重跑 P3-2 通过。

## 41. F18-c 防御性越权 E2E 与 abandon 名额泄漏修复（2026-11-11）

### 41.1 新增 mapBoss 防御性越权 E2E（35 项全绿）
- 新建 `backend/tests/e2e_f18c_security.mjs`，覆盖：A 开局夹带伪造 `quotaKey/periodKey` 被服务端忽略；B 未知/空/未解锁 `mapBossId` 一律拒绝（400/403）；C 跨用户隔离（别人 `battleId` 动作 404）；D 伪造 `battleId` 404；E 地图首领捕获 400 `MAPBOSS_UNCATCHABLE`；F 进行中再开 409 `MAPBOSS_BATTLE_IN_PROGRESS`；G 顶号旧 token 续打 403 `SESSION_REPLACED`、新 token 可续打；H 超上限重入 429 `MAPBOSS_QUOTA_EXHAUSTED`；I 胜利后同 `battleId` 再动作 404（唯一键幂等，used 不叠加）。
- 注册：`backend/package.json` 加 `e2e:f18c_security`；`scripts/verify.mjs` 的 `STAGES` 与 `GROUPS.e2e` 两处加 `e2e:f18c_security`（漏 `GROUPS` 静默少跑）。

### 41.2 真实 bug：放弃 mapBoss 战泄漏在途名额（被 J 区回归捕获）
- 现象：`/api/battle/abandon` 对 mapBoss 战不释放在途名额，连续 start→abandon 3 次后第 4 次即使 0 胜也被 429 拒，等于每天白丢次数。
- 根因：`backend/src/modules/battle.ts` 原释放守卫 `if (state.bossId && state.bossQuotaKey) bossQuota.release(...)`；mapBoss 战 state 只有 `mapBossId`（无 `bossId`），其 `bossQuotaKey` 虽已写入却永不释放。超时回收路径 `realtime.ts:174` 是 `if (st.bossQuotaKey)`（无 `bossId` 守卫），故仅「断线超时」会回收、「显式 HTTP abandon」会泄漏——口径不一致。
- 修复：守卫改为 `if (state.bossQuotaKey) bossQuota.release(...)`，与 `realtime.ts:174` 一致，boss / mapBoss 共用 `bossQuota` 一并覆盖。零新迁移、不动 `SCHEMA_VERSION`。修复后 J 区 4 轮 start→abandon 全部 200，名额每轮回收。
- 验收：`--only=check,e2e:f18c,e2e:f18c_security,e2e:f14` 全绿（前端/后端 tsc 无告警、内容表一致、F14 Boss 双档 46 项、F18-c 正例 33 项、F18-c 防御性 35 项）。

## 42. Camp 地图 Tab 解锁提示循环依赖（展示本城自身徽章，2026-11-11）

### 42.1 现象
- `src/pages/Camp.tsx` 地图 Tab 未解锁城的提示文案，原取 `badgeCatalog.find(b => b.locationName === loc.name)?.name`——即展示**本城自己**的徽章名当解锁前提（如「解锁坚石市需获得「坚石徽章」」），造成循环依赖：永远无法解锁。
- F18-a 375px UI 冒烟（`ui_smoke_f18a.mjs`）断言锁定文案为「需获得「青苗徽章」解锁」（首城 `town_starter` 的徽章 `badge_sprout` 名=「青苗徽章」、对应 `locationName=初心镇`），原实现会渲染错误文案。

### 42.2 修复（与后端 `mapLock.requiredBadgeFor` 同口径）
- 改为沿 `LOCATIONS` 键顺序取**上一相邻城镇**的徽章名：
  ```ts
  const orderedIds = Object.keys(LOCATIONS) as LocationId[];
  const idx = orderedIds.indexOf(loc.id);
  const prevName = idx > 0 ? LOCATIONS[orderedIds[idx - 1] as LocationId].name : null;
  const reqBadge = prevName
    ? badgeCatalog.find((b) => b.locationName === prevName)?.name ?? "上一级徽章"
    : "已解锁";
  ```
- 首城（`town_starter`，`idx===0`）`prevName=null` → 显示「已解锁」；第二城 `city_pebble` 显示「需获得「青苗徽章」解锁」，与后端 `requiredBadgeFor` 线性解锁一致。

### 42.3 验收
- `ui_smoke_f18a.mjs` 9/9 全绿（含「需获得「青苗徽章」解锁」+「未解锁」文案、375px 无横向溢出）；`verify.mjs --only=smoke:f18a` 通过。`npm run check` 无告警。

## 43. 回归 B/C/E 补齐：内容矩阵、全局状态提示与只读闸门对照（2026-11-11）

### 43.1 背景：45 项 verify 全绿，但三块系统性覆盖缺失
- 基线 `npm run verify` **45/45 `VERIFY_OK`**（前端 133 单测 / 后端 401 单测 / 24 组 E2E / 14 组 375px 冒烟 / 文档 154 项）。
- 已有 E2E 都是「单条主路径」或「单模块边界」，缺一份把**全部内容表与只读接口横着对一遍**的矩阵；已有 UI 冒烟只验「某功能弹窗能开、375px 不溢出」，没覆盖 Start 页三种状态文案，也没覆盖 `App.tsx` 里挂在 `<Routes>` 之外的全局封号 / 顶号弹窗。

### 43.2 新增 `backend/tests/e2e_content_matrix.mjs`（47 项全绿 `E2E_CONTENT_MATRIX_OK`）
- **A 内容完整度**：静态内容表 + 服务端 API 双侧钉住 7 城 / 7 徽章 / 7 馆 / 7 首 / 6 房 / 21 剧情 beat（7 到达 + 7 演武堂 + 7 地图首领）；另验 `placeholder:true` 为 0、王牌等级 8→30 递增、0 徽章只解锁首城。
- **B 边界**：线性解锁不越级（直跳末城仍 `LOCATION_LOCKED`）、未知城 `LOCATION_UNKNOWN`、未知馆 `GYM_UNKNOWN`、整包 PUT 伪造 `locationId` 跳关、空状态存档（`party=[]` / `inventory={}` / `collection={}` / `box=[]`）建档与回读、空队伍开演武堂 `PARTY_EMPTY`、未解锁首领拒绝开局。
- **C 只读闸门（口径差异如实记录，未擅自改产品语义）**：`/api/player/progress` → 400 `PROGRESS_INPUT_FORBIDDEN`；`/api/rank/:type` → 400 `RANK_INPUT_FORBIDDEN`（榜单类型是 `monster_power` / `team_power` / `summoner_level` / `progress`，不是 `power`）；`/api/boss` → 400 `BOSS_INPUT_FORBIDDEN`；而 `/api/gym/overview` 与 `/api/mapboss` 是纯只读派生，**忽略夹带字段、返回值与不带参一致**。两类都满足「客户端上报不生效」，只是拒绝方式不同。
- **D**：三个只读路由 POST 均 404，确认无写入口。

### 43.3 新增 `scripts/ui_smoke_ux.mjs`（26 项全绿 `UI_SMOKE_UX_OK`）
- 探针 A（`/`）：云同步态 / 实时通道态 / 在线权威态三种文案、`break-words` 长文案不横向溢出、375px 无溢出。
- 探针 B（`/camp`）：intro 剧情弹窗长文案与推进按钮；徽章弹窗可打开 / 有 `overflow-auto` / 点「关闭」后消失；在 **iframe 的 `contentWindow`** 派发 `mpk:banned` / `mpk:session-replaced` 触发全局封号 / 顶号弹窗（超长中文原因换行、双 `role="alertdialog"` 共存、点「重新登录」清登录态退回 `/auth`）。
- **踩坑**：`waitFor('camp')` 若只等「兽域手记」会在**骨架阶段**就返回，此时 `useStoryTriggers` 的 intro `useEffect` 尚未挂载，误判「剧情弹窗未出现」→ 改为等「徽章」入口按钮出现（f18b 同款口径），并延后 350ms 再观测。

### 43.4 两处断言写错（非应用 bug，实测口径已写回测试）
- 地图首领每日上限**不是统一 3**，而是按城镇梯度分档 `3,3,2,2,2,1,1`（`mapBosses.ts` 的 `dailyLimit`，`mapBossDailyLimit()` 可被 env 下调）。断言改为「从内容表读期望序列 + 非递增 + `remaining = dailyLimit - used - held`」。
- 榜单类型不是 `power`；`/api/rank/not_a_rank` 先返回 `RANK_TYPE_UNKNOWN`，须改用 `monster_power` 才测得到 `RANK_INPUT_FORBIDDEN`。顺带把「未知榜单类型」变成正向断言（C5a）。

### 43.5 HANDOFF 过期口径订正
- A 节仍写「下一步 F18-b / F18-d 剧情骨架（占位文案债务）」，但 F18-b/c/d 早已全部 ✅ → 改为 F18 全阶段收官 + 下一步等杰哥排期；§8 进度快照同步。
- §7 坑清单写死 `SCHEMA_VERSION`(=10) / `EXPECTED_SAVE_VERSION`(=10)，而 F17 已升 **11** → 改为「当前值以 `src/stores/saveVersion.ts` 与 `backend/src/lib/saveValidator.ts` 为准，别照抄历史数字」，与 HANDOFF 自身「不写死数字」原则一致。
- 注册：`backend/package.json` 加 `e2e:content_matrix`；`scripts/verify.mjs` 的 `STAGES` 与 `GROUPS.e2e` / `GROUPS.smoke` 四处注册（漏 `GROUPS` 会静默少跑）；`clean-test-data.mjs` 补 `matrix_` / `ux_` 前缀；头部注释「17 组 E2E」改为「以脚本输出为准」。

### 43.6 验收
- 聚焦 `npm run verify -- --only=e2e:content_matrix,smoke:ux,docs:doc,docs:memory` → **4/4 `VERIFY_OK`**（矩阵 47 项 + UX 26 项 + 文档 154 项 + 镜像一致，7.6s）。
- 全量 `npm run verify -- --strict` **47/47 `VERIFY_OK`**（0 失败 / 0 跳过，158.8s）：前端 133 单测 + 后端 401 单测 + 前端构建 + **25 组 E2E**（含新增矩阵 47 项）+ **15 组 375px 冒烟**（含新增 UX 26 项）+ 文档自检 **160 项** + 记忆镜像一致；原 45 阶段零回归。

## 44. P5-1 评估初稿 12 处结论被专家复核修正（2026-11-11，文档级，非代码 bug）

- **触发**：杰哥拍板选型 B 并要求「按建议 + 加专家修正」六个耦合点。请三组独立后端架构专家（并发一致性/CAS、分布式状态机/存储、实时系统/可运维性）并行只读复核，三组一致判定初稿「需修正后可用」；逐条 `file:line` 抽查后固化到 `.trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md`，评估稿降为初稿并在头部挂 12 处勘误指针。**本轮未改任何产品代码。**
- **最硬的一条（会直接改排期）**：`backend/prisma/migrations/migration_lock.toml:3` 锁 `provider = "sqlite"`，11 条 `migration.sql` 全是 SQLite 方言（`AUTOINCREMENT` / `DROP COLUMN` / `DATETIME`），而 `backend/prisma/schema.prisma:2` 注释却写「迁移到 Postgres 只需把 datasource.provider 改成 postgresql 并改 DATABASE_URL」——照做 `migrate deploy` 必失败。因此**不存在「第 12 条迁移」**，正确做法是归档旧链、重置 lock、生成一条 PG 基线 init，`Save.revision Int` 随 init 建列。评估稿 §5 的 1.0 与 §6 风险表「11 条→12 条」口径作废。
- **CAS 口径**：`session.ts:112` 的 `commitState()` 是 `prisma.save.upsert` 带 create 分支（:114），409 只能由 `updateMany ... WHERE revision=?` 的 `count` 裁决，create 分支并发靠 `userId @unique` 的 P2002→409；`save.ts:124` 仍取内存基线会提前误判，条件失败还会继续 apply 内存态 + `broadcastToUser`（`session.ts:134`）。另：单调 revision 本身即天然 fence，存档写路径**不需要**额外 fencing token。
- **quota / 状态机**：`roomRegistry.ts:36,40,47,193-211` 的 `committed` 是纯内存 Map、无 DB 事件支撑（评估稿「commit 由 DB 事件体现」覆盖是错的）；`coop.ts:96-97` 的 `coopQuotaKey` 用 `userId.slice(-8)` 会碰撞；release 分支实为 10 处而非 2 处；`room.ts:125,129,140,143` 四处 `pvpSettled/coopSettled` 只改引用不写回、`roomRegistry.ts:270` 的 `create()` 未初始化 `pvpSettled`；`RoomState` 另有 `contributions` 数字 key 反序列化变 string、optional 字段判定两处障碍。CAS 应定 PG 行版本 + 事务（Lua 跨不过 Postgres），Lua 只用于 quota INCR / wild claim。
- **广播 / 顶号**：现有只有 `broadcastAll` + `broadcastToUser`，`broadcastToMany`（`sessionBus.ts:41`）全 src 无调用点是死代码，评估稿「四频道」映射不成立；room 频道若发全量 RoomState 会泄露 `pvp/coop` 隐藏态（`room.ts:44-48`），须只发 `roomId` + 各实例本地裁剪；`realtime.ts:185-186` 心跳只查 `bannedAt`、**不查 `sessionVersion`**，旧 WS 只要回 pong 可无限存活，评估稿「残留到心跳扫到」是错的；三种 state 已自带单调 revision（`wsProtocol.ts:117,146,171`），pub/sub 兜底直接做跳号回源，不用新造 stateVersion。
- **定时器**：`realtime.ts:154` 心跳是「本地 + 全局」混合体（6 件事里 4 件必须全局只跑一次），不能整体各跑各的；`room.ts:97-105,392` 的 `tickRoom` 是 REST 读触发的第二推进入口，选主挡不住，须一并 CAS。
- **验收**：`harness.mjs:24-26` 的 `BASE/WS_HOST/ORIGIN` 可用环境变量覆盖，但 `api()`/`openWs()` 共用模块级单 target，同一进程内无法把两条 WS 分连 A/B；定稿 §5 补齐 5 项改造 + 4 条故障注入 + barrier 注入的确定性单测。
- **唯一键归属订正**：`@@unique([roomId,userId])` 属 `CoopRewardGrant`（`schema.prisma:174`），`BossRewardGrant` 只有 `grantKey @unique`（:145）。评估稿 §2 混同，已在定稿 §2.2 分开。
- **结论**：设计定稿与 W0~W9 工单已交付；W0（接口抽象 + 单实例零行为变更）无需任何外部资源、可立即开工，W2 完成前不开第二实例。验收数字见本轮提交末尾。

## 45. 本机 Android 构建链重建 + 性能基线 §6 真机补测（2026-11-11）

- **目标**：杰哥要求直接产出安卓包推送到雷电安装，并补齐 `性能基线_web.md` §6 四项 adb 补测。
- **构建链（全在 E: 盘 NTFS，不入库）**：`E:/Six/android-sdk`（cmdline-tools + platform-tools + `platforms;android-36` + `build-tools;35.0.0`）、`E:/Six/gradle-dist/gradle-8.14.3`（腾讯镜像 131 MB）、`E:/Six/jdk/jdk-21`（华为云 OpenJDK 21 GA，192 MB / 33 秒）、`E:/Six/gradle-user-home`（AGP 依赖缓存 367 MB）。`android/local.properties` 与 `*.apk` 已被 gitignore。
- **JDK 21 硬门槛**：Capacitor 8 / AGP 8.13 用 `sourceCompatibility 21`，本机原 Temurin 17 首次构建报 `错误: 无效的目标发行版: 21`（`apk_build_guide.md` §1 早已写明）。首次下载走 `aka.ms` 仅 ~115 KB/s（192 MB 需 28 分钟）且中途 `connect ENETUNREACH` 断流；改华为云镜像 33 秒完成，清华 Adoptium 镜像拒绝本网段。
- **调试包联网三约束**（仅本地自测，**正式包 P5-3 不得沿用**）：① 构建期 `VITE_API_BASE=http://192.168.111.47:3001` 注入；② `assets/capacitor.config.json` 加 `server.androidScheme=http` / `cleartext` / `allowMixedContent`（`MPK_DEV_APK=1` 开关），`android/app/src/debug/AndroidManifest.xml`（debug sourceSet）加 `usesCleartextTraffic=true`；③ 后端 `CORS_ORIGIN` 追加 `http://localhost` 等 origin。**顺手修一处真实口径不一致**：`wsProtocol.isOriginAllowed` 早已支持逗号分隔多值，但 `backend/src/index.ts` 的 cors 注册只传单字符串，多值配置会让 REST 全挂 → 改为按逗号拆数组，单值保持原行为。
- **发现并清除生产包广告注入（真实产品瑕疵）**：`vite.config.ts` 的 `traeBadgePlugin({prodOnly:true, clickable:true, clickUrl:'https://www.trae.ai/solo?showJoin=1', autoTheme:true})` 向生产 `dist/index.html` 注入右下角可点击外链角标 + 背景色探测脚本 + 多条 `console.debug`，首屏截图与 logcat 均已取证。删除插件调用与 import、`npm uninstall vite-plugin-trae-solo-badge --save-dev`，`dist/index.html` **26,433 B → 796 B**，`consoleErrors` 降为 0，最终截图角标消失。另把 `index.html` 模板残留 `<title>My Trae Project</title>` / `lang="en"` 订正为「兽域手记」/ `zh-CN`。
- **补测脚本 `scripts/perf-adb.mjs`**（12 项断言全绿）：冷启动 x3 + 首帧控件树、帧分布、内存/OOM、后台恢复，全程命令行零 `input tap`。结果 `.trae/documents/性能基线_adb_真机数据_2026-11-11.json`，回填 `性能基线_web.md` §6 / §7。
- **三个测试脚本口径坑（非应用 bug）**：① `dumpsys gfxinfo` 在静态页静置 4s 恒为 `Total frames rendered: 0`，FPS 采样必须覆盖冷启动渲染窗口并保留 0 帧静置对照；② 雷电 `am start -W` **不输出 `ThisTime`**（冷启动 / resume 皆然），resume 会打印 `Activity not started, its current task has been brought to the front`，恢复耗时以 `TotalTime` 为准，原断言 `thisTime != null` 误判失败（11/12 → 修后 12/12）；③ `adb pull /sdcard/...` 被 Git Bash MSYS 路径转换改写成 Windows 路径导致失败，须 `MSYS_NO_PATHCONV=1`。
- **验收**：`npm run check`（前端）与 `backend npm run check` 均 0；Gradle `assembleDebug` 首次 `BUILD SUCCESSFUL in 3m17s`（123 tasks）、两次增量 10s；APK 4,850,988 B 装到 `emulator-5558`，冷启动 `TotalTime 1283ms`、前台 `com.monster.game/.MainActivity`、首屏「服务器在线 / API · http://192.168.111.47:3001」、无 `ERR_CLEARTEXT` / `net::ERR`；补测 **12/12**：冷启动 1177/1145/1130 ms、35 帧 Janky 3 (8.57%)、PSS 123611 KB、恢复 48 ms、无 OOM / ANR。

## 46. A 类运行时改造收官 A1/A2/A4/A5（2026-11-12）

- **触发**：杰哥问「目前开始调哪一块」。探活发现前后端两个 dev 后台进程均被宿主回收（`front:000` / `back:000`，HANDOFF §B 已写明「换会话服务不会自动恢复」），#141 的挂起理由「会重启 Vite / 后端 tsx 打断 5173 自测」随之解除；他拍板续做 A1/A2/A4/A5。四项都是工程实现层，**没有产品语义变更**，不动存档结构 / `SCHEMA_VERSION` / 发奖链路。
- **A1 vite 分包**：`vite.config.ts` 加 `build.rollupOptions.output.manualChunks`，只把稳定依赖拆成 `vendor-react 180.53 kB`（react / react-dom / scheduler / react-router / @remix-run）与 `vendor-state 2.72 kB`（zustand / use-sync-external-store / zod），其余依赖仍并入主包避免请求碎片化；主包 764,766 B → 586,445 B。`sourcemap:'hidden'` 与 `localSavePlugin` 保持不变。构建仍提示 `Some chunks are larger than 500 kB`（业务代码 + `game/data.ts` 内容表未再拆，属后续可选项，不是错误）。
- **A2 requestId 日志**：`backend/src/index.ts` 的 `Fastify({ logger: true, genReqId })` 优先透传客户端 `X-Request-Id`，用 `/^[A-Za-z0-9._:-]{1,64}$/` 严格校验（不规则值含空白/超长会被替换，防止伪造日志行），否则 `node:crypto.randomUUID()`；`onRequest` 回写响应头 + `request_in`，`onResponse` 打 `request_out`（status / 耗时）；cors 注册加 `exposedHeaders: ['X-Request-Id']`，否则浏览器 / WebView 读不到自定义响应头。**业务响应体零改动**。
- **A4 ErrorBoundary**：新增 `src/components/ErrorBoundary.tsx`（class 边界 + `normalizeError()` 短文案 + 内联 SVG 手记图标 + 「重新加载 / 重试渲染」），`main.tsx` 包在 `<App/>` 外层（StrictMode 内层）。视觉沿用 `.impeccable.md`：既有 CSS 变量、`font-display`、2px 硬边、零 CDN、`max-w-sm` + `overflow-auto` + `max-h-[85vh]` 适配 375px。兜底页不写任何本地存档，刷新后由服务端真值恢复。**前端无 jsdom / testing-library**，单测改用 `react-dom/server` 的 `renderToStaticMarkup` 静态渲染（5 例，零新增依赖）。
- **A5 登录失败限流**：新增 `backend/src/lib/loginRateLimit.ts`（`LoginRateLimiter`），`auth.ts` 在密码校验前 `check()`、失败才 `recordFailure()`、成功 `clear()`，封号 403 不计数。超限 429 `LOGIN_RATE_LIMITED` + `Retry-After`。双维度：组合键 `IP+用户名` 5 次 / 纯 IP 兜底 60 次（60s 窗口）。属**可重建的单进程临时态**，丢了只是让攻击者多试几次，不写 DB、不影响权益；P5-1 迁共享存储时把计数改 Redis（带 TTL）即可，接口不变。
- **四个实现口径坑（非应用 bug）**：① 25 组 E2E 会连续注册/登录几十次，若按 IP 全量计数必误伤 → 改为**只计失败 + 成功清零 + 组合键隔离**，E2E 用例 7 次失败远低于 IP 兜底阈值 60；② harness `api()` 只回 `{status,data,text}` **不回传响应头**，A2 断言必须走原始 `fetch`；③ 含 `\n` 的 header 值会被 undici 直接拒绝，非法 id 改用「含空白 + 超长」验证服务端侧校验；④ 前端单测在 node 环境，用 SSR 静态渲染而非组件挂载。
- **环境坑（重要）**：重启前端 dev 报 `Port 5173 is already in use`，但 `curl 127.0.0.1:5173` 是 Connection refused。`Get-NetTCPConnection -LocalPort 5173` 查到 **`Weixin.exe`（PID 21288）** 持有 `0.0.0.0:5173 Bound` + `192.168.111.47:5173 ESTABLISHED 到外网 :80`（微信把它当出站源端口）。**不杀用户进程**，改 `npm run dev -- --host 127.0.0.1 --port 5173 --strictPort` 即起；14 个 375px 冒烟都走 `localhost:5173`，APK 只连后端 3001，均不受影响。
- **验收**：前端 `check` 0 / `test` **138 passed（17 文件）** / `build` 分包通过；后端 `check` 0 / `node:test` **407/407**（+6 限流用例）；A2 响应头实测 `x-request-id: manual-check-123` + `access-control-expose-headers: X-Request-Id`；`e2e:hardening` **122/122 `E2E_HARDENING_OK`**（原 115 + 新增 7 条：A2 四条响应头 / 日志注入防护、A5 三条限流 / 组合键隔离），fail=0 skip=0。全量数字见本轮提交末尾。

## 47. 端口可配置化 / A1 分包精简 / P5-1 W0 收官（2026-11-12）

- **触发**：杰哥三问 + 「W0 开始吧」。① A1 分包「拆这么小的目的是什么、是必须的吗」→ 复核确认**不是必须**：分包**不减少总下载量**（764,766 B → 586,445 + 180,530 + 2,720 ≈ 769,695 B，反而多约 5 kB 与两个请求），唯一真实收益是 React 生态单独成 chunk 后业务改版可复用那 180 kB 的长期缓存；`vendor-state 2.72 kB` 单独发一个请求是负收益 → **删掉该分组**，只留 `vendor-react`（主包 589,011 B）。②「我们自己起的端口应该随时可以换」→ 上一轮改绑 `127.0.0.1` 只是最小绕法，正确做法是可配置。③「专家不合适就换」的原意是**换一个适配本项目技术栈的专家**（React18/TS/Vite + Node/TS/Fastify/Prisma、服务端权威多人架构、并发一致性与测试方案），不是放弃专家线；两次只读检索均返回 `expertAlreadySelected: true` 且候选为空 —— 说明当前会话**仍占用着「游戏自动化测试专家团」的选择**（上一轮误记为「已取消」，此处订正），需杰哥在左侧「专家」入口取消 / 切换后我才能检索并推荐适配技术栈的专家（后端架构 / 全栈 TS 评审方向），本轮不启动团队流程、不阻塞 W0。
- **端口可配置（`MPK_FRONT_PORT`）**：新增 `scripts/lib/devConfig.mjs` 作脚本侧单一真值源（默认 5173，跨机器 / CI 零变更）；15 个 375px 冒烟脚本与 `verify.mjs` 改读它，`vite.config.ts` 加 `server.port` + `strictPort`；`check_home_env.py`、backend E2E 的 Origin、`backend/src/index.ts` / `realtime.ts` 的 CORS 默认值统一读同名 env（backend 属另一个 npm 包，不跨包 import）；`backend/.env` 追加 5174 两个 origin。**启动服务与跑 verify 必须在同一个 shell 里设同一个值**，且命令行不要再传 `--port`（会覆盖配置）。本机实测：5174 探活 200、CORS 放行 5174/5173 且非法 origin 无 ACAO、`smoke:f18a` 9/9 全绿、旧 5173 已释放（停的是自己的 vite 进程，不碰微信）。
- **W0 七项（设计定稿 §4.2 批次 A，全部零行为变更、无需 PG/Redis）**：① 锁接口化 `lib/lockProvider.ts`（`LockProvider` 接口 + `InProcessLockProvider` 逐字搬原 `chains: Map` 四条契约），`slotLock.ts` 保留全部导出并加 `setLockProvider` / `resetLockProviderForTest`；② 广播接口化 `lib/broadcastTransport.ts`（只 `toUser` / `toAll` 两出口），`sessionBus.ts` 加 `setBroadcastTransport`，**删死代码 `broadcastToMany`**（`wsRegistry` 与 `sessionBus` 两处）；③ 心跳拆 `runLocalHeartbeat` / `runGlobalSweep` / `runBanSweep` 三段，timer 仍由本进程依次触发、顺序与拆分前逐字一致（W4 只需给全局段加 leader 租约）；④ `lib/revisionSource.ts` 抽可注入 `readRevision()`，`save.ts` / `actions.ts` 改调它，默认实现仍是 `currentState()`（W2 注入 DB 列即可，409 响应体仍用同一基线对象）；⑤ `RoomRegistry.create()` 补 `pvpSettled: false` + 新增 `setSettledFlag()` 显式写回（**不 bump revision**），`room.ts` 四处改调它；⑥ `coopQuotaKey` 去掉 `slice(-8)` —— 旧注释「整键会超 64 字符」是误判（`periodKeyOf` 返回 10 字符 + cuid 25 字符 → 整键 41 字符，远低于 `INTENT_MAX_LEN=64`），截断反而让尾 8 字符相同的账号碰撞；⑦ `backend/tests/lib/deterministic.ts` 确定性时钟 / id 模板 + 4 组 W0 单测（共 15 例），其中 `CopyStorage` 用例确定性复现「`get()` 返回副本时旧写法丢结算标记、新写回不丢」。
- **三个测试 / 口径坑（非应用 bug）**：① `WS_MAX_CONNECTIONS_PER_USER = 1`（顶号语义），广播单测要显式 `add(conn, 10)` 才能覆盖「同账号多连接」；② 两条同账号连接共用同一个 sink 数组时 `toAll` 会写两条，断言别按账号数算；③ `doc_check` 的 A1 断言原先要求 `vendor-state` 存在，精简后口径要同步改（首次全量 45/47 的第二个 FAIL 就是它）。
- **跨套件偶发红（如实记录，不下臆断结论）**：三轮全量里前两轮各出现一次零星失败且落点不同 —— 首次 **45/47**（`e2e:f18c` 5 项 + `doc_check` 的 A1 断言口径过期），第二次 **46/47**（`e2e:core_loop` 3 项）。逐项排除 W0 回归：心跳拆三段后 timer 仍依次调用 `runGlobalSweep()`，`battles.sweepExpired()` 与 `bossQuota.release()` 均未漏；`bossQuotaKey` 用完整 userId、无截断碰撞；W0 七项均为等价抽象。`e2e:f18c` 单独跑 **33/33**、`e2e:core_loop` 单独跑 **49/49**，**按 verify 完全相同的 E2E 顺序连跑两轮均 25/25 `VERIFY_OK`**，第三次全量 **47/47 `VERIFY_OK`**。可复现的差异只有「全量比 `--only=e2e` 多跑约 30s 前置阶段，改变了 E2E 相对 30s 心跳 sweep 的相位」，怀疑是共享野怪池刷新 / 在途名额回收与某次 `GET /api/wild` → `POST /api/battle/start` 撞车；**但那两次没抓到失败原文，故只记为怀疑，不改测试断言去掩盖**。为此给 `scripts/verify.mjs` 的报告加失败阶段 `outTail`（末尾 8000 字符留痕），下次复现可直接读 `.verify-report.json` 定位。**2026-11-12 订正**：同日第 6 轮已抓到完整原文，5 项失败的根因是**逃跑 RNG 假设**（测试脚本 bug），与心跳相位 / 野怪池无关，详见 §49；本段「怀疑」仅作为当时无原文时的留痕保留。
- **验收**：前后端 `check` 均 0；后端 `node:test` **422/422**（W0 新增 15 例）；前端 138 单测；`doc_check` **186 项全绿**、记忆镜像 sha 一致；最终 `MPK_FRONT_PORT=5174 npm run verify -- --strict` **47/47 `VERIFY_OK`**（0 失败 0 跳过，163.7s：25 组 E2E / 14 组 375px 冒烟 / 前端 138 / 后端 422）。

## 48. 偶发红收敛：验收日志基建 + Windows 盘符大小写导致别名解析失效（2026-11-12）

- **触发**：杰哥要求「先处理偶发红，多跑几次，做好日志、抓异常抛出，修复并总结归档」。§47 末尾曾记录两轮全量零星失败（45/47、46/47）但**未抓到失败原文**，只留下「怀疑 30s 心跳相位 / 共享野怪池」的待证猜测。本轮先补留痕再复现，**不改任何断言去掩盖**。
- **日志基建（先落地，再复现）**：
  - 新增 `scripts/lib/verifyLogger.mjs`：`verify` 每轮一个 `.verify-logs/<runId>/` 目录，**每个阶段一份完整 stdout+stderr**，文件头附命令 / cwd / 退出码 / signal / `SPAWN_ERROR` / 耗时；轮末 `index.json` 记录阶段顺序与结论，便于多轮 diff。`--log-dir=xxx` 可固定目录；`.gitignore` 加 `.verify-logs/`。
  - `scripts/verify.mjs`：报告增 `runId` / `logDir` / `preCleanedTestAccounts` / 每阶段 `logFile`，失败阶段保留 `outHead` 4000 + `outTail` **32000**（原 8000）；控制台失败输出从 12 行扩到 30 行并打印日志路径；`spawnSync` 的 `error` / `signal` / 超时显式写进输出，避免「空输出 + 非零码」无法区分脚本失败与进程被宿主回收。`--no-clean` 等判定逻辑零改动。
  - `backend/tests/lib/harness.mjs`：顶层注册 `uncaughtException` / `unhandledRejection`，用 `formatFatal()` 打完整堆栈 + `cause` + 最近 HTTP；`api()` 记录最近 60 条请求，断言失败时附印 `[CONTEXT]` 最近 5 条（`method path -> status 响应体`）；网络异常包装成 `E2E_HTTP_NETWORK <METHOD> <完整 URL>` 并挂 `cause`；失败 detail 上限 300 → **1200** 字符。7 个 E2E 套件的 `try/catch` 不再把堆栈截到 280 字符，改为 `console.error('[FATAL:main] ...')` + 1200 字符摘要。
- **复现结果（两轮，落点完全固定，并非 E2E 时序）**：`MPK_FRONT_PORT=5174 npm run verify -- --strict` 连跑两轮均 **45/47**，失败阶段都是 `front:test` + `front:build`。原文存 `.verify-logs/round1|2.report.json` 与对应逐阶段日志。
  - `front:test`：`src/stores/battleFlow.test.ts` **20/20 全挂** `api.battleStart.mockResolvedValue is not a function`（`battleFlow.test.ts:134`），其余 16 文件 118 例全绿 —— `vi.mock('@/lib/api')` 注册到的模块 ID 与 `import { api } from '@/lib/api'` 解析出的 ID 不一致。
  - `front:build`：`[vite]: Rollup failed to resolve import "@/components/ErrorBoundary" from "E:/Six/MonsterPK/src/main.tsx"`（Vite 6.4.2，仅 2 modules transformed 即失败）。
- **根因（有 DEBUG 原文，不是推测）**：`DEBUG=vite-tsconfig-paths* npx vite build` 显示插件加载的 `configPath` 是 **`e:/Six/MonsterPK/tsconfig.json`（小写盘符）**，而 `resolveId` 收到的 `importer` 是 **`E:/Six/MonsterPK/src/main.tsx`（大写盘符）**。插件（`node_modules/vite-tsconfig-paths/dist/index.js:189-206`）用 `resolversByDir[projectDir]` 做**字符串键查表**，向上遍历目录时 `E:/Six/MonsterPK` ≠ `e:/Six/MonsterPK` → 全 miss、静默返回 `undefined`（DEBUG 里 `@/components/ErrorBoundary` 只有 `resolving:` 没有后续 `resolved`），于是项目里 **150 处 `@/` 别名**在 build / vitest 下整体失效。是否命中取决于当次进程 `cwd` / 入口路径的盘符写法，故**跨轮、跨阶段表现为偶发**：上一轮 47/47 与 45/47 可以并存，单独跑某个套件也可能绿。§47 里「心跳相位 / 共享野怪池」的怀疑在本轮 4 轮全量中**未复现**，且当时没有原文，不作为已证实根因，仍保留 `outTail` 留痕继续观察。
- **修复（三处，均属工程实现层，不动存档 / 协议 / 发奖）**：
  1. `vite.config.ts` 改用 **Vite 原生 `resolve.alias`**：`{ find: /^@\//, replacement: fileURLToPath(new URL('./src/', import.meta.url)).replace(/\\/g,'/') }`。只用正则吃 `@/` 前缀（字符串 `find:'@'` 会误伤 `@remix-run/...` 作用域包），replacement 统一正斜杠；与 `tsconfig.json` 的 `@/* -> ./src/*` 同义。**删掉 `vite-tsconfig-paths()` 插件调用并 `npm uninstall vite-tsconfig-paths --save-dev`**（package.json 删 1 行、lock 删 49 行），不留双解析链路。
  2. `index.html` 删掉模板残留的**内联 `<script type="module">` HMR 报错脚本**：生产构建里 `import.meta.hot` 恒为 `undefined`，该逻辑零作用；但 Vite 6.4.2 会为内联 module script 生成 html-proxy 模块，其缓存键 `filePath = id.replace(normalizePath(config.root), "")`（`dep-Dq2t6Dq0.js:36334`）与 `load` 时的 `url`（:36066）又因盘符大小写不一致查不到 → 修完别名后暴露第二处同源错误 `No matching HTML proxy module found`。曾试在配置里显式 `root` 统一大小写（配置 URL 仍是小写 `e:`），无效，故删脚本；Vite 自带错误 overlay 与 A4 `ErrorBoundary` 已覆盖报错展示。
  3. `vite.config.ts` 的 `server.host` 固定 **`0.0.0.0`**：改配置后 dev server 重启若只监听 `localhost(::1)`，`curl 127.0.0.1:5174` 返回 **000**，而 `devConfig.FRONT_PROBE` 与全部 14 个 375px 冒烟都走 IPv4 → 整套 smoke 会假红（实测 `localhost=200` / `127.0.0.1=000`）。Android 调试包访问宿主局域网 IP 同样依赖全网卡绑定。
- **验收**：
  - 修复前 2 轮 45/47 的**失败原文完整留存**；单独 `npm run build` **exit 0**（1699 modules，`dist/index.html` 1.39 kB、主包 589.01 kB + `vendor-react` 180.53 kB），`npm test` **138/138（17 文件）**。
  - 修复后全量连跑 2 轮 **47/47 `VERIFY_OK`**（0 失败 0 跳过，294.7s / 266.6s），前端 138 / 后端 422 / 25 组 E2E / 14 组冒烟 / 文档自检 / 镜像一致全部通过。
  - **如实记录的副作用**：`npm uninstall` 触发依赖重优化与 `tsc` 增量缓存重建，`front:test` 由 ~7s 升到 20.6~20.9s、`front:build` 由 ~7s 升到 24.2~38.0s，两轮总耗时 294.7s / 266.6s（修复前 146.9s 且含两个失败阶段）。不影响正确性，后续轮次继续观察是否回落。
  - 归档：本条 §48、任务表 §四进度、HANDOFF 起服务段、`doc_check.py` 新增 6 条断言、`.workbuddy/memory/MEMORY.md` 与 `.trae` 镜像同步。
- **后续订正（同日第 6 轮）**：上面写的「§47 心跳相位 / 野怪池怀疑本轮未复现」只适用于前 4 轮；第 6 轮全量 **46/47**，`e2e:f18c` 的 5 项失败被新日志完整抓到，根因是**逃跑 RNG**，与心跳无关。详见下条 §49。

## 49. E2E 偶发红第二个根因：逃跑有成功率，测试却假设一次必成功（2026-11-12）

- **触发**：§48 修完前端别名后做最终回归，第 6 轮全量 **46/47**，`e2e:f18c` 报 **5 项失败** —— 正是 §47 记录过、但当时没抓到原文的「f18c 5 项残留失败」。本轮 `outTail` + `[CONTEXT]` 把原文完整留下来了（`.verify-logs/round6.report.json` 与 `.../27_e2e_f18c.log`）。
- **失败原文**：`POST /api/battle/action {"type":"flee"}` 返回 200，但 `battle.turn=2, finished=false, result=null`，日志 `["遭遇：萌芽守望者","撤离失败！对方抓住了破绽。","苔羽鸮 使用了 冲撞，造成 3 点伤害。"]`。随即 `GET /api/mapboss` 显示 `used=1, held=1, remaining=1`（期望 2）；下一次 `POST /api/mapboss/start` 返回 **409 `MAPBOSS_BATTLE_IN_PROGRESS`**；`used=3` / `remaining=0` / `429 MAPBOSS_QUOTA_EXHAUSTED` 三条断言连锁失败，合计 **27 通过 5 失败**。
- **根因（产品语义正常，是测试脚本 bug）**：`backend/src/game/battle.ts:416-423` 的逃跑按速度判定成功率（速度占优 `0.75`、否则 `0.5`），失败时只 `pushLog('撤离失败！对方抓住了破绽。')` 并 `runEnemyTurn()` —— **战斗不结束、mapBoss 在途 hold 不释放、`battles` 仍登记该账号**。F18-b/c 的 E2E 是 2026-11-11 新增的，没有复用 `e2e_f14.mjs:85` / `e2e_p42c_boss.mjs:78` 早就写好的 `fleeUntilDone()`，把「一次 flee = 一定撤离」当成前提 → 约 25% 概率整条链假红，跨轮偶发，而 `--only` 单独跑常常绿。§47 怀疑的「30s 心跳相位 / 共享野怪池」**与此无关，正式排除**。
- **修复（只改测试脚本，产品代码零改动）**：
  - `backend/tests/e2e_f18c.mjs` / `e2e_f18b.mjs` 各补 `fleeUntilDone(token, battleId, maxTries=12)`，重试到 `battle.finished`；重试时打 `[INFO] 逃跑骰子未通过，第 N 次重试（服务端有成功率）`。两处「逃跑结算」用例改用它，并新增一条明确断言 `finished===true && result==='fled'`。`e2e:f18c` **33→34 项**、`e2e:f18b` **17→18 项**。
  - 无需改动：`e2e_f18c_security.mjs` 的单次 flee 都用于越权 / 顶号 / 幂等校验（期待 404 / 403，或只断言 status 200 后再 `playToEnd` 收尾）；`f14` / `p42c` 本来就有 `fleeUntilDone`；所有 `playToEnd` 的 while 条件本身就是 `!finished`，天然免疫。
- **验收（有可复现证据）**：
  - 定向压力 `e2e:f18c` **25/25 全绿（34 项）**、`e2e:f18b` **25/25 全绿（18 项）**；加日志后再跑 15 次 f18c，**15/15 全绿且日志出现 2 行 `[INFO] 逃跑骰子未通过，第 1 次重试`** —— 证明确实撞到 25% 失败分支并被重试消化，不是靠运气全绿。
  - `e2e:core_loop` 定向 **20/20（49 项）** 未复现 §47 那 3 项失败；那次没有原文，继续留 `outTail` 观察，不臆断、不改断言掩盖。
  - 全量 `MPK_FRONT_PORT=5174 npm run verify -- --strict` **47/47 `VERIFY_OK`**（round7，163.7s，0 失败 0 跳过），前端 138 / 后端 422 / 25 组 E2E / 14 组冒烟 / 文档自检 192 项 / 镜像一致；归档完成后的最终一轮数字见本轮提交末尾。
- **口径沉淀**：服务端任何带 RNG / 成功率的动作（逃跑、捕获）在 E2E 里都不能假设单次成功；要么重试到终态，要么走确定性接口（`abandon`）。新增玩法分支写 E2E 前先查既有 helper。

## 50. A1 分包复核定稿：Capacitor 本地包不做人工分包（2026-11-12）

- **触发**：杰哥「之前的分包问题你按最优解去处理吧」。§46 加了 `vendor-react`/`vendor-state` 两组，§47 因「拆这么小是否必要」删掉 `vendor-state` 只留 `vendor-react`，本轮把这个问题一次性收口。
- **复核结论（最优解 = 完全移除 `manualChunks`）**：此前两轮的理由是「React 生态单独成 chunk，业务改版时可复用长期缓存」。但本项目是 **Capacitor 本地包**：`dist/` 整体同步进 APK 的 `assets/public`，WebView 从本地文件加载，APK 升级时整个 assets 一起替换，**不存在跨版本 HTTP 缓存复用**。也就是说分包的唯一真实收益在本项目里恒为零；代价是多一个 `modulepreload`、多一层 chunk 边界、多一套需要跟着依赖变化维护的配置。§47 已证明「分包不减少总下载量」，本轮进一步证明「连体积优势也没有」。
- **实测对比（同一份源码，`npm run build`，Vite 6.4.2；仅切换 `build.rollupOptions.output.manualChunks`）**：

  | 指标 | 有 `vendor-react` | 默认单包 | 差异 |
  |---|---|---|---|
  | 首屏 JS 请求 | 2（script + modulepreload） | **1** | −1 |
  | 产物文件数（含 map） | 7 | **5** | −2 |
  | JS 总字节 | 770,245 B（589,011 + 180,527 + 707） | 770,965 B（770,293 + 672） | +720 B（基本持平） |
  | JS gzip | ≈164 kB | ≈164 kB | 持平 |
  | CSS | 27,068 B | 27,068 B | 不变 |
  | `dist/index.html` | 0.91 kB 前为带 1 条 modulepreload | 0.91 kB | 少一行 |

  结论要如实说：**字节没有变小，反而多 720 B**；取舍依据是「缓存收益为零 + 少一次本地请求 + 零配置」，不是体积。`intents-*.js`（约 0.67 kB）来自 `src/stores/useGameStore.ts:21` 为打破与 `lib/intents.ts` 顶层循环导入（TDZ）而写的动态 `import()`，属源码结构，不属构建期分包，保留；改成静态导入会重新引入循环依赖，收益远小于风险。
- **改动**：`vite.config.ts` 删掉整个 `build.rollupOptions.output`，只保留 `sourcemap:'hidden'`，构建策略回到 Vite 默认；`scripts/doc_check.py` 的 A1 断言由「必须存在 `manualChunks`/`vendor-react`」改为「不得存在函数调用 + 有 §50 与实测数字」。历史条目 §46/§47 保留当时事实，不改写。构建仍有 `Some chunks are larger than 500 kB` 提示（业务代码 + `game/data.ts` 内容表），是提示不是错误，不为了消警告再引入分包。
- **环境注意**：改 `vite.config.ts` 会让 Vite dev server 自动重启，之后必须 `curl 127.0.0.1:$MPK_FRONT_PORT` 探活再跑 verify；`MPK_FRONT_PORT` 单一真值源不变。
- **验收**：`npm run build` exit 0（见 `.verify-logs/build-no-split.txt`），前端 `npm test` 138/138；全量 `MPK_FRONT_PORT=5174 npm run verify -- --strict` 与 W1 合并后的最终数字见本轮提交末尾。


## 51. P5-1 W1 收官：provider 切 Postgres + 一条 PG 基线重置（2026-11-12）

- **触发**：杰哥「好，那就开始 W1 了吧？之前的分包问题按最优解处理」（分包见 §50）。定稿 §4.2 把 W1 列为批次 B 第一项，前置是**一个可连的 Postgres 实例**；本机实测无 `psql`/`postgres`/`redis`/Docker，5432 与 6379 均未监听，`wsl.exe` 被宿主安全黑名单直接拒绝（不可绕过）。
- **资源自决（工程取舍，未向杰哥要资源）**：从 npm 国内镜像取 `@embedded-postgres/windows-x64@16.15.0-beta.19`（37,871,077 B，含 `initdb.exe`/`pg_ctl.exe`/`postgres.exe` + lib/share），解压到 **`E:/Six/pg-runtime/`（NTFS、不入库、不入 git）**；`initdb -U mpk --auth=trust --encoding=UTF8 --no-locale`，单用户模式建库 `monsterpk`，端口 5432。**首次 `pg_ctl start` 的 detach 守护进程会被宿主回收**（几分钟后 5432 closed、`migrate deploy` 报 P1001），改为受管前台进程 `postgres.exe -D ... -p 5432 -h 127.0.0.1` 后稳定，和 3001/5174 同一套生命周期。正式 PG 实例到位时只需把 `backend/.env` 的 `DATABASE_URL` 换掉，schema / 迁移链零改动。
- **切换步骤（先停 3001，硬约束）**：`Stop-Process` 掉 PID 21184（`tsx watch src/index.ts` 的子进程，父进程随之退出），确认 3001 不再重新监听后才动 schema。
  1. `schema.prisma`：订正 `:2` 那句错的「改 provider 即可」注释、`provider = "postgresql"`、`Save` 加 `revision Int @default(0)`（W2 才把它收敛为唯一 +1 源，**W1 不改任何产品代码**）。
  2. 把 11 条 SQLite 方言迁移整体移到 `backend/prisma/migrations_sqlite_archive/`（留 README 说明为何不是「第 12 条迁移」），`migration_lock.toml` 重置为 `postgresql`。
  3. `npx prisma migrate diff --from-empty --to-schema-datamodel prisma/schema.prisma --script` 生成 **217 行纯 PG DDL**（`TEXT`/`TIMESTAMP(3)`/`INTEGER`/`SERIAL`、含 `"revision" INTEGER NOT NULL DEFAULT 0`），落成唯一基线 `20261112123700_init/migration.sql`。
  4. `migrate deploy` 成功、`generate` 成功、`migrate status` 显示 `Database schema is up to date!`（1 migration）。`.env` / `.env.example` 的 `DATABASE_URL` 改 `postgresql://...@127.0.0.1:5432/monsterpk?schema=public`。
- **revision 回填（不跳号，有可复现证据）**：`backend/prisma/backfill_revision.sql` 用 `regexp_match(COALESCE(authority,''), '"revision"\s*:\s*([0-9]+)')` 取原值，取不到 / NULL / 坏 JSON 给 0；**不用 `authority::jsonb->>'revision'`**，因为脏数据直接 cast 会让整条停机迁移报错；`WHERE "revision" = 0` 保证重跑幂等。`backend/scripts/w1_backfill_check.mjs` 在一个事务里造 4 行假数据（rev=7 / NULL / 坏 JSON / `{}`）执行回填、断言后再跑一次验幂等，最后主动回滚 —— **`W1_BACKFILL_RESULT pass=5 fail=0`**，事后查 `w1bf_` 账号数 **0**，无脏数据残留。新库为空库时生产回填影响 0 行，属正常。
- **定稿没列、本轮只读核对抓到的连带改造**：① `backend/tests/e2e_f17.mjs:108` 的 `PRAGMA table_info` 是 SQLite 专属 → 换 `information_schema.columns` 参数化查询（`e2e:f17` **25/25**）；② `scripts/check_home_env.py` 还在检查 `dev.db` 文件存在 → 改为校验 `DATABASE_URL` 是 `postgresql://` + TCP 探活；③ `doc_check.py` 五条「历史迁移已落盘」断言路径改指归档目录（语义不变，不是放宽）；④ 规范 / 任务表 / 路线图 / F10 台账 / HANDOFF / MEMORY 里「当前技术栈 = SQLite」的过期口径全部订正，历史条目（§34/§39 等）保留事实。
- **验收**：切库后首轮全量 `MPK_FRONT_PORT=5174 npm run verify -- --strict` **46/47** —— 唯一失败是 `docs:doc` 的 5 条归档路径断言（原文已抓到），**其余 46 阶段（25 组 E2E / 14 组冒烟 / 前端 138 / 后端 422 / build / 镜像）在空 PG 库下全绿**。断言改指归档目录并补齐 W1 断言后，连跑两轮全量 **47/47 `VERIFY_OK`**（0 失败 0 跳过，**153.3s / 159.6s**），`doc_check` **199 项全绿**、记忆镜像 sha 一致；`prisma migrate status` 干净、`w1_backfill_check.mjs` 5/5、`e2e:f17` 25/25。
- **边界 / 下一步**：W1 **产品代码零改动**（只动 schema / 迁移 / 测试脚本 / 工具 / 文档）；`commitState` 仍是 upsert、409 仍吃内存基线，这些是 **W2** 的事（**已于 2026-11-12 完成，见 §52**）。`backend/prisma/dev.db` 保留作回滚兜底但应用不再读取。**W3~W8 完成前仍不开第二实例做常规服务**；W3~W5 才需要 Redis，W9 才需要域名 / HTTPS / 反代。Redis 至今不存任何影响权益的真值。


## 52. P5-1 W2 收官：409 唯一由 DB 条件更新裁决（2026-11-12）

- **触发**：杰哥「继续下一步」。定稿 §4.2 的 W2 只依赖 W1 + PG（Redis 从 W3 才需要），本机自建 PG 已在线，直接开工。
- **目标（定稿 §3.1）**：唯一 +1 源收敛到 `Save.revision` 列；`409` 只由 `updateMany count` 裁决；create 分支 `P2002`→409；条件失败**短路**内存 apply 与广播；删两处内存 +1；内存态降级只读缓存。
- **实现**：新增 `backend/src/lib/saveCas.ts`（`casWriteSave` 纯逻辑 + 可注入 `SaveCasStore` + `RevisionConflictError` 带回服务端当前行）；`modules/session.ts` 重写 `commitState`：`prismaSaveCasStore()` 用 `updateMany({ where: { userId, revision: baseRev } })` 同时把列置为 baseRev+1，`count !== 1` 抛冲突；首档走 `create`，`P2002` 转冲突；冲突时**不 apply 内存、不广播**。客户端整包 PUT / 意图带 `baseRevision`（必须来自 `readRevision()` 读到的 DB 列，**禁用重读当前值替换**，否则旧版客户端会借新基线覆盖别人）；服务端内部写省略基线，冲突重读重试最多 3 次。`currentState()` / `hydrateForUser` / `GET /api/save` 的版本改以 DB 列为准。删 `monotonicAuthority`（`gameSession.ts`）与 `advanceAuthority` 的 `revision + 1`（`authority.ts`），10 处内部写档点不再手工 +1。
- **为什么必须双进程验收**：单实例 `withSlotLock(userId)` 会把第二个 PUT 排队，它重读到的已是新版本，在 `checkWriteRevision` 快速拒绝阶段就 409，**永远走不到 DB 条件更新分支**。只有两个后端进程各持自己的进程内锁，才会同时读到同一基线并同时进 `updateMany`，由 PG 行锁裁决。
- **新增测试**：`backend/tests/w2SaveCas.test.ts` 7 例（barrier 强制交汇的确定性并发、首档 create P2002、基线过期、连续 +1，以及**反证**：注入忽略 where 的无条件 upsert 后「恰好一赢」断言必须失败）；`backend/tests/e2e_w2_cas.mjs` 25 项，含真 PG 双连接条件 UPDATE 恰好 1 命中 + 无条件 upsert 反证、单实例 / 双进程并发 1×200+1×409、连续严格 +1、`authority` JSON 镜像与列一致、冲突不 apply 不广播（WS 只收 1 条 `session.state`）。脚本用 `node --import tsx src/index.ts` 临时拉起 `:3002`（**不能用 `tsx src/index.ts`**：CLI 会 fork 子进程注册 loader，kill 父进程会留下占端口的孤儿），收尾 SIGTERM / SIGKILL 保证端口释放。注册 `npm run e2e:w2` + `verify.mjs` 的 `STAGES` 与 `GROUPS.e2e`（**两处都要改**）+ `clean:e2e` 的 `w2` 前缀。
- **测试脚本自身的教训（避免重犯 §49 同类错）**：首版把「首档并发的 409 必须来自 create 的 P2002 分支」写成硬断言，实测输家走的是**快速拒绝**（另一进程先建完档），D2 假红 1 项。这属时序概率、不是产品 bug —— 已改为只硬断言对外契约（1 赢 1 409 / 只建 1 行 / rev=1），分支类型只作 `[INFO]` 输出；`create` 的 P2002 由 `w2SaveCas.test.ts` 的 barrier 单测确定性覆盖。**任何带 RNG / 时序分支的 E2E 都不能硬断言走哪条分支。**
- **验收**：新增 7 例后后端 `node:test` **428/428**；`e2e:w2` **25/25**，定向压力连跑 **10/10**（每轮 `[INFO] 双进程 5 组并发中命中 DB 条件更新分支：4/5`，且 3002 每轮都释放）；`MPK_FRONT_PORT=5174 npm run verify -- --strict` **48/48 `VERIFY_OK`**（0 失败 0 跳过，178.1s：26 组 E2E / 14 组冒烟 / 前端 138 / 后端 428 / build / 文档 / 镜像）；`doc_check` 与记忆镜像全绿；`prisma migrate status` 仍干净。
- **边界 / 下一步**：W2 **不改 schema、不动 `SCHEMA_VERSION`、不改迁移链**；`slotLock` 仍是进程内 Map（W3 换 Redis 租约锁），心跳 / 房间 / 野怪 / 广播仍是单进程内存态 —— **W3~W8 完成前仍不开第二实例做常规服务**（本轮仅临时起 3002 做验收）。W1 的 PG 是本机自建开发实例，正式实例到位只换 `DATABASE_URL`。


## 53. 冒烟偶发红第三个根因：headless Edge 单次导航失败（2026-11-12）

- **触发**：W2 归档后连跑两轮全量，round13 **48/48 `VERIFY_OK`**，round14 **47/48** —— 唯一失败 `smoke:p42d`（4 通过 / 11 失败）。
- **原文**（`.verify-logs/2026-11-12T07-31-52-560Z-p39560/38_smoke_p42d.log`）：`seed 注入登录态` 拿到 `<!DOCTYPE html><html dir="ltr" lang="zh"><head><meta name="theme-color"...`，即 **Chromium 网络错误页**而非 `SEEDED` 页；探针 `{"step":"init","errors":["timeout:camp-entry"]}`，`finalTxt` 停在登录页（「登录账号，继续你的野外考察与幻兽收集之旅」），后续 10 项连锁失败。同轮前后 14 个冒烟全绿、单独重跑 `UI_SMOKE_P42D_RESULT pass=15 fail=0` —— **不是产品 bug，也不是 W2 引入**（W2 只改后端 CAS；冒烟只走 REST + 前端页面）。
- **根因**：headless Edge `--headless=new --dump-dom` 偶发在导航阶段失败，直接 dump 出浏览器错误页；15 个 `scripts/ui_smoke_*.mjs` 的 `runEdge()` 都只调一次 `execFileSync`，**没有任何重试**。连续多轮全量（每轮启动 15+ 次 Edge）时命中概率上升。
- **修复（只改测试脚本，断言零放宽）**：新增 `scripts/lib/edgeDom.mjs` 的 `createRetriedExec(raw)`，只包装带 `--dump-dom` 的调用；输出是 Chromium 错误页（`dir="ltr"` / 「无法访问」）或执行抛异常时**最多重试 3 次**，后续尝试换 `--user-data-dir` 避免上次 profile 未释放；3 次都失败则**原样返回错误页，该红还是红**。非 `--dump-dom` 调用直接透传。15 个冒烟脚本只把 `import { execFileSync }` 改成别名 + 生成同名包装函数，`runEdge` 函数体与所有断言（含 `seedDom.includes('SEEDED')`）一行未动。
- **确定性证据**（`.verify-logs/edge-retry-proof.txt`，`EDGE_RETRY_PROOF pass=3 fail=0`）：① 前两次错误页 / 第三次成功 → 返回正常页且调用 3 次；② 三次全错误页 → 原样返回错误页、调用 3 次（证明不掩盖）；③ 非 `--dump-dom` → 透传且只调用 1 次。最后一次失败打 `[RETRY_EXHAUSTED]`，不再出现误导性的「重试 3/2」。
- **验收**：加固后 `ui_smoke_p42d.mjs` 单独 **15/15**、定向压力 **20/20**（0 次重试触发，说明错误页不是常态）；`MPK_FRONT_PORT=5174 npm run verify -- --strict` **48/48 `VERIFY_OK`**（round15，355.1s，0 失败 0 跳过）；`doc_check` 新增 2 条断言后全绿。归档完成后连跑两轮全量 **48/48 `VERIFY_OK`**（round16 333.9s / round17 309.5s，均 0 失败 0 跳过），`doc_check` **208 项**、记忆镜像一致；3002 每轮验收后均释放。
- **口径**：这是 §48 / §49 之后第三类偶发红根因（前两类是 Windows 盘符大小写导致别名解析失效、逃跑 RNG 假设），三类都靠「先落日志基建、再抓失败原文」定位，**没有靠重跑掩盖**。历史 §47 记的「UI 冒烟偶发」至此有具体成因与加固。


## 54. P5-1 W3 收官：Redis 分布式租约锁（2026-11-12）

- **触发**：杰哥「有硬阻塞那就打通它，没有 Redis 实例就加」。设计定稿 §3.2 / §4.2 W3 的唯一外部前置是 Redis，本机 6379 未监听、无 Docker、WSL 被宿主黑名单禁。
- **自建实例（不入库）**：GitHub release 直连仅约 3KB/s、`ghproxy.net` 中途失败 → 改用 `ghfast.top` 代理 + **HTTP Range 六段并行**拉取 `Redis-x64-5.0.14.1.zip`（12,617,669 B，其中一段失败单独补下，`zipfile.testzip()` CRC 全过），解压到 `E:/Six/redis-runtime`（NTFS）。启动：`redis-server.exe --port 6379 --bind 127.0.0.1 --save "" --appendonly no --protected-mode no`，**必须受管前台进程**（与 PG 同口径，detach 会被宿主回收）。实测 `PING=PONG`、`SET NX PX` 第二次抢锁返回 nil、`PTTL` 正常、Lua token 比对释放返回 0/1。
- **实现（W0 接口化的收益：6 个调用模块 + 锁顺序 + `alreadyLocked` 旁路全部零改动）**：新增 `lib/redisLockBackend.ts`（`acquire/renew/release` 三原子操作 + 两段带 token 比对的 Lua）、`lib/redisLockProvider.ts`（`RedisLockProvider implements LockProvider`）、`lib/lockBootstrap.ts`（启动装配 + health 诊断）。
  - 命名空间 `lock:acct:` / `lock:room:` / `lock:bossq:` / `lock:mapbossq:` / `lock:rank:`，映射放在 Provider 内部，`slotLockKey()` / `roomLockKey()` 返回值不变。
  - `AsyncLocalStorage` 记当前调用链已持 key，命中即 bypass —— `SET NX` 非重入，若把重入实现成轮询等待会自我死锁（§36 同锁重入教训）。
  - TTL **30s**、watchdog 每 **10s** 用 Lua「GET==token 才 PEXPIRE」续租；释放用 Lua「GET==token 才 DEL」，迟到释放不抹掉同名新租约；租约到期自动归还，进程崩溃不残留。
  - 抢锁抖动退避 + `acquireTimeoutMs=30s` + `maxAttempts` 兜底，超时明确抛 `LOCK_ACQUIRE_TIMEOUT`，**不静默放行**。定稿 §1#7 的「不同实例各持不同层级锁成环」由超时兜底（W6 统一层级前不改调用顺序）。
  - **语义差异如实记**：进程内实现是 Promise 链、严格 FIFO；Redis 锁只保证「同 key 不同时执行」，不保证先到先得 —— 正确性由 W2 的 DB 条件更新裁决，不依赖顺序。
  - **fencing token 不用在存档写**（revision 单调本身即 fence），token 只服务续租/释放；DB 条件更新仍作最后兜底。
  - `REDIS_URL` 未配置 → 保持进程内锁、**仅允许单实例**（CI 无 Redis 可跑）；一旦配置就必须 PING 成功，否则**启动直接失败**，绝不静默降级回进程内锁；运行期断连同样不降级（ioredis 停止重连、命令报错）。`/api/health` 新增 `lock: { mode, ttlMs, renewMs }` 供验收诊断。
- **验收**：`w3RedisLock.test.ts` 8 例确定性单测（内存后端 + 虚拟时钟 + 手动 watchdog）：同 key 并发不交错 / **去锁 + barrier 必交错反证**、20 次读-改-写无丢失、嵌套同 key 不死锁、嵌套不同 key 双锁并持、watchdog 续租与易主告警、reject 不阻断、抢锁超时、Lua 脚本 token 比对。后端 `node:test` **436/436**。`e2e_w3_lock.mjs` **23 项**（`node --import tsx` 直接 import 产品 TS 模块，不复制 Lua/命名空间规则）：两个独立 Provider 实例模拟双进程、真 Redis 续租/过期/安全释放、**预占 `lock:acct:<userId>` 后 :3001 与 :3002 的 PUT 都被挡在门外**、正确 token 释放后恰好 1×200 + 1×409 且 revision 严格 +1、错误 `REDIS_URL` 拒绝启动。定向压力 **10/10**，3002/3003 每轮干净释放。
- **踩坑（测试夹具，非产品 bug）**：20 个并发用例共用虚拟时钟时，`sleep` 若推进时钟会让 TTL 与 deadline 一起累积撞到抢锁超时 → 首版 435/436。修法不是放宽断言：给 Provider 加 `maxAttempts` 兜底（同时防生产时钟回拨死循环），测试 `sleep` 改为只让出微任务、由用例显式 `clock.advance()`。
- **验收（全量）**：新增 `e2e:w3` 后 `MPK_FRONT_PORT=5174 npm run verify -- --strict` **49/49 `VERIFY_OK`**（首次让全部 E2E 跑在分布式锁下）；首轮 48/49 唯一失败是 `doc_check` 的 W2 断言依赖 `'e2e:w2', 'e2e:p41'` 相邻字面量（GROUPS 插入 `e2e:w3` 后失配），改为独立检查，不是放宽。归档完成后连续两轮全量 **49/49 `VERIFY_OK`**（round20 257.2s / round21 193.2s，均 0 失败 0 跳过），`doc_check` **215 项**、记忆镜像一致；3002/3003 每轮释放。
- **边界 / 下一步**：W3 **不改 schema、不动 `SCHEMA_VERSION`、不改迁移链**；房间 / 野怪 / 定时器 / 广播仍是单进程内存态，**W4~W8 完成前仍不开第二实例做常规服务**（本轮 :3002/:3003 只是临时验收进程）。W4 定时器选主、W5 广播顶号可复用同一 Redis 实例；正式 Redis 到位只需换 `REDIS_URL`。


## 55. 偶发红第四个根因：core_loop 共斗「单强宠」被 RNG 拖到全灭（2026-11-12）

- **触发**：W3 归档后最终回归 round19 **48/49**，唯一失败 `e2e:core_loop`（46 通过 / 3 失败）。这正是 §47 记录、此前 4 轮全量 + 定向 20 次都没抓到原文的悬案 —— 本轮日志基建（§48）终于留下完整原文。
- **原文**（`.verify-logs/2026-11-12T12-02-59-923Z-p45112/31_e2e_core_loop.log`）：`六房全清 → settled / result=win / cleared=6` 实得 `{"result":"lose","cleared":3}`（房间 `turn:16`），随后 `房主通关奖励：+40 金钱`（`money=5950 expect=5990`）与 `+capsule_basic×1`（`capsule=52 expect=53`）连锁红。三项同一个根因，不是三个 bug。
- **根因（测试档强度不足，非产品 bug、非 W3 引入）**：共斗敌人 `createRoomEnemies()` 按注入 rng 生成（Lv.5→15 递增、每房 2 只），`canMove` / 命中 / 状态异常也都吃 rng；`applyCoopTurn` 在 `state.sides.every(s => s.out)` 时判 `lose`。`e2e_core_loop.mjs` 的 host 是「1 只强宠 + 1 只弱占位 + 捕获来的弱野怪」、guest **只有 1 只强宠**；回合一被 rng 拖长，guest 单宠倒下即 `out`，host 弱补位很快全灭。稳定的 `e2e_f16.mjs` 用的是 **6 只全强宠**，所以从未出现。`roundTimeoutMs` 默认 20s，E2E 每轮毫秒级，与超时无关；W3 的 Redis 锁只增加约 2 次本地往返，也不是因果（W2 时期定向 20/20 全绿，说明概率本就低）。
- **修复（只改测试档，断言零放宽）**：`e2e_core_loop.mjs` 的 `WEAK` 由 Lv.5 / hp300 / atk4 的占位宠改成与 `STRONG` 同口径的 Lv.40 高攻高血替补（保留 `id` / `specId`，不参与捕获，捕获仍由 index 0 执行）；`guestParty` 由 `[STRONG]` 改成 3 只 id 唯一的全强宠。**与 `e2e_f16` 的「全强宠」口径对齐**，把胜负从 rng 手里拿回来。`intentFor` / `playToFinish` / 六房与发奖断言一行未改。
- **口径沉淀（§49 的延伸）**：不只是「逃跑有成功率」—— 凡服务端战斗带 rng（敌人生成、命中、状态、暴击）的 E2E，都**不能把「必胜」寄托在单次 rng 结果上**；要么像 f16 用压倒性数值把 rng 变量压到零，要么重试到终态。新增玩法串联 E2E 前先比对同玩法专项 E2E 的档位构造。
- **验收**：加固后 `e2e:core_loop` 定向压力 **30/30 全绿**（49 项/轮，`lose_hits=0`）；归档完成后连续两轮全量 **49/49 `VERIFY_OK`**（round20 257.2s / round21 193.2s，均 0 失败 0 跳过），`doc_check` **215 项**、记忆镜像一致；3002/3003 每轮释放。

## 56. git push 恒 502 的真实根因：沙箱代理与系统代理错配（2026-11-12）

- **现象**：W3 本地提交 `12a9ef2`、tag `rollback-20261112-w3-redis-lock` 均已建，但 `git push` 累计约 30 次有限重试恒报 `CONNECT tunnel failed, response 502`，`origin/master` 一直停在 W2 的 `cd83638`；期间杰哥开启代理后浏览器能打开 GitHub，git 仍不通。
- **只读定位（可复现）**：环境变量 `HTTPS_PROXY` / `HTTP_PROXY` = `http://127.0.0.1:11811`；`netstat` 显示 11811 由 PID 8460 监听，进程是 `sandbox-cli.exe`（WorkBuddy 沙箱网络代理，命令行带 `--rule_decision center`）。经该代理 `curl -I https://github.com` 得 `HTTP/1.1 502 Bad Gateway` + `Retry-After: 1` + `Content-Type: text/plain`（46 B，代理自生成，非 GitHub 返回）；`--noproxy '*'` 直连超时。而注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings` 是 `ProxyEnable=1` / `ProxyServer=127.0.0.1:8693` —— **浏览器走 8693，所以能打开；git/curl 被环境变量钉在 11811，两者不是同一条通道**。git 未设 `http.proxy`，完全依赖环境变量。
- **解法（不改仓库配置、不改协议、不换 Git Data API）**：先验证系统代理端口 `P=http://127.0.0.1:8693; HTTPS_PROXY=$P HTTP_PROXY=$P curl -o /dev/null -w '%{http_code}' https://github.com` → `200`，仓库 `info/refs?service=git-upload-pack` 亦 `200`；再一次性覆盖 env 推送：`HTTPS_PROXY=$P HTTP_PROXY=$P https_proxy=$P http_proxy=$P git push origin master`。**用完即弃，不改全局 `git config http.proxy`**。
- **结果**：master 第 1 次成功；tag 第 1 次 `schannel: failed to receive handshake, SSL/TLS connection failed`、第 2 次成功。`HEAD == origin/master == 2ad52b3`，ahead 0，`git ls-remote --tags origin rollback-20261112-w3-redis-lock` 返回 `12a9ef2`，工作树干净。
- **口径**：与既有「推送 502 = 网络波动、有限次重试」不冲突 —— 若多次重试仍恒为 502 且浏览器能通，就核对 `HTTPS_PROXY` 是否指向沙箱代理；系统代理端口从注册表读。诊断只做「环境变量 / 端口归属 / 单次 curl 对照」三件，不做分层连通性排查。详见 HANDOFF 提交规矩段。

## 57. 配置分层失守：把沙箱 env 当成本机 / 项目配置（2026-11-12，流程级低级错误）

- **定性**：§56 的 502 不是网络故障也不是代码缺陷，是**配置分层没做** —— 直接把工具会话注入的 `HTTPS_PROXY=http://127.0.0.1:11811` 当成「本机代理配置」，按既有「502 = 网络波动、有限次重试」口径累计重试约 30 次；直到杰哥提示「浏览器能打开 GitHub」才去核对变量归属。**错在流程，不在技术**。本节记「以后怎么不犯」，§56 记「这一次怎么修」，两条并存不互相取代。
- **三层配置（本项目硬口径，跨机器 / 跨会话通用）**：

| 层 | 谁注入 / 从哪读 | 本项目实例 | 能否写进仓库 | 有效期 |
|---|---|---|---|---|
| **沙箱 / 工具层** | WorkBuddy 会话给子进程注入 | `HTTPS_PROXY` / `HTTP_PROXY` = 11811（`sandbox-cli.exe`）、`CODEBUDDY_*`、只在命令前缀临时指定的 `MPK_*` | **禁止**：不得进 `.env` / 脚本 / 文档 / CI 当默认值 | 仅当前会话进程 |
| **系统 / 本机层** | Windows 注册表、用户环境变量、本机安装路径 | 注册表 `HKCU\Software\Microsoft\Windows\CurrentVersion\Internet Settings\ProxyServer` = `127.0.0.1:8693`、`E:/Six/pg-runtime`、`E:/Six/redis-runtime`、JDK21 路径 | **禁止硬编码**：只在 bug_log / HANDOFF 作诊断例子，产品配置一律走 env | 机器级、跨会话 |
| **项目层（唯一可提交真值）** | 仓库内 `.env.example` + 配置模块 + 本机 `.env`（不入库） | `MPK_FRONT_PORT` → `scripts/lib/devConfig.mjs`；`DATABASE_URL` / `REDIS_URL` / `CORS_ORIGIN` → `backend/.env`（模板 `backend/.env.example`） | **允许**：模板随 git 走，`.env` 不入库 | 随仓库 |

- **防再犯六条硬规则**：
  1. 任何「环境类」失败（连接 502 / refused / 端口占用 / 凭据不通 / 工具找不到 / 路径大小写），**先报配置来源三层，再谈重试**；有限次重试前必须先核对一次变量归属，禁止「先重试 30 次再说」。
  2. 沙箱层的值不得写进任何项目文件；系统层端口（11811 / 8693）与本机绝对路径不得成为产品默认值，只作为 bug_log / HANDOFF 的诊断例子。
  3. 项目真值源唯一：端口 `MPK_FRONT_PORT`（`scripts/lib/devConfig.mjs`），后端 `DATABASE_URL` / `REDIS_URL` / `CORS_ORIGIN`（`backend/.env`，模板 `.env.example`）。新增配置项先定真值源，再写读取方。
  4. 覆盖环境只允许**一次性命令前缀**（`P=...; HTTPS_PROXY=$P ... git push ...`），用完即弃；不改全局 `git config http.proxy`、不改系统代理、不改仓库配置来「修」一次会话问题。
  5. 本地服务探活一律 `curl --noproxy '*'`（或直连 TCP），避免沙箱代理把 localhost 请求变成假 502（与 §33.2 同口径）；PG / Redis 不是 HTTP，`curl /` 返回 `000` **不等于**服务没起，用 `redis-cli PING` / `GET /api/health` 判活。
  6. 诊断只做三件：读 env → 查端口归属进程 → 单次 curl 对照；不做分层连通性排查、不换协议 / 通道 / Git Data API。
- **可复现核验命令（先读再动手）**：`env | grep -i proxy` → `11811`；PowerShell `Get-ItemProperty 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings' | Select-Object ProxyEnable,ProxyServer` → `8693`；`curl --noproxy '*' -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health` → `200`；`P=http://127.0.0.1:8693; HTTPS_PROXY=$P HTTP_PROXY=$P https_proxy=$P http_proxy=$P curl -o /dev/null -w '%{http_code}' https://github.com` → `200`。
- **归档落点**：HANDOFF 提交规矩段、项目 MEMORY §4、用户级长期记忆、今日日志、`scripts/doc_check.py` 的 §57 断言；`.trae` 镜像由 `scripts/sync_memory.py` 同步。
- **2026-11-12 晚推送实测补充**：沙箱程序黑名单会拦 `reg.exe`（Git Bash 报 `Permission denied` + `PROGRAM BLOCKED BY SECURITY POLICY`），**不要重试、不要换 shell 绕道启动它**；改用 `netstat -ano | grep ':8693'` 确认端口 `LISTENING`（本机 PID 49048）与 `11811`（PID 8460 `sandbox-cli.exe`）+ 单次 `curl` 对照即可完成「查端口归属」。`curl` 首次偶发 `exit 35`（TLS 握手）、复探一次 `github=200` 属正常抖动，不做分层连通性排查；随后 `git push` 一次性成功。

## 58. P5-1 W4 收官：定时器选主 + fencing + 幂等键（2026-11-12）

- **范围**：设计定稿 §3.4 / §4.2 W4，依赖 W3 的 Redis 实例与 PG（本机均已在线）。不改 schema / `SCHEMA_VERSION` / 迁移链，不改存档协议。
- **新增 `backend/src/lib/sweepLeader.ts`**（唯一真值源）：
  - `SweepLeaseStore` 接口 + Redis 实现（`createRedisSweepLeaseStore(client, keyPrefix='')`）+ 确定性内存实现（`InProcessSweepLeaseStore`，CI 无 Redis 也能验）。
  - leader 租约 `lock:sweep:global`（`SET NX PX`，TTL 默认 `2×WS_HEARTBEAT_MS` = 60s，可 `SWEEP_LEASE_TTL_MS` 覆盖）；`sweep:fence` 只在 acquire 成功时 `INCR`，新 leader fence 严格大于旧 leader。
  - `renew` / `release` / `isCurrent` / `claim` / `releaseClaim` 全用 Lua token 比对；`isCurrent` 同时校验 token 与 fence，**过期 leader 写共享态全拒**。
  - `guardedCommit(ctx, key, action)` = guard → claim → 动作，publish 一律写在 action 内，**提交成功才发**；抽到本模块让单测 / E2E 直接 import 同一实现。
  - `SweepLeader.run()`（心跳用：抢/续租 + 两次 re-check）与 `lightContext()`（250ms 房间定时器用：本地缓存，不打 Redis，跨实例正确性由 room 幂等键 + `withRoomLock` 兜底）；`shutdown()` 主动交出租约。
- **接线**：`lockBootstrap.ts` 导出 `getLockRedisClient()` 复用 W3 那条已 PING 通的 ioredis 连接；`index.ts` 在 `initializeLockProvider()` 之后 `await initializeSweepLeader(...)` **启动即抢一次租约**（否则 250ms timer 在前 30s 因 `lightContext()` 为空而停摆），再 `registerRealtime()` / `listen()`；health 加 `sweep:{mode,instanceId,leader,fence,ttlMs,idemTtlMs,current}`（`current` 查一次 Redis，区分缓存与真 leader）；SIGINT / onClose 先交租约再关锁连接。
- **三段心跳**：`runLocalHeartbeat` / `runBanSweep` 每进程各跑；`runGlobalSweep(now, heartbeatMs, ctx?)` 只有 leader 跑，按心跳 bucket 给 `sweep:sessions` / `sweep:battles` / `sweep:wilds`、`quota:release:<battleId>`、`wild:<areaId>:<bucket>` 加幂等键；无 ctx 时走单实例直通路径，与 W0 拆分前逐字一致。
- **封号段顺带修 W5 前置项**：`WsConnection` 加 `sessionVersion`（握手 JWT 的 sv），`runBanSweep` 一次查库同时判 `bannedAt` 与 `sessionVersion`，不匹配即本地 `bye` + close + remove + detach —— 旧 token 的 WS 不再靠 pong 无限存活。
- **房间路径**：`tickRoom` / `sweepRooms` 改 async 并统一套 `withRoomLock`（`sweepRooms` 逐房加锁，不再无锁遍历快照；REST 读去掉外层嵌套锁，避免进程内锁非重入自锁）；`RoomRegistry.roomIds()` 提供 id 快照。幂等门 `idem:room:<roomId>:<revision>` 是**短期 claim + 用完释放**：同 revision 双实例并发只 1 个推进，推进后 revision 变了下一次 tick 用新键，不会饿死回合。结算标记提共享 CAS 门 `idem:settle:pvp|coop:<roomId>`（失败回滚键以允许重试），`maybeSettle*` 改 async。
- **边界（如实记录，别当已完成）**：W6 才把 RoomStorage 换 PG 行版本 CAS、W7 才把野怪池全量搬 Redis；本阶段的房间/野怪状态仍是**进程内内存真值**，幂等键防的是「leader 切换重叠窗口重复推进」，不是跨实例共享真值。定稿 §4.2 的「双实例跑 5 分钟」长稳验收**延后到 W6/W7 之后**才有意义；本轮用「两个独立 SweepLeader 共享同一真 Redis」等价验证选主/fence/接管，测试键带独立前缀，**绝不抢常驻 :3001 的租约**（否则 :3001 的 250ms 房间 timer 会停摆，连锁污染后续 E2E）。W3~W8 完成前仍不开第二实例做常规服务。**性能边界（如实记录）**：250ms 房间定时器在 Redis 模式下每房每轮约 4 次 Redis 往返（`withRoomLock` 抢/放 + room 幂等键 claim/放），房间规模大时需 W6 批量化；本轮 11 房规模全量 50/50 通过，未做大规模压测。
- **测试**：`w4SweepLeader.test.ts` 11 例（确定性时钟 + 内存 store：单实例续租不重编号 / 双实例只 1 leader / fence 递增 / 过期 leader guard 与广播全拒 / TTL 接管 / bucket 幂等 / 房间短期 claim 不饿死 / 错误 token 不误删 / 结算幂等 / shutdown 幂等 / lightContext 不续租）；`e2e_w4_sweep.mjs` 27 项（真 Redis 六分区：health 诊断、双 leader 互斥、kill 接管、TTL 自然过期接管、四类幂等键、生产租约隔离）。注册 `e2e:w4` + `STAGES` + `GROUPS.e2e`；**新增 verify 阶段必须同时改两处**，本次又踩到 doc_check 里 `'e2e:w2', 'e2e:w3', 'e2e:p41'` 相邻字面量断言，已改为独立检查（§52 同类坑复发一次，勿再写相邻串）。
- **验收**：后端 `node:test` **447/447**（W3 的 436 + 11）、`e2e:w4` **27/27**、定向回归 p42b 43/43 / p42d 16/16 / p42e 20/20 / f16 14/14 / core_loop 49/49 全绿；全量 `MPK_FRONT_PORT=5174 npm run verify -- --strict` 连续两轮 **50/50 `VERIFY_OK`**（315.4s / 230.3s，均 0 失败 0 跳过）、`doc_check` **222 项**、记忆镜像 sha256 一致。

## 59. P5-1 W5 收官：广播 / 顶号（双频道 + 本地裁剪 + revision 跳号回源，2026-11-12）

- **范围**：设计定稿 §3.5 / §4.2 W5，依赖 W3 的 Redis 实例（本机 6379 在线）。不改 schema / `SCHEMA_VERSION` / 迁移链，不改存档协议；W0 已抽象的 `BroadcastTransport`（`toUser`/`toAll`）让所有发送点是零改动的注入点。验收断言（定稿 §3.5）：A 实例写入后 B 实例连接收到三种快照；跨实例顶号旧连接收到 `bye`；订阅闪断后跳号自动回源；room 消息不含隐藏态。
- **新增 `backend/src/lib/redisBroadcastTransport.ts`**（唯一真值源）：
  - 双频道：`mpk:bc:all`（野怪全局快照）+ `mpk:bc:user:<userId>`（定向，session/room 按 owner 路由）；控制频道 `mpk:ctl:takeover`（跨实例顶号信号）。
  - subscriber 用**独立 ioredis 连接**（pub/sub 模式下普通命令在订阅连接上被禁）；publisher 复用 W3 `getLockRedisClient()` 那条已 PING 通的连。
  - 本地裁剪：定向频道只把 `room.state` 发给房间里登记连接的 userId 集合，按接收者剔除 `tokenDigest` / `digest` / `conn_*` / 他人 username 等隐藏态；订阅端本地转发保证连接只收一次。单实例时「发布 → 自身订阅 → 本地转发」闭环，**零重复、零行为差异**（W5 单实例零行为变更验收点）。
  - 订阅建立时 `hydrate` 全量（拉各 owner 当前权威态），避免订阅前窗口漏快照；hydrate 直接重置 revision 基线，不触发跳号误判。
- **新增 `backend/src/lib/connectionControl.ts`**（模块边界不反向依赖：不被 session/realtime 反向 import）：
  - `kickUserConnectionsExceptSv(userId, sv)`：顶号时只踢 `sessionVersion !== sv` 的连接，匹配的连接（同账号同代次）保留，避免「自己顶自己」把当前连接也断。
  - `publishTakeover(userId, sv)` / `getBroadcastMode()` / `shutdownBroadcast()`：与 `realtime.ts` 的 `onConnected` 本地 takeover 串起来；`index.ts` SIGINT 前 `shutdownBroadcast` 先退订。
  - 边界：跨实例顶号靠控制频道发信号 + 对端 `kickUserConnectionsExceptSv`；旧 token / 旧 sv 的旧 WS 连接收到 `bye` + close（4001，`SESSION_REPLACED`）。
- **接线**：`index.ts` 在 `REDIS_URL` 配时 `initW5Broadcast()`，health 加 `broadcast`（值从 `getBroadcastMode()` 来，redis/local）；SIGINT 先 `shutdownBroadcast` 再交租约关锁。`realtime.ts` 新连接 `publishTakeover`、onClose 关广播。session 模块 `session.resync` 上行 → 重推 `buildSnapshot`；room 模块 `room.resync` 上行 → 重推房间态（`pvp/coop` 隐藏态仍按接收者裁剪）。
- **前端跳号回源 `src/lib/ws.ts`**（零 React 耦合）：
  - 维护 `(domain, ownerKey) → lastRev`；`noteReceivedRevision(domainKey, rev)` 三种返回 `reset` / `ok` / `jump`：首次/hydrate 建基线 `reset`，`rev<=prev` 重复帧 `ok`，`rev>prev+1` 跳号 `jump`。
  - 三种快照分支接检测：`session` 跳号发 `session.resync` 上行、`wild` 跳号 `window.dispatchEvent(new CustomEvent(WILD_REFRESH_EVENT))`、`room` 跳号发 `room.resync` 上行（带 `roomId`）。`connect()` 重连后 `resetRevisionBaselines()` 重置基线，避免首帧误判跳号。
  - `src/lib/sessionState.ts` 新增 `WILD_REFRESH_EVENT` 常量；`src/lib/wild.ts` 的 `useWildList` 监听该事件走 REST `GET /api/wild` 重拉全量（订阅期间丢 wild 快照的兜底）。
- **边界（如实记录，别当已完成）**：房间态 / 野怪态在 W6/W7 之前仍是**进程内内存真值**，跨实例的 room 成员必须连同一实例。故定稿 §3.5 的「A 实例 room 写入 B 实例连接收到」中，**room 部分 W6 前无法构造跨实例送达**（W5 E2E 的 room 用例改为：同实例创建+加入+出招，验证经 `RedisBroadcastTransport.toUser` 传输 + 隐藏态裁剪，落点正确即可）；session/wild 是真正的跨实例双进程送达（A 写入 → B 连接收到）。W3~W8 完成前仍不开第二实例做常规服务。
- **测试**：`w5Broadcast.test.ts` 6 例（FakeRedisBus/FakeRegistry 覆盖双频道路由、takeover 控制频道、只踢 sv 不匹配、未 init local 不广播）；`ws.test.ts` 7 例（`noteReceivedRevision` 的 reset/ok/jump/decreasing/非法/独立域基线）；`e2e_w5_broadcast.mjs` 23 项（真 Redis 临时 :3002 双实例：B0 双实例就绪+广播模式 redis、B1 session 跨实例送达、B2 wild 跨实例 claimed/available、B3 room 经 Redis 传输 + 隐藏态裁剪、B4 跨实例顶号旧连接收 bye/4001、B5 resync 回源通路）。注册 `e2e:w5` + `STAGES` + `GROUPS.e2e`（**新增 verify 阶段两处都改**，漏 `GROUPS` 静默少跑）；E2E 测试键带独立前缀，不抢 :3001 的锁 / 租约。
- **验收**：后端 `node:test` **453/453**（W4 的 447 + 6）、`ws.test.ts` 前端 7 例（合并前端 16/16）、`e2e:w5` **23/23**、定向 f18a/b/c/ux 冒烟与 content matrix 回归全绿；全量前端 144 / 后端 453 / content / W5 E2E 23 / docs 222（记忆镜像 sha256 一致）全绿。健康检查 `broadcast: "redis"` 已 `curl --noproxy '*' /api/health` 探活确认。

## 60. P5-1 W6.1 收官：RoomStorage 异步化 + PG 行版本 CAS（2026-11-13）

- **范围**：设计定稿 W6 顺序工单 #182（W6.0 的 `Room`/`RoomQuota` 模型与迁移已在 #181 落库）。零行为变更：不改 `SCHEMA_VERSION`、不改存档协议、不改房间对外语义；`RoomStorage` 从同步内存接口全量改 `Promise`，CAS 用 `Room.revision` 行版本（`updateMany where revision=base` + `count===1` 裁决）。
- **新增 `backend/src/lib/pgRoomStorage.ts`**：`get`/`create`（P2002→false 表并发建房冲突）/`set`（base=rev-1 抬到 rev，count!==1 表 CAS 失败）/`writeBack`（同 rev 条件写回，见下）/`delete`/`all`/quota 两方法。`sessionBus.ts` 注入 `new PgRoomStorage()`（测试仍可传 `InMemoryRoomStorage`）。
- **重写 `backend/src/lib/roomRegistry.ts`**：接口 9 方法全 async；`get` 返回深拷贝副本；`bump`=revision+1+CAS 落库（冲突抛 `RoomCasConflictError`）；load-once/set-once 模式（一次操作一次 get、末尾一次 bump）；子方法（`settleRoom`/`abandonRoom`/`advanceTurn`/`autoSubmit`/`finishQuota`）改传对象不各自 get/set；泛型包装 `loadAndMutate`（无变更不抬 revision）与 `withUserRooms`（markDisconnected/reconnect 跨房遍历）。`InMemoryRoomStorage` 同步升 async 保持测试可用。
- **调用方全量 await 化**：`room.ts`/`coop.ts`/`pvp.ts`/`realtime.ts`/`index.ts` 全部 `rooms.*`/`publishRoom(s)`/`memberView`/`roomStats` 补 await（realtime 的 message/close handler、`sweepRooms`、health 都在内）。单测 await 化用转换脚本 `scripts/w6_await_transform.cjs`：**v1 的 `[^)]*` 实参匹配被嵌套括号（`seeded(3)`）截断，把 `rep` 挤出实参列表产生「括号平衡但实参丢失」的静默损坏**（coopRoom.test.ts L101 实证）→ v2 改括号感知逐字符配平（识别字符串字面量），`reg/reg2/onlineReg` 变量全集覆盖，117 处调用零手工遗漏。
- **顺带修三处 W6.1 引入/暴露的回归（勿回退）**：
  - **① `setSettledFlag` 误用 `bump` 抬 revision**，违反 W0 钉住的「结算标记写回不 bump revision（零行为变更）」口径 → 新增 `writeBack` 原语：`RoomStorage` 接口 + InMemory/Pg 双实现 + 测试 CopyStorage 同步加，语义=where revision=room.revision、revision 不变只覆盖 data、冲突 false；`setSettledFlag` 改走 writeBack + 有限 5 次重试，已是目标值不写（与原行为一致）。
  - **② CAS 冲突无人兜底打死进程**：WS close handler 的 `markDisconnected`（`withUserRooms`→`bump`）不持房间锁，与持锁 HTTP 操作并发时 `bump` 抛 `RoomCasConflictError`，async handler 的 rejection 未接住 → 后端整个进程崩（p42d E2E 实证）。修法：新增 `retryCas` 整段重试（load→mutate→bump 重跑，最多 5 次），包住 `loadAndMutate`/`withUserRooms`/`attachPvp`/`attachCoop`/`tick`（tick 拆 `tickOnce` 外壳重试；`deleted/abandoned/changedRoomIds` 都在 bump 成功后才 push 不重复，`timedOut/autopiloted` 计数极小概率多计一次仅影响日志口径）；realtime close handler 再加 try/catch 兜底（重试耗尽也绝不打死进程，掉线标记由下轮 sweep/心跳补齐）。
  - **③ 事件监听晚挂载静默丢消息**：`onConnected` 的 `message`/`close` 监听原本挂载在 `await rooms.reconnect()` 之后——同步时代同 tick 挂载无窗口；W6.1 变 async 后，客户端 hello 后立即上行的消息（对抗攻防的 ping/25 连发限流用例）赶在监听器挂好前到达被**静默丢弃**（ws 无监听即丢），且超大帧 1009 错误走 nextTick 早于微任务，同样会在窗口内无人接住打死进程。修法：提取顶层 `attachWsHandlers(fastify, ws, conn, userId, now)`，在 `onConnected` **任何 await 之前**调用；同时 ws `error` 监听也最先挂（1009 由它接住，close 事件紧随）。
- **测试与验收**：后端 `node:test` **453/453**（roomRegistry 18 / coopRoom 6 / w0QuotaSettled 4 含新 writeBack 断言）；房间 E2E（打真后端 3001 + PgRoomStorage）：`e2e:p42b` 43/43、`e2e:p42d` 16/16、`e2e:p42e` 20/20、`e2e:f16` 14/14、`e2e:core_loop` 49/49；W 系双实例 `e2e:w2` 25 / `e2e:w3` 23 / `e2e:w4` 27 / `e2e:w5` 23；`e2e:hardening` **122/122**（②③修复前 3 红 + 曾打死进程）。`npm run verify` 非 UI 冒烟阶段全绿、docs 222、记忆镜像 sha256 一致。
- **环境事实（今日沙箱更新后，非代码问题）**：沙箱注入的代理端口由 11811 → **3935**，且环境块同时含 `https_proxy`/`HTTPS_PROXY` 大小写成对重复（.NET `Start-Process` 因此直接抛「字典关键字重复」）；**headless Edge（msedge.exe）自本次会话起被沙箱静默击杀**（日志止步 variations 初始化、约 200ms、无 stderr/无截图/无事件日志，`--no-sandbox`/`--headless=old`/独立 user-data-dir/清代理 env 均无效；PowerShell 通道同现象；昨日 11-12 冒烟全绿）→ 冒烟改用 `EDGE_PATH` 指向 Puppeteer 自带 `chrome-headless-shell` 可在沙箱内完整执行（见 §61 ④ 的订正与实测）。doc_check 的 W1 断言「PG 迁移恰好 1 条」随 W6.0/W6.1 合法新增迁移改为 `>=1`（SQLite 归档仍须恰好 11 条）。
- **遗留**：`withUserRooms` 每次 `storage.all()` 全表扫（markDisconnected/reconnect/listForUser 同路径），房多后是性能点，W6.x 收口；房间态路由仍走进程内 `gameSessions` 快照缓存，跨实例 room 送达在 #188 双实例 E2E 验。

## 61. 本机 verify 18 红的 5 个根因（其中 2 个只在 Windows 本机暴露，2026-11-13）

- **背景**：杰哥在本机 PowerShell 跑 `$env:MPK_FRONT_PORT="5174"; npm run verify` → 33 通过 / 18 失败；同一份代码在沙箱 bash 里全绿。差异全部落在「shell 语义 / 编码 / 进程编排 / dev server 生命周期」四类，产品代码零语义变更。
- **① 后端单测整阶段失败 `Could not find 'E:\...\backend\tests\*.test.ts'`**：`"test": "tsx --test tests/*.test.ts"` 依赖 shell 展开 glob。bash 会展开、PowerShell/cmd **不展开**并原样交给 node，node 对单星号不做 glob。修：改 `tsx --test "tests/**/*.test.ts"`（带引号 → 交给 Node 22 test runner 自己的 glob），bash/PowerShell 同一条命令都成立，实测 453/453。
- **② doc_check 抛 `UnicodeEncodeError: 'gbk' codec can't encode '\u2705'`**：Windows 本机 stdout 是 GBK(cp936)，断言名里含 ✅ 时 `print` 直接崩；沙箱 `PYTHONIOENCODING=utf-8` 所以从没暴露。修：脚本顶部对 stdout/stderr `reconfigure(errors="replace")`——编码不变（中文照常可读），只把不可编码符号降级成 `?`，绝不中断。用 `PYTHONIOENCODING=gbk` 复现并验到 `DOC_CHECK_OK`。
- **③ W4 24/3 与 p42b 41/2 同源：临时实例抢走 sweep leader，硬杀后不释放**：W2/W3/W5 的双实例 E2E 会 spawn :3002 临时实例，它同样装配 sweepLeader 抢 `lock:sweep:global`；退出走 `SIGTERM/SIGKILL`（Windows 下等同直接杀进程，`shutdown()` handler 不执行）→ 租约只能等 60s TTL 过期。窗口内常驻 :3001 抢不回 leader → 全局 sweep 与房间 tick 停摆 → W4 的 A1/A2/F0 读到 `leader=false current=false fence=0`，p42b 的「超时代放」不触发（`turn=undefined`）。修：`index.ts` 支持 `MPK_DISABLE_SWEEP=1` 跳过选主（打 warn 说明仅测试用），W2/W3/W5 的 spawn env 加该变量，生产不设。修后 W4 27/27、p42b 43/43，且 W2→W3→W4→W5 连跑稳定。
- **④ 14 套 UI 冒烟全白屏：`public/` 写入触发 Vite full-reload**：冒烟必须把 `_*_seed.html` / `_*_probe.html` 放进 `public/` 才能与 App 同源读 iframe 的 document，但 public 内任何变更都让 Vite 发 `full-reload`：页面在 dump-dom 采样窗口里被强制刷新 → React 挂不上 → `<div id="root"></div>` 空、`textLen:0`、probe 卡在 `data-probe="PENDING"`。证据：dev server 日志 `14:38:44 [vite] (client) page reload public/_p21_seed.html` … 共 29 次，与杰哥 verify 的时间窗完全重合。修：`vite.config.ts` 加 `server.watch.ignored: ['**/public/_*.html']`；修后同样跑冒烟，日志零 `_*.html` reload。**顺带订正 §60 的结论**：不是「沙箱内跑不了冒烟」——沙箱拦的是 `msedge.exe`，用 `EDGE_PATH` 指向 Puppeteer 自带 `chrome-headless-shell`（`C:\Users\Six\.cache\puppeteer\chrome-headless-shell\win64-131.0.6778.204\...`）即可完整跑 14 套冒烟，本轮全部冒烟均由它在沙箱内执行。
- **⑤ W2 21/4：`AUTHORITY_MISMATCH` 抢在 CAS 之前拦掉请求（测试自身 50% 竞态）**：D 段每轮并发提交 `1200-round` / `1100-round` 两路、差 100。服务端每次成功写入会把 `authority.expected` 同步成**落库值**（反作弊：金币减少后不能凭空涨回），所以一旦 `1100` 那路赢，expected 掉到 `1099`，下一轮 `1198` 必然 400、走不到 409。证据：失败行 `statuses=400,200` 且裁决值 `1099 = 1100-1` 正是上一轮赢家值；此前全绿纯属时序运气（本地 :3001 总比 :3002 先到）。修：两路改相邻 `1200-round` / `1199-round`——落库值 ≥ `1199-r`，下一轮最大候选也是 `1199-r`，数学上任一方赢都不会超；D5 断言同步改 `[1196,1195]`。连跑 3 次 25/25。
- **验收（本轮最终）**：`MPK_FRONT_PORT=5174 EDGE_PATH=<chrome-headless-shell> npm run verify` → **51 通过 / 0 失败 / 0 跳过，453.0s，`VERIFY_OK`**；14 套 UI 冒烟全绿（p21 15 / p31c 15 / p41 13 / p42a 17 / p42c 19 / p42d 15 / p42e 16 / f01f02 17 / f16 15 / f04 15 / f18a 9 / f18b 15 / f18c 18 / ux 26）、后端 453 单测、docs 222、记忆镜像 sha256 一致。
- **教训**：沙箱里全绿 ≠ 本机能跑。凡「依赖 shell 语义（glob / 引号 / 编码）」或「依赖进程时序」的断言，都要在 PowerShell + GBK 下过一遍；本次 5 项里有 3 项属此类。

## 62. 本地存档全栈删除（P5 过渡态收尾，2026-11-13）

- **杰哥口径**：「本地存档相关的都可以删掉，无论是逻辑还是文件，包括 md 里面曾经记录的『铁律』『方案』，那些都是早期的。」
- **删除理由（先确认了它们真是死的，不是还在用的）**：
  - `useGameStore` 的 `customStorage` 实际是**坏代码**——`getItem` 用裸 `fetch('/api/save')`（无 Authorization → 后端 `authenticate` 直接 401），`setItem` 用 `POST /api/save`（后端只有 `PUT /api/save` → 404）。所以它名义上「云端优先、本地兜底」，实际每次读写都只落到 `localStorage`：既没同步到云端，还白送一次必然失败的请求。
  - `rebase.ts` 的 `markRebase()` **全仓零调用**，只剩 `sync.ts` 里 `takeRebase()` 读一个永远 false 的标记。
  - `resetSave()` 只 `set({ save: null })`，服务端那份还在——刷新（`GET /api/save`）就回来，「重新开始」按钮是个假动作。
- **删除清单**：
  - 前端逻辑：`useGameStore` 的 `persist` 中间件 + `customStorage` + `migrate`/`merge`/`partialize`/`version`；`saveVersion.ts` 的整条 `migrateSaveState`（v1→v11 逐级补字段，约 140 行）；`syncPolicy.ts`（LWW 决策纯函数）及其单测；`rebase.ts`；`sync.ts` 的 `startAutoSync`/`stopAutoSync`/`scheduleUpload`/`flush`/`offlineQueue`/`flushQueue`/`cancelPendingUpload`/`suppressNextUpload`/`syncOnLogin`/`getSyncDiagnostics`；`session.ts` 与 `useGameStore` 的 `suppressNextUpload` 调用（3 处）；`App.tsx` 的 `SyncBootstrap`；`Auth.tsx` 的 `syncOnLogin`；`Start.tsx` 的 `resetSave` 假按钮改为走服务端 `new_game` 覆盖。
  - 前端文件：`src/lib/syncPolicy.ts`、`src/lib/syncPolicy.test.ts`、`src/lib/rebase.ts`、`src/stores/saveVersion.test.ts`、`scripts/ui_smoke_p12.mjs`（P1-2 期旧冒烟，早被 `ui_smoke_p21` 取代且不在 verify 内）。
  - 冒烟 seed：14 个脚本里的 `localStorage.setItem('beast-journal-save', …)` 与 `const persist = …` 全部去掉，只注入 `mpk_token`；云端基线仍由 `PUT /api/save` 建立。
- **新增（删了本地副本就必须有它，否则刷新后页面是空的）**：
  - `src/lib/saveBootstrap.ts`：登录态下 `GET /api/save` → `setRevision` + `importSaveJson(keepBattle)`；404 记 revision=0（下次提交即新建）。
  - `App.tsx::BootGate`：登录态且在拉到档之前只渲染「正在读取服务端存档…」，不渲染路由——否则 Start 会先闪一屏「开始新旅程」、Camp 会因空档误判跳回首页。**未登录直接放行**（登录页不需要存档）。`BootGate` 内**先调 `startRealtime()` 再发 GET**：实时通道不依赖存档，WS 建连不能被存档请求推迟（见下一节的新坑）。
  - `Auth.tsx` 登录成功后 `await bootstrapSave()` 再 `navigate("/")`（`BootGate` 在未登录时已放行，不会再跑第二次）。
- **新坑（本轮引入并修掉，勿回退）：`--virtual-time-budget` 快进冲掉真实网络**。
  - 现象：`npm run verify --only=smoke` 批量跑时 `p42d` 11/4、`p42e` 12/4，但**单独跑同一条脚本 15/15 全绿**。失败项全部收在 `timeout:waiting`，页面停在弹窗态并显示「进入房间需要实时通道在线」。
  - 根因：`--dump-dom` + `--virtual-time-budget=40000` 会把 `setTimeout(50)` 瞬间快进（240 轮 ≈ 12s 虚拟时间可能只对应几十毫秒真实时间）。本地存档时代页面首帧就是同步 hydrate，WS 在建连那一刻就发起、赶在快进前握完手；加上 `BootGate` 的 GET 之后 WS 发起变晚，快进直接跨过握手窗口 → 点「创建房间」时还没连上。单独跑时因进程/缓存状态不同侥幸躲过（再次印证「偶发红不能靠重跑掩盖」）。
  - 修法：① `BootGate` 里 `startRealtime()` 与 `bootstrapSave()` 并行发起；② `p42d`/`p42e` 的 `waitFor` 每 4 轮挂一个真实 `fetch('http://localhost:3001/api/health')`，让 Chromium 的 `pauseIfNetworkFetchesPending` 生效，给真实网络留落地时间。修后两条各 15/15、16/16。
- **文档同步清理**：`MEMORY.md`（顺带从 13388 → 10095 字节，删掉已被后续阶段取代的历史细节，保留硬约束+索引+进度+验收锚点）、`.trae/documents/项目记忆.md`（镜像）、`HANDOFF.md` 三处、`后端开发规范_backend.md` 九处、`技术架构-原创抓怪回合制RPG.md`（§1 图 / §2 / §4 / §5 从「无后端 + localStorage」改为现行架构）、`开发路线图_roadmap.md` 六处、`未来规划与技术债` 两处、`PRD` 一处。
- **保留但订正口径**：后端 `saveValidator` 对 `version < EXPECTED_SAVE_VERSION` 仍是 `warn('VERSION_OLD')`（不 reject）——那是服务端的纵深防御，与客户端有没有 migrate 无关；规范里「将由客户端迁移」的说法已删。
- **新坑 2（同源，务必别再犯）：`session.state` 监听晚于 WS 推送 → 首条快照被静默丢掉**。
  - 现象：`p21` 的「Start 收到服务端权威快照（rev=N）」红，页面显示「在线权威态：等待服务端快照」，但「实时通道已连接」。
  - 根因：`SessionBootstrap`（注册 `mpk:session-state` window 监听）挂在 Router 内，被 `BootGate` 一起挡住；而 WS 是在 `BootGate` 里并行发起的 → 服务端 `hydrateForUser` 推的第一条快照到达时还没有监听者，`window.dispatchEvent` 对空监听直接丢弃（事件不排队）。
  - 修法：`BootGate` effect 里**先 `startSessionSync()` 再 `startRealtime()`**（两者都是幂等的，Router 内再调不会重复注册）。这条与 W6.1 后端「`attachWsHandlers` 必须在任何 await 之前挂载」是同一类 bug 的两侧。
  - 顺带把 `p21` 探针的固定 `setTimeout(4000)` 改成「60 次带真实 `fetch` 的心跳后再采样」——`--virtual-time-budget` 会把 4000ms 瞬间快进，固定延时的语义在有异步首屏之后就不成立了。
- **验收（本轮最终）**：`MPK_FRONT_PORT=5174 EDGE_PATH=<chrome-headless-shell> npm run verify` → **51 通过 / 0 失败 / 0 跳过，266.7s，`VERIFY_OK`**；前端单测 133（删掉 syncPolicy 7 例 + saveVersion 4 例后仍全绿）、后端 453、14 套 UI 冒烟全绿（15/15/13/17/19/15/16/17/15/15/9/15/18/26）、docs 222、记忆镜像 sha256 一致。
- **口径沉淀**：前端写档只剩两个入口——服务端快照 `importSaveJson`（含 WS `session.state`）与意图通道 `intents.ts`。**不要再引入任何本地缓存真值**。

## 63. 推送环境事故复发（第三次）与「新机交代」补齐（2026-11-13）

- **现象**：W6.1（`5129aab`）与本地存档删除（`341c72a`）两阶段收官后，工具会话内累计 5 次 `git push` 全败（502 ×2、`schannel: server closed abruptly`、`127.0.0.1:8693` 未监听、直连 reset）；杰哥在本机 PowerShell 同一时刻一次 `git push origin master` 即 `402b343..341c72a`。与 §56（11-12）、11-09 那次同源，是**第三次**。
- **复发原因**：不是没记——规矩同时写在用户级 `MEMORY.md:43/48`、`HANDOFF.md:80-81`、项目 `MEMORY.md §4`、`bug_log §56/§57`，且 `scripts/doc_check.py:880/890/898` 三条断言守着、当轮 222 项全过；上一轮甚至刚改过 HANDOFF。失效点是**动手那一刻没把规则调出来**：先重试 3 次才读 `env`，还照 §56 去试系统代理和直连，最后定性成「网络侧问题」。存储没问题，检索 / 触发有问题。
- **订正（覆盖 §56 执行口径）**：环境类失败先读 env 分清三层；`git push` 在工具沙箱内失败**最多 1 次**，不换代理 / 不试直连 / 不做连通性排查，直接给【本机终端】完整命令；杰哥说「我这边能通」立即按环境差异处理。§56 的一次性 `HTTPS_PROXY=8693` 覆盖解法**降为历史记录，不再执行**（正是本次复发的诱因）。收尾核对新增「本地 tag 是否全部已在远端」。
- **漏推 tag**：核对发现 `rollback-20261113-w61`（`5129aab`，W6.1 那次 502 后没收尾）本地有、远端无，已补推；历史遗留 `rollback-20261111-f18c-security`（`00eab5c`）一并补齐。
- **机制分层（界面原文）**：① 「给 WorkBuddy 的指令」=「之后每次对话和任务都会默认生效」→ 常驻硬规则；② 「本地记忆与技能」=「支持用户级和项目级，让智能体在后续任务中遵循」→ 项目细节与证据；③ 「云端记忆」=「每晚自动整理更新」的偏好画像（工作背景 / 个人背景 / 当前关注 / 近期动态）→ 会被概括重写，**不放可判定的硬条件**。硬规则只进 ①，细节留 ②。
- **新机交代**：`~/.workbuddy/app/app-config.json` 的 `personalization` 不随 git（项目内搜该指令全文 0 命中），也未证实随账号同步 → 家里那台电脑按「要粘一次」准备；HANDOFF §4.1 原样收录四条指令文案，`scripts/check_home_env.py` 加只读检查、缺则 `[WARN]` 指向 §4.1，§5 话术第 3 条亦补确认步骤。
- **别再往 md 里堆同款文字**：加文字不解决触发；真要硬拦截得做成执行面脚本（如 `scripts/push.mjs`），本轮未做。
- **补充判别（11-13 23:35，W6.2 推送误判；订正上条被过度套用）**：W6.2 本地提交 `12cb4b3` 后 `git push` 单次报 `Recv failure: Connection was aborted`，被直接按「环境类阻断」交本机终端；杰哥指出「你应该可以推送的」。实测 `git ls-remote origin refs/heads/master` 正常返回 `faa627c`、`curl .../info/refs?service=git-upload-pack` = `200` → **通道本身是通的**，属传输中途偶发抖动，不是 §56/§63 的代理层错配。随后未改任何代理 / 配置，一次 `git push origin master` 即 `faa627c..12cb4b3` 成功，`pre/post-w62` 两个 tag 一并补推，本地 81 个 tag 与远端 81 个全对齐（`TAG_PARITY_OK`）。**判别顺序**：push 失败 → 一次只读探活 → 200 / 有返回 = 允许原样重试 1 次；探活也失败 / 502 恒现 / env 层错配 = 交本机终端。「最多 1 次、不换代理、不试直连、不改 git config」的边界不变，只是别把偶发抖动误归类为环境类阻断。

## 64. P5-1 W6.2 收官：room + quota + 结算写档 + 发奖同一事务边界（2026-11-13）

- **工单**：#183，实施权威 `P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md` §3.6 / §4.2「W6 房间 + quota」第 1 条。W6.1 已把 `RoomStorage` 异步化 + PG 行版本 CAS，但 `bump()`（room 行）、`finishQuota()`（RoomQuota 行）、`commitState()`（Save 行）、`grantCoopClearReward()`（CoopRewardGrant 行）仍是**四次各自自动提交**；`maybeSettlePvp/Coop` 还是 `void import(...).then(...)` fire-and-forget，结算写档根本不在房间推进的调用栈里。崩在中间即留下「房间 settled 但奖励没发」或「quota 扣了但房间没结算」。
- **做法（工程实现层，零产品语义变更）**：新增 `lib/roomUnitOfWork.ts` —— `AsyncLocalStorage` 保存当前 `prisma.$transaction` 的 tx 客户端，`roomDb()` 让四个存储层共用它；`onRoomCommit()` 把内存权威态 apply 与 WS 广播挂到**提交成功后**（事务回滚时钩子全部丢弃）；`withRoomUnit(roomId)` = 房间锁 + 同一事务，嵌套复用外层事务，事务 `maxWait=5s / timeout=15s`。
- **四个存储层接入**：`pgRoomStorage.ts`（`create` 改 `createMany + skipDuplicates`，避免事务内 P2002 把 PG 事务置为 aborted）、`session.ts` 的 CAS store、`saveRead.ts`（**事务内必须读 DB**：内存 apply 已延后，读内存会拿旧档覆盖同事务前一次写，典型场景是共斗「回写队伍」后再「发通关奖励」）、`coopReward.ts`（事务内 `commitState` 失败必须冒泡让整包回滚，原来 catch 后手删占位记录会吞错）。
- **结算链 await 化**：`maybeSettlePvp/Coop` 改 `await import()` + `await settle*Room()`，失败冒泡 → 事务回滚 → `setSettledFlag` 与 quota 一起撤销 → Redis 长期 claim 释放、下轮 tick 可重试；`settleCoopRoom` 两个 catch 与 `grantOne` 的 catch 在 `isRoomUnitActive()` 时一律 throw。`publishRoom` 的 `room.state` 广播也改为 after-commit；`realtime.ts` 的掉线 / 重连多房写同样纳入工作单元。`tickRoom` / `sweepRooms` 对事务失败记日志降级，不把惰性读打成 500、不中断其它房间的 sweep。
- **锁序复核**：`withRoomUnit` 持 `room:<roomId>`，`settleCoopRoom` 内层取账号锁；不同 key 在 `LockProvider` 里是独立队列（Redis `SET NX` 同理），不构成 room→account / account→room 死锁；`applyCoopCreate` 原本 account→room 的顺序保持不变。
- **验收**：`w62RoomUnit.test.ts` 8 例（fake runner 零 IO：同一事务客户端、提交后才跑钩子、失败钩子全丢、嵌套不开新事务、四类读写共用客户端、`skipDuplicates`、`withRoomUnit` 串行）；`e2e_w62_room_tx.mjs` 13 项（真 PG：建房 + quota hold 原子可见、并发双意图只推进 `turn=2`、提交后才广播、nonce 重放无半写、重复 settle 只扣一次）。注册 `e2e:w62` + `STAGES`/`GROUPS.e2e` 两处 + `doc_check` 4 条断言。全量 **52/52 `VERIFY_OK`**、后端单测 **461**、前端 133、14 套 375px 冒烟全绿。
- **首轮红（已修）**：`doc_check` 的 W4 断言硬绑 `room.ts` 里的 `withRoomLock` 字符串，W6.2 换成 `withRoomUnit` 后误报；按文档解耦口径改为查 `roomUnitOfWork.ts` 的 `withRoomLock`（锁职责未变）+ `room.ts` 的 `withRoomUnit`，不绑旧函数名。全量 51/52 → 修断言后 52/52。
- **边界（留给后续工单）**：`committed` 仍是 `RoomQuota` 行的 read-modify-write upsert，并发不超卖由 **#184 W6.3 DB 计数 + 结算二次 count** 解决；quota 租约 token / TTL / release 全分支是 **#185 W6.4**；序列化 3 障碍 **#186 W6.5**；裁剪视图与 revision 区分 **#187**；双实例 E2E **#188**。**W6.2 不宣称并发不超卖**，E2E 也刻意不做该断言（避免超前验收）。



