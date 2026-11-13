/// <reference types="vitest/config" />
import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';

function localSaveMiddleware(req: any, res: any, next: any) {
  if (req.url === '/api/save' && req.method === 'GET') {
    const savePath = path.resolve(process.cwd(), 'save_data.json');
    if (fs.existsSync(savePath)) {
      res.setHeader('Content-Type', 'application/json');
      res.end(fs.readFileSync(savePath, 'utf-8'));
    } else {
      res.statusCode = 404;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  } else if (req.url === '/api/save' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: any) => {
      body += chunk.toString();
    });
    req.on('end', () => {
      try {
        const data = JSON.parse(body);
        const savePath = path.resolve(process.cwd(), 'save_data.json');
        fs.writeFileSync(savePath, data.value, 'utf-8');
        res.setHeader('Content-Type', 'application/json');
        res.statusCode = 200;
        res.end(JSON.stringify({ ok: true }));
      } catch (e) {
        res.statusCode = 500;
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ error: 'Internal Server Error' }));
      }
    });
  } else {
    next();
  }
}

function localSavePlugin(): Plugin {
  return {
    name: 'local-save-plugin',
    configureServer(server) {
      server.middlewares.use(localSaveMiddleware);
    },
    // 生产预览（vite preview）同样挂载存档接口，避免被 SPA 回退成 index.html
    configurePreviewServer(server) {
      server.middlewares.use(localSaveMiddleware);
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
    localSavePlugin()
  ],
})
