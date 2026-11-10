// F18-b 演武堂只读客户端：概览来自 `/api/gym/overview`（权威，含每座馆主的冷却与徽章归属）。
// 与 `lib/boss.ts` 同一思路——客户端不算冷却、不判归属，只把服务端下发的值规整成稳定结构。
import { api } from "./api";

export type GymEntry = {
  locationId: string;
  leaderName: string;
  aceSpeciesId: string;
  aceLevel: number;
  badgeId: string | null;
  badgeOwned: boolean;
  onCooldown: boolean;
  cooldownUntil: number;
};

export async function fetchGymOverview(): Promise<GymEntry[]> {
  const res = (await api.gymOverview()) as any;
  const gyms = res?.gyms;
  if (!Array.isArray(gyms)) return [];
  return gyms.map((g: any) => ({
    locationId: String(g.locationId ?? ""),
    leaderName: String(g.leaderName ?? ""),
    aceSpeciesId: String(g.aceSpeciesId ?? ""),
    aceLevel: Number(g.aceLevel ?? 0),
    badgeId: g.badgeId ?? null,
    badgeOwned: !!g.badgeOwned,
    onCooldown: !!g.onCooldown,
    cooldownUntil: Number(g.cooldownUntil ?? 0),
  }));
}
