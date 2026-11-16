/**
 * F18-b 演武堂 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f18b.mjs
 *
 * 目标：证明「营地 → 演武堂弹窗 → 点首城馆主「挑战馆主」→ 真进战斗（/arena）」这条链路
 * 在真浏览器里跑得通，且 375px 窄屏无横向溢出。
 * 接口权威（冷却、徽章归属、胜利发奖）由 `e2e` 覆盖，这里只管可视层与接线。
 */
import { execFileSync as rawExecFileSync } from 'node:child_process';
import { resolveBrowser } from './lib/browser.mjs';
import { createRetriedExec } from './lib/edgeDom.mjs';

// headless Edge --dump-dom 偶发返回 Chromium 错误页时有限重试（断言不变，见 lib/edgeDom.mjs）。
const execFileSync = createRetriedExec(rawExecFileSync);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = resolveBrowser();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
import { FRONT_BASE as BASE } from './lib/devConfig.mjs';
const API = 'http://localhost:3001';
const RUN = Date.now().toString(36).slice(-6);
const SEED = path.join(PUBLIC, '_f18b_seed.html');
const PROBE = path.join(PUBLIC, '_f18b_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f18b_${RUN}`);

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
  var t = txt();
  out.arenaActionVisible = t.indexOf('选择行动') >= 0;
  out.fightError = t.indexOf('无法开始挑战') >= 0 || t.indexOf('无法开始') >= 0;
  out.hash = (function () { try { return f.contentWindow.location.hash; } catch (e) { return ''; } })();
  out.path = (function () { try { return f.contentWindow.location.pathname; } catch (e) { return ''; } })();
  out.tail = t.slice(-400);
  // 抓取本城馆主卡片文本（含可能的 fightError）与开战按钮实时文案
  var d = doc();
  out.gymBtn = null;
  if (d) {
    var btns = [].slice.call(d.querySelectorAll('button'));
    for (var i = 0; i < btns.length; i++) {
      var p = btns[i].parentElement;
      for (var k = 0; k < 6 && p; k++) {
        if (p.textContent && p.textContent.indexOf('木之导师 青岚') >= 0) { out.gymBtn = btns[i].textContent.trim(); break; }
        p = p.parentElement;
      }
      if (out.gymBtn) break;
    }
  }
  out.finalTxt = t.slice(0, 6000);
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
/** 找「某城镇行」按钮：列表项整体是一个 button，文本形如「初心镇 (当前)…进入」，非 disabled。 */
function enterTownButton(name) {
  var d = doc(); if (!d) return null;
  var btns = [].slice.call(d.querySelectorAll('button'));
  for (var i = 0; i < btns.length; i++) {
    var t = btns[i].textContent || '';
    if (btns[i].disabled || t.indexOf(name) < 0 || t.indexOf('进入') < 0 || t.indexOf('未解锁') >= 0) continue;
    return btns[i];
  }
  return null;
}
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function once(label, fn) {
  return function () { if (completed[label]) return; completed[label] = true; fn(); };
}
/** 找到剧情弹窗的「继续 / 完成」推进按钮（其祖先含「剧情」标题）。 */
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
/** 反复点掉剧情弹窗（首帧 locationId 变化会自动 fire intro beat）。 */
function dismissStory(done) {
  var b = storyAdvance();
  if (b) { b.click(); setTimeout(function () { dismissStory(done); }, 250); }
  else done();
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
  // 1) 等营地加载。馆主入口已迁回各自地图：头部 chip「演武堂」必须不存在。
  waitFor('camp', function () {
    return txt().indexOf('兽域手记') >= 0 && !!enterTownButton('初心镇');
  }, once('camp', function () {
    out.campLoaded = true;
    out.noHeaderChip = !findButton('演武堂');
    // 剧情弹窗（intro beat）会盖住地图，先点掉再进详情
    dismissStory(function () {
    out.storyDismissed = true;
    // 2) 进初心镇地图详情
    var entry = enterTownButton('初心镇');
    if (!entry) { out.errors.push('no-enter'); return finish(); }
    entry.click();
    waitFor('detail', function () {
      var t = txt();
      return t.indexOf('初心镇') >= 0 && t.indexOf('演武堂 · 木之导师 青岚') >= 0
        && t.indexOf('挑战馆主') >= 0;
    }, once('detail', function () {
      var t = txt();
      out.step = 'detail';
      out.hasTownGym = t.indexOf('木之导师 青岚') >= 0;
      out.inMapCard = t.indexOf('演武堂 · 木之导师 青岚') >= 0;
      out.scrollWidth = overflow();
      var fight = findButton('挑战馆主');
      if (!fight) { out.errors.push('no-fight-btn'); return finish(); }
      fight.click();
      // 3) 开局成功：跳到 /arena，且战斗页渲染「演武堂馆主 + 固定行动区」。
      waitFor('arena', function () {
        return path() === '/arena' && txt().indexOf('演武堂馆主') >= 0
          && txt().indexOf('选择行动') >= 0;
      }, once('arena', function () {
        var t2 = txt();
        out.step = 'done';
        out.fightStarted = true;
        out.arenaPath = path();
        out.arenaAction = t2.indexOf('演武堂馆主') >= 0 && t2.indexOf('选择行动') >= 0;
        out.scrollWidth2 = overflow();
        finish();
      }));
    }));
    }); // dismissStory(camp)
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
  const username = `f18b_${RUN}`;
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
  const seedDom = runEdge(`${BASE}/_f18b_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f18b_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  console.log('PROBE_DUMP', JSON.stringify(p));
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地 → 地图详情本城馆主 → 战斗全部走完）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地加载成功', p.campLoaded === true, JSON.stringify(p.errors));
  check('头部菜单不再有「演武堂」chip（入口已迁回地图）', p.noHeaderChip === true, brief(p));
  check('地图详情页显示本城馆主卡片「演武堂 · 木之导师 青岚」', p.inMapCard === true, brief(p));
  check('首城馆主「木之导师 青岚」渲染', p.hasTownGym === true, brief(p));
  check('地图详情页 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('点「挑战馆主」进入战斗并跳转到 /arena',
    p.fightStarted === true && p.arenaPath === '/arena', brief(p));
  check('战斗页显示演武堂遭遇与固定行动区（确已离开营地）', p.arenaAction === true, brief(p));
  check('战斗页 375px 无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);

  // 服务端对照：演武堂概览只读，且客户端无伤害/胜负写入口
  const ov = await apiJson('/api/gym/overview', { headers: auth });
  check('服务端演武堂概览只读且含 7 座馆主',
    ov.status === 200 && ov.data?.readonly === true
    && Array.isArray(ov.data?.gyms) && ov.data.gyms.length === 7,
    JSON.stringify({ status: ov.status, readonly: ov.data?.readonly, n: ov.data?.gyms?.length }));
  const town = ov.data?.gyms?.find((g) => g.locationId === 'town_starter');
  check('首城馆主尚未持有徽章（新号基线）',
    town && town.badgeOwned === false, JSON.stringify(town));
  const write = await apiJson('/api/gym/town_starter/damage', {
    method: 'POST', headers: auth, body: JSON.stringify({ damage: 1 }),
  });
  check('服务端无演武堂伤害/胜负重写入口', write.status === 404, `status=${write.status}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F18B_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F18B_OK');
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
