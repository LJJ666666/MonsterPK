/**
 * 野怪池内存实现（W7.1）。
 *
 * 直接承接 P4-1b 的原始 Map 状态机，语义一字不改，只把方法改成 async
 * 以对齐 `WildStorage` 接口。用途：
 *  - 未配 `REDIS_URL` 的单实例开发 / 单测；
 *  - Redis 实现的行为基线（两套实现必须逐断言一致）。
 *
 * 并发说明：内存实现依赖 Node 单线程 + 「方法内无 await」的语言级保证，
 * 因此同一 wildId 的并发 claim 天然只 1 成功 —— 与改造前完全一致。
 * 跨进程互斥由 `RedisWildStorage` 的 Lua 承担。
 */
import {
  WILD_CLAIM_TTL_MS, WILD_PER_AREA, WILD_RESOLVED_GRACE_MS, WILD_TTL_MS,
  toWildView,
  type ClaimResult, type WildAreaSpec, type WildInstance, type WildResult,
  type WildStats, type WildStatus,
} from './wildTypes';
import type { WildListSnapshot, WildStorage, WildStorageOptions } from './wildStorage';

export class MemoryWildStorage implements WildStorage {
  readonly kind = 'memory' as const;

  private readonly byId = new Map<string, WildInstance>();
  private readonly byArea = new Map<string, Set<string>>();
  private readonly areaSpecs = new Map<string, WildAreaSpec>();
  /** 每个区域独立的版本号：别的区域补怪不该把本区域的快照版本推高。 */
  private readonly areaRevisions = new Map<string, number>();
  /** 全局累计变更数（health 统计用），不对外做幂等判断。 */
  private revision = 0;

  private readonly perArea: number;
  private readonly ttlMs: number;
  private readonly claimTtlMs: number;
  private readonly graceMs: number;

  constructor(private readonly opts: WildStorageOptions) {
    this.perArea = opts.perArea ?? WILD_PER_AREA;
    this.ttlMs = opts.ttlMs ?? WILD_TTL_MS;
    this.claimTtlMs = opts.claimTtlMs ?? WILD_CLAIM_TTL_MS;
    this.graceMs = opts.graceMs ?? WILD_RESOLVED_GRACE_MS;
  }

  private bump(areaId: string): void {
    this.revision += 1;
    this.areaRevisions.set(areaId, (this.areaRevisions.get(areaId) ?? 0) + 1);
  }

  async setAreaSpec(areaId: string, spec: WildAreaSpec): Promise<void> {
    this.areaSpecs.set(areaId, { ...spec });
  }

  async getAreaSpec(areaId: string): Promise<WildAreaSpec | null> {
    return this.areaSpecs.get(areaId) ?? null;
  }

  async revisionFor(areaId: string): Promise<number> {
    return this.areaRevisions.get(areaId) ?? 0;
  }

  async stats(): Promise<WildStats> {
    let available = 0;
    let claimed = 0;
    for (const w of this.byId.values()) {
      if (w.status === 'available') available += 1;
      else if (w.status === 'claimed') claimed += 1;
    }
    return {
      active: this.byId.size, areas: this.byArea.size,
      available, claimed, revision: this.revision,
    };
  }

  private add(inst: WildInstance): void {
    this.byId.set(inst.id, inst);
    let set = this.byArea.get(inst.areaId);
    if (!set) {
      set = new Set<string>();
      this.byArea.set(inst.areaId, set);
    }
    set.add(inst.id);
  }

  private remove(id: string): void {
    const w = this.byId.get(id);
    if (!w) return;
    this.byId.delete(id);
    const set = this.byArea.get(w.areaId);
    if (set) {
      set.delete(id);
      if (set.size === 0) this.byArea.delete(w.areaId);
    }
  }

  /** 清过期 + 归还超时 claim + 补足；返回是否变化。 */
  private ensureSync(areaId: string, spec: WildAreaSpec, now: number): boolean {
    const count = this.byArea.get(areaId)?.size ?? 0;
    this.areaSpecs.set(areaId, { ...spec });
    const ids = Array.from(this.byArea.get(areaId) ?? []);
    let changed = false;
    for (const id of ids) {
      const w = this.byId.get(id);
      if (!w) continue;
      if (w.status === 'resolved' && now >= w.expiresAt) {
        this.remove(id);
        changed = true;
      } else if (w.status === 'available' && now >= w.expiresAt) {
        this.remove(id);
        changed = true;
      } else if (w.status === 'claimed' && w.claim && now - w.claim.at >= this.claimTtlMs) {
        // 断线挂机：放回池子让别人也能抢，不永久占坑。
        w.status = 'available';
        w.claim = null;
        w.expiresAt = now + this.ttlMs;
        changed = true;
      }
    }
    let nowCount = this.byArea.get(areaId)?.size ?? 0;
    while (nowCount < this.perArea) {
      this.add(this.opts.spawner(areaId, spec, now));
      nowCount += 1;
      changed = true;
    }
    if (count !== nowCount) changed = true;
    if (changed) this.bump(areaId);
    return changed;
  }

  async ensure(areaId: string, spec: WildAreaSpec, now: number): Promise<boolean> {
    return this.ensureSync(areaId, spec, now);
  }

  async listArea(areaId: string, spec: WildAreaSpec, now: number): Promise<WildListSnapshot> {
    this.ensureSync(areaId, spec, now);    const ids = this.byArea.get(areaId) ?? new Set<string>();
    const monsters = [];
    for (const id of ids) {
      const w = this.byId.get(id);
      if (!w) continue;
      monsters.push(toWildView(w));
    }
    monsters.sort((a, b) => a.id.localeCompare(b.id));
    return { revision: this.areaRevisions.get(areaId) ?? 0, monsters };
  }

  async claim(wildId: string, userId: string, battleId: string, now: number): Promise<ClaimResult> {
    const w = this.byId.get(wildId);
    if (!w) return { ok: false, code: 'WILD_NOT_FOUND' };
    if (w.status === 'resolved') return { ok: false, code: 'WILD_RESOLVED' };
    if (w.status === 'claimed') return { ok: false, code: 'WILD_CLAIMED' };
    for (const other of this.byId.values()) {
      if (other.status === 'claimed' && other.claim && other.claim.userId === userId) {
        return { ok: false, code: 'WILD_ON_COOLDOWN' };
      }
    }
    w.status = 'claimed';
    w.claim = { userId, battleId, at: now };
    this.bump(w.areaId);
    return { ok: true, instance: w };
  }

  async resolve(
    wildId: string,
    userId: string,
    battleId: string,
    result: Exclude<WildResult, null>,
    now: number,
  ): Promise<boolean> {
    const w = this.byId.get(wildId);
    if (!w || w.status !== 'claimed' || !w.claim) return false;
    if (w.claim.userId !== userId || w.claim.battleId !== battleId) return false;
    w.status = 'resolved';
    w.result = result;
    w.claim = null;
    w.expiresAt = now + this.graceMs;
    this.bump(w.areaId);
    return true;
  }

  async release(battleId: string, now: number): Promise<string[]> {
    const affected: string[] = [];
    for (const w of this.byId.values()) {
      if (w.status !== 'claimed' || w.claim?.battleId !== battleId) continue;
      w.status = 'available';
      w.claim = null;
      w.expiresAt = now + this.ttlMs;
      affected.push(w.areaId);
    }
    for (const areaId of new Set(affected)) this.bump(areaId);
    return affected;
  }

  async findByBattle(battleId: string): Promise<WildInstance | undefined> {
    for (const w of this.byId.values()) {
      if (w.status === 'claimed' && w.claim?.battleId === battleId) return w;
    }
    return undefined;
  }

  async sweep(now: number): Promise<string[]> {
    const changed = new Set<string>();
    for (const [areaId, spec] of this.areaSpecs) {
      if (this.ensureSync(areaId, spec, now)) changed.add(areaId);
    }
    return Array.from(changed);
  }

  async clear(): Promise<void> {
    this.byId.clear();
    this.byArea.clear();
    this.areaSpecs.clear();
    this.areaRevisions.clear();
    this.revision = 0;
  }

  async patchStatus(wildId: string, status: WildStatus, patch: Partial<WildInstance>): Promise<void> {
    const w = this.byId.get(wildId);
    if (!w) return;
    Object.assign(w, patch, { status });
    this.bump(w.areaId);
  }
}
