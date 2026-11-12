/**
 * W4 定时器选主 / fencing / 幂等键确定性单测（设计定稿 §3.4 / §5.3）。
 *
 * CI 不提供 Redis，这里用 InProcessSweepLeaseStore + 虚拟时钟，
 * 与真 Redis 语义逐条对齐（SET NX PX、token 比对、fence 单调）。
 * 真 Redis 的 Lua / TTL / 跨实例竞争由 e2e_w4_sweep.mjs 覆盖。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  InProcessSweepLeaseStore, SweepLeader, guardedCommit,
  type SweepContext,
} from '../src/lib/sweepLeader';
import { DeterministicClock } from './lib/deterministic';

const TTL = 1_000;
const IDEM_TTL = 10_000;

function fixture() {
  const clock = new DeterministicClock(10_000);
  const store = new InProcessSweepLeaseStore(() => clock.now());
  const make = (id: string) => new SweepLeader(store, id, {
    ttlMs: TTL, idemTtlMs: IDEM_TTL, now: () => clock.now(),
  });
  return { clock, store, make };
}

test('W4-1 单实例恒为 leader，续租不重新编号 fence', async () => {
  const { clock, make } = fixture();
  const leader = make('A');
  let runs = 0;
  let fence = 0;
  const r1 = await leader.run(async (ctx) => { runs += 1; fence = ctx.fence; return 'ok'; });
  clock.advance(TTL / 2);
  const r2 = await leader.run(async (ctx) => { runs += 1; assert.equal(ctx.fence, fence); return 'ok2'; });
  assert.equal(r1, 'ok');
  assert.equal(r2, 'ok2');
  assert.equal(runs, 2);
  assert.equal(leader.diagnostics().leader, true);
  assert.equal(fence, 1);
});

test('W4-2 双实例共享 store：同时只有 1 个 leader，非 leader 的 fn 不执行', async () => {
  const { make } = fixture();
  const a = make('A');
  const b = make('B');
  let aRuns = 0;
  let bRuns = 0;
  const ra = await a.run(async () => { aRuns += 1; return 1; });
  const rb = await b.run(async () => { bRuns += 1; return 2; });
  assert.equal(ra, 1);
  assert.equal(rb, null);
  assert.equal(aRuns, 1);
  assert.equal(bRuns, 0);
  assert.equal(a.diagnostics().leader, true);
  assert.equal(b.diagnostics().leader, false);
});

test('W4-3 leader 交出后新 leader 接管，fence 严格递增', async () => {
  const { make } = fixture();
  const a = make('A');
  const b = make('B');
  const first = await a.run(async (ctx) => ctx.fence);
  assert.equal(first, 1);
  await a.shutdown();
  const second = await b.run(async (ctx) => ctx.fence);
  assert.equal(second, 2);
  assert.ok(second > first);
  assert.equal(a.diagnostics().leader, false);
  assert.equal(b.diagnostics().leader, true);
});

test('W4-4 过期 leader 的 guard / guardedCommit 全拒，publish 动作不执行', async () => {
  const { make } = fixture();
  const a = make('A');
  const b = make('B');
  let oldCtx: SweepContext | null = null;
  await a.run(async (ctx) => { oldCtx = ctx; });
  assert.ok(oldCtx);
  await a.shutdown();
  await b.run(async () => {});
  assert.equal(await (oldCtx as SweepContext).guard(), false);
  let published = 0;
  const ok = await guardedCommit(oldCtx as SweepContext, 'wild:area:1', () => { published += 1; });
  assert.equal(ok, false);
  assert.equal(published, 0);
});

test('W4-5 TTL 过期（leader 未主动 shutdown）后其它实例接管且旧 guard 失效', async () => {
  const { clock, make } = fixture();
  const a = make('A');
  const b = make('B');
  let oldCtx: SweepContext | null = null;
  await a.run(async (ctx) => { oldCtx = ctx; });
  clock.advance(TTL + 1);
  const fence = await b.run(async (ctx) => ctx.fence);
  assert.equal(fence, 2);
  assert.equal(await (oldCtx as SweepContext).guard(), false);
  // A 下一次心跳发现自己已失主，缓存清空，不会继续跑全局 sweep。
  assert.equal(await a.run(async () => 'should-not-run'), null);
  assert.equal(a.diagnostics().leader, false);
});

test('W4-6 幂等键：同 bucket 只提交一次，提交成功才执行动作', async () => {
  const { make } = fixture();
  const leader = make('A');
  await leader.run(async (ctx) => {
    let commits = 0;
    const first = await guardedCommit(ctx, 'sweep:sessions:7', () => { commits += 1; });
    const second = await guardedCommit(ctx, 'sweep:sessions:7', () => { commits += 1; });
    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(commits, 1);
    // 不同 bucket 是不同动作，不受上一个键影响。
    const other = await guardedCommit(ctx, 'sweep:sessions:8', () => { commits += 1; });
    assert.equal(other, true);
    assert.equal(commits, 2);
  });
});

test('W4-7 房间 tick 短期 claim：用完释放，新 revision 不会被饿死', async () => {
  const { make } = fixture();
  const leader = make('A');
  await leader.run(async (ctx) => {
    const t1 = await ctx.claim('room:r1:1', 5_000);
    assert.ok(t1);
    const t2 = await ctx.claim('room:r1:1', 5_000);
    assert.equal(t2, null);
    await ctx.releaseClaim('room:r1:1', t1 as string);
    // 同 revision 释放后仍可再 claim（单实例连续 tick 不被自己挡住）；
    // 真正跨实例互斥发生在「同一时刻重叠」的那次 claim 上。
    const t3 = await ctx.claim('room:r1:1', 5_000);
    assert.ok(t3);
    const t4 = await ctx.claim('room:r1:2', 5_000);
    assert.ok(t4, 'revision 变了必须用新键');
  });
});

test('W4-8 幂等键释放必须带正确 token，错误 token 不误删', async () => {
  const { make } = fixture();
  const leader = make('A');
  await leader.run(async (ctx) => {
    const mine = await ctx.claim('quota:release:b1');
    assert.ok(mine);
    await ctx.releaseClaim('quota:release:b1', 'other-instance:fake');
    const again = await ctx.claim('quota:release:b1');
    assert.equal(again, null, '错误 token 不能删掉别人的键');
    await ctx.releaseClaim('quota:release:b1', mine as string);
    const after = await ctx.claim('quota:release:b1');
    assert.ok(after);
  });
});

test('W4-9 结算标记共享 CAS 门：同 room 只领一次', async () => {
  const { make } = fixture();
  const leader = make('A');
  await leader.run(async (ctx) => {
    let settled = 0;
    await guardedCommit(ctx, 'settle:coop:r9', () => { settled += 1; });
    await guardedCommit(ctx, 'settle:coop:r9', () => { settled += 1; });
    assert.equal(settled, 1);
  });
});

test('W4-10 shutdown 幂等，重复交出不抛错也不影响新 leader', async () => {
  const { make } = fixture();
  const a = make('A');
  const b = make('B');
  await a.run(async () => {});
  await a.shutdown();
  await a.shutdown();
  const fence = await b.run(async (ctx) => ctx.fence);
  assert.equal(fence, 2);
});

test('W4-11 250ms lightContext 只在持有 lease 时存在，且不刷新租约', async () => {
  const { clock, make } = fixture();
  const a = make('A');
  const b = make('B');
  assert.equal(a.lightContext(), null);
  await a.run(async () => {});
  assert.ok(a.lightContext());
  // 只用 lightContext 不续租：TTL 到了就被 B 接管。
  assert.ok(a.lightContext());
  clock.advance(TTL + 1);
  assert.equal(await b.run(async (ctx) => ctx.fence), 2);
  assert.equal(await a.verifyCurrent(), false);
});
