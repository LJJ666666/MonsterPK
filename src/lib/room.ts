// P4-2b 房间视图层：只读、零写入口。
//
// 服务端按成员分别下发 `room.state` 全量快照（self 随接收者变化），
// 客户端只做形状校验（ws.ts）、按 (roomId, revision) 幂等应用与文案映射。
// b 阶段刻意不做玩法 UI：房间内核没有可展示的战斗内容，UI 留到 d/e 接真实玩法。
import type { RoomStateMessage, RoomView, RoomSeatView } from "./sessionState";

/** 每个 roomId 最近一次已认可的 revision（-1 = 尚未建立基线）。 */
const lastSeen = new Map<string, number>();

export function getRoomRevision(roomId: string): number {
  return lastSeen.get(roomId) ?? -1;
}

/** 旧版本 / 重放快照一律丢弃；与 session.state 的幂等口径一致。 */
export function shouldApplyRoomSnapshot(m: RoomStateMessage): boolean {
  const r = m?.room;
  if (!r || typeof r.roomId !== "string" || r.roomId.length === 0) return false;
  if (typeof r.revision !== "number" || !Number.isFinite(r.revision) || r.revision < 0) return false;
  return r.revision > getRoomRevision(r.roomId);
}

/** 返回可渲染的视图；返回 null 表示这是过期快照，调用方应忽略。 */
export function applyRoomSnapshot(m: RoomStateMessage): RoomView | null {
  if (!shouldApplyRoomSnapshot(m)) return null;
  lastSeen.set(m.room.roomId, m.room.revision);
  return m.room;
}

export function forgetRoom(roomId: string): void {
  lastSeen.delete(roomId);
}

/** 仅用于单测复位，不在业务路径调用。 */
export function resetRoomStateForTest(): void {
  lastSeen.clear();
}

const STATUS_TEXT: Record<RoomView["status"], string> = {
  forming: "等待队友",
  active: "进行中",
  paused: "有人掉线，等待重连",
  abandoned: "已解散（不扣次数）",
  settled: "已结算",
};

export function roomStatusText(status: RoomView["status"]): string {
  return STATUS_TEXT[status] ?? "未知";
}

export function roomSeatText(seat: RoomSeatView): string {
  if (!seat.online) return seat.autopilot ? "掉线 · 托管中" : "掉线 · 等待重连";
  if (seat.submitted) return "已提交";
  return "在线";
}

const QUOTA_TEXT: Record<"held" | "committed" | "released", string> = {
  held: "次数已预留（未消耗）",
  committed: "次数已消耗",
  released: "次数已释放（未消耗）",
};

export function roomQuotaText(quota: RoomView["quota"]): string {
  if (!quota) return "不限次";
  return QUOTA_TEXT[quota.state] ?? "未知";
}
