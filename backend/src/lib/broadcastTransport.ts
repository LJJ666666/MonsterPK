/**
 * 广播出口抽象（W0 / P5-1 批次 A）。
 *
 * 目的：W5 要把「本地直发」改成「Redis pub/sub 两频道 + 各实例本地裁剪」，
 * 但 `session.ts` / `battle.ts` / `room.ts` 等调用方只关心「发给谁」，不关心
 * 消息怎么跨进程。W0 先把出口收成一个双方法接口，调用点与返回语义完全不变。
 *
 * 设计约束（设计定稿 §3.5）：
 *  - 只允许 `toUser`（账号定向）与 `toAll`（全量）两个出口；
 *  - 房间消息**只发 roomId**，按接收者裁剪在各实例本地做，绝不把含
 *    `pvp` / `coop` 隐藏态的全量 RoomState 塞进 pub/sub；
 *  - 原 `broadcastToMany` 全 src 无调用点（死代码），W0 直接删除。
 */
import type { WsRegistry } from './wsRegistry';

export interface BroadcastTransport {
  /** 发给某账号的所有在线连接；返回实际送达条数。 */
  toUser(userId: string, data: string): number;
  /** 跨账号全量广播（共享野怪快照）；返回实际送达条数。 */
  toAll(data: string): number;
}

/** 单实例时期：直接转发给本进程 WsRegistry（W0 前逐字等价）。 */
export class LocalBroadcastTransport implements BroadcastTransport {
  constructor(private readonly registry: WsRegistry) {}

  toUser(userId: string, data: string): number {
    return this.registry.broadcastToUser(userId, data);
  }

  toAll(data: string): number {
    return this.registry.broadcastAll(data);
  }
}
