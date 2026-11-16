/**
 * F18-d 剧情已读进度 UI 冒烟（375px headless）。
 * 运行：node scripts/ui_smoke_f18d.mjs
 *
 * 目标：证明「到达 intro 只在第一次播放」这条修复在真浏览器里成立。
 * 旧行为：`firedSession` 是模块级 Set，重载即清 → 每次冷启动都要连点 3 次「继续」
 * 把已看过的剧情重看一遍（bug_log §72 观察点 1）。
 *
 * 两趟探针：
 *   第 1 趟 — 全新账号进 /camp → 应弹出「剧情」，逐行点完 3 屏后关闭；
 *            关闭后直接问服务端 GET /api/story/seen，应含 arrival_town_starter。
 *   第 2 趟 — 同一账号、同一份 localStorage，重新冷启动一次 → **不应再弹剧情**，
 *            但营地本身必须正常渲染（证明不是靠白屏/报错「跳过」的假绿）。
 *
 * 范式与 ui_smoke_f18a 一致：seed HTML 注入 token，probe HTML 用 iframe 驱动 SPA，
 * 结果写进 body[data-probe] 由 --dump-dom 回传。
 */
import { execFileSync as rawExecFileSync } from 'node:child_process';
import { createRetriedExec } from './lib/edgeDom.mjs';

// headless --dump-dom 偶发返回 Chromium 错误页时有限重试（断言不变，见 lib/edgeDom.mjs）。
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
const SEED = path.join(PUBLIC, '_f18d_seed.html');
const PROBE1 = path.join(PUBLIC, '_f18d_probe1.html');
const PROBE2 = path.join(PUBLIC, '_f18d_probe2.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f18d_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

/** arrival_town_starter 的首行台词片段；用它判断「剧情弹窗是否在屏幕上」。 */
const STORY_LINE = '初心镇被常青的草坡温柔环抱';

const STATS = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const monster = {
  id: 'm1', specId: 'sprout_owl', level: 5, exp: 0, element: 'grass',
  maxHp: 120, hp: 120, atk: 40, def: 60, spAtk: 40, spDef: 60, spd: 70,
  status: 'none', moveIds: ['tackle'], initStats: STATS, growthRates: GROWTH,
};
const save = {
  version: '11', playerName: '旅行者', money: 1200, steps: 340,
  locationId: 'town_starter', lastHealLocationId: 'town_starter',
  visitedLocationIds: ['town_starter'], party: [monster], box: [],
  inventory: { capsule_basic: 6, potion_small: 3 },
  collection: {}, clearedAreas: {}, lastSavedAt: new Date(Date.now() - 60_000).toISOString(),
};

/** 公共探针骨架（等待 / 点击 / 采样工具）。 */
const PROBE_HELPERS = `
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
var completed = {};
window.onerror = function (msg) { out.errors.push('error:' + msg); finish(); };
function finish() {
  try { out.finalTxt = txt().slice(0, 600); } catch (e) {}
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function once(label, fn) { return function () { if (completed[label]) return; completed[label] = true; fn(); }; }
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 300) { out.errors.push('timeout:' + label); return finish(); }
  var d = doc();
  if (d) {
    var ob = new MutationObserver(function () { if (cond()) { ob.disconnect(); next(); } });
    try { ob.observe(d.body, { subtree: true, childList: true, characterData: true }); } catch (e) {}
    setTimeout(function () { ob.disconnect(); waitFor(label, cond, next, tries + 1); }, 50);
  } else {
    setTimeout(function () { waitFor(label, cond, next, tries + 1); }, 50);
  }
}
/** 点剧情弹窗的推进按钮（只认「继续」「完成」，避免误点页面其它按钮）。 */
function clickStoryButton() {
  var d = doc();
  if (!d) return false;
  var bs = d.querySelectorAll('button');
  for (var i = 0; i < bs.length; i += 1) {
    var t = (bs[i].textContent || '').trim();
    if (t === '继续' || t === '完成') { bs[i].click(); return true; }
  }
  return false;
}
/** 真实网络请求：--virtual-time-budget 会快进定时器，只有挂真实 fetch 才会等真实时间。 */
function realTick(cb) { fetch('/api/health', { cache: 'no-store' }).then(cb, cb); }
`;

/** 第 1 趟：应弹出剧情，点完 3 屏。 */
function probe1Html() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/camp" style="width:375px;height:812px;border:0"></iframe>
<script>${PROBE_HELPERS}
var STORY_LINE = ${JSON.stringify(STORY_LINE)};
function storyOnScreen() { return txt().indexOf(STORY_LINE) >= 0; }
var clicks = 0;
function tap() {
  if (clicks >= 3) return afterClicks();
  clicks += 1;
  var ok = clickStoryButton();
  if (!ok) out.errors.push('no-button-at-' + clicks);
  // 每步都挂一次真实请求，避免虚拟时钟把 React 重渲染的窗口瞬间跨过
  realTick(function () {
    setTimeout(function () { tap(); }, 120);
  });
}
function afterClicks() {
  realTick(function () {
    realTick(function () {
      realTick(function () {
        out.step = 'closed';
        out.clicks = clicks;
        out.storyStillOnScreen = storyOnScreen();
        out.campText = txt().indexOf('兽域手记') >= 0;
        finish();
      });
    });
  });
}
f.addEventListener('load', function () {
  out.loaded = true;
  waitFor('story', storyOnScreen, once('story', function () {
    out.step = 'story';
    out.storyShown = true;
    // 弹窗是 3 行台词：继续 / 继续 / 完成
    out.totalLabel = (txt().indexOf('1 / 3') >= 0);
    tap();
  }));
});
</script></body></html>`;
}

/** 第 2 趟：同一账号再冷启动一次，不应再弹剧情。 */
function probe2Html() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/camp" style="width:375px;height:812px;border:0"></iframe>
<script>${PROBE_HELPERS}
var STORY_LINE = ${JSON.stringify(STORY_LINE)};
f.addEventListener('load', function () {
  out.loaded = true;
  // 先等营地本身渲染出来，再判断剧情有没有弹（避免「白屏=没弹」的假绿）
  waitFor('camp', function () {
    var t = txt();
    return t.indexOf('兽域手记') >= 0 && t.indexOf('进入') >= 0;
  }, once('camp', function () {
    out.campRendered = true;
    // 多挂几轮真实请求 + 定时器，给「已读集合」GET 与首帧触发留出窗口
    var n = 0;
    function probe() {
      n += 1;
      if (n < 6) { realTick(function () { setTimeout(probe, 120); }); return; }
      out.step = 'camp';
      out.storyShown = txt().indexOf(STORY_LINE) >= 0;
      out.noStoryToast = txt().indexOf('1 / 3') < 0;
      finish();
    }
    probe();
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
  const username = `f18d_${RUN}`;
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
  check('建立云端基线存档（locationId=town_starter）', put.status === 200, `${put.status}`);

  const seenBefore = await apiJson('/api/story/seen', { headers: auth });
  check('新账号已读集合为空', Array.isArray(seenBefore.data?.seen) && seenBefore.data.seen.length === 0,
    JSON.stringify(seenBefore.data).slice(0, 160));

  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    </script></body></html>`, 'utf8');
  const seedDom = runEdge(`${BASE}/_f18d_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  // ── 第 1 趟：首次到达应弹出剧情，逐行点完 ──
  fs.writeFileSync(PROBE1, probe1Html(), 'utf8');
  const dom1 = runEdge(`${BASE}/_f18d_probe1.html?t=${Date.now()}`);
  const p1 = parseProbe(dom1);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, final: x?.finalTxt?.slice(0, 200) });
  check('探针 1 回传（剧情弹窗已出现并点完）', !!p1 && p1.step === 'closed', brief(p1) ?? dom1.slice(0, 200));
  if (!p1) return report();

  check('首次进营地弹出到达剧情', p1.storyShown === true, brief(p1));
  check('剧情是 3 行分页（1 / 3）', p1.totalLabel === true, brief(p1));
  check('点完 3 次后弹窗关闭', p1.storyStillOnScreen === false, brief(p1));
  check('关闭后营地正常渲染', p1.campText === true, brief(p1));

  // 直接问服务端：这一步是「已读落库」的硬证据，不依赖前端采样时机
  const seenAfter = await apiJson('/api/story/seen', { headers: auth });
  check('服务端已记录 arrival_town_starter',
    Array.isArray(seenAfter.data?.seen) && seenAfter.data.seen.includes('arrival_town_starter'),
    JSON.stringify(seenAfter.data).slice(0, 200));

  // ── 第 2 趟：同一账号再冷启动一次，不应重播 ──
  fs.writeFileSync(PROBE2, probe2Html(), 'utf8');
  const dom2 = runEdge(`${BASE}/_f18d_probe2.html?t=${Date.now()}`);
  const p2 = parseProbe(dom2);
  check('探针 2 回传（营地已渲染）', !!p2 && p2.step === 'camp', brief(p2) ?? dom2.slice(0, 200));
  if (!p2) return report();

  check('第二次冷启动营地正常渲染（不是白屏假绿）', p2.campRendered === true, brief(p2));
  check('第二次冷启动不再重播已看过的剧情', p2.storyShown === false, brief(p2));
  check('页面无剧情分页残留（1 / 3）', p2.noStoryToast === true, brief(p2));

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F18D_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F18D_OK');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
}).finally(() => {
  for (const f of [SEED, PROBE1, PROBE2]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
