/// <reference types="vitest/config" />
import { defineConfig, Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import tsconfigPaths from "vite-tsconfig-paths";
import fs from 'fs';
import path from 'path';

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
    tsconfigPaths(),
    localSavePlugin()
  ],
})
