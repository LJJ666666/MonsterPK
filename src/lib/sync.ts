// 自动云同步引擎（P0-3；P1-2 增加「裁决结果立即提交」通道；P2-2 增加「远端快照不回传」；
// P4 前置增加「写入必须带 revision 的 CAS」）。
// 设计要点：
//  - 登录后按冲突策略自动恢复（last-write-wins，必要时把云端存档拉回本地）；
//  - 本地存档变更后防抖自动 PUT（默认 1.5s），不阻塞操作；
//  - 离线 / 服务端不可达时入队，网络恢复或登录后重传；
//  - P1-2：关键路径走「发意图 → 服务端裁决 → 应用结果 → commitIntent 立即带 nonce 提交」；
//  - P2-2：应用服务端权威快照会写 store，必须抑制这一次自动上传，否则
//    「收快照 → 上传 → 再广播」会形成多端回环；本端 PUT 成功后记下 revision，
//    使自己的回显快照被幂等忽略；
//  - P4：每次 PUT / 意图都必须声明「基于第几版」。版本不符时服务端 409 并把当前
//    存档一起返回，这里直接应用那份快照——多人同时玩时以服务端为准，不覆盖别人的进度。
import { useEffect, useState } from "react";
import { api, type PutExtra } from "./api";
import { getClientId } from "./auth";
import { useGameStore } from "@/stores/useGameStore";
import { decideSyncAction, type SyncDecision } from "./syncPolicy";
import { classifyUploadError, conflictPayloadOf, uploadErrorMessage } from "./syncErrors";
import { takeRebase } from "./rebase";
import { noteRevision, setRevision, getWriteRevision } from "./sessionState";

export type SyncPhase = "idle" | "syncing" | "synced" | "offline" | "error";
export type { SyncDecision };
export { decideSyncAction };

// —— 状态订阅（供 React UI 消费）——
const listeners = new Set<(phase: SyncPhase, info?: string) => void>();
let phase: SyncPhase = "idle";
let phaseInfo: string | undefined;

function emit() {
  for (const l of listeners) l(phase, phaseInfo);
}
function setPhase(p: SyncPhase, info?: string) {
  phase = p;
  phaseInfo = info;
  emit();
}
export function getSyncPhase(): SyncPhase {
  return phase;
}

/** 供意图调用方在请求失败时把中文原因展示到同步状态行。 */
export function setSyncError(message: string): void {
  setPhase("error", message);
}

/** P1-2：取消尚未发出的防抖上传，避免旧快照在裁决结果之后落库。 */
export function cancelPendingUpload(): void {
  if (debounceTimer) {
    clearTimeout(debounceTimer);
    debounceTimer = null;
  }
  pending = null;
}

/**
 * 只读诊断信息（P1-1）：供排障与自动化回归确认「离线队列没有堆积被拒的存档」。
 */
export function getSyncDiagnostics(): { phase: SyncPhase; info?: string; queueLength: number } {
  return { phase, info: phaseInfo, queueLength: offlineQueue.length };
}
export function subscribeSync(cb: (phase: SyncPhase, info?: string) => void): () => void {
  listeners.add(cb);
  cb(phase, phaseInfo);
  return () => {
    listeners.delete(cb);
  };
}

// React 钩子：订阅同步状态
export function useSyncStatus(): { phase: SyncPhase; info?: string } {
  const [state, setState] = useState({ phase: getSyncPhase(), info: phaseInfo });
  useEffect(() => subscribeSync((p, i) => setState({ phase: p, info: i })), []);
  return state;
}

// —— 防抖上传 + 离线队列 ——
/**
 * 入队 / 防抖时还不知道该用哪一版（revision 要在真正发请求前才取），
 * 所以这里只带「附加标记」，revision 由 attemptUpload 补齐。
 */
type UploadExtra = Omit<Partial<PutExtra>, "revision">;

let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { data: string; extra?: UploadExtra } | null = null;
const offlineQueue: { data: string; extra?: UploadExtra }[] = [];

// —— P2-2：远端快照写入 store 时抑制一次自动上传 ——
let suppressUploads = 0;
/**
 * 必须在调用 importSaveJson() 之前调用；zustand 的 subscribe 是同步触发的，
 * 用 queueMicrotask 兜底清除，即使应用失败也不会永久吞掉后续合法上传。
 */
export function suppressNextUpload(): void {
  suppressUploads += 1;
  queueMicrotask(() => {
    suppressUploads = Math.max(0, suppressUploads - 1);
  });
}
function consumeSuppressedUpload(): boolean {
  if (suppressUploads <= 0) return false;
  suppressUploads -= 1;
  return true;
}

// 导出当前存档 JSON（与手动备份使用的同一个出口，保证落盘格式一致）
function exportSave(): string | null {
  const r = useGameStore.getState().exportSaveJson();
  return r.ok ? r.json : null;
}

// —— P4：写入基线版本 ——
// 探测请求合并成一个，避免首次同步时并发打好几次 GET。
let revisionProbe: Promise<number> | null = null;

/**
 * 取得写入基线版本（CAS 的 compare 部分）。
 * 本地还没有基线时问一次服务端：
 *   · 有存档 → 用它的 revision（说明这一端是「接着别人的版本改」）；
 *   · 404    → 记 0（服务端确实没有存档，本次 PUT 就是新建，基线 0 合法）。
 * 注意这里必须用 setRevision 而不是 noteRevision：换账号后新账号的版本号可能更小。
 */
async function ensureRevision(): Promise<number> {
  const known = getWriteRevision();
  if (known !== null) return known;
  if (revisionProbe) return revisionProbe;
  const probe = (async () => {
    try {
      const cloud = await api.getSave();
      const rev = typeof cloud?.revision === "number" ? cloud.revision : 0;
      setRevision(rev);
      return rev;
    } catch (e: any) {
      if (e?.status === 404) {
        setRevision(0);
        return 0;
      }
      throw e; // 网络 / 鉴权问题交给上层按 transient 处理
    } finally {
      revisionProbe = null;
    }
  })();
  revisionProbe = probe;
  return probe;
}

/** 供意图通道复用：发意图前必须知道基线版本，否则服务端无法做 CAS。 */
export const ensureWriteRevision = ensureRevision;

/**
 * P4：版本冲突就地自愈——服务端已经赢了，本地切过去。
 * 关键在于「不重试」：带旧 revision 的这份 data 永远不会被接受，
 * 反复重试只会把状态行卡在 error；正确做法是丢掉本地这份快照、应用服务端那份。
 */
function healFromConflict(e: unknown): boolean {
  const p = conflictPayloadOf(e);
  if (!p) {
    setPhase("error", "存档版本冲突，请刷新页面后重试");
    return false;
  }
  setRevision(p.revision);
  if (p.data) {
    // 与 P2-2 同样的顺序：先抑制回传，再写 store。
    suppressNextUpload();
    const r = useGameStore
      .getState()
      .importSaveJson(p.data, { keepBattle: true });
    setPhase("synced", r.ok ? "其他设备已更新，已切换为服务器版本" : "其他设备已更新，请刷新页面");
    return r.ok;
  }
  setPhase("synced", "其他设备已更新，已切换为服务器版本");
  return true;
}

/** 供意图通道复用：意图请求 409 时切到服务端版本，并让调用方把本次操作判为失败。 */
export const recoverFromConflict = healFromConflict;

async function uploadNow(data: string, extra: PutExtra): Promise<any> {
  return api.putSave(data, getClientId(), extra);
}

/**
 * 上传一次并分类结果（P1-1 / P4）。4xx 属永久失败，不入队；临时失败才入队。
 * P2-2：成功响应的 revision 记进会话态，供快照幂等判断。
 * P4：先补齐 revision 再发；409 冲突走自愈，既不重试也不入队。
 */
async function attemptUpload(
  data: string,
  extra: UploadExtra = {},
): Promise<"conflict" | "permanent" | "transient" | null> {
  let revision: number;
  try {
    revision = await ensureRevision();
  } catch {
    return "transient"; // 连基线版本都拿不到，等于离线
  }
  try {
    setPhase("syncing");
    const res = await uploadNow(data, { ...extra, revision });
    if (res && typeof res.revision === "number") noteRevision(res.revision);
    setPhase("synced", "已同步到云端");
    return null; // 成功
  } catch (e) {
    const kind = classifyUploadError(e);
    if (kind === "conflict") {
      healFromConflict(e);
      return "conflict";
    }
    if (kind === "permanent") {
      setPhase("error", uploadErrorMessage(e));
      return "permanent";
    }
    return "transient";
  }
}

export function scheduleUpload(data: string, delayMs = 1500, extra?: UploadExtra): void {
  pending = { data, extra };
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flush();
  }, delayMs);
}

async function flush(): Promise<void> {
  if (!pending) return;
  const job = pending;
  pending = null;
  const outcome = await attemptUpload(job.data, job.extra);
  if (outcome === "transient") {
    offlineQueue.push(job);
    setPhase("offline", "离线，将在网络恢复后重传");
  }
}

/**
 * P1-2：应用服务端裁决结果后**立即**提交，带上 intentNonce 让服务端核对增量。
 */
export async function commitIntent(nonce: string): Promise<boolean> {
  cancelPendingUpload();
  const data = exportSave();
  if (!data) return false;
  const outcome = await attemptUpload(data, { intentNonce: nonce });
  if (outcome === "transient") {
    offlineQueue.push({ data, extra: { intentNonce: nonce } });
    setPhase("offline", "离线，将在网络恢复后重传");
  }
  return outcome === null;
}

// 网络恢复 / 登录后，把离线队列重传一遍
function flushQueue(): void {
  if (offlineQueue.length === 0) return;
  const jobs = offlineQueue.splice(0, offlineQueue.length);
  void (async () => {
    for (const job of jobs) {
      const outcome = await attemptUpload(job.data, job.extra);
      if (outcome === "transient") {
        offlineQueue.push(job);
        setPhase("offline", "离线，将在网络恢复后重传");
      }
    }
  })();
}

// —— 登录后自动恢复（按冲突策略）——
export async function syncOnLogin(): Promise<void> {
  const local = useGameStore.getState().save;
  const localExists = !!local;
  const localTime = local?.lastSavedAt ? Date.parse(local.lastSavedAt) : 0;

  try {
    const cloud = await api.getSave();
    // P4：先对齐基线版本。换账号 / 其他设备写过之后本地记录可能过期，
    // 这里用 setRevision 强制覆盖，后续 PUT 才会带对 revision。
    setRevision(typeof cloud.revision === "number" ? cloud.revision : 0);
    const sameDevice = cloud.clientId === getClientId();
    const cloudTime = cloud.updatedAt ? Date.parse(cloud.updatedAt) : 0;
    const decision = decideSyncAction({ localExists, localTime, cloudExists: true, cloudTime, sameDevice });
    if (decision === "restore") {
      suppressNextUpload(); // 刚拉下来的云端档不必再原样传回去
      const r = useGameStore
        .getState()
        .importSaveJson(cloud.data) as { ok: boolean; reason?: string };
      if (r.ok) setPhase("synced", "已从云端恢复");
      else setPhase("error", r.reason ?? "恢复失败");
    } else if (decision === "upload") {
      const data = exportSave();
      if (data) {
        const outcome = await attemptUpload(data);
        if (outcome === null) setPhase("synced", "已将本地进度上传云端");
        else if (outcome === "transient") {
          offlineQueue.push({ data });
          setPhase("offline", "离线，将在网络恢复后重传");
        }
      } else {
        setPhase("synced");
      }
    } else {
      setPhase("synced");
    }
  } catch (e: any) {
    if (e?.status === 404) {
      // 服务端没有存档：本次上传就是新建，基线版本为 0。
      setRevision(0);
      const data = exportSave();
      if (data) {
        const outcome = await attemptUpload(data);
        if (outcome === null) setPhase("synced", "已建立云端存档");
        else if (outcome === "transient") {
          offlineQueue.push({ data });
          setPhase("offline", "离线，将在网络恢复后重传");
        }
      } else {
        setPhase("synced");
      }
    } else if (classifyUploadError(e) === "permanent") {
      setPhase("error", uploadErrorMessage(e));
    } else {
      const data = exportSave();
      if (data) offlineQueue.push({ data });
      setPhase("offline", "无法连接服务器，稍后重传");
    }
  }
  flushQueue();
}

// —— 启动自动同步：订阅 store 变更，防抖上传当前存档；并监听网络恢复 ——
let started = false;

/**
 * P4-1a 顶号：立刻停掉一切上传动作并丢弃离线队列。
 * api.request 层的只读下线态是硬闸；这里把待发任务清干净，避免弹窗确认后
 * 残留的 debounce / 离线队列在重新登录瞬间把旧改动发出去。
 */
export function stopAutoSync(): void {
  cancelPendingUpload();
  offlineQueue.length = 0;
  revisionProbe = null;
  setPhase("idle");
}

export function startAutoSync(): void {
  if (started) return;
  started = true;
  let prev = pickSave(useGameStore.getState());
  useGameStore.subscribe((state) => {
    const next = pickSave(state);
    if (next !== prev) {
      prev = next;
      // P2-2：这次变更来自服务端权威快照，不再回传，避免多端广播回环。
      if (consumeSuppressedUpload()) return;
      const data = exportSave();
      if (data) scheduleUpload(data, 1500, takeRebase() ? { rebase: true } : undefined);
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => flushQueue());
  }
}

// 取出单档做浅比较，只在存档内容真正变化时触发上传
function pickSave(s: any) {
  return s.save;
}
