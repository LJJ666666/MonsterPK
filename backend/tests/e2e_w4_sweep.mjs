/**
 * W4 / 设计定稿 §3.4 + §4.2：定时器选主 + fencing + 幂等键（真 Redis）。
 * 运行：cd backend && npm run e2e:w4（需 :3001 已在线、PG + Redis 可用）
 *
 * 用 `node --import tsx` 直接 import 产品 TS 模块，不复制 Lua / 键规则。
 *
 * 为什么不临时起 :3002：两个独立 `SweepLeader` 共享同一个真 Redis 已等价
 * 「两个进程各持自己的缓存」；且测试键带独立前缀，**绝不抢常驻 :3001 的
 * leader 租约**（否则会让 :3001 的 250ms 房间定时器停摆，连锁污染后续 E2E）。
 *
 * 分区：
 *  A 启动诊断   :3001 health.sweep 是 redis + 真 leader + fence/TTL；Redis PING
 *  B 双 leader  同命名空间同时只有 1 个 leader；非 leader 的 fn / 广播都不执行
 *  C kill 接管  leader shutdown 后新 leader 接管、fence 递增、旧 guard 全拒
 *  D TTL 接管   leader 不交出、租约自然过期后其它实例接管
 *  E 幂等键     sweep bucket / quota.release / 结算 / wild 广播 / 房间短期 claim
 *  F 隔离       生产 `lock:sweep:global` 未被测试污染，:3001 仍是真 leader
 *
 * 输出逐例 [PASS]/[FAIL]，末尾 E2E_W4_RESULT；任一失败 exit 1。
 */
import Redis from 'ioredis';
import {
  Suite, RUN, requireBackend, loadBackendEnv, sleep, formatFatal,
} from './lib/harness.mjs';

const suite = new Suite('E2E_W4');
const PFX = `w4e2e:${RUN}:`;

const healthAt = async (base) => {
  const r = await fetch(`${base}/api/health`, { signal: AbortSignal.timeout(2_000) });
  return { status: r.status, data: await r.json() };
};

async function main() {
  await requireBackend();
  loadBackendEnv();
  const {
    SweepLeader, createRedisSweepLeaseStore, guardedCommit,
    SWEEP_LEASE_KEY, SWEEP_FENCE_KEY,
  } = await import('../src/lib/sweepLeader.ts');

  const redis = new Redis(process.env.REDIS_URL ?? 'redis://127.0.0.1:6379', {
    maxRetriesPerRequest: 2,
  });
  let aborted = false;

  try {
    // ————————————————— A：启动诊断 —————————————————
    const h = await healthAt('http://127.0.0.1:3001');
    const sw = h.data?.sweep ?? {};
    suite.check('A0 :3001 health.sweep 已装配且 mode=redis',
      h.status === 200 && sw.mode === 'redis', `mode=${sw.mode}`);
    suite.check('A1 :3001 是本地缓存 leader 且共享态确认 current=true',
      sw.leader === true && sw.current === true,
      `leader=${sw.leader} current=${sw.current}`);
    suite.check('A2 fence 已起号且 TTL / 幂等 TTL 合理',
      Number.isInteger(sw.fence) && sw.fence >= 1 && sw.ttlMs >= 10_000 && sw.idemTtlMs >= 60_000,
      `fence=${sw.fence} ttl=${sw.ttlMs} idem=${sw.idemTtlMs}`);
    suite.check('A3 本地 Redis PING 通', (await redis.ping()) === 'PONG');
    suite.check('A4 生产租约键与 fence 计数器都存在',
      (await redis.get(SWEEP_LEASE_KEY)) !== null && (await redis.get(SWEEP_FENCE_KEY)) !== null,
      `lease=${await redis.get(SWEEP_LEASE_KEY)} fence=${await redis.get(SWEEP_FENCE_KEY)}`);

    // ————————————————— B：双 leader 互斥 —————————————————
    const pB = `${PFX}b:`;
    const storeA = createRedisSweepLeaseStore(redis, pB);
    const storeB = createRedisSweepLeaseStore(redis, pB);
    const a = new SweepLeader(storeA, 'inst-A', { ttlMs: 20_000, idemTtlMs: 30_000 });
    const b = new SweepLeader(storeB, 'inst-B', { ttlMs: 20_000, idemTtlMs: 30_000 });
    let aRuns = 0;
    let bRuns = 0;
    let ctxA = null;
    const resA = await a.run(async (ctx) => { aRuns += 1; ctxA = ctx; return 'done'; });
    const resB = await b.run(async () => { bRuns += 1; return 'done'; });
    suite.check('B0 leader A 的 sweep fn 执行且返回结果', resA === 'done' && aRuns === 1,
      `res=${resA} runs=${aRuns}`);
    suite.check('B1 非 leader B 的 sweep fn 完全不执行', resB === null && bRuns === 0,
      `res=${resB} runs=${bRuns}`);
    suite.check('B2 两者 leader 诊断恰好一真一假',
      a.diagnostics().leader === true && b.diagnostics().leader === false,
      `A=${a.diagnostics().leader} B=${b.diagnostics().leader}`);
    suite.check('B3 当前 leader 的 guard 通过、lightContext 存在',
      (await ctxA.guard()) === true && a.lightContext() !== null);
    suite.check('B4 非 leader 没有 lightContext（250ms 房间 timer 不会双推进）',
      b.lightContext() === null);
    let commits = 0;
    const c1 = await guardedCommit(ctxA, 'sweep:sessions:100', () => { commits += 1; });
    const c2 = await guardedCommit(ctxA, 'sweep:sessions:100', () => { commits += 1; });
    suite.check('B5 同一心跳 bucket 的全局 sweep 只提交一次（提交成功才动作）',
      c1 === true && c2 === false && commits === 1, `c1=${c1} c2=${c2} commits=${commits}`);

    // ————————————————— C：leader kill 接管 —————————————————
    const fenceA = ctxA.fence;
    await a.shutdown();
    const fenceB = await b.run(async (ctx) => ctx.fence);
    suite.check('C0 leader 交出租约后 B 立刻接管', fenceB !== null, `fenceB=${fenceB}`);
    suite.check('C1 fencing 严格递增', Number.isInteger(fenceB) && fenceB > fenceA,
      `A=${fenceA} B=${fenceB}`);
    suite.check('C2 旧 leader 的 guard 被共享态拒绝', (await ctxA.guard()) === false);
    let published = 0;
    const stale = await guardedCommit(ctxA, 'wild:area:1:100', () => { published += 1; });
    suite.check('C3 过期 leader 的广播动作不执行（提交成功才 publish）',
      stale === false && published === 0, `stale=${stale} published=${published}`);
    const back = await a.run(async () => 'revived');
    suite.check('C4 旧 leader 不会意外抢回租约', back === null, `back=${back}`);

    // ————————————————— D：TTL 自然过期接管 —————————————————
    const pD = `${PFX}ttl:`;
    const dA = new SweepLeader(createRedisSweepLeaseStore(redis, pD), 'ttl-A', { ttlMs: 1_200 });
    const dB = new SweepLeader(createRedisSweepLeaseStore(redis, pD), 'ttl-B', { ttlMs: 1_200 });
    let ctxD = null;
    const fenceD = await dA.run(async (ctx) => { ctxD = ctx; return ctx.fence; });
    suite.check('D0 短 TTL leader 先拿到租约', Number.isInteger(fenceD) && fenceD >= 1,
      `fence=${fenceD}`);
    const blocked = await dB.run(async () => 'too-early');
    suite.check('D1 租约未过期时其它实例仍被挡住', blocked === null, `blocked=${blocked}`);
    await sleep(1_500);
    const fenceD2 = await dB.run(async (ctx) => ctx.fence);
    suite.check('D2 TTL 过期后新实例接管且 fence 递增',
      Number.isInteger(fenceD2) && fenceD2 > fenceD, `before=${fenceD} after=${fenceD2}`);
    suite.check('D3 过自然期的旧 leader guard 失效', (await ctxD.guard()) === false);

    // ————————————————— E：四类幂等键 —————————————————
    const pE = `${PFX}idem:`;
    const e = new SweepLeader(createRedisSweepLeaseStore(redis, pE), 'idem-A', { ttlMs: 20_000 });
    await e.run(async (ctx) => {
      const quota1 = await guardedCommit(ctx, 'quota:release:battle-1', () => {});
      const quota2 = await guardedCommit(ctx, 'quota:release:battle-1', () => {});
      suite.check('E0 quota.release 按 battleId 只放行一次', quota1 === true && quota2 === false,
        `${quota1}/${quota2}`);

      const settle1 = await guardedCommit(ctx, 'settle:coop:room-1', () => {});
      const settle2 = await guardedCommit(ctx, 'settle:coop:room-1', () => {});
      suite.check('E1 结算标记共享 CAS 门只领一次', settle1 === true && settle2 === false,
        `${settle1}/${settle2}`);

      const wild1 = await guardedCommit(ctx, 'wild:area-1:100', () => {});
      const wild2 = await guardedCommit(ctx, 'wild:area-1:100', () => {});
      const wild3 = await guardedCommit(ctx, 'wild:area-1:101', () => {});
      suite.check('E2 wild 广播按 (areaId, bucket) 幂等，换 bucket 正常发',
        wild1 === true && wild2 === false && wild3 === true, `${wild1}/${wild2}/${wild3}`);

      const t1 = await ctx.claim('room:r1:1', 5_000);
      const t2 = await ctx.claim('room:r1:1', 5_000);
      await ctx.releaseClaim('room:r1:1', 'wrong-token');
      const t3 = await ctx.claim('room:r1:1', 5_000);
      await ctx.releaseClaim('room:r1:1', t1);
      const t4 = await ctx.claim('room:r1:1', 5_000);
      const t5 = await ctx.claim('room:r1:2', 5_000);
      suite.check('E3 房间 tick 短期 claim：并发互斥、错误 token 不误删、释放后可再用',
        !!t1 && t2 === null && t3 === null && !!t4 && !!t5,
        `t1=${!!t1} t2=${!!t2} t3=${!!t3} t4=${!!t4} t5=${!!t5}`);

      const keys = await redis.keys(`${pE}idem:*`);
      suite.check('E4 幂等键确实落在 idem: 命名空间且带测试前缀',
        keys.length >= 4, `keys=${keys.length} sample=${keys.slice(0, 2).join(',')}`);
    });

    // ————————————————— F：与生产租约隔离 —————————————————
    const h2 = await healthAt('http://127.0.0.1:3001');
    suite.check('F0 测试未抢走 :3001 的 leader 租约（health.sweep.current 仍 true）',
      h2.data?.sweep?.current === true && h2.data?.sweep?.leader === true,
      `leader=${h2.data?.sweep?.leader} current=${h2.data?.sweep?.current}`);
    suite.check('F1 生产 fence 未被测试分区改动',
      h2.data?.sweep?.fence === sw.fence, `before=${sw.fence} after=${h2.data?.sweep?.fence}`);
  } catch (e) {
    aborted = true;
    console.error('\n[ABORT]', formatFatal(e));
    suite.check('套件未抛异常', false, String(e?.message ?? e));
  } finally {
    try {
      const keys = await redis.keys(`${PFX}*`);
      if (keys.length) await redis.del(...keys);
      console.log(`\n清理 W4 测试 Redis 键：${keys.length} 个`);
    } catch (e) {
      console.error('清理 W4 测试键失败：', e?.message ?? e);
    }
    await redis.quit().catch(() => {});
    const ok = suite.done();
    if (aborted || !ok) process.exitCode = 1;
  }
}

main().catch((e) => {
  console.error(`[FATAL:main] ${formatFatal(e)}`);
  process.exitCode = 1;
});
