/**
 * P4 测试工具：带 revision 的整包 PUT（乐观并发 / CAS）。
 *
 * 背景：P4 起 `PUT /api/save` 必须声明「本次写入基于服务端第几版」，
 * 版本不符一律 409 REVISION_CONFLICT。裸的 `{ data }` 请求现在会被
 * 400 REVISION_REQUIRED 拒掉，所以 E2E 里所有写入都要带 revision。
 *
 * 这里维护「每个 token × 槽位」的当前版本：
 *  · 首次用到时向服务端问一次（该槽位无存档 → 0，正好是新建的合法基线）；
 *  · PUT 成功后用响应里的 revision 更新；
 *  · 被拒（400/403/409）时保持不变——服务端没写入，版本自然没变。
 *
 * 需要构造「版本冲突」用例时显式传 `extra.revision`，或先 `set(token, slot, n)`。
 *
 * @param {(path: string, opts?: object) => Promise<{status:number, data:any}>} request
 *        各套件自己的请求函数（签名统一为 request(path, { method, token, body })）
 * @param {string} apiPath 存档接口路径
 */
export function makeSaveWriter(request, apiPath = '/api/save') {
  const revs = new Map();
  const key = (token, slot) => `${token}|${slot}`;

  /** 该 token/槽位的当前版本；没有就向服务端确认一次。 */
  async function revOf(token, slot = 1) {
    if (!token) return 0; // 无鉴权用例：revision 拦不到它，401 先返回
    const k = key(token, slot);
    if (revs.has(k)) return revs.get(k);
    const cur = await request(`${apiPath}?slot=${slot}`, { token });
    const rev = cur?.status === 200 && typeof cur.data?.revision === 'number' ? cur.data.revision : 0;
    revs.set(k, rev);
    return rev;
  }

  /** PUT 成功后同步版本号。 */
  function note(token, slot, res) {
    if (res?.status === 200 && typeof res.data?.revision === 'number') {
      revs.set(key(token, slot), res.data.revision);
    }
  }

  /** 手工设定版本（用于「其它端已经写过」的场景）。 */
  function set(token, slot, revision) {
    revs.set(key(token, slot), revision);
  }

  /**
   * 带 revision 的整包 PUT。
   * @param {string} token
   * @param {object|string} data 存档对象或 JSON 文本
   * @param {object} extra 附加标记（intentNonce / rebase / 显式 revision）
   * @param {number} slot
   */
  async function put(token, data, extra = {}, slot = 1) {
    const revision = typeof extra.revision === 'number' ? extra.revision : await revOf(token, slot);
    const res = await request(`${apiPath}?slot=${slot}`, {
      method: 'PUT',
      token,
      body: {
        data: typeof data === 'string' ? data : JSON.stringify(data),
        revision,
        ...extra,
      },
    });
    note(token, slot, res);
    return res;
  }

  return { put, revOf, note, set };
}
