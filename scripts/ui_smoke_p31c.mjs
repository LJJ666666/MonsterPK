/**
 * P3-1c 前端服务端战斗链路冒烟（375px headless Edge，无需额外依赖）。
 * 运行：node scripts/ui_smoke_p31c.mjs
 *
 * 为什么必须有这一层：store 单测是 mock 掉 api 的，能证明「入口分流写对了」，
 * 但证明不了「真浏览器里点按钮 → 前端发意图 → 服务端结算 → 存档真的变了」。
 * 这里就查这条端到端链路：
 *   1. 训练场点「快速开始」后出现服务端下发的战斗（顶部角标「服务端裁决」）；
 *   2. 点技能/逃跑后回合推进或战斗结束（说明动作真的转给了 /api/battle/action）；
 *   3. 用 HTTP 复查存档：战斗结束后服务端已经写档（HP / 金钱 / 图鉴有变化）。
 *
 * 实现要点：不用固定 sleep 串流程（--virtual-time-budget 下定时器会被快进），
 * 改用 MutationObserver 等 React 重渲染，条件满足即进入下一步，超时再兜底。
 * 临时 public 文件与浏览器 profile 用完即删。
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
const SEED = path.join(PUBLIC, '_p31c_seed.html');
const PROBE = path.join(PUBLIC, '_p31c_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_p31c_${RUN}`);

const STATS = { hp: 60, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };
// 血厚 + 低攻，保证不会一击结束，从而一定能观察到「回合推进」
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

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}

function probeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/arena" style="width:375px;height:812px;border:0"></iframe>
<script>
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
function finish() {
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
function clickOne(pred) {
  var b = buttons().filter(pred)[0];
  if (!b) return false;
  b.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: f.contentWindow }));
  return true;
}
/** 等条件成立（靠 React 重渲染触发 mutation），超时也往下走，避免整脚本卡死。 */
function waitFor(label, cond, next, tries) {
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 400) { out.errors.push('timeout:' + label); return next(); }
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
var turn = function () { var m = txt().match(/回合 (\\d+)/); return m ? Number(m[1]) : 0; };

f.addEventListener('load', function () {
  waitFor('arena-ready', function () { return txt().indexOf('训练场') >= 0 || buttons().length > 0; }, function () {
    // 虚拟时间会快进定时器，多个 observer 可能同时满足并重复调用 next；
    // 不幂等就会在战斗结束后二次执行，把 moveClicked / turnAtStart 覆盖掉。
    if (out.arenaSeen) return;
    out.arenaSeen = true;
    out.step = 'arena';
    out.arenaReady = true;
    out.startClicked = clickOne(function (b) { return b.textContent.indexOf('快速开始') >= 0; });
  });

  waitFor('battle-started', function () { return txt().indexOf('服务端裁决') >= 0; }, function () {
    if (out.battleSeen) return;
    out.battleSeen = true;
    out.step = 'battle';
    out.serverBadge = txt().indexOf('服务端裁决') >= 0;
    out.localBadge = txt().indexOf('本地模式') >= 0;
    out.turnAtStart = turn();
    out.hasEnemyHp = txt().indexOf('HP') >= 0;
    var before = txt();
    out.moveClicked = clickOne(function (b) { return b.textContent.indexOf('威力') >= 0; });
    waitFor('turn-advanced', function () {
      var t = txt();
      return turn() > out.turnAtStart || t.indexOf('结束') >= 0 || t.indexOf('对手倒下') >= 0;
    }, function () {
      out.step = 'acted';
      out.turnAfterMove = turn();
      out.finishedAfterMove = txt().indexOf('结束') >= 0;
      // 还没结束就再打两次，尽量把一场仗打完，好验证结算写档
      var guard = 0;
      (function more() {
        if (guard++ > 6) return doneAll();
        var t = txt();
        if (t.indexOf('结束') >= 0) return doneAll();
        var clicked = clickOne(function (b) { return b.textContent.indexOf('威力') >= 0; });
        if (!clicked) return doneAll();
        var t0 = turn();
        waitFor('more-turn', function () { return turn() > t0 || txt().indexOf('结束') >= 0; }, more, 0);
      })();
    });
  });
});

function doneAll() {
  out.step = 'done';
  out.finalText = txt().slice(0, 400);
  out.finalTurn = turn();
  out.ended = out.finalText.indexOf('结束') >= 0;
  out.scrollWidth = doc() ? doc().documentElement.scrollWidth : -1;
  finish();
}
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
  check('后端 health 可读', health.data?.ok === true, JSON.stringify(health.data));
  check('后端已启用服务端战斗（battles 统计存在）',
    typeof health.data?.battles?.active === 'number', JSON.stringify(health.data?.battles));

  const username = `ui3_${RUN}`;
  const reg = await apiJson('/api/auth/register', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password: 'ui3-pass-123' }),
  });
  const token = reg.data?.token;
  check('注册测试账号', !!token, JSON.stringify(reg.data).slice(0, 160));
  if (!token) return report();

  const auth = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
  // P4：整包 PUT 必须带 revision（CAS）。新账号服务端没有存档，基线就是 0。
  const put = await apiJson('/api/save', {
    method: 'PUT', headers: auth, body: JSON.stringify({ data: JSON.stringify(save), revision: 0 }),
  });
  check('建立云端基线存档', put.status === 200, `${put.status} ${JSON.stringify(put.data).slice(0, 120)}`);

  const persist = JSON.stringify({ state: { save }, version: 11 });
  fs.writeFileSync(SEED, `<!doctype html><html><head><meta charset="utf-8"></head><body>SEEDED<script>
    localStorage.setItem('mpk_token',${JSON.stringify(token)});
    localStorage.setItem('beast-journal-save',${JSON.stringify(persist)});
    </script></body></html>`, 'utf8');

  const seedDom = runEdge(`${BASE}/_p31c_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_p31c_probe.html?t=${Date.now()}`);
  const p = parseProbe(dom);
  check('探针回传（页面未白屏且完成交互）', !!p, dom.slice(0, 200));
  if (!p) return report();

  check('训练场渲染出「快速开始」入口', p.arenaReady === true && p.startClicked !== false,
    JSON.stringify(p));
  check('点「快速开始」后进入战斗（服务端下发对手）', p.serverBadge === true, JSON.stringify(p));
  check('战斗态来自服务端而非本地降级（无「本地模式」角标）', p.localBadge !== true, JSON.stringify(p));
  check('技能按钮可点（我方队伍副本带 moveIds）', p.moveClicked === true, JSON.stringify(p));
  check('动作生效：回合推进或战斗结束',
    (p.turnAfterMove ?? 0) > (p.turnAtStart ?? 0) || p.finishedAfterMove === true || p.ended === true,
    JSON.stringify({ start: p.turnAtStart, after: p.turnAfterMove, ended: p.ended }));
  check('375px 无横向溢出', Number.isFinite(p.scrollWidth) && p.scrollWidth <= 375, String(p.scrollWidth));
  if (Array.isArray(p.errors) && p.errors.length) {
    console.log(`[INFO] 探针内部提示：${p.errors.join(', ')}`);
  }

  // —— 服务端侧证据：动作真的到了服务端 ——
  const after = await apiJson('/api/save', { headers: auth });
  const cloudSave = (() => { try { return JSON.parse(after.data?.data ?? '{}'); } catch { return {}; } })();
  const hpAfter = cloudSave?.party?.[0]?.hp;
  check('服务端存档可读（结算后）', typeof hpAfter === 'number', JSON.stringify(after.data).slice(0, 160));

  // 战斗可能还没结束（血厚怪我方打不完），此时 current 仍存在；
  // 结束则 current 为 null 且存档 HP/金钱/图鉴已被服务端写过。
  const cur = await apiJson('/api/battle/current', { headers: auth });
  const stillRunning = !!cur.data?.battle;
  if (stillRunning) {
    check('战斗仍在服务端存活（GET /api/battle/current 可恢复）',
      typeof cur.data.battle.battleId === 'string', JSON.stringify(cur.data).slice(0, 160));
    check('服务端存活战斗带完整个体（前端重连后能直接渲染）',
      Array.isArray(cur.data.battle.party?.[0]?.moveIds), JSON.stringify(cur.data.battle.party?.[0] ?? null).slice(0, 200));
  } else {
    check('战斗已结束且服务端已回收（current 为空）', true);
    // 玩家出手后通常敌方会反击（HP 下降）或我方击杀（金钱上升）。
    // 但「撤退成功 / 我方全灭」这两种结束方式本来就不改 HP 与金钱（全灭是回满，
    // P3-2 起由服务端写档），历史上有极低概率撞到，导致误报。
    // 这里按「结算结果」豁免，而不是放宽成永远为真。
    const endText = String(p.finalText ?? '');
    const nonKillEnd = /撤离|撤退|失去战斗力/.test(endText);
    check('服务端已写档：我方 HP 或金钱有变化（非击杀结束豁免）',
      nonKillEnd || hpAfter < 120 || (cloudSave.money ?? 0) > 1200,
      JSON.stringify({ hp: hpAfter, money: cloudSave.money, nonKillEnd, endText: endText.slice(0, 220) }));
  }

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_P31C_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_P31C_OK');
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
