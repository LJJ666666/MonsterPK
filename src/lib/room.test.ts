import { describe, it, expect, beforeEach } from "vitest";
import { isRoomStateMessage, isWildStateMessage, isSessionStateMessage } from "./ws";
import {
  applyRoomSnapshot, shouldApplyRoomSnapshot, getRoomRevision, forgetRoom,
  resetRoomStateForTest, roomStatusText, roomSeatText, roomQuotaText,
} from "./room";
import {
  setRevision, getWriteRevision, resetSessionStateForTest,
} from "./sessionState";
import type { RoomStateMessage } from "./sessionState";

function msg(overrides: Record<string, unknown> = {}): any {
  return {
    type: "room.state",
    room: {
      roomId: "r1",
      mode: "kernel",
      status: "active",
      revision: 1,
      turn: 1,
      deadlineAt: 10_000,
      seats: [
        { seat: 0, label: "座位 1", online: true, autopilot: false, submitted: false, self: true },
        { seat: 1, label: "座位 2", online: true, autopilot: false, submitted: false, self: false },
      ],
      lastAction: null,
      quota: { key: "boss:daily", state: "held" },
      endReason: null,
      updatedAt: 1_000,
      ...overrides,
    },
  };
}

describe("room.state 下行形状校验", () => {
  it("合法快照通过，且不与其他消息类型混淆", () => {
    expect(isRoomStateMessage(msg())).toBe(true);
    expect(isSessionStateMessage(msg())).toBe(false);
    expect(isWildStateMessage(msg())).toBe(false);
    expect(isRoomStateMessage({ type: "session.state", room: msg().room })).toBe(false);
    expect(isRoomStateMessage({ type: "wild.state", room: msg().room })).toBe(false);
  });

  it("伪造 room.state 上行 / 缺字段 / 坏枚举一律拒绝", () => {
    expect(isRoomStateMessage(null)).toBe(false);
    expect(isRoomStateMessage({ type: "room.state" })).toBe(false);
    expect(isRoomStateMessage(msg({ roomId: "" }))).toBe(false);
    expect(isRoomStateMessage(msg({ mode: "hacked" }))).toBe(false);
    expect(isRoomStateMessage(msg({ status: "hacked" }))).toBe(false);
    expect(isRoomStateMessage(msg({ revision: "1" }))).toBe(false);
    expect(isRoomStateMessage(msg({ revision: -1 }))).toBe(false);
    expect(isRoomStateMessage(msg({ seats: "nope" }))).toBe(false);
    expect(isRoomStateMessage({
      type: "room.state",
      room: { ...msg().room, seats: [{ seat: 0, label: "座位 1", online: "yes" }] },
    })).toBe(false);
  });

  it("形状合法但版本离谱的快照仍由幂等层裁决", () => {
    const forged = msg({ turn: 999, revision: 999, status: "settled" });
    expect(isRoomStateMessage(forged)).toBe(true);
    expect(shouldApplyRoomSnapshot(forged as RoomStateMessage)).toBe(true);
    // 视图层只读：模块导出里不存在任何写状态 / 上报战果的入口。
    expect(roomStatusText("settled")).toBe("已结算");
  });
});

describe("按 (roomId, revision) 幂等应用", () => {
  beforeEach(() => resetRoomStateForTest());

  it("只接受单调递增的新版本", () => {
    const a = msg() as RoomStateMessage;
    expect(shouldApplyRoomSnapshot(a)).toBe(true);
    expect(applyRoomSnapshot(a)?.revision).toBe(1);
    expect(getRoomRevision("r1")).toBe(1);
    const old = msg({ revision: 1 }) as RoomStateMessage;
    expect(shouldApplyRoomSnapshot(old)).toBe(false);
    expect(applyRoomSnapshot(old)).toBe(null);
    const stale = msg({ revision: 0 }) as RoomStateMessage;
    expect(applyRoomSnapshot(stale)).toBe(null);
    const newer = msg({ revision: 2, status: "paused" }) as RoomStateMessage;
    expect(applyRoomSnapshot(newer)?.status).toBe("paused");
    expect(getRoomRevision("r1")).toBe(2);
  });

  it("不同 roomId 的 revision 互不干扰", () => {
    const a = msg() as RoomStateMessage;
    const b = msg({ roomId: "r2", revision: 7 }) as RoomStateMessage;
    expect(applyRoomSnapshot(a)?.roomId).toBe("r1");
    expect(applyRoomSnapshot(b)?.roomId).toBe("r2");
    expect(getRoomRevision("r1")).toBe(1);
    expect(getRoomRevision("r2")).toBe(7);
  });

  it("坏 revision / 缺 roomId 的快照不写基线", () => {
    expect(applyRoomSnapshot(msg({ revision: Number.NaN }) as RoomStateMessage)).toBe(null);
    expect(applyRoomSnapshot(msg({ roomId: "" }) as RoomStateMessage)).toBe(null);
    expect(getRoomRevision("r1")).toBe(-1);
  });

  it("forgetRoom / reset 后重新建立基线", () => {
    applyRoomSnapshot(msg() as RoomStateMessage);
    forgetRoom("r1");
    expect(getRoomRevision("r1")).toBe(-1);
    expect(applyRoomSnapshot(msg() as RoomStateMessage)?.revision).toBe(1);
  });
});

describe("RoomState.revision 与 Save.revision 在客户端两模块独立（W6.6）", () => {
  beforeEach(() => {
    resetRoomStateForTest();
    resetSessionStateForTest();
  });

  it("写入/推进 Save.revision 不影响房间 revision 基线", () => {
    setRevision(42); // 模拟 session.state 落库到 revision 42
    expect(getWriteRevision()).toBe(42);
    expect(getRoomRevision("r1"), "房间基线不应被 Save.revision 污染").toBe(-1);
    applyRoomSnapshot(msg() as RoomStateMessage);
    expect(getRoomRevision("r1"), "房间快照独立维护自己的 revision").toBe(1);
    expect(getWriteRevision(), "房间推进不应回填 Save.revision").toBe(42);
  });

  it("房间多版本推进不影响 Save.revision 基线", () => {
    applyRoomSnapshot(msg() as RoomStateMessage);
    applyRoomSnapshot(msg({ revision: 5 }) as RoomStateMessage);
    expect(getRoomRevision("r1")).toBe(5);
    expect(getWriteRevision(), "房间推进不应生成 Save.revision 基线").toBe(null);
  });
});

describe("只读文案", () => {
  it("状态文案覆盖五种房间状态", () => {
    expect(roomStatusText("forming")).toBe("等待队友");
    expect(roomStatusText("active")).toBe("进行中");
    expect(roomStatusText("paused")).toBe("有人掉线，等待重连");
    expect(roomStatusText("abandoned")).toBe("已解散（不扣次数）");
    expect(roomStatusText("settled")).toBe("已结算");
  });

  it("座位与次数文案体现「不扣次数」口径", () => {
    expect(roomSeatText({ seat: 0, label: "座位 1", online: false, autopilot: true, submitted: false, self: true }))
      .toBe("掉线 · 托管中");
    expect(roomSeatText({ seat: 0, label: "座位 1", online: false, autopilot: false, submitted: false, self: true }))
      .toBe("掉线 · 等待重连");
    expect(roomSeatText({ seat: 0, label: "座位 1", online: true, autopilot: false, submitted: true, self: true }))
      .toBe("已提交");
    expect(roomQuotaText({ key: "k", state: "held" })).toBe("次数已预留（未消耗）");
    expect(roomQuotaText({ key: "k", state: "released" })).toBe("次数已释放（未消耗）");
    expect(roomQuotaText(null)).toBe("不限次");
  });
});
