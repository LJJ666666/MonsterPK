/**
 * P5-1 W6.2（#183）确定性单测：房间工作单元的事务边界（零 IO，§5.3 口径）。
 *
 * 用注入的 fake runner / fake client 证明四件事，不依赖 PG 实例，CI 也能跑：
 *  1. room / quota / Save / 奖励的读写都取到**同一个事务客户端**；
 *  2. 内存态 apply 与 WS 广播只在事务成功返回后才执行；
 *  3. 事务失败（模拟回滚）时钩子全部丢弃、错误冒泡，不会留下半状态；
 *  4. 嵌套不新开事务、同 roomId 串行、建房冲突不产生 P2002 语句错误。
 */
import test, { afterEach } from 'node:test';
import assert from 'node:assert/strict';
import type { PrismaClient } from '@prisma/client';
import {
  runInRoomUnit, roomDb, onRoomCommit, isRoomUnitActive,
  setRoomUnitRunnerForTest, withRoomUnit,
} from '../src/lib/roomUnitOfWork';
import { PgRoomStorage } from '../src/lib/pgRoomStorage';
import type { RoomState } from '../src/lib/roomTypes';

type Call = { model: string; op: string };

/** 记录所有 DB 调用的 fake client：任何 model / op 都被 Proxy 接住。 */
function fakeClient(calls: Call[], countResult = 1): PrismaClient {
  const model = (name: string) => new Proxy({}, {
    get: (_t, op: string) => async () => {
      calls.push({ model: name, op });
      if (op === 'findUnique') return null;
      if (op === 'findMany') return [];
      return { count: countResult };
    },
  });
  return {
    room: model('room'),
    roomQuota: model('roomQuota'),
    save: model('save'),
    coopRewardGrant: model('coopRewardGrant'),
    // W6.3：占额改走条件 UPDATE，fake 需接住模板标签调用。
    $executeRaw: async () => { calls.push({ model: '$executeRaw', op: 'raw' }); return 1; },
  } as unknown as PrismaClient;
}

function minimalRoom(roomId: string): RoomState {
  return {
    roomId, mode: 'kernel', status: 'forming', revision: 1,
    createdAt: 1, updatedAt: 1, seats: [], turn: 1, deadlineAt: 0,
    submitted: [], turnIntents: [], lastAction: null, quota: null,
    allOfflineSince: null, seenNonces: [], endReason: null,
    pvp: null, coop: null, pvpSettled: false, coopSettled: false,
    coopBossId: null,
  } as RoomState;
}

afterEach(() => setRoomUnitRunnerForTest(null));

test('W6.2 roomDb 在工作单元内返回事务客户端，工作单元外恢复全局单例', async () => {
  const client = fakeClient([]);
  setRoomUnitRunnerForTest((fn) => fn(client));
  let inside: PrismaClient | null = null;
  await runInRoomUnit(async () => {
    inside = roomDb();
    assert.equal(isRoomUnitActive(), true);
  });
  assert.equal(inside, client);
  assert.equal(isRoomUnitActive(), false);
  assert.notEqual(roomDb(), client);
});

test('W6.2 副作用只在事务成功返回后按注册顺序执行', async () => {
  const order: string[] = [];
  setRoomUnitRunnerForTest(async (fn) => {
    order.push('tx:begin');
    const value = await fn(fakeClient([]));
    order.push('tx:commit');
    return value;
  });
  const value = await runInRoomUnit(async () => {
    onRoomCommit(() => order.push('hook:1'));
    onRoomCommit(() => order.push('hook:2'));
    order.push('body');
    return 'ok';
  });
  assert.equal(value, 'ok');
  assert.deepEqual(order, ['tx:begin', 'body', 'tx:commit', 'hook:1', 'hook:2']);
});

test('W6.2 事务失败时钩子全部丢弃且错误冒泡（不留 room settled / 奖励缺失半状态）', async () => {
  let ran = 0;
  setRoomUnitRunnerForTest(async (fn) => {
    await fn(fakeClient([]));
    throw new Error('TX_ROLLBACK');
  });
  await assert.rejects(
    () => runInRoomUnit(async () => { onRoomCommit(() => { ran += 1; }); }),
    /TX_ROLLBACK/,
  );
  assert.equal(ran, 0);
});

test('W6.2 嵌套工作单元复用外层事务，不新开连接', async () => {
  let opens = 0;
  const client = fakeClient([]);
  setRoomUnitRunnerForTest((fn) => { opens += 1; return fn(client); });
  await runInRoomUnit(async () => {
    const outer = roomDb();
    await runInRoomUnit(async () => { assert.equal(roomDb(), outer); });
  });
  assert.equal(opens, 1);
});

test('W6.2 room + quota + 存档 + 奖励四类读写共用同一事务客户端', async () => {
  const calls: Call[] = [];
  const client = fakeClient(calls);
  setRoomUnitRunnerForTest((fn) => fn(client));
  const storage = new PgRoomStorage();
  const room = minimalRoom('w62_r1');

  await runInRoomUnit(async () => {
    assert.equal(await storage.create(room), true);
    room.revision = 2;
    assert.equal(await storage.set(room), true);
    // W6.3：旧 setQuota 整行覆盖写已删除，改用原子占额验证同一事务客户端。
    assert.equal(await storage.tryHoldQuota('w62:quota', 3), true);
    await storage.getQuota('w62:quota');
    await (roomDb() as any).save.findUnique({ where: { userId: 'u' } });
    await (roomDb() as any).coopRewardGrant.count({ where: { userId: 'u' } });
  });

  const models = new Set(calls.map((c) => c.model));
  for (const m of ['room', 'roomQuota', 'save', 'coopRewardGrant']) {
    assert.ok(models.has(m), `缺少 ${m} 的读写`);
  }
  assert.equal(calls.filter((c) => c.model === 'room' && c.op === 'createMany').length, 1);
  assert.equal(calls.filter((c) => c.model === 'room' && c.op === 'updateMany').length, 1);
  assert.equal(calls.filter((c) => c.model === 'roomQuota' && c.op === 'createMany').length, 1);
});

test('W6.2 建房冲突走 skipDuplicates，返回 false 而不是抛 P2002 把事务置为 aborted', async () => {
  const calls: Call[] = [];
  const client = fakeClient(calls, 0);
  setRoomUnitRunnerForTest((fn) => fn(client));
  const storage = new PgRoomStorage();
  const created = await runInRoomUnit(() => storage.create(minimalRoom('w62_dup')));
  assert.equal(created, false);
  assert.equal(calls.filter((c) => c.op === 'createMany').length, 1);
});

test('W6.2 非事务上下文的副作用立即执行（旧调用链行为不变）', () => {
  let ran = 0;
  onRoomCommit(() => { ran += 1; });
  assert.equal(ran, 1);
});

test('W6.2 withRoomUnit 同一 roomId 严格串行、两次事务不交错', async () => {
  const order: string[] = [];
  let opens = 0;
  setRoomUnitRunnerForTest((fn) => { opens += 1; return fn(fakeClient([])); });
  await Promise.all([
    withRoomUnit('r1', async () => {
      order.push('a1');
      await new Promise((r) => setTimeout(r, 10));
      order.push('a2');
    }),
    withRoomUnit('r1', async () => {
      order.push('b1');
      order.push('b2');
    }),
  ]);
  assert.deepEqual(order, ['a1', 'a2', 'b1', 'b2']);
  assert.equal(opens, 2);
});
