/**
 * W5 跨实例顶号（设计定稿 §3.5）。
 *
 * 单实例：本地 wsRegistry.takeover 已处理本进程内旧连接，无需跨实例。
 * 多实例：新连接握手成功后，除本地 takeover 外，再广播一条 takeover 事件
 * （mpk:ctl:takeover {userId, sv}），其余实例的 subscriber 收到后，对本地该
 * userId、且 sessionVersion !== sv 的连接发 bye + close + 移除 + detach。
 *
 * 这样旧设备无论连在哪个实例都会被即时踢下线；新连接（sv 匹配）被自身忽略，
 * 不会收到自己的 bye。与 REST 403 SESSION_REPLACED 同源同一 code，前端幂等。
 *
 * 模块边界：本文件依赖 sessionBus（wsRegistry / setBroadcastTransport）与 session
 * （detachConnection），但不被它们反向依赖，无循环。
 */
import Redis from 'ioredis';
import { wsRegistry, setBroadcastTransport } from '../modules/sessionBus';
import { detachConnection } from '../modules/session';
import { encodeServerMessage } from './wsProtocol';
import { SESSION_REPLACED_CODE } from './account';
import { RedisBroadcastTransport } from './redisBroadcastTransport';
import type { BroadcastTransport } from './broadcastTransport';

interface W5BroadcastHandle {
  transport: BroadcastTransport;
  publishTakeover: (userId: string, sv: number) => void;
  shutdown: () => Promise<void>;
}

let current: W5BroadcastHandle | null = null;

/** 跨实例踢人：踢掉本进程内该 userId 且 sv 不匹配的所有连接。导出以供给单测精准覆盖。 */
export function kickUserConnectionsExceptSv(userId: string, sv: number): void {
  for (const c of wsRegistry.listForUser(userId)) {
    if (c.sessionVersion !== undefined && c.sessionVersion !== sv) {
      try {
        c.socket.send(encodeServerMessage({
          type: 'bye',
          code: SESSION_REPLACED_CODE,
          reason: '账号已在其他设备登录，本设备已下线',
        }));
        c.socket.close(4001, SESSION_REPLACED_CODE);
      } catch { /* 已断开 */ }
      wsRegistry.remove(c.id);
      detachConnection(c.id);
    }
  }
}

/**
 * 用已 PING 通的 Redis 连接装配 W5 广播 + 跨实例顶号。
 * 仅在 REDIS_URL 已配置（即锁已是 redis 模式）时由 index 调用；返回 false 表示未启用。
 * 内部直接把 RedisBroadcastTransport 注入 sessionBus，所有 broadcast* 调用点零改动。
 */
export function initW5Broadcast(publisher: Redis): boolean {
  if (current) return true;
  const transport = new RedisBroadcastTransport(publisher, wsRegistry, {
    onTakeover: (userId, sv) => kickUserConnectionsExceptSv(userId, sv),
  });
  setBroadcastTransport(transport);
  current = {
    transport,
    publishTakeover: (userId, sv) => transport.publishTakeover(userId, sv),
    shutdown: () => transport.shutdown(),
  };
  console.info('[W5] Redis 广播双频道 + 跨实例顶号已启用');
  return true;
}

/** 供 onConnected 调用：新连接接管后通知其余实例踢旧连接。 */
export function publishTakeover(userId: string, sv: number): void {
  current?.publishTakeover(userId, sv);
}

/** 供 /api/health 与 E2E 诊断：确认当前实例真的跑在跨实例广播上。 */
export function getBroadcastMode(): 'local' | 'redis' {
  return current ? 'redis' : 'local';
}

export async function shutdownBroadcast(): Promise<void> {
  if (current) {
    await current.shutdown();
    current = null;
  }
}
