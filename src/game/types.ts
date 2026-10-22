/**
 * 幻兽与技能的属性（火、水、草等），决定战斗中的伤害克制关系（效果拔群/微弱）。
 */
export type Element = 
  | "normal" | "fire" | "water" | "grass" | "electric" 
  | "ice" | "fighting" | "poison" | "ground" | "flying" 
  | "psychic" | "bug" | "rock" | "ghost" | "dragon" 
  | "dark" | "steel" | "fairy";

/**
 * 异常状态机制。
 * none: 无异常 | burn: 烧伤(每回合扣血，物攻减半) | paralyze: 麻痹(速度减半，概率无法行动) 
 * sleep: 睡眠(无法行动，概率醒来) | poison: 中毒(每回合扣血) | freeze: 冰冻(无法行动，概率解冻)
 */
export type Status = "none" | "burn" | "paralyze" | "sleep" | "poison" | "freeze";

/**
 * 技能的伤害分类。
 * physical: 物理攻击（伤害计算基于攻击方的物攻和防守方的物防）
 * special: 特殊攻击（伤害计算基于攻击方的特攻和防守方的特防）
 * status: 变化类技能（无直接伤害，用于施加异常状态或能力升降）
 */
export type MoveCategory = "physical" | "special" | "status";

/**
 * 战斗中的核心能力值与命中/闪避属性。
 */
export type Stat = "atk" | "def" | "spAtk" | "spDef" | "spd" | "accuracy" | "evasion";

/**
 * 记录战斗中能力的阶级变化（通常在 -6 到 +6 之间）。
 */
export type StatModifiers = Record<Stat, number>;

export type MoveId = string;

export type ItemId = 
  | "capsule_basic" | "capsule_prism" | "capsule_ultra" | "capsule_master" 
  | "potion_small" | "potion_medium" | "potion_large" | "potion_max"
  | "heal_antidote" | "heal_paralyze" | "heal_awake" | "heal_burn" | "heal_ice"
  | "berry_oran" | "berry_sitrus" | "berry_lum"
  | "stone_fire" | "stone_water" | "stone_leaf" | "stone_thunder"
  | "amulet_coin" | "exp_share";

export type EncounterTheme = "grass" | "cave" | "coast" | "forest" | "lake" | "volcano" | "mansion" | "snowfield";

export type LocationId = "town_starter" | "city_pebble" | "town_leafy" | "city_spring" | "town_sun" | "city_shadow" | "town_winter";

export type NpcSpec = {
  id: string;
  name: string;
  dialog: string[];
};

export type WildAreaSpec = {
  id: string;
  name: string;
  desc: string;
  levelMin: number;
  levelMax: number;
  encounters: EncounterTheme[];
};

export type LocationSpec = {
  id: LocationId;
  name: string;
  desc: string;
  hasCenter: boolean;
  hasShop: boolean;
  shop?: ItemId[];
  npcs?: NpcSpec[];
  wildAreas?: WildAreaSpec[];
};

export type StatBlock = {
  hp: number;
  atk: number;
  def: number;
  spAtk: number;
  spDef: number;
  spd: number;
};

export type EvolutionCondition = 
  | { type: "level"; level: number }
  | { type: "item"; itemId: ItemId };

/**
 * 幻兽物种的静态配置表（图鉴基础数据）。
 */
export type MonsterSpec = {
  id: string;
  dexNum: number;
  name: string;
  element: Element;
  // 以下为该物种的种族值基准
  baseHp: number;
  baseAtk: number;
  baseDef: number;
  baseSpAtk: number;
  baseSpDef: number;
  baseSpd: number;
  /** 基础捕获率（0~1之间），数值越大越容易被捕获 */
  captureRate: number;
  /** 升级可学技能表（特定等级解锁特定技能） */
  learnset: Array<{ level: number; moveId: MoveId }>;
  /** 野外遭遇时，1级初始属性生成的最大可能值（决定个体值的上限） */
  initStatsMax?: StatBlock;
  /** 每次升级时，各项能力的成长潜能（随机波动的最小/最大值） */
  growthPerLevel?: { min: StatBlock; max: StatBlock };
  /** 进化链配置 */
  evolutions?: Array<{
    targetId: string;
    condition: EvolutionCondition;
  }>;
};

/**
 * 技能的静态配置表定义。
 */
export type MoveSpec = {
  id: MoveId;
  /** 技能展示名称 */
  name: string;
  /** 技能的属性 */
  element: Element;
  /** 技能的伤害分类（物理/特殊/变化） */
  category: MoveCategory;
  /** 技能基础威力（变化类技能通常为 0） */
  power: number;
  /** 技能基础命中率（0~1之间，1代表100%命中） */
  accuracy: number;
  /** 先制优先度。数值越大越先出手（如水流喷射 priority: 1）。默认为 0。 */
  priority?: number;
  /** 技能作用目标。enemy=单体敌人，self=施法者自身，all=全体目标。 */
  target?: "enemy" | "self" | "all";
  /** 是否可以通过技能机或后天NPC教学获得。true=可学习，false/undefined=仅能通过升级自然领悟。 */
  teachable?: boolean;
  /** 专属技能限制。填入幻兽 specId 数组，代表只有这些特定幻兽才能合法掌握此技能。 */
  exclusiveTo?: string[];
  /** 附加的异常状态效果。type=状态类型，chance=触发概率(0~1)，target=作用给谁(默认enemy)。 */
  status?: { type: Exclude<Status, "none">; chance: number; target?: "enemy" | "self" };
  /** 附加的能力升降效果数组。stat=影响的属性，stages=升降阶级(-6到+6)，chance=触发概率，target=作用给谁。 */
  statChanges?: Array<{ stat: Stat; stages: number; chance: number; target: "enemy" | "self" }>;
  /** 造成伤害后，恢复自身最大HP的百分比（如吸血、光合作用）。 */
  healPct?: number;
  /** 造成伤害后，自身承受所造成伤害的百分比（反作用力伤害，如猛撞）。 */
  recoilPct?: number;
  /** 造成对方畏缩（当回合无法行动）的概率(0~1)。 */
  flinchChance?: number;
  /** 暴击概率（0~1），默认 0.05（即 5%），有些容易击中要害的技能可设为 0.125 或更高 */
  critChance?: number;
  /** 造成多段攻击的次数，例如 [2, 5] 表示攻击 2~5 次 */
  multiHit?: [number, number];
  /** 技能的文本描述说明。 */
  desc?: string;
};

export type ItemSpec =
  | { id: ItemId; name: string; kind: "capture"; modifier: number; price: number; desc?: string }
  | { id: ItemId; name: string; kind: "heal"; heal: number; healPct?: boolean; price: number; desc?: string }
  | { id: ItemId; name: string; kind: "status_heal"; cures: Status[]; price: number; desc?: string }
  | { id: ItemId; name: string; kind: "evolution"; element: Element; price: number; desc?: string }
  | { id: ItemId; name: string; kind: "key_item"; price: number; desc?: string };

/**
 * 游戏中实际存在的幻兽个体（玩家拥有的，或野外生成的实体）。
 */
export type MonsterInstance = {
  /** 个体的全局唯一标识符 (UUID) */
  id: string;
  /** 对应的幻兽物种 ID（关联 MonsterSpec） */
  specId: string;
  /** 玩家自定义的昵称 */
  nickname?: string;
  /** 当前等级 */
  level: number;
  /** 当前积累的经验值 */
  exp: number;
  /** 个体的属性（通常与物种一致，预留变异空间） */
  element: Element;
  /** 当前最大生命值 */
  maxHp: number;
  /** 当前剩余生命值 */
  hp: number;
  // 以下为当前等级下的实际能力值面板
  atk: number;
  def: number;
  spAtk: number;
  spDef: number;
  spd: number;
  /** 当前携带的异常状态 */
  status: Status;
  /** 当前掌握的技能列表（最多只能带 4 个） */
  moveIds: MoveId[];
  /** 1级时的基础六维（可理解为天生的“个体值”基数） */
  initStats: StatBlock;
  /** 每次升级固定的成长潜能（可理解为后天的“努力值”或成长率） */
  growthRates: StatBlock;
  /** 升级领悟但尚未替换到当前技能槽中的备选技能库 */
  pendingMoves?: MoveId[];
  pendingEvolution?: { targetId: string; condition: EvolutionCondition };
  /** 是否为闪光（异色）稀有形态 */
  isShiny?: boolean;
};

export type CollectionEntry = {
  seen: boolean;
  captured: boolean;
  timesCaptured: number;
  seenLocations?: LocationId[];
};

export type SaveData = {
  version: string;
  playerName: string;
  money: number;
  steps: number;
  locationId: LocationId;
  lastHealLocationId: LocationId;
  visitedLocationIds: LocationId[];
  party: MonsterInstance[];
  box: MonsterInstance[];
  inventory: Record<ItemId, number>;
  collection: Record<string, CollectionEntry>;
  lastSavedAt: string;
};

/**
 * 战斗运行时的状态数据结构。
 */
export type BattleState = {
  /** 遭遇的场景主题（决定战斗背景或氛围） */
  theme: EncounterTheme;
  areaName: string;
  levelMin: number;
  levelMax: number;
  /** 当前进行到的回合数 */
  turn: number;
  /** 战斗文字日志记录 */
  log: string[];
  /** 我方当前出战幻兽在队伍中的索引位置 */
  playerActiveIndex: number;
  /** 我方当前场上幻兽的能力阶级变化（Buff/Debuff） */
  playerStatMods: StatModifiers;
  /** 敌方当前场上幻兽的能力阶级变化（Buff/Debuff） */
  enemyStatMods: StatModifiers;
  /** 敌方野生幻兽的实体数据 */
  enemy: MonsterInstance;
  /** 战斗是否已经结束 */
  finished: boolean;
  /** 战斗结束的最终结果。captured=成功捕获，enemy_fainted=击败敌方，fled=成功逃跑，player_fainted=我方全灭。 */
  result?: "captured" | "enemy_fainted" | "fled" | "player_fainted";
};
