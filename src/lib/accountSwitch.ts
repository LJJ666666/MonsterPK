/**
 * 账号边界：退出登录 / 换成另一个账号时，把「上一个账号」留在内存里的东西清干净。
 *
 * 背景（2026-11-15 真机复现）：本地存档删除后 store.save 只是服务端快照的渲染副本，
 * 但它留在内存里不会自己消失。用户从 gametest001 退出、注册 aabbcc 登录后，
 * GET /api/save 返回 404（新账号没建档），bootstrapSave 早先只置 revision=0 就返回，
 * 于是 Start 显示「继续旅程」、Camp 用旧账号的图鉴/金钱渲染，看着像能玩；
 * 可任何写操作都以 aabbcc 身份打到服务端，一律 404 SAVE_NOT_FOUND
 * ——截图里那条红字「还没有存档，请先开始游戏」就是这么来的。
 *
 * 这里统一处理：停实时通道与写通道、丢渲染副本、清 revision 基线与权威态视图。
 * 注意「清」不是「写」：不产生任何真值，服务端存档不受影响。
 */
import { useGameStore } from "@/stores/useGameStore";
import { clearToken } from "./auth";
import { stopRealtime } from "./ws";
import { stopWriteChannel } from "./sync";
import { forgetAllRevisions } from "./sessionState";
import { resetSessionView } from "./session";

/** 只清内存态，不动 token。登录成功后、写入新 token 之前调用。 */
export function resetAccountState(): void {
  stopRealtime();
  stopWriteChannel();
  useGameStore.getState().resetLocalSave();
  forgetAllRevisions();
  resetSessionView();
}

/** 退出登录：在 resetAccountState 之外再清掉 token。 */
export function signOut(): void {
  resetAccountState();
  clearToken();
}
