// 后端 API 封装。开发期默认连本地后端，生产环境用 VITE_API_BASE 覆盖。
export const API_BASE: string =
  (import.meta as any).env?.VITE_API_BASE ?? "http://localhost:3001";

// 401 统一事件：token 失效（过期/被服务端拒绝）时由 request 抛出，前端监听后跳转登录页
export const UNAUTHORIZED_EVENT = "mpk:unauthorized";

// 403 封号事件：服务端检测到改档并封停账号时广播，前端弹「你已被封号」并强制登出。
// 与 401 分开，避免把「账号被封」误当成「登录过期」而静默跳登录页。
export const BANNED_EVENT = "mpk:banned";
export const BAN_CODE = "ACCOUNT_BANNED";

import { clearToken } from "./auth";

async function request(path: string, options: RequestInit = {}): Promise<any> {
  const token = localStorage.getItem("mpk_token");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    ...((options.headers as Record<string, string>) ?? {}),
  };
  if (token) headers["Authorization"] = `Bearer ${token}`;
  const res = await fetch(API_BASE + path, { ...options, headers });
  const text = await res.text();
  let data: any = text;
  try {
    data = JSON.parse(text);
  } catch {
    // 保留原文
  }
  if (!res.ok) {
    const err: any = new Error((data && data.error) || `请求失败 (${res.status})`);
    err.status = res.status; // 供调用方区分 404（该槽位无存档）与真实故障
    err.code = data && data.code; // 供调用方识别 ACCOUNT_BANNED 等业务码
    if (res.status === 403 && data?.code === BAN_CODE) {
      // 封号：广播事件让全局弹窗展示原因并强制登出。这里不清 token，
      // 交给弹窗「确定」按钮处理，保证用户一定能看到封号提示。
      if (typeof window !== "undefined") {
        window.dispatchEvent(
          new CustomEvent(BANNED_EVENT, {
            detail: { reason: data?.reason || "检测到异常游戏数据" },
          })
        );
      }
    }
    if (res.status === 401) {
      // 登录态失效：清掉本地 token 并广播事件，由 App 统一跳登录页
      clearToken();
      if (typeof window !== "undefined") {
        window.dispatchEvent(new CustomEvent(UNAUTHORIZED_EVENT));
      }
    }
    throw err;
  }
  return data;
}

/** P1-2：整包 PUT 的附加标记（意图 nonce / 新档重建基线）。 */
export type PutExtra = { intentNonce?: string; rebase?: boolean };

export const api = {
  health: () => request("/api/health"),
  me: () => request("/api/auth/me"),
  register: (username: string, password: string) =>
    request("/api/auth/register", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  login: (username: string, password: string) =>
    request("/api/auth/login", {
      method: "POST",
      body: JSON.stringify({ username, password }),
    }),
  getSave: (slot: number) => request(`/api/save?slot=${slot}`),
  putSave: (slot: number, data: string, clientId?: string, extra?: PutExtra) =>
    request(`/api/save?slot=${slot}`, {
      method: "PUT",
      body: JSON.stringify({
        data,
        ...(clientId ? { clientId } : {}),
        ...(extra?.intentNonce ? { intentNonce: extra.intentNonce } : {}),
        ...(extra?.rebase ? { rebase: true } : {}),
      }),
    }),
  /** P1-2：发意图给服务端裁决，返回 { ok, nonce, result }；结果不可由客户端伪造。 */
  dispatchIntent: (type: string, body: {
    slot: number;
    nonce: string;
    save: string;
    payload: Record<string, unknown>;
  }) =>
    request(`/api/actions/${encodeURIComponent(type)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),

  // ───────────────────── P3-1c 服务端战斗（服务端裁决全部过程）─────────────────────
  /** 开局：客户端只说明「在哪打」，敌人与队伍副本由服务端生成。 */
  battleStart: (body: {
    slot: number;
    theme: string;
    areaName: string;
    areaId?: string | null;
    levelMin: number;
    levelMax: number;
    testFlags?: { testShiny?: boolean; testMaxStats?: boolean; testOHKO?: boolean };
  }) =>
    request("/api/battle/start", { method: "POST", body: JSON.stringify(body) }),
  /** 发一个战斗动作（技能/道具/捕获/换人/逃跑），服务端推进一回合。 */
  battleAction: (body: {
    battleId: string;
    slot: number;
    action:
      | { type: "move"; moveId: string }
      | { type: "item"; itemId: string }
      | { type: "capture"; itemId: string }
      | { type: "switch"; partyIndex: number }
      | { type: "flee" };
  }) =>
    request("/api/battle/action", { method: "POST", body: JSON.stringify(body) }),
  /** 刷新/重连后取回服务端仍存活的战斗（战斗态不进存档）。 */
  battleCurrent: (slot: number) => request(`/api/battle/current?slot=${slot}`),
  /** 放弃战斗：不结算奖励，仅丢弃会话。 */
  battleAbandon: (battleId: string, slot: number) =>
    request("/api/battle/abandon", {
      method: "POST",
      body: JSON.stringify({ battleId, slot }),
    }),

  // ───────────────────── P3-2 服务端存档写操作（流程本身在服务端）─────────────────────
  /**
   * 治疗 / 战斗外道具 / 进化 / 学招 / 队伍整理 / 移动。
   * 客户端只发意图 ID，服务端判定并写档，返回新存档整包（data）。
   */
  gameOp: (op: string, body: Record<string, unknown>) =>
    request(`/api/game/${encodeURIComponent(op)}`, {
      method: "POST",
      body: JSON.stringify(body),
    }),
};
