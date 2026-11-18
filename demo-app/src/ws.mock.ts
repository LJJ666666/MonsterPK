/**
 * L1 演示包的实时通道替身。只在 MPK_MOCK=1 构建里经 Vite 插件重定向到此。
 *
 * 默认包完全不引用本文件。行为：不建任何 WebSocket，恒报 online（避免 ConnBanner
 * 弹「正在连接/已断开」横幅干扰看界面）；session/wild/room 三类纯函数保留形状校验，
 * 供运行时类型与个别模块 import 不报错——它们不会收到任何消息。
 */
import { useEffect, useState } from 'react';

export type WsPhase = 'idle' | 'connecting' | 'online' | 'reconnecting' | 'offline' | 'unauthorized';
export type ServerEnvelope = { type: string; [key: string]: any };
export type SessionStateMessage = { type: 'session.state'; revision: number; data: string; updatedAt: number; source?: string; online?: number };
export type WildStateMessage = { type: 'wild.state'; areaId: string; revision: number; monsters: any[] };
export type RoomStateMessage = { type: 'room.state'; room: Record<string, any> };

export const SESSION_STATE_EVENT = 'mpk:session.state';
export const WILD_STATE_EVENT = 'mpk:wild.state';
export const ROOM_STATE_EVENT = 'mpk:room.state';
export const WILD_REFRESH_EVENT = 'mpk:wild.refresh';

export function wsUrl(base: string, token: string): string { return 'mock://ws'; }
export function reconnectDelayMs(): number { return 0; }
export function parseServerMessage(raw: string): ServerEnvelope | null {
  try { const v = JSON.parse(raw); return v && typeof v === 'object' ? v : null; } catch { return null; }
}
export function isSessionStateMessage(m: any): m is SessionStateMessage {
  return !!m && m.type === 'session.state' && typeof m.revision === 'number' && typeof m.data === 'string';
}
export function isWildStateMessage(m: any): m is WildStateMessage {
  return !!m && m.type === 'wild.state' && typeof m.areaId === 'string' && Array.isArray(m.monsters);
}
export function isRoomStateMessage(m: any): m is RoomStateMessage {
  return !!m && m.type === 'room.state' && !!m.room && typeof m.room === 'object';
}
export type RevDelta = 'reset' | 'ok' | 'jump';
export function noteReceivedRevision(_key: string, _rev: number): RevDelta { return 'ok'; }
export function resetRevisionBaselines(): void {}
export function getWsPhase(): WsPhase { return 'online'; }
export function getWsDiagnostics() { return { phase: 'online' as WsPhase, info: undefined, attempts: 0, connected: true }; }
export function subscribeWs(cb: () => void): () => void { cb(); return () => {}; }
export function useWsStatus(): { phase: WsPhase; info?: string } {
  const [s] = useState({ phase: 'online' as WsPhase, info: undefined });
  useEffect(() => {}, []);
  return s;
}
export function startRealtime(): void {}
export function stopRealtime(): void {}
