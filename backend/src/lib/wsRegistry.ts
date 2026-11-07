/**
 * WebSocket 会话登记表（P2-1）。
 *
 * 按 userId 索引当前在线连接，供心跳扫描、连接数限制与后续 P2-2 的状态广播使用。
 * 刻意不 import ws 的具体类型，只依赖一个最小 socket 接口，这样单测可以注入假对象，
 * 不需要真的起服务器就能覆盖「连接上下线 / 超限 / 死连接清理 / 按用户广播」。
 */
import { WS_MAX_CONNECTIONS_PER_USER } from './wsProtocol';

/** socket 最小接口：只用到实时通道真正需要的方法。 */
export interface WsLike {
  readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  terminate(): void;
  ping(): void;
}

export type WsConnection = {
  id: string;
  userId: string;
  socket: WsLike;
  connectedAt: number;
  /** 最近一次收到消息 / pong 的时间，用于死连接判定。 */
  lastSeenAt: number;
  /** 底层 ping 后是否收到过 pong。 */
  alive: boolean;
};

export class WsRegistry {
  private readonly byId = new Map<string, WsConnection>();
  private readonly byUser = new Map<string, Set<string>>();

  /** 当前登记的连接总数。 */
  get size(): number {
    return this.byId.size;
  }

  /** 当前在线账号数（有至少一条连接的 userId 数量）。 */
  get userCount(): number {
    return this.byUser.size;
  }

  canAccept(userId: string, max: number = WS_MAX_CONNECTIONS_PER_USER): boolean {
    return this.countForUser(userId) < max;
  }

  countForUser(userId: string): number {
    return this.byUser.get(userId)?.size ?? 0;
  }

  /** 登记连接；超过单账号上限时返回 false 且不做任何修改。 */
  add(conn: WsConnection, max: number = WS_MAX_CONNECTIONS_PER_USER): boolean {
    if (!this.canAccept(conn.userId, max)) return false;
    if (this.byId.has(conn.id)) return false;
    this.byId.set(conn.id, conn);
    let set = this.byUser.get(conn.userId);
    if (!set) {
      set = new Set<string>();
      this.byUser.set(conn.userId, set);
    }
    set.add(conn.id);
    return true;
  }

  /**
   * P4-1a 顶号：原子地踢掉该账号所有既有连接并登记新连接，返回被踢掉的连接。
   *
   * 必须是**同步**方法：upgrade 阶段有 await（查库），两个并发握手都可能通过校验，
   * 只有把「移除旧连接 + 登记新连接」放进同一个同步临界区，才不会出现两条同时在线。
   * 调用方负责给被踢连接发 bye / close / detach，本类只管登记表。
   */
  takeover(conn: WsConnection): WsConnection[] {
    const evicted = this.listForUser(conn.userId);
    for (const old of evicted) this.remove(old.id);
    if (this.byId.has(conn.id)) return evicted;
    this.byId.set(conn.id, conn);
    let set = this.byUser.get(conn.userId);
    if (!set) {
      set = new Set<string>();
      this.byUser.set(conn.userId, set);
    }
    set.add(conn.id);
    return evicted;
  }

  /** P4-1b：全量广播（跨账号），共享野怪的 wild.state 用它下发。 */
  broadcastAll(data: string): number {
    let sent = 0;
    for (const c of this.byId.values()) {
      if (c.socket.readyState !== 1) continue;
      try {
        c.socket.send(data);
        sent += 1;
      } catch {
        // 单条连接失败不影响其他连接；close 事件会负责注销
      }
    }
    return sent;
  }

  /** P4-2b：按一批 userId 广播同一份文本（去重），返回实际送达条数。 */
  broadcastToMany(userIds: string[], data: string): number {
    let sent = 0;
    for (const userId of new Set(userIds)) sent += this.broadcastToUser(userId, data);
    return sent;
  }

  remove(id: string): boolean {
    const conn = this.byId.get(id);
    if (!conn) return false;
    this.byId.delete(id);
    const set = this.byUser.get(conn.userId);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.byUser.delete(conn.userId);
    }
    return true;
  }

  get(id: string): WsConnection | undefined {
    return this.byId.get(id);
  }

  listForUser(userId: string): WsConnection[] {
    const ids = this.byUser.get(userId);
    if (!ids) return [];
    const out: WsConnection[] = [];
    for (const id of ids) {
      const c = this.byId.get(id);
      if (c) out.push(c);
    }
    return out;
  }

  all(): WsConnection[] {
    return Array.from(this.byId.values());
  }

  /**
   * 找出超过阈值没有任何响应的死连接。
   * 纯逻辑（注入 now），由上层定时器调用后执行 terminate，便于单测覆盖 30s 心跳超时。
   */
  findStale(now: number, timeoutMs: number): WsConnection[] {
    return this.all().filter((c) => !c.alive || now - c.lastSeenAt > timeoutMs);
  }

  /** 按用户广播文本；返回实际送达的连接数。P2-2 的状态推送会复用这个出口。 */
  broadcastToUser(userId: string, data: string): number {
    let sent = 0;
    for (const c of this.listForUser(userId)) {
      // 1 = WebSocket.OPEN
      if (c.socket.readyState !== 1) continue;
      try {
        c.socket.send(data);
        sent += 1;
      } catch {
        // 单条连接发送失败不影响其他连接；close 事件会负责注销
      }
    }
    return sent;
  }

  /** 服务关闭时清空登记表，避免热重载后残留幽灵连接。 */
  clear(): void {
    this.byId.clear();
    this.byUser.clear();
  }
}
