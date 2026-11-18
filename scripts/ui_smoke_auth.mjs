#!/usr/bin/env node
/**
 * Auth 页一屏 / 报错态冒烟（360×616 headless Chromium，2026-11-15）。
 *
 * 背景：2026-11-15 真机修复过三个 UI 问题 —— 注册页普通态 687px 溢出 616px 一屏、
 * `.safe-top` 的 24px 兜底白占顶部、无档账号残留旧渲染副本。前两个当时只用真机 CDP
 * 取证，14 套既有冒烟都不覆盖 Auth 页，改版后没有自动回归。本套件把这几条契约固化：
 *   - 登录 / 注册共用一套排版（品牌描述两态都显示，注册多一个确认密码）；
 *   - 服务状态只在标题右侧展示红绿灯（带 aria-label），不再有底部状态栏与 API 行；
 *   - 切换时锚点对齐：header / tab / 表单顶部 / 服务红绿灯四处的 top 两态完全一致，
 *     不出现「切换就整块错位」（2026-11-17 修复：旧版注册态用紧凑排版导致 16~30px 跳动）；
 *   - 360×616 真机视口下两种形态都必须一屏、无横向溢出、顶部内边距为 0；
 *   - 三字段报错态（最容易把页面顶出屏幕）仍一屏、无横向溢出；
 *   - 切回登录清错误；忘记密码提示同样不破坏一屏。
 *
 * 范式与 ui_smoke_ux.mjs 一致：probe HTML 用 iframe + 固定延时时间线驱动 SPA，
 * 结果写进 body[data-probe] 由 --dump-dom 回传。与其余冒烟不同，这里**不注入登录态**
 * （head 里先清 mpk_token），因为要测的正是未登录的 /auth 页。
 *
 * 运行：node scripts/ui_smoke_auth.mjs（需要 5173 + 3001 同时在线）
 */
import { execFileSync as rawExecFileSync } from 'node:child_process';
import { resolveBrowser } from './lib/browser.mjs';
import { createRetriedExec } from './lib/edgeDom.mjs';

// headless Chromium --dump-dom 偶发返回错误页时有限重试（断言不变，见 lib/edgeDom.mjs）。
const execFileSync = createRetriedExec(rawExecFileSync);
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const EDGE = resolveBrowser();
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PUBLIC = path.join(ROOT, 'public');
import { FRONT_BASE as BASE } from './lib/devConfig.mjs';
const RUN = Date.now().toString(36).slice(-6);
const PROBE = path.join(PUBLIC, '_auth_probe.html');
const PROFILE = path.join(os.tmpdir(), `mpk_auth_${RUN}`);
// 真机（雷电 360dp / 1080×1920）的 CSS 视口；616 是当时实测的一屏高度。
const VIEW_W = 360;
const VIEW_H = 616;

const results = [];
function check(name, ok, detail = '') {
  results.push({ name, ok });
  console.log(`${ok ? '[PASS]' : '[FAIL]'} ${name} ${ok ? '' : detail}`);
}
const brief = (x) => JSON.stringify({
  step: x?.step, errors: x?.errors, txt: x?.finalTxt?.slice(0, 220),
});

/** 探针内联 helper（不写含斜杠的正则，避免模板字面量转义坑）。 */
const HELPERS = `
var f = document.getElementById('app');
var out = { step: 'init', errors: [] };
var done = {};
var finished = false;
window.onerror = function (msg) { out.errors.push('error:' + msg); finish(); };
function finish() {
  if (finished) return;
  finished = true;
  out.finalTxt = txt().slice(0, 900);
  document.body.setAttribute('data-probe', encodeURIComponent(JSON.stringify(out)));
}
function doc() { try { return f.contentDocument; } catch (e) { return null; } }
function win() { try { return f.contentWindow; } catch (e) { return null; } }
function txt() {
  try { return f.contentDocument.body.innerText || ''; } catch (e) { out.errors.push('read:' + e); return ''; }
}
function shell() { var d = doc(); return d ? d.querySelector('.page-shell') : null; }
function topOf(sel) {
  var d = doc(), el = d && d.querySelector(sel);
  if (!el) return null;
  return Math.round(el.getBoundingClientRect().top);
}
function metrics() {
  var d = doc(), s = shell();
  if (!d || !s) return null;
  var st = win().getComputedStyle(s);
  return {
    scrollWidth: Math.max(d.documentElement.scrollWidth, d.body.scrollWidth, s.scrollWidth),
    scrollHeight: s.scrollHeight,
    clientHeight: s.clientHeight,
    docScrollHeight: d.documentElement.scrollHeight,
    padTop: st.paddingTop,
    // 锚点：切换登录/注册时这四处的 top 必须完全一致，否则肉眼可见整块错位。
    topHeader: topOf('header'),
    topTabs: topOf('[role="tablist"]'),
    topForm: topOf('form'),
    // 服务状态已移到标题右侧红绿灯（原底部状态栏已删）。
    topStatus: topOf('[data-service-dot]')
  };
}
function buttons() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('button'));
}
function byText(x) {
  return buttons().filter(function (b) { return b.textContent.trim() === x; })[0];
}
function alerts() {
  var d = doc(); if (!d) return [];
  return [].slice.call(d.querySelectorAll('[role="alert"]'));
}
function hasInput(id) { var d = doc(); return !!(d && d.getElementById(id)); }
function setInput(id, val) {
  var d = doc(), w = win(), el = d && d.getElementById(id);
  if (!el || !w) return false;
  var setter = Object.getOwnPropertyDescriptor(w.HTMLInputElement.prototype, 'value').set;
  setter.call(el, val);
  el.dispatchEvent(new w.Event('input', { bubbles: true }));
  return true;
}
function submit() {
  var b = byText('创建账号并进入') || byText('登录并继续');
  if (!b) return false;
  b.click();
  return true;
}
function once(label, fn) {
  return function () { if (done[label]) return; done[label] = true; fn(); };
}
function waitFor(label, cond, next, tries) {
  if (done[label] || finished) return;
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
`;

function probeHtml() {
  return `<!doctype html><html><head><meta charset="utf-8"><script>
try { localStorage.removeItem('mpk_token'); localStorage.removeItem('mpk_last_username'); } catch (e) {}
</script></head><body data-probe="PENDING">
<iframe id="app" src="/auth" style="width:${VIEW_W}px;height:${VIEW_H}px;border:0"></iframe>
<script>${HELPERS}
f.addEventListener('load', function () {
  if (finished) return;
  out.loaded = true;

  // ① 登录态：普通排版、持续嗅探状态条、一屏无滚动
  waitFor('login', function () {
    return txt().indexOf('登录并继续') >= 0 && !!byText('注册');
  }, once('login', function () {
    var t = txt();
    out.step = 'login';
    out.loginTabs = (doc().querySelectorAll('[role="tab"]') || []).length;
    out.loginHasUsername = hasInput('auth-username');
    out.loginHasPassword = hasInput('auth-password');
    out.loginHasConfirm = hasInput('auth-confirm');
    out.loginBrand = t.indexOf('BEAST JOURNAL') >= 0;
    out.loginApiGone = t.indexOf('API ·') < 0;
    out.loginServiceDot = (function () {
      var el = doc().querySelector('[data-service-dot]');
      return el ? el.getAttribute('data-service-dot') : null;
    })();
    out.loginServiceLabel = (function () {
      var el = doc().querySelector('[data-service-dot]');
      return el ? el.getAttribute('aria-label') : null;
    })();
    out.login = metrics();

    // ①b 登录态字段报错态：空表单提交出 2 条错误，也不得把页面顶出屏幕
    out.loginSubmitted = submit();
    waitFor('loginErrors', function () { return alerts().length >= 2; }, once('loginErrors', function () {
      out.loginErrCount = alerts().length;
      out.loginErrors = metrics();

      // ② 切注册：紧凑排版 + 确认密码
      setTimeout(function () {
        var reg = byText('注册');
      if (reg) reg.click();
      waitFor('register', function () {
        return hasInput('auth-confirm') && txt().indexOf('创建你的冒险账号') >= 0;
      }, once('register', function () {
        var t2 = txt();
        out.step = 'register';
        out.regTabSelected = !!(doc().querySelector('[role="tab"][aria-selected="true"]'))
          && doc().querySelector('[role="tab"][aria-selected="true"]').textContent.trim() === '注册';
        out.regHasConfirm = hasInput('auth-confirm');
        out.regLabelHint = t2.indexOf('用户名 · 3–20 位') >= 0;
        out.regBrand = t2.indexOf('BEAST JOURNAL') >= 0;
        out.regApiGone = t2.indexOf('API ·') < 0;
        out.regAlerts = alerts().length;
        out.regDesc = t2.indexOf('野外考察手记') >= 0;
        out.register = metrics();

        // ③ 三字段报错态：username/password 留空，confirm 填不一致值，直接提交
        setTimeout(function () {
          out.setConfirm = setInput('auth-confirm', 'x');
          setTimeout(function () {
            out.submitted = submit();
            waitFor('errors', function () { return alerts().length >= 3; }, once('errors', function () {
              out.step = 'errors';
              out.errCount = alerts().length;
              out.errText = alerts().map(function (a) { return a.textContent.trim(); }).join('|');
              out.errors = metrics();

              // ④ 切回登录：错误清空 + 恢复普通态
              setTimeout(function () {
                var back = byText('登录');
                if (back) back.click();
                waitFor('back', function () {
                  return txt().indexOf('登录并继续') >= 0 && alerts().length === 0;
                }, once('back', function () {
                  var t3 = txt();
                  out.step = 'back';
                  out.backAlerts = alerts().length;
                  out.backHasConfirm = hasInput('auth-confirm');
                  out.backBrand = t3.indexOf('BEAST JOURNAL') >= 0;
                  out.back = metrics();

                  // ⑤ 忘记密码提示也不得把页面顶出屏幕
                  setTimeout(function () {
                    var forgot = byText('忘记密码？');
                    out.forgotFired = !!forgot;
                    if (forgot) forgot.click();
                    setTimeout(function () {
                      out.forgotHint = txt().indexOf('暂未开放自助找回密码') >= 0;
                      out.forgot = metrics();

                      // ⑥ 真实登录失败（服务端 401）→ formError 横幅，也不得顶出屏幕
                      setTimeout(function () {
                        out.failUser = setInput('auth-username', 'no_such_user_auth');
                        out.failPwd = setInput('auth-password', 'wrong-pass-123');
                        setTimeout(function () {
                          out.failSubmitted = submit();
                          waitFor('loginFail', function () {
                            return txt().indexOf('用户名或密码错误') >= 0;
                          }, once('loginFail', function () {
                            out.step = 'done';
                            out.failFormError = txt().indexOf('用户名或密码错误') >= 0;
                            out.failAlerts = alerts().length;
                            out.fail = metrics();
                            finish();
                          }));
                        }, 120);
                      }, 120);
                    }, 200);
                  }, 120);
                }));
              }, 150);
            }));
          }, 120);
        }, 150);
      }));
    }, 150);
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
  ], { encoding: 'utf8', timeout: 150_000, stdio: ['ignore', 'pipe', 'ignore'] });
}

function parseProbe(dom) {
  const m = dom.match(/data-probe="([^"]+)"/);
  if (!m || m[1] === 'PENDING') return null;
  try { return JSON.parse(decodeURIComponent(m[1])); } catch { return null; }
}

/** 一屏契约：横向不溢出 + 页面自身无纵向滚动 + 顶部无兜底内边距。 */
function oneScreen(m) {
  return !!m && Number.isFinite(m.scrollWidth) && m.scrollWidth <= VIEW_W
    && Number.isFinite(m.scrollHeight) && Number.isFinite(m.clientHeight)
    && m.scrollHeight <= m.clientHeight + 1
    && m.padTop === '0px';
}

async function main() {
  fs.writeFileSync(PROBE, probeHtml(), 'utf8');
  const dom = runEdge(`${BASE}/_auth_probe.html?t=${Date.now()}`);
  const a = parseProbe(dom);
  check('探针回传（Auth 全流程执行完成）', !!a && a.step === 'done', brief(a) ?? dom.slice(0, 200));
  if (!a) return report();
  check('全流程无 JS 异常 / 无等待超时', (a.errors?.length ?? 0) === 0, brief(a));

  // ① 登录态
  check('登录页渲染（登录/注册双 tab + 两个输入框）',
    a.loginTabs === 2 && a.loginHasUsername === true && a.loginHasPassword === true
    && a.loginHasConfirm === false, JSON.stringify(a.login));
  check('标题右侧显示服务红绿灯（checking/online/offline 三态之一 + 无障碍标签）',
    ['checking', 'online', 'offline'].indexOf(a.loginServiceDot) >= 0
      && (a.loginServiceLabel || '').indexOf('服务器状态') >= 0,
    `dot=${a.loginServiceDot} label=${a.loginServiceLabel}`);
  check('登录态显示品牌描述，且不再有 API 行',
    a.loginBrand === true && a.loginApiGone === true, brief(a));
  check('登录态 360px 无横向溢出',
    Number.isFinite(a.login?.scrollWidth) && a.login.scrollWidth <= VIEW_W,
    `scrollWidth=${a.login?.scrollWidth}`);
  check('登录态 360×616 一屏无纵向滚动', oneScreen(a.login), JSON.stringify(a.login));
  check('.safe-top 顶部内边距为 0（无 24px 兜底）', a.login?.padTop === '0px', `padTop=${a.login?.padTop}`);
  check('登录态空表单提交触发 2 条字段错误',
    a.loginSubmitted === true && a.loginErrCount >= 2, `count=${a.loginErrCount}`);
  check('登录态字段报错态仍 360×616 一屏且无横向溢出',
    oneScreen(a.loginErrors), JSON.stringify(a.loginErrors));

  // ② 注册态（与登录共用排版）
  check('点「注册」切换到注册态（tab 选中 + 确认密码出现）',
    a.regTabSelected === true && a.regHasConfirm === true, brief(a));
  check('注册态提示并进 label（用户名 · 3–20 位）', a.regLabelHint === true, brief(a));
  check('注册态与登录同款品牌区（品牌名/描述都在，无 API 行）',
    a.regBrand === true && a.regDesc === true && a.regApiGone === true, brief(a));
  check('切换清空旧字段错误', a.regAlerts === 0, `alerts=${a.regAlerts}`);
  // 2026-11-17：登录/注册排版统一后，切换时四个锚点的 top 必须完全一致，
  // 否则就是肉眼可见的「切 tab 整块错位」。旧版注册态用紧凑排版会在 tab/表单/状态栏跳动 16~30px。
  var al = a.login || {}, ar = a.register || {};
  check('切换登录/注册锚点对齐（品牌区/tab/表单顶部/服务红绿灯 top 一致）',
    al.topHeader === ar.topHeader && al.topTabs === ar.topTabs
      && al.topForm === ar.topForm && al.topStatus === ar.topStatus,
    `login=${JSON.stringify({ h: al.topHeader, t: al.topTabs, f: al.topForm, s: al.topStatus })}`
    + ` reg=${JSON.stringify({ h: ar.topHeader, t: ar.topTabs, f: ar.topForm, s: ar.topStatus })}`);
  check('注册态 360px 无横向溢出',
    Number.isFinite(a.register?.scrollWidth) && a.register.scrollWidth <= VIEW_W,
    `scrollWidth=${a.register?.scrollWidth}`);
  check('注册态 360×616 一屏无纵向滚动', oneScreen(a.register), JSON.stringify(a.register));

  // ③ 三字段报错态
  check('可用 React 受控输入注入不一致确认密码并提交',
    a.setConfirm === true && a.submitted === true, brief(a));
  check('空表单提交触发 3 条字段错误', a.errCount >= 3, `count=${a.errCount}`);
  check('三条错误文案正确（用户名 / 密码 / 两次不一致）',
    (a.errText || '').indexOf('请输入用户名') >= 0
    && (a.errText || '').indexOf('请输入密码') >= 0
    && (a.errText || '').indexOf('两次输入的密码不一致') >= 0,
    `errText=${a.errText}`);
  check('报错态仍 360×616 一屏且无横向溢出', oneScreen(a.errors), JSON.stringify(a.errors));

  // ④ 切回登录
  check('切回登录清空错误并移除确认密码',
    a.backAlerts === 0 && a.backHasConfirm === false, brief(a));
  check('切回登录品牌区仍在（两态同款）', a.backBrand === true, brief(a));
  check('切回登录 360×616 一屏且无横向溢出', oneScreen(a.back), JSON.stringify(a.back));
  check('切回登录后锚点仍与首次登录一致（来回切换不漂移）',
    a.back?.topHeader === al.topHeader && a.back?.topTabs === al.topTabs
      && a.back?.topForm === al.topForm && a.back?.topStatus === al.topStatus,
    `back=${JSON.stringify({ h: a.back?.topHeader, t: a.back?.topTabs, f: a.back?.topForm, s: a.back?.topStatus })}`);

  // ⑤ 忘记密码提示
  check('忘记密码提示可打开且文案正确',
    a.forgotFired === true && a.forgotHint === true, brief(a));
  check('忘记密码提示态仍一屏且无横向溢出', oneScreen(a.forgot), JSON.stringify(a.forgot));

  // ⑥ 服务端 401 登录失败横幅
  check('真实登录失败显示服务端错误横幅',
    a.failUser === true && a.failPwd === true && a.failSubmitted === true
    && a.failFormError === true && a.failAlerts >= 1,
    `formError=${a.failFormError} alerts=${a.failAlerts}`);
  check('登录失败横幅态仍 360×616 一屏且无横向溢出',
    oneScreen(a.fail), JSON.stringify(a.fail));

  report();
}

function report() {
  const fail = results.filter((r) => !r.ok).length;
  console.log(`\nUI_SMOKE_AUTH_RESULT pass=${results.length - fail} fail=${fail}`);
  if (fail > 0) process.exit(1);
  console.log('UI_SMOKE_AUTH_OK');
}

main().catch((e) => {
  console.error('[FATAL]', e);
  process.exit(1);
}).finally(() => {
  try { fs.rmSync(PROBE, { force: true }); } catch {}
  try { fs.rmSync(PROFILE, { recursive: true, force: true }); } catch {}
});
