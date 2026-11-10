/**
 * P4-2a 只读派生榜（纯逻辑层）。
 *
 * 榜单是「服务端存档真值 → 派生 → 只读下发」的读模型：
 * 客户端**没有任何写入口**，也不能上报战力 / 等级 / 进度 / 分数。
 * 本文件不查库、不写档、不碰 revision，输入是已解析且已通过存档校验的对象。
 *
 * 四类榜（杰哥暂定）：单宠战力 / 全队战力 / 召唤师等级 / 推图。
 * 「召唤师等级」当前 SaveData 没有 playerLevel 字段，按契约**派生**而不加持久化字段，
 * 避免联动 SCHEMA_VERSION / EXPECTED_SAVE_VERSION / migrate 三处。
 */
import {
  POWER_DISCLAIMER, monsterPower, partyPower, bestMonsterPower,
} from './power';
import { BASE_PLAYER_LEVEL } from './playerLevel.js';

export const RANK_TYPES = [
  'monster_power', 'team_power', 'summoner_level', 'progress',
] as const;
export type RankType = typeof RANK_TYPES[number];

export type RankMeta = {
  type: RankType;
  label: string;
  unit: string;
  description: string;
  disclaimer: string;
};

export const RANK_META: Record<RankType, RankMeta> = {
  monster_power: {
    type: 'monster_power', label: '单宠战力', unit: '战力',
    description: '队伍与箱子中六维总和最高的一只',
    disclaimer: POWER_DISCLAIMER,
  },
  team_power: {
    type: 'team_power', label: '全队战力', unit: '战力',
    description: '出战队伍各只六维总和之和（不含箱子）',
    disclaimer: POWER_DISCLAIMER,
  },
  summoner_level: {
    type: 'summoner_level', label: '召唤师等级', unit: '级',
    description: '服务端徽章真值：基础 Lv.5 + 每枚徽章等级加成；账号等级与宠物等级帽见规范 §31',
    disclaimer: '等级来自服务端徽章发放记录，客户端上报无效',
  },
  progress: {
    type: 'progress', label: '推图', unit: '区',
    description: '已首通区域数量，同数量时比较最高区域难度',
    disclaimer: '按服务端 clearedAreas 统计，客户端上报无效',
  },
};

/** 派生指标：全部来自存档，全部只读。 */
export type RankMetrics = {
  monsterPower: number;
  teamPower: number;
  summonerLevel: number;
  clearedCount: number;
  maxClearedLevel: number;
  dexCaptured: number;
  partyLevelSum: number;
  partySize: number;
};

export type RankSource = {
  userId: string;
  username: string;
  metrics: RankMetrics;
};

export type RankRow = {
  rank: number;
  username: string;
  value: number;
  secondary: number;
  detail: string;
  isMe: boolean;
};

export function parseRankType(v: unknown): RankType | null {
  return typeof v === 'string' && (RANK_TYPES as readonly string[]).includes(v)
    ? (v as RankType)
    : null;
}

function finite(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

function clamp(v: number, min: number, max: number): number {
  if (!Number.isFinite(v)) return min;
  return Math.min(Math.max(Math.trunc(v), min), max);
}

/**
 * 从已解析的存档对象派生榜单指标。
 * 非对象返回 null（脏档不上榜）；字段缺失按 0 处理，绝不采信额外上报字段。
 */
export function deriveMetrics(save: unknown): RankMetrics | null {
  if (!save || typeof save !== 'object' || Array.isArray(save)) return null;
  const s = save as Record<string, unknown>;
  const party = Array.isArray(s.party) ? s.party : [];
  const box = Array.isArray(s.box) ? s.box : [];
  const cleared = (s.clearedAreas && typeof s.clearedAreas === 'object'
    && !Array.isArray(s.clearedAreas))
    ? Object.values(s.clearedAreas as Record<string, unknown>) : [];
  const collection = (s.collection && typeof s.collection === 'object'
    && !Array.isArray(s.collection))
    ? Object.values(s.collection as Record<string, unknown>) : [];

  const clearedCount = cleared.length;
  const maxClearedLevel = cleared.reduce<number>((max, a) => {
    const lv = a && typeof a === 'object' ? finite((a as Record<string, unknown>).level) : 0;
    return Math.max(max, Math.trunc(lv));
  }, 0);
  const dexCaptured = collection.filter((c) => {
    if (!c || typeof c !== 'object') return false;
    const e = c as Record<string, unknown>;
    return e.captured === true || finite(e.timesCaptured) > 0;
  }).length;
  const partyLevelSum = party.reduce((sum, m) => (
    sum + (m && typeof m === 'object'
      ? Math.trunc(finite((m as Record<string, unknown>).level)) : 0)
  ), 0);
  const partySize = party.filter((m) => m && typeof m === 'object').length;

  return {
    monsterPower: bestMonsterPower(party as any[], box as any[]),
    teamPower: partyPower(party as any[]),
    // F04：占位派生已下线。纯函数层只给基础等级，真值由 modules/rank.ts
    // 用服务端 BadgeGrant 覆盖（存档里的任何等级字段都影响不了榜单）。
    summonerLevel: BASE_PLAYER_LEVEL,
    clearedCount,
    maxClearedLevel,
    dexCaptured,
    partyLevelSum,
    partySize,
  };
}

/** 主排序值；推图榜把「最高难度」作为 secondary，不混进主数值。 */
export function rankValue(type: RankType, m: RankMetrics): { value: number; secondary: number } {
  switch (type) {
    case 'monster_power': return { value: m.monsterPower, secondary: m.teamPower };
    case 'team_power': return { value: m.teamPower, secondary: m.partySize };
    case 'summoner_level': return { value: m.summonerLevel, secondary: m.dexCaptured };
    case 'progress': return { value: m.clearedCount, secondary: m.maxClearedLevel };
    default: return { value: 0, secondary: 0 };
  }
}

export function detailOf(type: RankType, m: RankMetrics): string {
  switch (type) {
    case 'monster_power': return `队伍/箱子最强一只 · 全队 ${m.teamPower}`;
    case 'team_power': return `出战 ${m.partySize} 只六维总和`;
    case 'summoner_level':
      return `徽章真值 · 首通 ${m.clearedCount} 区 · 图鉴 ${m.dexCaptured}`;
    case 'progress': return `最高区域 Lv.${m.maxClearedLevel} · 图鉴 ${m.dexCaptured}`;
    default: return '';
  }
}

/**
 * 生成榜单：按主值 → 次值 → 用户名稳定降序，同分也完全可复现。
 * limit 由调用方钳制；viewerUserId 只用于给前端标「我」，不参与排序。
 */
export function buildBoard(
  type: RankType,
  sources: RankSource[],
  limit = 20,
  viewerUserId?: string,
): RankRow[] {
  const scored = (Array.isArray(sources) ? sources : [])
    .filter((s) => s && s.metrics && typeof s.username === 'string')
    .map((s) => {
      const { value, secondary } = rankValue(type, s.metrics);
      return {
        username: s.username,
        value: clamp(value, 0, 1e12),
        secondary: clamp(secondary, 0, 1e12),
        detail: detailOf(type, s.metrics),
        isMe: !!viewerUserId && viewerUserId === s.userId,
      };
    });
  scored.sort((a, b) => (
    b.value - a.value
    || b.secondary - a.secondary
    || a.username.localeCompare(b.username)
  ));
  return scored.slice(0, clamp(limit, 1, 50)).map((row, i) => ({ rank: i + 1, ...row }));
}

/** 单宠战力的裸值，供单测/E2E 直接对照公式（不经过榜单排序）。 */
export function rawMonsterPower(m: unknown): number {
  return monsterPower(m as any);
}
