/**
 * 启动加载：从服务端取唯一真值的存档。
 *
 * 本地存档删除后，刷新页面时 store 是空的，必须先问一次 `GET /api/save`
 * 才知道这个账号有没有档。两处调用：
 *   · App 的 BootGate 在登录态下跑一次（首次进入 / 刷新）；
 *   · Auth 页登录成功后跑一次（BootGate 在未登录时已放行，不会再跑）。
 */
import { api } from "./api";
import { isLoggedIn } from "./auth";
import { setRevision } from "./sessionState";
import { useGameStore } from "@/stores/useGameStore";

/**
 * @returns 是否拿到了可用存档（false 表示服务端没有档，或这次没拉成）。
 */
export async function bootstrapSave(): Promise<boolean> {
  if (!isLoggedIn()) return false;
  try {
    const cloud: any = await api.getSave();
    // 先对齐基线版本，后续提交才带得对 revision。
    setRevision(typeof cloud?.revision === "number" ? cloud.revision : 0);
    if (cloud?.data) {
      // 权威快照不是换存档，不能打断进行中的战斗（战斗态不进存档）。
      useGameStore.getState().importSaveJson(cloud.data, { keepBattle: true });
      return true;
    }
  } catch (e: any) {
    if (e?.status === 404) {
      // 服务端确实没有存档：下一次提交即新建，基线 0 合法。
      setRevision(0);
      return false;
    }
    // 401 由 api 层的 UnauthorizedListener 统一处理；
    // 网络故障就保持空档，等实时通道的第一条 session.state 快照补上。
  }
  return false;
}
