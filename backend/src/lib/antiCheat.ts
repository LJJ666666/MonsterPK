/**
 * 存档风控决策（P1-1b）：把 saveValidator 的校验结果翻译成三种处置。
 *
 * 需求来源（杰哥 2026-11-05 拍板）：
 *  - 满属性 / 高等级 / 满金币这类「测试菜单或外挂才造得出」的数值，**普通账号一律不放行**；
 *  - 只有管理员账号（服务端判定）能带这类数据，用于开发调试；
 *  - 明确改档（越界、伪造、异常高数值）→ 封号 + 前端弹窗 + 强制登出；
 *  - 改系统时间 → 不封号，交给 serverClock 钳制为「不生效」。
 *
 * 防误封原则：采用**改档特征白名单**（CHEAT_CODES）。未列入的违规一律只 400 拒绝、
 * 不封号——旧版存档、内容表更新、客户端 bug、网络损坏都可能造成格式异常，
 * 拿这些去封号会把正常玩家封掉。
 *
 * ⚠️ 能力边界：只能识别「数值异常」的作弊。GG 修改器在合法区间内微调数值、
 * 加速器篡改客户端节奏、外挂直接构造请求，本层看不见；根治依赖
 * P1-2（关键随机/结算上移）与 P3（服务端模拟，客户端无真值）。
 */
import type { SaveValidation } from './saveValidator';

export type SaveAction =
  | { kind: 'allow'; reason: string; codes: string[]; adminOverride: boolean }
  | { kind: 'reject'; reason: string; codes: string[] }
  | { kind: 'ban'; reason: string; codes: string[] };

/**
 * 明确的改档特征码。
 * - hard 段：数值越界 / 容量越界（正常游戏逻辑不可能产生）。
 * - soft 段：数值高到只有测试菜单或外挂才能造出（前端 test 菜单 addGold 上限 999999、
 *   捕抓必全满会抬高六维与 initStats；普通游玩达不到这些阈值）。
 */
export const CHEAT_CODES: ReadonlySet<string> = new Set([
  // —— 硬违规里的数值类 ——
  'MONEY', 'STEPS',
  'MONSTER_LEVEL', 'MONSTER_EXP', 'MONSTER_MAX_HP', 'MONSTER_HP', 'MONSTER_HP_EXCEED',
  'MONSTER_STAT', 'MONSTER_STATS_VALUE', 'MONSTER_MOVES_MAX', 'MONSTER_LIST_MAX',
  'INVENTORY_VALUE', 'INVENTORY_KEYS',
  'COLLECTION_TIMES', 'COLLECTION_KEYS',
  'IDLE_LEVEL', 'CLEARED_AREA_LEVEL',
  // —— 软告警里的改档特征（本次由「放行」升级为「封号」）——
  'MONEY_HIGH', 'MONSTER_LEVEL_HIGH', 'MONSTER_EXP_OVERFLOW', 'COLLECTION_TIMES_HIGH',
]);

/** 是否为明确的改档特征（导出便于单测与日志检索）。 */
export function isCheatCode(code: string): boolean {
  return CHEAT_CODES.has(code);
}

/**
 * 决策主函数：纯函数、不连库、不依赖 Fastify。
 * @param validation saveValidator 的结果
 * @param isAdmin 由服务端 lib/account.ts 判定，绝不接受客户端传入
 */
export function decideSaveAction(validation: SaveValidation, isAdmin: boolean): SaveAction {
  const hardCodes = validation.hard.map((x) => x.code);
  const softCodes = validation.soft.map((x) => x.code);
  const cheatHard = validation.hard.filter((x) => CHEAT_CODES.has(x.code));
  const cheatSoft = validation.soft.filter((x) => CHEAT_CODES.has(x.code));
  const formatHard = validation.hard.filter((x) => !CHEAT_CODES.has(x.code));

  // ① 结构 / 格式硬伤：任何账号都拒绝，不封号。
  //    管理员也不能把一份非 JSON 或结构损坏的存档写进库，否则会污染整张表。
  if (formatHard.length > 0) {
    return {
      kind: 'reject',
      reason: formatHard[0].message,
      codes: hardCodes,
    };
  }

  const hasCheat = cheatHard.length > 0 || cheatSoft.length > 0;

  // ② 管理员：改档特征放行并标记 override，供日志留痕（测试/调试用途）。
  if (isAdmin) {
    return {
      kind: 'allow',
      reason: hasCheat ? '管理员测试存档，已放行' : '校验通过',
      codes: [...cheatHard, ...cheatSoft].map((x) => x.code),
      adminOverride: hasCheat,
    };
  }

  // ③ 普通账号：出现任一改档特征 → 封号。
  if (hasCheat) {
    const first = cheatHard[0] ?? cheatSoft[0];
    return {
      kind: 'ban',
      reason: `检测到异常游戏数据：${first.message}`,
      codes: [...cheatHard, ...cheatSoft].map((x) => x.code),
    };
  }

  // ④ 只剩旧档兼容类软告警（VERSION_OLD / MONSTER_STATS_MISSING / TIMESTAMP_*）→ 放行。
  return {
    kind: 'allow',
    reason: '校验通过',
    codes: softCodes,
    adminOverride: false,
  };
}
