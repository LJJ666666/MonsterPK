/**
 * F18-a 地图地区锁定 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f18a.mjs
 *
 * 目标：证明「营地默认进入地图 Tab → 未解锁地区显示正确的前置徽章提示」这条链路
 * 在真浏览器里渲染正确，且 375px 窄屏无横向溢出。
 *
 * 重点回归：此前 Camp.tsx 地区锁提示会把「本城自己的徽章」当解锁门槛（循环依赖），
 * 修复后应展示「上一相邻城镇的徽章名」（与后端 mapLock.requiredBadgeFor 同口径），
 * 即 city_pebble 一行应显示「需获得「青苗徽章」解锁」。
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
const SEED = path.join(PUBLIC, '_f18a_seed.html');
const PROBE = path.join(PUBLIC, '_f18a_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f18a_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

const STATS = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
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
  collection: {}, clearedAreas: {}, lastSavedAt: new Date(Date.now() - 60_000).toISOString(),
};

function probeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/camp" style="width:375px;height:812px;border:0"></iframe>
<script>
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
var completed = {};
window.onerror = function (msg) { out.errors.push('error:' + msg); finish(); };
function finish() {
  out.finalTxt = txt().slice(0, 800);
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function overflow() {
  var d = doc();
  return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1;
}
function once(label, fn) {
  return function () { if (completed[label]) return; completed[label] = true; fn(); };
}
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 240) { out.errors.push('timeout:' + label); return finish(); }
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
  out.loaded = true;
  out.initialTxt = txt().slice(0, 260);
  finish();
  // 营地默认 Tab 即「地图」：地区列表直接渲染出锁定行
  waitFor('map', function () {
    return txt().indexOf('兽域手记') >= 0 && txt().indexOf('未解锁') >= 0;
  }, once('map', function () {
    var t = txt();
    out.step = 'map';
    out.campLoaded = t.indexOf('兽域手记') >= 0;
    out.unlockShown = t.indexOf('未解锁') >= 0;
    // 修复点：city_pebble 一行应显示「需获得「青苗徽章」解锁」（前置城镇徽章，而非本城徽章）
    out.reqBadgeText = t.indexOf('需获得「青苗徽章」解锁') >= 0;
    // 首城 town_starter 已解锁，应显示「进入」而非锁定
    out.firstCityUnlocked = t.indexOf('进入') >= 0;
    out.scrollWidth = overflow();
    finish();
  }));
});
</script></body></html>`;
}

function runEdge(url) {
  return execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--window-size=375,812',
    '--virtual-time-budget=40000', '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 150_000, stdio: ['ignore', 'pipe', 'ignore'] });
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
  const username = `f18a_${RUN}`;
  const reg = await apiJson('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'ui-pass-123' }),
  });
  const token = reg.data?.token;
  check('注册测试账号', !!token, JSON.stringify(reg.data).slice(0, 160));
  if (!token) return report();

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  const put = await apiJson('/api/save', {
    method: 'PUT', headers: auth, body: JSON.stringify({ data: JSON.stringify(save), revision: 0 }),
  });
  check('建立云端基线存档', put.status === 200, `${put.status}`);

  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    </script></body></html>`, 'utf8');
  const seedDom = runEdge(`${BASE}/_f18a_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f18a_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地地图 Tab 渲染完成）', !!p && p.step === 'map', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页面加载完成', p.campLoaded === true, brief(p));
  check('未解锁地区显示「未解锁」', p.unlockShown === true, brief(p));
  check('锁定提示显示前置徽章「青苗徽章」（修复循环依赖）',
    p.reqBadgeText === true, brief(p));
  check('首城（初心镇）已解锁显示「进入」', p.firstCityUnlocked === true, brief(p));
  check('375px 窄屏无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F18A_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F18A_OK');
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
