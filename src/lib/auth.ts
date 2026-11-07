// 登录态 token 的本地存取（仅存 token，存档仍在云端）。
// 注意：token 合法性（过期）在本地只做轻量判断，真正的校验以后端 jwtVerify 为准。
import { uuid } from "@/game/rules";
import { forgetAllRevisions } from "./sessionState";

const TOKEN_KEY = "mpk_token";
// 每设备唯一标识：用于云端存档冲突判断（区分「同一设备」与「跨设备」写入）。
// 生成一次后持久化，避免每次启动都换标识。
const CLIENT_ID_KEY = "mpk_client_id";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string): void {
  localStorage.setItem(TOKEN_KEY, token);
}

export function clearToken(): void {
  localStorage.removeItem(TOKEN_KEY);
  // P4：登录态结束必须一并丢掉各槽位的写入基线版本，
  // 否则下一个账号会带着上一个账号的 revision 去写，白白撞一次 409。
  forgetAllRevisions();
}

// 取每设备唯一 clientId（首次访问时生成并持久化）
export function getClientId(): string {
  let id = localStorage.getItem(CLIENT_ID_KEY);
  if (!id) {
    id = uuid();
    localStorage.setItem(CLIENT_ID_KEY, id);
  }
  return id;
}

// base64url 解码为字符串（兼容非 ASCII，避免中文/特殊字符损坏）
function b64urlDecode(s: string): string {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/");
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (ch) => ch.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

// 解析 JWT payload（不校验签名，仅用于本地过期判断；签名校验交给后端）
export function getTokenPayload(token: string | null = getToken()): any | null {
  if (!token) return null;
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(b64urlDecode(parts[1]));
  } catch {
    return null;
  }
}

// 取 token 过期时间（秒），无法解析时返回 null
export function getTokenExpiry(token: string | null = getToken()): number | null {
  const p = getTokenPayload(token);
  return p && typeof p.exp === "number" ? p.exp : null;
}

// token 是否仍在有效期内（本地粗判，最终以后端 401 为准）
export function isTokenValid(token: string | null = getToken()): boolean {
  const exp = getTokenExpiry(token);
  if (exp == null) return false;
  return exp * 1000 > Date.now();
}

// 是否处于登录态：有 token 且未过期
export function isLoggedIn(): boolean {
  const t = getToken();
  return !!t && isTokenValid(t);
}
