/**
 * 读档公共入口（F12 之后的小收敛）。
 *
 * 原本 `modules/battle.ts` 与 `modules/game.ts` 各有一份完全相同的 `readSave()`；
 * P4-2c 的 Boss 开局需要第三次，所以抽到独立模块，避免第三份副本。
 * 口径不变：**在线读内存权威态（最新），不在线回库**；两者都没有说明还没建号。
 */
import { prisma } from '../lib/prisma';
import { parseAuthority, type AuthorityState } from '../lib/authority';
import { gameSessions } from './sessionBus';

export type SaveRow = {
  raw: string;
  schemaVersion: string;
  clientId: string | null;
  authority: AuthorityState;
};

export async function readSave(userId: string): Promise<SaveRow | null> {
  const mem = gameSessions.get(userId);
  if (mem) {
    return { raw: mem.data, schemaVersion: mem.schemaVersion, clientId: mem.clientId, authority: mem.authority };
  }
  const rec = await prisma.save.findUnique({ where: { userId } });
  if (!rec) return null;
  return {
    raw: rec.data,
    schemaVersion: rec.schemaVersion,
    clientId: rec.clientId,
    authority: parseAuthority(rec.authority, rec.data),
  };
}
