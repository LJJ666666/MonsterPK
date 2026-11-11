/**
 * 回归 C：全局状态提示与弹窗 UX 冒烟（375px headless Edge，2026-11-11）。
 *
 * 既有 14 个 UI 冒烟都验证「某功能弹窗能开、375px 不溢出」，但没有一组覆盖：
 *   - Start 页的云同步态 / 实时通道态 / 在线权威态三种状态文案与长文案换行；
 *   - 全局封号弹窗、顶号弹窗（App.tsx 里挂在 Routes 之外，需派发事件才能复现）；
 *   - 弹窗「可滚动 + 可关闭」这条 UX 契约。
 * 本套件补这三块，不重复各功能弹窗的内容断言。
 *
 * 范式与 ui_smoke_f18a/b/c 一致：seed HTML 注入 localStorage，probe HTML 用 iframe
 * + 固定延时时间线驱动 SPA，结果写进 body[data-probe] 由 --dump-dom 回传。
 *
 * 运行：node scripts/ui_smoke_ux.mjs（需要 5173 + 3001 同时在线）
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
const SEED = path.join(PUBLIC, '_ux_seed.html');
const PROBE_START = path.join(PUBLIC, '_ux_start.html');
const PROBE_CAMP = path.join(PUBLIC, '_ux_camp.html');
const PROFILE = path.join(os.tmpdir(), `mpk_ux_${RUN}`);

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}
const brief = (x) => JSON.stringify({
  step: x?.step, errors: x?.errors, txt: x?.finalTxt?.slice(0, 260),
});

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
  collection: {}, clearedAreas: {},
  lastSavedAt: new Date(Date.now() - 60_000).toISOString(),
};

const LONG_REASON = '检测到异常游戏数据：存档中的金钱、等级、徽章与成就和服务端权威摘要不一致，'
  + '并且多次尝试重新同步仍然失败；账号已被停止服务并退出登录，请先联系管理员核查后再重新登录。';

/** 两个探针共用的内联 helper（绝不写含斜杠的正则，避免模板字面量转义坑）。 */
const HELPERS = `
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
var done = {};
window.onerror = function (msg) { out.errors.push('error:' + msg); finish(); };
function finish() {
  out.finalTxt = txt().slice(0, 900);
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function win() { try { return f.contentWindow; } catch (e) { return null; } }
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function byText(x) {
  return buttons().filter(function (b) { return b.textContent.trim() === x; })[0];
}
function overflow() {
  var d = doc();
  return d ? Math.max(d.documentElement.scrollWidth, d.body.scrollWidth) : -1;
}
function noOverflow() {
  var d = doc(); if (!d) return false;
  var els = d.querySelectorAll('.break-words, .overflow-auto, .overflow-y-auto, [role="alertdialog"] p');
  var bad = 0;
  for (var i = 0; i < els.length; i++) {
    if (els[i].scrollWidth > els[i].clientWidth + 1) bad++;
  }
  return bad === 0;
}
function scrollableCount() {
  var d = doc(); if (!d) return 0;
  var els = d.querySelectorAll('.overflow-auto, .overflow-y-auto');
  var n = 0;
  for (var i = 0; i < els.length; i++) {
    var st = d.defaultView.getComputedStyle(els[i]);
    if (st.overflowY === 'auto' || st.overflowY === 'scroll') n++;
  }
  return n;
}
function once(label, fn) {
  return function () { if (done[label]) return; done[label] = true; fn(); };
}
function waitFor(label, cond, next, tries) {
  if (done[label]) return;
  tries = tries || 0;
  if (cond()) return next();
  if (tries > 200) { out.errors.push('timeout:' + label); return finish(); }
  var d = doc();
  if (d) {
    var ob = new (win().MutationObserver)(function () {
      if (cond()) { ob.disconnect(); next(); }
    });
    try { ob.observe(d.body, { subtree: true, childList: true, characterData: true }); } catch (e) {}
    setTimeout(function () { ob.disconnect(); waitFor(label, cond, next, tries + 1); }, 50);
  } else {
    setTimeout(function () { waitFor(label, cond, next, tries + 1); }, 50);
  }
}
function fire(name, detail) {
  var w = win(); if (!w) return false;
  w.dispatchEvent(new w.CustomEvent(name, { detail: detail }));
  return true;
}
`;

function startProbe() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/" style="width:375px;height:812px;border:0"></iframe>
<script>${HELPERS}
f.addEventListener('load', function () {
  out.loaded = true;
  waitFor('start', function () {
    return txt().indexOf('实时通道') >= 0 && txt().indexOf('在线权威态') >= 0;
  }, once('start', function () {
    var t = txt();
    out.step = 'start';
    out.hasSyncText = t.indexOf('同步') >= 0;
    out.hasWsText = t.indexOf('实时通道') >= 0;
    out.hasAuthorityText = t.indexOf('在线权威态') >= 0;
    out.hasJourneyText = t.indexOf('继续旅程') >= 0 || t.indexOf('开始新旅程') >= 0;
    out.scrollWidth = overflow();
    out.breakWords = (doc().querySelectorAll('.break-words') || []).length;
    out.longTextNoOverflow = noOverflow();
    finish();
  }));
});
</script></body></html>`;
}

function campProbe() {
  return `<!doctype html><html><head><meta charset="utf-8"></head><body data-probe="PENDING">
<iframe id="app" src="/camp" style="width:375px;height:812px;border:0"></iframe>
<script>${HELPERS}
var LONG = ${JSON.stringify(LONG_REASON)};
function dismissStory(n) {
  if (n > 8) return;
  var b = byText('完成') || byText('继续');
  if (b) { b.click(); setTimeout(function () { dismissStory(n + 1); }, 90); }
}
f.addEventListener('load', function () {
  out.loaded = true;
  waitFor('camp', function () {
    return txt().indexOf('兽域手记') >= 0 && !!byText('徽章');
  }, once('camp', function () {
    out.step = 'camp';
    out.campLoaded = true;
    // intro beat 的 useEffect 比骨架渲染晚一拍，等 350ms 再观测，否则会误判「未出现」。
    setTimeout(function () {
      // ① 剧情弹窗：首帧 intro beat（全屏 z-50），长文案 + 推进按钮 + 不横向溢出
      out.storyModal = txt().indexOf('剧情') >= 0;
      out.storyAdvanceBtn = !!(byText('完成') || byText('继续'));
      out.storyScrollWidth = overflow();
      out.storyNoOverflow = noOverflow();
      dismissStory(0);

      // ② 徽章弹窗：可打开 / 可滚动 / 可关闭
      setTimeout(function () {
        var badgeBtn = byText('徽章');
      if (!badgeBtn) { out.errors.push('no badge button'); }
      else badgeBtn.click();
      setTimeout(function () {
        out.badgeOpened = !!byText('关闭');
        out.badgeScrollable = scrollableCount() > 0;
        out.badgeScrollWidth = overflow();
        out.badgeNoOverflow = noOverflow();
        var closeBtn = byText('关闭');
        if (closeBtn) closeBtn.click();
        setTimeout(function () {
          out.badgeClosed = !byText('关闭');

          // ③ 全局封号弹窗（App.tsx 的 BanGate，Routes 之外）
          out.banFired = fire('mpk:banned', { reason: LONG });
          setTimeout(function () {
            var t = txt();
            out.banTitle = t.indexOf('你已被封号') >= 0;
            out.banExplain = t.indexOf('账号已被停止服务并退出登录') >= 0;
            out.banLongReason = t.indexOf('请先联系管理员核查') >= 0;
            out.banBtn = !!byText('确定并退出登录');
            out.banDialogs = doc().querySelectorAll('[role="alertdialog"]').length;
            out.banScrollWidth = overflow();
            out.banNoOverflow = noOverflow();

            // ④ 全局顶号弹窗（SessionGate，z-[110] 压在封号弹窗之上）
            out.replacedFired = fire('mpk:session-replaced', { reason: '账号已在其他设备登录，本设备已下线' });
            setTimeout(function () {
              var t2 = txt();
              out.replacedTitle = t2.indexOf('账号已在其他设备登录') >= 0;
              out.replacedExplain = t2.indexOf('本设备尚未同步的改动不会被保存') >= 0;
              out.replacedBtn = !!byText('重新登录');
              out.replacedDialogs = doc().querySelectorAll('[role="alertdialog"]').length;
              out.replacedScrollWidth = overflow();
              out.replacedNoOverflow = noOverflow();

              // ⑤ 顶号弹窗可关闭：点「重新登录」清 token 并退回登录页
              var relog = byText('重新登录');
              if (relog) relog.click();
              setTimeout(function () {
                out.step = 'done';
                out.backToAuth = txt().indexOf('登录账号') >= 0 || txt().indexOf('创建账号') >= 0;
                finish();
              }, 350);
            }, 350);
          }, 350);
          }, 250);
        }, 450);
      }, 1200);
    }, 350);
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
  const username = `ux_${RUN}`;
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
  const seedDom = runEdge(`${BASE}/_ux_seed.html`);
  check('seed 注入登录态', seedDom.includes('SEEDED'), seedDom.slice(0, 120));

  // —— 探针 A：Start 页三种状态文案 + 长文案换行 ——
  fs.writeFileSync(PROBE_START, startProbe(), 'utf8');
  const domA = runEdge(`${BASE}/_ux_start.html?t=${Date.now()}`);
  const a = parseProbe(domA);
  check('探针 A 回传（Start 页渲染完成）', !!a && a.step === 'start', brief(a) ?? domA.slice(0, 200));
  if (!a) return report();
  check('Start 页显示云同步状态文案', a.hasSyncText === true, brief(a));
  check('Start 页显示实时通道状态文案', a.hasWsText === true, brief(a));
  check('Start 页显示在线权威态文案（P2-2 rev 快照）', a.hasAuthorityText === true, brief(a));
  check('Start 页主操作按钮可见（有存档 → 继续旅程）', a.hasJourneyText === true, brief(a));
  check('Start 页 375px 无横向溢出',
    Number.isFinite(a.scrollWidth) && a.scrollWidth <= 375, `scrollWidth=${a.scrollWidth}`);
  check('Start 页长文案使用 break-words 且不横向溢出',
    a.breakWords > 0 && a.longTextNoOverflow === true,
    `breakWords=${a.breakWords} noOverflow=${a.longTextNoOverflow}`);

  // —— 探针 B：剧情 / 徽章弹窗 + 全局封号 / 顶号弹窗 ——
  fs.writeFileSync(PROBE_CAMP, campProbe(), 'utf8');
  const domB = runEdge(`${BASE}/_ux_camp.html?t=${Date.now()}`);
  const b = parseProbe(domB);
  check('探针 B 回传（全流程执行完成）', !!b && b.step === 'done', brief(b) ?? domB.slice(0, 200));
  if (!b) return report();
  check('营地页面加载完成', b.campLoaded === true, brief(b));
  check('到达 intro 剧情弹窗渲染', b.storyModal === true, brief(b));
  check('剧情弹窗有「继续 / 完成」推进按钮', b.storyAdvanceBtn === true, brief(b));
  check('剧情弹窗长文案换行且 375px 无溢出',
    b.storyNoOverflow === true && b.storyScrollWidth <= 375,
    `scrollWidth=${b.storyScrollWidth} noOverflow=${b.storyNoOverflow}`);
  check('徽章弹窗可打开（出现「关闭」按钮）', b.badgeOpened === true, brief(b));
  check('徽章弹窗有可滚动容器（overflow-auto）', b.badgeScrollable === true, brief(b));
  check('徽章弹窗 375px 无横向溢出且长文案换行',
    b.badgeNoOverflow === true && b.badgeScrollWidth <= 375,
    `scrollWidth=${b.badgeScrollWidth} noOverflow=${b.badgeNoOverflow}`);
  check('徽章弹窗点「关闭」后消失（可关闭）', b.badgeClosed === true, brief(b));

  check('封号事件可触发全局弹窗', b.banFired === true && b.banTitle === true, brief(b));
  check('封号弹窗含中文说明与「确定并退出登录」',
    b.banExplain === true && b.banBtn === true, brief(b));
  check('封号弹窗为 alertdialog 且带长原因不横向溢出',
    b.banDialogs >= 1 && b.banLongReason === true && b.banNoOverflow === true
      && b.banScrollWidth <= 375,
    `dialogs=${b.banDialogs} reason=${b.banLongReason} noOverflow=${b.banNoOverflow} scrollWidth=${b.banScrollWidth}`);
  check('顶号事件可触发全局弹窗（标题 + 说明）',
    b.replacedFired === true && b.replacedTitle === true && b.replacedExplain === true, brief(b));
  check('顶号弹窗含「重新登录」且双 alertdialog 共存',
    b.replacedBtn === true && b.replacedDialogs >= 2,
    `dialogs=${b.replacedDialogs} btn=${b.replacedBtn}`);
  check('顶号弹窗 375px 无横向溢出且长文案换行',
    b.replacedNoOverflow === true && b.replacedScrollWidth <= 375,
    `scrollWidth=${b.replacedScrollWidth} noOverflow=${b.replacedNoOverflow}`);
  check('点「重新登录」清登录态并退回登录页（可关闭）', b.backToAuth === true, brief(b));

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_UX_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_UX_OK');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
}).finally(() => {
  for (const f of [SEED, PROBE_START, PROBE_CAMP]) {
    try { fs.rmSync(f, { force: true }); } catch {}
  }
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
