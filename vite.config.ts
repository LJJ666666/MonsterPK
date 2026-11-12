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
  build: {
    sourcemap: 'hidden',
    rollupOptions: {
      output: {
        // 只拆「稳定、几乎不随业务改动」的 React 生态：升级游戏逻辑时这一块的内容哈希
        // 不变，浏览器/WebView 可复用缓存。它**不减少总下载量**，收益只在缓存命中率；
        // 因此不再为 zustand/zod 这类几 kB 的小依赖单独成块 —— 多一个请求的开销
        // 比它本身还大，且会把主包切得更碎。返回 undefined 走 Vite 默认合并策略。
        manualChunks(id) {
          if (!id.includes('node_modules')) return;
          if (/[\\/]node_modules[\\/](react|react-dom|scheduler|react-router|react-router-dom|@remix-run)[\\/]/.test(id)) {
            return 'vendor-react';
          }
        },
      },
    },
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
