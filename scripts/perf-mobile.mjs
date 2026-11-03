const URL = 'http://127.0.0.1:4173/';
const list = await (await fetch('http://127.0.0.1:9222/json/list')).json();
const page = list.find((t) => t.type === 'page');
const ws = new WebSocket(page.webSocketDebuggerUrl);
let id = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  const m = JSON.parse(ev.data);
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
const send = (method, params = {}) => new Promise((r) => { const i = ++id; pending.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
await new Promise((r) => ws.addEventListener('open', r));

await send('Page.enable');
await send('Runtime.enable');
await send('Performance.enable');
await send('Network.enable');
await send('Network.setCacheDisabled', { cacheDisabled: true });
await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 3, mobile: true });
// 模拟中低端手机：CPU 4x 降速 + 近似 Fast 3G
await send('Emulation.setCPUThrottlingRate', { rate: 4 });
await send('Network.emulateNetworkConditions', {
  offline: false, latency: 150, downloadThroughput: 1.6 * 1024 * 1024 / 8, uploadThroughput: 750 * 1024 / 8,
});

await send('Page.addScriptToEvaluateOnNewDocument', {
  source: `
    window.__perf = { lcp: 0, cls: 0, longtasks: [] };
    try {
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.lcp = Math.max(window.__perf.lcp, e.startTime); })
        .observe({ type: 'largest-contentful-paint', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) if (!e.hadRecentInput) window.__perf.cls += e.value; })
        .observe({ type: 'layout-shift', buffered: true });
      new PerformanceObserver((l) => { for (const e of l.getEntries()) window.__perf.longtasks.push({ s: Math.round(e.startTime), d: Math.round(e.duration) }); })
        .observe({ type: 'longtask', buffered: true });
    } catch (e) {}
  `,
});

const evalJs = async (expression) => {
  const r = await send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
  return r.result?.result?.value;
};

for (let run = 1; run <= 2; run++) {
  await send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 12000));
  console.log('run' + run, await evalJs(`(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const p = window.__perf;
    return JSON.stringify({
      ttfb: Math.round(n.responseStart), fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: Math.round(p.lcp), domInteractive: Math.round(n.domInteractive),
      domComplete: Math.round(n.domComplete), loadEnd: Math.round(n.loadEventEnd),
      cls: +p.cls.toFixed(4), longTasks: p.longtasks.length,
      longTaskTotal: p.longtasks.reduce((a, t) => a + t.d, 0),
      longTaskMax: p.longtasks.reduce((a, t) => Math.max(a, t.d), 0),
      transferKB: Math.round(res.reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
    });
  })()`));
}

// 交互：进入营地 + 打开图鉴（同样在 4x 降速下）
const enter = await evalJs(`new Promise((resolve) => {
  const t0 = performance.now();
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('继续游戏'));
  if (!btn) return resolve('no-button');
  btn.click();
  const tick = () => {
    if (location.pathname === '/camp') { requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)))); return; }
    if (performance.now() - t0 > 8000) return resolve('timeout');
    setTimeout(tick, 8);
  };
  setTimeout(tick, 8);
})`);
const dex = await evalJs(`new Promise((resolve) => {
  const t0 = performance.now();
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('图鉴'));
  if (!btn) return resolve('no-dex-button');
  btn.click();
  const tick = () => {
    const t = document.body.innerText;
    if (t.includes('???') || (t.includes('/') && t.includes('化'))) { requestAnimationFrame(() => requestAnimationFrame(() => resolve(Math.round(performance.now() - t0)))); return; }
    if (performance.now() - t0 > 8000) return resolve('timeout');
    setTimeout(tick, 8);
  };
  setTimeout(tick, 8);
})`);
console.log('throttled enterCampMs=', enter, 'openDexMs=', dex);

await send('Emulation.setCPUThrottlingRate', { rate: 1 });
await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
ws.close();
process.exit(0);
