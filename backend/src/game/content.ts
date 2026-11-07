/**
 * 服务端内容表访问层（P3-1）。
 *
 * 真源是前端 `src/game/data.ts`，由 `scripts/gen-content.ts` 生成 `content.generated.ts`。
 * 不要在服务端手写技能/幻兽/克制数据：`npm run check:content` 会校验是否与真源一致。
 *
 * 有了这张表，服务端才能自己判：技能威力/命中/PP、属性克制、幻兽捕获率与成长，
 * 不再采信客户端上报的 `captureRate` / `baseRate` 等 ID 真值（P1-2 时期的残留边界）。
 */
import { CONTENT } from './content.generated';

export type Element = string;
export type MoveCategory = 'physical' | 'special' | 'status';
export type StatusType = 'none' | 'burn' | 'paralyze' | 'sleep' | 'freeze' | 'poison';
export type StatKey = 'atk' | 'def' | 'spAtk' | 'spDef' | 'spd' | 'accuracy' | 'evasion';

export type StatBlock = {
  hp: number; atk: number; def: number; spAtk: number; spDef: number; spd: number;
};

export type StatModifiers = Record<StatKey, number>;

/** 幻兽个体（与前端 MonsterInstance 对齐，只保留服务端需要的字段）。 */
export type ServerMonster = {
  id: string;
  specId: string;
  nickname?: string;
  level: number;
  exp: number;
  element: Element;
  maxHp: number;
  hp: number;
  atk: number;
  def: number;
  spAtk: number;
  spDef: number;
  spd: number;
  status: StatusType;
  moveIds: string[];
  initStats: StatBlock;
  growthRates: StatBlock;
  pendingMoves?: string[];
  pendingEvolution?: { targetId: string; condition: Record<string, unknown> };
  isShiny?: boolean;
};

export type ServerMove = {
  id: string;
  name: string;
  element: Element;
  category: MoveCategory;
  power: number;
  accuracy: number;
  pp?: number;
  priority?: number;
  target?: 'enemy' | 'self' | 'all';
  status?: { type: Exclude<StatusType, 'none'>; chance: number; target?: 'enemy' | 'self' };
  statChanges?: Array<{ stat: StatKey; stages: number; chance: number; target: 'enemy' | 'self' }>;
  healPct?: number;
  recoilPct?: number;
  flinchChance?: number;
  critChance?: number;
  multiHit?: [number, number];
  desc?: string;
};

export type ServerMonsterSpec = {
  id: string;
  dexNum: number;
  name: string;
  element: Element;
  baseHp: number;
  baseAtk: number;
  baseDef: number;
  baseSpAtk: number;
  baseSpDef: number;
  baseSpd: number;
  captureRate: number;
  learnset: Array<{ level: number; moveId: string }>;
  initStatsMax?: StatBlock;
  growthPerLevel?: { min: StatBlock; max: StatBlock };
  evolutions?: Array<{ targetId: string; condition: Record<string, unknown> }>;
};

export type ServerItem =
  | { id: string; name: string; kind: 'capture'; modifier: number; price: number; desc?: string }
  | { id: string; name: string; kind: 'heal'; heal: number; healPct?: boolean; price: number; desc?: string }
  | { id: string; name: string; kind: 'status_heal'; cures: string[]; price: number; desc?: string }
  | { id: string; name: string; kind: 'evolution'; element: Element; price: number; desc?: string }
  | { id: string; name: string; kind: 'key_item'; price: number; desc?: string };

export const MOVE_SPECS: Record<string, ServerMove> = CONTENT.moves;
export const MONSTER_SPECS: Record<string, ServerMonsterSpec> = CONTENT.monsters;
export const ITEM_SPECS: Record<string, ServerItem> = CONTENT.items;
export const THEME_TABLE: Record<string, string[]> = CONTENT.themes;
export const LOCATIONS: Record<string, any> = CONTENT.locations;
export const ELEMENT_LABEL: Record<string, string> = CONTENT.elementLabel;

/** 初始幻兽候选（新档只能从这里选）。 */
export const STARTERS: string[] = CONTENT.starters;

/** 新档出生城镇。 */
export const START_LOCATION_ID: string = CONTENT.startLocationId;

/** 新档初始背包（同时是 rebase 的上限模板）。 */
export const INITIAL_INVENTORY: Record<string, number> = CONTENT.initialInventory;

/** 挂机参数（真源 src/game/data.ts::IDLE_CONFIG）。 */
export const IDLE_CONFIG: {
  capMinutes: number;
  rollMinutes: number;
  dropChance: number;
  moneyBase: number;
  moneyPerLevel: number;
} = CONTENT.idleConfig;

/** 属性克制表：缺省 1 倍。 */
export const TYPE_CHART: Record<string, Partial<Record<string, number>>> = CONTENT.typeChart;

export function effectiveness(attacking: Element, defending: Element): number {
  return TYPE_CHART[attacking]?.[defending] ?? 1;
}

export function emptyMods(): StatModifiers {
  return { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 };
}

/** 内容表规模，health / E2E 用来确认服务端确实加载了真值而不是空表。 */
export function contentStats() {
  return {
    moves: Object.keys(MOVE_SPECS).length,
    monsters: Object.keys(MONSTER_SPECS).length,
    items: Object.keys(ITEM_SPECS).length,
    themes: Object.keys(THEME_TABLE).length,
    locations: Object.keys(LOCATIONS).length,
  };
}
