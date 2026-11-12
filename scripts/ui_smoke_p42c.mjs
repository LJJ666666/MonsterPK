/**
 * P4-2c 讨伐 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_p42c.mjs
 *
 * 目标：证明「营地 → 讨伐弹窗 → 三只 Boss / 剩余次数 / 今日伤害榜 → 点讨伐真的进战斗」
 * 这条链路在真浏览器里跑得通，且 375px 窄屏无横向溢出。
 * 接口权威（伤害真值、次数、伪上报拦截）由 `e2e:p42c` 覆盖，这里只管可视层与接线。
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
const SEED = path.join(PUBLIC, '_p42c_seed.html');
const PROBE = path.join(PUBLIC, '_p42c_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p42c_${RUN}`);

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
function overflow() {
  var d = doc();
  return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1;
}
f.addEventListener('load', function () {
  out.loaded = true;
  out.initialTxt = txt().slice(0, 260);
  out.initialButtons = buttons().map(function (b) { return b.textContent.trim(); }).slice(0, 24);
  finish();
  // 1) 等营地渲染出「讨伐」入口
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0
      && buttons().some(function (b) { return b.textContent.trim() === '讨伐'; });
  }, once('camp-entry', function () {
    out.entry = true;
    var e = buttons().filter(function (b) { return b.textContent.trim() === '讨伐'; })[0];
    if (!e) { out.errors.push('no-entry'); return finish(); }
    e.click();
    // 2) 等弹窗渲染完 Boss 列表与榜单（不是 loading）
    waitFor('board', function () {
      var t = txt();
      return t.indexOf('兽域讨伐') >= 0 && t.indexOf('今日伤害榜') >= 0
        && t.indexOf('正在读取讨伐列表') < 0 && t.indexOf('正在读取榜单') < 0;
    }, once('board', function () {
      var t = txt();
      out.step = 'board';
      out.title = t.indexOf('兽域讨伐') >= 0;
      out.disclaimer = t.indexOf('服务端战斗结算产出') >= 0 && t.indexOf('不扣次数') >= 0;
      out.bossCount = (t.match(/Lv\\.\\d+/g) || []).length;
      out.hasBehemoth = t.indexOf('烈焰巨兽') >= 0;
      out.hasDragon = t.indexOf('霸主苍龙') >= 0;
      out.quotaText = /今日剩余 \\d+\\/\\d+/.test(t);
      out.rankTitle = t.indexOf('今日伤害榜') >= 0;
      out.scrollWidth = overflow();
      var btns = buttons().filter(function (b) { return b.textContent.trim() === '讨伐'; });
      out.fightButtons = btns.length;
      var fight = btns[btns.length - 1];
      if (!fight) { out.errors.push('no-fight-btn'); return finish(); }
      fight.click();
      // 3) 开局成功应跳到 Arena 并渲染 Boss 战标题 + 本场伤害
      waitFor('arena', function () {
        var t2 = txt();
        return t2.indexOf('烈焰巨兽 · 讨伐') >= 0 && t2.indexOf('讨伐 · 本场伤害') >= 0;
      }, once('arena', function () {
        var t3 = txt();
        out.step = 'done';
        out.fightStarted = true;
        out.arenaTitle = t3.indexOf('烈焰巨兽 · 讨伐') >= 0;
        out.arenaDamage = t3.indexOf('讨伐 · 本场伤害') >= 0;
        out.arenaServer = t3.indexOf('服务端裁决') >= 0;
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
  check('后端 health 带 boss 讨伐统计',
    health.data?.boss?.bosses === 3 && health.data?.boss?.damageSource === 'server_battle',
    JSON.stringify(health.data?.boss ?? null));

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
  const seedDom = runEdge(`${BASE}/_p42c_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_p42c_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 300) });
  check('探针回传（营地 → 讨伐弹窗 → 战斗全部走完）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('营地页存在「讨伐」入口', p.entry === true, JSON.stringify(p.errors));
  check('弹窗标题为「兽域讨伐」', p.title === true, brief(p));
  check('免责文案含「服务端战斗结算产出」与「逃跑/放弃不扣次数」', p.disclaimer === true, brief(p));
  check('三只 Boss 全部渲染（含烈焰巨兽 / 霸主苍龙）',
    Number(p.bossCount) >= 3 && p.hasBehemoth === true && p.hasDragon === true,
    JSON.stringify({ n: p.bossCount, hasBehemoth: p.hasBehemoth, hasDragon: p.hasDragon }));
  check('每只 Boss 显示「今日剩余 x/y」', p.quotaText === true, brief(p));
  check('伤害榜区渲染（今日伤害榜）', p.rankTitle === true, brief(p));
  check('弹窗打开时 375px 无横向溢出',
    Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, `scrollWidth=${p.scrollWidth}`);
  check('弹窗存在开战按钮', Number(p.fightButtons) >= 1, `n=${p.fightButtons}`);
  check('点「讨伐」进入战斗并渲染 Boss 标题',
    p.fightStarted === true && p.arenaTitle === true, brief(p));
  check('战斗页显示「本场伤害」与服务端裁决标识',
    p.arenaDamage === true && p.arenaServer === true, brief(p));
  check('战斗页 375px 无横向溢出',
    Number.isFinite(p.scrollWidth2) && p.scrollWidth2 <= 375, `scrollWidth=${p.scrollWidth2}`);

  // 服务端对照：UI 展示的次数与真值来自只读接口
  const list = await apiJson('/api/boss', { headers: auth });
  check('服务端讨伐列表只读且次数来自服务端',
    list.status === 200 && list.data?.readonly === true
    && list.data?.bosses?.length === 3
    && list.data.bosses.every((b) => typeof b.remaining === 'number'),
    JSON.stringify({ status: list.status, readonly: list.data?.readonly }));
  const forged = await apiJson('/api/boss/start', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bossId: 'boss_ember_behemoth', damage: 999999 }),
  });
  check('服务端拒绝客户端上报伤害',
    forged.status === 400 && forged.data?.code === 'BOSS_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 120)}`);
  const write = await apiJson('/api/boss/boss_ember_behemoth/rank', {
    method: 'POST', headers: auth, body: JSON.stringify({ damage: 1 }),
  });
  check('服务端无伤害榜写入口', write.status === 404, `status=${write.status}`);
  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_P42C_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_P42C_OK');
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
