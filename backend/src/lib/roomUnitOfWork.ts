/**
 * P5-1 W6.2（#183）：房间工作单元 —— 同一事务边界。
 *
 * 目标（设计定稿 §3.6）：`room` 行 + `RoomQuota` 行 + 结算写档 `Save` 行 +
 * 发奖 `CoopRewardGrant` 行，全部落在**同一个 Postgres 事务**里；任何一步失败，
 * 四者一起回滚，绝不出现「房间已 settled 但奖励没发」或「quota 扣了但房间没结算」。
 *
 * 做法：AsyncLocalStorage 保存当前事务客户端。所有参与这条链的 DB 读写必须经
 * `roomDb()` 取客户端（PgRoomStorage / saveCas store / readSave / coopReward），
 * 事务外用全局单例，事务内自动用 `$transaction` 的 tx，调用点无需层层传参。
 *
 * 副作用（内存权威态 apply、WS 广播）**不能在事务内执行**：事务可能回滚，
 * 内存态与客户端收不到回滚。统一经 `onRoomCommit()` 注册，等 `$transaction`
 * 成功返回后再逐个执行；非事务上下文则立即执行，原有调用链行为不变。
 *
 * `withRoomUnit()` = `withRoomLock(roomId)` + `runInRoomUnit()`：仍由房间锁保证
 * 同一 owner key 的写入串行，事务只负责原子性，两者职责不混。
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { PrismaClient } from '@prisma/client';
import { prisma } from './prisma';
import { withRoomLock } from './slotLock';

export type RoomCommitHook = () => void | Promise<void>;

type RoomUnit = {
  client: PrismaClient;
  hooks: RoomCommitHook[];
};

const storage = new AsyncLocalStorage<RoomUnit>();

/**
 * 事务执行器。抽成变量只为确定性单测注入 fake（零 IO 也能验证「同一客户端 /
 * 提交后才跑 hooks」）；生产始终是 `prisma.$transaction`。
 */
type TransactionRunner = <T>(fn: (client: PrismaClient) => Promise<T>) => Promise<T>;

const defaultRunner: TransactionRunner = (fn) =>
  prisma.$transaction((tx) => fn(tx as PrismaClient), {
    // 结算链可能包含多成员写档 + 发奖，给足事务窗口；锁仍由 withRoomLock 串行。
    maxWait: 5_000,
    timeout: 15_000,
  });

let runner: TransactionRunner = defaultRunner;

/** 仅单测：替换事务执行器；传 null 恢复默认。 */
export function setRoomUnitRunnerForTest(next: TransactionRunner | null): void {
  runner = next ?? defaultRunner;
}

/** 取当前 DB 客户端：房间工作单元内是事务 tx，否则是全局单例。 */
export function roomDb(): PrismaClient {
  return storage.getStore()?.client ?? prisma;
}

export function isRoomUnitActive(): boolean {
  return storage.getStore() !== undefined;
}

/**
 * 注册「提交成功后」的副作用。事务内暂存，事务外立即执行。
 * 注意：hook 必须只做内存态 / 广播，不要再写 DB（那会脱离事务边界）。
 */
export function onRoomCommit(hook: RoomCommitHook): void {
  const unit = storage.getStore();
  if (!unit) {
    void hook();
    return;
  }
  unit.hooks.push(hook);
}

/**
 * 在一个事务里执行 fn。嵌套调用复用外层事务（不新开）。
 * fn 抛错 → 事务回滚 → hooks 全部丢弃（不 apply 内存、不广播）。
 */
export async function runInRoomUnit<T>(fn: () => Promise<T>): Promise<T> {
  if (storage.getStore()) return fn();
  const unit: RoomUnit = { client: prisma, hooks: [] };
  const result = await runner(async (client) => {
    unit.client = client;
    return storage.run(unit, fn);
  });
  // 只有 $transaction 成功返回（已提交）才执行副作用。
  for (const hook of unit.hooks) await hook();
  return result;
}

/** 房间写入的统一入口：房间锁串行 + 同一事务边界。 */
export function withRoomUnit<T>(roomId: string, fn: () => Promise<T>): Promise<T> {
  return withRoomLock(roomId, () => runInRoomUnit(fn));
}
