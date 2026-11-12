// P4-1b 共享野怪：客户端只读视图。
//
// 唯一写入口是服务端 POST /api/battle/start 带 wildId（原子抢占）。
// 这里只做两件事：首次 REST 拉列表、订阅 WS 的 wild.state 全量快照并按 revision
// 幂等应用。故意不提供任何「改列表」的方法，客户端改不了别人的野怪。
import { useCallback, useEffect, useState } from "react";
import { api } from "./api";
import {
  WILD_STATE_EVENT, WILD_REFRESH_EVENT, isSessionSuspended,
  type WildMonsterView, type WildStateMessage,
} from "./sessionState";

/** 共享野怪的真实区域 id：命中内容表 LOCATIONS.wildAreas，主题与等级由服务端定。 */
export const SHARED_WILD_AREA_ID = "wild_starter";

export type WildListView = {
  areaName: string;
  revision: number;
  monsters: WildMonsterView[];
  loading: boolean;
  error: string | null;
};

const EMPTY: WildListView = {
  areaName: "", revision: -1, monsters: [], loading: true, error: null,
};

export function useWildList(
  areaId: string,
  theme: string,
  levelMin: number,
  levelMax: number,
): WildListView & { refresh: () => Promise<void> } {
  const [view, setView] = useState<WildListView>(EMPTY);

  const refresh = useCallback(async () => {
    if (isSessionSuspended()) return; // 顶号下线后不再拉任何业务数据
    try {
      const res = await api.wildList(areaId, theme, levelMin, levelMax);
      if (!res?.ok || !Array.isArray(res.monsters)) return;
      setView((prev) => {
        if (typeof res.revision === "number" && res.revision < prev.revision) return prev;
        return {
          areaName: res.areaName ?? areaId,
          revision: Number(res.revision ?? prev.revision),
          monsters: res.monsters,
          loading: false,
          error: null,
        };
      });
    } catch (e: any) {
      setView((prev) => ({ ...prev, loading: false, error: e?.message ?? "野怪列表不可用" }));
    }
  }, [areaId, theme, levelMin, levelMax]);

  useEffect(() => { void refresh(); }, [refresh]);

  useEffect(() => {
    const onState = (e: Event) => {
      const m = (e as CustomEvent<WildStateMessage>).detail;
      if (!m || m.areaId !== areaId || !Array.isArray(m.monsters)) return;
      setView((prev) => m.revision < prev.revision
        ? prev
        : { ...prev, revision: m.revision, monsters: m.monsters, loading: false, error: null });
    };
    // W5：订阅期间丢了 wild.state 时，ws 通道派发此事件，这里走 REST 重新拉全量。
    const onRefresh = () => { void refresh(); };
    window.addEventListener(WILD_STATE_EVENT, onState);
    window.addEventListener(WILD_REFRESH_EVENT, onRefresh);
    return () => {
      window.removeEventListener(WILD_STATE_EVENT, onState);
      window.removeEventListener(WILD_REFRESH_EVENT, onRefresh);
    };
  }, [areaId, refresh]);

  // WS 未连上时的兜底轮询（30s），不替代广播，只防止列表永久不动。
  useEffect(() => {
    const timer = setInterval(() => { void refresh(); }, 30_000);
    return () => clearInterval(timer);
  }, [refresh]);

  return { ...view, refresh };
}

/** 状态文案：被抢 / 已结算都要如实展示，避免玩家点了才发现 409。 */
export function wildStatusText(m: WildMonsterView): string {
  if (m.status === "claimed") return "已被挑战";
  if (m.status === "resolved") {
    if (m.result === "captured") return "已被捕获";
    if (m.result === "defeated") return "已被击败";
    return "已逃走";
  }
  return "可挑战";
}
