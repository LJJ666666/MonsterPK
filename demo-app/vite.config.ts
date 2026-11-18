/// <reference types="vitest/config" />
/**
 * demo-app 独立构建配置 —— L1/L2 演示包专用，不参与主工程任何构建/测试。
 *
 * 设计（2026-11-17 定案）：
 *  - 本目录是「主工程 + mock 覆盖层」的构建变体，不是另起炉灶的独立游戏。
 *    业务源码仍用主工程 src/，只是在 resolve 阶段把 `@/lib/api`、`@/lib/ws`
 *    重定向到本目录的 mock 替身，实现「假登录 + 固定存档、不连后端」。
 *  - 主工程 vite.config.ts / src/ 零改动；默认 npm run build / verify / 冒烟
 *    完全不读本文件，产物零 mock 痕迹。
 *  - 所有 demo 资产（配置、mock、fixtures、出包脚本、产物）都在 demo-app/ 下，
 *    可整体提交 git；APK 产物走 .gitignore 不入库。
 *
 * 用法：见 demo-app/README.md（或 `npm run demo:apk`）。
 */
import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url)); // demo-app/
const appRoot = path.resolve(here, '..');                   // 主工程根
const toPosix = (p: string) => p.replace(/\\/g, '/');

/**
 * resolveId 重定向：只拦主工程业务源码对 api/ws 的导入，指向本目录 mock。
 * 防自引用：importer 不在主工程 src/ 下（如 mock 自身、node_modules）一律放行。
 */
function demoMockPlugin(): Plugin {
  const srcDir = toPosix(path.join(appRoot, 'src')) + '/';
  const apiMock = toPosix(path.join(here, 'src/api.mock.ts'));
  const wsMock = toPosix(path.join(here, 'src/ws.mock.ts'));
  return {
    name: 'mpk-demo-mock-redirect',
    enforce: 'pre',
    resolveId(source, importer) {
      // Vite alias 会把 '@/lib/api' 先解析成绝对路径再传给本插件（enforce pre 也拦不住），
      // 所以三种形式都要认：原始别名、相对路径、已解析的绝对路径（Windows 盘符大小写不敏感）。
      const normSrc = toPosix(source).toLowerCase();
      const absApi = normSrc.endsWith('/src/lib/api') || normSrc.endsWith('/src/lib/api.ts');
      const absWs = normSrc.endsWith('/src/lib/ws') || normSrc.endsWith('/src/lib/ws.ts');
      const isApi = source === '@/lib/api' || source === './api' || source === '../lib/api' || absApi;
      const isWs = source === '@/lib/ws' || source === './ws' || source === '../lib/ws' || absWs;
      if (!isApi && !isWs) return null;
      if (!importer || importer.includes('/node_modules/')) return null;
      // 盘符大小写不敏感（项目已知坑：tsconfck 给小写 e:/，Vite 传大写 E:/）。
      const norm = toPosix(importer).toLowerCase();
      const prefix = srcDir.toLowerCase();
      if (!norm.startsWith(prefix)) return null;
      return isApi ? apiMock : wsMock;
    },
  };
}

export default defineConfig({
  // 复用主工程入口 index.html 与 src/main.tsx，避免维护第二份业务入口。
  root: appRoot,
  resolve: {
    alias: [{ find: /^@\//, replacement: toPosix(path.join(appRoot, 'src')) + '/' }],
  },
  build: {
    // 产物独立输出到 demo-app/dist，绝不覆盖主工程 dist。
    outDir: toPosix(path.join(here, 'dist')),
    emptyOutDir: true,
    sourcemap: 'hidden',
  },
  plugins: [
    react({ babel: { plugins: ['react-dev-locator'] } }),
    demoMockPlugin(),
  ],
});
