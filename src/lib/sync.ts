/**
 * 存档写通道：版本基线探测 + 意图结果提交 + 409 自愈。
 *
 * P5 起服务端是存档唯一真值，前端不再保留任何本地副本，也不再「自动把本地状态
 * 推上去」。这个模块只剩一件事——把**服务端已裁决**的结果按版本契约提交回库：
 *
 *  1. 发意图前先问一次基线版本（ensureWriteRevision），带上与服务端做 CAS；
 *  2. 裁决结果应用后立即带 intentNonce 提交（commitIntent），服务端凭 nonce
 *     核对增量，不是客户端自由写档；
 *  3. 409 表示别处已写过，直接切到服务端那份（recoverFromConflict），不重试——
 *     带旧版本的那份数据永远不会被接受，重试只会把状态行卡死在 error。
 *
 * 2026-11-13 删除的历史包袱（都建立在「本地也有一份真值」的错误前提上）：
 *   · localStorage 存档持久化（zustand persist + 自定义 storage）；
 *   · 防抖自动上传与离线重传队列；
 *   · 登录时按时间戳 last-write-wins 的冲突决策（syncPolicy）；
 *   · rebase 授权标记（新建/导入存档时通知服务端重建基线）；
 *   · suppressNextUpload（抑制「收到快照又原样传回」的回环）——
 *     现在没有自动上传，回环天然不存在。
 */
import { useEffect, useState } from "react";
import { api, type PutExtra } from "./api";
import { getClientId } from "./auth";
import { useGameStore } from "@/stores/useGameStore";
import { classifyUploadError, conflictPayloadOf, uploadErrorMessage } from "./syncErrors";
import { noteRevision, setRevision, getWriteRevision } from "./sessionState";

export type SyncPhase = "idle" | "submitting" | "committed" | "error";

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

/** 供意图调用方在请求失败时把中文原因展示到提交状态行。 */
export function setSyncError(message: string): void {
  setPhase("error", message);
}

export function subscribeSync(cb: (phase: SyncPhase, info?: string) => void): () => void {
  listeners.add(cb);
  cb(phase, phaseInfo);
  return () => {
    listeners.delete(cb);
  };
}

/** React 钩子：订阅提交状态。 */
export function useSyncStatus(): { phase: SyncPhase; info?: string } {
  const [state, setState] = useState({ phase: getSyncPhase(), info: phaseInfo });
  useEffect(() => subscribeSync((p, i) => setState({ phase: p, info: i })), []);
  return state;
}

/** 导出当前存档 JSON（与手动备份同一出口，保证落盘格式一致）。 */
function exportSave(): string | null {
  const r = useGameStore.getState().exportSaveJson();
  return r.ok ? r.json : null;
}

// —— 写入基线版本 ——
// 探测请求合并成一个，避免首次提交时并发打好几次 GET。
let revisionProbe: Promise<number> | null = null;

/**
 * 取得写入基线版本（CAS 的 compare 部分）。
 * 本地还没有基线时问一次服务端：
 *   · 有存档 → 用它的 revision（说明这一端是「接着服务端的版本改」）；
 *   · 404    → 记 0（服务端确实没有存档，本次提交就是新建，基线 0 合法）。
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
      throw e; // 网络 / 鉴权问题交给上层按失败处理
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
 * 版本冲突就地自愈——服务端已经赢了，本地切过去。
 * 关键在于「不重试」：带旧 revision 的这份 data 永远不会被接受。
 */
function healFromConflict(e: unknown): boolean {
  const p = conflictPayloadOf(e);
  if (!p) {
    setPhase("error", "存档版本冲突，请刷新页面后重试");
    return false;
  }
  setRevision(p.revision);
  if (p.data) {
    const r = useGameStore.getState().importSaveJson(p.data, { keepBattle: true });
    setPhase("committed", r.ok ? "其他设备已更新，已切换为服务器版本" : "其他设备已更新，请刷新页面");
    return r.ok;
  }
  setPhase("committed", "其他设备已更新，已切换为服务器版本");
  return true;
}

/** 供意图通道复用：意图请求 409 时切到服务端版本，并让调用方把本次操作判为失败。 */
export const recoverFromConflict = healFromConflict;

async function uploadNow(data: string, extra: PutExtra): Promise<any> {
  return api.putSave(data, getClientId(), extra);
}

/**
 * P1-2：应用服务端裁决结果后**立即**提交，带上 intentNonce 让服务端核对增量。
 * @returns 是否提交成功；失败时状态行已给出中文原因（4xx）或保持静默（网络）。
 */
export async function commitIntent(nonce: string): Promise<boolean> {
  const data = exportSave();
  if (!data) return false;

  let revision: number;
  try {
    revision = await ensureRevision();
  } catch {
    // 连基线版本都拿不到 = 连不上服务端。裁决结果留在界面上，下次操作会重新走完整流程。
    setPhase("error", "无法连接服务器，本次改动未提交");
    return false;
  }

  try {
    setPhase("submitting");
    const res = await uploadNow(data, { intentNonce: nonce, revision });
    if (res && typeof res.revision === "number") noteRevision(res.revision);
    setPhase("committed", "已提交至服务端");
    return true;
  } catch (e) {
    if (classifyUploadError(e) === "conflict") {
      healFromConflict(e);
      return false;
    }
    setPhase("error", uploadErrorMessage(e));
    return false;
  }
}

/**
 * P4-1a 顶号：停掉写通道并清空状态。
 * 顶号后本设备的 token 已失效，任何提交都会被 403 SESSION_REPLACED 拒绝；
 * 这里把相位复位，避免状态行残留「已提交」误导玩家。
 */
export function stopWriteChannel(): void {
  revisionProbe = null;
  setPhase("idle");
}
