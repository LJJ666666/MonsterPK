/**
 * 活跃战斗存储的内存实现（W8.1）。
 *
 * 逐行承接原 `BattleRegistry` 的 Map 状态机，只做「加 async」这一件事：
 * 结构、遍历顺序、边界判断全部保持原样，作为 Redis 实现的行为基线
 * （等价性由 `tests/battleSession.test.ts` 与 `tests/w8RedisKv.test.ts` 双向覆盖）。
 */
import type { BattleState } from '../game/battle.js';
import { BATTLE_TTL_MS, type BattleStats, type BattleStorage } from './battleStorage.js';

/** 账号单档：战斗 key 就是 userId（历史名保留）。 */
export function battleKey(userId: string): string {
  return userId;
}

export class MemoryBattleStorage implements BattleStorage {
  private readonly byId = new Map<string, BattleState>();
  private readonly byKey = new Map<string, string>();

  get kind(): string {
    return 'memory';
  }

  async size(): Promise<number> {
    return this.byId.size;
  }

  async create(state: BattleState): Promise<BattleState> {
    const key = battleKey(state.userId);
    const prevId = this.byKey.get(key);
    if (prevId) this.byId.delete(prevId);
    this.byId.set(state.id, state);
    this.byKey.set(key, state.id);
    return state;
  }

  async get(userId: string, battleId: string): Promise<BattleState | undefined> {
    const state = this.byId.get(battleId);
    if (!state) return undefined;
    if (state.userId !== userId) return undefined;
    return state;
  }

  async current(userId: string): Promise<BattleState | undefined> {
    const id = this.byKey.get(battleKey(userId));
    return id ? this.byId.get(id) : undefined;
  }

  async update(state: BattleState): Promise<void> {
    if (!this.byId.has(state.id)) return;
    this.byId.set(state.id, state);
  }

  async drop(userId: string): Promise<boolean> {
    const key = battleKey(userId);
    const id = this.byKey.get(key);
    if (!id) return false;
    this.byKey.delete(key);
    return this.byId.delete(id);
  }

  async dropUser(userId: string): Promise<number> {
    let n = 0;
    for (const [id, state] of [...this.byId]) {
      if (state.userId !== userId) continue;
      this.byId.delete(id);
      this.byKey.delete(battleKey(userId));
      n += 1;
    }
    return n;
  }

  async sweepExpired(now: number, ttl = BATTLE_TTL_MS): Promise<BattleState[]> {
    const cleaned: BattleState[] = [];
    for (const [id, state] of [...this.byId]) {
      if (now - state.updatedAt <= ttl) continue;
      this.byId.delete(id);
      this.byKey.delete(battleKey(state.userId));
      cleaned.push(state);
    }
    return cleaned;
  }

  async stats(): Promise<BattleStats> {
    const users = new Set<string>();
    for (const s of this.byId.values()) users.add(s.userId);
    return { active: this.byId.size, users: users.size };
  }
}
