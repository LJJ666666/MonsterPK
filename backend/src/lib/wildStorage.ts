/**
 * 野怪池存储接口（W7.0）。
 *
 * 与 `RoomStorage` 同构：把「状态真值存在哪」抽成可替换 adapter，
 * 上层 `WildRegistry` 只做编排（内容生成 + RNG + 定时参数），
 * 单实例开发用内存实现、多实例部署用 Redis 实现。
 *
 * 全部方法 async —— Redis 实现必须跨进程 IO，内存实现同步也会包一层 Promise
 * （保证两套实现签名一致，调用方只写一种写法）。
 *
 * 并发语义由实现自行保证：
 *  - `claim` 同 wildId 并发只允许 1 个成功；
 *  - `listArea` / `sweep` 的补怪不得因并发而超过 `perArea`；
 *  - `resolve` 必须校验 (userId, battleId) 双键归属。
 */
import type {
  ClaimResult, WildAreaSpec, WildInstance, WildMonsterView, WildStats, WildStatus, WildResult,
} from './wildTypes';

export type WildStorageKind = 'memory' | 'redis';

export type WildListSnapshot = {
  revision: number;
  monsters: WildMonsterView[];
};

/** 构造参数：两个实现共用，避免各写一套默认值。 */
export type WildStorageOptions = {
  perArea?: number;
  ttlMs?: number;
  claimTtlMs?: number;
  graceMs?: number;
  /** 内容工厂（必填，由 facade 注入）。 */
  spawner: (areaId: string, spec: WildAreaSpec, now: number) => WildInstance;
};

export interface WildStorage {
  readonly kind: WildStorageKind;

  /** 区域内容真值（主题 / 等级区间），供心跳广播时回取。 */
  setAreaSpec(areaId: string, spec: WildAreaSpec): Promise<void>;
  getAreaSpec(areaId: string): Promise<WildAreaSpec | null>;

  /** 该区域当前快照版本（客户端按它幂等应用）。 */
  revisionFor(areaId: string): Promise<number>;

  /** 公开列表：自动 ensure（清过期 / 超时归还 / 补足）后返回全量快照。 */
  listArea(areaId: string, spec: WildAreaSpec, now: number): Promise<WildListSnapshot>;

  /** 只做清理与补足，不读列表；返回是否发生变化（决定要不要广播）。 */
  ensure(areaId: string, spec: WildAreaSpec, now: number): Promise<boolean>;

  /** 原子抢占：同 wildId 只 1 成功；同账号已有在途野怪时拒绝。 */
  claim(wildId: string, userId: string, battleId: string, now: number): Promise<ClaimResult>;

  /** 结算：只有 (userId, battleId) 双键归属者能调用。 */
  resolve(
    wildId: string,
    userId: string,
    battleId: string,
    result: Exclude<WildResult, null>,
    now: number,
  ): Promise<boolean>;

  /** 放弃战斗 / 战斗 TTL 回收：按 battleId 归还，返回受影响的 areaId。 */
  release(battleId: string, now: number): Promise<string[]>;

  /** 按 battleId 找归属的野怪（战斗结束时定位用）。 */
  findByBattle(battleId: string): Promise<WildInstance | undefined>;

  /** 心跳扫描：全部已知区域做一次 ensure，返回发生变化的 areaId。 */
  sweep(now: number): Promise<string[]>;

  stats(): Promise<WildStats>;

  /** 仅测试：清空（生产不调用）。 */
  clear(): Promise<void>;

  /** 仅测试：直接改某只野怪的状态（内存实现支持，Redis 实现按需实现）。 */
  patchStatus?(wildId: string, status: WildStatus, patch: Partial<WildInstance>): Promise<void>;
}
