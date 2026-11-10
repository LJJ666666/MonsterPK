/**
 * F04 徽章 / 成就双 Tab 弹窗 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f04.mjs
 *
 * 与 F16 冒烟不同：这里**不注入假状态**（服务端权威，不留客户端注入后门），
 * 而是注册真实账号 → 直接写 Grant 表（等价于服务端唯一写入口刚执行完）
 * → 浏览器打开营地 → 点「徽章」→ 验证只读投影与 375px 无横向溢出。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.EDGE_PATH || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BACKEND = path.join(ROOT, 'backend');
const PUBLIC = path.join(ROOT, 'public');
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3001';
const RUN = Date.now().toString(36).slice(-6);
const SEED = path.join(PUBLIC, '_f04_seed.html');
const PROBE = path.join(PUBLIC, '_f04_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f04_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

const STATS = { hp: 60, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const monster = {
  id: 'm1', specId: 'sprout_owl', level: 5, exp: 0, element: 'grass',
  maxHp: 60, hp: 60, atk: 40, def: 60, spAtk: 40, spDef: 60, spd: 70,
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
  out.finalTxt = txt().slice(0, 1200);
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() { try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; } }
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function buttons() { var d = doc(); return d ? [].slice.call(d.querySelectorAll('button')) : []; }
function byText(s) { return buttons().filter(function (b) { return b.textContent.trim() === s; })[0]; }
function once(label, fn) { return function () { if (completed[label]) return; completed[label] = true; fn(); }; }
function waitFor(label, cond, next, tries) {
  if (completed[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 240) { out.errors.push('timeout:' + label); return finish(); }
  var d = doc();
  if (d) {
    var ob = new MutationObserver(function () { if (cond()) { ob.disconnect(); next(); } });
    try { ob.observe(d.body, { subtree: true, childList: true, characterData: true }); } catch (e) {}
    setTimeout(function () { ob.disconnect(); waitFor(label, cond, next, tries + 1); }, 50);
  } else { setTimeout(function () { waitFor(label, cond, next, tries + 1); }, 50); }
}
function overflow() { var d = doc(); return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1; }
f.addEventListener('load', function () {
  out.loaded = true;
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0 && !!byText('徽章');
  }, once('camp-entry', function () {
    var e = byText('徽章');
    if (!e) { out.errors.push('no-entry'); return finish(); }
    e.click();
    waitFor('modal', function () {
      return txt().indexOf('徽章与成就') >= 0 && txt().indexOf('总等级加成') >= 0
        && txt().indexOf('读取服务端进度') < 0;
    }, once('modal', function () {
      var t = txt();
      out.step = 'badges';
      out.totalBonus = t.indexOf('总等级加成 +15') >= 0;
      out.playerLevel = t.indexOf('人物等级 Lv.20') >= 0;
      out.cap = t.indexOf('宠物等级帽 20') >= 0;
      out.badgeRows = ['青苗徽章 丨 5','磐石徽章 丨 5','翠羽徽章 丨 5','流泉徽章 丨 5',
        '赤焰徽章 丨 5','幽玄徽章 丨 5','霜华徽章 丨 5'].every(function (s) { return t.indexOf(s) >= 0; });
      out.owned = t.indexOf('已获得') >= 0;
      out.locked = t.indexOf('未挑战') >= 0 && t.indexOf('凛冬镇') >= 0;
      out.disclaimer = t.indexOf('超帽不降级') >= 0;
      out.scrollWidthA = overflow();
      var ach = byText('成就');
      if (!ach) { out.errors.push('no-ach-tab'); return finish(); }
      ach.click();
      waitFor('achievements', function () {
        return txt().indexOf('全体物攻 +5') >= 0;
      }, once('achievements', function () {
        var a = txt();
        out.step = 'done';
        out.achAll = a.indexOf('全体物攻 +5') >= 0;
        out.achElement = a.indexOf('火属性速度 +1') >= 0;
        out.achName = a.indexOf('百战之姿') >= 0 && a.indexOf('炎行千里') >= 0;
        out.achFooter = a.indexOf('属性加成待装备系统统一生效') >= 0;
        out.scrollWidthB = overflow();
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

function prismaClient() {
  const envPath = path.join(BACKEND, '.env');
  if (fs.existsSync(envPath)) {
    for (const line of fs.readFileSync(envPath, 'utf8').split('\n')) {
      const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
      if (!m) continue;
      let v = m[2].trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (process.env[m[1]] === undefined) process.env[m[1]] = v;
    }
  }
  const require = createRequire(path.join(BACKEND, 'package.json'));
  const { PrismaClient } = require('@prisma/client');
  return new PrismaClient();
}

async function main() {
  const username = `ui_f04_${RUN}`;
  const reg = await apiJson('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'ui-pass-123' }),
  });
  const token = reg.data?.token;
  check('注册测试账号', !!token, JSON.stringify(reg.data).slice(0, 160));
  if (!token) return report();
  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };

  const prisma = prismaClient();
  try {
    const u = await prisma.user.findUnique({ where: { username }, select: { id: true } });
    const uid = u?.id ?? '';
    for (const badgeId of ['badge_sprout', 'badge_stone', 'badge_flame']) {
      await prisma.badgeGrant.create({ data: { userId: uid, badgeId, source: 'ui_smoke' } });
    }
    for (const achievementId of ['ach_veteran', 'ach_flame_runner']) {
      await prisma.achievementGrant.create({ data: { userId: uid, achievementId, source: 'ui_smoke' } });
    }
    const progress = await apiJson('/api/player/progress', { headers: auth });
    check('服务端真值：3 徽章 → Lv.20 / 总加成 +15',
      progress.data?.progress?.level === 20 && progress.data.progress.badgeBonus === 15
      && progress.data.catalog?.length === 7,
      JSON.stringify(progress.data?.progress).slice(0, 200));
  } finally {
    await prisma.$disconnect();
  }

  const put = await apiJson('/api/save?slot=1', {
    method: 'PUT', headers: auth, body: JSON.stringify({ data: JSON.stringify(save), revision: 0 }),
  });
  check('建立云端基线存档', put.status === 200, `${put.status}`);

  const persist = JSON.stringify({ state: { save1: save, save2: null, save3: null, slot: 1 }, version: 10 });
  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    localStorage.setItem('beast-journal-save',${JSON.stringify(persist)});
    </script></body></html>`, 'utf8');
  const seedDom = runEdge(`${BASE}/_f04_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f04_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 400) });
  check('探针回传（营地 → 徽章弹窗 → 成就 Tab）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('顶部显示总等级加成 +15', p.totalBonus === true, brief(p));
  check('顶部显示人物等级 Lv.20 与宠物等级帽 20', p.playerLevel === true && p.cap === true, brief(p));
  check('徽章 Tab 七行「名称 丨 5」齐全', p.badgeRows === true, brief(p));
  check('已获得 / 未挑战两态可见', p.owned === true && p.locked === true, brief(p));
  check('免责文案含「超帽不降级」', p.disclaimer === true, brief(p));
  check('徽章 Tab 375px 无横向溢出',
    Number.isFinite(p.scrollWidthA) && p.scrollWidthA <= 375, `scrollWidth=${p.scrollWidthA}`);
  check('成就 Tab 显示全体物攻 +5 / 火属性速度 +1',
    p.achAll === true && p.achElement === true, brief(p));
  check('成就 Tab 显示成就名与 F06 边界说明', p.achName === true && p.achFooter === true, brief(p));
  check('成就 Tab 375px 无横向溢出',
    Number.isFinite(p.scrollWidthB) && p.scrollWidthB <= 375, `scrollWidth=${p.scrollWidthB}`);

  const forged = await apiJson('/api/player/progress?playerLevel=999', { headers: auth });
  check('服务端拒绝客户端伪上报等级',
    forged.status === 400 && forged.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 140)}`);

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F04_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F04_OK');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
}).finally(() => {
  for (const f of [SEED, PROBE]) { try { fs.rmSync(f, { force: true }); } catch {} }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
