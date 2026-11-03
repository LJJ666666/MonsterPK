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

for (let run = 1; run <= 3; run++) {
  await send('Page.navigate', { url: URL });
  await new Promise((r) => setTimeout(r, 6000));
  const data = await evalJs(`(() => {
    const n = performance.getEntriesByType('navigation')[0];
    const res = performance.getEntriesByType('resource');
    const fcp = performance.getEntriesByName('first-contentful-paint')[0];
    const bytes = res.reduce((a, r) => a + (r.transferSize || 0), 0);
    const p = window.__perf || { lcp: 0, cls: 0, longtasks: [] };
    return JSON.stringify({
      ttfb: Math.round(n.responseStart),
      fcp: fcp ? Math.round(fcp.startTime) : null,
      lcp: Math.round(p.lcp),
      domInteractive: Math.round(n.domInteractive),
      domComplete: Math.round(n.domComplete),
      loadEnd: Math.round(n.loadEventEnd),
      cls: Number(p.cls.toFixed(4)),
      longTasks: p.longtasks.length,
      longTaskTotal: p.longtasks.reduce((a, t) => a + t.d, 0),
      longTaskMax: p.longtasks.reduce((a, t) => Math.max(a, t.d), 0),
      requests: res.length + 1,
      transferKB: Math.round(bytes / 1024),
      jsKB: Math.round(res.filter(r => r.name.endsWith('.js')).reduce((a, r) => a + (r.transferSize || 0), 0) / 1024),
    });
  })()`);
  const m = await send('Performance.getMetrics');
  const pick = (name) => m.result?.metrics?.find((x) => x.name === name)?.value;
  console.log(`run${run}:`, data);
  console.log(`   heapMB=${(pick('JSHeapUsedSize') / 1048576).toFixed(1)} layoutCount=${pick('LayoutCount')} recalcStyle=${pick('RecalcStyleCount')} nodes=${pick('Nodes')}`);
}

const t0 = Date.now();
const clickRes = await evalJs(`(() => {
  const btn = [...document.querySelectorAll('button')].find(b => b.textContent.includes('继续游戏'));
  if (!btn) return 'no-button';
  btn.click();
  return 'clicked';
})()`);
await new Promise((r) => setTimeout(r, 1200));
console.log('interaction:', clickRes, '| url:', await evalJs('location.pathname'), '| uiSwitchMs:', Date.now() - t0);
const campState = await evalJs(`JSON.stringify({ready:document.readyState, chars:document.body.innerText.length, hasDex:document.body.innerText.includes('图鉴')})`);
console.log('camp:', campState);

ws.close();
process.exit(0);
