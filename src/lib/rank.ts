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

// ————————————————— F01/F02：周期榜与奖励（只读视图层） —————————————————
// 与本期榜同一原则：客户端只做防御性解析与展示，不计算名次、不上报奖励、不提供领取。

export type RewardView = { money: number; items: { itemId: string; count: number }[] };
export type RankPeriodInfo = {
  currentPeriodKey: string;
  previousPeriodKey: string;
  rewardMaxRank: number;
  boards: { boardKey: string; label: string; rewardTiers: { rank: number; reward: RewardView }[] }[];
  periods: { periodKey: string; settledAt: string }[];
};
export type PeriodBoard = { boardKey: string; label: string; settledAt: string; entries: RankRow[] };
export type PeriodBoards = { periodKey: string; boards: PeriodBoard[] };
export type MyReward = {
  periodKey: string;
  boardKey: string;
  label: string;
  rank: number;
  reward: RewardView;
  revision: number;
  grantedAt: string;
};
export type MyRewards = { entries: MyReward[] };

function isObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}

function isPeriodKey(v: unknown): v is string {
  return typeof v === "string" && /^\d{4}-\d{2}-\d{2}$/.test(v);
}

function parseRewardView(v: unknown): RewardView {
  if (!isObject(v)) return { money: 0, items: [] };
  const money = typeof v.money === "number" && Number.isFinite(v.money) ? Math.max(0, v.money) : 0;
  const items = Array.isArray(v.items)
    ? v.items.filter(isObject)
      .filter((it) => typeof it.itemId === "string" && typeof it.count === "number")
      .map((it) => ({ itemId: it.itemId as string, count: Math.floor(it.count as number) }))
    : [];
  return { money, items };
}

/** 防御性解析：脏响应一律不进 UI；周期列表逐条过滤非法键。 */
export function parseRankPeriods(res: unknown): RankPeriodInfo | null {
  if (!isObject(res) || res.ok !== true || res.readonly !== true) return null;
  if (!isPeriodKey(res.currentPeriodKey) || !isPeriodKey(res.previousPeriodKey)) return null;
  const periods = Array.isArray(res.periods)
    ? res.periods.filter(isObject)
      .filter((p) => isPeriodKey(p.periodKey) && typeof p.settledAt === "string")
      .map((p) => ({ periodKey: p.periodKey as string, settledAt: p.settledAt as string }))
    : [];
  const boards = Array.isArray(res.boards)
    ? res.boards.filter(isObject)
      .filter((b) => typeof b.boardKey === "string" && typeof b.label === "string")
      .map((b) => ({
        boardKey: b.boardKey as string,
        label: b.label as string,
        rewardTiers: Array.isArray(b.rewardTiers)
          ? b.rewardTiers.filter(isObject)
            .filter((t) => typeof t.rank === "number")
            .map((t) => ({ rank: t.rank as number, reward: parseRewardView(t.reward) }))
          : [],
      }))
    : [];
  return {
    currentPeriodKey: res.currentPeriodKey,
    previousPeriodKey: res.previousPeriodKey,
    rewardMaxRank: typeof res.rewardMaxRank === "number" ? res.rewardMaxRank : 10,
    boards,
    periods,
  };
}

export function parsePeriodBoards(res: unknown): PeriodBoards | null {
  if (!isObject(res) || res.ok !== true || res.readonly !== true || !isPeriodKey(res.periodKey)) return null;
  if (!Array.isArray(res.boards)) return null;
  const boards = res.boards.filter(isObject)
    .filter((b) => typeof b.boardKey === "string" && Array.isArray(b.entries))
    .map((b) => ({
      boardKey: b.boardKey as string,
      label: typeof b.label === "string" ? b.label : "",
      settledAt: typeof b.settledAt === "string" ? b.settledAt : "",
      entries: (b.entries as unknown[]).filter(isRankRow),
    }));
  return { periodKey: res.periodKey, boards };
}

export function parseMyRewards(res: unknown): MyRewards | null {
  if (!isObject(res) || res.ok !== true || res.readonly !== true || !Array.isArray(res.entries)) return null;
  const entries = res.entries.filter(isObject)
    .filter((e) => isPeriodKey(e.periodKey) && typeof e.rank === "number" && typeof e.label === "string")
    .map((e) => ({
      periodKey: e.periodKey as string,
      boardKey: typeof e.boardKey === "string" ? e.boardKey : "",
      label: e.label as string,
      rank: Math.max(1, Math.floor(e.rank as number)),
      reward: parseRewardView(e.reward),
      revision: typeof e.revision === "number" ? e.revision : 0,
      grantedAt: typeof e.grantedAt === "string" ? e.grantedAt : "",
    }));
  return { entries };
}

export async function fetchRankPeriods(): Promise<RankPeriodInfo> {
  const info = parseRankPeriods(await api.rankPeriods());
  if (!info) throw new Error("周期榜数据不可用");
  return info;
}

export async function fetchPeriodBoards(periodKey: string): Promise<PeriodBoards> {
  const data = parsePeriodBoards(await api.rankPeriodBoard(periodKey));
  if (!data) throw new Error("该周期榜单不可用");
  return data;
}

export async function fetchMyRewards(): Promise<MyRewards> {
  const data = parseMyRewards(await api.rankRewards());
  if (!data) throw new Error("奖励记录不可用");
  return data;
}

/** 只读文案：奖励内容由服务端下发，客户端不拼装数值真值。 */
export function formatReward(reward: RewardView): string {
  const parts: string[] = [];
  if (reward.money > 0) parts.push(`金币 ${reward.money}`);
  for (const it of reward.items) if (it.count > 0) parts.push(`道具 ${it.itemId} ×${it.count}`);
  return parts.length ? parts.join(" · ") : "无";
}
