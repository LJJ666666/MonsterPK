// 上传失败分类（P1-1）。
// 服务端 P1-1 起会对非法存档返回 400。若不区分错误类型，sync.ts 会把
// 「永久性 4xx 拒绝」当成网络故障塞进离线队列，导致无限重传、状态永远卡在 offline。
// 抽成纯函数便于单测，不依赖网络 / React（沿用 P0-3 syncPolicy 的做法）。

/** 一次上传的结果：成功 / 永久失败（不可重试） / 临时失败（可重试）。 */
export type UploadOutcome = "ok" | "permanent" | "transient";

/** 从 api.request 抛出的错误对象里取 HTTP 状态码（无 status 视为网络层错误）。 */
function statusOf(e: unknown): number | undefined {
  if (!e || typeof e !== "object") return undefined;
  const s = (e as { status?: unknown }).status;
  return typeof s === "number" && Number.isFinite(s) ? s : undefined;
}

/**
 * 判定错误是否可重试：
 * - 4xx（除 429）＝请求本身有问题，重试一万次也不会成功 → permanent；
 *   典型是 400 存档被服务端校验拒绝、401 登录失效（api.ts 已统一登出）、
 *   403 账号被封（api.ts 广播 mpk:banned，BanGate 弹窗并强制登出，更不能重传）。
 * - 429 限流、5xx、无 status 的网络错误 / 超时 → transient，稍后重传。
 */
export function classifyUploadError(e: unknown): Exclude<UploadOutcome, "ok"> {
  const status = statusOf(e);
  if (status !== undefined && status >= 400 && status < 500 && status !== 429) {
    return "permanent";
  }
  return "transient";
}

/** 取给用户看的中文原因；错误对象由 api.request 构造，message 已是后端中文说明。 */
export function uploadErrorMessage(e: unknown): string {
  if (e && typeof e === "object") {
    const msg = (e as { message?: unknown }).message;
    if (typeof msg === "string" && msg.trim()) return msg;
  }
  return "同步失败，请稍后重试";
}
