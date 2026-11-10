// F18-d 剧情内容模块（2026-11-10 骨架）。
//
// 设计口径（规范 §33.5）：轻量对话 + 触发播片，**不持久化**。
// 本文件只放「内容表 + 取数纯函数」，不含任何渲染/状态逻辑；
// 触发器在 `src/lib/story.ts`，弹窗在 `src/components/StoryModal.tsx`。
//
// 债务：当前所有 beat 均为 **占位文案**（placeholder:true），仅用于支撑开发，
// 真剧情后续补全（见 未来规划与技术债 文档 F18-d 条目）。补全时把对应 beat 的
// `placeholder` 置 false 并替换 `lines` 即可，无需改动触发器与弹窗。
import type { LocationId } from "@/game/types";

/** 一行台词。speaker 省略表示旁白/系统。 */
export interface StoryLine {
  speaker?: string;
  text: string;
}

/** 触发条件。on_arrival 现已接入；on_gym_clear 由 F18-b 胜馆主后显式 fire。 */
export type StoryTrigger =
  | { type: "on_arrival"; locationId: LocationId }
  | { type: "on_gym_clear"; locationId: LocationId };

export interface StoryBeat {
  /** 稳定 id，用于同会话内去重（不落档）。 */
  id: string;
  trigger: StoryTrigger;
  /** 逐行台词。 */
  lines: StoryLine[];
  /** 预留：触发后播放的播片资源 id；当前不实现，留空。 */
  cutscene?: string;
  /** 占位标记：当前为债务文案，后续补全。 */
  placeholder?: boolean;
}

/**
 * 剧情内容表（占位）。
 * 覆盖：7 城到达 intro（on_arrival）+ 7 城演武堂通关贺词（on_gym_clear，待 F18-b 启用）。
 */
export const STORY_BEATS: StoryBeat[] = [
  // ───────────────────────── 到达 intro（现已接入） ─────────────────────────
  {
    id: "arrival_town_starter",
    trigger: { type: "on_arrival", locationId: "town_starter" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】初心镇——你旅程开始的地方。微风里夹杂着草木的清香。" },
      { speaker: "妈妈", text: "【占位】路上小心，记得带上伤药。如果幻兽受伤了，去恢复中心就好。" },
    ],
  },
  {
    id: "arrival_city_pebble",
    trigger: { type: "on_arrival", locationId: "city_pebble" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】坚石市——依山而建的繁华都市，矿洞与火山在望。" },
    ],
  },
  {
    id: "arrival_town_leafy",
    trigger: { type: "on_arrival", locationId: "town_leafy" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】绿叶镇——被茂密树冠覆盖的静谧村落。" },
    ],
  },
  {
    id: "arrival_city_spring",
    trigger: { type: "on_arrival", locationId: "city_spring" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】涌泉市——以水系生态闻名的美丽水都。" },
    ],
  },
  {
    id: "arrival_town_sun",
    trigger: { type: "on_arrival", locationId: "town_sun" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】烈阳镇——终年高温，居民热情如火。" },
    ],
  },
  {
    id: "arrival_city_shadow",
    trigger: { type: "on_arrival", locationId: "city_shadow" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】幽影市——常年不见阳光的暗淡城市，充满神秘。" },
    ],
  },
  {
    id: "arrival_town_winter",
    trigger: { type: "on_arrival", locationId: "town_winter" },
    placeholder: true,
    lines: [
      { speaker: "旁白", text: "【占位】凛冬镇——被白雪覆盖的寒冷城镇。" },
    ],
  },

  // ─────────────────── 演武堂通关贺词（F18-b 胜馆主后 fire，现占位） ───────────────────
  {
    id: "gym_town_starter",
    trigger: { type: "on_gym_clear", locationId: "town_starter" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】干得漂亮！这是初心镇演武堂的徽章，收下吧。" },
    ],
  },
  {
    id: "gym_city_pebble",
    trigger: { type: "on_gym_clear", locationId: "city_pebble" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】你的实力配得上这枚徽章！" },
    ],
  },
  {
    id: "gym_town_leafy",
    trigger: { type: "on_gym_clear", locationId: "town_leafy" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】绿叶镇的徽章，赠与值得信赖的伙伴。" },
    ],
  },
  {
    id: "gym_city_spring",
    trigger: { type: "on_gym_clear", locationId: "city_spring" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】涌泉市认可你的勇气，拿去吧。" },
    ],
  },
  {
    id: "gym_town_sun",
    trigger: { type: "on_gym_clear", locationId: "town_sun" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】烈阳般的热情，这枚徽章属于你。" },
    ],
  },
  {
    id: "gym_city_shadow",
    trigger: { type: "on_gym_clear", locationId: "city_shadow" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】幽影之中，你的意志未曾动摇。徽章归你。" },
    ],
  },
  {
    id: "gym_town_winter",
    trigger: { type: "on_gym_clear", locationId: "town_winter" },
    placeholder: true,
    lines: [
      { speaker: "馆主", text: "【占位】凛冬也无法冷却你的决心。这是最后的徽章。" },
    ],
  },
];

/** 取某地点「到达」触发的剧情节点（纯函数，便于单测）。 */
export function getArrivalBeat(locationId: LocationId): StoryBeat | null {
  return (
    STORY_BEATS.find(
      (b) => b.trigger.type === "on_arrival" && b.trigger.locationId === locationId,
    ) ?? null
  );
}

/** 取某地点「演武堂通关」触发的剧情节点（F18-b 启用，纯函数）。 */
export function getGymClearBeat(locationId: LocationId): StoryBeat | null {
  return (
    STORY_BEATS.find(
      (b) => b.trigger.type === "on_gym_clear" && b.trigger.locationId === locationId,
    ) ?? null
  );
}
