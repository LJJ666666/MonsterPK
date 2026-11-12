/**
 * P4-1b 共享野怪 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_p41.mjs
 *
 * 目标：证明「附近野怪」这段新 UI 在真浏览器里真的渲染出来，且 375px 窄屏
 * 不出现横向滚动。E2E 只能证明接口一致，证明不了 DOM 没撑破屏幕。
 * 刻意不点「挑战」：共享野怪的抢占互斥由 e2e:p41 覆盖，这里只管可视层。
 */
import { execFileSync as rawExecFileSync } from 'node:child_process';
import { createRetriedExec } from './lib/edgeDom.mjs';

// headless Edge --dump-dom 偶发返回 Chromium 错误页时有限重试（断言不变，见 lib/edgeDom.mjs）。
const execFileSync = createRetriedExec(rawExecFileSync);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.EDGE_PATH || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
import { FRONT_BASE as BASE } from './lib/devConfig.mjs';
const API = 'http://localhost:3001';
const RUN = Date.now().toString(36).slice(-6);
const SEED = path.join(PUBLIC, '_p41_seed.html');
const PROBE = path.join(PUBLIC, '_p41_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p41_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

const STATS = { hp: 60, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const monster = {
  id: 'm1', specId: 'sprout_owl', level: 5, exp: 0, element: 'grass',
  maxHp: 120, hp: 120, atk: 40, def: 60, spAtk: 40, spDef: 60, spd: 70,
  status: 'none', moveIds: ['tackle'], initStats: STATS, growthRates: GROWTH,
};
const save = {
  version: '10', playerName: '旅行者', money: 1200, steps: 340,
  locationId: 'town_starter', lastHealLocationId: 'town_starter',
  visitedLocationIds: ['town_starter'], party: [monster], box: [],
  inventory: { capsule_basic: 6, potion_small: 3 },
  collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
  clearedAreas: {}, lastSavedAt: new Date(Date.now() - 60_000).toISOString(),
};

function probeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/arena" style="width:375px;height:812px;border:0"></iframe>
<script>
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
function finish() {
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function waitFor(label, cond, next, tries) {
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 400) { out.errors.push('timeout:' + label); return finish(); }
  var d = doc();
  if (d) {
    var ob = new MutationObserver(function () {
      if (cond()) { ob.disconnect(); next(); }
    });
    try { ob.observe(d.body, { subtree: true, childList: true, characterData: true }); } catch (e) {}
    setTimeout(function () { ob.disconnect(); waitFor(label, cond, next, tries + 1); }, 50);
  } else {
    setTimeout(function () { waitFor(label, cond, next, tries + 1); }, 50);
  }
}
f.addEventListener('load', function () {
  waitFor('wild-list', function () { return txt().indexOf('附近野怪') >= 0 && txt().indexOf('Lv.') >= 0; }, function () {
    var t = txt();
    var d = doc();
    out.step = 'done';
    out.wildTitle = t.indexOf('附近野怪（多人共享）') >= 0;
    out.lvMatches = t.match(/Lv\\.\\d+/g) || [];
    out.challengeButtons = buttons().filter(function (b) { return b.textContent.indexOf('挑战') >= 0; }).length;
    out.availableButtons = buttons().filter(function (b) {
      return b.textContent.indexOf('挑战') >= 0 && !b.disabled;
    }).length;
    out.scrollWidth = d ? d.documentElement.scrollWidth : -1;
    out.bodyScrollWidth = d ? d.body.scrollWidth : -1;
    out.hint = t.indexOf('所有玩家看到同一批野怪') >= 0;
    finish();
  });
});
</script></body></html>`;
}

function runEdge(url) {
  return execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--window-size=375,812',
    '--virtual-time-budget=20000', '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 120_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseProbe(dom) {
  const m = dom.match(/data-probe="([^"]+)"/);
  if (!m || m[1] === 'PENDING') return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

async function apiJson(p, init = {}) {
  const res = await fetch(API + p, init);
  const text = await res.text();
  try { return { status: res.status, data: JSON.parse(text) }; } catch { return { status: res.status, data: text }; }
}

async function main() {
  const health = await apiJson('/api/health');
  check('后端 health 带 wild 统计', typeof health.data?.wild?.active === 'number',
    JSON.stringify(health.data?.wild ?? null));

  const username = `ui4_${RUN}`;
  const reg = await apiJson('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'ui4-pass-123' }),
  });
  const token = reg.data?.token;
  check('注册测试账号', !!token, JSON.stringify(reg.data).slice(0, 160));
  if (!token) return report();

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const put = await apiJson('/api/save', {
    method: 'PUT', headers: auth, body: JSON.stringify({ data: JSON.stringify(save), revision: 0 }),
  });
  check('建立云端基线存档', put.status === 200, `${put.status}`);

  const persist = JSON.stringify({ state: { save }, version: 11 });
  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    localStorage.setItem('beast-journal-save',${JSON.stringify(persist)});
    </script></body></html>`, 'utf8');
  const seedDom = runEdge(`${BASE}/_p41_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_p41_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  check('探针回传（页面未白屏且野怪列表已渲染）', !!p, dom.slice(0, 200));
  if (!p) return report();

  check('训练场显示「附近野怪（多人共享）」', p.wildTitle === true, JSON.stringify(p));
  check('列表渲染出 3 只共享野怪（Lv. 行）',
    Array.isArray(p.lvMatches) && p.lvMatches.length >= 3, JSON.stringify(p.lvMatches));
  check('每只野怪都有「挑战」按钮', (p.challengeButtons ?? 0) >= 3, String(p.challengeButtons));
  check('至少一只可挑战（服务端有 available 实例）', (p.availableButtons ?? 0) >= 1, String(p.availableButtons));
  check('多人共享提示文案存在', p.hint === true, JSON.stringify(p));
  check('375px 无横向溢出', Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375,
    `scrollWidth=${p.scrollWidth} body=${p.bodyScrollWidth}`);
  if (Array.isArray(p.errors) && p.errors.length) {
    console.log(`[INFO] 探针内部提示：${p.errors.join(', ')}`);
  }

  // 服务端侧对照：UI 看到的等级区间必须来自内容表（wild_starter 1-5）
  const wild = await apiJson('/api/wild?areaId=wild_starter&theme=grass&levelMin=1&levelMax=5', { headers: auth });
  check('服务端共享野怪列表可读且为真实区域', wild.status === 200 && wild.data?.areaName === '微风林道',
    JSON.stringify({ status: wild.status, areaName: wild.data?.areaName }));
  check('服务端等级区间来自内容表（1-5）',
    wild.data?.levelMin === 1 && wild.data?.levelMax === 5,
    JSON.stringify({ min: wild.data?.levelMin, max: wild.data?.levelMax }));
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_P41_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_P41_OK');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
}).finally(() => {
  for (const f of [SEED, PROBE]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
