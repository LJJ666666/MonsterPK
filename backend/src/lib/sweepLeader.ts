/**
 * W4 定时器选主 + 幂等（P5-1 / F10 批次 B，设计定稿 §3.4）。
 *
 * 解决什么：W0 把 30s 心跳拆成「本地段 / 全局段 / 封号段」，但全局段仍由
 * **每个进程各跑一份**。多实例时 sweepSessions / battles.sweepExpired /
 * wilds.sweep / sweepRooms 会重复推进内存状态、重复释放 quota、重复广播。
 *
 * 四件套：
 *  1) leader 租约 `lock:sweep:global`（SET NX PX，TTL ≈ 2×心跳），只有 leader 跑全局 sweep；
 *  2) fencing：`sweep:fence` 每次新 leader 上任 INCR，旧 leader 的 guard() 全拒；
 *  3) 幂等键 `idem:*`（SET NX PX + token 安全释放），覆盖 sweep bucket / quota.release /
 *     wild 广播 / 房间 tick / 结算标记；
 *  4) re-check / 续租：心跳每次 renew + isCurrent；共享态提交前再 guard 一次；
 *     提交成功才 publish。
 *
 * 边界（如实记录，别当已完成）：
 *  - W6 才把 RoomStorage 换 PG 行版本 CAS，W7 才把野怪池全量搬 Redis。
 *    本阶段的 `idem:room:<roomId>:<rev>` 是**短期 claim + 用完释放**的互斥门，
 *    不是持久 CAS；它防的是「同一 revision 被两个实例同时推进」。
 *  - 250ms 房间定时器用本地 leader 缓存（不每 250ms 打一次 Redis），
 *    跨实例最终裁决由 room 幂等键 + W3 的 `withRoomLock` 共同给出。
 */
import { randomUUID } from 'node:crypto';
import type Redis from 'ioredis';

/** leader 租约键；与 W3 业务锁命名空间 `lock:*` 同前缀、语义独立。 */
export const SWEEP_LEASE_KEY = 'lock:sweep:global';
/** fencing 计数器：每次 acquire 成功才 +1，保证新 leader 的 fence 严格大于旧 leader。 */
export const SWEEP_FENCE_KEY = 'sweep:fence';
export const SWEEP_IDEM_PREFIX = 'idem:';
/** 默认租约：2×30s 心跳；可用 SWEEP_LEASE_TTL_MS 覆盖（E2E 用短 TTL 验接管）。 */
export const DEFAULT_SWEEP_LEASE_TTL_MS = 60_000;
/** 幂等键默认 TTL：覆盖一个心跳 bucket 与一次房间回合，5 分钟足够且不会永久堆积。 */
export const DEFAULT_IDEM_TTL_MS = 5 * 60_000;

export type SweepLease = {
  instanceId: string;
  token: string;
  fence: number;
};

/** 与 W0 锁抽象同风格：接口化后 prod 用 Redis、CI 单测用确定性内存实现。 */
export interface SweepLeaseStore {
  /** 抢到返回带 fence 的租约；已被别人持有返回 null。 */
  acquire(instanceId: string, token: string, ttlMs: number): Promise<SweepLease | null>;
  /** token 匹配才续租；锁已易主返回 false。 */
  renew(lease: SweepLease, ttlMs: number): Promise<boolean>;
  /** token 匹配才释放；迟到释放不得抹掉新 leader。 */
  release(lease: SweepLease): Promise<boolean>;
  /** token 与 fence 都仍是当前值才算有效 leader（过期 leader 写共享态全拒）。 */
  isCurrent(lease: SweepLease): Promise<boolean>;
  /** 幂等键 / 短期互斥键：SET NX PX，成功 true。 */
  claim(key: string, token: string, ttlMs: number): Promise<boolean>;
  /** token 匹配才删除，供「用完释放」的短期互斥键回滚。 */
  releaseClaim(key: string, token: string): Promise<boolean>;
}

/** Lua：SET NX PX 成功才 INCR fence，避免「抢锁失败的实例把 fence 顶上去」。 */
export const ACQUIRE_SCRIPT = `
local ok = redis.call('set', KEYS[1], ARGV[1], 'PX', ARGV[2], 'NX')
if ok then
  return redis.call('incr', KEYS[2])
end
return 0
`;

/** Lua：GET==token 才续租。 */
export const RENEW_LEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('pexpire', KEYS[1], ARGV[2])
else
  return 0
end
`;

/** Lua：GET==token 且 fence 未变，才承认仍是 leader。 */
export const IS_CURRENT_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] and redis.call('get', KEYS[2]) == ARGV[2] then
  return 1
end
return 0
`;

/** Lua：GET==token 才 DEL（幂等释放，不误删别人的键）。 */
export const TOKEN_RELEASE_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
else
  return 0
end
`;

/**
 * 生产实现：复用 W3 已 PING 通的 ioredis 客户端，不另建连接。
 * `keyPrefix` 只给 E2E 用：测试实例在独立命名空间选主，绝不抢常驻 :3001 的租约。
 */
export function createRedisSweepLeaseStore(client: Redis, keyPrefix = ''): SweepLeaseStore {
  const leaseKey = `${keyPrefix}${SWEEP_LEASE_KEY}`;
  const fenceKey = `${keyPrefix}${SWEEP_FENCE_KEY}`;
  const idemKey = (key: string) => `${keyPrefix}${SWEEP_IDEM_PREFIX}${key}`;
  return {
    async acquire(instanceId, token, ttlMs) {
      const fence = Number(
        await client.eval(ACQUIRE_SCRIPT, 2, leaseKey, fenceKey, token, String(ttlMs)),
      );
      if (!Number.isInteger(fence) || fence <= 0) return null;
      return { instanceId, token, fence };
    },
    async renew(lease, ttlMs) {
      const n = Number(await client.eval(RENEW_LEASE_SCRIPT, 1, leaseKey, lease.token, String(ttlMs)));
      return n === 1;
    },
    async release(lease) {
      const n = Number(await client.eval(TOKEN_RELEASE_SCRIPT, 1, leaseKey, lease.token));
      return n === 1;
    },
    async isCurrent(lease) {
      const n = Number(await client.eval(
        IS_CURRENT_SCRIPT, 2, leaseKey, fenceKey, lease.token, String(lease.fence),
      ));
      return n === 1;
    },
    async claim(key, token, ttlMs) {
      const res = await client.set(idemKey(key), token, 'PX', ttlMs, 'NX');
      return res === 'OK';
    },
    async releaseClaim(key, token) {
      const n = Number(await client.eval(TOKEN_RELEASE_SCRIPT, 1, idemKey(key), token));
      return n === 1;
    },
  };
}

/**
 * 单实例 / CI 用：与 Redis 语义逐条对齐（SET NX PX、token 比对、fence 单调）。
 * 注入 clock 让 TTL 过期在单测里完全确定性。
 */
export class InProcessSweepLeaseStore implements SweepLeaseStore {
  private readonly entries = new Map<string, { token: string; expiresAt: number }>();
  private fence = 0;

  constructor(private readonly now: () => number = Date.now) {}

  private live(key: string) {
    const e = this.entries.get(key);
    if (!e) return null;
    if (e.expiresAt <= this.now()) {
      this.entries.delete(key);
      return null;
    }
    return e;
  }

  async acquire(instanceId: string, token: string, ttlMs: number): Promise<SweepLease | null> {
    if (this.live(SWEEP_LEASE_KEY)) return null;
    this.entries.set(SWEEP_LEASE_KEY, { token, expiresAt: this.now() + ttlMs });
    this.fence += 1;
    return { instanceId, token, fence: this.fence };
  }

  async renew(lease: SweepLease, ttlMs: number): Promise<boolean> {
    const e = this.live(SWEEP_LEASE_KEY);
    if (!e || e.token !== lease.token) return false;
    e.expiresAt = this.now() + ttlMs;
    return true;
  }

  async release(lease: SweepLease): Promise<boolean> {
    const e = this.live(SWEEP_LEASE_KEY);
    if (!e || e.token !== lease.token) return false;
    this.entries.delete(SWEEP_LEASE_KEY);
    return true;
  }

  async isCurrent(lease: SweepLease): Promise<boolean> {
    const e = this.live(SWEEP_LEASE_KEY);
    return !!e && e.token === lease.token && this.fence === lease.fence;
  }

  async claim(key: string, token: string, ttlMs: number): Promise<boolean> {
    const k = `${SWEEP_IDEM_PREFIX}${key}`;
    if (this.live(k)) return false;
    this.entries.set(k, { token, expiresAt: this.now() + ttlMs });
    return true;
  }

  async releaseClaim(key: string, token: string): Promise<boolean> {
    const k = `${SWEEP_IDEM_PREFIX}${key}`;
    const e = this.live(k);
    if (!e || e.token !== token) return false;
    this.entries.delete(k);
    return true;
  }

  /** 仅单测诊断。 */
  peekFence(): number { return this.fence; }
}

/** 一次 sweep 内可使用的共享能力。所有写共享态的动作都必须先 guard()，再 claim()。 */
export interface SweepContext {
  readonly instanceId: string;
  readonly fence: number;
  /** 提交前 re-check：过期 leader 一律拒绝。 */
  guard(): Promise<boolean>;
  /** 成功返回 token（用于 releaseClaim 回滚），失败返回 null。 */
  claim(key: string, ttlMs?: number): Promise<string | null>;
  releaseClaim(key: string, token: string): Promise<void>;
}

/**
 * W4：一次「共享态提交」= guard（仍是 leader）→ claim（幂等键）→ 动作。
 * 只有两者都通过才执行；publish 一律写在 action 内部，保证「提交成功才发」。
 * 抽到本模块是为了让单测 / E2E 直接 import 产品实现，不复制语义。
 */
export async function guardedCommit(
  ctx: SweepContext,
  key: string,
  action: () => void,
): Promise<boolean> {
  if (!(await ctx.guard())) return false;
  const token = await ctx.claim(key);
  if (!token) return false;
  action();
  return true;
}

export interface SweepLeaderOptions {
  ttlMs?: number;
  idemTtlMs?: number;
  now?: () => number;
}

/**
 * 每个进程一个实例。心跳调 run()（抢/续租 + re-check），250ms 房间定时器
 * 调 lightContext()（本地缓存，不打 Redis；正确性由 room 幂等键兜底）。
 */
export class SweepLeader {
  private lease: SweepLease | null = null;
  private readonly ttlMs: number;
  private readonly idemTtlMs: number;
  private readonly now: () => number;

  constructor(
    private readonly store: SweepLeaseStore,
    private readonly instanceId: string,
    options: SweepLeaderOptions = {},
  ) {
    this.ttlMs = options.ttlMs ?? DEFAULT_SWEEP_LEASE_TTL_MS;
    this.idemTtlMs = options.idemTtlMs ?? DEFAULT_IDEM_TTL_MS;
    this.now = options.now ?? Date.now;
  }

  /** 只有当前 leader 执行 fn；不是 leader 返回 null，且不产生任何副作用。 */
  async run<T>(fn: (ctx: SweepContext) => Promise<T>): Promise<T | null> {
    let lease = this.lease;
    if (lease) {
      const stillCurrent = await this.store.isCurrent(lease);
      const renewed = stillCurrent && await this.store.renew(lease, this.ttlMs);
      if (!renewed) {
        this.lease = null;
        lease = null;
      }
    }
    if (!lease) {
      lease = await this.store.acquire(this.instanceId, `${this.instanceId}:${randomUUID()}`, this.ttlMs);
      if (!lease) {
        this.lease = null;
        return null;
      }
      this.lease = lease;
    }
    const ctx = this.contextFor(lease, true);
    // 抢到 / 续租后再 re-check 一次：租约在两次 await 之间易主也要拒绝本次 sweep。
    if (!(await ctx.guard())) return null;
    return fn(ctx);
  }

  /** 250ms 房间定时器用：不做 Redis 往返，lease 由心跳 run() 维护。 */
  lightContext(): SweepContext | null {
    return this.lease ? this.contextFor(this.lease, false) : null;
  }

  private contextFor(lease: SweepLease, full: boolean): SweepContext {
    return {
      instanceId: this.instanceId,
      fence: lease.fence,
      guard: async () => (full
        ? this.store.isCurrent(lease)
        : this.lease === lease),
      claim: async (key: string, ttlMs = this.idemTtlMs) => {
        const token = `${this.instanceId}:${lease.fence}:${randomUUID()}`;
        return (await this.store.claim(key, token, ttlMs)) ? token : null;
      },
      releaseClaim: async (key: string, token: string) => {
        await this.store.releaseClaim(key, token);
      },
    };
  }

  /** 仅测试 / 平滑关服：主动交出租约，让其它实例立刻接管。 */
  async shutdown(): Promise<void> {
    const lease = this.lease;
    this.lease = null;
    if (lease) await this.store.release(lease);
  }

  diagnostics() {
    return {
      mode: this.store instanceof InProcessSweepLeaseStore ? 'in-process' : 'redis',
      instanceId: this.instanceId,
      leader: this.lease !== null,
      fence: this.lease?.fence ?? 0,
      ttlMs: this.ttlMs,
      idemTtlMs: this.idemTtlMs,
    };
  }

  /** 仅诊断：让 health 能报「缓存认为自己是 leader 但共享态已易主」。 */
  async verifyCurrent(): Promise<boolean> {
    return this.lease ? this.store.isCurrent(this.lease) : false;
  }
}

// ───────────────────── 模块级单例与启动装配 ─────────────────────

let current: SweepLeader = new SweepLeader(
  new InProcessSweepLeaseStore(),
  `local-${process.pid}`,
);

export function getSweepLeader(): SweepLeader { return current; }

/** 仅单测注入；E2E 直接 new SweepLeader 模拟双进程，不污染全局单例。 */
export function setSweepLeader(next: SweepLeader): void { current = next; }

export function resetSweepLeaderForTest(): void {
  current = new SweepLeader(new InProcessSweepLeaseStore(), `local-${process.pid}`);
}

export function getSweepDiagnostics() {
  return getSweepLeader().diagnostics();
}

/** 租约 TTL：默认 2×心跳；env 覆盖仅供联调 / E2E 缩短接管窗口。 */
export function sweepLeaseTtlMs(heartbeatMs: number): number {
  const raw = Number(process.env.SWEEP_LEASE_TTL_MS);
  if (Number.isFinite(raw) && raw >= 2_000) return Math.min(raw, 300_000);
  return Math.min(Math.max(heartbeatMs * 2, 10_000), 240_000);
}

/**
 * 启动时装配：有 W3 的 Redis 客户端就用真跨进程租约；没有则保持进程内
 * （仅允许单实例，与 W3 `REDIS_URL` 未配置时同口径）。
 */
export async function initializeSweepLeader(
  client: Redis | null,
  heartbeatMs: number,
): Promise<SweepLeader> {
  if (!client) {
    console.warn('[W4] 无 Redis 客户端：选主保持进程内，仅允许单实例');
    return current;
  }
  const leader = new SweepLeader(
    createRedisSweepLeaseStore(client),
    `${process.pid}:${randomUUID().slice(0, 8)}`,
    { ttlMs: sweepLeaseTtlMs(heartbeatMs) },
  );
  setSweepLeader(leader);
  // 启动即抢一次租约：250ms 房间定时器依赖 lightContext() 非空，不能等第一个 30s 心跳。
  // 抢不到说明别的实例是 leader，本实例安静不跑全局 sweep，符合设计。
  await leader.run(async () => {});
  console.info(`[W4] Redis 全局 sweep 选主已启用 ttl=${leader.diagnostics().ttlMs}ms leader=${leader.diagnostics().leader}`);
  return leader;
}
