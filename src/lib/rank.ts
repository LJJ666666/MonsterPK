// P4-2a 只读派生榜：客户端视图层。
//
// 唯一真值在服务端：GET /api/rank/:type 从落库存档派生，
// 客户端既不计算战力、也不上报任何分数，只做防御性解析与展示。
// 本文件刻意不含任何「写榜 / 改榜 / 重新计算」的函数。
import { api } from "./api";

/** 与后端 game/rank.ts::RANK_TYPES 一一对应；一致性由 E2E 与单测钉住。 */
export const RANK_TABS = [
  { type: "monster_power", label: "单宠战力", unit: "战力" },
  { type: "team_power", label: "全队战力", unit: "战力" },
  { type: "summoner_level", label: "召唤师等级", unit: "级" },
  { type: "progress", label: "推图", unit: "区" },
] as const;

export type RankType = (typeof RANK_TABS)[number]["type"];

/** 与后端 POWER_DISCLAIMER 同文案，服务端下发时以服务端为准。 */
export const RANK_DISCLAIMER = "战力仅为六维总和，不代表实战强弱";

export type RankRow = {
  rank: number;
  username: string;
  slot: number;
  value: number;
  secondary: number;
  detail: string;
  isMe: boolean;
};

export type RankBoard = {
  type: RankType;
  label: string;
  unit: string;
  description: string;
  disclaimer: string;
  generatedAt: string;
  eligible: number;
  entries: RankRow[];
};

export function isRankType(v: unknown): v is RankType {
  return typeof v === "string" && RANK_TABS.some((t) => t.type === v);
}

function isRankRow(v: unknown): v is RankRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return (
    typeof r.rank === "number" && Number.isInteger(r.rank) &&
    typeof r.username === "string" && r.username.length > 0 &&
    typeof r.slot === "number" && Number.isInteger(r.slot) &&
    typeof r.value === "number" && Number.isFinite(r.value) &&
    typeof r.secondary === "number" && Number.isFinite(r.secondary) &&
    typeof r.detail === "string" &&
    typeof r.isMe === "boolean"
  );
}

/** 防御性解析：脏响应 / 缺字段一律不进 UI，非法行逐条丢弃。 */
export function parseRankBoard(res: unknown): RankBoard | null {
  if (!res || typeof res !== "object" || Array.isArray(res)) return null;
  const r = res as Record<string, unknown>;
  if (r.ok !== true || !isRankType(r.type) || !Array.isArray(r.entries)) return null;
  return {
    type: r.type,
    label: typeof r.label === "string" ? r.label : "",
    unit: typeof r.unit === "string" ? r.unit : "",
    description: typeof r.description === "string" ? r.description : "",
    disclaimer: typeof r.disclaimer === "string" ? r.disclaimer : RANK_DISCLAIMER,
    generatedAt: typeof r.generatedAt === "string" ? r.generatedAt : "",
    eligible: typeof r.eligible === "number" ? r.eligible : 0,
    entries: r.entries.filter(isRankRow),
  };
}

export function formatRankValue(type: RankType, row: RankRow): string {
  if (type === "summoner_level") return `Lv.${row.value}`;
  if (type === "progress") return `${row.value} 区`;
  return `${row.value} 战力`;
}

export function rankTabLabel(type: RankType): string {
  return RANK_TABS.find((t) => t.type === type)?.label ?? "榜单";
}

/** 拉取一张榜：调用方负责 loading / error 态，失败时抛给 UI 展示中文原因。 */
export async function fetchRankBoard(type: RankType, limit = 20): Promise<RankBoard> {
  const res = await api.rankBoard(type, limit);
  const board = parseRankBoard(res);
  if (!board) throw new Error("榜单数据不可用");
  return board;
}
