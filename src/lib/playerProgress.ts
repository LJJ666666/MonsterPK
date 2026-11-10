// F04 徽章 / 成就：客户端只读视图层。
//
// 唯一真值在服务端 `GET /api/player/progress`（等级 = 基础 5 + Σ徽章加成）。
// 本文件只做防御性解析与展示，**不计算等级、不上报字段、没有领取入口**。
import { api } from "./api";

export type BadgeView = {
  id: string;
  name: string;
  locationName: string;
  levelBonus: number;
  desc: string;
};
export type BadgeCatalogItem = BadgeView & { owned: boolean };
export type AchievementView = {
  id: string;
  name: string;
  desc: string;
  bonusText: string[];
};
export type StatBonus = {
  scope: "all" | "element";
  element?: string;
  stat: string;
  amount: number;
};
export type PlayerProgress = {
  level: number;
  cap: number;
  baseLevel: number;
  badgeBonus: number;
  badgeCount: number;
  badges: BadgeView[];
  achievements: AchievementView[];
  bonuses: StatBonus[];
  readonly: true;
};
export type PlayerProgressResponse = {
  ok: boolean;
  readonly: true;
  progress: PlayerProgress;
  /** 全部徽章清单（含未获得灰态），由服务端下发，前端不硬编码内容表。 */
  catalog: BadgeCatalogItem[];
  /** F18-a 地图锁：服务端权威下发的已解锁城镇 id 集合，前端仅用于灰显，最终以服务端 travel 校验为准。 */
  unlockedLocations: string[];
};

export const PROGRESS_DISCLAIMER =
  "人物等级由徽章加成决定，等级帽超帽不降级、只冻结升级；数据由服务端裁决，此处仅查看。";

function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.trunc(v) : fallback;
}
function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** 脏响应一律返回 null，交给 UI 显示中文错误，不静默渲染半截数据。 */
export function parsePlayerProgress(raw: unknown): PlayerProgressResponse | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const p = r.progress;
  if (!p || typeof p !== "object") return null;
  const s = p as Record<string, unknown>;
  const progress: PlayerProgress = {
    level: num(s.level, 5),
    cap: num(s.cap, 5),
    baseLevel: num(s.baseLevel, 5),
    badgeBonus: num(s.badgeBonus),
    badgeCount: num(s.badgeCount),
    badges: arr(s.badges).map((x) => {
      const b = (x ?? {}) as Record<string, unknown>;
      return {
        id: String(b.id ?? ""), name: String(b.name ?? ""),
        locationName: String(b.locationName ?? ""), levelBonus: num(b.levelBonus),
        desc: String(b.desc ?? ""),
      };
    }),
    achievements: arr(s.achievements).map((x) => {
      const a = (x ?? {}) as Record<string, unknown>;
      return {
        id: String(a.id ?? ""), name: String(a.name ?? ""),
        desc: String(a.desc ?? ""),
        bonusText: arr(a.bonusText).map(String),
      };
    }),
    bonuses: arr(s.bonuses).map((x) => {
      const b = (x ?? {}) as Record<string, unknown>;
      return {
        scope: b.scope === "element" ? "element" : "all",
        ...(b.element ? { element: String(b.element) } : {}),
        stat: String(b.stat ?? ""), amount: num(b.amount),
      } as StatBonus;
    }),
    readonly: true,
  };
  const catalog: BadgeCatalogItem[] = arr(r.catalog).map((x) => {
    const b = (x ?? {}) as Record<string, unknown>;
    return {
      id: String(b.id ?? ""), name: String(b.name ?? ""),
      locationName: String(b.locationName ?? ""), levelBonus: num(b.levelBonus),
      desc: String(b.desc ?? ""), owned: b.owned === true,
    };
  });
  const unlockedLocations = arr(r.unlockedLocations).map(String);
  return { ok: r.ok === true, readonly: true, progress, catalog, unlockedLocations };
}

export async function fetchPlayerProgress(): Promise<PlayerProgressResponse> {
  const parsed = parsePlayerProgress(await api.playerProgress());
  if (!parsed) throw new Error("进度数据不可用");
  return parsed;
}
