/**
 * 活跃战斗注册表（P3-1）。
 *
 * 纯内存、纯逻辑、零 IO：便于 node:test 覆盖归属校验与生命周期。
 * 约束：
 *  - 一个账号的一个槽位同时只允许一场战斗（新开覆盖旧的，避免并发刷奖励）；
 *  - `get()` 必须同时校验 userId + slot + battleId，防止拿到别人的战斗；
 *  - 30 分钟无动作自动回收（断线挂机不会永久占内存）。
 */
import type { BattleState } from '../game/battle.js';

export const BATTLE_TTL_MS = 30 * 60 * 1000;

export function battleKey(userId: string, slot: number): string {
  return `${userId}#${slot}`;
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
    const key = battleKey(state.userId, state.slot);
    const prevId = this.byKey.get(key);
    if (prevId) this.byId.delete(prevId);
    this.byId.set(state.id, state);
    this.byKey.set(key, state.id);
    return state;
  }

  /** 三个键全对才返回；battleId 泄漏也拿不到别人的战斗。 */
  get(userId: string, slot: number, battleId: string): BattleState | undefined {
    const state = this.byId.get(battleId);
    if (!state) return undefined;
    if (state.userId !== userId || state.slot !== slot) return undefined;
    return state;
  }

  current(userId: string, slot: number): BattleState | undefined {
    const id = this.byKey.get(battleKey(userId, slot));
    return id ? this.byId.get(id) : undefined;
  }

  /** 保存推进后的状态（同一 battleId 覆盖）。 */
  update(state: BattleState): void {
    if (!this.byId.has(state.id)) return;
    this.byId.set(state.id, state);
  }

  drop(userId: string, slot: number): boolean {
    const key = battleKey(userId, slot);
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
      this.byKey.delete(battleKey(userId, state.slot));
      n += 1;
    }
    return n;
  }

  /** 回收超时战斗；返回清理数量。 */
  sweep(now: number, ttl = BATTLE_TTL_MS): number {
    let n = 0;
    for (const [id, state] of [...this.byId]) {
      if (now - state.updatedAt <= ttl) continue;
      this.byId.delete(id);
      this.byKey.delete(battleKey(state.userId, state.slot));
      n += 1;
    }
    return n;
  }

  stats(): BattleStats {
    const users = new Set<string>();
    for (const s of this.byId.values()) users.add(s.userId);
    return { active: this.byId.size, users: users.size };
  }
}
