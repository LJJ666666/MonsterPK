// 自动云同步引擎（P0-3；P1-2 增加「裁决结果立即提交」通道；P2-2 增加「远端快照不回传」）。
// 设计要点：
//  - 登录后按冲突策略自动恢复（last-write-wins，必要时把云端存档拉回本地）；
//  - 本地存档变更后防抖自动 PUT（默认 1.5s），不阻塞操作；
//  - 离线 / 服务端不可达时入队，网络恢复或登录后重传；
//  - P1-2：关键路径走「发意图 → 服务端裁决 → 应用结果 → commitIntent 立即带 nonce 提交」；
//  - P2-2：应用服务端权威快照会写 store，必须抑制这一次自动上传，否则
//    「收快照 → 上传 → 再广播」会形成多端回环；本端 PUT 成功后记下 revision，
//    使自己的回显快照被幂等忽略。
import { useEffect, useState } from "react";
import { api, type PutExtra } from "./api";
import { getClientId } from "./auth";
import { useGameStore } from "@/stores/useGameStore";
import { decideSyncAction, type SyncDecision } from "./syncPolicy";
import { classifyUploadError, uploadErrorMessage } from "./syncErrors";
import { takeRebase } from "./rebase";
import { noteRevision } from "./sessionState";

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
let debounceTimer: ReturnType<typeof setTimeout> | null = null;
let pending: { slot: number; data: string; extra?: PutExtra } | null = null;
const offlineQueue: { slot: number; data: string; extra?: PutExtra }[] = [];

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

// 导出当前槽位的存档 JSON（与手动备份使用的同一个出口，保证落盘格式一致）
function exportSlot(slot: number): string | null {
  const r = useGameStore.getState().exportSaveJson(slot as 1 | 2 | 3);
  return r.ok ? r.json : null;
}

async function uploadNow(slot: number, data: string, extra?: PutExtra): Promise<any> {
  return api.putSave(slot, data, getClientId(), extra);
}

/**
 * 上传一次并分类结果（P1-1）。4xx 属永久失败，不入队；临时失败才入队。
 * P2-2：成功响应的 revision 记进会话态，供快照幂等判断。
 */
async function attemptUpload(slot: number, data: string, extra?: PutExtra): Promise<"permanent" | "transient" | null> {
  try {
    setPhase("syncing");
    const res = await uploadNow(slot, data, extra);
    if (res && typeof res.revision === "number") noteRevision(slot, res.revision);
    setPhase("synced", "已同步到云端");
    return null; // 成功
  } catch (e) {
    if (classifyUploadError(e) === "permanent") {
      setPhase("error", uploadErrorMessage(e));
      return "permanent";
    }
    return "transient";
  }
}

export function scheduleUpload(slot: number, data: string, delayMs = 1500, extra?: PutExtra): void {
  pending = { slot, data, extra };
  if (debounceTimer) clearTimeout(debounceTimer);
  debounceTimer = setTimeout(() => {
    void flush();
  }, delayMs);
}

async function flush(): Promise<void> {
  if (!pending) return;
  const job = pending;
  pending = null;
  const outcome = await attemptUpload(job.slot, job.data, job.extra);
  if (outcome === "transient") {
    offlineQueue.push(job);
    setPhase("offline", "离线，将在网络恢复后重传");
  }
}

/**
 * P1-2：应用服务端裁决结果后**立即**提交，带上 intentNonce 让服务端核对增量。
 */
export async function commitIntent(slot: number, nonce: string): Promise<boolean> {
  cancelPendingUpload();
  const data = exportSlot(slot);
  if (!data) return false;
  const outcome = await attemptUpload(slot, data, { intentNonce: nonce });
  if (outcome === "transient") {
    offlineQueue.push({ slot, data, extra: { intentNonce: nonce } });
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
      const outcome = await attemptUpload(job.slot, job.data, job.extra);
      if (outcome === "transient") {
        offlineQueue.push(job);
        setPhase("offline", "离线，将在网络恢复后重传");
      }
    }
  })();
}

// —— 登录后自动恢复（按冲突策略）——
export async function syncOnLogin(slot: number): Promise<void> {
  const local = useGameStore.getState()[`save${slot}` as "save1"];
  const localExists = !!local;
  const localTime = local?.lastSavedAt ? Date.parse(local.lastSavedAt) : 0;

  try {
    const cloud = await api.getSave(slot);
    const sameDevice = cloud.clientId === getClientId();
    const cloudTime = cloud.updatedAt ? Date.parse(cloud.updatedAt) : 0;
    const decision = decideSyncAction({ localExists, localTime, cloudExists: true, cloudTime, sameDevice });
    if (decision === "restore") {
      const r = useGameStore
        .getState()
        .importSaveJson(cloud.data, slot as 1 | 2 | 3) as { ok: boolean; reason?: string };
      if (r.ok) setPhase("synced", "已从云端恢复");
      else setPhase("error", r.reason ?? "恢复失败");
    } else if (decision === "upload") {
      const data = exportSlot(slot);
      if (data) {
        const outcome = await attemptUpload(slot, data);
        if (outcome === null) setPhase("synced", "已将本地进度上传云端");
        else if (outcome === "transient") {
          offlineQueue.push({ slot, data });
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
      const data = exportSlot(slot);
      if (data) {
        const outcome = await attemptUpload(slot, data);
        if (outcome === null) setPhase("synced", "已建立云端存档");
        else if (outcome === "transient") {
          offlineQueue.push({ slot, data });
          setPhase("offline", "离线，将在网络恢复后重传");
        }
      } else {
        setPhase("synced");
      }
    } else if (classifyUploadError(e) === "permanent") {
      setPhase("error", uploadErrorMessage(e));
    } else {
      const data = exportSlot(slot);
      if (data) offlineQueue.push({ slot, data });
      setPhase("offline", "无法连接服务器，稍后重传");
    }
  }
  flushQueue();
}

// —— 启动自动同步：订阅 store 变更，防抖上传当前槽位；并监听网络恢复 ——
let started = false;
export function startAutoSync(): void {
  if (started) return;
  started = true;
  let prev = pickSaves(useGameStore.getState());
  useGameStore.subscribe((state) => {
    const next = pickSaves(state);
    if (next.s1 !== prev.s1 || next.s2 !== prev.s2 || next.s3 !== prev.s3) {
      prev = next;
      // P2-2：这次变更来自服务端权威快照，不再回传，避免多端广播回环。
      if (consumeSuppressedUpload()) return;
      const data = exportSlot(state.slot);
      if (data) scheduleUpload(state.slot, data, 1500, takeRebase() ? { rebase: true } : undefined);
    }
  });
  if (typeof window !== "undefined") {
    window.addEventListener("online", () => flushQueue());
  }
}

// 取出三个槽位做浅比较，只在存档内容真正变化时触发上传
function pickSaves(s: any) {
  return { s1: s.save1, s2: s.save2, s3: s.save3 };
}
