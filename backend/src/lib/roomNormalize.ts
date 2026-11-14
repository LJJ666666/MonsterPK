/**
 * P5-1 W6.5（#186）：房间态从 Postgres 反序列化后的归一化。
 *
 * 设计定稿 §3.6「序列化三障碍」之三：房间态整房 `JSON.stringify` 落 PG、读回 `JSON.parse`，
 * 会发生两类失真：
 *   1. `Record<number, number>`（如共斗每房 `contributions`）的 key 一律变 string
 *      （JSON 对象键只能是字符串），违反类型 `Record<number, number>`；
 *   2. 顶层 optional 布尔 `pvpSettled` / `coopSettled` 若因旧数据缺失变成 `undefined`，
 *      幂等判定会重新退化（见 roomRegistry.ts 创建处的注释）。
 *
 * 这两个修复不在存储实现里散落，统一收敛到本纯函数，由 `PgRoomStorage.get` / `all`
 * 在读取后调用（InMemory 不走序列化，无需归一化）。纯函数、零 IO，便于单测。
 */
import type { RoomState } from './roomTypes';

/** 把 `Record<number, number>` 的 string key 统一转回 number（已为 number 的不动）。 */
function numericKeys(src: Record<string | number, number> | undefined): Record<number, number> | undefined {
  if (!src || typeof src !== 'object') return src;
  const out: Record<number, number> = {};
  for (const [k, v] of Object.entries(src)) out[Number(k)] = v as number;
  return out;
}

export function normalizeRoom(room: RoomState): RoomState {
  // 1. 共斗每房 contributions：key 转 number。无 coop 的房间（pvp / 普通）跳过。
  if (room.coop && Array.isArray((room.coop as any).rooms)) {
    for (const r of (room.coop as any).rooms) {
      if (r && r.contributions) r.contributions = numericKeys(r.contributions);
    }
  }
  // 2. optional 布尔补显式 false，抗旧数据 / 反序列化缺失。
  if (room.pvpSettled === undefined) room.pvpSettled = false;
  if (room.coopSettled === undefined) room.coopSettled = false;
  return room;
}
