// F18-d 剧情薄触发器（2026-11-10 骨架）。
//
// 基于已同步的权威状态（locationId）派生触发，不新增存档字段、不持久化。
// 同会话内用模块级 Set 去重；重载页面即释放（满足 §33.5「跑完即释放，状态不入档」）。
//
// 接入点：
//  - on_arrival：useStoryTriggers 监听 save.locationId 变化，自动 fire 对应 beat。
//  - on_gym_clear：F18-b 胜馆主后调用返回的 fire(getGymClearBeat(loc.id)) 显式触发。
import { useCallback, useEffect, useRef, useState } from "react";
import { useGameStore } from "@/stores/useGameStore";
import { getArrivalBeat, getGymClearBeat, type StoryBeat } from "@/game/story";
import type { LocationId } from "@/game/types";

/** 同会话已播放过的 beat id，避免重复触发。模块级 = 不落档、重载即清。 */
const firedSession = new Set<string>();

export function useStoryTriggers() {
  const locationId = useGameStore((s) => s.save?.locationId);
  const [activeBeat, setActiveBeat] = useState<StoryBeat | null>(null);
  const prevLoc = useRef<LocationId | null>(null);

  /** 显式触发一个 beat（F18-b 胜馆主后调用）。已播放过的不再重复。 */
  const fire = useCallback((beat: StoryBeat | null) => {
    if (!beat || firedSession.has(beat.id)) return;
    firedSession.add(beat.id);
    setActiveBeat(beat);
  }, []);

  // on_arrival：locationId 变化时（含首帧）自动触发对应 intro。
  useEffect(() => {
    if (!locationId || locationId === prevLoc.current) return;
    prevLoc.current = locationId;
    const beat = getArrivalBeat(locationId);
    if (beat && !firedSession.has(beat.id)) {
      firedSession.add(beat.id);
      setActiveBeat(beat);
    }
  }, [locationId]);

  const dismiss = useCallback(() => setActiveBeat(null), []);

  return { activeBeat, dismiss, fire };
}

/** F18-b 便捷入口：胜馆主后直接 fire 对应贺词 beat（届时在演武堂结算成功处调用）。 */
export function fireGymClearBeat(locationId: LocationId, fire: (b: StoryBeat | null) => void) {
  fire(getGymClearBeat(locationId));
}
