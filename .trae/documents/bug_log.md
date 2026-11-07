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
