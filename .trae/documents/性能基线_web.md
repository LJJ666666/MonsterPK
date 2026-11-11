# 性能基线（Web 运行时）

> 采集时间：2026-10-20
> 采集对象：`vite build` 产出的生产包，通过 `vite preview` 在沙盒内以真实 Chrome 150 加载。

## 0. 测试环境与口径说明

- 本沙盒**没有** `adb`、Android 模拟器、Android SDK（`adb / emulator / sdkmanager / avdmanager` 均不存在），因此 `android-performance` 技能依赖的 **Simpleperf / Perfetto / gfxinfo / meminfo** 原生链路无法执行。
- 本项目 APK 是 Capacitor 的 WebView 外壳，**业务性能瓶颈基本落在 JS 包体积、首屏渲染与 React 渲染成本**上，因此本次用同一份代码的 Web 运行时作为基线，能够覆盖绝大部分用户可感知的卡顿来源。
- 缺失的部分（真机 GPU 合成、WebView 版本差异、冷启动到首帧的进程拉起时间）需要在有 adb 环境时补测。

## 1. 构建产物

| 产物 | 体积 | gzip |
|---|---|---|
| `dist/assets/index-*.js` | 532.31 kB | 128.69 kB |
| `dist/assets/index-*.css` | 23.97 kB | 5.59 kB |
| `dist/assets/index-*.js.map` | 1,439.78 kB | — |

Vite 给出告警：单 chunk 超过 500 kB。

## 2. 冷启动（移动视口 390×844 DPR3，禁用缓存）

### 2.1 无节流（桌面级 Chrome）

| 指标 | run1 | run2 | run3 |
|---|---|---|---|
| TTFB | 15 ms | 5 ms | 7 ms |
| FCP | 176 ms | 92 ms | 88 ms |
| LCP | 244 ms | 92 ms | 88 ms |
| DOMInteractive | 95 ms | 52 ms | 50 ms |
| DOMComplete | 121 ms | 59 ms | 56 ms |
| CLS | 0 | 0 | 0 |
| 长任务数 | 0 | 0 | 0 |
| 请求数 / 传输量 | 6 / 138 kB | 5 / 137 kB | 5 / 137 kB |
| JS 堆 | 2.3 MB | 3.5 MB | 4.3 MB |

### 2.2 CPU 4x 降速 + Fast 3G（近似中低端手机）

| 指标 | run1 | run2 |
|---|---|---|
| TTFB | 12 ms | 9 ms |
| FCP | 1080 ms | 1056 ms |
| LCP | 1112 ms | 1076 ms |
| DOMInteractive | 566 ms | 562 ms |
| DOMComplete | 1026 ms | 1012 ms |
| CLS | 0.0007 | 0.0007 |
| 长任务数 | 0 | 0 |

## 3. 关键交互耗时

| 交互 | 无节流 | 4x 降速 |
|---|---|---|
| 启动页 → 营地（点击「继续游戏」到两帧绘制完成） | 28 ms | 43 ms |
| 营地 → 打开图鉴 | 32 ms | 48 ms |
| 图鉴搜索框输入（一次 input 到两帧绘制） | 31 ms | — |

## 4. 结论

1. **当前交互性能没有明显问题**：无长任务、CLS 接近 0，路由切换与图鉴打开均在 50 ms 内（4x 降速下）。
2. **首屏在弱网下约 1.0–1.1 s**，主要成本是 128 kB gzip 的 JS 下载，而非 JS 执行（`DOMInteractive` 仅 566 ms）。
3. **主要风险在包体积而非运行时**：
   - 单 chunk 532 kB，且 `data.ts`（40 只幻兽 / 294 个技能 / 22 个道具 / 7 个地点）被所有页面静态引用，无法按路由拆分。
   - 幻兽扩到 200 只后，`data.ts` 会成为首屏硬成本；图鉴一次性渲染全部条目也会开始出现渲染压力。
4. 抓到的小问题：图鉴首屏只有 245 个 DOM 节点，说明当前只渲染了已发现条目 + 少量占位；扩到 200 只后**需要虚拟列表或分页**，否则节点数会线性膨胀。

## 5. 复测方法

仓库内保留了两个可直接运行的采集脚本（需要沙盒内 Chrome 的 CDP 端口 `9222`）：

```bash
node scripts/perf-web.mjs      # 冷启动 x3 + 进入营地/图鉴/搜索
node scripts/perf-mobile.mjs   # CPU 4x + Fast3G 下的冷启动与交互
```

采集口径：

- `Network.setCacheDisabled(true)` 保证冷启动
- `Emulation.setDeviceMetricsOverride` 模拟 390×844 DPR3 移动视口
- `Emulation.setCPUThrottlingRate(4)` + `Network.emulateNetworkConditions` 模拟中低端设备
- 指标取 `performance.getEntriesByType('navigation')`、`first-contentful-paint`、`largest-contentful-paint`、`layout-shift`、`longtask`

## 6. 真机补测（2026-11-11 已完成，雷电模拟器 14 / Android 14）

**环境**：`emulator-5558`，机型 `25060RK16C`，Android 14 / SDK 34，1260×2800 / 560dpi，x86_64，无 root。
APK 为本机重建的 debug 包（JDK 21 + SDK 36 + Gradle 8.14.3），WebView 通过
`http://192.168.111.47:3001` 直连宿主机后端（首屏显示「服务器在线」）。

- [x] APK 冷启动到首帧（`am start -W` + `uiautomator dump` 首帧文案校验）
- [x] WebView 内实际 FPS 与掉帧分布（`dumpsys gfxinfo` framestats）
- [x] JS 堆峰值 / WebView OOM（`dumpsys meminfo` + logcat）
- [x] 后台切回后的恢复耗时（HOME → `am start -W`）

## 7. 真机补测结果（12/12 全绿）

原始数据在 `.trae/documents/性能基线_adb_真机数据_2026-11-11.json`，
采集脚本 `node scripts/perf-adb.mjs`（全程命令行、零 `input tap`，遵守
`.trae/documents/雷电模拟器_adb操作规范_2026-11-11.md`）。

| 项 | 结果 | 口径 |
|---|---|---|
| 冷启动到首帧 | **1177 / 1145 / 1130 ms**（均值 1151） | `am start -W` 的 `TotalTime`；三次均 `focusOk=true`，控件树含「兽域手记 / 登录 / 服务器在线」 |
| WebView 帧分布 | 冷启动渲染窗口 **35 帧**，Janky **3 (8.57%)** | p50 5ms / p90 125ms / p95 450ms / p99 450ms；Missed Vsync 3、Slow UI 2 |
| 静置对照 | **0 帧** | 静态登录页静置 4s 无持续重绘；FPS 采样必须覆盖冷启动窗口，否则拿到空数据 |
| 内存 / OOM | PSS **123611 KB（≈121 MB）** | Views 10 / Activities 1 / WebViews 1；logcat 无 `FATAL` / `OutOfMemoryError` / `SIGABRT` / ANR；consoleErrors 0 |
| 后台恢复 | **48 ms**（WaitTime 50） | HOME 后 `focusOk=false`，恢复后 `true`；雷电 `am start -W` 不输出 `ThisTime`，以 `TotalTime` 为准 |

**结论**：

1. 真机冷启动 ~1.15 s，与 Web 基线「4x 降速 + Fast 3G 下 FCP 1.0–1.1 s」基本吻合；主要成本仍是 764 kB（gzip 166 kB）单 chunk 的 JS 加载解析，不是原生壳开销。
2. 掉帧集中在冷启动长帧（p95/p99 450ms），对应 WebView 首屏解析与布局；稳态静态页无重绘、无持续掉帧，与 Web 侧「无长任务 / CLS≈0」一致。
3. 内存 ~121 MB 属 Capacitor WebView 常规量级，未触发 OOM。**本次是 x86_64 模拟器、非 4GB 低端真机**：「低端机 JS 堆峰值」只完成了 OOM 信号观测这一半，真实低端 ARM 机仍需 P5-3 阶段补测。
4. 后台恢复 48 ms，Activity 未重建（`Activity not started, its current task has been brought to the front`），符合预期。

> 注：§0 写的「本沙盒没有 adb / Android SDK」是 2026-10-20 采集时的历史环境说明；
> 2026-11-11 已在本机重建完整构建链并完成补测，详见 §6 / §7 与 `雷电模拟器_adb操作规范_2026-11-11.md`。
