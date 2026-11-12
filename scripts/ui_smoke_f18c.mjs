/**
 * F18-c 地图首领 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f18c.mjs
 *
 * 目标：证明「营地 → 地图首领弹窗 → 点首城首领「挑战」→ 真进战斗（/arena）」这条链路
 * 在真浏览器里跑得通，且 375px 窄屏无横向溢出。同时校验掉落预览文案与「不上排行榜」声明。
 * 接口权威（次数、掉落、禁捕获）由 `e2e` 覆盖，这里只管可视层与接线。
 */
import { execFileSync } from 'node:child_process';
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
const SEED = path.join(PUBLIC, '_f18c_seed.html');
const PROBE = path.join(PUBLIC, '_f18c_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f18c_${RUN}`);

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
  out.finalTxt = txt().slice(0, 1000);
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function path() { try { return f.contentWindow.location.pathname; } catch (e) { return ''; } }
function overflow() {
  var d = doc();
  return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1;
}
function findButton(label) {
  var d = doc(); if (!d) return null;
  var btns = [].slice.call(d.querySelectorAll('button'));
  for (var i = 0; i < btns.length; i++) {
    if (btns[i].textContent.trim() === label) return btns[i];
  }
  return null;
}
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function buttonInRow(text) {
  var d = doc(); if (!d) return null;
  var btns = [].slice.call(d.querySelectorAll('button'));
  for (var i = 0; i < btns.length; i++) {
    var p = btns[i].parentElement;
    for (var k = 0; k < 6 && p; k++) {
      if (p.textContent && p.textContent.indexOf(text) >= 0) return btns[i];
      p = p.parentElement;
    }
  }
  return null;
}
function storyAdvance() {
  var d = doc(); if (!d) return null;
  var all = [].slice.call(d.querySelectorAll('button'));
  for (var i = 0; i < all.length; i++) {
    var t = all[i].textContent.trim();
    if (t === '继续' || t === '完成') {
      var p = all[i].parentElement;
      for (var k = 0; k < 6 && p; k++) {
        if (p.textContent && p.textContent.indexOf('剧情') >= 0) return all[i];
        p = p.parentElement;
      }
    }
  }
  return null;
}
function dismissStory(done) {
  var b = storyAdvance();
  if (b) { b.click(); setTimeout(function () { dismissStory(done); }, 250); }
  else done();
}
function once(label, fn) {
  return function () { if (completed[label]) return; completed[label] = true; fn(); };
}
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 300) { out.errors.push('timeout:' + label); return finish(); }
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
  // 1) 等营地渲染出「地图首领」入口
  waitFor('camp', function () {
    return txt().indexOf('兽域手记') >= 0 && !!findButton('地图首领');
  }, once('camp', function () {
    out.campLoaded = true;
    var e = findButton('地图首领');
    if (!e) { out.errors.push('no-entry'); return finish(); }
    e.click();
    // 2) 等弹窗渲染完（不是 loading）
    waitFor('modal', function () {
      var t = txt();
      return t.indexOf('地图首领') >= 0 && t.indexOf('挑战') >= 0
        && t.indexOf('正在读取地图首领') < 0;
    }, once('modal', function () {
      var t = txt();
      out.step = 'modal';
      out.title = t.indexOf('地图首领') >= 0;
      out.disclaimer = t.indexOf('不上排行榜，每日有次数上限') >= 0;
      out.hasTownBoss = t.indexOf('萌芽守望者') >= 0;
      out.aceText = t.indexOf('王牌') >= 0;
      out.quotaText = t.indexOf('每日余量 3/3') >= 0;
      out.dropText = t.indexOf('掉落') >= 0 && t.indexOf('50 金币') >= 0;
      out.scrollWidth = overflow();
      // 先点掉可能盖在最上层的剧情弹窗（intro beat），再点开战按钮
      dismissStory(function () {
        out.storyDismissed = true;
        var allBtns = buttons().filter(function (b) { return b.textContent.trim() === '挑战'; });
        var fight = allBtns[0];
        if (!fight) { out.errors.push('no-fight-btn'); return finish(); }
        fight.click();
      // 3) 开局成功应跳到 Arena，且头部显示首领战标记
      waitFor('arena', function () {
        return path() === '/arena' && txt().indexOf('首领 · 本场伤害') >= 0;
      }, once('arena', function () {
        var t2 = txt();
        out.step = 'done';
        out.fightStarted = true;
        out.arenaPath = path();
        out.arenaHeader = t2.indexOf('首领 · 本场伤害') >= 0;
        out.scrollWidth2 = overflow();
        finish();
      }));
      });
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
  const username = `f18c_${RUN}`;
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
  const seedDom = runEdge(`${BASE}/_f18c_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f18c_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地 → 地图首领弹窗 → 战斗全部走完）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页存在「地图首领」入口', p.campLoaded === true, JSON.stringify(p.errors));
  check('弹窗标题为「地图首领」', p.title === true, brief(p));
  check('声明「不上排行榜，每日有次数上限」', p.disclaimer === true, brief(p));
  check('首城首领「萌芽守望者」渲染', p.hasTownBoss === true, brief(p));
  check('显示王牌信息「王牌 … · Lv.8」', p.aceText === true, brief(p));
  check('显示「每日余量 3/3」', p.quotaText === true, brief(p));
  check('显示掉落预览「掉落 … 50 金币」', p.dropText === true, brief(p));
  check('弹窗打开时 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('点「挑战」进入战斗并跳转到 /arena',
    p.fightStarted === true && p.arenaPath === '/arena', brief(p));
  check('战斗页头部显示「首领 · 本场伤害」', p.arenaHeader === true, brief(p));
  check('战斗页 375px 无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);

  // 服务端对照：地图首领列表只读，且首城首领已解锁、余量 3
  const list = await apiJson('/api/mapboss', { headers: auth });
  check('服务端地图首领列表只读且含 7 座首领',
    list.status === 200 && list.data?.readonly === true
    && Array.isArray(list.data?.bosses) && list.data.bosses.length === 7,
    JSON.stringify({ status: list.status, readonly: list.data?.readonly, n: list.data?.bosses?.length }));
  const town = list.data?.bosses?.find((b) => b.mapBossId === 'mb_starter_guardian');
  // 注：本测试前半段已通过 UI 发起了 1 场该首领战斗，服务端会占用 1 个当日名额（held>=1），
  // 故剩余名额 = dailyLimit - held，不可硬断言为 3。
  check('首城首领已解锁且每日上限=3（余量随进行中战斗递减）',
    town && town.unlocked === true && town.dailyLimit === 3
      && town.remaining === town.dailyLimit - (town.held || 0),
    JSON.stringify(town));
  const forged = await apiJson('/api/mapboss/mb_starter_guardian/damage', {
    method: 'POST', headers: auth, body: JSON.stringify({ damage: 9999 }),
  });
  check('服务端无地图首领伤害/胜负重写入口', forged.status === 404, `status=${forged.status}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F18C_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F18C_OK');
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
