// F18-d 剧情内容模块（2026-11-10 骨架，2026-11-10 杰哥拍板补全正式文案）。
//
// 设计口径（规范 §33.5）：轻量对话 + 触发播片，**不持久化**。
// 本文件只放「内容表 + 取数纯函数」，不含任何渲染/状态逻辑；
// 触发器在 `src/lib/story.ts`，弹窗在 `src/components/StoryModal.tsx`。
//
// 债务已偿（2026-11-10）：原 14 个占位 beat 已全部替换为正式文案（placeholder 置 false），
// 并新增 7 个地图首领讨伐胜利 beat（on_mapboss_clear）。仅改内容表，未动触发器/弹窗结构。
import type { LocationId } from "@/game/types";

/** 一行台词。speaker 省略表示旁白/系统。 */
export interface StoryLine {
  speaker?: string;
  text: string;
}

/** 触发条件。on_arrival / on_gym_clear 已接入；on_mapboss_clear 由 F18-c 胜首领后显式 fire。 */
export type StoryTrigger =
  | { type: "on_arrival"; locationId: LocationId }
  | { type: "on_gym_clear"; locationId: LocationId }
  | { type: "on_mapboss_clear"; mapBossId: string };

export interface StoryBeat {
  /** 稳定 id，用于同会话内去重（不落档）。 */
  id: string;
  trigger: StoryTrigger;
  /** 逐行台词。 */
  lines: StoryLine[];
  /** 预留：触发后播放的播片资源 id；当前不实现，留空。 */
  cutscene?: string;
  /** 占位标记：历史债务，正式文案补全后已统一置 false。 */
  placeholder?: boolean;
}

/**
 * 剧情内容表（正式文案）。
 * 覆盖：7 城到达 intro（on_arrival）+ 7 城演武堂通关贺词（on_gym_clear）+ 7 座地图首领讨伐胜利（on_mapboss_clear）。
 * 全部为中文文案，物种/首领均用中文名（不夹带英文 id）。
 */
export const STORY_BEATS: StoryBeat[] = [
  // ───────────────────────── 到达 intro（现已接入） ─────────────────────────
  {
    id: "arrival_town_starter",
    trigger: { type: "on_arrival", locationId: "town_starter" },
    lines: [
      { speaker: "旁白", text: "初心镇被常青的草坡温柔环抱，清晨的露珠在草尖上闪着光。你旅程开始的地方，就藏在这片绿意里。" },
      { speaker: "妈妈", text: "出发前先把背包理好，伤药记得带够。外面的世界很大，但家永远在这儿等你回来。" },
      { speaker: "旁白", text: "镇口的老橡树下，一只苔羽鸮歪着头打量你——新的旅途，从这里迈出了第一步。" },
    ],
  },
  {
    id: "arrival_city_pebble",
    trigger: { type: "on_arrival", locationId: "city_pebble" },
    lines: [
      { speaker: "旁白", text: "坚石市依山而建，黑曜石铺成的街道在脚下泛着冷光，远处的火山口吐着缕缕白烟。" },
      { speaker: "商人", text: "坚石市的特产是火之石，能让特定幻兽进化。想让伙伴更上一层楼，尽管来找我。" },
      { speaker: "旁白", text: "城心的锻炉终年不熄，锤击声里，藏着这座城市硬朗而炽热的脾气。" },
    ],
  },
  {
    id: "arrival_town_leafy",
    trigger: { type: "on_arrival", locationId: "town_leafy" },
    lines: [
      { speaker: "旁白", text: "绿叶镇的树冠连成一片碧海，阳光被筛成细碎的金斑，落在湿润的泥土上。" },
      { speaker: "旁白", text: "林间溪水叮咚，潮纹螈在浅滩里甩着尾巴——这里的生灵，似乎都懂得安静地活着。" },
    ],
  },
  {
    id: "arrival_city_spring",
    trigger: { type: "on_arrival", locationId: "city_spring" },
    lines: [
      { speaker: "旁白", text: "涌泉市的水道纵横，清泉从城心的石龙口中喷涌，整座城都浸着水汽的凉意。" },
      { speaker: "游泳者", text: "水之石是我们涌泉市的骄傲！带着它，水系的伙伴能焕然一新。" },
      { speaker: "旁白", text: "倒映着云影的河面上，铁翎雀掠过，翅尖点起一圈圈温柔的涟漪。" },
    ],
  },
  {
    id: "arrival_town_sun",
    trigger: { type: "on_arrival", locationId: "town_sun" },
    lines: [
      { speaker: "旁白", text: "烈阳镇终年笼在暖橙色的光里，石板被晒得发烫，空气里浮动着焦糖般的甜香。" },
      { speaker: "旁白", text: "镇民们笑起来像晒透了的麦子，连争执都带着热乎劲儿——这是一座不会冷下来的城。" },
    ],
  },
  {
    id: "arrival_city_shadow",
    trigger: { type: "on_arrival", locationId: "city_shadow" },
    lines: [
      { speaker: "旁白", text: "幽影市常年浸在灰蓝的暮色里，霓虹与阴影交织，巷子深处传来辨别不清的低语。" },
      { speaker: "旁白", text: "幽影灵在墙角的暗处若隐若现，它不伤人，只是好奇地注视着每一个过客。" },
    ],
  },
  {
    id: "arrival_town_winter",
    trigger: { type: "on_arrival", locationId: "town_winter" },
    lines: [
      { speaker: "旁白", text: "凛冬镇被厚厚的雪盖住，呼出的白气瞬间凝成霜，世界安静得只剩踩雪的咯吱声。" },
      { speaker: "旁白", text: "远处冰封的湖面下，似乎有冰霜幼崽蜷成一团，睡得正沉。" },
    ],
  },

  // ─────────────────── 演武堂通关贺词（F18-b 胜馆主后 fire） ───────────────────
  {
    id: "gym_town_starter",
    trigger: { type: "on_gym_clear", locationId: "town_starter" },
    lines: [
      { speaker: "馆主", text: "干得漂亮！初心镇演武堂的徽章，是你踏出第一步的证明。拿着吧。" },
      { speaker: "旁白", text: "徽章入手微温，像是为你的旅程点亮了一盏灯。" },
    ],
  },
  {
    id: "gym_city_pebble",
    trigger: { type: "on_gym_clear", locationId: "city_pebble" },
    lines: [
      { speaker: "馆主", text: "你的招式像锻炉里的火一样稳。这枚徽章，配得上你的硬气。" },
    ],
  },
  {
    id: "gym_town_leafy",
    trigger: { type: "on_gym_clear", locationId: "town_leafy" },
    lines: [
      { speaker: "馆主", text: "绿叶镇崇尚顺势而为，你刚才的从容，正是我们推崇的。收下徽章。" },
    ],
  },
  {
    id: "gym_city_spring",
    trigger: { type: "on_gym_clear", locationId: "city_spring" },
    lines: [
      { speaker: "馆主", text: "涌泉市认你的沉稳。水能载舟，也能托起你的野心——拿去吧。" },
    ],
  },
  {
    id: "gym_town_sun",
    trigger: { type: "on_gym_clear", locationId: "town_sun" },
    lines: [
      { speaker: "馆主", text: "烈阳般的热情，你已经有了。这枚徽章，是给你的回礼。" },
    ],
  },
  {
    id: "gym_city_shadow",
    trigger: { type: "on_gym_clear", locationId: "city_shadow" },
    lines: [
      { speaker: "馆主", text: "幽影之中，你的意志不曾动摇。这枚徽章，归你。" },
    ],
  },
  {
    id: "gym_town_winter",
    trigger: { type: "on_gym_clear", locationId: "town_winter" },
    lines: [
      { speaker: "馆主", text: "凛冬也冷却不了你的决心。这是最后一座演武堂的徽章，恭喜你走完全程。" },
    ],
  },

  // ─────────────────── 地图首领讨伐胜利（F18-c 胜首领后 fire） ───────────────────
  {
    id: "mapboss_mb_starter_guardian",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_starter_guardian" },
    lines: [
      { speaker: "旁白", text: "草系首领垂下头，将一捧沾着晨露的素材推到你脚边——这是它守护的初心镇瑰宝。" },
      { speaker: "草帽守护者", text: "你比来时更强了。带着它们，走得更远些。" },
    ],
  },
  {
    id: "mapboss_mb_pebble_warden",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_pebble_warden" },
    lines: [
      { speaker: "旁白", text: "磐石守望者裂开的甲壳里透出火脉的微光，它默许你取走矿脉深处的馈赠。" },
      { speaker: "磐石守望", text: "火之石的暖意，分你一份。" },
    ],
  },
  {
    id: "mapboss_mb_leafy_tide",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_leafy_tide" },
    lines: [
      { speaker: "旁白", text: "碧潭之灵没入水中又浮起，吐出一串裹着水草的宝物，涟漪里满是善意。" },
      { speaker: "碧潭之灵", text: "这片林的安静，今后也托付给你了。" },
    ],
  },
  {
    id: "mapboss_mb_spring_ironwing",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_spring_ironwing" },
    lines: [
      { speaker: "旁白", text: "涌泉龙裔自高空敛翅落下，将一枚泛着水光的晶石轻放在你掌心。" },
      { speaker: "涌泉龙裔", text: "泉水不枯，馈赠不绝。拿好。" },
    ],
  },
  {
    id: "mapboss_mb_sun_emberlord",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_sun_emberlord" },
    lines: [
      { speaker: "旁白", text: "炽阳祭司周身火焰稍敛，从怀中取出一枚滚烫的火石，递向你。" },
      { speaker: "炽阳祭司", text: "烈阳认可了你。这份热，收下吧。" },
    ],
  },
  {
    id: "mapboss_mb_shadow_phantom",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_shadow_phantom" },
    lines: [
      { speaker: "旁白", text: "暗影之主散作一缕青烟，又在你的影子里凝回人形，留下一包幽暗的造物。" },
      { speaker: "暗影之主", text: "影子里藏的东西，归识货的人。" },
    ],
  },
  {
    id: "mapboss_mb_winter_frostbite",
    trigger: { type: "on_mapboss_clear", mapBossId: "mb_winter_frostbite" },
    lines: [
      { speaker: "旁白", text: "霜息巨兽呼出最后的白雾，将冰封的宝藏推到你面前，便蜷回雪中沉睡。" },
      { speaker: "霜息巨兽", text: "（低吼）……冷，但值得。" },
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

/** 取某地图首领「讨伐胜利」触发的剧情节点（F18-c 启用，纯函数）。 */
export function getMapBossClearBeat(mapBossId: string): StoryBeat | null {
  return (
    STORY_BEATS.find(
      (b) => b.trigger.type === "on_mapboss_clear" && b.trigger.mapBossId === mapBossId,
    ) ?? null
  );
}
