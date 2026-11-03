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

## 6. 待补测（需要 adb 环境）

- [ ] APK 冷启动到首帧（`am start -W`）
- [ ] WebView 内实际 FPS 与掉帧分布（`dumpsys gfxinfo`）
- [ ] 低端机（如 4GB 内存）下的 JS 堆峰值与是否触发 WebView OOM
- [ ] 后台切回后的恢复耗时
