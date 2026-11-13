/**
 * F01/F02 周期榜与奖励 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f01f02.mjs
 *
 * 只验证可视层：三个视图切换、只读文案、空/有数据态与 375px 无横向溢出。
 * 结算与发奖的权威口径由 e2e:f01f02 覆盖，这里不重复造数据。
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
const SEED = path.join(PUBLIC, '_f01_seed.html');
const PROBE = path.join(PUBLIC, '_f01_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f01_${RUN}`);

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
  out.finalTxt = txt().slice(0, 700);
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
function click(label) {
  var b = buttons().filter(function (x) { return x.textContent.trim() === label; })[0];
  if (!b) { out.errors.push('no-button:' + label); return finish(); }
  b.click();
  return true;
}
function once(label, fn) {
  return function () { if (completed[label]) return; completed[label] = true; fn(); };
}
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 200) { out.errors.push('timeout:' + label); return finish(); }
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
  finish();
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0
      && buttons().some(function (b) { return b.textContent.trim() === '榜单'; });
  }, once('camp-entry', function () {
    out.entry = true;
    if (!click('榜单')) return;
    waitFor('board', function () {
      return txt().indexOf('兽域榜单') >= 0 && txt().indexOf('服务端派生') >= 0
        && txt().indexOf('正在读取') < 0;
    }, once('board', function () {
      out.step = 'board';
      out.boardTitle = txt().indexOf('兽域榜单') >= 0;
      out.readonly = txt().indexOf('客户端只读') >= 0;
      out.tabs = buttons().map(function (b) { return b.textContent.trim(); });
      out.scrollWidth = overflow();
      if (!click('周期榜')) return;
      waitFor('periods', function () {
        return txt().indexOf('已结算周期') >= 0 && txt().indexOf('服务端结算') >= 0;
      }, once('periods', function () {
        out.step = 'periods';
        out.periodText = txt().indexOf('日榜 UTC+8') >= 0;
        out.periodFooter = txt().indexOf('按周期结算') >= 0;
        out.scrollWidth2 = overflow();
        if (!click('我的奖励')) return;
        waitFor('rewards', function () {
          return txt().indexOf('服务端发放') >= 0 && txt().indexOf('无需领取') >= 0;
        }, once('rewards', function () {
          out.step = 'done';
          out.rewardText = txt().indexOf('奖励在周期结算时') >= 0;
          out.rewardFooter = txt().indexOf('只读') >= 0;
          out.scrollWidth3 = overflow();
          finish();
        }));
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
    '--virtual-time-budget=30000', '--dump-dom', url,
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
  check('后端 health 在线', health.data?.ok === true, JSON.stringify(health.data).slice(0, 140));

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
  const seedDom = runEdge(`${BASE}/_f01_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f01_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 320) });
  check('三个视图全部走通（本期 → 周期榜 → 我的奖励）', !!p && p.step === 'done',
    brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页存在「榜单」入口', p.entry === true, JSON.stringify(p.errors));
  check('弹窗标题与只读提示可见',
    p.boardTitle === true && p.readonly === true, brief(p));
  check('三个视图 Tab 与四榜 Tab 同时渲染',
    ['本期榜', '周期榜', '我的奖励', '单宠战力', '推图']
      .every((t) => Array.isArray(p.tabs) && p.tabs.includes(t)),
    JSON.stringify(p.tabs));
  check('周期榜显示 UTC+8 周期口径与服务端结算说明',
    p.periodText === true && p.periodFooter === true, brief(p));
  check('奖励视图显示「无需领取」与只读口径',
    p.rewardText === true && p.rewardFooter === true, brief(p));
  check('本期榜 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('周期榜 375px 无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);
  check('奖励视图 375px 无横向溢出',
    Number.isFinite(p.scrollWidth3) && p.scrollWidth3 <= 375, `scrollWidth=${p.scrollWidth3}`);
  if (Array.isArray(p.errors) && p.errors.length) {
    console.log(`[INFO] 探针内部提示：${p.errors.join(', ')}`);
  }

  const periods = await apiJson('/api/rank/periods', { headers: auth });
  check('服务端周期清单只读且带七张榜',
    periods.status === 200 && periods.data?.readonly === true
    && periods.data?.boards?.length === 7,
    `${periods.status} ${JSON.stringify(periods.data).slice(0, 140)}`);
  const rewards = await apiJson('/api/rank/rewards', { headers: auth });
  check('服务端奖励记录只读',
    rewards.status === 200 && rewards.data?.readonly === true && Array.isArray(rewards.data?.entries));
  const noClaim = await apiJson('/api/rank/rewards/claim', {
    method: 'POST', headers: auth, body: JSON.stringify({}),
  });
  check('服务端无「领取奖励」写接口 → 404', noClaim.status === 404, `status=${noClaim.status}`);
  const forged = await apiJson('/api/rank/rewards?claim=1', { headers: auth });
  check('服务端拒绝客户端上报领取',
    forged.status === 400 && forged.data?.code === 'RANK_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 120)}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F01F02_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F01F02_OK');
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
