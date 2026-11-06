/**
 * 服务端 GameSession 在线权威态（P2-2）。
 *
 * 定位：P2-1 只有通道、没有状态；P3 才把战斗模拟整体搬上服务端。
 * 本层按 (userId, slot) 维护「服务端认可的那份存档」：
 *   - 内存态：在线期间以内存为准，避免每次读写都回 DB，且能立刻广播给同账号其它连接；
 *   - DB 持久化：仍落到既有的 Save 表（data + authority），不新增 Prisma 迁移，
 *     重启 / 新连接时从 DB hydrate，语义与 P1-2 的权威摘要完全兼容；
 *   - revision：复用 authority.revision，任何一次服务端写入都单调递增，
 *     客户端据此判断快照新旧，旧快照一律忽略；
 *   - 上行不写状态：客户端只能通过 REST 的意图裁决 / 整包 PUT 请求变更，
 *     WS 上行只有控制消息（ping / session.resync），伪造 session.state 会被协议层拒绝。
 *
 * 纯逻辑 + 零依赖（不连库、不碰 WebSocket），便于 node:test 单测。
 */
import type { AuthorityState } from './authority';

/** 最后一个连接断开后，会话在内存里保留多久（重连可直接命中，不必回 DB）。 */
export const SESSION_TTL_MS = 10 * 60 * 1000;
export const SESSION_SLOTS = [1, 2, 3] as const;

export type SessionSource = 'hydrate' | 'put' | 'intent';

export type GameSessionState = {
  userId: string;
  slot: number;
  /** 服务端认可的存档 JSON 文本。 */
  data: string;
  schemaVersion: string;
  clientId: string | null;
  /** P1-2 权威摘要；revision 同时是本会话的状态版本号。 */
  authority: AuthorityState;
  /** 毫秒时间戳。 */
  updatedAt: number;
  lastActiveAt: number;
  connections: Set<string>;
  source: SessionSource;
};

/** 下行快照（session.state 消息体）。下行不受上行 4KB maxPayload 限制。 */
export type SessionSnapshot = {
  type: 'session.state';
  slot: number;
  revision: number;
  data: string;
  updatedAt: number;
  schemaVersion: string;
  source: SessionSource;
  /** 该会话当前登记的在线连接数。 */
  online: number;
};

export type SessionRecord = {
  data: string;
  schemaVersion: string;
  clientId: string | null;
  authority: AuthorityState;
  updatedAt: number;
};

export type SessionStats = {
  users: number;
  slots: number;
  online: number;
  connections: number;
};

export function sessionKey(userId: string, slot: number): string {
  return `${userId}:${slot}`;
}

/** 构造下发给客户端的全量快照。 */
export function buildSnapshot(s: GameSessionState): SessionSnapshot {
  return {
    type: 'session.state',
    slot: s.slot,
    revision: s.authority.revision,
    data: s.data,
    updatedAt: s.updatedAt,
    schemaVersion: s.schemaVersion,
    source: s.source,
    online: s.connections.size,
  };
}

/**
 * 保证「每次服务端写入 revision 至少 +1」。
 * P1-2 的 advanceAuthority 会自己 +1；普通整包 PUT / 意图登记不会，
 * 这里统一补齐，避免出现「写入了但版本号没变」导致客户端忽略快照。
 */
export function monotonicAuthority(
  prev: AuthorityState | null | undefined,
  next: AuthorityState,
): AuthorityState {
  const floor = prev ? prev.revision + 1 : 1;
  return next.revision >= floor ? next : { ...next, revision: floor };
}

/** 无连接且超过 TTL 的会话可回收；有连接的会话永不回收。 */
export function isSessionExpired(s: GameSessionState, now: number, ttl = SESSION_TTL_MS): boolean {
  return s.connections.size === 0 && now - s.lastActiveAt > ttl;
}

export class GameSessionRegistry {
  private readonly byKey = new Map<string, GameSessionState>();

  get size(): number {
    return this.byKey.size;
  }

  get(userId: string, slot: number): GameSessionState | undefined {
    return this.byKey.get(sessionKey(userId, slot));
  }

  listForUser(userId: string): GameSessionState[] {
    const out: GameSessionState[] = [];
    for (const slot of SESSION_SLOTS) {
      const s = this.get(userId, slot);
      if (s && s.userId === userId) out.push(s);
    }
    return out;
  }

  /** 从 DB 记录恢复；内存已有会话时直接返回（在线期间内存即权威）。 */
  hydrate(
    userId: string,
    slot: number,
    record: SessionRecord | null,
    now = Date.now(),
  ): GameSessionState | null {
    const existing = this.get(userId, slot);
    if (existing) return existing;
    if (!record) return null;
    const state: GameSessionState = {
      userId,
      slot,
      data: record.data,
      schemaVersion: record.schemaVersion,
      clientId: record.clientId,
      authority: record.authority,
      updatedAt: record.updatedAt,
      lastActiveAt: now,
      connections: new Set<string>(),
      source: 'hydrate',
    };
    this.byKey.set(sessionKey(userId, slot), state);
    return state;
  }

  /**
   * 服务端写入的唯一入口（由 modules/session.ts 在 DB upsert 成功后调用）。
   * 不在这里连库，保证单测可以用假数据覆盖全部状态迁移。
   */
  apply(
    userId: string,
    slot: number,
    input: {
      data: string;
      schemaVersion: string;
      clientId: string | null;
      authority: AuthorityState;
      source: SessionSource;
      updatedAt?: number;
    },
    now = Date.now(),
  ): GameSessionState {
    const key = sessionKey(userId, slot);
    const prev = this.byKey.get(key);
    const authority = monotonicAuthority(prev?.authority, input.authority);
    const state: GameSessionState = {
      userId,
      slot,
      data: input.data,
      schemaVersion: input.schemaVersion,
      clientId: input.clientId,
      authority,
      updatedAt: input.updatedAt ?? now,
      lastActiveAt: now,
      connections: prev?.connections ?? new Set<string>(),
      source: input.source,
    };
    this.byKey.set(key, state);
    return state;
  }

  /** 连接登记到该用户所有已存在的会话。 */
  attach(userId: string, connectionId: string): void {
    for (const s of this.listForUser(userId)) s.connections.add(connectionId);
  }

  detach(connectionId: string): void {
    for (const s of this.byKey.values()) s.connections.delete(connectionId);
  }

  /** 回收空会话；返回清理数量。 */
  sweep(now: number, ttl = SESSION_TTL_MS): number {
    let n = 0;
    for (const [key, s] of this.byKey) {
      if (isSessionExpired(s, now, ttl)) {
        this.byKey.delete(key);
        n += 1;
      }
    }
    return n;
  }

  /** 封号 / 登出：立即清掉该用户的在线权威态。 */
  dropUser(userId: string): number {
    let n = 0;
    for (const [key, s] of this.byKey) {
      if (s.userId === userId) {
        this.byKey.delete(key);
        n += 1;
      }
    }
    return n;
  }

  stats(): SessionStats {
    const users = new Set<string>();
    const allConnections = new Set<string>();
    let online = 0;
    for (const s of this.byKey.values()) {
      users.add(s.userId);
      if (s.connections.size > 0) online += 1;
      // 一条连接会登记到该账号的多个槽位会话，统计在线连接数必须去重。
      for (const id of s.connections) allConnections.add(id);
    }
    return { users: users.size, slots: this.byKey.size, online, connections: allConnections.size };
  }

  clear(): void {
    this.byKey.clear();
  }
}
