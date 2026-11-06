/**
 * P2-1 / P2-2 前端 UI 冒烟（375px 移动端，headless Edge，无需外部依赖）。
 * 运行：node scripts/ui_smoke_p21.mjs
 *
 * 断言：Start 页必须渲染状态行且显示「实时通道已连接」（证明 WS 握手 + hello），
 * 并显示「在线权威态 rev=N」（证明收到服务端 session.state 权威快照）。
 * 临时 public 文件与浏览器 profile 用完即删。
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = process.env.EDGE_PATH || String.raw`C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe`;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
const BASE = 'http://localhost:5173';
const API = 'http://localhost:3001';
const RUN = Date.now().toString(36).slice(-6);
const SEED = path.join(PUBLIC, '_p21_seed.html');
const PROBE = path.join(PUBLIC, '_p21_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p21_${RUN}`);

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
const monster = {
  id: 'm1', specId: 'sprout_owl', level: 5, exp: 0, element: 'grass',
  maxHp: 57, hp: 57, atk: 63, def: 54, spAtk: 71, spDef: 61, spd: 76,
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

function probeHtml(route) {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING"><iframe id="app" src="${route}" style="width:375px;height:812px;border:0"></iframe><script>
  var f=document.getElementById('app');
  f.addEventListener('load',function(){
    setTimeout(function(){
      var out={ok:false};
      try{
        var d=f.contentDocument;
        var t=d.body?d.body.innerText:'';
        var root=d.getElementById('root');
        out={scrollWidth:d.documentElement.scrollWidth,textLen:t.length,
             mounted:!!(root&&root.children.length>0),
             hasAccount:t.indexOf('账号')>=0,hasSync:t.indexOf('同步')>=0,
             hasWs:t.indexOf('实时通道')>=0,
             wsOnline:t.indexOf('实时通道已连接')>=0,
             wsUnauth:t.indexOf('实时连接未授权')>=0,
             hasSession:t.indexOf('在线权威态')>=0,
             sessionRev:t.indexOf('rev=')>=0,
             hasCamp:t.indexOf('地区列表')>=0&&t.indexOf('背包')>=0,textHead:t.slice(0,260),
             title:d.title};
      }catch(e){out.error=String(e)}
      document.body.setAttribute('data-probe',encodeURIComponent(JSON.stringify(out)));
    },4000);
  });
  </script></body></html>`;
}

function runEdge(url) {
  return execFileSync(EDGE, [
    '--headless=new', '--disable-gpu', '--no-first-run', '--no-default-browser-check',
    `--user-data-dir=${PROFILE}`, '--window-size=375,812',
    '--virtual-time-budget=14000', '--dump-dom', url,
  ], { encoding: 'utf8', timeout: 90_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseProbe(dom) {
  const m = dom.match(/data-probe="([^"]+)"/);
  if (!m || m[1] === 'PENDING') return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

async function main() {
  const health = await fetch(`${API}/api/health`).then((r) => r.json());
  check('后端 health 带 ws 在线统计与 sessions 权威态统计',
    typeof health?.ws?.connections === 'number' && typeof health?.sessions?.slots === 'number',
    JSON.stringify(health));

  const reg = await fetch(`${API}/api/auth/register`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: `ui_${RUN}`, password: 'ui-pass-123' }),
  });
  const regData = await reg.json();
  const token = regData.token;
  if (!token) throw new Error(`注册失败: ${JSON.stringify(regData)}`);
  const putRes = await fetch(`${API}/api/save?slot=1`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: JSON.stringify({ data: JSON.stringify(save) }),
  });
  check('建立云端基线存档', putRes.status === 200, String(putRes.status));

  const persist = JSON.stringify({ state: { save1: save, save2: null, save3: null, slot: 1 }, version: 10 });
  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    localStorage.setItem('beast-journal-save',${JSON.stringify(persist)});
    </script></body></html>`, 'utf8');

  const seedDom = runEdge(`${BASE}/_p21_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  for (const [label, route] of [['Start 首页', '/'], ['Camp 营地', '/camp']]) {
    fs.writeFileSync(PROBE, probeHtml(route), 'utf8');
    const dom = runEdge(`${BASE}/_p21_probe.html?r=${encodeURIComponent(route)}&t=${Date.now()}`);
    const p = parseProbe(dom);
    check(`${label} 探针回传`, !!p, dom.slice(0, 160));
    if (!p) continue;
    check(`${label} React 已挂载且非白屏`, p.mounted === true && p.textLen > 50, JSON.stringify(p));
    check(`${label} 375px 无横向溢出`, Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, JSON.stringify(p));
    if (label === 'Start 首页') {
      check('Start 显示账号条与同步状态行', p.hasAccount === true && p.hasSync === true, JSON.stringify(p));
      check('Start 显示实时通道状态行', p.hasWs === true, JSON.stringify(p));
      check('Start 实时通道已连接（WS 握手并收到 hello）',
        p.wsOnline === true && p.wsUnauth === false, JSON.stringify(p));
      check('Start 显示在线权威态状态行', p.hasSession === true, JSON.stringify(p));
      check('Start 收到服务端权威快照（rev=N）', p.sessionRev === true, JSON.stringify(p));
    } else {
      check('Camp 显示营地内容', p.hasCamp === true, JSON.stringify(p));
    }
  }
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_OK');
}

try {
  await main();
} catch (e) {
  console.error('UI_SMOKE_ABORT', e);
  process.exitCode = 1;
} finally {
  for (const p of [SEED, PROBE]) { try { fs.unlinkSync(p); } catch { /* 已清理 */ } }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch { /* 忽略 */ }
}
