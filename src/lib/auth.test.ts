import { describe, expect, it } from "vitest";
import { getTokenPayload, getTokenExpiry, isTokenValid } from "@/lib/auth";

// 在 node 环境构造一个合法的 base64url JWT（不校验签名，仅用于测试前端解码/过期判断）
function makeToken(payload: Record<string, any>): string {
  const b64 = (obj: any) =>
    Buffer.from(JSON.stringify(obj))
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  const now = Math.floor(Date.now() / 1000);
  const header = b64({ alg: "HS256", typ: "JWT" });
  const pl = b64({ ...payload, iat: now, exp: payload.exp ?? now + 3600 });
  return `${header}.${pl}.sig`;
}

describe("auth token 解析与过期判断", () => {
  it("有效（未过期）token 被认为有效，且能解出 payload", () => {
    const t = makeToken({ userId: "u1", exp: Math.floor(Date.now() / 1000) + 3600 });
    expect(isTokenValid(t)).toBe(true);
    expect(getTokenPayload(t)?.userId).toBe("u1");
    expect(getTokenExpiry(t)).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });

  it("过期 token 被认为无效", () => {
    const t = makeToken({ userId: "u1", exp: Math.floor(Date.now() / 1000) - 10 });
    expect(isTokenValid(t)).toBe(false);
  });

  it("结构损坏的 token 被安全判定为无效，不抛异常", () => {
    expect(isTokenValid("abc.def")).toBe(false); // 只有两段
    expect(isTokenValid("not-a-jwt")).toBe(false); // 无点
    expect(getTokenPayload("garbage")).toBeNull();
  });
});
