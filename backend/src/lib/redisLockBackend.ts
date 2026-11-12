/**
 * W3 分布式锁的存储后端（P5-1 / F10 批次 B）。
 *
 * 只做三件原子操作，全部带 token 比对，避免「迟到释放删掉同名新租约」：
 *  - acquire: `SET key token NX PX ttl`（Redis 单命令原子，跨进程互斥）
 *  - renew  : Lua「GET==token 才 PEXPIRE」（watchdog 续租，不续别人的锁）
 *  - release: Lua「GET==token 才 DEL」（幂等释放，不误删）
 *
 * 抽成接口是为了让确定性单测（CI 无 Redis）注入内存实现，用 barrier 强制
 * 两个任务在 acquire 处交汇，证明「去掉锁必失败」；真 Redis 语义由 E2E 覆盖。
 */
import type Redis from 'ioredis';

export interface RedisLockBackend {
  /** 成功抢到锁返回 true；key 已存在返回 false。 */
  acquire(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** 仍持有锁且续租成功返回 true；锁已易主/过期返回 false。 */
  renew(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** 成功删除自己那把锁返回 true；锁已被别人持有或已过期返回 false。 */
  release(key: string, token: string): Promise<boolean>;
}

/** Lua：只有 token 匹配才续租。返回 1/0。 */
export const RENEW_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;

/** Lua：只有 token 匹配才删除，防止迟到释放抹掉同名新租约。返回 1/0。 */
export const RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/** 生产实现：ioredis 客户端（由 lockBootstrap 在启动时建连并 PING 验证）。 */
export function createIoredisLockBackend(client: Redis): RedisLockBackend {
  return {
    async acquire(key, token, ttlMs) {
      const res = await client.set(key, token, 'PX', ttlMs, 'NX');
      return res === 'OK';
    },
    async renew(key, token, ttlMs) {
      const res = await client.eval(RENEW_SCRIPT, 1, key, token, String(ttlMs));
      return Number(res) === 1;
    },
    async release(key, token) {
      const res = await client.eval(RELEASE_SCRIPT, 1, key, token);
      return Number(res) === 1;
    },
  };
}
