import { describe, it, expect } from "vitest";
import { STORY_BEATS, getArrivalBeat, getGymClearBeat, getMapBossClearBeat } from "./story";

describe("F18-d story beats", () => {
  it("所有 beat id 唯一、均有台词、正式文案（无占位）", () => {
    const ids = STORY_BEATS.map((b) => b.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const b of STORY_BEATS) {
      expect(b.placeholder).not.toBe(true);
      expect(b.lines.length).toBeGreaterThan(0);
      for (const l of b.lines) {
        expect(l.text).not.toContain("【占位】");
      }
    }
  });

  it("getArrivalBeat 按地点返回对应 beat", () => {
    expect(getArrivalBeat("town_starter")?.id).toBe("arrival_town_starter");
    expect(getArrivalBeat("town_winter")?.id).toBe("arrival_town_winter");
    // @ts-expect-error 非法的地点类型也应安全返回 null
    expect(getArrivalBeat("nowhere")).toBeNull();
  });

  it("getGymClearBeat 按地点返回对应 beat（F18-b 启用）", () => {
    expect(getGymClearBeat("city_pebble")?.id).toBe("gym_city_pebble");
    expect(getGymClearBeat("town_winter")?.id).toBe("gym_town_winter");
  });

  it("getMapBossClearBeat 按地图首领 id 返回对应 beat（F18-c 启用）", () => {
    expect(getMapBossClearBeat("mb_starter_guardian")?.id).toBe("mapboss_mb_starter_guardian");
    expect(getMapBossClearBeat("mb_winter_frostbite")?.id).toBe("mapboss_mb_winter_frostbite");
    expect(getMapBossClearBeat("no_such_boss")).toBeNull();
  });
});
