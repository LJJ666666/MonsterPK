/**
 * 写入版本号校验（P4 前置，乐观并发控制）。
 *
 * 背景：P2-2 用 `authority.revision` 只是**下行**语义——服务端每次写入 +1，
 * 客户端靠它判断快照新旧、忽略过期快照。它是「服务端告诉客户端现在是第几版」，
 * 不是「客户端声明自己是基于第几版改的」。于是多人同时玩会出现：
 *
 *   A、B 两端都基于 rev=5 改了存档 → A 先 PUT（rev→6）→ B 的 PUT 也放行
 *   （P1-2 的单调比对只挡「资源变多」，双方都是合法消耗时都能过）→ B 覆盖 A。
 *
 * P4 要让多个客户端同时在线，就必须有 CAS（compare-and-swap）：
 * 客户端写入时必须带上「我基于哪一版」，与当前版本不一致就整包拒绝，
 * 由客户端拉回服务端版本后重放。这样「后写覆盖前写」变成「后写被拒、先写生效」，
 * 语义从 last-write-wins 收敛为 server-wins，且客户端的本地改动不会被静默吞掉。
 *
 * 本模块只做判定，不碰 DB / Fastify，便于 node:test 单测。
 */

/** 当前写入版本号（无存档时由调用方传 0）。 */
export type RevisionCheck =
  | { ok: true }
  | { ok: false; code: 'REVISION_REQUIRED'; reason: string }
  | { ok: false; code: 'REVISION_CONFLICT'; reason: string; current: number };

/**
 * 失败分支的别名。tsconfig 是 strict:false（判别联合不会自动收窄，见 bug_log §18），
 * 调用点用 `revCheck as RevisionFailure` 显式取失败字段，比 `"code" in x` 更好读。
 */
export type RevisionFailure = Exclude<RevisionCheck, { ok: true }>;

/** 客户端上报的 revision 是否合法（非负整数）。 */
export function isValidRevision(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v) && v >= 0;
}

/**
 * 校验一次写入请求声明的基线版本。
 *
 * @param current 服务端当前版本（内存权威态优先，回落到 DB；完全没有存档时为 0）
 * @param provided 客户端上报的 revision
 *
 * 缺省不当作 0：新建存档时客户端确实基于 0，但那必须是**显式声明**的 0，
 * 否则「老客户端忘传」会和服务端版本恰好为 0 混淆，掩盖真正的并发问题。
 */
export function checkWriteRevision(current: number, provided: unknown): RevisionCheck {
  if (provided === undefined || provided === null) {
    return { ok: false, code: 'REVISION_REQUIRED', reason: '写入请求必须携带 revision' };
  }
  if (!isValidRevision(provided)) {
    return { ok: false, code: 'REVISION_REQUIRED', reason: 'revision 必须是非负整数' };
  }
  if (provided !== current) {
    return {
      ok: false,
      code: 'REVISION_CONFLICT',
      reason: `存档已被其它端更新（当前版本 ${current}，请求基于 ${provided}），已拒绝本次写入`,
      current,
    };
  }
  return { ok: true };
}
