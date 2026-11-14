/**
 * 服务端 GameSession 在线权威态（P2-2）。
 *
 * 定位：P2-1 只有通道、没有状态；P3 才把战斗模拟整体搬上服务端。
 * F17 起一账号一档：本层按 userId 维护「服务端认可的那份存档」：
 *   - 内存态：在线期间以内存为准，避免每次读写都回 DB，且能立刻广播给同账号其它连接；
 *   - DB 持久化：仍落到既有的 Save 表（data + authority），不新增 Prisma 迁移，
 *     重启 / 新连接时从 DB hydrate，语义与 P1-2 的权威摘要完全兼容；
 *   - revision：W2 起真值在 Save.revision 列；本层只保存 DB 下发的只读镜像，
 *     不自行递增，客户端据此判断快照新旧、旧快照一律忽略；
 *   - 上行不写状态：客户端只能通过 REST 的意图裁决 / 整包 PUT 请求变更，
 *     WS 上行只有控制消息（ping / session.resync），伪造 session.state 会被协议层拒绝。
 *
 * 纯逻辑 + 零依赖（不连库、不碰 WebSocket），便于 node:test 单测。
 */
import type { AuthorityState } from './authority';

/** 最后一个连接断开后，会话在内存里保留多久（重连可直接命中，不必回 DB）。 */
export const SESSION_TTL_MS = 10 * 60 * 1000;

/**
 * 状态写入来源。
 * `action` = P3-2 的服务端存档写操作（治疗 / 道具 / 进化 / 学招 / 队伍整理 / 移动），
 * 由 `modules/mutations.ts` 在服务端算完后写入，客户端只收快照。
 */
export type SessionSource = 'hydrate' | 'put' | 'intent' | 'battle' | 'action';

export type GameSessionState = {
  userId: string;
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
  /** 账号单档下的会话数（= 有会话的账号数）。 */
  slots: number;
  online: number;
  connections: number;
};

/** 账号单档：会话 key 就是 userId（历史名保留）。 */
export function sessionKey(userId: string): string {
  return userId;
}

/** 构造下发给客户端的全量快照。 */
export function buildSnapshot(s: GameSessionState): SessionSnapshot {
  return {
    type: 'session.state',
    revision: s.authority.revision,
    data: s.data,
    updatedAt: s.updatedAt,
    schemaVersion: s.schemaVersion,
    source: s.source,
    online: s.connections.size,
  };
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

  get(userId: string): GameSessionState | undefined {
    return this.byKey.get(sessionKey(userId));
  }

  /** 账号单档：一个账号至多一个会话；返回数组以兼容既有调用点。 */
  listForUser(userId: string): GameSessionState[] {
    const s = this.get(userId);
    return s ? [s] : [];
  }

  /**
   * 从 DB 记录恢复。
   *
   * W8.2：改造前是 `if (existing) return existing`——内存有会话就完全忽略刚读出来的 DB 行。
   * 单实例下没问题（内存总是最新），**多实例下这是「换实例读到旧档」的根因**：
   * A 实例提交了新档，B 实例内存还是旧副本，玩家重连到 B 时 B 把 DB 新数据丢掉、
   * 继续拿旧副本推给客户端。
   *
   * 现在按 `revision` 比较（DB 列的版本是真值）：
   *  - DB 不新于内存 → 保留内存（内存里的 `connections` 是进程本地真值，覆盖会丢在线登记）；
   *  - DB 更新 → **原地覆盖**内容字段，保留 `connections` 与在线时间。
   * 原地改而不是换对象：调用方可能已经持有 state 引用（`hydrateForUser` 之后立刻 `attach`）。
   */
  hydrate(
    userId: string,
    record: SessionRecord | null,
    now = Date.now(),
  ): GameSessionState | null {
    const existing = this.get(userId);
    if (existing) {
      // 没有 DB 记录（还没建号）或 DB 不比内存新：内存权威，直接返回。
      if (!record || existing.authority.revision >= record.authority.revision) return existing;
      existing.data = record.data;
      existing.schemaVersion = record.schemaVersion;
      existing.clientId = record.clientId;
      existing.authority = record.authority;
      existing.updatedAt = record.updatedAt;
      existing.lastActiveAt = now;
      existing.source = 'hydrate';
      return existing;
    }
    if (!record) return null;
    const state: GameSessionState = {
      userId,
      data: record.data,
      schemaVersion: record.schemaVersion,
      clientId: record.clientId,
      authority: record.authority,
      updatedAt: record.updatedAt,
      lastActiveAt: now,
      connections: new Set<string>(),
      source: 'hydrate',
    };
    this.byKey.set(sessionKey(userId), state);
    return state;
  }

  /**
   * 服务端写入的唯一入口（由 modules/session.ts 在 DB upsert 成功后调用）。
   * 不在这里连库，保证单测可以用假数据覆盖全部状态迁移。
   */
  apply(
    userId: string,
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
    const key = sessionKey(userId);
    const prev = this.byKey.get(key);
    // W2：revision 由 DB 条件更新裁决后写入，内存缓存不再自行 +1。
    const authority = input.authority;
    const state: GameSessionState = {
      userId,
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

  /** 连接登记到该账号的单档会话。 */
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
      // 账号单档：一条连接只登记到该账号的唯一会话，仍统一去重计数。
      for (const id of s.connections) allConnections.add(id);
    }
    return { users: users.size, slots: this.byKey.size, online, connections: allConnections.size };
  }

  clear(): void {
    this.byKey.clear();
  }
}
