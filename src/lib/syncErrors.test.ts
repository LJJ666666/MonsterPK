// 上传失败分类单测（P1-1 / P1-1b）：确保 4xx（含 403 封号）不会被当成离线故障无限重传。
import { describe, it, expect } from "vitest";
import { classifyUploadError, uploadErrorMessage } from "./syncErrors";

describe("classifyUploadError", () => {
  it("400 存档被拒 → permanent（不可重试）", () => {
    expect(classifyUploadError({ status: 400, message: "金钱必须是整数" })).toBe("permanent");
  });

  it("401 登录失效 → permanent（api.ts 已统一登出，不该入队）", () => {
    expect(classifyUploadError({ status: 401 })).toBe("permanent");
  });

  it("404 / 409 等 4xx → permanent", () => {
    expect(classifyUploadError({ status: 404 })).toBe("permanent");
    expect(classifyUploadError({ status: 409 })).toBe("permanent");
  });

  it("403 封号 → permanent（不入离线队列，由 BanGate 弹窗登出）", () => {
    expect(classifyUploadError({ status: 403, code: "ACCOUNT_BANNED", message: "你已被封号" })).toBe("permanent");
  });

  it("429 限流 → transient（稍后可重试）", () => {
    expect(classifyUploadError({ status: 429 })).toBe("transient");
  });

  it("5xx 服务端故障 → transient", () => {
    expect(classifyUploadError({ status: 500 })).toBe("transient");
    expect(classifyUploadError({ status: 503 })).toBe("transient");
  });

  it("无 status 的网络错误 / 超时 → transient", () => {
    expect(classifyUploadError(new Error("Failed to fetch"))).toBe("transient");
    expect(classifyUploadError(undefined)).toBe("transient");
    expect(classifyUploadError(null)).toBe("transient");
  });

  it("status 非数字（脏错误对象）→ 保守视为 transient", () => {
    expect(classifyUploadError({ status: "400" })).toBe("transient");
  });
});

describe("uploadErrorMessage", () => {
  it("优先返回后端中文说明", () => {
    expect(uploadErrorMessage({ message: "hp 不能超过 maxHp" })).toBe("hp 不能超过 maxHp");
  });

  it("无 message 时给兜底文案", () => {
    expect(uploadErrorMessage(new Error())).toBe("同步失败，请稍后重试");
    expect(uploadErrorMessage(undefined)).toBe("同步失败，请稍后重试");
  });
});
