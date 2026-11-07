// P4-1a 顶号：统一的「本设备已下线」通知出口（零依赖，避免 api.ts / ws.ts 互相 import）。
//
// 两条路径会同时到达这里：
//  ① WS 收到 bye(code=SESSION_REPLACED) —— 新设备建连时服务端主动踢；
//  ② REST 收到 403 SESSION_REPLACED —— 新设备登录已递增会话代次，旧 token 立即失效。
// 用一次性闸门去重：弹窗只弹一次，避免两个通道叠加把提示刷两遍。
export const SESSION_REPLACED_EVENT = "mpk:session-replaced";
export const SESSION_REPLACED_CODE = "SESSION_REPLACED";

export const DEFAULT_REPLACED_REASON = "账号已在其他设备登录，本设备已下线";

let notified = false;

export function notifySessionReplaced(reason: string = DEFAULT_REPLACED_REASON): void {
  if (notified) return;
  notified = true;
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent(SESSION_REPLACED_EVENT, { detail: { reason } }),
    );
  }
}

/** 重新登录后复位，允许下一次顶号再次弹窗。 */
export function resetSessionReplaced(): void {
  notified = false;
}
