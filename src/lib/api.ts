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
import { isSessionSuspended } from "./sessionState";
import {
  SESSION_REPLACED_CODE, SESSION_REPLACED_EVENT, notifySessionReplaced,
} from "./sessionReplaced";

export { SESSION_REPLACED_EVENT };

async function request(path: string, options: RequestInit = {}): Promise<any> {
  // P4-1a：被顶号后本设备进入只读下线态，任何业务请求都不再发出。
  // 放在最前面比逐个调用点加判断可靠：自动同步、意图、写操作、战斗动作全部覆盖，
  // 也不会把本地未上传的改动偷偷同步上去。登录/注册接口必须放行，否则无法重新登录。
  if (isSessionSuspended() && !path.startsWith("/api/auth/")) {
    throw Object.assign(new Error("账号已在其他设备登录，本设备已下线"), {
      status: 403, code: SESSION_REPLACED_CODE,
    });
  }
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
    err.code = data && data.code; // 供调用方识别 ACCOUNT_BANNED / REVISION_CONFLICT 等业务码
    err.body = data; // P4：409 冲突时带着服务端当前存档，客户端就地自愈要用
    if (res.status === 403 && data?.code === SESSION_REPLACED_CODE) {
      // P4-1a 顶号：旧会话代次的 token 被服务端拒绝。不清 token（弹窗要留住当前页面），
      // 由全局弹窗停掉后台任务并在用户确认后清 token 跳登录页。
      notifySessionReplaced(data?.reason || "账号已在其他设备登录，本设备已下线");
    }
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

/**
 * P1-2 / P4：整包 PUT 的附加标记。
 * `revision` 是必填的基线版本（CAS）：不匹配时服务端返回 409 REVISION_CONFLICT，
 * 客户端据此切回服务端版本，而不是静默覆盖别人的进度。
 */
export type PutExtra = { revision: number; intentNonce?: string; rebase?: boolean };

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
  putSave: (slot: number, data: string, clientId: string | undefined, extra: PutExtra) =>
    request(`/api/save?slot=${slot}`, {
      method: "PUT",
      body: JSON.stringify({
        data,
        revision: extra.revision,
        ...(clientId ? { clientId } : {}),
        ...(extra.intentNonce ? { intentNonce: extra.intentNonce } : {}),
        ...(extra.rebase ? { rebase: true } : {}),
      }),
    }),
  /** P1-2：发意图给服务端裁决，返回 { ok, nonce, result }；结果不可由客户端伪造。 */
  dispatchIntent: (type: string, body: {
    slot: number;
    nonce: string;
    save: string;
    /** P4：本次意图基于服务端第几版，冲突时服务端拒绝（409）。 */
    revision: number;
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
    /** P4-1b：指定共享野怪实例，命中时由服务端原子抢占（别人抢先则 409）。 */
    wildId?: string;
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

  // ───────────────────── P4-1b 共享野怪（跨账号同一份实例）─────────────────────
  /** 读某区域的共享野怪列表；服务端保证实例对所有客户端一致。 */
  wildList: (areaId: string, theme: string, levelMin: number, levelMax: number) =>
    request(`/api/wild?areaId=${encodeURIComponent(areaId)}&theme=${encodeURIComponent(theme)}`
      + `&levelMin=${levelMin}&levelMax=${levelMax}`),

  // ───────────────────── P4-2a 只读派生榜（服务端真值，客户端零写入口）─────────────────────
  /** 榜单类型清单（只读元数据）。 */
  rankTypes: () => request("/api/rank"),
  /** 读一张榜；limit 由服务端钳制 1~50，不允许上报任何分数 / 战力 / 进度。 */
  rankBoard: (type: string, limit = 20) =>
    request(`/api/rank/${encodeURIComponent(type)}?limit=${limit}`),
  // F01/F02：周期榜与奖励全部只读，唯一写接口在服务端结算脚本 / 管理员，不暴露给客户端。
  rankPeriods: () => request("/api/rank/periods"),
  rankPeriodBoard: (periodKey: string) =>
    request(`/api/rank/periods/${encodeURIComponent(periodKey)}`),
  rankRewards: () => request("/api/rank/rewards"),

  // ───────────────────── P4-2c 单人 Boss 讨伐（伤害只认服务端结算）─────────────────────
  /** 讨伐列表 + 我的次数与今日伤害（只读）。 */
  bossList: () => request("/api/boss"),
  /** 开一场讨伐：只传 slot + bossId，等级 / 倍率 / 次数全在服务端。 */
  bossStart: (body: { slot: number; bossId: string }) =>
    request("/api/boss/start", { method: "POST", body: JSON.stringify(body) }),
  /** 只读伤害榜（当日），只接受 limit。 */
  bossRank: (bossId: string, limit = 20) =>
    request(`/api/boss/${encodeURIComponent(bossId)}/rank?limit=${limit}`),

  // ───────────────────── P4-2d 玩家对战 1v1（双方意图由服务端裁决）─────────────────────
  /** 房主创建 1v1 房间：只传 slot，队伍 / 胜负 / HP 全在服务端。 */
  pvpCreate: (body: { slot: number }) =>
    request("/api/pvp/create", { method: "POST", body: JSON.stringify(body) }),
  /** 对手加入 1v1 房间：只传 roomId + slot，双方队伍由服务端读取。 */
  pvpJoin: (roomId: string, body: { slot: number }) =>
    request(`/api/pvp/${encodeURIComponent(roomId)}/join`, { method: "POST", body: JSON.stringify(body) }),
  /** 提交一个回合意图（1v1 用 move:tackle / switch:1 / flee），服务端双方交齐后推进。 */
  roomAction: (roomId: string, intent: string, nonce: string) =>
    request(`/api/room/${encodeURIComponent(roomId)}/action`, {
      method: "POST",
      body: JSON.stringify({ intent, nonce }),
    }),

  // ───────────────────── P4-2e 共斗 Boss / 副本（Boss HP 是房间真值）─────────────────────
  /** 房主创建共斗房间：只传 slot + bossId，Boss 数值 / 次数 / 队伍全在服务端。 */
  coopCreate: (body: { slot: number; bossId: string }) =>
    request("/api/coop/create", { method: "POST", body: JSON.stringify(body) }),
  /** 队友加入共斗房间：只传 roomId + slot，全员队伍与 Boss 由服务端构造。 */
  coopJoin: (roomId: string, body: { slot: number }) =>
    request(`/api/coop/${encodeURIComponent(roomId)}/join`, { method: "POST", body: JSON.stringify(body) }),

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
