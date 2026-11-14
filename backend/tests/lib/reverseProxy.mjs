/**
 * W9 反向代理（设计定稿 §5.2.3）：HTTP 轮询 + WebSocket Upgrade 透传 + Origin 白名单。
 *
 * 目的：把两个后端实例（:3101 / :3102）收拢到一个端点（:3109）后面，模拟生产环境
 * 的负载均衡 / TLS 终结层。客户端只连反代，由反代把流量分发到存活实例。
 *
 * 为什么必须自己写：
 *  - 真 Redis 让两个实例共享全部真值（存档 / 战斗 / 野怪 / 房间 / 广播 / 锁），所以
 *    任意实例都能服务任意请求 —— 这正是「横向扩展」成立的硬前提；
 *  - 但 WS Upgrade 不能走普通 HTTP 代理转发，必须手工把升级握手原样转给后端并双向 pipe；
 *  - Origin 白名单镜像 wsProtocol.isOriginAllowed，防 CSWSH（浏览器之外的客户端不带
 *    Origin 一律放行，与后端一致）。
 *
 * 用法：
 *  const px = startReverseProxy({ listenPort: 3109, targets: ['http://127.0.0.1:3101','http://127.0.0.1:3102'] });
 *  ... 跑测试 ...
 *  px.close();
 */
import http from 'node:http';
import net from 'node:net';
import { URL } from 'node:url';

/**
 * Origin 白名单（与后端 wsProtocol.isOriginAllowed 同口径）。
 * allowedCsv 为空 → 放行（与后端默认行为一致）。
 * @param {string|undefined} origin
 * @param {string|undefined} allowedCsv
 */
export function isOriginAllowed(origin, allowedCsv) {
  if (!origin) return true;
  const allowed = (allowedCsv ?? '').split(',').map((s) => s.trim()).filter((s) => s.length > 0);
  if (allowed.length === 0) return true;
  return allowed.includes(origin);
}

/**
 * 启动反代。
 * @param {{listenPort:number, targets:string[], originWhitelistCsv?:string, probeIntervalMs?:number}} opts
 * @returns {{server:http.Server, close:()=>void, liveCount:()=>number}}
 */
export function startReverseProxy({ listenPort, targets, originWhitelistCsv, probeIntervalMs = 1000 }) {
  /** 当前存活的后端（health 探活维护）。 */
  const live = new Set(targets);
  let rr = 0;

  const pick = () => {
    const alive = targets.filter((t) => live.has(t));
    if (alive.length === 0) return null;
    const chosen = alive[rr % alive.length];
    rr += 1;
    return chosen;
  };

  const probe = () => {
    for (const t of targets) {
      fetch(`${t}/api/health`, { signal: AbortSignal.timeout(800) })
        .then((r) => { if (r.ok) live.add(t); else live.delete(t); })
        .catch(() => live.delete(t));
    }
  };
  probe();
  const timer = setInterval(probe, probeIntervalMs);

  const server = http.createServer((req, res) => {
    const target = pick();
    if (!target) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'no_backend' }));
      return;
    }
    const u = new URL(req.url, target);
    const proxyReq = http.request(
      u,
      { method: req.method, headers: { ...req.headers, host: u.host } },
      (proxyRes) => {
        res.writeHead(proxyRes.statusCode ?? 502, proxyRes.headers);
        proxyRes.pipe(res);
      },
    );
    proxyReq.on('error', () => {
      if (!res.headersSent) res.writeHead(502, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'bad_gateway' }));
    });
    req.pipe(proxyReq);
  });

  server.on('upgrade', (req, clientSocket, head) => {
    // Origin 白名单（防 CSWSH）：浏览器 WS 必带 Origin；脚本不带则放行。
    if (!isOriginAllowed(req.headers.origin, originWhitelistCsv)) {
      clientSocket.write(
        'HTTP/1.1 403 Forbidden\r\nContent-Type: application/json\r\nConnection: close\r\n\r\n'
        + JSON.stringify({ error: 'origin_not_allowed' }),
      );
      clientSocket.destroy();
      return;
    }
    const target = pick();
    if (!target) {
      clientSocket.write('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    const u = new URL(req.url, target);
    const port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
    const upstream = net.connect(port, u.hostname, () => {
      const lines = [`${req.method} ${u.pathname}${u.search} HTTP/1.1`, `Host: ${u.host}`];
      for (const [k, v] of Object.entries(req.headers)) {
        if (k.toLowerCase() === 'host') continue; // 上面已显式写
        if (Array.isArray(v)) v.forEach((vv) => lines.push(`${k}: ${vv}`));
        else lines.push(`${k}: ${v}`);
      }
      lines.push('', '');
      upstream.write(lines.join('\r\n'));
      if (head && head.length) upstream.write(head);
    });

    // 双向透传：把后端的原始字节（含 101 握手响应）原样回流到客户端。
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);

    const kill = () => { try { upstream.destroy(); } catch { /* noop */ } try { clientSocket.destroy(); } catch { /* noop */ } };
    upstream.on('error', kill);
    clientSocket.on('error', kill);
    upstream.on('close', () => { try { clientSocket.destroy(); } catch { /* noop */ } });
    clientSocket.on('close', () => { try { upstream.destroy(); } catch { /* noop */ } });
  });

  server.listen(listenPort);

  return {
    server,
    close: () => { clearInterval(timer); server.close(); },
    liveCount: () => targets.filter((t) => live.has(t)).length,
    isLive: (target) => live.has(target),
  };
}
