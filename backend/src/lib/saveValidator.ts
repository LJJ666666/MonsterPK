/**
 * 服务端存档数值契约校验（P1-1；P1-1b 修订处置口径）。
 *
 * 定位：这是「服务端权威」的信任根最小版。P0-2 只校验存档的「结构」
 * （是否合法 JSON / 有没有 version、party、inventory），本模块进一步校验
 * 「数值」是否落在游戏契约允许的范围内，并识别可疑但不必然作弊的情况。
 *
 * 设计原则：
 *  1. 纯函数、零外部依赖（不连数据库、不依赖 Fastify），便于单测与复用。
 *  2. 只产出 hard / soft 两类「问题」，**不决定处置**。处置由 lib/antiCheat.ts
 *     翻译为 allow / reject / ban：管理员放行改档特征、普通账号改档即封号、
 *     结构格式问题只 400 不封号（防误封）。
 *  3. 与游戏「内容表」解耦：不硬编码 40 只幻兽 / 22 个道具 / 300+ 技能的白名单，
 *     只校验与内容无关的数值不变量。ID 真值校验与进化链校验留到 P3
 *     （服务端持有内容表、成为唯一真相来源时）再做，避免双端数据漂移。
 *  4. 客户端时间戳不再判违规：由 lib/serverClock.ts 钳制为服务端时间，
 *     让「改系统时间」只是不生效、不封号（见 checkTimestampFormat 处注释）。
 *
 * ⚠️ 能力边界（必须如实说明）：本模块能识别「明显改档」（负数、超上限、
 * NaN、超队伍容量、hp>maxHp、版本与数值异常），但挡不住「在合法范围内
 * 改数值」（例如把 money 从 100 改成 500），也看不见 GG 修改器改内存、
 * 加速器改客户端节奏。彻底防作弊依赖 P1-2 关键随机上移与 P3 服务端结算。
 */

/** 与前端 src/stores/saveVersion.ts 的 SCHEMA_VERSION 保持一致；升级版本时两处同步修改。 */
export const EXPECTED_SAVE_VERSION = 10;

/** 数值边界集中定义，便于后续按运营数据调整；每项都注明来源。 */
export const SAVE_LIMITS = {
  /** 前端测试菜单 addMoney 用 Math.min(999999, ...)，故合法上限至少 999999；留 10 倍余量防误杀长线游玩。 */
  MONEY_MAX: 9_999_999,
  /** 超过此值记软告警（疑似改钱，但测试菜单可合法达到 999999）。 */
  MONEY_WARN: 999_999,
  STEPS_MAX: 1_000_000_000,
  /** 前端 levelUp 无硬上限，野生怪 clamp 1~30；取宽松上限只挡明显伪造。 */
  LEVEL_MAX: 1_000,
  LEVEL_WARN: 100,
  /** 六维与 maxHp 上限：满个体值 + 满成长率 * 等级，正常远低于此。 */
  STAT_MAX: 100_000,
  EXP_MAX: 1_000_000_000,
  /** 前端捕获时 party.length < 6 才入队，超出即进 box。 */
  PARTY_MAX: 6,
  BOX_MAX: 2_000,
  /** 前端明确「最多带 4 个技能」。 */
  MOVES_MAX: 4,
  ITEM_STACK_MAX: 1_000_000,
  ITEM_KEYS_MAX: 128,
  COLLECTION_KEYS_MAX: 512,
  TIMES_CAPTURED_MAX: 1_000_000,
  TIMES_CAPTURED_WARN: 1_000,
  /** 允许客户端与服务端之间 5 分钟时钟偏差；超过即视为伪造时间。 */
  CLOCK_SKEW_MS: 5 * 60 * 1000,
  PLAYER_NAME_MAX: 64,
  ID_MAX: 128,
  VISITED_MAX: 64,
} as const;

/** 一条校验问题：code 便于日志检索，path 定位字段，message 为中文说明。 */
export type ValidationIssue = {
  code: string;
  path: string;
  message: string;
};

/** 校验结果：ok=false 表示存在硬违规，调用方应返回 400。 */
export type SaveValidation = {
  ok: boolean;
  /** 从存档内解析出的版本字符串，写入 Save.schemaVersion。 */
  schemaVersion: string;
  hard: ValidationIssue[];
  soft: ValidationIssue[];
  /** 摘要指标，供告警日志与后续「相邻两次存档增量校验」使用。 */
  stats: {
    money: number;
    steps: number;
    partySize: number;
    boxSize: number;
    maxLevel: number;
    totalCaptured: number;
  };
};

const ELEMENTS = new Set([
  'normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison',
  'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark',
  'steel', 'fairy',
]);
const STATUSES = new Set(['none', 'burn', 'paralyze', 'sleep', 'poison', 'freeze']);
const STAT_KEYS = ['hp', 'atk', 'def', 'spAtk', 'spDef', 'spd'] as const;

/** 有限的非负整数（金钱、步数、道具数量等必须满足）。 */
function isNonNegInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v) && v >= 0;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 收集器：统一产出 hard / soft 两类问题，避免散落的字符串拼接。 */
function createCollector() {
  const hard: ValidationIssue[] = [];
  const soft: ValidationIssue[] = [];
  return {
    hard,
    soft,
    reject(code: string, path: string, message: string) {
      hard.push({ code, path, message });
    },
    warn(code: string, path: string, message: string) {
      soft.push({ code, path, message });
    },
  };
}

/**
 * 校验单只幻兽实例的数值不变量。
 * 存在即校验；initStats/growthRates 等可选字段缺失只记告警（旧档迁移可能缺）。
 */
function validateMonster(m: unknown, path: string, c: ReturnType<typeof createCollector>): void {
  if (!isPlainObject(m)) {
    c.reject('MONSTER_NOT_OBJECT', path, '幻兽实例必须是对象');
    return;
  }
  if (typeof m.id !== 'string' || m.id.length === 0 || m.id.length > SAVE_LIMITS.ID_MAX) {
    c.reject('MONSTER_ID', `${path}.id`, '幻兽 id 必须是非空字符串');
  }
  if (typeof m.specId !== 'string' || m.specId.length === 0 || m.specId.length > SAVE_LIMITS.ID_MAX) {
    c.reject('MONSTER_SPEC_ID', `${path}.specId`, '幻兽 specId 必须是非空字符串');
  }
  // 幻兽数值同样按 FORMAT（格式错，不封号）/ RANGE（越界，可封号）两级判定。
  if (!isNonNegInt(m.level) || (m.level as number) < 1) {
    c.reject('MONSTER_LEVEL_FORMAT', `${path}.level`, `等级必须是正整数（当前 ${JSON.stringify(m.level)}）`);
  } else if ((m.level as number) > SAVE_LIMITS.LEVEL_MAX) {
    c.reject('MONSTER_LEVEL_RANGE', `${path}.level`, `等级 ${m.level} 超出上限 ${SAVE_LIMITS.LEVEL_MAX}`);
  } else if ((m.level as number) > SAVE_LIMITS.LEVEL_WARN) {
    c.warn('MONSTER_LEVEL_HIGH', `${path}.level`, `等级 ${m.level} 偏高，疑似改档或极端练级`);
  }
  if (!isNonNegInt(m.exp)) {
    c.reject('MONSTER_EXP_FORMAT', `${path}.exp`, '经验值必须是非负整数');
  } else if ((m.exp as number) > SAVE_LIMITS.EXP_MAX) {
    c.reject('MONSTER_EXP_RANGE', `${path}.exp`, `经验值 ${m.exp} 超出上限 ${SAVE_LIMITS.EXP_MAX}`);
  } else if (
    isNonNegInt(m.level) &&
    (m.exp as number) >= 16 + (m.level as number) * 18
  ) {
    // 前端 gainExp 会循环升级直到 exp 低于下一级需求，正常存档不应出现 exp 溢出。
    c.warn('MONSTER_EXP_OVERFLOW', `${path}.exp`, `经验值 ${m.exp} 已达到升级阈值却未升级，疑似改档`);
  }

  // HP 不变量：0 <= hp <= maxHp，且 maxHp 为正整数。
  if (!isNonNegInt(m.maxHp) || (m.maxHp as number) < 1) {
    c.reject('MONSTER_MAX_HP_FORMAT', `${path}.maxHp`, `maxHp 必须是正整数（当前 ${JSON.stringify(m.maxHp)}）`);
  } else if ((m.maxHp as number) > SAVE_LIMITS.STAT_MAX) {
    c.reject('MONSTER_MAX_HP_RANGE', `${path}.maxHp`, `maxHp ${m.maxHp} 超出上限 ${SAVE_LIMITS.STAT_MAX}`);
  }
  if (!isNonNegInt(m.hp)) {
    c.reject('MONSTER_HP_FORMAT', `${path}.hp`, 'hp 必须是非负整数');
  } else if (isNonNegInt(m.maxHp) && (m.hp as number) > (m.maxHp as number)) {
    // hp > maxHp 是内部矛盾（脏档或客户端算错），不是改档特征，不封号。
    c.reject('MONSTER_HP_EXCEED', `${path}.hp`, 'hp 不能超过 maxHp');
  }

  for (const key of ['atk', 'def', 'spAtk', 'spDef', 'spd']) {
    const v = m[key];
    if (!isNonNegInt(v)) {
      c.reject('MONSTER_STAT_FORMAT', `${path}.${key}`, `${key} 必须是非负整数（当前 ${JSON.stringify(v)}）`);
    } else if ((v as number) > SAVE_LIMITS.STAT_MAX) {
      c.reject('MONSTER_STAT_RANGE', `${path}.${key}`, `${key} ${v} 超出上限 ${SAVE_LIMITS.STAT_MAX}`);
    }
  }

  if (!Array.isArray(m.moveIds)) {
    c.reject('MONSTER_MOVES', `${path}.moveIds`, 'moveIds 必须是数组');
  } else {
    if (m.moveIds.length > SAVE_LIMITS.MOVES_MAX) {
      c.reject('MONSTER_MOVES_MAX', `${path}.moveIds`, `技能数量不能超过 ${SAVE_LIMITS.MOVES_MAX}`);
    }
    if (m.moveIds.some((id) => typeof id !== 'string' || id.length === 0)) {
      c.reject('MONSTER_MOVE_ID', `${path}.moveIds`, '技能 id 必须是非空字符串');
    }
  }

  // element / status 是固定小枚举，硬编码成本低且能挡住乱填；字段缺失只记告警（兼容旧档）。
  if (m.element !== undefined && (typeof m.element !== 'string' || !ELEMENTS.has(m.element))) {
    c.reject('MONSTER_ELEMENT', `${path}.element`, '属性不在合法枚举内');
  }
  if (m.status !== undefined && (typeof m.status !== 'string' || !STATUSES.has(m.status))) {
    c.reject('MONSTER_STATUS', `${path}.status`, '异常状态不在合法枚举内');
  }

  for (const key of ['initStats', 'growthRates']) {
    const block = m[key];
    if (block === undefined) {
      c.warn('MONSTER_STATS_MISSING', `${path}.${key}`, `缺少 ${key}，可能为旧版存档`);
      continue;
    }
    if (!isPlainObject(block)) {
      c.reject('MONSTER_STATS', `${path}.${key}`, `${key} 必须是对象`);
      continue;
    }
    for (const stat of STAT_KEYS) {
      const v = block[stat];
      if (!isNonNegInt(v)) {
        c.reject('MONSTER_STATS_VALUE_FORMAT', `${path}.${key}.${stat}`, `${key}.${stat} 必须是非负整数（当前 ${JSON.stringify(v)}）`);
      } else if ((v as number) > SAVE_LIMITS.STAT_MAX) {
        c.reject('MONSTER_STATS_VALUE_RANGE', `${path}.${key}.${stat}`, `${key}.${stat} ${v} 超出上限 ${SAVE_LIMITS.STAT_MAX}`);
      }
    }
  }

  // 进化链：只校验形状（P3 服务端持有内容表后再校验 targetId 真值与链路合法性）。
  if (m.pendingEvolution !== undefined) {
    if (!isPlainObject(m.pendingEvolution) || typeof m.pendingEvolution.targetId !== 'string') {
      c.reject('MONSTER_EVOLUTION', `${path}.pendingEvolution`, '待进化信息格式不正确');
    }
  }
}

/**
 * 校验存档 JSON 文本。
 * @param raw 前端 exportSaveJson 产出的 JSON 文本
 * @param opts.now 服务端当前时间（毫秒），便于单测注入；默认 Date.now()
 */
export function validateSaveData(
  raw: string,
  // now 注入点保留以兼容既有调用；未来时间戳的处置已下沉 lib/serverClock.ts，
  // 本模块不再依据时钟做拒绝 / 告警（改系统时间不封号，P1-1b）。
  _opts: { now?: number } = {},
): SaveValidation {
  const c = createCollector();
  const emptyStats = {
    money: 0, steps: 0, partySize: 0, boxSize: 0, maxLevel: 0, totalCaptured: 0,
  };

  // —— 结构层（沿用 P0-2 的最小必要结构校验）——
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    c.reject('NOT_JSON', '$', '存档不是合法 JSON');
    return { ok: false, schemaVersion: 'unknown', hard: c.hard, soft: c.soft, stats: emptyStats };
  }
  if (!isPlainObject(parsed)) {
    c.reject('NOT_OBJECT', '$', '存档顶层必须是对象');
    return { ok: false, schemaVersion: 'unknown', hard: c.hard, soft: c.soft, stats: emptyStats };
  }
  if (typeof parsed.version !== 'string') {
    c.reject('VERSION_MISSING', 'version', '存档缺少 version 字段（疑似脏档）');
    return { ok: false, schemaVersion: 'unknown', hard: c.hard, soft: c.soft, stats: emptyStats };
  }
  if (!Array.isArray(parsed.party)) {
    c.reject('PARTY_MISSING', 'party', '存档 party 字段不正确（疑似脏档）');
  }
  if (!isPlainObject(parsed.inventory)) {
    c.reject('INVENTORY_MISSING', 'inventory', '存档 inventory 字段不正确（疑似脏档）');
  }

  // —— 版本一致性：必须是纯数字字符串，且不得高于服务端已知版本 ——
  // 高于当前版本意味着客户端比服务端「更新」，多为伪造或版本错配，直接拒绝；
  // 低于当前版本是正常旧档（前端 migrate 会升版），放行但记告警。
  const version = parsed.version;
  const schemaVersion = version;
  if (!/^\d+$/.test(version)) {
    c.reject('VERSION_FORMAT', 'version', '存档版本号必须是数字字符串');
  } else {
    const n = Number(version);
    if (!Number.isSafeInteger(n) || n < 1) {
      c.reject('VERSION_FORMAT', 'version', '存档版本号不合法');
    } else if (n > EXPECTED_SAVE_VERSION) {
      c.reject('VERSION_TOO_NEW', 'version', `存档版本 ${version} 高于服务端当前版本 ${EXPECTED_SAVE_VERSION}`);
    } else if (n < EXPECTED_SAVE_VERSION) {
      c.warn('VERSION_OLD', 'version', `旧版存档 ${version}，将由客户端迁移至 ${EXPECTED_SAVE_VERSION}`);
    }
  }

  // —— 顶层数值 ——
  // 金钱分两级判定，不可合并：
  //   FORMAT（负数 / 小数 / 非数字）→ 400 拒绝但**不封号**。脏档、旧版迁移失败、
  //     客户端算术 bug 都会产生这种值，拿它封号会误封正常玩家（见 antiCheat.ts 白名单原则）。
  //   RANGE（超出合法上界）→ 正常游戏逻辑不可能产生，才是改档特征，交给 antiCheat 判定封号。
  let money = 0;
  if (!isNonNegInt(parsed.money)) {
    c.reject('MONEY_FORMAT', 'money', '金钱必须是非负整数');
  } else if ((parsed.money as number) > SAVE_LIMITS.MONEY_MAX) {
    c.reject('MONEY_RANGE', 'money', `金钱 ${parsed.money} 超出上限 ${SAVE_LIMITS.MONEY_MAX}`);
  } else {
    money = parsed.money as number;
    if (money > SAVE_LIMITS.MONEY_WARN) {
      c.warn('MONEY_HIGH', 'money', `金钱 ${money} 偏高，疑似改档`);
    }
  }
  if (!isNonNegInt(parsed.steps)) {
    c.reject('STEPS_FORMAT', 'steps', '步数必须是非负整数');
  } else if ((parsed.steps as number) > SAVE_LIMITS.STEPS_MAX) {
    c.reject('STEPS_RANGE', 'steps', `步数 ${parsed.steps} 超出上限 ${SAVE_LIMITS.STEPS_MAX}`);
  }
  if (parsed.playerName !== undefined) {
    if (typeof parsed.playerName !== 'string' || parsed.playerName.length > SAVE_LIMITS.PLAYER_NAME_MAX) {
      c.reject('PLAYER_NAME', 'playerName', '玩家名称必须是字符串且不超出长度上限');
    }
  }
  if (parsed.visitedLocationIds !== undefined) {
    if (
      !Array.isArray(parsed.visitedLocationIds) ||
      parsed.visitedLocationIds.length > SAVE_LIMITS.VISITED_MAX ||
      parsed.visitedLocationIds.some((id) => typeof id !== 'string')
    ) {
      c.reject('VISITED', 'visitedLocationIds', '已访问地点列表格式不正确');
    }
  }

  // —— 队伍与箱子 ——
  let maxLevel = 0;
  const scanMonsters = (list: unknown, path: string, limit: number): number => {
    if (!Array.isArray(list)) return 0;
    if (list.length > limit) {
      c.reject('MONSTER_LIST_MAX', path, `${path} 数量不能超过 ${limit}`);
    }
    list.forEach((m, i) => {
      if (isPlainObject(m) && isNonNegInt(m.level)) {
        maxLevel = Math.max(maxLevel, m.level as number);
      }
      validateMonster(m, `${path}[${i}]`, c);
    });
    return list.length;
  };
  const partySize = scanMonsters(parsed.party, 'party', SAVE_LIMITS.PARTY_MAX);
  if (parsed.box !== undefined && !Array.isArray(parsed.box)) {
    c.reject('BOX', 'box', 'box 必须是数组');
  }
  const boxSize = scanMonsters(parsed.box, 'box', SAVE_LIMITS.BOX_MAX);

  // —— 背包：每个道具数量必须是非负整数，键数量受限防滥用 ——
  if (isPlainObject(parsed.inventory)) {
    const entries = Object.entries(parsed.inventory);
    if (entries.length > SAVE_LIMITS.ITEM_KEYS_MAX) {
      c.reject('INVENTORY_KEYS', 'inventory', '背包条目数超出上限');
    }
    for (const [key, value] of entries) {
      if (typeof key !== 'string' || key.length === 0 || key.length > SAVE_LIMITS.ID_MAX) {
        c.reject('INVENTORY_KEY', `inventory.${key}`, '道具 id 格式不正确');
      }
      if (!isNonNegInt(value)) {
        c.reject('INVENTORY_VALUE_FORMAT', `inventory.${key}`, `${key} 的数量必须是非负整数（当前 ${JSON.stringify(value)}）`);
      } else if ((value as number) > SAVE_LIMITS.ITEM_STACK_MAX) {
        c.reject('INVENTORY_VALUE_RANGE', `inventory.${key}`, `${key} 的数量 ${value} 超出上限 ${SAVE_LIMITS.ITEM_STACK_MAX}`);
      }
    }
  }

  // —— 图鉴：捕获次数必须是非负整数 ——
  let totalCaptured = 0;
  if (parsed.collection !== undefined) {
    if (!isPlainObject(parsed.collection)) {
      c.reject('COLLECTION', 'collection', 'collection 必须是对象');
    } else {
      const entries = Object.entries(parsed.collection);
      if (entries.length > SAVE_LIMITS.COLLECTION_KEYS_MAX) {
        c.reject('COLLECTION_KEYS', 'collection', '图鉴条目数超出上限');
      }
      for (const [key, entry] of entries) {
        if (!isPlainObject(entry)) {
          c.reject('COLLECTION_ENTRY', `collection.${key}`, '图鉴条目必须是对象');
          continue;
        }
        const times = entry.timesCaptured;
        if (!isNonNegInt(times)) {
          c.reject('COLLECTION_TIMES_FORMAT', `collection.${key}.timesCaptured`, '捕获次数必须是非负整数');
        } else if ((times as number) > SAVE_LIMITS.TIMES_CAPTURED_MAX) {
          c.reject('COLLECTION_TIMES_RANGE', `collection.${key}.timesCaptured`, `捕获次数 ${times} 超出上限 ${SAVE_LIMITS.TIMES_CAPTURED_MAX}`);
        } else {
          totalCaptured += times as number;
          if ((times as number) > SAVE_LIMITS.TIMES_CAPTURED_WARN) {
            c.warn('COLLECTION_TIMES_HIGH', `collection.${key}.timesCaptured`, `捕获次数 ${times} 偏高，疑似改档`);
          }
        }
      }
    }
  }

  // —— 时间戳：只检查「格式」，不再因「晚于服务器时间」而拒绝或告警。
  //     P1-1b 起，未来时间戳由 lib/serverClock.ts::clampSaveTimestamps 统一钳制为
  //     服务端时间：改系统时间只是「不生效」，不封号（杰哥 2026-11-05 拍板）。
  //     钳制同时堵住「填未来时间让本地永远赢 last-write-wins 冲突决策」的攻击面。
  //     ⚠️ 把时间往过去调刷挂机收益，需 P1-2 服务端挂机结算根治，见任务表 P1-2。
  const checkTimestampFormat = (v: unknown, path: string) => {
    if (typeof v !== 'string') {
      c.warn('TIMESTAMP_MISSING', path, `${path} 缺失或格式不正确`);
      return;
    }
    if (!Number.isFinite(Date.parse(v))) {
      c.warn('TIMESTAMP_INVALID', path, `${path} 不是合法时间`);
    }
  };
  checkTimestampFormat(parsed.lastSavedAt, 'lastSavedAt');
  if (isPlainObject(parsed.idle)) {
    checkTimestampFormat(parsed.idle.startedAt, 'idle.startedAt');
    if (parsed.idle.level !== undefined) {
      if (!isNonNegInt(parsed.idle.level)) {
        c.reject('IDLE_LEVEL_FORMAT', 'idle.level', '挂机区域难度等级必须是整数');
      } else if ((parsed.idle.level as number) > SAVE_LIMITS.LEVEL_MAX) {
        c.reject('IDLE_LEVEL_RANGE', 'idle.level', `挂机区域难度等级 ${parsed.idle.level} 超出上限 ${SAVE_LIMITS.LEVEL_MAX}`);
      }
    }
  }
  if (parsed.clearedAreas !== undefined) {
    if (!isPlainObject(parsed.clearedAreas)) {
      c.reject('CLEARED_AREAS', 'clearedAreas', 'clearedAreas 必须是对象');
    } else {
      for (const [key, area] of Object.entries(parsed.clearedAreas)) {
        const areaPath = `clearedAreas.${key}`;
        if (!isPlainObject(area)) {
          c.reject('CLEARED_AREA', areaPath, '首通区域记录必须是对象');
        } else if (!isNonNegInt(area.level)) {
          c.reject('CLEARED_AREA_LEVEL_FORMAT', `${areaPath}.level`, '首通区域难度等级必须是整数');
        } else if ((area.level as number) > SAVE_LIMITS.LEVEL_MAX) {
          c.reject('CLEARED_AREA_LEVEL_RANGE', `${areaPath}.level`, `首通区域难度等级 ${area.level} 超出上限 ${SAVE_LIMITS.LEVEL_MAX}`);
        }
      }
    }
  }

  return {
    ok: c.hard.length === 0,
    schemaVersion,
    hard: c.hard,
    soft: c.soft,
    stats: {
      money,
      steps: isNonNegInt(parsed.steps) ? (parsed.steps as number) : 0,
      partySize,
      boxSize,
      maxLevel,
      totalCaptured,
    },
  };
}
