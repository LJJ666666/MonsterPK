/**
 * CAS 基线读取的可注入点（W0 / P5-1 批次 A）。
 *
 * 现状：`save.ts` 与 `actions.ts` 各自 `await currentState(userId)` 拿服务端当前版本，
 * 而 `currentState()` 是「内存权威态优先、回落 DB」。W2 起 CAS 基线**只能来自 DB 列**，
 * 内存态降级为只读缓存；若届时两处调用点都要重写，改动面会扩散到风控与响应体。
 *
 * W0 做法：把「读基线」收成单一 `readRevision()`，默认实现仍是 `currentState()`
 * （零行为变更），W2 只需 `setRevisionReader(...)` 注入从 DB 列读取的实现。
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

/** CAS 基线唯一读取口。W0 默认行为与改动前的 `currentState()` 完全一致。 */
export async function readRevision(userId: string): Promise<RevisionBaseline | null> {
  if (reader) return reader(userId);
  return currentState(userId);
}
