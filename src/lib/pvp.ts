// P4-2d 玩家对战 1v1：客户端视图层。
//
// 唯一真值在服务端：
//  - 房间与 1v1 战斗态由 `room.state` 全量快照下发（按接收者裁剪）；
//  - 客户端只发意图（move:<moveId> / switch:<idx> / flee），双方交齐后服务端结算一回合；
//  - 胜负 / HP / PP / 回合 / 日志全部由服务端裁决，客户端没有任何「改战斗态」的函数。
import type { PvpView, RoomView } from "./sessionState";

/** 从 room.state 快照里取出 1v1 战斗视图；非 pvp 房间或脏数据返回 null。 */
export function pvpViewOf(room: RoomView | null | undefined): PvpView | null {
  if (!room || room.mode !== "pvp" || !room.pvp) return null;
  return room.pvp;
}

/** 生成一个 nonce：本地唯一、长度受服务端约束（A-Za-z0-9_-，≤64）。 */
let nonceSeq = 0;
export function newNonce(): string {
  nonceSeq += 1;
  return `${Date.now().toString(36)}${nonceSeq.toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export const PVP_DISCLAIMER =
  "玩家对战由服务端裁决：双方交齐意图后结算一回合，胜负 / 伤害 / PP 全在服务端，客户端无法改写。";

/** 状态文案（与房间内核状态机对应）。 */
export function pvpStatusText(room: RoomView | null | undefined): string {
  if (!room) return "未开始";
  switch (room.status) {
    case "forming": return "等待对手加入";
    case "active": return "对战中";
    case "paused": return "有人掉线，等待重连";
    case "abandoned": return "已解散";
    case "settled": return "已结束";
    default: return "未知";
  }
}
