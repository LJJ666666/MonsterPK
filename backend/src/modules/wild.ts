/**
 * 共享野怪接口（P4-1b）。
 *
 * 状态真值在 WildRegistry（内存），写入口只有服务端的 claim / resolve / release；
 * 客户端读列表、发「我要打这一只」的意图，绝不能通过 WS 写野怪状态。
 * 广播用 broadcastAll（跨账号），因为野怪是**所有玩家**看到的同一份实例，
 * 与 session.state（只发给同账号）不同。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { LOCATIONS, THEME_TABLE } from '../game/content';
import { encodeServerMessage } from '../lib/wsProtocol';
import type { WildAreaSpec } from '../lib/wildRegistry';
import { wilds, broadcastAll } from './sessionBus';

const querySchema = z.object({
  areaId: z.string().min(1).max(60),
  theme: z.string().min(1).max(40).default('grass'),
  levelMin: z.coerce.number().int().min(1).max(60).default(1),
  levelMax: z.coerce.number().int().min(1).max(60).default(5),
});

function clampLv(v: number): number {
  return Math.min(Math.max(Math.round(Number.isFinite(v) ? v : 1), 1), 60);
}

/**
 * 未知区域的服务端默认真值。刻意**不采信客户端传来的 theme / levelMin / levelMax**：
 * 共享野怪池是跨账号单例，A 客户端传 levelMax=60 会改掉所有人看到的野怪。
 * 想打别的主题/等级，只能用 LOCATIONS 里真实存在的 wildArea id。
 */
const DEFAULT_WILD_SPEC: WildAreaSpec = { theme: 'grass', levelMin: 1, levelMax: 5 };

/**
 * 区域真值一律以服务端内容表为准：areaId 命中 LOCATIONS.wildAreas 时，
 * 主题与等级区间取自内容表；未命中时用上面的固定默认，忽略客户端 fallback。
 * 与 /api/battle/start 的「areaId 命中即校准」口径一致，但这里更严格。
 */
export function resolveAreaSpec(
  areaId: string,
  _fallback: { theme: string; levelMin: number; levelMax: number },
): WildAreaSpec & { name: string } {
  for (const loc of Object.values(LOCATIONS) as any[]) {
    const area = (loc.wildAreas ?? []).find((a: any) => a.id === areaId);
    if (!area) continue;
    return {
      theme: area.encounters?.[0] ?? DEFAULT_WILD_SPEC.theme,
      levelMin: clampLv(area.levelMin ?? DEFAULT_WILD_SPEC.levelMin),
      levelMax: clampLv(area.levelMax ?? DEFAULT_WILD_SPEC.levelMax),
      name: area.name ?? areaId,
    };
  }
  return { ...DEFAULT_WILD_SPEC, name: areaId };
}

/** 把某个区域的最新野怪列表广播给所有在线客户端。返回送达条数。 */
export function publishWild(areaId: string, spec: WildAreaSpec, now = Date.now()): number {
  const snap = wilds.list(areaId, spec, now);
  return broadcastAll(encodeServerMessage({
    type: 'wild.state',
    areaId,
    revision: snap.revision,
    monsters: snap.monsters,
  }));
}

export async function wildRoutes(fastify: FastifyInstance): Promise<void> {
  /** 读某个区域的共享野怪列表；顺带做一次 ensure（过期换新）。 */
  fastify.get('/api/wild', { preHandler: fastify.authenticate }, async (req, reply) => {
    const parsed = querySchema.safeParse(req.query);
    if (!parsed.success) return reply.code(400).send({ error: '区域参数不合法' });
    const q = parsed.data;
    const spec = resolveAreaSpec(q.areaId, {
      theme: q.theme, levelMin: q.levelMin, levelMax: q.levelMax,
    });
    if (!THEME_TABLE[spec.theme]) {
      return reply.code(400).send({ error: '该区域没有可遭遇的幻兽', code: 'THEME_UNKNOWN' });
    }
    const snap = wilds.list(q.areaId, spec, Date.now());
    return {
      ok: true,
      areaId: q.areaId,
      areaName: spec.name,
      theme: spec.theme,
      levelMin: spec.levelMin,
      levelMax: spec.levelMax,
      revision: snap.revision,
      monsters: snap.monsters,
      stats: wilds.stats(),
    };
  });
}
