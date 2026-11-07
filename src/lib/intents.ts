/**
 * 前端意图客户端（P1-2；P2-2 增加「意图在途期间不覆盖本地」保护）。
 *
 * 关键路径：发意图（携带当前存档 + 一次性 nonce）→ 服务端裁决 →
 * 应用裁决结果到本地 store → 立即带 intentNonce 提交，由服务端精确核对增量。
 *
 * P2-2：服务端会把每次写入广播给该账号所有连接。意图在途期间收到的远端快照
 * 先暂存，等 commitIntent 完成再按 revision 判断是否补应用，避免把本地尚未提交的
 * 裁决结果覆盖掉。
 */
import { api } from "./api";
import { commitIntent, ensureWriteRevision, recoverFromConflict, setSyncError } from "./sync";
import { uuid } from "@/game/rules";
import { useGameStore } from "@/stores/useGameStore";
import type { SaveData } from "@/game/types";
import { beginIntent, endIntent, setRevision, type SessionStateMessage } from "./sessionState";
import { flushDeferredSnapshot } from "./session";
import { classifyUploadError } from "./syncErrors";

export type IntentResult = Record<string, any>;

/** 应用裁决结果的回调：拿到服务端结果 + 当前存档 + 槽位，直接改 store。 */
export type IntentApply = (result: IntentResult, save: SaveData, slot: number) => void;

/**
 * 发一次意图并落地裁决结果。
 * @returns 服务端裁决结果；请求失败或提交被拒时返回 null（状态行会给出中文原因）。
 */
export async function runIntent(
  type: string,
  payload: Record<string, unknown>,
  apply: IntentApply,
): Promise<IntentResult | null> {
  beginIntent();
  try {
    const s0 = useGameStore.getState();
    const slot = s0.slot;
    const exported = s0.exportSaveJson(slot);
    if (!exported.ok) return null;

    const nonce = uuid();
    // P4：意图同样要声明基线版本。多人同时发意图时，后到的一方会被 409 拒绝，
    // 而不是两端各算一遍、后落库的静默覆盖前一方。
    let revision: number;
    try {
      revision = await ensureWriteRevision(slot);
    } catch {
      setSyncError("无法连接服务器，请稍后重试");
      return null;
    }
    let res: { ok: boolean; nonce: string; revision?: number; result: IntentResult };
    try {
      res = await api.dispatchIntent(type, {
        slot,
        nonce,
        save: exported.json,
        revision,
        payload,
      });
    } catch (e: any) {
      if (classifyUploadError(e) === "conflict") {
        recoverFromConflict(slot, e); // 服务端已更新：切过去，本次操作作废
        return null;
      }
      setSyncError(e?.message ?? "操作失败，请稍后重试");
      return null;
    }
    // P4：服务端裁决时已经写过一版，提交结果必须基于裁决后的版本号，
    // 否则 commitIntent 会拿「裁决前」的 revision 去撞自己的 CAS。
    if (typeof res.revision === "number") setRevision(slot, res.revision);

    const s1 = useGameStore.getState();
    const save = s1[`save${slot}` as "save1"] as SaveData | null;
    if (!save) return null;

    apply(res.result, save, slot);

    // 立即提交，跳过防抖：防止旧快照在裁决结果之后落库。
    const ok = await commitIntent(slot, nonce);
    if (!ok) return null;
    return res.result;
  } finally {
    const deferred = endIntent();
    if (deferred) flushDeferredSnapshot(deferred as SessionStateMessage);
  }
}
