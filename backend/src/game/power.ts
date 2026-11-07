/**
 * P4-2a 战力纯函数（服务端权威，只读派生）。
 *
 * 定义（杰哥 2026-11-07 拍板，公式待定 / 定义钉死）：
 *   单宠战力 = 当前有效六维之和 = maxHp + atk + def + spAtk + spDef + spd
 *   全队战力 = party 各只战力之和（不含 box）
 *
 * 三条硬边界，改这个文件时不要破：
 *  1. 必须用 maxHp，**绝不能用 hp**：hp 是当前剩余血量，打一仗掉血、治疗回血都会
 *     让榜单波动甚至可刷，也与「不代表实战强弱」冲突。
 *  2. 战力**不代表实战强弱**（血多可能只是耐揍），不得用于匹配 / 伤害 / 奖励 /
 *     解锁 / 任何判定，否则它会变成隐藏实力分数，必然被刷。
 *  3. 后续宠物装备的加成作为**服务端独立真值**叠加成 effectiveStats，
 *     **不写回 MonsterInstance 面板**：写回会污染 digestOf / authority 摘要，
 *     被 CAS 与风控判成「凭空变强」。战力函数只依赖有效六维，
 *     所以装备上线时本文件零改动。
 *
 * 系数 / 权重 / 取整 / 等级修正待定，先简单求和占位；纯函数、可注入、可复现。
 */
import type { ServerMonster } from './content';

/** 展示用免责声明；服务端与前端共用同一句，避免各写一套口径。 */
export const POWER_DISCLAIMER = '战力仅为六维总和，不代表实战强弱';

export type EffectiveStats = {
  maxHp: number;
  atk: number;
  def: number;
  spAtk: number;
  spDef: number;
  spd: number;
};

/** 装备加成（服务端独立真值）。P4-2a 尚无装备系统，先留好扩展点。 */
export type EquipmentBonus = Partial<EffectiveStats> | null | undefined;

/** 只接受有限正数：NaN / Infinity / 负数 / 字符串一律归零，脏档不能抬榜。 */
function safe(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0;
}

/** 面板类型只需要这七个字段，纯函数不关心技能 / 等级 / 物种 / PP。 */
export type PowerInput = Pick<
  ServerMonster,
  'maxHp' | 'atk' | 'def' | 'spAtk' | 'spDef' | 'spd'
>;

/**
 * 有效六维 = 存档里的当前面板 + 可选装备加成。
 * 刻意不改传入对象：装备真值与个体面板永远分离。
 */
export function effectiveStats(
  m: Partial<PowerInput> | null | undefined,
  bonus: EquipmentBonus = null,
): EffectiveStats {
  const b = bonus ?? {};
  return {
    maxHp: safe(m?.maxHp) + safe(b.maxHp),
    atk: safe(m?.atk) + safe(b.atk),
    def: safe(m?.def) + safe(b.def),
    spAtk: safe(m?.spAtk) + safe(b.spAtk),
    spDef: safe(m?.spDef) + safe(b.spDef),
    spd: safe(m?.spd) + safe(b.spd),
  };
}

/** 单宠战力：有效六维之和。 */
export function monsterPower(
  m: Partial<PowerInput> | null | undefined,
  bonus: EquipmentBonus = null,
): number {
  const s = effectiveStats(m, bonus);
  return s.maxHp + s.atk + s.def + s.spAtk + s.spDef + s.spd;
}

/** 全队战力：只算 party，不含 box。 */
export function partyPower(
  party: Array<Partial<PowerInput> | null | undefined> | null | undefined,
  bonus: EquipmentBonus = null,
): number {
  if (!Array.isArray(party)) return 0;
  return party.reduce((sum, m) => sum + monsterPower(m, bonus), 0);
}

/** 单宠榜口径：party ∪ box 里最高的那一只。 */
export function bestMonsterPower(
  party: Array<Partial<PowerInput> | null | undefined> | null | undefined,
  box: Array<Partial<PowerInput> | null | undefined> | null | undefined = [],
  bonus: EquipmentBonus = null,
): number {
  const all = [
    ...(Array.isArray(party) ? party : []),
    ...(Array.isArray(box) ? box : []),
  ];
  return all.reduce((best, m) => Math.max(best, monsterPower(m, bonus)), 0);
}
