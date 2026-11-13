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
import { prisma } from './prisma';
import type { QuotaUsage, RoomState } from './roomTypes';

/** 深拷贝，避免 `get` 返回的副本被调用方改了之后，绕开 `set` 静默污染存储（§3.6 序列化障碍之一）。 */
function clone<T>(v: T): T {
  return JSON.parse(JSON.stringify(v)) as T;
}

const emptyUsage = (): QuotaUsage => ({ held: 0, committed: 0 });

export class PgRoomStorage {
  /** 加载房间；返回独立副本（revision 取自 data 内的字段，与列保持一致）。 */
  async get(roomId: string): Promise<RoomState | undefined> {
    const row = await prisma.room.findUnique({ where: { roomId } });
    if (!row) return undefined;
    const room = JSON.parse(row.data) as RoomState;
    return room;
  }

  /** 插入新房间；已存在返回 false（调用方据此返回 ROOM_EXISTS）。 */
  async create(room: RoomState): Promise<boolean> {
    try {
      await prisma.room.create({
        data: {
          roomId: room.roomId,
          mode: room.mode,
          status: room.status,
          revision: room.revision,
          data: JSON.stringify(room),
        },
      });
      return true;
    } catch (e: any) {
      if (e?.code === 'P2002') return false; // 唯一约束冲突（并发建同名房）
      throw e;
    }
  }

  /**
   * 条件更新：WHERE revision = room.revision-1 抬到 room.revision。
   * 返回 true 表示本进程抢到这一版；false 表示 CAS 失败（别人已先写）。
   */
  async set(room: RoomState): Promise<boolean> {
    const base = room.revision - 1;
    const res = await prisma.room.updateMany({
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
    await prisma.room.deleteMany({ where: { roomId } });
  }

  /**
   * 同 revision 条件写回：WHERE revision = room.revision、revision 保持不变，只覆盖 data。
   * 供 `setSettledFlag` 这类 W0 钉住「不 bump revision」的写回使用；冲突返回 false。
   */
  async writeBack(room: RoomState): Promise<boolean> {
    const res = await prisma.room.updateMany({
      where: { roomId: room.roomId, revision: room.revision },
      data: { data: JSON.stringify(room) },
    });
    return res.count === 1;
  }

  /** 全量加载（sweep 用）；副本隔离，调用方改了不影响存储。 */
  async all(): Promise<RoomState[]> {
    const rows = await prisma.room.findMany();
    return rows.map((r) => JSON.parse(r.data) as RoomState);
  }

  async getQuota(key: string): Promise<QuotaUsage> {
    const row = await prisma.roomQuota.findUnique({ where: { key } });
    if (!row) return emptyUsage();
    return { held: row.held, committed: row.committed };
  }

  async setQuota(key: string, usage: QuotaUsage): Promise<void> {
    await prisma.roomQuota.upsert({
      where: { key },
      create: { key, held: usage.held, committed: usage.committed },
      update: { held: usage.held, committed: usage.committed },
    });
  }

  async quotaKeys(): Promise<string[]> {
    const rows = await prisma.roomQuota.findMany({ select: { key: true } });
    return rows.map((r) => r.key);
  }
}

export { clone as cloneRoom };
