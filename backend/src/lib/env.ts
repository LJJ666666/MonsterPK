import { readFileSync, existsSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, resolve } from 'path';

// 极简 .env 加载器：避免引入额外依赖。
// 在 src/index.ts 顶部最先 import 本模块，确保其他模块读取 process.env 前已就绪。
function loadEnv() {
  const here = dirname(fileURLToPath(import.meta.url));
  // src/lib/ → backend/ 需回退两级；此前写成 '../.env' 会指向 backend/src/.env，
  // 导致 .env 从未被加载（JWT_SECRET 一直用代码里的默认值，属安全缺陷，见 bug_log §14）。
  const envPath = resolve(here, '../../.env');
  if (!existsSync(envPath)) return;
  const raw = readFileSync(envPath, 'utf-8');
  for (const line of raw.split('\n')) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m) continue;
    const key = m[1];
    let val = m[2];
    if (
      (val.startsWith('"') && val.endsWith('"')) ||
      (val.startsWith("'") && val.endsWith("'"))
    ) {
      val = val.slice(1, -1);
    }
    if (process.env[key] === undefined) process.env[key] = val;
  }
}

loadEnv();
