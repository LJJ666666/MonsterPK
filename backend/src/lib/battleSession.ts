/**
 * 活跃战斗注册表（P3-1）。
 *
 * 纯内存、纯逻辑、零 IO：便于 node:test 覆盖归属校验与生命周期。
 * 约束：
 *  - 一个账号（单档）同时只允许一场战斗（新开覆盖旧的，避免并发刷奖励）；
 *  - `get()` 必须同时校验 userId + battleId，防止拿到别人的战斗；
 *  - 30 分钟无动作自动回收（断线挂机不会永久占内存）。
 */
import type { BattleState } from '../game/battle.js';

export const BATTLE_TTL_MS = 30 * 60 * 1000;

/** 账号单档：战斗 key 就是 userId（历史名保留）。 */
export function battleKey(userId: string): string {
  return userId;
}

export type BattleStats = {
  /** 活跃战斗数。 */
  active: number;
  /** 有战斗的账号数。 */
  users: number;
};

export class BattleRegistry {
  private readonly byId = new Map<string, BattleState>();
  private readonly byKey = new Map<string, string>();

  get size(): number {
    return this.byId.size;
  }

  create(state: BattleState): BattleState {
    const key = battleKey(state.userId);
    const prevId = this.byKey.get(key);
    if (prevId) this.byId.delete(prevId);
    this.byId.set(state.id, state);
    this.byKey.set(key, state.id);
    return state;
  }

  /** 两个键全对才返回；battleId 泄漏也拿不到别人的战斗。 */
  get(userId: string, battleId: string): BattleState | undefined {
    const state = this.byId.get(battleId);
    if (!state) return undefined;
    if (state.userId !== userId) return undefined;
    return state;
  }

  current(userId: string): BattleState | undefined {
    const id = this.byKey.get(battleKey(userId));
    return id ? this.byId.get(id) : undefined;
  }

  /** 保存推进后的状态（同一 battleId 覆盖）。 */
  update(state: BattleState): void {
    if (!this.byId.has(state.id)) return;
    this.byId.set(state.id, state);
  }

  drop(userId: string): boolean {
    const key = battleKey(userId);
    const id = this.byKey.get(key);
    if (!id) return false;
    this.byKey.delete(key);
    return this.byId.delete(id);
  }

  /** 封号 / 登出：丢弃该账号全部战斗。 */
  dropUser(userId: string): number {
    let n = 0;
    for (const [id, state] of [...this.byId]) {
      if (state.userId !== userId) continue;
      this.byId.delete(id);
      this.byKey.delete(battleKey(userId));
      n += 1;
    }
    return n;
  }

  /** 回收超时战斗；返回清理数量。 */
  sweep(now: number, ttl = BATTLE_TTL_MS): number {
    return this.sweepExpired(now, ttl).length;
  }

  /**
   * P4-2c：回收超时战斗并**返回被回收的战斗态**，让调用方释放 Boss 的在途次数。
   * 单独开一个方法而不是改 `sweep()` 的返回类型：既有调用方与单测依赖 `number`。
   */
  sweepExpired(now: number, ttl = BATTLE_TTL_MS): BattleState[] {
    const cleaned: BattleState[] = [];
    for (const [id, state] of [...this.byId]) {
      if (now - state.updatedAt <= ttl) continue;
      this.byId.delete(id);
      this.byKey.delete(battleKey(state.userId));
      cleaned.push(state);
    }
    return cleaned;
  }

  stats(): BattleStats {
    const users = new Set<string>();
    for (const s of this.byId.values()) users.add(s.userId);
    return { active: this.byId.size, users: users.size };
  }
}
