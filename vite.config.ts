/// <reference types="vitest/config" />
import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

/**
 * 开发 / 预览服务器：把 public/_*.html 原样返回（14 个 375px UI 冒烟的 seed / probe 页）。
 *
 * 背景（2026-11-15 实证）：Vite 6.4.2 会把任意 *.html 请求当作 SPA 入口交给
 * transformIndexHtml，public/ 下的 _*.html 在 root 下并不存在，于是回退成 index.html
 * （带 /@react-refresh 注入）。冒烟拿到的是首页而不是 seed 页，14 套全红且共享
 * 同一根因「seed 注入登录态」。txt / 字体等 public 静态资源不受影响，故只需放行 HTML。
 *
 * 这里注册在 configureServer / configurePreviewServer，执行顺序早于 Vite 内部中间件，
 * 命中即原样返回、不命中一律 next()；不参与 build，生产产物零影响。
 * 同时移除本地存档时代对 /api/save 的文件读写：存档唯一真值是后端 3001 的 PostgreSQL，
 * 前端 api.ts 与全部冒烟都带 API_BASE 直连后端，不存在相对路径命中该中间件的合法调用。
 */
function devProbeMiddleware(req: any, res: any, next: any) {
  const pathname = String(req.url || '').split('?')[0];
  const m = /^\/(_[\w-]+\.html)$/.exec(pathname);
  if (!m) return next();
  const publicDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'public');
  const file = path.resolve(publicDir, m[1]);
  if (!fs.existsSync(file)) return next();
  res.statusCode = 200;
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.setHeader('Cache-Control', 'no-store');
  res.end(fs.readFileSync(file, 'utf8'));
}

function devProbePlugin(): Plugin {
  return {
    name: 'dev-probe-plugin',
    configureServer(server) {
      server.middlewares.use(devProbeMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(devProbeMiddleware);
    }
  };
}

// https://vite.dev/config/
export default defineConfig({
  // 端口统一由 MPK_FRONT_PORT 控制，默认 5173（跨机器/CI 零变更）。
  // 本机 5173 被其它程序占用时，改这个 env 即可，scripts/lib/devConfig.mjs 会让
  // 所有冒烟脚本与 verify 探活同步跟着走；strictPort 保证冲突直接报错而非偷偷换端口。
  server: {
    port: Number(process.env.MPK_FRONT_PORT ?? 5173),
    strictPort: true,
    // 绑定 IPv4 全网卡：verify 的 FRONT_PROBE 与全部 UI 冒烟都走 127.0.0.1，
    // Vite 默认只监听 localhost(::1) 时 IPv4 探活返回 000 → 整套 smoke 假红；
    // Android 调试包访问宿主局域网 IP 也一样依赖 0.0.0.0。
    host: '0.0.0.0',
    watch: {
      // 冒烟脚本必须把 seed/probe 页放进 public/ 才能与 App 同源（读 iframe 的 document），
      // 但 public/ 内任何文件变更都会让 Vite 发 `full-reload`：页面在 dump-dom 采样窗口
      // 里被强制刷新 → React 挂不上 → 整批冒烟报「白屏」（<div id="root"></div> 空）。
      // 2026-11-13 实证：dev server 日志出现 29 次 `page reload public/_*_seed.html`。
      // 这些文件只被一次性读取、不参与 HMR，忽略其变更即可。
      ignored: ['**/public/_*.html'],
    },
  },
  // 别名唯一真值源（2026-11-12 偶发红修复）。
  // 原先靠 vite-tsconfig-paths 读 tsconfig.paths：该插件用「项目根目录字符串」做
  // resolversByDir 查表，Windows 下 tsconfck 给出的键是小写盘符 `e:/Six/MonsterPK`，
  // 而 Vite 传入的 importer 是大写 `E:/Six/MonsterPK/...`，查表全 miss 后所有 `@/`
  // 解析失效 —— npm run build 报「Rollup failed to resolve import」、vitest 里
  // vi.mock('@/lib/api') 注册不到同一模块 ID 导致 20 例齐红。是否命中取决于当次
  // 进程 cwd / 入口路径的盘符写法，故表现为跨轮偶发。改用 Vite 原生 alias 后与
  // 大小写、插件版本、cwd 完全无关。与 tsconfig.json 的 `@/* -> ./src/*` 保持同义。
  resolve: {
    // 用正则只吃 `@/` 前缀：字符串 find:'@' 会把 `@remix-run/...` 这类作用域包
    // 也误改写到 src/ 下。replacement 统一成正斜杠，避免 Windows 反斜杠再踩坑。
    alias: [
      {
        find: /^@\//,
        replacement: fileURLToPath(new URL('./src/', import.meta.url)).replace(/\\/g, '/'),
      },
    ],
  },
  // 前端测试边界：后端 backend/ 使用独立的 node:test（见 backend/package.json 的 npm test），
  // 两套测试框架不能混跑，否则 vitest 会把 node:test 文件当成空套件报错。
  test: {
    include: ['src/**/*.test.{ts,tsx}'],
    exclude: ['node_modules/**', 'dist/**', 'backend/**'],
  },
  // 不做人工分包（2026-11-12 复核定稿，取代 A1 的 manualChunks/vendor-react）。
  // 本项目是 Capacitor 本地包：dist 整体打进 APK 的 assets/public，WebView 从本地
  // 加载，不存在跨版本 HTTP 缓存复用；人工分包的唯一真实收益（React 生态单独成
  // chunk 后长期命中缓存）在这里为零，代价反而是多一个 modulepreload 请求、多一层
  // chunk 边界与配置维护成本。实测：去掉后首屏 JS 请求 2→1、产物文件 7→5；
  // JS 总字节 770,245→770,965 B（基本持平，反而多 720 B）、gzip ≈170 kB 不变，
  // 所以取舍依据是「缓存收益为零 + 少一次本地请求 + 零配置」，不是体积变小。
  // 回到 Vite 默认合并策略。src/stores/useGameStore.ts 的 import("@/lib/intents")
  // 是打破循环依赖的动态导入，属源码结构、不属构建期分包，保留。
  build: {
    sourcemap: 'hidden',
  },
  plugins: [
    react({
      babel: {
        plugins: [
          'react-dev-locator',
        ],
      },
    }),
    devProbePlugin()
  ],
})
