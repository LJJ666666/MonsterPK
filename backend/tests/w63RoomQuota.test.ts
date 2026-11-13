/**
 * P5-1 W6.3（#184）确定性单测：房间 quota 的 DB 原子计数与结算二次 count（零 IO，§5.3 口径）。
 *
 * 分两层，互不替代：
 *  A. InMemoryRoomStorage + 真实 RoomRegistry —— 验证「近阈值并发开局不超卖」的语义，
 *     以及 hold → commit → 每日累计账的账目关系（并发 6 房只成 3 房、committed 恰好 3）。
 *  B. PgRoomStorage + 注入的 fake 事务客户端 —— 验证实现形态确实是**条件更新**而不是
 *     read-modify-write：占额一条 `$executeRaw`、结算先二次 count 再两处条件更新、
 *     所有读写共用同一个 tx、超限时短路且抛错让工作单元整包回滚。
 *
 * 真库并发裁决由 `e2e_w63_quota.mjs` 覆盖（这里 fake 不模拟 PG 行锁）。
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  RoomRegistry, InMemoryRoomStorage, RoomQuotaExceededError,
} from '../src/lib/roomRegistry';
import { PgRoomStorage } from '../src/lib/pgRoomStorage';
import {
  runInRoomUnit, roomDb, onRoomCommit, setRoomUnitRunnerForTest,
} from '../src/lib/roomUnitOfWork';

const NOW = 1_700_000_000_000;
const OWNER = { userId: 'u_a', tokenDigest: 'digest_a', connectionId: 'conn_a' };
const CFG = {
  maxSeats: 2, roundTimeoutMs: 20_000, roomTtlMs: 30 * 60_000,
  allOfflineTimeoutMs: 60_000, formingTimeoutMs: 60_000,
} as any;

function regWith(storage: InMemoryRoomStorage, ids?: () => string): RoomRegistry {
  let seq = 0;
  return new RoomRegistry({
    storage,
    configFor: () => CFG,
    policy: { pick: () => 'move_1' },
    idFactory: ids ?? (() => `w63_room_${++seq}`),
  });
}

/** 记录调用形态的 fake 事务客户端；$executeRaw 按序返回可配置的受影响行数。 */
function fakeClient(opts: {
  calls: string[];
  executeResults?: number[];
  daily?: number | null;
  dailyUpdateCount?: number;
}): PrismaClient {
  let execIdx = 0;
  return {
    roomQuota: {
      createMany: async () => { opts.calls.push('roomQuota.createMany'); return { count: 1 }; },
      findUnique: async () => { opts.calls.push('roomQuota.findUnique'); return null; },
      findMany: async () => { opts.calls.push('roomQuota.findMany'); return []; },
      upsert: async () => { opts.calls.push('roomQuota.upsert'); return {}; },
    },
    roomQuotaDaily: {
      findUnique: async () => {
        opts.calls.push('roomQuotaDaily.findUnique');
        return opts.daily === null || opts.daily === undefined ? null : { committed: opts.daily };
      },
      createMany: async () => { opts.calls.push('roomQuotaDaily.createMany'); return { count: 1 }; },
      updateMany: async () => {
        opts.calls.push('roomQuotaDaily.updateMany');
        return { count: opts.dailyUpdateCount ?? 1 };
      },
    },
    $executeRaw: async (_strings: TemplateStringsArray, ..._values: unknown[]) => {
      opts.calls.push('$executeRaw');
      const n = opts.executeResults?.[execIdx] ?? 1;
      execIdx += 1;
      return n;
    },
  } as unknown as PrismaClient;
}

afterEach(() => setRoomUnitRunnerForTest(null));

test('W6.3 存储层 tryHoldQuota 在近阈值并发下只放行 limit 次', async () => {
  const s = new InMemoryRoomStorage();
  const results = await Promise.all(Array.from({ length: 6 }, () => s.tryHoldQuota('k', 3)));
  assert.equal(results.filter(Boolean).length, 3);
  assert.deepEqual(await s.getQuota('k'), { held: 3, committed: 0 });
});

test('W6.3 并发建 6 房（同 quotaKey / limit=3）只成 3 房，其余 ROOM_QUOTA_EXHAUSTED', async () => {
  const s = new InMemoryRoomStorage();
  const reg = regWith(s);
  const rs = await Promise.all(Array.from({ length: 6 }, () =>
    reg.create({ mode: 'kernel', owner: OWNER, quotaKey: 'w63_q', quotaLimit: 3, now: NOW })));
  assert.equal(rs.filter((r) => r.ok === true).length, 3);
  assert.equal(rs.filter((r) => 'code' in r && r.code === 'ROOM_QUOTA_EXHAUSTED').length, 3);
  assert.deepEqual(await s.getQuota('w63_q'), { held: 3, committed: 0 });
});

test('W6.3 建房把服务端 limit 随房间态落库（结算二次 count 的依据）', async () => {
  const s = new InMemoryRoomStorage();
  const reg = regWith(s, () => 'w63_limit_room');
  const r = await reg.create({ mode: 'kernel', owner: OWNER, quotaKey: 'w63_q', quotaLimit: 3, now: NOW });
  assert.equal(r.ok, true);
  const room = await reg.get('w63_limit_room');
  assert.equal(room?.quota?.limit, 3);
});

test('W6.3 三房并发结算后 committed=3 / held=0 / 每日累计账=3，重复结算不多扣', async () => {
  const s = new InMemoryRoomStorage();
  let seq = 0;
  const reg = regWith(s, () => `w63_settle_${++seq}`);
  const ids = ['w63_settle_1', 'w63_settle_2', 'w63_settle_3'];
  await Promise.all(ids.map((id) =>
    reg.create({ roomId: id, mode: 'kernel', owner: OWNER, quotaKey: 'w63_q', quotaLimit: 3, now: NOW })));
  const settled = await Promise.all(ids.map((id) => reg.settle(id, NOW)));
  assert.ok(settled.every((r) => r.ok === true));
  assert.deepEqual(await s.getQuota('w63_q'), { held: 0, committed: 3 });
  assert.equal(await s.dailyCommitted('w63_q'), 3);
  // 幂等：重复 settle 不应再动账。
  await Promise.all(ids.map((id) => reg.settle(id, NOW)));
  assert.deepEqual(await s.getQuota('w63_q'), { held: 0, committed: 3 });
  assert.equal(await s.dailyCommitted('w63_q'), 3);
});

test('W6.3 release 只减 held，不动 committed 与每日累计账', async () => {
  const s = new InMemoryRoomStorage();
  await s.tryHoldQuota('w63_q', 3);
  assert.equal(await s.settleQuota('w63_q', false, 3), true);
  assert.deepEqual(await s.getQuota('w63_q'), { held: 0, committed: 0 });
  assert.equal(await s.dailyCommitted('w63_q'), 0);
});

test('W6.3 PgRoomStorage 占额是一条条件 UPDATE，不做 read-modify-write', async () => {
  const calls: string[] = [];
  const client = fakeClient({ calls });
  setRoomUnitRunnerForTest((fn) => fn(client));
  await runInRoomUnit(async () => {
    assert.equal(roomDb(), client, 'PgRoomStorage 必须取事务客户端');
    const s = new PgRoomStorage();
    assert.equal(await s.tryHoldQuota('w63_q', 3), true);
  });
  assert.ok(calls.includes('$executeRaw'), '必须有条件 UPDATE');
  assert.ok(!calls.includes('roomQuota.findUnique'), '不得再读整行');
  assert.ok(!calls.includes('roomQuota.upsert'), '不得整行覆盖写');
});

test('W6.3 结算先二次 count，再在途账 + 每日累计账两处条件更新', async () => {
  const calls: string[] = [];
  const client = fakeClient({ calls, daily: 0, dailyUpdateCount: 1 });
  setRoomUnitRunnerForTest((fn) => fn(client));
  await runInRoomUnit(async () => {
    const ok = await new PgRoomStorage().settleQuota('w63_q', true, 3);
    assert.equal(ok, true);
  });
  assert.equal(calls[0], 'roomQuotaDaily.findUnique', '第一件事必须是事务内二次 count');
  assert.equal(calls.filter((c) => c === '$executeRaw').length, 1, '在途账一条条件 UPDATE');
  assert.ok(calls.includes('roomQuotaDaily.updateMany'), '每日累计账条件 +1');
});

test('W6.3 二次 count 已满时短路（零写入），抛错让工作单元整包回滚', async () => {
  const calls: string[] = [];
  const client = fakeClient({ calls, daily: 3 });
  setRoomUnitRunnerForTest((fn) => fn(client));
  const hooks: string[] = [];
  await assert.rejects(
    runInRoomUnit(async () => {
      onRoomCommit(() => hooks.push('after-commit'));
      const ok = await new PgRoomStorage().settleQuota('w63_q', true, 3);
      assert.equal(ok, false);
      throw new RoomQuotaExceededError('w63_q', 3);
    }),
    /ROOM_QUOTA_EXCEEDED/,
  );
  assert.deepEqual(hooks, [], '回滚后提交后副作用必须全部丢弃');
  assert.deepEqual(calls, ['roomQuotaDaily.findUnique'], '超限短路不得产生任何写');
});

test('W6.3 在途账条件更新失败（committed 已满）不写每日累计账', async () => {
  const calls: string[] = [];
  const client = fakeClient({ calls, daily: 0, executeResults: [0] });
  setRoomUnitRunnerForTest((fn) => fn(client));
  await runInRoomUnit(async () => {
    assert.equal(await new PgRoomStorage().settleQuota('w63_q', true, 3), false);
  });
  assert.ok(!calls.includes('roomQuotaDaily.updateMany'));
  assert.ok(!calls.includes('roomQuotaDaily.createMany'));
});
