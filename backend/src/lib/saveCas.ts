/**
 * W2 / P5-1 §3.1：存档写入的 CAS（compare-and-swap）策略层。
 *
 * 真值唯一在 Postgres 的 `Save.revision` 列：
 *   - 更新只命中 `revision === baseRevision` 的那一行，同时把列置为 baseRevision + 1；
 *   - 受影响行数 `count !== 1` 是 409 的**唯一**裁决依据，内存权威态不参与；
 *   - 首档走 create，`userId @unique` 抛出的 P2002 同样判 409。
 *
 * PG 默认 READ COMMITTED 下，单条条件 UPDATE 靠行锁即原子：任何把 revision 从 N 推到
 * N+1 的成功更新只能发生一次，第二次 `WHERE revision = N` 必然匹配 0 行。因此无需
 * Serializable、无需 fencing token，也无需把「读到的当前版本」当最终裁决。
 *
 * 本层是纯逻辑：DB 操作由注入的 SaveCasStore 提供，便于 node:test 用内存 fake +
 * 强制 barrier 做确定性并发（设计定稿 §5.3），也便于证明「去掉条件更新必失败」。
 */

export type SaveCasRow = {
  revision: number;
  data: string;
  schemaVersion: string;
  clientId: string | null;
  updatedAt: Date;
};

/** 一次写入要落库的字段（不含 revision，由 CAS 层推导）。 */
export type SaveCasPatch = {
  data: string;
  schemaVersion: string;
  clientId: string | null;
  /** 序列化后的 authority JSON；其中 revision 是 DB 列的只读镜像。 */
  authority: string;
  updatedAt: Date;
};

export type SaveCasWrite = SaveCasPatch & { revision: number };

/** 最小 DB 接口：真实现在 modules/session.ts 用 Prisma 适配，单测注入内存 fake。 */
export type SaveCasStore = {
  find(userId: string): Promise<SaveCasRow | null>;
  /** 条件更新，返回受影响行数；忽略 baseRevision 的 fake 会让确定性测试失败。 */
  updateIfRevision(userId: string, baseRevision: number, write: SaveCasWrite): Promise<number>;
  /** 首档创建；唯一索引冲突必须抛 { code: 'P2002' }。 */
  create(userId: string, write: SaveCasWrite): Promise<void>;
};

/** 条件更新未命中（或首档被抢先创建）时抛出，携带服务端当前行供 409 回带。 */
export class RevisionConflictError extends Error {
  readonly row: SaveCasRow | null;

  constructor(row: SaveCasRow | null) {
    super('存档已被其它端更新，条件更新未命中');
    this.name = 'RevisionConflictError';
    this.row = row;
  }
}

/**
 * 执行一次 CAS 写入。冲突时抛 RevisionConflictError；调用方必须**短路**
 * 内存 apply 与广播，不能让被拒绝的写入污染在线缓存。
 */
export async function casWriteSave(
  store: SaveCasStore,
  args: { userId: string; baseRevision: number; write: SaveCasPatch },
): Promise<{ revision: number; created: boolean }> {
  const { userId, baseRevision } = args;
  const nextRevision = baseRevision + 1;
  const write: SaveCasWrite = { ...args.write, revision: nextRevision };
  const existing = await store.find(userId);

  if (!existing) {
    try {
      await store.create(userId, write);
      return { revision: nextRevision, created: true };
    } catch (err: any) {
      if (err?.code === 'P2002') {
        throw new RevisionConflictError(await store.find(userId));
      }
      throw err;
    }
  }

  const count = await store.updateIfRevision(userId, baseRevision, write);
  if (count !== 1) {
    throw new RevisionConflictError(await store.find(userId));
  }
  return { revision: nextRevision, created: false };
}
