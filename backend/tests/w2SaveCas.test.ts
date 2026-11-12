/**
 * W2 / 设计定稿 §5.3 确定性并发单测：CAS 必须只让一个写入生效。
 *
 * E2E 只能证明对外契约，证不了临界区不交错。这里用内存 fake + 强制 barrier
 * 让两个并发写**必然**读到同一 revision 后交汇，并额外注入「忽略 where 的
 * 无条件 upsert」来证明这套断言真的能抓到错误实现（去条件更新必失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  casWriteSave, RevisionConflictError,
  type SaveCasPatch, type SaveCasRow, type SaveCasStore, type SaveCasWrite,
} from '../src/lib/saveCas.js';

type Gate = { wait(): Promise<void> };

/** parties 个任务全部到达后才一起放行，杜绝靠机器负载碰运气。 */
function barrier(parties: number): Gate {
  let arrived = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => { release = r; });
  return {
    async wait() {
      arrived += 1;
      if (arrived === parties) release();
      await gate;
    },
  };
}

class FakeStore implements SaveCasStore {
  readonly rows = new Map<string, SaveCasRow>();
  readonly writes: SaveCasWrite[] = [];

  constructor(
    private readonly opts: {
      initialRevision?: number;
      gate?: Gate;
      /** 模拟 W2 之前的无条件 upsert：忽略 where 条件，永远写成功。 */
      unconditional?: boolean;
    } = {},
  ) {
    if (opts.initialRevision !== undefined) {
      this.rows.set('u1', {
        revision: opts.initialRevision,
        data: '{"tag":"base"}',
        schemaVersion: '11',
        clientId: null,
        updatedAt: new Date(0),
      });
    }
  }

  async find(userId: string): Promise<SaveCasRow | null> {
    return this.rows.get(userId) ?? null;
  }

  async updateIfRevision(userId: string, baseRevision: number, write: SaveCasWrite): Promise<number> {
    if (this.opts.gate) await this.opts.gate.wait();
    const row = this.rows.get(userId);
    if (!row) return 0;
    if (!this.opts.unconditional && row.revision !== baseRevision) return 0;
    this.writes.push(write);
    this.rows.set(userId, {
      revision: write.revision,
      data: write.data,
      schemaVersion: write.schemaVersion,
      clientId: write.clientId,
      updatedAt: write.updatedAt,
    });
    return 1;
  }

  async create(userId: string, write: SaveCasWrite): Promise<void> {
    if (this.opts.gate) await this.opts.gate.wait();
    if (this.rows.has(userId)) {
      const err: any = new Error('Unique constraint failed on userId');
      err.code = 'P2002';
      throw err;
    }
    this.writes.push(write);
    this.rows.set(userId, {
      revision: write.revision,
      data: write.data,
      schemaVersion: write.schemaVersion,
      clientId: write.clientId,
      updatedAt: write.updatedAt,
    });
  }
}

function patch(tag: string): SaveCasPatch {
  return {
    data: `{"tag":"${tag}"}`,
    schemaVersion: '11',
    clientId: tag,
    authority: '{}',
    updatedAt: new Date(1_700_000_000_000),
  };
}

type RaceResult =
  | { ok: true; revision: number; created: boolean }
  | { ok: false; err: unknown };

async function raceTwoWrites(store: SaveCasStore): Promise<RaceResult[]> {
  const run = (tag: string) => casWriteSave(store, {
    userId: 'u1', baseRevision: 5, write: patch(tag),
  }).then(
    (r): RaceResult => ({ ok: true, ...r }),
    (err): RaceResult => ({ ok: false, err }),
  );
  return Promise.all([run('A'), run('B')]);
}

/** 被测不变量：恰好一赢、输家是条件更新冲突、版本严格 +1、落库的是赢家。 */
function assertExactlyOneWinner(results: RaceResult[], store: FakeStore): void {
  const winners = results.filter((r) => r.ok);
  assert.equal(winners.length, 1, '期望恰好一个成功；两个都成功就是后写覆盖先写');
  const loser = results.find((r) => !r.ok) as { ok: false; err: unknown };
  assert.ok(loser.err instanceof RevisionConflictError, '输家必须是 DB 条件更新冲突');
  const row = store.rows.get('u1')!;
  assert.equal(row.revision, 6, 'revision 必须严格 +1，不能跳号也不能原地不动');
  assert.equal(store.writes.length, 1, '被拒绝的写入不得落库');
  assert.equal(row.data, store.writes[0].data, '落库内容只能是赢家');
  assert.equal(
    (loser.err as RevisionConflictError).row?.revision, 6,
    '冲突错误要带上服务端当前行，供 409 响应体回带',
  );
}

test('单写：条件命中时 revision 严格 +1，created=false', async () => {
  const store = new FakeStore({ initialRevision: 5 });
  const r = await casWriteSave(store, { userId: 'u1', baseRevision: 5, write: patch('A') });
  assert.deepEqual(r, { revision: 6, created: false });
  assert.equal(store.rows.get('u1')!.data, '{"tag":"A"}');
});

test('首档：create 分支 revision 从 0 到 1，created=true', async () => {
  const store = new FakeStore();
  const r = await casWriteSave(store, { userId: 'u1', baseRevision: 0, write: patch('A') });
  assert.deepEqual(r, { revision: 1, created: true });
});

test('基线过期：updateMany count=0 → 冲突且不落库，row 回带当前版本', async () => {
  const store = new FakeStore({ initialRevision: 8 });
  await assert.rejects(
    casWriteSave(store, { userId: 'u1', baseRevision: 5, write: patch('stale') }),
    (err: unknown) => {
      assert.ok(err instanceof RevisionConflictError);
      assert.equal((err as RevisionConflictError).row?.revision, 8);
      return true;
    },
  );
  assert.equal(store.writes.length, 0);
  assert.equal(store.rows.get('u1')!.revision, 8);
});

test('确定性并发（barrier 强制交汇）：两个基于同一版的写恰好 1 成功 1 冲突', async () => {
  const store = new FakeStore({ initialRevision: 5, gate: barrier(2) });
  const results = await raceTwoWrites(store);
  assertExactlyOneWinner(results, store);
});

test('首档并发：两个 create 抢同一 userId，P2002 转成冲突且只建一行', async () => {
  const store = new FakeStore({ gate: barrier(2) });
  const run = (tag: string) => casWriteSave(store, {
    userId: 'u1', baseRevision: 0, write: patch(tag),
  }).then(
    (): RaceResult => ({ ok: true, revision: 1, created: true }),
    (err): RaceResult => ({ ok: false, err }),
  );
  const results = await Promise.all([run('A'), run('B')]);
  assert.equal(results.filter((r) => r.ok).length, 1);
  const loser = results.find((r) => !r.ok) as { ok: false; err: unknown };
  assert.ok(loser.err instanceof RevisionConflictError);
  assert.equal(store.writes.length, 1);
  assert.equal(store.rows.get('u1')!.revision, 1);
});

test('反证：注入无条件 upsert（忽略 where）后「恰好一赢」断言必须失败', async () => {
  // 这条是 §5.3 要求的「去掉条件更新必失败」——证明上面的测试不是永远绿的摆设。
  const store = new FakeStore({ initialRevision: 5, gate: barrier(2), unconditional: true });
  const results = await raceTwoWrites(store);
  assert.equal(results.filter((r) => r.ok).length, 2, '无条件 upsert 会让两个写都成功');
  assert.equal(store.writes.length, 2);
  assert.equal(store.rows.get('u1')!.revision, 6, '版本只涨一次 → 后写静默覆盖先写');
  assert.throws(
    () => assertExactlyOneWinner(results, store),
    /期望恰好一个成功/,
    '确定性测试必须能抓到退化成无条件 upsert 的实现',
  );
});

test('连续写入：每次严格 +1，不跳号', async () => {
  const store = new FakeStore({ initialRevision: 0 });
  for (let rev = 0; rev < 6; rev += 1) {
    const r = await casWriteSave(store, { userId: 'u1', baseRevision: rev, write: patch(`w${rev}`) });
    assert.equal(r.revision, rev + 1);
  }
  assert.equal(store.rows.get('u1')!.revision, 6);
});
