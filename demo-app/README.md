# demo-app —— 离线演示包工程（L1 / L2）

> 主工程是「服务端权威 + 强制登录 + PG/Redis」，真机看界面必须连后端。
> 本目录产出**不连后端**的演示 APK，供随时随地在手机上查看界面、走查布局、验收 UI 改动。
> **不测玩法逻辑**——战斗回合不真推进、写操作不落地。

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
├── build-apk.mjs         # 一键出包：构建 → 拷 assets → gradle → 恢复默认 assets
├── README.md             # 本文件
├── src/
│   ├── api.mock.ts       # api 替身：读返回 fixtures，写返回 ok，假登录 JWT
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

## 演示包行为契约（L1）

| 能 | 不能 |
|---|---|
| 假登录：任意用户名密码点登录即进 | 战斗回合不真推进（点技能有反应但不结算） |
| 固定存档：3 只兽 + 仓库 + 12860 金币 + 丰富道具 | 写操作不落地，退出重进回到固定存档 |
| 看所有界面：地图/队伍/图鉴/Boss/演武堂/商店等 | 不连后端，多人/实时功能空壳 |
| 无网络请求、无断线横幅 | — |

fixture 存档来自真后端真实结构快照，按 `data.ts` 的合法 spec 增强，界面渲染数据结构真实。

## 已踩坑（勿重犯）

1. **黑屏根因（2026-11-17）**：fake JWT 的 `btoa()` payload 里放了中文 `演示账号`，
   `btoa` 只接受 Latin1，抛 `InvalidCharacterError` → 模块顶层崩溃 → React 挂不上 → 全黑。
   **规则：`btoa()` 的 JSON 必须纯 ASCII；中文放 fixture 渲染层，不进 JWT。**
   真机 logcat 一条 `btoa ... outside of the Latin1 range` 即定位；headless 当时抓不到。
2. **cap sync/copy 被沙箱 shim 拦**：出包脚本绕开 CLI，直接 `cpSync` 到 assets/public。
3. **出包后必须恢复 assets**：否则下次 gradle 直出会误打 mock 包；脚本 `finally` 里恢复。

## L2 扩展方向（未做）

L1 战斗不动。要 L2（点技能能真打一场），在本目录加一个简化战斗推进层：
复用主工程 `src/game/rules.ts` 的纯函数（`computeDamage`/`attemptCapture`/`gainExp`…），
在 `api.mock.ts` 的 `battleAction` 里维护一份内存战斗态并逐步返回——仍不碰主工程。
