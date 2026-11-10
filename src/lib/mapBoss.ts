// F18-c 地图首领：前端只读列表拉取（服务端 `/api/mapboss` 返回解锁态 / 每日余量 / 掉落预览）。
import { api } from "./api";

export type MapBossDrop = { money: number; items: { itemId: string; count: number }[] };
export type MapBossEntry = {
  mapBossId: string;
  name: string;
  locationId: string;
  speciesId: string;
  speciesName: string;
  level: number;
  theme: string;
  description: string;
  dailyLimit: number;
  unlocked: boolean;
  drop: MapBossDrop;
  used: number;
  held: number;
  remaining: number;
};

/** 拉取地图首领总览（每座解锁态 / 每日余量 / 掉落预览）。 */
export async function fetchMapBossList(): Promise<MapBossEntry[]> {
  const res = await api.mapBossList();
  return Array.isArray((res as any)?.bosses) ? ((res as any).bosses as MapBossEntry[]) : [];
}
