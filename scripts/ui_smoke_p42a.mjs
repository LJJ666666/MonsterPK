/**
 * P4-2a 只读派生榜 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_p42a.mjs
 *
 * 目标：证明榜单入口、弹窗、四榜切换、免责文案与只读提示在真浏览器里渲染出来，
 * 且 375px 窄屏不出现横向滚动。接口权威由 e2e:p42a 覆盖，这里只管可视层。
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
const SEED = path.join(PUBLIC, '_p42a_seed.html');
const PROBE = path.join(PUBLIC, '_p42a_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p42a_${RUN}`);

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
  out.finalTxt = txt().slice(0, 600);
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
  out.initialTxt = txt().slice(0, 260);
  out.initialButtons = buttons().map(function (b) { return b.textContent.trim(); }).slice(0, 20);
  finish(); // 先落一次初始快照，后续流程会覆盖；卡住时至少能诊断页面状态
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0
      && buttons().some(function (b) { return b.textContent.trim() === '榜单'; });
  }, once('camp-entry', function () {
    out.entry = true;
    var entry = buttons().filter(function (b) { return b.textContent.trim() === '榜单'; })[0];
    if (!entry) { out.errors.push('no-entry'); return finish(); }
    entry.click();
    waitFor('board', function () {
      // 必须等榜单数据真正渲染完（有行、且不在 loading），否则点击 Tab 会与首屏请求竞态。
      return txt().indexOf('兽域榜单') >= 0 && txt().indexOf('服务端派生') >= 0
        && txt().indexOf('正在读取') < 0 && txt().indexOf('暂无上榜记录') < 0;
    }, once('board', function () {
      var t = txt();
      out.step = 'board';
      out.boardTitle = t.indexOf('兽域榜单') >= 0;
      out.disclaimer = t.indexOf('不代表实战强弱') >= 0;
      out.readonly = t.indexOf('只读') >= 0;
      out.serverDerived = t.indexOf('服务端派生') >= 0;
      out.tabs = buttons().map(function (b) { return b.textContent.trim(); });
      out.hasRows = txt().indexOf('暂无上榜记录') < 0 && txt().indexOf('正在读取') < 0;
      out.scrollWidth = overflow();
      var tab = buttons().filter(function (b) { return b.textContent.trim() === '推图'; })[0];
      if (!tab) { out.errors.push('no-progress-tab'); return finish(); }
      tab.click();
      waitFor('progress-tab', function () {
        return txt().indexOf('已首通区域数量') >= 0;
      }, once('progress-tab', function () {
        var t2 = txt();
        out.step = 'done';
        out.progressDesc = t2.indexOf('已首通区域数量') >= 0;
        // F01/F02 重写弹窗后，免责行统一为「榜单与奖励均由服务端结算，客户端只读」。
        // 这里验证「切 Tab 后只读与服务端结算提示仍在」，不钉死某一句旧措辞。
        out.progressDisclaimer = t2.indexOf('服务端结算') >= 0
          && (t2.indexOf('客户端只读') >= 0 || t2.indexOf('客户端上报无效') >= 0);
        out.progressUnit = t2.indexOf(' 区') >= 0;
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
  check('后端 health 带 rank 只读统计',
    health.data?.rank?.types === 4 && health.data?.rank?.readonly === true,
    JSON.stringify(health.data?.rank ?? null));

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

  const persist = JSON.stringify({ state: { save }, version: 11 });
  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    localStorage.setItem('beast-journal-save',${JSON.stringify(persist)});
    </script></body></html>`, 'utf8');
  const seedDom = runEdge(`${BASE}/_p42a_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_p42a_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地页与榜单弹窗均已渲染）', !!p && p.step === 'done',
    brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页存在「榜单」入口', p.entry === true, JSON.stringify(p.errors));
  check('弹窗标题为「兽域榜单」', p.boardTitle === true, brief(p));
  check('免责与只读提示同时可见',
    p.disclaimer === true && p.readonly === true && p.serverDerived === true, brief(p));
  check('四榜 Tab 全部渲染',
    ['单宠战力', '全队战力', '召唤师等级', '推图']
      .every((t) => Array.isArray(p.tabs) && p.tabs.includes(t)),
    JSON.stringify(p.tabs));
  check('榜单行渲染出至少一条（按账号）',
    p.hasRows === true, JSON.stringify(p.hasRows));
  check('弹窗打开时 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('切换到推图榜后说明文案更新',
    p.progressDesc === true && p.progressDisclaimer === true, brief(p));
  check('推图榜数值单位为「区」', p.progressUnit === true, brief(p));
  check('切换 Tab 后仍无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);
  if (Array.isArray(p.errors) && p.errors.length) {
    console.log(`[INFO] 探针内部提示：${p.errors.join(', ')}`);
  }

  // 服务端侧对照：UI 的数值必须来自只读派生接口
  const board = await apiJson('/api/rank/team_power?limit=5', { headers: auth });
  check('服务端榜单只读且真值来源为落库存档',
    board.status === 200 && board.data?.readonly === true
    && board.data?.source === 'server_save' && Array.isArray(board.data?.entries),
    JSON.stringify({ status: board.status, readonly: board.data?.readonly }));
  const forged = await apiJson('/api/rank/team_power?power=999999', { headers: auth });
  check('服务端拒绝客户端上报战力',
    forged.status === 400 && forged.data?.code === 'RANK_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 120)}`);
  const write = await apiJson('/api/rank/team_power', {
    method: 'POST', headers: auth, body: JSON.stringify({ value: 9999 }),
  });
  check('服务端无榜单写入口', write.status === 404, `status=${write.status}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_P42A_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_P42A_OK');
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
