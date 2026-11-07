/**
 * P4-2c Boss 伤害榜聚合与次数在途闸的单测（零 IO）。
 *
 * 榜单口径：**按账号合并多槽位**（限次按账号计，按槽位拆会变成刷榜）；
 * 次数口径：已用次数由 DB 事件行数传入，内存只保证「同时开工不超卖」。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildBossBoard, summarizeRuns, type BossRunRow } from '../src/game/bossRank.js';
import { BossQuotaLedger } from '../src/lib/bossQuota.js';

const run = (userId: string, username: string, slot: number, damage: number): BossRunRow => ({
  userId, username, slot, damage, createdAt: 0,
});

test('summarizeRuns：只统计本账号，累计 / 最高 / 次数正确', () => {
  const rows = [
    run('u1', '杰哥', 1, 100),
    run('u1', '杰哥', 2, 350),
    run('u2', '别人', 1, 9999),
  ];
  assert.deepEqual(summarizeRuns(rows, 'u1'), { total: 450, best: 350, attempts: 2 });
  assert.deepEqual(summarizeRuns(rows, 'nobody'), { total: 0, best: 0, attempts: 0 });
});

test('buildBossBoard：按账号合并多槽位，而不是按槽位各占一行', () => {
  const rows = [
    run('u1', '杰哥', 1, 100),
    run('u1', '杰哥', 2, 200),
    run('u2', '别人', 1, 350),
  ];
  const board = buildBossBoard(rows, 20);
  assert.equal(board.length, 2, '两个账号只有两行');
  const me = board.find((r) => r.username === '杰哥')!;
  assert.equal(me.damage, 300);
  assert.equal(me.best, 200);
  assert.equal(me.attempts, 2);
  // 350 > 300，所以别人第一
  assert.equal(board[0].username, '别人');
  assert.equal(board[1].rank, 2);
});

test('buildBossBoard：累计相同看单场最高，再按用户名稳定排序', () => {
  const rows = [
    run('u1', '甲', 1, 100),
    run('u1', '甲', 2, 100),
    run('u2', '乙', 1, 150),
    run('u2', '乙', 2, 50),
  ];
  const board = buildBossBoard(rows, 20);
  assert.deepEqual(board.map((r) => r.username), ['乙', '甲'], '同为 200，单场最高 150 > 100');
});

test('buildBossBoard：isMe 只按账号标记，limit 被钳制且不改变排序', () => {
  const rows = [
    run('u1', '甲', 1, 10), run('u2', '乙', 1, 20), run('u3', '丙', 1, 30),
  ];
  const board = buildBossBoard(rows, 2, 'u3');
  assert.equal(board.length, 2);
  assert.equal(board[0].isMe, true);
  assert.equal(board[1].isMe, false);
  assert.equal(buildBossBoard(rows, 999).length, 3);
  assert.equal(buildBossBoard(rows, -5).length, 1, 'limit 下限 1');
});

test('buildBossBoard：空 / 脏数据不炸', () => {
  assert.deepEqual(buildBossBoard([], 20), []);
  assert.deepEqual(buildBossBoard(null as any, 20), []);
  const board = buildBossBoard([
    run('u1', '甲', 1, NaN as any),
    { ...run('u2', '', 1, 5) } as any,
  ], 20);
  // NaN 记为 0，但空用户名那行仍会被收进来（用户名由服务端保证，不在这里兜）
  assert.equal(board.length, 2);
  assert.equal(board[0].damage, 5);
});

test('BossQuotaLedger：在途 + 已用达到上限后拒绝，release 后可再占', () => {
  const q = new BossQuotaLedger();
  const key = 'boss:daily:2026-11-07:b1:u1';
  assert.equal(q.hold(key, 0, 2), true);
  assert.equal(q.hold(key, 0, 2), true);
  assert.equal(q.hold(key, 0, 2), false, '两个在途已占满');
  assert.equal(q.heldOf(key), 2);

  q.release(key);
  assert.equal(q.heldOf(key), 1);
  assert.equal(q.hold(key, 0, 2), true, '释放一个后可以再占');

  q.commit(key);
  assert.equal(q.heldOf(key), 1, 'commit 只释放在途，不加已用（已用看 DB）');
});

test('BossQuotaLedger：DB 已用次数参与计算，跨 key 互不影响', () => {
  const q = new BossQuotaLedger();
  const k1 = 'boss:daily:2026-11-07:b1:u1';
  const k2 = 'boss:daily:2026-11-07:b1:u2';
  assert.equal(q.hold(k1, 2, 3), true);
  assert.equal(q.hold(k1, 2, 3), false, '已用 2 + 在途 1 = 3');
  assert.equal(q.hold(k2, 2, 3), true, '别的账号不受影响');
  assert.deepEqual(q.stats(), { keys: 2, held: 2 });
});

test('BossQuotaLedger：释放不存在的 key 不产生负数', () => {
  const q = new BossQuotaLedger();
  q.release('nope');
  assert.equal(q.heldOf('nope'), 0);
  assert.equal(q.usageOf('nope', 4).committed, 4);
});
