/**
 * P4-2b：设备身份指纹。
 *
 * 顶号口径要求「只有同一 token 同一设备算重连」。JWT 里带 `sv`（sessionVersion），
 * 换设备登录必然签出一枚不同的 token，因此对 token 原文取 sha256 就是天然的
 * 「同 token 同设备」判据：刷新页面 token 不变 → 指纹相同 → 原位恢复；
 * 换设备/被顶号 → 指纹不同 → 座位保持掉线、不转移。
 *
 * 只存摘要不存明文，避免把可重放的凭证放进房间状态或日志。
 */
import { createHash } from 'node:crypto';

export function tokenDigest(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
