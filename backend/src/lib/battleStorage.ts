/**
 * 活跃战斗存储抽象（W8.1）。
 *
 * 背景：`BattleRegistry` 原本是纯内存 Map，多实例下 A 实例开的战斗 B 实例看不见。
 * 玩家 WS 断线重连被路由到另一实例时，`battles.current(userId)` 返回 undefined，
 * 前端就会拿到「没有进行中的战斗」——战斗直接丢失（定稿 W8 验收「换实例不丢战斗」）。
 *
 * 拆法与 W7 的 `WildStorage` 同构：
 *  - 本文件只定义接口与类型，零 IO；
 *  - `MemoryBattleStorage` 承接原 Map 语义，作**行为基线**；
 *  - `RedisBattleStorage` 是共享实现；
 *  - `battleSession.ts` 降为 facade，保留 `BattleRegistry` 类名与构造签名。
 *
 * 全异步：Redis 实现必然是异步的，接口不提供同步变体——否则调用方两套路径，
 * 迟早出现「某处忘了 await」的静默 bug。
 */
import type { BattleState } from '../game/battle.js';

/** 战斗无动作 30 分钟回收（与改造前 `BATTLE_TTL_MS` 一致）。 */
export const BATTLE_TTL_MS = 30 * 60 * 1000;

/**
 * Redis 物理 TTL 系数：逻辑超时 30min，物理键留 2 倍（60min）。
 *
 * 为什么物理 TTL 要长于逻辑超时：`sweepExpired()` 需要**返回被回收的战斗态**，
 * 让调用方释放 Boss 在途次数（`realtime.ts` 的 `releaseBossHold`）。
 * 如果物理 TTL 与逻辑超时相同，键会先被 Redis 删掉，sweep 就只看到「不存在」，
 * 拿到的是 undefined 而不是战斗态，Boss 名额就泄漏了。
 * 物理 TTL 只作兜底（防 sweep 长期不跑导致无限堆积）。
 */
export const BATTLE_PHYSICAL_TTL_FACTOR = 2;

export type BattleStats = {
  /** 活跃战斗数。 */
  active: number;
  /** 有战斗的账号数。 */
  users: number;
};

export interface BattleStorage {
  /** 诊断用：'memory' | 'redis'。 */
  readonly kind: string;

  /** 登记新战斗；同账号已有战斗时**覆盖**（`create` 返回新状态）。 */
  create(state: BattleState): Promise<BattleState>;

  /** userId + battleId 双键全对才返回（battleId 泄漏也拿不到别人的战斗）。 */
  get(userId: string, battleId: string): Promise<BattleState | undefined>;

  current(userId: string): Promise<BattleState | undefined>;

  /** 保存推进后的状态；未登记的战斗不凭空插入。 */
  update(state: BattleState): Promise<void>;

  /** 丢弃该账号当前战斗，返回是否真的删掉了。 */
  drop(userId: string): Promise<boolean>;

  /** 封号 / 登出：丢弃该账号全部战斗，返回清理数量。 */
  dropUser(userId: string): Promise<number>;

  /**
   * 回收超时战斗并返回被回收的状态（Boss 在途次数靠它释放）。
   * 与 `sweep()` 的差异只在返回值，不提供两个方法：新代码只该用这个。
   */
  sweepExpired(now: number, ttl?: number): Promise<BattleState[]>;

  stats(): Promise<BattleStats>;

  /** 单测 / 诊断：活跃战斗数。 */
  size(): Promise<number>;
}
