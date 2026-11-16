// F18-d 剧情触发器（2026-11-10 骨架，2026-11-16 补已读进度）。
//
// 触发源仍然是已同步的权威状态（locationId 派生），不新增 SaveData 字段、不升
// SCHEMA_VERSION：已读与否记在服务端独立表 `StoryBeatSeen`（`GET/POST /api/story/seen`）。
//
// 为什么不放在存档里：
//   1. 它只是「看过没有」这一展示事实，没有权益/数值，和 F04 徽章/成就同性质；
//   2. 塞进 SaveData 就得升 SCHEMA_VERSION + 同步后端 EXPECTED_SAVE_VERSION，
//      为了一个去重标记动存档契约不划算。
//
// 早期实现（2026-11-10 ~ 11-15）只有模块级 `firedSession`：重载页面即清空，
// 于是每次冷启动进 Camp 都会把已经看完的「到达 intro」按 3 行台词重播一遍
// （bug_log §72 观察点 1、§80）。现在冷启动会先拉服务端已读集合，
// **拉取完成前不触发**，避免「先弹出来再被收走」的闪动。
//
// 接入点：
//  - on_arrival：useStoryTriggers 监听 save.locationId 变化，自动 fire 对应 beat。
//  - on_gym_clear：F18-b 胜馆主后调用返回的 fire(getGymClearBeat(loc.id)) 显式触发。
//  - on_mapboss_clear：F18-c 胜首领后 fire(getMapBossClearBeat(id))。
import { useCallback, useEffect, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useGameStore } from "@/stores/useGameStore";
import { getArrivalBeat, getGymClearBeat, getMapBossClearBeat, type StoryBeat } from "@/game/story";
import type { LocationId } from "@/game/types";

/** 同会话已播放过的 beat id，避免同一次会话内重复触发。模块级 = 不落档、重载即清。 */
const firedSession = new Set<string>();

export function useStoryTriggers() {
  const locationId = useGameStore((s) => s.save?.locationId);
  const [activeBeat, setActiveBeat] = useState<StoryBeat | null>(null);
  /**
   * 服务端已读集合。`null` = 还没拉到 —— 此时**不触发到达 intro**，
   * 否则冷启动第一帧会先把看过的剧情弹出来，等 GET 回来再收走。
   * 拉取失败退化为空集合（等价于旧行为：只能靠 firedSession 挡同会话重复）。
   */
  const [seen, setSeen] = useState<Set<string> | null>(null);
  const prevLoc = useRef<LocationId | null>(null);

  useEffect(() => {
    let alive = true;
    void api
      .storySeen()
      .then((d: any) => {
        if (!alive) return;
        const ids = Array.isArray(d?.seen) ? d.seen.filter((x: unknown) => typeof x === "string") : [];
        setSeen(new Set(ids as string[]));
      })
      .catch(() => {
        // 拉不到就退化为「本次会话内去重」，不阻断游戏
        if (alive) setSeen(new Set());
      });
    return () => {
      alive = false;
    };
  }, []);

  const show = useCallback((beat: StoryBeat) => {
    firedSession.add(beat.id);
    setActiveBeat(beat);
  }, []);

  /** 显式触发一个 beat（F18-b / F18-c 结算后调用）。已播放过或服务端记过的不再重复。 */
  const fire = useCallback(
    (beat: StoryBeat | null) => {
      if (!beat || firedSession.has(beat.id)) return;
      if (seen?.has(beat.id)) return;
      show(beat);
    },
    [seen, show],
  );

  // on_arrival：locationId 变化时（含首帧）自动触发对应 intro。
  useEffect(() => {
    if (!locationId) return;
    if (seen === null) return; // 等已读集合到位再判断，见上方注释
    if (locationId === prevLoc.current) return;
    prevLoc.current = locationId;
    const beat = getArrivalBeat(locationId);
    if (beat && !seen.has(beat.id) && !firedSession.has(beat.id)) show(beat);
  }, [locationId, seen, show]);

  /**
   * 关闭剧情弹窗。`StoryModal` 的关闭路径只有「点继续走完最后一行」——
   * 点背景 / 点叉也走 advance，即必然看完全部台词，所以关闭即视为「看完了」。
   * 上报失败不阻断 UI：本次会话由 firedSession 挡，下次冷启动会再播一次。
   */
  const dismiss = useCallback(() => {
    const beat = activeBeat;
    setActiveBeat(null);
    if (!beat) return;
    void api
      .markStorySeen(beat.id)
      .then(() => {
        setSeen((prev) => {
          const next = new Set(prev ?? []);
          next.add(beat.id);
          return next;
        });
      })
      .catch(() => {
        /* 静默：下次冷启动重播一次即可，不影响玩法 */
      });
  }, [activeBeat]);

  return { activeBeat, dismiss, fire };
}

/** F18-b 便捷入口：胜馆主后直接 fire 对应贺词 beat（届时在演武堂结算成功处调用）。 */
export function fireGymClearBeat(locationId: LocationId, fire: (b: StoryBeat | null) => void) {
  fire(getGymClearBeat(locationId));
}

/** F18-c 便捷入口：讨伐地图首领胜利后直接 fire 对应贺词 beat（在 Arena 胜首领处调用）。 */
export function fireMapBossClearBeat(mapBossId: string, fire: (b: StoryBeat | null) => void) {
  fire(getMapBossClearBeat(mapBossId));
}
