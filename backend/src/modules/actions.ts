/**
 * 意图裁决路由（P1-2）：POST /api/actions/:type
 *
 * 流程（服务端权威，客户端只发意图、拿结果）：
 *  ① nonce 一次性消费 —— 失败也消费，杜绝反复重试刷 RNG（尤其捕获骰子）；
 *  ② 基线校验 —— 请求里的「当前存档」先过 P1-1 三层风控 + 权威摘要单调比对，
 *     通过后落库为本次裁决的基线，保证后续增量核对有可信参照；
 *  ③ 服务端裁决 —— 掷骰、服务端时钟、价格表、奖励公式全在 lib/settlements.ts；
 *  ④ 登记一次性授权 pending，客户端应用结果后带 intentNonce 由 PUT 消费。
 *
 * P2-2：④ 的落库改走 commitState()，让在线权威态同步登记 pending 并广播快照。
 */
import { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { validateSaveData } from '../lib/saveValidator';
import { decideSaveAction } from '../lib/antiCheat';
import { clampSaveTimestamps } from '../lib/serverClock';
import { banAccount, BAN_CODE } from '../lib/account';
import { digestOf, compareDigest, parseAuthority } from '../lib/authority';
import { decideIntent, INTENT_TYPES, type IntentType } from '../lib/settlements';
import { commitState } from './session';

const paramsSchema = z.object({ type: z.string().min(1).max(40) });
const bodySchema = z.object({
  slot: z.coerce.number().int().min(1).max(3).default(1),
  /** 一次性意图标识；前端用 rules.ts 的 uuid() 生成，忌用 crypto.randomUUID（旧 WebView 没有）。 */
  nonce: z.string().min(8).max(64),
  /** 发起意图时客户端的完整存档（尚未应用裁决结果）。 */
  save: z.string().min(1).max(5_000_000),
  payload: z.record(z.unknown()).default({}),
});

export async function actionRoutes(fastify: FastifyInstance) {
  fastify.post('/api/actions/:type', { preHandler: fastify.authenticate }, async (req, reply) => {
    const userId = (req.user as any).userId;
    const params = paramsSchema.safeParse(req.params);
    const parsed = bodySchema.safeParse(req.body);
    if (!params.success || !parsed.success) {
      return reply.code(400).send({ error: '意图请求格式不正确' });
    }
    const type = params.data.type as IntentType;
    if (!INTENT_TYPES.includes(type)) {
      return reply.code(400).send({ error: '未知的操作类型' });
    }
    const { slot, nonce, save, payload } = parsed.data;
    const isAdmin = req.account?.isAdmin ?? false;

    // ① 消费 nonce：唯一索引冲突即重放。放在最前面，裁决失败也不退还。
    try {
      await prisma.intentLog.create({ data: { userId, slot, nonce, type } });
    } catch (e: any) {
      if (e?.code === 'P2002') {
        return reply.code(409).send({ error: '重复的操作请求，请刷新后重试', code: 'INTENT_REPLAY' });
      }
      throw e;
    }

    // ② 既有三层风控：坏结构 400 / 明确改档 403 封号 / 管理员放行。
    const validation = validateSaveData(save);
    const decision = decideSaveAction(validation, isAdmin);
    if (decision.kind === 'reject') {
      return reply.code(400).send({ error: decision.reason, code: decision.codes[0], path: validation.hard[0]?.path });
    }
    if (decision.kind === 'ban') {
      await banAccount({ userId, reason: decision.reason, codes: decision.codes, slot, stats: validation.stats });
      return reply.code(403).send({ error: '你已被封号', code: BAN_CODE, reason: decision.reason });
    }
    const clamp = clampSaveTimestamps(save);
    const baseData = clamp.data;
    const baseDigest = digestOf(baseData);

    const rec = await prisma.save.findUnique({ where: { userId_slot: { userId, slot } } });
    const authority = parseAuthority(rec?.authority, baseData);

    const skipBaselineCheck = type === 'admin_test' && isAdmin;
    if (!skipBaselineCheck) {
      const violations = compareDigest(baseDigest, authority.expected);
      if (violations.length > 0) {
        return reply.code(400).send({
          error: `当前进度与服务端不一致：${violations[0].reason}`,
          code: 'AUTHORITY_MISMATCH',
          path: violations[0].path,
        });
      }
    }
    authority.expected = baseDigest;

    // ③ 服务端裁决。所有 RNG / 时钟 / 价格 / 公式都在服务端，客户端只能拿到结果。
    const outcome = decideIntent(type, payload, {
      nowMs: Date.now(),
      rng: Math.random,
      dbSaveRaw: baseData,
      authority,
      isAdmin,
      nonce,
    });
    if (!outcome.ok || !outcome.pending) {
      req.log.warn({ userId, slot, kind: 'intent_rejected', type, nonce, reason: outcome.reason }, '意图被服务端拒绝');
      return reply.code(400).send({ error: outcome.reason ?? '操作无法完成', code: 'INTENT_REJECTED' });
    }

    // ④ 落库基线 + 登记一次性授权；挂机会话以服务端时钟为准。
    const pending = outcome.pending;
    authority.pending = pending;
    if (pending.idleStart) {
      authority.idleStartedAtMs = pending.idleStart.startedAtMs;
      authority.idleAreaId = pending.idleStart.areaId;
      authority.idleLevel = pending.idleStart.level;
    } else if (type === 'idle_claim' || type === 'idle_cancel') {
      authority.idleStartedAtMs = null;
      authority.idleAreaId = null;
      authority.idleLevel = null;
    }
    await commitState(userId, slot, {
      data: baseData,
      schemaVersion: validation.schemaVersion,
      clientId: rec?.clientId ?? null,
      authority,
      source: 'intent',
    });
    req.log.info({ userId, slot, kind: 'intent_decided', type, nonce, result: pending.result }, '服务端裁决完成');
    return { ok: true, nonce, result: pending.result };
  });
}
