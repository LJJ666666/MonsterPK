/**
 * 无头浏览器解析（冒烟脚本共用）。
 *
 * 为什么需要：16 套 375px 冒烟原来都写 `EDGE_PATH || C:\Program Files (x86)\...\msedge.exe`。
 * 默认值在真实桌面能跑，但在受限沙箱里 msedge 会被安全策略干掉 —— 同一台机器、同一个仓库，
 * 换个会话就 16 个阶段一起假红，且报错只有「seed 注入登录态 FAIL」，看不出是浏览器没起来。
 *
 * 解析顺序（env 覆盖 → 常见位置探测 → 明确报错）：
 *   1. `EDGE_PATH`（显式指定，指向不存在的文件直接报错，不静默回退）；
 *   2. puppeteer 缓存里的 `chrome-headless-shell`（沙箱内实测可跑，优先于 msedge）；
 *   3. 系统安装的 Edge / Chrome 常见路径；
 *   4. 全都没有 → 抛带修复指引的错误。
 */
import fs from 'node:fs';
import path from 'node:path';

const CACHE = process.env.USERPROFILE || process.env.HOME || '';

/** 展开 `<puppeteer 缓存>/chrome-headless-shell/<ver>/chrome-headless-shell-win64/*.exe`。 */
function probePuppeteer() {
  const roots = [
    path.join(CACHE, '.cache', 'puppeteer', 'chrome-headless-shell'),
    path.join(process.env.LOCALAPPDATA || '', 'puppeteer', 'chrome-headless-shell'),
  ].filter((p) => p && fs.existsSync(p));

  const found = [];
  for (const root of roots) {
    let versions = [];
    try {
      versions = fs.readdirSync(root).sort().reverse();
    } catch {
      continue;
    }
    for (const ver of versions) {
      const dir = path.join(root, ver);
      let subs = [];
      try {
        subs = fs.readdirSync(dir);
      } catch {
        continue;
      }
      for (const sub of subs) {
        const exe = path.join(dir, sub, process.platform === 'win32' ? 'chrome-headless-shell.exe' : 'chrome-headless-shell');
        if (fs.existsSync(exe)) found.push(exe);
      }
    }
  }
  return found;
}

const SYSTEM_CANDIDATES = [
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  '/usr/bin/chromium',
  '/usr/bin/chromium-browser',
  '/usr/bin/google-chrome',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
];

export function resolveBrowser() {
  const env = process.env.EDGE_PATH;
  if (env) {
    if (fs.existsSync(env)) return env;
    throw new Error(`EDGE_PATH 指向的文件不存在：${env}（修：删掉该变量让它自动探测，或改成真实路径）`);
  }

  const puppeteer = probePuppeteer();
  if (puppeteer.length > 0) return puppeteer[0];

  for (const c of SYSTEM_CANDIDATES) {
    if (fs.existsSync(c)) return c;
  }

  throw new Error(
    'no headless browser found. 修法二选一：\n'
    + '  1) 设 EDGE_PATH 指向 Edge/Chrome/chrome-headless-shell 的可执行文件；\n'
    + '  2) 让 puppeteer 把 chrome-headless-shell 装到 ~/.cache/puppeteer（npm run smoke 前跑一次即可）。',
  );
}

/** 便于冒烟脚本在失败时打印一行诊断。 */
export function describeBrowser(exe) {
  return `${exe} (${process.platform})`;
}
