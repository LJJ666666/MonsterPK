# demo-app —— 离线演示包工程（L1 / L2 / L3）

> 主工程是「服务端权威 + 强制登录 + PG/Redis」，真机看界面必须连后端。
> 本目录产出**不连后端**的演示 APK，供随时随地在手机上查看界面、走查布局、验收 UI 改动。
> 按深度分三层推进（见文末「深度路线」）：**当前交付 L1**（看界面，战斗回合不真推进、写操作不落地）；
> L2 待实现（简化战斗）；L3 冻结（完整引擎，不建议在演示包内重做）。

## 为什么独立成目录（2026-11-17 定案）

早期 L1 曾把 mock 插件塞进主工程 `vite.config.ts`、mock 文件放 `src/mock/`，
虽然用 `MPK_MOCK=1` 做了构建期隔离，但**配置和源码仍和主工程混在一起**，
后续 L2 会越滚越大。现在整体迁到 `demo-app/`：

- **主工程零污染**：`vite.config.ts` / `src/` 完全还原；默认 `npm run build` / `verify` /
  全部冒烟都不读本目录，产物零 mock 痕迹。
- **可提交 git**：mock 配置、替身、fixtures、出包脚本都在本目录，纳入版本控制；
  产物（`dist/`、`output/*.apk`）走 `.gitignore` 不入库。
- **可扩展**：L2（简化战斗引擎）继续在本目录加文件，不动主工程一行。

## 目录结构

```
demo-app/
├── vite.config.ts        # 独立构建配置：复用主工程入口，resolve 阶段重定向 api/ws
├── vitest.config.ts      # 独立单测配置：只扫本目录，不进主工程 162 项口径
├── tsconfig.json         # 独立类型检查（主工程 tsconfig 只 include src/api）
├── build-apk.mjs         # 一键出包：构建 → 拷 assets → gradle → 恢复默认 assets
├── README.md             # 本文件
├── src/
│   ├── api.mock.ts       # api 替身：读 fixtures + L2 战斗真推进 + 假登录 JWT
│   ├── battle.engine.ts  # L2 简化战斗状态机（只用主工程前端纯函数）
│   ├── battle.engine.test.ts # L2 引擎单测（8 项）
│   ├── ws.mock.ts        # ws 替身：不建连、恒 online（避免断线横幅）
│   └── fixtures/*.json   # 从真后端抓的真实结构快照（存档/榜单/Boss/演武堂等）
├── dist/                 # [gitignored] mock 前端产物
└── output/*.apk          # [gitignored] 最终 APK
```

## 出包

工具链路径走 env 覆盖 → 常见位置探测 → 明确报错，不写死单机路径。

```bash
# 只出包（APK 落在 demo-app/output/）
npm run demo:apk

# 出包并装到已连接的设备/模拟器（雷电 emulator-5554 亦可）
MPK_ADB=/d/game/leidian/LDPlayer14/adb.exe npm run demo:apk:install
```

脚本做完会自动**恢复主工程 Android assets 为默认版**——即便中途失败（`finally` 保证），
下次直接打正式包不会误带 mock。

启动（若未用 `--install`）：

```bash
adb shell am start -n com.monster.game/.MainActivity
```

独立校验（不碰主工程 verify）：

```bash
npm run demo:check   # demo-app 类型检查
npm run demo:test    # L2 战斗引擎单测（8 项）
```

## 演示包行为契约（L1 + L2）

| 能 | 不能 |
|---|---|
| 假登录：任意用户名密码点登录即进 | 不连后端，多人 / 实时功能空壳 |
| 固定存档：3 只兽 + 仓库 + 12860 金币 + 丰富道具 | 退出进程回到固定存档（结算只进内存副本，不落盘） |
| 看所有界面：地图 / 队伍 / 图鉴 / Boss / 演武堂 / 商店等 | 不发徽章 / CD / 次数 / 掉落 / 榜单等服务端权威真值 |
| **L2 真打一场**：技能 / PP / 命中 / 伤害 / 异常 / 换人 / 捕获 / 逃跑 / 敌方回合 / 经验金钱奖励 | 不做服务端完整引擎（见 L3 冻结说明） |
| 无网络请求、无断线横幅 | — |

fixture 存档来自真后端真实结构快照，按 `data.ts` 的合法 spec 增强，界面渲染数据结构真实。

## 已踩坑（勿重犯）

1. **黑屏根因（2026-11-17）**：fake JWT 的 `btoa()` payload 里放了中文 `演示账号`，
   `btoa` 只接受 Latin1，抛 `InvalidCharacterError` → 模块顶层崩溃 → React 挂不上 → 全黑。
   **规则：`btoa()` 的 JSON 必须纯 ASCII；中文放 fixture 渲染层，不进 JWT。**
   真机 logcat 一条 `btoa ... outside of the Latin1 range` 即定位；headless 当时抓不到。
2. **cap sync/copy 被沙箱 shim 拦**：出包脚本绕开 CLI，直接 `cpSync` 到 assets/public。
3. **出包后必须恢复 assets**：否则下次 gradle 直出会误打 mock 包；脚本 `finally` 里恢复。

## 深度路线（L1 / L2 / L3）

> 三层都在本目录内实现，**主工程零改动**；层级只决定 mock 替身的厚度，
> 不改业务源码、不连后端、不污染默认构建。成本为单人估算。

| 深度 | 做什么 | 能测什么 | 成本 | 状态 |
|---|---|---|---|---|
| **L1 快照** | mock 登录 + 存档 + 各页面 GET 返回固定数据 | 看界面、点 tab、查布局；进战斗界面能看到怪和按钮 | 几小时 | 已完成（雷电真机已验） |
| **L2 简化战斗** | mock 层用前端 `src/game/rules.ts` 推进回合 | 能真点技能打一场，测战斗 UI 交互流程 | 1–3 天 | 已完成（单测 8/8，待真机复核） |
| **L3 完整引擎** | 把服务端发奖 / 进化 / 去重 / CD 全搬前端 | 真玩法测试 | 几天~两周（= 方案 C） | 冻结，不建议 |

### L1 快照（已交付）

行为契约见上文「演示包行为契约」。要点：读操作全走 fixtures，写操作返回 ok 但不推进状态；
战斗能进、按钮能点，回合不真变化。退出重进回到固定存档。

### L2 简化战斗（已实现，待真机复核）

- **落点**：本目录 `src/battle.engine.ts`（新增）+ `src/api.mock.ts` 的
  `battleStart` / `battleAction` / `battleCurrent` / `battleAbandon`
  + `bossStart` / `gymStart` / `mapBossStart`（L1 只回 battleId 会让主工程 store 报缺 battle，
  L2 一并返回真实视图）。
- **复用**：主工程纯函数 `@/game/rules`（`computeDamage` / `gainExp` / `getSpeed` /
  `canMove` / `applyDamage` / `getMoveMaxPP` / `createInstance` 等）与
  `@/game/data`（`MONSTER_SPECS` / `MOVE_SPECS` / `ITEM_SPECS` / `THEME_TABLE`）。
  **不 import 服务端任何模块**——这是 L2 与 L3 的分界线。
- **内存战斗态**：`battleStart` 按主题表生成敌人、拷贝队伍、初始化 PP；
  `battleAction` 推进「玩家意图 → 敌方选招 → 命中/伤害/异常/PP → 回合末 → 胜负与奖励日志」，
  返回与 `ServerBattleView` 同形状的视图；`battleCurrent` 取回在场战斗；`battleAbandon` 清空。
  敌方 HP 差累计 `damageDealt`。
- **边界**：只在本次 APK 进程内有效；战斗结算把 HP / 经验 / 金币 / 捕获 / 道具消耗写进
  **内存存档副本**，`getSave()` 能立即读到（主工程结算后 `refreshSaveFromServer()` 会拉它），
  但退出进程回到 fixture 固定存档。不写 localStorage、不发网络请求。
- **单测**：`npm run demo:test` → 8 项（开局视图 / 技能真推进 / PP / OHKO 结算 /
  捕获 / 换人 / 逃跑 / 特殊战禁捕），`npm run demo:check` 独立类型检查。
  主工程 `npm test` 只扫 `src/**`，不受影响（仍 162 项）。
- **验收口径**：雷电真机点技能，敌方 HP / 己方 HP / PP / 回合数 / 战斗日志每次动作都真实变化，
  能打到「敌方倒下 → 获得经验与金钱」或「己方全灭」；战斗 UI 无卡死、logcat 无 JS 错误；
  主工程零改动，默认 `verify --strict` 仍 64/64。

### L3 完整引擎（冻结，不建议）

把服务端发奖 / 进化 / 去重 / CD 全搬前端，等于重复实现服务端权威逻辑：
会随时间漂移、与真实后端结果不等价，且成本接近另起一套引擎。
**结论：不做。** 需要真玩法测试时走方案 C（真实后端 + 正式包），
而不是把引擎塞进演示包。此节保留仅为记录分层决策边界。
