/**
 * W5 广播出口：Redis pub/sub 双频道实现（设计定稿 §3.5）。
 *
 * 两个广播频道（房间消息只发 roomId，绝不把含 pvp/coop 隐藏态的全量 RoomState
 * 塞进 pub/sub，裁剪在各实例本地做）：
 *  - mpk:bc:all           —— 跨账号全量（共享野怪 wild.state）
 *  - mpk:bc:user:<userId> —— 账号定向（session / room / battle 快照、bye）
 * 一个控制频道：
 *  - mpk:ctl:takeover     —— 跨实例顶号事件 {userId, sv}；接收端本地踢 sv 不匹配的连接
 *
 * 关键不变量：所有发送都走 Redis，所有接收都经本进程的独立 subscriber 转发回
 * 本地 WsRegistry。单实例下形成「发布 → 自己订阅 → 本地转发」闭环，连接只收到
 * 一次，与切换前（直接本地发送）零行为差异。Redis 不可达时 publish 静默失败，
 * 快照可由客户端 REST 回源兜底（定稿「可丢」类）。
 *
 * subscriber 必须是独立连接：Redis 规定进入订阅模式后该连接只能发 SUBSCRIBE 类
 * 命令，不能再执行 PUBLISH 等普通命令。publisher 复用 W3 已 PING 通的锁连接。
 */
import Redis from 'ioredis';
import type { BroadcastTransport } from './broadcastTransport';
import type { WsRegistry } from './wsRegistry';

const BC_ALL = 'mpk:bc:all';
const BC_USER_PREFIX = 'mpk:bc:user:';
const CTL_TAKEOVER = 'mpk:ctl:takeover';

export type TakeoverHandler = (userId: string, sv: number) => void;

export interface RedisBroadcastOptions {
  /** 跨实例顶号事件回调：收到 mpk:ctl:takeover 时本地踢人。由调用方注入，避免本模块依赖 session。 */
  onTakeover?: TakeoverHandler;
}

export class RedisBroadcastTransport implements BroadcastTransport {
  private readonly sub: Redis;

  constructor(
    private readonly publisher: Redis,
    private readonly registry: WsRegistry,
    private readonly options: RedisBroadcastOptions = {},
    subscriber?: Redis,
  ) {
    const url = process.env.REDIS_URL;
    if (!url) throw new Error('[W5] REDIS_URL 未配置，无法创建 Redis 广播');
    // 独立订阅连接：默认自动重连，断线恢复后 ioredis 会自动重新订阅已订阅频道。
    this.sub = subscriber ?? new Redis(url, { maxRetriesPerRequest: 2 });
    this.sub.on('error', (e) => console.error('[W5] 广播订阅连接错误:', String(e?.message ?? e)));
    void this.sub.psubscribe(`${BC_USER_PREFIX}*`, BC_ALL, CTL_TAKEOVER);
    this.sub.on('pmessage', (_pattern: string, channel: string, message: string) => {
      this.dispatch(channel, message);
    });
  }

  private dispatch(channel: string, message: string): void {
    try {
      if (channel === BC_ALL) {
        this.registry.broadcastAll(message);
      } else if (channel.startsWith(BC_USER_PREFIX)) {
        const userId = channel.slice(BC_USER_PREFIX.length);
        this.registry.broadcastToUser(userId, message);
      } else if (channel === CTL_TAKEOVER) {
        const payload = JSON.parse(message) as { userId?: unknown; sv?: unknown };
        if (typeof payload.userId === 'string' && typeof payload.sv === 'number') {
          this.options.onTakeover?.(payload.userId, payload.sv);
        }
      }
    } catch (e) {
      console.error('[W5] 广播分发失败:', String(e?.message ?? e));
    }
  }

  toUser(userId: string, data: string): number {
    void this.publisher.publish(`${BC_USER_PREFIX}${userId}`, data).catch((e) => {
      console.error('[W5] 账号定向广播失败:', String(e?.message ?? e));
    });
    return 0;
  }

  toAll(data: string): number {
    void this.publisher.publish(BC_ALL, data).catch((e) => {
      console.error('[W5] 全量广播失败:', String(e?.message ?? e));
    });
    return 0;
  }

  /** 发布跨实例顶号事件；其余实例的 subscriber 收到后本地踢掉 sv 不匹配的连接。 */
  publishTakeover(userId: string, sv: number): void {
    void this.publisher.publish(CTL_TAKEOVER, JSON.stringify({ userId, sv })).catch((e) => {
      console.error('[W5] 顶号事件广播失败:', String(e?.message ?? e));
    });
  }

  async shutdown(): Promise<void> {
    try {
      await this.sub.quit();
    } catch { /* 已断开 */ }
  }
}
