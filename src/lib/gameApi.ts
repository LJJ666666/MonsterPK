/**
 * P3-2 服务端存档写操作适配层。
 *
 * 客户端在这里只做两件事：把意图拼成请求体、把服务端返回的整包存档交给 store。
 * **没有任何数值计算**——治疗回多少、进化后六维、道具能不能用、技能栏满没满，
 * 全部由 `backend/src/game/mutations.ts` 判定。
 *
 * 失败分两类并统一成 `{ ok: false, reason }`：
 *  · 业务拒绝（400 + code）：直接展示服务端给的中文原因，不重试；
 *  · 未登录 / 网络失败：提示需要连接服务端——这些操作没有本地降级（与战斗同一口径）。
 */
import { api } from "./api";
import { isLoggedIn } from "./auth";
import { setRevision } from "./sessionState";

export type MutationOp =
  | "new_game"
  | "heal"
  | "use_item"
  | "evolve"
  | "learn_move"
  | "move_to_box"
  | "move_to_party"
  | "release"
  | "travel";

export type OpFailure = { ok: false; reason: string; code?: string; transient: boolean };
export type OpSuccess = {
  ok: true;
  data: string;
  revision: number;
  effect: Record<string, unknown>;
};
export type OpResult = OpSuccess | OpFailure;

export const OP_MESSAGES: Record<string, string> = {
  NO_HEAL_CENTER: "这里没有幻兽恢复中心",
  ITEM_NOT_ENOUGH: "道具不足",
  ITEM_UNKNOWN: "没有这种道具",
  ITEM_NOT_USABLE: "该道具不能在战斗外使用",
  STATUS_NOT_MATCH: "这只幻兽没有该道具能解除的状态",
  MONSTER_FAINTED: "倒下的幻兽不能使用回复道具",
  EVOLUTION_NOT_APPLICABLE: "这只幻兽无法使用该进化石",
  EVOLUTION_TARGET_INVALID: "进化目标与图鉴配置不符",
  NO_PENDING_EVOLUTION: "这只幻兽没有等待中的进化",
  MOVE_NOT_PENDING: "这个技能不在待学列表里",
  MOVE_SLOTS_FULL: "技能栏已满，需要指定要替换的技能",
  MOVE_NOT_KNOWN: "要替换的技能不在这只幻兽身上",
  PARTY_TOO_SMALL: "队伍至少保留一只幻兽",
  PARTY_FULL: "队伍已满 6 只",
  MONSTER_NOT_FOUND: "找不到这只幻兽",
  LOCATION_UNKNOWN: "没有这个地点",
  BATTLE_IN_PROGRESS: "战斗进行中，无法执行该操作",
  SAVE_NOT_FOUND: "还没有存档，请先开始游戏",
  SAVE_UNREADABLE: "服务端存档不可用",
  NAME_INVALID: "名字需要 1~12 个字符",
  STARTER_INVALID: "只能选择初始幻兽",
  SAVE_EXISTS: "该槽位已有存档",
};

export async function runGameOp(op: MutationOp, body: Record<string, unknown>): Promise<OpResult> {
  if (!isLoggedIn()) {
    return { ok: false, reason: "尚未登录，该操作需要连接服务端", code: "NOT_LOGGED_IN", transient: true };
  }
  try {
    const res = await api.gameOp(op, body);
    if (!res?.ok || typeof res.data !== "string") {
      return { ok: false, reason: "服务端没有返回存档", code: "NO_SAVE_DATA", transient: false };
    }
    const revision = Number(res.revision ?? 0);
    // P4：服务端已经写过一版，把基线版本对齐到这一版，
    // 否则后续自动上传会拿着旧 revision 去撞 409（内容其实没变，属于无谓冲突）。
    if (typeof body.slot === "number") setRevision(body.slot, revision);
    return {
      ok: true,
      data: res.data,
      revision,
      effect: (res.effect ?? {}) as Record<string, unknown>,
    };
  } catch (e) {
    const any = e as any;
    const status = typeof any?.status === "number" ? any.status : undefined;
    const code = typeof any?.code === "string" ? any.code : undefined;
    return {
      ok: false,
      code,
      reason: (code && OP_MESSAGES[code]) || any?.message || "操作失败，请稍后重试",
      transient: status === undefined || status >= 500,
    };
  }
}
