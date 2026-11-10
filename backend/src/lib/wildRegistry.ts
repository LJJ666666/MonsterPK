/**
 * 共享野怪实例池（P4-1b）。
 *
 * 纯内存、纯逻辑、零 IO：便于 node:test 覆盖「捕获互斥」与生命周期。
 * 与 P4-0 的槽位锁不同，这里的 claim **故意不加锁**：
 * 它是同步函数，中间没有 await，Node 单线程下两个请求不可能交错进临界区，
 * 因此「只有一个人能抢到」是语言级保证，不依赖任何锁实现。
 *
 * 约束：
 *  - 每个 areaId 维护 N 只野怪，过期 / 结算后按服务端 RNG 补新的；
 *  - claim 只有 available 能成功，归属用 (userId, battleId) 两键；
 *  - resolve / release 都必须验证归属，别人不能结束我的野怪；
 *  - 对外视图不含 userId / battleId，避免泄露他人账号；
 *  - revision 全局单调递增，客户端按它幂等应用 wild.state 全量快照。
 */
import { MONSTER_SPECS, THEME_TABLE } from '../game/content';

/** 每个区域同时可见的野怪数。 */
export const WILD_PER_AREA = 3;
/** 未抢占的野怪存活时间（到期换新，避免列表永远不变）。 */
export const WILD_TTL_MS = 5 * 60_000;
/** 抢占后长时间不结算（掉线 / 战斗 TTL）自动放回池子。 */
export const WILD_CLAIM_TTL_MS = 30 * 60_000;
/** 结算后保留一小段时间，让其他客户端看得到「已被捕获 / 已逃走」。 */
export const WILD_RESOLVED_GRACE_MS = 10_000;

export type WildStatus = 'available' | 'claimed' | 'resolved';
export type WildResult = 'captured' | 'defeated' | 'fled' | null;
export type WildClaim = { userId: string; battleId: string; at: number };

export type WildInstance = {
  id: string;
  areaId: string;
  theme: string;
  speciesId: string;
  name: string;
  level: number;
  label: string;
  spawnedAt: number;
  expiresAt: number;
  status: WildStatus;
  result: WildResult;
  claim: WildClaim | null;
};

/** 对外公开视图：刻意不含 claim（userId / battleId）。 */
export type WildMonsterView = {
  id: string;
  areaId: string;
  speciesId: string;
  name: string;
  level: number;
  label: string;
  status: WildStatus;
  result: WildResult;
  expiresAt: number;
};

export type WildAreaSpec = {
  theme: string;
  levelMin: number;
  levelMax: number;
};

export type ClaimResult =
  | { ok: true; instance: WildInstance }
  | { ok: false; code: 'WILD_NOT_FOUND' | 'WILD_CLAIMED' | 'WILD_RESOLVED' | 'WILD_ON_COOLDOWN' };

function clampInt(v: number, min: number, max: number): number {
  return Math.min(Math.max(Math.floor(Number.isFinite(v) ? v : min), min), max);
}

export class WildRegistry {
  private readonly byId = new Map<string, WildInstance>();
  private readonly byArea = new Map<string, Set<string>>();
  private readonly areaSpecs = new Map<string, WildAreaSpec>();
  /** 每个区域独立的版本号：别的区域补怪不该把本区域的快照版本推高。 */
  private readonly areaRevisions = new Map<string, number>();
  /** 全局累计变更数（health 统计用），不对外做幂等判断。 */
  private revision = 0;
  private seq = 0;

  constructor(
    private readonly opts: {
      perArea?: number;
      ttlMs?: number;
      claimTtlMs?: number;
      graceMs?: number;
      rng?: () => number;
    } = {},
  ) {}

  get currentRevision(): number {
    return this.revision;
  }

  private rng(): number {
    return (this.opts.rng ?? Math.random)();
  }

  /** 一次状态变更同时推进全局计数与该区域版本。 */
  private bump(areaId: string): void {
    this.revision += 1;
    this.areaRevisions.set(areaId, (this.areaRevisions.get(areaId) ?? 0) + 1);
  }

  /** 某区域当前版本号（客户端按 areaId 幂等应用时用）。 */
  revisionFor(areaId: string): number {
    return this.areaRevisions.get(areaId) ?? 0;
  }

  stats(): { active: number; areas: number; available: number; claimed: number; revision: number } {
    let available = 0;
    let claimed = 0;
    for (const w of this.byId.values()) {
      if (w.status === 'available') available += 1;
      else if (w.status === 'claimed') claimed += 1;
    }
    return { active: this.byId.size, areas: this.byArea.size, available, claimed, revision: this.revision };
  }

  /** 登记 / 更新区域的内容真值（等级区间与主题一律以服务端内容表为准）。 */
  setAreaSpec(areaId: string, spec: WildAreaSpec): void {
    this.areaSpecs.set(areaId, {
      theme: spec.theme,
      levelMin: clampInt(spec.levelMin, 1, 60),
      levelMax: clampInt(spec.levelMax, 1, 60),
    });
  }

  /** 心跳扫描广播时取回已登记的区域真值。 */
  getAreaSpec(areaId: string): WildAreaSpec | null {
    return this.areaSpecs.get(areaId) ?? null;
  }

  private spawn(areaId: string, spec: WildAreaSpec, now: number): WildInstance {
    const table = THEME_TABLE[spec.theme] ?? [];
    const speciesId = table.length > 0
      ? table[Math.floor(this.rng() * table.length)]
      : Object.keys(MONSTER_SPECS)[0];
    const lvMin = Math.min(spec.levelMin, spec.levelMax);
    const lvMax = Math.max(spec.levelMin, spec.levelMax);
    const level = clampInt(lvMin + this.rng() * (lvMax - lvMin + 1), 1, 60);
    const rare = this.rng() < 0.08;
    const elite = !rare && this.rng() < 0.12;
    const name = MONSTER_SPECS[speciesId]?.name ?? speciesId;
    const inst: WildInstance = {
      id: `w_${now.toString(36)}_${(this.seq++).toString(36)}_${Math.floor(this.rng() * 1e6).toString(36)}`,
      areaId,
      theme: spec.theme,
      speciesId,
      name,
      level: clampInt(level + (elite ? 2 : 0) + (rare ? 3 : 0), 1, 60),
      label: `${rare ? '稀有' : elite ? '精英' : '野生'} ${name}`,
      spawnedAt: now,
      expiresAt: now + (this.opts.ttlMs ?? WILD_TTL_MS),
      status: 'available',
      result: null,
      claim: null,
    };
    this.byId.set(inst.id, inst);
    let set = this.byArea.get(areaId);
    if (!set) {
      set = new Set<string>();
      this.byArea.set(areaId, set);
    }
    set.add(inst.id);
    return inst;
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

  /**
   * 保证该区域有 N 只野怪：清掉过期的 available / resolved，把超时 claim 放回池子，
   * 再补足缺额。返回是否发生了任何变化（决定要不要广播）。
   */
  ensure(areaId: string, spec: WildAreaSpec, now: number): boolean {
    const count = this.byArea.get(areaId)?.size ?? 0;
    this.setAreaSpec(areaId, spec);
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
      } else if (
        w.status === 'claimed' && w.claim
        && now - w.claim.at >= (this.opts.claimTtlMs ?? WILD_CLAIM_TTL_MS)
      ) {
        // 断线挂机：放回池子让别人也能抢，不永久占坑。
        w.status = 'available';
        w.claim = null;
        w.expiresAt = now + (this.opts.ttlMs ?? WILD_TTL_MS);
        changed = true;
      }
    }
    const target = this.opts.perArea ?? WILD_PER_AREA;
    let nowCount = this.byArea.get(areaId)?.size ?? 0;
    while (nowCount < target) {
      this.spawn(areaId, spec, now);
      nowCount += 1;
      changed = true;
    }
    if (count !== nowCount) changed = true;
    if (changed) this.bump(areaId);
    return changed;
  }

  /** 公开列表：自动 ensure 后返回全量快照（客户端按 revision 幂等应用）。 */
  list(areaId: string, spec: WildAreaSpec, now: number): {
    revision: number;
    monsters: WildMonsterView[];
  } {
    this.ensure(areaId, spec, now);
    const ids = this.byArea.get(areaId) ?? new Set<string>();
    const monsters: WildMonsterView[] = [];
    for (const id of ids) {
      const w = this.byId.get(id);
      if (!w) continue;
      monsters.push({
        id: w.id, areaId: w.areaId, speciesId: w.speciesId, name: w.name,
        level: w.level, label: w.label, status: w.status, result: w.result,
        expiresAt: w.expiresAt,
      });
    }
    monsters.sort((a, b) => a.id.localeCompare(b.id));
    return { revision: this.revisionFor(areaId), monsters };
  }

  /**
   * 原子抢占。同步、无 await —— 同一 wildId 的两次 claim 只有第一次能成功。
   * 同一账号已有别的野怪在打时拒绝（单账号只允许一场战斗）。
   */
  claim(
    wildId: string,
    userId: string,
    battleId: string,
    now: number,
  ): ClaimResult {
    const w = this.byId.get(wildId);
    if (!w) return { ok: false, code: 'WILD_NOT_FOUND' };
    if (w.status === 'resolved') return { ok: false, code: 'WILD_RESOLVED' };
    if (w.status === 'claimed') return { ok: false, code: 'WILD_CLAIMED' };
    for (const other of this.byId.values()) {
      if (other.status === 'claimed' && other.claim
        && other.claim.userId === userId) {
        return { ok: false, code: 'WILD_ON_COOLDOWN' };
      }
    }
    w.status = 'claimed';
    w.claim = { userId, battleId, at: now };
    this.bump(w.areaId);
    return { ok: true, instance: w };
  }

  /** 结算：只有归属者能调用。结算后保留一小段时间，供其他客户端看到结果。 */
  resolve(
    wildId: string,
    userId: string,
    battleId: string,
    result: Exclude<WildResult, null>,
    now: number,
  ): boolean {
    const w = this.byId.get(wildId);
    if (!w || w.status !== 'claimed' || !w.claim) return false;
    if (w.claim.userId !== userId || w.claim.battleId !== battleId) return false;
    w.status = 'resolved';
    w.result = result;
    w.claim = null;
    w.expiresAt = now + (this.opts.graceMs ?? WILD_RESOLVED_GRACE_MS);
    this.bump(w.areaId);
    return true;
  }

  /** 放弃战斗 / 战斗 TTL 回收：把野怪放回池子（别人还能抢）。 */
  release(battleId: string, now: number): string[] {
    const affected: string[] = [];
    for (const w of this.byId.values()) {
      if (w.status !== 'claimed' || w.claim?.battleId !== battleId) continue;
      w.status = 'available';
      w.claim = null;
      w.expiresAt = now + (this.opts.ttlMs ?? WILD_TTL_MS);
      affected.push(w.areaId);
    }
    for (const areaId of new Set(affected)) this.bump(areaId);
    return affected;
  }

  /** 按 battleId 找归属的野怪（战斗结束时定位用）。 */
  findByBattle(battleId: string): WildInstance | undefined {
    for (const w of this.byId.values()) {
      if (w.status === 'claimed' && w.claim?.battleId === battleId) return w;
    }
    return undefined;
  }

  /** 心跳扫描：清理过期实例并补足，返回受影响的区域（供广播）。 */
  sweep(now: number): string[] {
    const changed = new Set<string>();
    for (const [areaId, spec] of this.areaSpecs) {
      if (this.ensure(areaId, spec, now)) changed.add(areaId);
    }
    return Array.from(changed);
  }

  clear(): void {
    this.byId.clear();
    this.byArea.clear();
    this.areaSpecs.clear();
    this.areaRevisions.clear();
    this.revision = 0;
    this.seq = 0;
  }
}
