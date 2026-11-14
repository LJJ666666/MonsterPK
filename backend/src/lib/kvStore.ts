/**
 * 带 TTL 的共享 KV 存储（W8.0 基础设施）。
 *
 * 为什么单独抽一层：W8 要迁三处「进程内 Map + 时间戳」到共享存储——
 * 馆主 CD（`gym:cd:<userId>:<locationId>`）、战斗态（`battle:<battleId>`）、
 * 会话版本戳（`sess:rev:<userId>`）。三者都是「一个字符串值 + 一个到期时间」，
 * 抽出统一原语后，Redis 实现只写一次，三处各自组合语义。
 *
 * 一致性边界：
 *  - `acquire()` 是唯一需要原子性的原语（「不存在才写入」），Redis 侧用 Lua 保证；
 *  - 其余读写都靠调用方已有的串行化（同账号 `withSlotLock` / Redis 租约锁）兜底，
 *    不为它们额外写脚本——多写脚本只会把语义散到 Lua 里，反而难维护。
 *
 * 与内存实现的行为等价性由 `tests/w8KvStore.test.ts` 逐断言覆盖。
 */

/** 一次「不存在才写入」的结果：成功时 current 是新值，失败时是已存在的旧值。 */
export type AcquireResult = { ok: boolean; current: string | null };

export interface KvStore {
  /** 诊断用：'memory' | 'redis'。 */
  readonly kind: string;

  get(key: string): Promise<string | null>;

  /** 写入并（可选）置 TTL；ttlMs <= 0 表示不过期。 */
  set(key: string, value: string, ttlMs?: number): Promise<void>;

  /** 原子「不存在才写入」。已存在时返回旧值且不覆盖。 */
  acquire(key: string, value: string, ttlMs?: number): Promise<AcquireResult>;

  /** 删除，返回删除条数（0 = 本来就不存在）。 */
  del(key: string): Promise<number>;

  /**
   * 按前缀列出**尚未过期**的 key。
   * 内存实现遍历本地 Map；Redis 实现用 SCAN（不用 KEYS，避免阻塞）。
   * 只用于 sweep / stats / 单测，不放在热路径上。
   */
  keys(prefix: string): Promise<string[]>;

  /** 剩余 TTL（毫秒）；无 TTL 或不存在返回 -1 / -2（对齐 Redis PTTL 语义）。 */
  pttl(key: string): Promise<number>;

  /** 仅单测：清空本实现管辖的 key。生产调用会清掉共享真值，禁止使用。 */
  clear(): Promise<void>;
}

/**
 * acquire 的原子脚本：存在即返回旧值，不存在才写入。
 *
 * 为什么不写成 `SET NX` + 失败后 `GET` 两条命令：两条命令之间键可能刚好过期，
 * 会返回「失败 + current=null」，调用方就没法算出剩余冷却时间。
 */
export const ACQUIRE_SCRIPT = `
local cur = redis.call('GET', KEYS[1])
if cur then return {0, cur} end
if tonumber(ARGV[2]) > 0 then
  redis.call('PSETEX', KEYS[1], ARGV[2], ARGV[1])
else
  redis.call('SET', KEYS[1], ARGV[1])
end
return {1, ARGV[1]}
`;
