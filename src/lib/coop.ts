// P4-2e 共斗 Boss / 副本：客户端视图层。
//
// 唯一真值在服务端：
//  - Boss HP / 伤害 / 回合 / 胜负 / 日志全部由 `room.state` 全量快照下发（按接收者裁剪）；
//  - 客户端只发意图（move:<moveId> / switch:<idx>），全员交齐后服务端结算一回合；
//  - 客户端没有任何「改战斗态 / 算伤害 / 扣次数 / 发奖励」的函数。
// 本阶段刻意不发奖励（2026-11-08 杰哥拍板「延续先例」），奖励规则在台账 F09 / F14。
import type { CoopView, RoomView } from "./sessionState";

/** 从 room.state 快照里取出共斗视图；非 coop 房间或脏数据返回 null。 */
export function coopViewOf(room: RoomView | null | undefined): CoopView | null {
  if (!room || room.mode !== "coop" || !room.coop) return null;
  return room.coop;
}

export const COOP_DISCLAIMER =
  "共斗由服务端裁决：Boss HP 是房间真值，全员交齐意图后结算一回合；本阶段不发奖励，只回写队伍状态。";

/** 状态文案（与房间内核状态机对应）。 */
export function coopStatusText(room: RoomView | null | undefined): string {
  if (!room) return "未开始";
  switch (room.status) {
    case "forming": return "等待队友加入";
    case "active": return "共斗中";
    case "paused": return "有人掉线，等待重连";
    case "abandoned": return "已解散（不扣次数）";
    case "settled": return "已结束";
    default: return "未知";
  }
}

/** 结果文案。 */
export function coopResultText(view: CoopView | null): string {
  if (!view || !view.finished) return "";
  if (view.result === "win") return "讨伐成功！";
  if (view.result === "lose") return "全员倒下，讨伐失败";
  return "共斗结束";
}
