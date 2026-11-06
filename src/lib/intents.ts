/**
 * 前端意图客户端（P1-2）。
 *
 * 关键路径统一走：发意图（携带当前存档 + 一次性 nonce）→ 服务端裁决 →
 * 应用裁决结果到本地 store → 立即带 intentNonce 提交，由服务端精确核对增量。
 *
 * 客户端不再自己决定「捕获成功与否 / 战斗奖励 / 商店扣款 / 挂机收益」，
 * 只负责把服务端给的结果渲染出来。这样 GG 修改器改本地数值、改系统时间刷挂机
 * 都不会产生额外资源；P3 瘦终端化后再把战斗中间态也上移服务端。
 *
 * 注意：本模块单向依赖 useGameStore；store 内部用动态 import 调用本模块，
 * 避免形成顶层循环导入导致的 TDZ。
 */
import { api } from "./api";
import { commitIntent, setSyncError } from "./sync";
import { uuid } from "@/game/rules";
import { useGameStore } from "@/stores/useGameStore";
import type { SaveData } from "@/game/types";

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
  const s0 = useGameStore.getState();
  const slot = s0.slot;
  const exported = s0.exportSaveJson(slot);
  if (!exported.ok) return null;

  const nonce = uuid();
  let res: { ok: boolean; nonce: string; result: IntentResult };
  try {
    res = await api.dispatchIntent(type, {
      slot,
      nonce,
      save: exported.json,
      payload,
    });
  } catch (e: any) {
    setSyncError(e?.message ?? "操作失败，请稍后重试");
    return null;
  }

  const s1 = useGameStore.getState();
  const save = s1[`save${slot}` as "save1"] as SaveData | null;
  if (!save) return null;

  apply(res.result, save, slot);

  // 立即提交，跳过防抖：防止旧快照在裁决结果之后落库。
  const ok = await commitIntent(slot, nonce);
  if (!ok) return null;
  return res.result;
}
