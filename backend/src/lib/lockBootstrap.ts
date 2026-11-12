/**
 * W3 锁模式启动装配（P5-1 / F10 批次 B）。
 *
 * 单真值：`REDIS_URL` 未配置 → 保持 W0 的进程内锁，**仅允许单实例**（CI 与纯本地开发
 * 无 Redis 也能跑）；一旦配置就必须连上并 PING 成功，否则**启动直接失败**——绝不
 * 静默降级回进程内锁，那会让第二个实例以为自己有跨进程互斥而实际没有。
 *
 * 运行期 Redis 断连同样不降级：ioredis 停止重连、命令直接报错，写路径由 W2 的
 * DB 条件更新兜底，不会写脏（设计定稿 §3.2「DB 条件更新作最后兜底」）。
 */
import Redis from 'ioredis';
import { createIoredisLockBackend } from './redisLockBackend';
import { RedisLockProvider, LOCK_TTL_MS, LOCK_RENEW_INTERVAL_MS } from './redisLockProvider';
import { setLockProvider } from './slotLock';

export type LockMode = 'in-process' | 'redis';

let mode: LockMode = 'in-process';
let client: Redis | null = null;

/** 供 /api/health 与 E2E 诊断：确认当前实例真的跑在分布式锁上。 */
/** W4 复用同一个已 PING 通的 Redis 客户端做全局 sweep 选主，不另建连接。 */
export function getLockRedisClient(): Redis | null {
  return client;
}

export function getLockMode(): LockMode {
  return mode;
}

export function getLockDiagnostics() {
  return {
    mode: getLockMode(),
    ttlMs: LOCK_TTL_MS,
    renewMs: LOCK_RENEW_INTERVAL_MS,
  };
}

function redact(url: string): string {
  try {
    const u = new URL(url);
    if (u.password) u.password = '***';
    return u.toString();
  } catch {
    return url.replace(/\/\/[^@]*@/, '//***@');
  }
}

export async function initializeLockProvider(): Promise<LockMode> {
  const url = process.env.REDIS_URL?.trim();
  if (!url) {
    console.warn('[W3] REDIS_URL 未配置：保持进程内锁，仅允许单实例（禁止开第二实例）');
    return mode;
  }

  // lazyConnect + 显式 connect：连不上立刻抛，让启动失败而不是带病监听端口。
  const next = new Redis(url, {
    lazyConnect: true,
    maxRetriesPerRequest: 1,
    retryStrategy: () => null,
    enableOfflineQueue: false,
  });
  next.on('error', (e) => console.error(`[W3] Redis 连接错误：${String(e?.message ?? e)}`));
  try {
    await next.connect();
    await next.ping();
  } catch (e) {
    next.disconnect();
    throw new Error(`[W3] REDIS_URL 已配置但不可达，拒绝以进程内锁降级启动：${String(e?.message ?? e)}`);
  }

  client = next;
  setLockProvider(new RedisLockProvider(createIoredisLockBackend(next)));
  mode = 'redis';
  console.info(
    `[W3] Redis 租约锁已启用 url=${redact(url)} ttl=${LOCK_TTL_MS}ms watchdog=${LOCK_RENEW_INTERVAL_MS}ms`,
  );
  return mode;
}

export async function shutdownLockProvider(): Promise<void> {
  if (!client) return;
  try {
    await client.quit();
  } catch {
    client.disconnect();
  }
  client = null;
  mode = 'in-process';
}
