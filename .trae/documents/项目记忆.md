# MEMORY.md — MonsterPK（兽域手记）项目记忆

> 权威源：**本文件**。镜像：`.trae/documents/项目记忆.md`（用 `scripts/sync_memory.py` 双向同步）。
> 每日工作日志：`.workbuddy/memory/YYYY-MM-DD.md`（追加写，不改旧内容）。

## 0. 两边同步约定（2026-11-03 建立）
- `.workbuddy/memory/MEMORY.md` 与 `.trae/documents/项目记忆.md` 内容必须逐字一致。
- 改完任一侧后跑：`python scripts/sync_memory.py`（默认 workbuddy → trae；`--reverse` 反向；`--check` 只校验）。
- `.trae/documents/` 里的 PRD / 技术架构 / 路线图 / bug_log 属于**产品文档**，不被本文件覆盖；代码与文档的偏差记在下面第 3 节。

## 1. 项目是什么
浏览器 + Capacitor/Android 的原创抓怪回合制 RPG 原型「兽域手记」（appId `com.monster.game`）。
核心循环：营地 → 野外遭遇 → 回合制战斗 → 捕获 → 战后结算 → 回营地管理/图鉴。
纯前端无后端：存档走 localStorage（zustand persist，key `beast-journal-save`）+ JSON 导入导出；
dev/preview 另有 `/api/save` 中间件落盘 `save_data.json`（`vite.config.ts` 里的 `localSavePlugin`）。

## 2. 技术栈与代码入口
React 18 + TS + Vite 6 + Tailwind 3 + zustand 5 + react-router 7。路由：`/` 启动页、`/camp` 营地、`/arena` 训练场。
- 内容数据源（唯一）：`src/game/data.ts` — MOVE_SPECS、ITEM_SPECS、MONSTER_SPECS（40 只）、STARTERS、THEME_TABLE、LOCATIONS（7 城镇）
- 规则引擎：`src/game/rules.ts` — 18 属性克制表、伤害/暴击/多段、异常状态、捕获率、升级、进化重算、`getMoveMaxPP`（技能 PP 分档）、`initPP`（战斗内 PP 初始化）
- 挂机：`src/game/idle.ts` — 离线结算金币/捕获器（8h 封顶、捕获器按区域难度 Lv10/Lv20 解锁）；首通记录 `SaveData.clearedAreas`，打赢即写入
- 遭遇生成：`src/game/gen.ts` — 稀有 8% / 精英 12%，等级带 clamp 1~30
- 全局状态：`src/stores/useGameStore.ts`（1010 行，最核心）— 3 存档槽；`SAVE_VERSION="0.1.0"`；persist `version=9`，migrate 链 1→9
- 页面：`src/pages/Start.tsx`（多槽位+导入导出）、`Camp.tsx`（5 Tab）、`Arena.tsx`（战斗/捕获）
- 弹窗：`MechanicsModal` / `MoveChartModal` / `MoveLearnerModal` / `EvolutionModal` / `TypeChartModal`

## 3. 文档与代码偏差（2026-11-03 与 2fc7439 同步后）
- 路线图 `.trae/documents/开发路线图_roadmap.md` 已整体更新到与代码一致（含 PP/挂机、世界地图、5 Tab、3 存档槽、克制卡片、测试菜单），并保留「文档与代码一致性核对」表。
- **远端已落地、本次 pull 验证为真的系统**：技能 PP（`getMoveMaxPP` 按威力分档、`BattleState.ppByMonster` 战斗内消耗、敌我均扣减、归零禁用）、首通记录 `SaveData.clearedAreas`、远征挂机（`idle.ts` + `startIdle`/`settleIdle`，8h 封顶、捕获器按区域难度解锁）。这三者是 `2fc7439` 提交新增。
- **仍真实存在的待修缺口**（已登记进路线图「已知遗留缺口」）：
  - 道具进化全链路未打通：`useItemOutsideBattle` 只处理 `kind==="heal"`，进化石（已在商店卖）买了用不了。
  - 关键道具无效：`amulet_coin`（金钱翻倍）、`exp_share`（经验分享）已售卖但无任何效果代码。
  - 捕获率仅按概率分 3 档摇晃，未计稀有度/等级差。
  - `SAVE_VERSION="0.1.0"` 与 persist `version=9` 已脱钩（见第 4 节）。
- 已删：空壳 `src/pages/Home.tsx`（2026-11-03）。

## 4. 改代码前必读的硬约束
- **新增持久化字段 → 递增 `SAVE_VERSION` 且递增 persist `version` 并补 `migrate` 分支**，老存档必须还能玩（bug_log 第 3 条就是这个坑）。
- `data.ts` 是大对象字面量，漏写 `};` 会让后面的 `export` 落进对象内部 → 报 `Unexpected keyword 'export'`。改完立刻 `npm run check`（= `tsc -b --noEmit`）。
- 禁用 `crypto.randomUUID()`（旧 WebView 没有），统一用 `rules.ts` 的 `uuid()`。
- 所有 Hook 必须在组件顶层，渲染函数（如 `renderDex`）里不能再 `useState`。
- 移动端优先：弹窗需小 `max-w` + `overflow-auto` + `max-h`；禁止大表格横向滚动。
- 打包：Capacitor + 云端 Android SDK 全流程见 `apk_build_guide.md`。

## 5. 运行命令（2026-11-03 实测通过）
- 装依赖：`npm install`（已装，368 包）
- 起服务：`npm run dev -- --host 0.0.0.0 --port 5173 --strictPort`（固定 5173，别换端口）
- 校验：`npm run check`（tsc）/ `npm run build`（vite build，约 5s，产物 542 KB JS）/ `npm test`（vitest，3 个用例全过）
- `strict: false`、`noUnusedLocals: false` —— 类型检查很宽松，别指望 tsc 兜住所有问题。

## 6. 本机环境事实
- 项目目录 `E:\Six\MonsterPK`（NTFS，安全，非 U 盘）；git remote `https://github.com/LJJ666666/MonsterPK.git`。
- 本地 master = `2fc7439 加入技能 PP 与远征挂机系统`（base `65c2ac6` 初始化 + 远端 1 提交）；2026-11-03 用 `git pull --ff-only` 拉取，无冲突（roadmap 冲突已手动合并）。
- `node_modules` 已装（368 包）；dev server 跑在 `http://localhost:5173`（background 任务 9EoK2s，HMR 已加载新代码）。
- 生产构建带 `sourcemap: 'hidden'`；`vite-plugin-trae-solo-badge` 仅 prod 注入右下角标。
- dev/preview 的 `/api/save`：无 `save_data.json` 时返回 404，属正常，store 会回退到 localStorage。

## 7. 已修的坑（改前都是拦路虎）
- **`tsconfig.json` 的 `ignoreDeprecations: "6.0"` 是 TS 5.8 的非法值**（TS5103），会让 `npm run check` 与 `npm run build` 直接失败。已于 2026-11-03 删除该行。
- `rules.ts::createInstance` 残留的调试 `console.log` 已删除。
- 未被任何路由引用的空壳 `src/pages/Home.tsx` 已删除。
