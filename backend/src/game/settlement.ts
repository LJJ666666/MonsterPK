/**
 * 战斗结算 → 存档（F12 抽取，P4-2c 偿还）。
 *
 * 从 `modules/battle.ts` 里搬出来的**纯函数**：输入「当前存档 JSON 文本 + 已结束的服务端战斗态」，
 * 输出「结算后的存档 JSON 文本」。不查库、不广播、不碰 revision，便于：
 *  - 单人 Boss / 后续共斗复用同一套写档规则（不再各抄一份）；
 *  - `node:test` 直接对照「同一场战斗结算两次结果一致」；
 *  - 单测覆盖「全灭回满 / 首通 / 捕获入队 / 道具扣减」而不用起 HTTP。
 *
 * 只信任服务端战斗态，**不读客户端任何数值**。
 */
import type { BattleState } from './battle.js';
import { BattleError } from './battle.js';

function num(v: unknown): number {
  return typeof v === 'number' && Number.isFinite(v) ? Math.max(0, Math.floor(v)) : 0;
}

/**
 * 把战斗结果写回存档：队伍 HP/经验、金钱、道具消耗、捕获入队、图鉴、首通记录。
 *
 * 幂等性说明：函数本身无副作用，但重复调用会**再次累加**金钱与捕获（因为它拿到的
 * 是「战前存档」作为输入）。调用方必须保证一场战斗只结算一次 —— 现有两条链路
 * （`POST /api/battle/action` 的 finished 分支、Boss 结算）都由槽位锁串行 + `battles.drop()` 保证。
 */
export function applySettlementToSave(raw: string, state: BattleState): string {
  let save: any;
  try {
    save = JSON.parse(raw);
  } catch {
    throw new BattleError('SAVE_UNREADABLE', '服务端存档不可用');
  }
  if (!save || typeof save !== 'object' || Array.isArray(save)) {
    throw new BattleError('SAVE_UNREADABLE', '服务端存档结构异常');
  }

  const next: any = { ...save };

  // 队伍：战斗内的 HP / 经验 / 等级 / 技能变化以服务端为准
  next.party = state.party;

  if (state.rewards) next.money = num(next.money) + state.rewards.moneyGain;

  if (Object.keys(state.consumed).length > 0) {
    const inv: Record<string, number> = { ...(next.inventory ?? {}) };
    for (const [itemId, used] of Object.entries(state.consumed)) {
      inv[itemId] = Math.max(0, num(inv[itemId]) - num(used));
    }
    next.inventory = inv;
  }

  // 图鉴：见过；捕获成功再记一次
  const seenId = state.enemy.specId;
  const seenPrev = next.collection?.[seenId] ?? {};
  next.collection = {
    ...(next.collection ?? {}),
    [seenId]: {
      seen: true,
      captured: seenPrev.captured ?? false,
      timesCaptured: num(seenPrev.timesCaptured),
      seenLocations: seenPrev.seenLocations,
    },
  };

  if (state.captured) {
    const party = Array.isArray(next.party) ? next.party.slice() : [];
    const box = Array.isArray(next.box) ? next.box.slice() : [];
    if (party.length < 6) party.push(state.captured);
    else box.push(state.captured);
    next.party = party;
    next.box = box;
    const prev = next.collection[seenId] ?? {};
    next.collection[seenId] = {
      seen: true,
      captured: true,
      timesCaptured: num(prev.timesCaptured) + 1,
      seenLocations: prev.seenLocations,
    };
  }

  // 首通：与前端 markAreaCleared 同规则（更高难度的区域才覆盖）
  if ((state.result === 'enemy_fainted' || state.result === 'captured') && state.areaId) {
    const prev = next.clearedAreas?.[state.areaId];
    if (!prev || prev.level < state.levelMax) {
      next.clearedAreas = {
        ...(next.clearedAreas ?? {}),
        [state.areaId]: {
          name: state.areaName,
          level: state.levelMax,
          theme: state.theme,
          clearedAt: new Date().toISOString(),
        },
      };
    }
  }

  // 全灭：送回最近的恢复点并回满。此前这是客户端 `leaveBattle` 里的本地逻辑——
  // 意味着「不点离开按钮」或「改客户端」就能避免惩罚，而且回满结果由客户端写进存档。
  // P3-2 起由服务端在结算时直接落档，客户端只负责关掉战斗界面。
  if (state.result === 'player_fainted') {
    const heal = typeof next.lastHealLocationId === 'string' && next.lastHealLocationId
      ? next.lastHealLocationId
      : next.locationId;
    next.party = (Array.isArray(next.party) ? next.party : []).map((m: any) => ({
      ...m,
      hp: m.maxHp,
      status: 'none',
    }));
    if (typeof heal === 'string' && heal) next.locationId = heal;
  }

  next.lastSavedAt = new Date().toISOString();
  return JSON.stringify(next);
}
