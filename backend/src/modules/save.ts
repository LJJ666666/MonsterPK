import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validateSaveData } from '../lib/saveValidator';
import { decideSaveAction } from '../lib/antiCheat';
import { clampSaveTimestamps } from '../lib/serverClock';
import { banAccount, BAN_CODE } from '../lib/account';
import {
  digestOf, compareDigest, parseAuthority, freshAuthority,
  advanceAuthority, checkFreshSave, checkPartyStateRegression, type AuthorityState,
} from '../lib/authority';
import { checkIntentDelta } from '../lib/settlements';
import { checkWriteRevision, type RevisionFailure } from '../lib/revision';
import { withSlotLock, slotLockKey } from '../lib/slotLock';
import { gameSessions } from './sessionBus';
import { commitState, currentState } from './session';

// PUT 入参：存档 JSON 文本（限 5MB）+ 客户端标识 / 基线版本 / 意图 nonce / 重建基线标记
const putSchema = z.object({
  data: z.string().min(1).max(5_000_000),
  clientId: z.string().min(1).max(64).optional(),
  /**
   * P4 前置：本次写入基于服务端第几版（CAS）。必填，缺省按 REVISION_REQUIRED 拒绝。
   * 这里故意只做 `z.number()`，不在 schema 里校验整数 —— 交给 checkWriteRevision，
   * 这样「缺字段」和「字段不合法」都返回同一个明确业务码，而不是笼统的格式错误。
   */
  revision: z.number().optional(),
  /** P1-2：应用服务端裁决结果后提交，服务端据此核对「增量是否等于裁决值」。 */
  intentNonce: z.string().min(8).max(64).optional(),
  /** 新建/重置存档时由前端标记，服务端校验「新档特征」后重建权威基线。 */
  rebase: z.boolean().optional(),
});

const getQuerySchema = z.object({
  slot: z.coerce.number().int().min(1).max(3).default(1),
});

/**
 * 存档读写（P0-2 结构校验 → P1-1/P1-1b 三层风控 → P1-2 权威摘要 → P2-2 在线权威态）。
 * 路由只负责组装响应与日志，判定逻辑都在 lib 下的纯函数里；
 * 落库统一走 commitState()，保证内存会话态与 DB 同步、并把快照广播给所有在线连接。
 */
export async function saveRoutes(fastify: FastifyInstance) {
  // 读取某个槽位存档：在线期间以内存权威态为准，否则回 DB。
  fastify.get('/api/save', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const parsed = getQuerySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: 'slot 必须是 1/2/3' });
    const slot = parsed.data.slot;

    const live = gameSessions.get(userId, slot);
    if (live) {
      return {
        slot,
        data: live.data,
        updatedAt: new Date(live.updatedAt).toISOString(),
        clientId: live.clientId,
        schemaVersion: live.schemaVersion,
        revision: live.authority.revision,
      };
    }

    const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
    if (!rec) return reply.code(404).send({ error: '该槽位无存档' });
    let revision = 0;
    try { revision = JSON.parse(rec.authority ?? '{}')?.revision ?? 0; } catch { /* 忽略坏数据 */ }
    return {
      slot,
      data: rec.data,
      updatedAt: rec.updatedAt,
      clientId: rec.clientId,
      schemaVersion: rec.schemaVersion,
      revision,
    };
  });

  fastify.put('/api/save', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const query = getQuerySchema.safeParse(req.query);
    if (!query.success) return reply.code(400).send({ error: 'slot 必须是 1/2/3' });
    const slot = query.data.slot;
    // P4：CAS 的「读版本 → 比对 → 写」必须是一个原子段，
    // 否则并发 PUT 会同时通过校验（读档有 await，会让出事件循环）。
    return withSlotLock(slotLockKey(userId, slot), () => handlePut(req, reply, userId, slot));
  });

  async function handlePut(req: any, reply: any, userId: string, slot: number) {
    const parsed = putSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: '存档数据格式不正确或过大' });

    // —— P4 前置：CAS 版本校验，必须放在风控之前 ——
    // 并发写冲突不是作弊，先判版本能省掉一次全量结构校验，
    // 也避免「旧客户端拿着过期存档」被误判成改档而封号。
    const server = await currentState(userId, slot);
    const currentRev = server?.revision ?? 0;
    const revCheck = checkWriteRevision(currentRev, parsed.data.revision);
    if (!revCheck.ok) {
      const bad = revCheck as RevisionFailure;
      if (bad.code === 'REVISION_CONFLICT') {
        req.log.info(
          { userId, slot, kind: 'revision_conflict', current: bad.current, provided: parsed.data.revision },
          '写入版本冲突，已拒绝（由客户端拉回服务端版本后重放，不封号）',
        );
        return reply.code(409).send({
          error: bad.reason,
          code: 'REVISION_CONFLICT',
          revision: bad.current,
          // 冲突时把服务端当前存档一并返回：客户端可直接应用，省一次往返。
          data: server?.data ?? null,
          updatedAt: server ? new Date(server.updatedAt).toISOString() : null,
          schemaVersion: server?.schemaVersion ?? null,
        });
      }
      return reply.code(400).send({ error: bad.reason, code: bad.code });
    }

    // —— 既有三层风控：结构/数值校验 → 风控决策 → 时间钳制 ——
    const validation = validateSaveData(parsed.data.data);
    const isAdmin = req.account?.isAdmin ?? false;
    const action = decideSaveAction(validation, isAdmin);
    if (action.kind === 'reject') {
      req.log.warn({ userId, slot, kind: 'save_rejected', codes: action.codes, issues: validation.hard.slice(0, 10) }, '存档结构不合法，已拒绝写入（不封号）');
      return reply.code(400).send({ error: action.reason, code: action.codes[0], path: validation.hard[0]?.path });
    }
    if (action.kind === 'ban') {
      await banAccount({ userId, reason: action.reason, codes: action.codes, slot, stats: validation.stats });
      req.log.warn({ userId, slot, kind: 'save_banned', codes: action.codes, stats: validation.stats }, '检测到改档，已封号');
      return reply.code(403).send({ error: '你已被封号', code: BAN_CODE, reason: action.reason });
    }
    const clamp = clampSaveTimestamps(parsed.data.data);
    if (clamp.adjusted.length > 0) {
      req.log.info({ userId, slot, kind: 'save_clock_clamped', adjusted: clamp.adjusted }, '客户端时间戳已钳制为服务端时间（改系统时间不生效，不封号）');
    }
    const dataToStore = clamp.data;
    const actual = digestOf(dataToStore);

    const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
    let authority: AuthorityState = parseAuthority(rec?.authority, dataToStore);

    // —— 分支 1：新建 / 重置存档，重建权威基线 ——
    if (parsed.data.rebase === true) {
      const fresh = checkFreshSave(dataToStore);
      if (!fresh.ok) {
        return reply.code(400).send({ error: `重置存档未通过校验：${fresh.reason}`, code: 'REBASE_REJECTED' });
      }
      authority = freshAuthority(dataToStore);
      req.log.info({ userId, slot, kind: 'authority_rebased' }, '新游戏/重置：权威基线已重建');
    } else {
      const pending = authority.pending;
      // —— 分支 2：带 intentNonce 提交裁决结果，精确核对增量 ——
      if (parsed.data.intentNonce && pending && pending.nonce === parsed.data.intentNonce) {
        const violations = checkIntentDelta(pending.baseDigest, actual, pending);
        if (violations.length === 0) {
          let s: any = null;
          try { s = JSON.parse(dataToStore); } catch { /* 前面已校验过 JSON */ }
          if (pending.allow.idle === 'start' && pending.idleStart) {
            if (s?.idle?.areaId !== pending.idleStart.areaId || s?.idle?.level !== pending.idleStart.level) {
              violations.push({ code: 'IDLE_MISMATCH', reason: '挂机派遣区域与服务端裁决不一致', path: 'idle' });
            }
          } else if (pending.allow.idle === 'claim' || pending.allow.idle === 'cancel') {
            if (s?.idle) violations.push({ code: 'IDLE_MISMATCH', reason: '挂机派遣未正确结束', path: 'idle' });
          }
        }
        if (violations.length > 0) {
          req.log.warn({ userId, slot, kind: 'intent_delta_rejected', type: pending.type, violations }, '裁决结果增量不合法，已拒绝');
          return reply.code(400).send({
            error: `结算结果与服务端裁决不一致：${violations[0].reason}`,
            code: 'INTENT_DELTA_MISMATCH',
            path: violations[0].path,
          });
        }
        if (pending.allow.rebase) {
          authority = freshAuthority(dataToStore); // 管理员测试档：服务端授权重建基线
          req.log.warn({ userId, slot, kind: 'admin_override' }, '管理员测试存档已授权放行');
        } else {
          const patch: Parameters<typeof advanceAuthority>[2] = { pending: null };
          if (pending.allow.idle === 'start' && pending.idleStart) {
            patch.idleStartedAtMs = pending.idleStart.startedAtMs;
            patch.idleAreaId = pending.idleStart.areaId;
            patch.idleLevel = pending.idleStart.level;
          } else if (pending.allow.idle === 'claim' || pending.allow.idle === 'cancel') {
            patch.idleStartedAtMs = null;
            patch.idleAreaId = null;
            patch.idleLevel = null;
          }
          authority = advanceAuthority(authority, dataToStore, patch);
        }
        req.log.info({ userId, slot, kind: 'intent_committed', type: pending.type, nonce: pending.nonce }, '裁决结果已落库');
      } else {
        // —— 分支 3：普通整包 PUT，单调比对（客户端资源不得更富）——
        const violations = compareDigest(actual, authority.expected);
        // P3-2：HP 与异常状态不在资源摘要里，单独校验「只能变差」——
        // 否则改存档把血改满、把烧伤清掉都能通过（治疗已全部上移服务端）。
        const stateViolation = checkPartyStateRegression(rec?.data, dataToStore);
        if (stateViolation) violations.push(stateViolation);
        if (violations.length > 0) {
          req.log.warn({ userId, slot, kind: 'authority_mismatch', violations }, '存档资源增量未经服务端裁决，已拒绝（不封号）');
          return reply.code(400).send({
            error: `存档未通过服务端校验：${violations[0].reason}`,
            code: 'AUTHORITY_MISMATCH',
            path: violations[0].path,
          });
        }
        // 放行：把合法消耗同步进权威摘要，防止之后把消耗「撤销」回去。
        // 注意保留 pending —— 裁决结果尚未提交时，普通 PUT 不应清掉授权。
        authority.expected = actual;
      }
    }

    if (action.adminOverride) {
      req.log.warn({ userId, slot, kind: 'admin_override', codes: action.codes, stats: validation.stats }, '管理员测试存档已放行');
    } else if (validation.soft.length > 0) {
      req.log.warn({ userId, slot, kind: 'save_suspicious', codes: validation.soft.map((x) => x.code), stats: validation.stats }, '存档存在兼容类告警，已放行并记录');
    }

    // P2-2：写入收敛到在线权威态（DB + 内存 + 广播），revision 由 commitState 保证单调递增。
    const { saved, revision } = await commitState(userId, slot, {
      data: dataToStore,
      schemaVersion: validation.schemaVersion,
      clientId: parsed.data.clientId ?? null,
      authority,
      source: 'put',
    });
    return {
      ok: true, slot,
      updatedAt: saved.updatedAt,
      clientId: saved.clientId,
      schemaVersion: saved.schemaVersion,
      revision,
    };
  }
}
