// F16 共斗 6 房副本：客户端视图层。
//
// 唯一真值在服务端：
//  - 每房敌人 HP / 房间四态 / 贡献 / 回合 / 胜负 / 日志全部由 `room.state` 全量快照下发（按接收者裁剪）；
//  - 客户端只发意图（enter:<0..5> / move:<moveId> / switch:<idx> / idle），全员交齐后服务端结算一回合；
//  - 客户端没有任何「改房间态 / 算伤害 / 扣次数 / 领奖励」的函数，只读渲染。
import type { CoopRoomView, CoopView, RoomView } from "./sessionState";

/** 从 room.state 快照里取出共斗视图；非 coop 房间或脏数据返回 null。 */
export function coopViewOf(room: RoomView | null | undefined): CoopView | null {
  if (!room || room.mode !== "coop" || !room.coop) return null;
  return room.coop;
}

export const COOP_DISCLAIMER =
  "共斗由服务端裁决：6 间房各自结算，全清即通关；一房同时 1 人，战败可重打。通关且有战斗贡献者得奖励，每日上限 3 次。";

/** 房间四态文案（与服务端 `CoopRoomState` 对应）。 */
export function coopRoomStateText(state: CoopRoomView["state"]): string {
  switch (state) {
    case "pending": return "未挑战";
    case "fighting": return "战斗中";
    case "cleared": return "已清理";
    case "defeated": return "已战败";
    default: return "未知";
  }
}

/** 状态文案（与房间内核状态机对应）。 */
export function coopStatusText(room: RoomView | null | undefined): string {
  if (!room) return "未开始";
  switch (room.status) {
    case "forming": return "等待队友加入";
    case "active": return "副本进行中";
    case "paused": return "有人掉线，等待重连";
    case "abandoned": return "已解散（不扣次数）";
    case "settled": return "已结束";
    default: return "未知";
  }
}

/** 结果文案。 */
export function coopResultText(view: CoopView | null): string {
  if (!view || !view.finished) return "";
  if (view.result === "win") return "六房全清，副本通关！";
  if (view.result === "lose") return "全员倒下，副本失败";
  return "副本结束";
}
