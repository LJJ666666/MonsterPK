/**
 * P4-2e 共斗 Boss / 副本 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_p42e.mjs
 *
 * 目标：证明「营地 → 共斗弹窗 → 选 Boss + 创建/加入表单 + 免责声明 → 创建房间进入等待态并显示房间号」
 * 这条链路在真浏览器里跑得通，且 375px 窄屏无横向溢出。
 * 双人真实共斗 / 并发意图 / Boss HP 只减一次 / 结算幂等由 `e2e:p42e` 覆盖，这里只管可视层与接线。
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
const SEED = path.join(PUBLIC, '_p42e_seed.html');
const PROBE = path.join(PUBLIC, '_p42e_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p42e_${RUN}`);

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
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function once(label, fn) {
  return function () { if (completed[label]) return; completed[label] = true; fn(); };
}
function keepAlive() {
  // --virtual-time-budget 会把 50ms 定时器瞬间快进，真实网络（存档 GET、WS 握手）
  // 反而没有落地机会。挂一个真实请求，触发 Chromium 的 pauseIfNetworkFetchesPending。
  try { fetch('http://localhost:3001/api/health?t=' + Date.now(), { cache: 'no-store' }).catch(function () {}); } catch (e) {}
}
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 240) { out.errors.push('timeout:' + label); return finish(); }
  if (tries % 4 === 0) keepAlive();
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
function overflow() {
  var d = doc();
  return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1;
}
f.addEventListener('load', function () {
  out.loaded = true;
  out.initialTxt = txt().slice(0, 260);
  finish();
  // 1) 等营地渲染出「共斗」入口
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0
      && buttons().some(function (b) { return b.textContent.trim() === '共斗'; });
  }, once('camp-entry', function () {
    out.entry = true;
    var e = buttons().filter(function (b) { return b.textContent.trim() === '共斗'; })[0];
    if (!e) { out.errors.push('no-entry'); return finish(); }
    e.click();
    // 2) 等弹窗渲染出标题 + 创建/加入表单 + 共斗目标列表（列表来自服务端只读下发，
    //    必须等它渲染完再点创建，否则 bossId 还是空、create() 会报「请先选择共斗目标」）
    waitFor('modal', function () {
      var t = txt();
      return t.indexOf('共斗副本') >= 0 && t.indexOf('创建共斗房间') >= 0 && t.indexOf('Lv.') >= 0;
    }, once('modal', function () {
      var t = txt();
      out.step = 'modal';
      out.title = t.indexOf('共斗副本') >= 0;
      out.disclaimer = t.indexOf('服务端裁决') >= 0 && t.indexOf('全清即通关') >= 0;
      out.createBtn = t.indexOf('创建共斗房间') >= 0;
      out.joinBtn = buttons().some(function (b) { return b.textContent.trim() === '加入'; });
      // 共斗目标列表（服务端只读下发）渲染出来才算接线成功
      out.bossList = t.indexOf('选择共斗目标') >= 0 && t.indexOf('Lv.') >= 0;
      out.scrollWidth = overflow();
      var create = buttons().filter(function (b) { return b.textContent.trim().indexOf('创建共斗房间') >= 0; })[0];
      if (!create) { out.errors.push('no-create-btn'); return finish(); }
      create.click();
      // 3) 创建后进入等待态：显示房间号 + 等待队友
      waitFor('waiting', function () {
        var t2 = txt();
        return t2.indexOf('房间号') >= 0 && t2.indexOf('等待队友加入') >= 0;
      }, once('waiting', function () {
        var t3 = txt();
        out.step = 'done';
        out.roomShown = /房间号/.test(t3) && /[A-Za-z0-9]{4,}/.test(t3);
        out.waiting = t3.indexOf('等待队友加入') >= 0;
        out.scrollWidth2 = overflow();
        finish();
      }));
    }));
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
  const health = await apiJson('/api/health');
  check('后端 health 在线（含房间/战斗统计）',
    health.data?.sessions !== undefined && health.data?.battles !== undefined,
    JSON.stringify(health.data ?? null).slice(0, 120));

  const username = `ui_${RUN}`;
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
  const seedDom = runEdge(`${BASE}/_p42e_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_p42e_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地 → 共斗弹窗 → 创建房间等待态全部走完）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页存在「共斗」入口', p.entry === true, JSON.stringify(p.errors));
  check('弹窗标题为「共斗副本」', p.title === true, brief(p));
  check('免责文案含「服务端裁决」与「全清即通关」', p.disclaimer === true, brief(p));
  check('共斗目标列表已从服务端下发', p.bossList === true, brief(p));
  check('弹窗存在「创建共斗房间」按钮', p.createBtn === true, brief(p));
  check('弹窗存在「加入」按钮', p.joinBtn === true, brief(p));
  check('弹窗打开时 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('创建后进入等待态并显示房间号', p.roomShown === true, brief(p));
  check('等待态文案「等待队友加入」', p.waiting === true, brief(p));
  check('等待态 375px 无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);

  // 服务端对照：伪上报共斗字段被拦（Boss HP / 伤害只认服务端）。
  const forged = await apiJson('/api/coop/create', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bossHp: 1, damage: 99999, winner: 'A' }),
  });
  check('服务端拒绝客户端伪造共斗字段',
    forged.status === 400 && forged.data?.code === 'COOP_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 120)}`);

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_P42E_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_P42E_OK');
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
