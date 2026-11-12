/**
 * F16 共斗六房副本 UI 冒烟（375px headless Edge）。
 * 运行：node scripts/ui_smoke_f16.mjs
 *
 * 目标：证明「六房地图四态（未挑战 / 战斗中 / 已清理 / 已战败）+ 进度 + 贡献 +
 * 进房按钮 + 房内技能面板」在真浏览器里渲染得出来，且 375px 窄屏无横向溢出。
 * 快照由探针注入 `mpk:room-state`（服务端下发的同形状全量快照），客户端零计算只渲染；
 * 真实房间推进 / 发奖 / 幂等由 `e2e:f16` 覆盖。
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
const SEED = path.join(PUBLIC, '_f16_seed.html');
const PROBE = path.join(PUBLIC, '_f16_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_f16_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

const STATS = { hp: 60, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const monster = {
  id: 'm1', specId: 'sprout_owl', level: 30, exp: 0, element: 'grass',
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

function enemy(name, hp, maxHp, isAlive) {
  return { specId: 'sprout_owl', name, level: 5, hp, maxHp, status: 'none', isShiny: false, alive: isAlive };
}

/** 与后端 `coopViewFor()` 同形状的六房快照；A 在房内、B 回大厅（revision 递增）。 */
function fakeRoom(revision, selfRoomIndex) {
  const rooms = [
    { index: 0, state: 'cleared', occupantSeat: null, clearedBy: 0, defeatedBySeat: null,
      contributions: { 0: 40 }, enemyPreviews: [enemy('芽鸮', 0, 30, false), enemy('叶虫', 0, 30, false)] },
    { index: 1, state: 'fighting', occupantSeat: 0, clearedBy: null, defeatedBySeat: null,
      contributions: { 0: 12 }, enemyPreviews: [enemy('岩偶', 20, 30, true), enemy('铁鸟', 30, 30, true)] },
    { index: 2, state: 'defeated', occupantSeat: null, clearedBy: null, defeatedBySeat: 1,
      contributions: { 1: 5 }, enemyPreviews: [enemy('火鼠', 30, 30, true), enemy('岩偶二', 30, 30, true)] },
    { index: 3, state: 'pending', occupantSeat: null, clearedBy: null, defeatedBySeat: null,
      contributions: {}, enemyPreviews: [enemy('叶虫二', 30, 30, true), enemy('绒毛犬', 30, 30, true)] },
    { index: 4, state: 'pending', occupantSeat: null, clearedBy: null, defeatedBySeat: null,
      contributions: {}, enemyPreviews: [enemy('妖精', 30, 30, true), enemy('芽鸮二', 30, 30, true)] },
    { index: 5, state: 'pending', occupantSeat: null, clearedBy: null, defeatedBySeat: null,
      contributions: {}, enemyPreviews: [enemy('铁鸟二', 30, 30, true), enemy('泥猪', 30, 30, true)] },
  ];
  const publicActive = {
    specId: 'sprout_owl', name: '芽鸮', level: 30, hp: 120, maxHp: 120,
    status: 'none', isShiny: false, alive: true,
  };
  return {
    roomId: 'coop_probe_f16', mode: 'coop', status: 'active', revision,
    turn: 3, deadlineAt: 0,
    seats: [{ seat: 0, label: '座位 1', online: true, autopilot: false, submitted: false, self: true },
      { seat: 1, label: '座位 2', online: true, autopilot: false, submitted: false, self: false }],
    lastAction: null, quota: { key: 'coop', state: 'held' }, endReason: null,
    updatedAt: Date.now(), pvp: null,
    coop: {
      bossId: 'boss_ember_behemoth', bossName: '烈焰巨兽 · 讨伐', theme: 'volcano',
      turn: 3, finished: false, result: null,
      log: ['副本开始：6 间房、每房 2 只，全清即通关。', '座位 1 进入第 2 间房。'],
      rooms, cleared: 1, total: 6,
      self: {
        userId: 'self', seat: 0, roomIndex: selfRoomIndex, activeIndex: 0,
        party: [monster], ppByMonster: { m1: { tackle: 30 } }, contribution: 52, out: false,
      },
      members: [
        { seat: 0, userId: 'self', self: true, roomIndex: selfRoomIndex, out: false, contribution: 52, active: publicActive },
        { seat: 1, userId: 'ally', self: false, roomIndex: -1, out: false, contribution: 5, active: publicActive },
      ],
    },
  };
}

function probeHtml() {
  const A = JSON.stringify(fakeRoom(42, 1));
  const B = JSON.stringify(fakeRoom(43, -1));
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/camp" style="width:375px;height:812px;border:0"></iframe>
<script>
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
var completed = {};
var ROOM_A = ${A};
var ROOM_B = ${B};
window.onerror = function (msg) { out.errors.push('error:' + msg); finish(); };
function finish() {
  out.finalTxt = txt().slice(0, 900);
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
function inject(room) {
  var W = f.contentWindow;
  var evt = new W.CustomEvent('mpk:room-state', { detail: { type: 'room.state', room: room } });
  W.dispatchEvent(evt);
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
  waitFor('camp-entry', function () {
    return txt().indexOf('兽域手记') >= 0
      && buttons().some(function (b) { return b.textContent.trim() === '共斗'; });
  }, once('camp-entry', function () {
    var e = buttons().filter(function (b) { return b.textContent.trim() === '共斗'; })[0];
    if (!e) { out.errors.push('no-entry'); return finish(); }
    e.click();
    waitFor('modal', function () {
      return txt().indexOf('共斗副本') >= 0 && txt().indexOf('创建共斗房间') >= 0;
    }, once('modal', function () {
      inject(ROOM_A);
      waitFor('rooms-a', function () {
        var t = txt();
        return t.indexOf('副本进度') >= 0 && t.indexOf('第 6 间') >= 0;
      }, once('rooms-a', function () {
        var t = txt();
        out.step = 'rooms-a';
        out.progress = t.indexOf('已清理 1 / 6') >= 0;
        out.roomCells = ['第 1 间','第 2 间','第 3 间','第 4 间','第 5 间','第 6 间']
          .every(function (s) { return t.indexOf(s) >= 0; });
        out.states = ['未挑战','战斗中','已清理','已战败']
          .every(function (s) { return t.indexOf(s) >= 0; });
        out.contribution = t.indexOf('本场贡献') >= 0;
        out.skillBtn = buttons().some(function (b) { return b.textContent.indexOf('PP 30/') >= 0; });
        out.disclaimer = t.indexOf('全清即通关') >= 0;
        out.scrollWidthA = overflow();
        inject(ROOM_B);
        waitFor('rooms-b', function () {
          return buttons().some(function (b) { return b.textContent.trim() === '进入房间'; });
        }, once('rooms-b', function () {
          out.step = 'done';
          out.enterBtn = true;
          out.scrollWidthB = overflow();
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
  check('后端 health 在线', health.data?.sessions !== undefined, JSON.stringify(health.data ?? null).slice(0, 120));

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
  const seedDom = runEdge(`${BASE}/_f16_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_f16_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  const brief = (x) => JSON.stringify({ step: x?.step, errors: x?.errors, finalTxt: x?.finalTxt?.slice(0, 320) });
  check('探针回传（营地 → 共斗副本 → 六房地图 → 大厅进房按钮）', !!p && p.step === 'done', brief(p) ?? dom.slice(0, 200));
  if (!p) return report();

  check('六房地图渲染 6 个房间格', p.roomCells === true, brief(p));
  check('四态文案齐全（未挑战 / 战斗中 / 已清理 / 已战败）', p.states === true, brief(p));
  check('进度显示「已清理 1 / 6」', p.progress === true, brief(p));
  check('成员贡献面板渲染', p.contribution === true, brief(p));
  check('房内技能按钮（含 PP）渲染', p.skillBtn === true, brief(p));
  check('免责文案含「全清即通关」', p.disclaimer === true, brief(p));
  check('房内态 375px 无横向溢出',
    Number.isFinite(p.scrollWidthA) && p.scrollWidthA <= 375, `scrollWidth=${p.scrollWidthA}`);
  check('回到大厅出现「进入房间」按钮（revision 递增生效）', p.enterBtn === true, brief(p));
  check('大厅态 375px 无横向溢出',
    Number.isFinite(p.scrollWidthB) && p.scrollWidthB <= 375, `scrollWidth=${p.scrollWidthB}`);

  // 服务端对照：六房状态 / 贡献 / 奖励字段一律不准客户端上报。
  const forged = await apiJson('/api/coop/create', {
    method: 'POST', headers: auth,
    body: JSON.stringify({ bossId: 'boss_ember_behemoth', rooms: [], contribution: 99999, reward: 1 }),
  });
  check('服务端拒绝客户端伪造六房状态 / 贡献 / 奖励',
    forged.status === 400 && forged.data?.code === 'COOP_INPUT_FORBIDDEN',
    `${forged.status} ${JSON.stringify(forged.data).slice(0, 140)}`);

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_F16_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_F16_OK');
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
