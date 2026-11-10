// P4-2c 单人 Boss 讨伐：客户端视图层。
//
// 唯一真值在服务端：
//  - 讨伐列表的等级 / 每日次数 / 剩余次数由 `GET /api/boss` 下发；
//  - 伤害榜来自 `BossDamageEvent` 聚合（`GET /api/boss/:id/rank`）；
//  - 开局只传 `bossId`，战斗过程仍走 `/api/battle/action`。
// 本文件没有任何「计算伤害 / 扣次数 / 写榜」的函数：客户端做这些必然被服务端拒绝。
import { api } from "./api";

export type BossMySummary = { total: number; best: number; attempts: number };

export type BossEntry = {
  bossId: string;
  name: string;
  speciesId: string;
  speciesName: string;
  level: number;
  theme: string;
  description: string;
  dailyLimit: number;
  used: number;
  held: number;
  remaining: number;
  my: BossMySummary;
};

export type BossRankRow = {
  rank: number;
  username: string;
  damage: number;
  best: number;
  attempts: number;
  isMe: boolean;
};

export type BossRank = {
  bossId: string;
  bossName: string;
  periodKey: string;
  generatedAt: string;
  entries: BossRankRow[];
  me: BossMySummary;
};

export const BOSS_DISCLAIMER = "伤害由服务端战斗结算产出；每日次数按账号计算，逃跑与放弃不扣次数";

function num(v: unknown): number {
  return typeof v === "number" && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

function parseSummary(v: unknown): BossMySummary {
  const o = (v && typeof v === "object" && !Array.isArray(v)) ? v as Record<string, unknown> : {};
  return { total: num(o.total), best: num(o.best), attempts: num(o.attempts) };
}

function isBossEntry(v: unknown): v is BossEntry {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const b = v as Record<string, unknown>;
  return typeof b.bossId === "string" && b.bossId.length > 0
    && typeof b.name === "string"
    && typeof b.level === "number" && Number.isFinite(b.level)
    && typeof b.dailyLimit === "number";
}

/** 防御性解析：非法行逐条丢弃，脏响应整份拒绝。 */
export function parseBossList(res: unknown): BossEntry[] | null {
  if (!res || typeof res !== "object" || Array.isArray(res)) return null;
  const r = res as Record<string, unknown>;
  if (r.ok !== true || !Array.isArray(r.bosses)) return null;
  return r.bosses.filter(isBossEntry).map((raw) => {
    const b = raw as unknown as Record<string, unknown>;
    return {
      bossId: str(b.bossId),
      name: str(b.name),
      speciesId: str(b.speciesId),
      speciesName: str(b.speciesName),
      level: num(b.level),
      theme: str(b.theme),
      description: str(b.description),
      dailyLimit: num(b.dailyLimit),
      used: num(b.used),
      held: num(b.held),
      remaining: num(b.remaining),
      my: parseSummary(b.my),
    };
  });
}

function isBossRankRow(v: unknown): v is BossRankRow {
  if (!v || typeof v !== "object" || Array.isArray(v)) return false;
  const r = v as Record<string, unknown>;
  return typeof r.rank === "number" && Number.isInteger(r.rank)
    && typeof r.username === "string" && r.username.length > 0
    && typeof r.damage === "number" && Number.isFinite(r.damage)
    && typeof r.best === "number" && Number.isFinite(r.best)
    && typeof r.attempts === "number" && Number.isFinite(r.attempts)
    && typeof r.isMe === "boolean";
}

export function parseBossRank(res: unknown): BossRank | null {
  if (!res || typeof res !== "object" || Array.isArray(res)) return null;
  const r = res as Record<string, unknown>;
  if (r.ok !== true || typeof r.bossId !== "string" || !Array.isArray(r.entries)) return null;
  return {
    bossId: r.bossId,
    bossName: str(r.bossName),
    periodKey: str(r.periodKey),
    generatedAt: str(r.generatedAt),
    entries: r.entries.filter(isBossRankRow),
    me: parseSummary(r.me),
  };
}

export async function fetchBossList(): Promise<BossEntry[]> {
  const list = parseBossList(await api.bossList());
  if (!list) throw new Error("讨伐列表不可用");
  return list;
}

export async function fetchBossRank(bossId: string, limit = 20): Promise<BossRank> {
  const rank = parseBossRank(await api.bossRank(bossId, limit));
  if (!rank) throw new Error("伤害榜不可用");
  return rank;
}
