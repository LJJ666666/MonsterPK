import { describe, it, expect } from "vitest";
import { decideSyncAction } from "./syncPolicy";

describe("decideSyncAction 冲突决策", () => {
  it("两侧都无存档 → none", () => {
    expect(
      decideSyncAction({ localExists: false, localTime: 0, cloudExists: false, cloudTime: 0, sameDevice: false })
    ).toBe("none");
  });

  it("本地空、云端有 → restore（从云端恢复）", () => {
    expect(
      decideSyncAction({ localExists: false, localTime: 0, cloudExists: true, cloudTime: 100, sameDevice: false })
    ).toBe("restore");
  });

  it("本地有、云端空 → upload（上传基线）", () => {
    expect(
      decideSyncAction({ localExists: true, localTime: 100, cloudExists: false, cloudTime: 0, sameDevice: false })
    ).toBe("upload");
  });

  it("两侧都有、同一台设备 → upload（本地即权威）", () => {
    expect(
      decideSyncAction({ localExists: true, localTime: 100, cloudExists: true, cloudTime: 999, sameDevice: true })
    ).toBe("upload");
  });

  it("跨设备、云端更新 → restore", () => {
    expect(
      decideSyncAction({ localExists: true, localTime: 100, cloudExists: true, cloudTime: 200, sameDevice: false })
    ).toBe("restore");
  });

  it("跨设备、本地更新 → upload", () => {
    expect(
      decideSyncAction({ localExists: true, localTime: 300, cloudExists: true, cloudTime: 200, sameDevice: false })
    ).toBe("upload");
  });

  it("跨设备、时间戳相同 → upload（平局时本地胜，避免无谓恢复）", () => {
    expect(
      decideSyncAction({ localExists: true, localTime: 200, cloudExists: true, cloudTime: 200, sameDevice: false })
    ).toBe("upload");
  });
});
