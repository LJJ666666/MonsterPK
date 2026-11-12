/**
 * 实时通道与在线会话的共享单例（P2-2）。
 *
 * 单独抽一层是为了消除循环依赖：realtime.ts 需要推快照、session.ts 需要广播，
 * 两边都只依赖本模块，不互相 import。
 *
 * W0：广播出口改为可注入 `BroadcastTransport`（W5 换 Redis pub/sub 只改注入），
 * 并删除无调用点的 `broadcastToMany`。所有单例与函数签名保持不变。
 */
import { WsRegistry } from '../lib/wsRegistry';
import { GameSessionRegistry, type SessionStats } from '../lib/gameSession';
import { BattleRegistry } from '../lib/battleSession';
import { WildRegistry } from '../lib/wildRegistry';
import { RoomRegistry } from '../lib/roomRegistry';
import { BossQuotaLedger } from '../lib/bossQuota';
import { LocalBroadcastTransport, type BroadcastTransport } from '../lib/broadcastTransport';

/** 在线 WebSocket 连接登记表（P2-1 已在用）。 */
export const wsRegistry = new WsRegistry();
/** 按 userId（账号单档）的在线权威态。 */
export const gameSessions = new GameSessionRegistry();
/** 按 userId（账号单档）的活跃战斗（P3-1）。 */
export const battles = new BattleRegistry();
/** 按区域的共享野怪实例池（P4-1b），跨账号共享同一份实例。 */
export const wilds = new WildRegistry();
/** P4-2b 房间状态域（roomId）：纯逻辑 + 可替换 storage，P5-1 迁共享存储时只换 adapter。 */
export const rooms = new RoomRegistry();
/**
 * P4-2c Boss 每日次数的「在途闸」：只记已开局未结算的名额，
 * 已用次数真值在 `BossDamageEvent`（进程重启不会重置次数）。
 */
export const bossQuota = new BossQuotaLedger();

let transport: BroadcastTransport = new LocalBroadcastTransport(wsRegistry);

/** W5 注入共享 pub/sub 实现；所有 broadcast* 调用点零改动。 */
export function setBroadcastTransport(next: BroadcastTransport): void {
  transport = next;
}

/** 仅单测：恢复本地实现。 */
export function resetBroadcastTransportForTest(): void {
  transport = new LocalBroadcastTransport(wsRegistry);
}

/** 把一条服务端消息发给该账号的所有在线连接；返回实际送达条数。 */
export function broadcastToUser(userId: string, data: string): number {
  return transport.toUser(userId, data);
}

/** P4-1b：跨账号全量广播（共享野怪状态），返回实际送达条数。 */
export function broadcastAll(data: string): number {
  return transport.toAll(data);
}

export function getSessionStats(): SessionStats {
  return gameSessions.stats();
}
