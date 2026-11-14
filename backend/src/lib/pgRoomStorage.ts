/**
 * P5-1 W6.1（#182）：房间共享存储的 Postgres 实现。
 *
 * 行版本 CAS 与 W2 的 Save.revision 同范式：房间真值在 `Room` 表，`data` 列整房态
 * 序列化，`revision` 提列为 CAS 基线。每次写经「加载 revision=N 的对象 → 改 → 条件
 * 更新 WHERE revision=N 并把 revision 抬到 N+1」裁决，并发双写只有 1 个成功，
 * 另一个 `set` 返回 false（调用方据此判定冲突）。
 *
 * quota 在途账走 `RoomQuota` 表（按 quotaKey 一维），写经 `withRoomLock(quotaKey)`
 * 串行；`held` 只增不减、release 幂等，不依赖行版本（设计定稿 §3.3/§3.6）。
 *
 * 注意：本文件是「IO 边界」，roomRegistry.ts 仍保持零 IO（只认 RoomStorage 接口）。
 */
import { roomDb } from './roomUnitOfWork';
import { periodKeyOf, parsePeriodKey } from '../game/period';
import type { QuotaUsage, RoomState } from './roomTypes';
import { normalizeRoom } from './roomNormalize';

/** 深拷贝，避免 `get` 返回的副本被调用方改了之后，绕开 `set` 静默污染存储（§3.6 序列化障碍之一）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const emptyUsage = (): QuotaUsage => ({ held: 0, committed: 0 });

/**
 * W6.3：quotaKey 形如 `coop:YYYY-MM-DD:<userId>`（coop.ts::coopQuotaKey），
 * 直接用建房当天作为 `RoomQuotaDaily.periodKey`，避免跨零点结算时归错周期；
 * 通用房间键没有日期段时回退当前 UTC+8 自然日。
 */
function periodKeyForQuota(key: string): string {
  const m = /^coop:(\d{4}-\d{2}-\d{2}):/.exec(key);
  if (m && parsePeriodKey(m[1])) return m[1];
  return periodKeyOf(Date.now());
}

export class PgRoomStorage {
  /** 加载房间；返回独立副本（revision 取自 data 内的字段，与列保持一致）。 */
  async get(roomId: string): Promise<RoomState | undefined> {
    const row = await roomDb().room.findUnique({ where: { roomId } });
    if (!row) return undefined;
    const room = JSON.parse(row.data) as RoomState;
    return normalizeRoom(room);
  }

  /** 插入新房间；已存在返回 false（调用方据此返回 ROOM_EXISTS）。 */
  async create(room: RoomState): Promise<boolean> {
    // W6.2：事务内不能靠 `create` + catch P2002 —— PG 一条语句报错会把整个事务
    // 置为 aborted，后续 quota 回滚写全部失败。`skipDuplicates` 走 ON CONFLICT
    // DO NOTHING，不产生语句错误，并发建同名房只体现在 count=0。
    const res = await roomDb().room.createMany({
      data: [{
        roomId: room.roomId,
        mode: room.mode,
        status: room.status,
        revision: room.revision,
        data: JSON.stringify(room),
      }],
      skipDuplicates: true,
    });
    return res.count === 1;
  }

  /**
   * 条件更新：WHERE revision = room.revision-1 抬到 room.revision。
   * 返回 true 表示本进程抢到这一版；false 表示 CAS 失败（别人已先写）。
   */
  async set(room: RoomState): Promise<boolean> {
    const base = room.revision - 1;
    const res = await roomDb().room.updateMany({
      where: { roomId: room.roomId, revision: base },
      data: {
        revision: room.revision,
        data: JSON.stringify(room),
        updatedAt: new Date(room.updatedAt),
      },
    });
    return res.count === 1;
  }

  async delete(roomId: string): Promise<void> {
    await roomDb().room.deleteMany({ where: { roomId } });
  }

  /**
   * 同 revision 条件写回：WHERE revision = room.revision、revision 保持不变，只覆盖 data。
   * 供 `setSettledFlag` 这类 W0 钉住「不 bump revision」的写回使用；冲突返回 false。
   */
  async writeBack(room: RoomState): Promise<boolean> {
    const res = await roomDb().room.updateMany({
      where: { roomId: room.roomId, revision: room.revision },
      data: { data: JSON.stringify(room) },
    });
    return res.count === 1;
  }

  /** 全量加载（sweep 用）；副本隔离，调用方改了不影响存储。 */
  async all(): Promise<RoomState[]> {
    const rows = await roomDb().room.findMany();
    return rows.map((r) => normalizeRoom(JSON.parse(r.data) as RoomState));
  }

  async getQuota(key: string): Promise<QuotaUsage> {
    const row = await roomDb().roomQuota.findUnique({ where: { key } });
    if (!row) return emptyUsage();
    return { held: row.held, committed: row.committed };
  }

  /** quota 的写入一律走下面的原子方法；W6.3 起不再提供整行覆盖写口子。 */

  async quotaKeys(): Promise<string[]> {
    const rows = await roomDb().roomQuota.findMany({ select: { key: true } });
    return rows.map((r) => r.key);
  }

  /**
   * W6.3（#184）原子占额。房间锁 key 是 roomId，同一 quotaKey 会被不同房间并发写，
   * 所以「读 usage → 判断 → setQuota 整行覆盖」必然超卖；改用一条条件 UPDATE，
   * 由 DB 裁决 `held + committed < limit`。`createMany + skipDuplicates` 保证行存在
   * 且不产生 P2002（事务内一条语句报错会把整个 PG 事务置为 aborted）。
   */
  async tryHoldQuota(key: string, limit: number): Promise<boolean> {
    await roomDb().roomQuota.createMany({
      data: [{ key, held: 0, committed: 0 }],
      skipDuplicates: true,
    });
    const affected = await roomDb().$executeRaw`
      UPDATE "RoomQuota"
         SET "held" = "held" + 1, "updatedAt" = NOW()
       WHERE "key" = ${key}
         AND ("held" + "committed") < ${limit}
    `;
    return affected === 1;
  }

  /** W6.3：事务内二次 count —— 每日累计账才是每日上限的最终真值。 */
  async dailyCommitted(key: string): Promise<number> {
    const row = await roomDb().roomQuotaDaily.findUnique({
      where: {
        quotaKey_periodKey: { quotaKey: key, periodKey: periodKeyForQuota(key) },
      },
    });
    return row?.committed ?? 0;
  }

  /**
   * W6.3（#184）原子结算：held-1；commit 时 committed+1 并同步每日累计账。
   * 两处都是**带 limit 的条件更新**，不是 read-modify-write；任一处判定已满即返回
   * false，由 `finishQuota` 抛错让 W6.2 的工作单元整包回滚，绝不留半扣状态。
   */
  async settleQuota(key: string, commit: boolean, limit: number): Promise<boolean> {
    if (!commit) {
      await roomDb().$executeRaw`
        UPDATE "RoomQuota"
           SET "held" = GREATEST("held" - 1, 0), "updatedAt" = NOW()
         WHERE "key" = ${key}
      `;
      return true;
    }

    // ① 结算事务内二次 count（hold 时判过一次，这里再判一次）。
    if ((await this.dailyCommitted(key)) >= limit) return false;

    // ② 在途活账：committed 未达上限才 +1，同时释放 hold。
    const live = await roomDb().$executeRaw`
      UPDATE "RoomQuota"
         SET "held" = GREATEST("held" - 1, 0),
             "committed" = "committed" + 1,
             "updatedAt" = NOW()
       WHERE "key" = ${key}
         AND "committed" < ${limit}
    `;
    if (live !== 1) return false;

    // ③ 每日累计账同一事务内条件更新；唯一键 (quotaKey, periodKey) 防并发重复插入。
    const periodKey = periodKeyForQuota(key);
    await roomDb().roomQuotaDaily.createMany({
      data: [{ quotaKey: key, periodKey, committed: 0 }],
      skipDuplicates: true,
    });
    const daily = await roomDb().roomQuotaDaily.updateMany({
      where: { quotaKey: key, periodKey, committed: { lt: limit } },
      data: { committed: { increment: 1 } },
    });
    return daily.count === 1;
  }
}

export { clone as cloneRoom };
