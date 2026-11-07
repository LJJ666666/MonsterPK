/**
 * 实时通道与在线会话的共享单例（P2-2）。
 *
 * 单独抽一层是为了消除循环依赖：realtime.ts 需要推快照、session.ts 需要广播，
 * 两边都只依赖本模块，不互相 import。
 */
import { WsRegistry } from '../lib/wsRegistry';
import { GameSessionRegistry, type SessionStats } from '../lib/gameSession';
import { BattleRegistry } from '../lib/battleSession';
import { WildRegistry } from '../lib/wildRegistry';

/** 在线 WebSocket 连接登记表（P2-1 已在用）。 */
export const wsRegistry = new WsRegistry();
/** 按 (userId, slot) 的在线权威态。 */
export const gameSessions = new GameSessionRegistry();
/** 按 (userId, slot) 的活跃战斗（P3-1）。 */
export const battles = new BattleRegistry();
/** 按区域的共享野怪实例池（P4-1b），跨账号共享同一份实例。 */
export const wilds = new WildRegistry();

/** 把一条服务端消息发给该账号的所有在线连接；返回实际送达条数。 */
export function broadcastToUser(userId: string, data: string): number {
  return wsRegistry.broadcastToUser(userId, data);
}

/** P4-1b：跨账号全量广播（共享野怪状态），返回实际送达条数。 */
export function broadcastAll(data: string): number {
  return wsRegistry.broadcastAll(data);
}

export function getSessionStats(): SessionStats {
  return gameSessions.stats();
}
