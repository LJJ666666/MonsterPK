/// <reference types="vitest/config" />
import { defineConfig } from 'vite';
import path from 'path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));   // demo-app/
const appRoot = path.resolve(here, '..');

/** demo-app 独立单测：include 只认本目录，主工程 npm test 不会扫到。 */
export default defineConfig({
  root: here,
  resolve: {
    alias: [{ find: /^@\//, replacement: path.join(appRoot, 'src').replace(/\\/g, '/') + '/' }],
  },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
