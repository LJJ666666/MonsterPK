/**
 * CAS 基线读取的可注入点（W0 / P5-1 批次 A）。
 *
 * W0 把「读基线」收成单一 `readRevision()`；W2 把 `currentState()` 改成只读 DB 列，
 * 于是本模块的默认实现即等于 W2 要求的「CAS 基线只能来自 DB 列」，
 * 内存权威态降级为只读缓存、不参与 CAS。`setRevisionReader(...)` 仅供确定性单测注入。
 *
 * 为什么返回完整基线对象而不是一个 number：409 响应体还要回带服务端当前存档、
 * updatedAt、schemaVersion 供客户端直接应用（`save.ts` / `actions.ts` 现用），
 * 基线对象一次取回可避免为拿这些字段再读一次库。
 */
import { currentState } from '../modules/session';

export type RevisionBaseline = {
  revision: number;
  data: string;
  schemaVersion: string;
  clientId: string | null;
  updatedAt: number;
};

/** 返回 null 表示该账号还没有存档（此时基线版本按 0 处理）。 */
export type RevisionReader = (userId: string) => Promise<RevisionBaseline | null>;

let reader: RevisionReader | null = null;

/** 注入自定义基线来源（W2 用 DB 列）；传 null 恢复默认。 */
export function setRevisionReader(next: RevisionReader | null): void {
  reader = next;
}

export function getRevisionReader(): RevisionReader | null {
  return reader;
}

/** CAS 基线唯一读取口（W2：默认读 Save.revision 列，绝不读内存缓存）。 */
export async function readRevision(userId: string): Promise<RevisionBaseline | null> {
  if (reader) return reader(userId);
  return currentState(userId);
}
