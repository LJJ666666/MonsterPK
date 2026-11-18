/**
 * L1/L2 演示包的 API 替身（独立工程 demo-app，主工程零改动）。
 *
 * 只在演示包构建里经 Vite 插件把 `@/lib/api` / `./api` 重定向到这里，
 * 默认构建完全不引用本文件。接口形状与 src/lib/api.ts 一一对应（导出符号齐全），
 * 这样所有业务模块无需改动即可跑起来。
 *
 * 行为契约（见 README「深度路线」）：
 *  - L1：读操作返回 fixtures 真实结构快照；登录返回合法假 JWT；无网络、无 localStorage。
 *  - L2：战斗接入 `battle.engine.ts` 的内存状态机——技能 / PP / 命中 / 伤害 / 异常 /
 *    换人 / 捕获 / 逃跑 / 敌方回合 / 胜负奖励都真实推进；结算把变化写进**内存存档副本**
 *    （仅供本次进程内 getSave 读取），不写 localStorage、不写任何文件、退出即还原。
 *  - 馆主 / Boss / 地图首领三类入口也返回真实 battle view（L1 曾只回 battleId，
 *    主工程 store 会因缺 battle 字段报错），不发放徽章 / 次数 / 掉落真值。
 */
import saveFixture from './fixtures/save.json';
import me from './fixtures/me.json';
import progress from './fixtures/progress.json';
import storySeen from './fixtures/storySeen.json';
import rankTypes from './fixtures/rankTypes.json';
import rankPeriods from './fixtures/rankPeriods.json';
import rankRewards from './fixtures/rankRewards.json';
import bossList from './fixtures/bossList.json';
import gymOverview from './fixtures/gymOverview.json';
import mapBossList from './fixtures/mapBossList.json';
import {
  applyAction, applyTestFlags, battleView, createBattle, specialBattle, rollWildEnemy,
  type DemoAction, type DemoBattle,
} from './battle.engine';
import type { MonsterInstance, SaveData } from '@/game/types';

export const API_BASE = 'mock://local';
export const UNAUTHORIZED_EVENT = 'mpk:unauthorized';
export const BANNED_EVENT = 'mpk:banned';
export const BAN_CODE = 'ACCOUNT_BANNED';
export const SESSION_REPLACED_EVENT = 'mpk:session-replaced';
export const SESSION_REPLACED_CODE = 'SESSION_REPLACED';
export type PutExtra = { revision: number; intentNonce?: string };

// exp=2100 的假 JWT。⚠️ payload 必须纯 ASCII：btoa 只接受 Latin1，含中文会在模块顶层
// 抛 InvalidCharacterError → React 挂不上 → 黑屏（2026-11-17 真机 logcat 实证）。
const FAKE_JWT = (() => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'mock-demo', username: 'demo', exp: 4102444800 })}.mock`;
})();

const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** 内存存档副本：战斗结算只改它，getSave 读它；进程重启回到 fixture。 */
let liveSave: SaveData = clone(saveFixture as unknown as SaveData);
let revision = 1;
let activeBattle: DemoBattle | null = null;
let battleSeq = 0;
const nextId = (prefix: string) => `${prefix}-${Date.now().toString(36)}-${++battleSeq}`;

const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });

/** 战斗结算：把 HP / 经验 / 货币 / 捕获 / 道具消耗写回内存存档副本（绝不落盘）。 */
function healParty() {
  for (const m of liveSave.party) m.hp = m.maxHp;
}

function settleToSave(b: DemoBattle) {
  if (!b.finished) return;
  liveSave.party = b.party.map((m) => ({ ...m }));
  // 对齐主工程 P3-2：全灭惩罚由结算方回满 + 送回恢复点，不能让玩家卡在 0 HP。
  if (b.result === 'player_fainted') healParty();
  const gain = b.rewards?.moneyGain ?? 0;
  liveSave.money = (liveSave.money ?? 0) + gain;
  const inv = liveSave.inventory as unknown as Record<string, number>;
  for (const [itemId, n] of Object.entries(b.consumed)) {
    inv[itemId] = Math.max(0, (inv[itemId] ?? 0) - n);
  }
  if (b.captured) {
    if (liveSave.party.length < 6) liveSave.party.push(b.captured);
    else liveSave.box.push(b.captured);
    const entry = liveSave.collection[b.captured.specId] ?? { seen: true, captured: false, timesCaptured: 0 };
    liveSave.collection[b.captured.specId] = {
      ...entry, seen: true, captured: true, timesCaptured: (entry.timesCaptured ?? 0) + 1,
    };
  }
  liveSave.lastSavedAt = new Date().toISOString();
  revision += 1;
}

function requireBattle(battleId: string): DemoBattle {
  if (!activeBattle || activeBattle.battleId !== battleId) {
    throw Object.assign(new Error('这场演示战斗已经结束，请重新开局。'), { code: 'BATTLE_NOT_FOUND' });
  }
  return activeBattle;
}

export const api = {
  health: async () => ({ ok: true, mock: true, l2: true }),
  playerProgress: async () => progress,
  storySeen: async () => storySeen,
  markStorySeen: async () => ok(),
  me: async () => me,
  register: async () => ({ token: FAKE_JWT }),
  login: async () => ({ token: FAKE_JWT }),
  getSave: async () => ({ data: JSON.stringify(liveSave), revision }),
  putSave: async () => ({ revision: ++revision }),
  dispatchIntent: async (_body?: any) => ok({ nonce: `mock-${++battleSeq}` }),

  // ───────────────────── L2 真实战斗 ─────────────────────
  battleStart: async (body: any) => {
    const party: MonsterInstance[] = clone(liveSave.party);
    const { enemy, label } = rollWildEnemy(
      body?.theme ?? 'grass', body?.levelMin ?? 5, body?.levelMax ?? 8,
    );
    const battle = applyTestFlags(createBattle({
      id: nextId('demo-wild'),
      theme: body?.theme ?? 'grass',
      areaName: body?.areaName ?? '微风林道',
      areaId: body?.areaId ?? null,
      levelMin: body?.levelMin ?? 5,
      levelMax: body?.levelMax ?? 8,
      party, enemy, encounterLabel: label,
    }), body?.testFlags);
    activeBattle = battle;
    return { battle: battleView(battle) };
  },

  battleAction: async (body: any) => {
    const cur = requireBattle(String(body?.battleId ?? ''));
    const action = body?.action as DemoAction;
    if (!action || typeof action.type !== 'string') {
      throw Object.assign(new Error('未知的战斗操作'), { code: 'ACTION_UNKNOWN' });
    }
    const next = applyAction(cur, action, liveSave.inventory as unknown as Record<string, number>);
    activeBattle = next;
    if (next.finished) settleToSave(next);
    return {
      battle: battleView(next),
      settled: next.finished,
      ...(next.finished ? { revision } : {}),
    };
  },

  battleCurrent: async () => ({ battle: activeBattle ? battleView(activeBattle) : null }),
  battleAbandon: async (battleId?: string) => {
    if (!battleId || activeBattle?.battleId === battleId) activeBattle = null;
    return ok();
  },

  wildList: async () => ({ areaId: '', monsters: [], revision: 1 }),
  rankTypes: async () => rankTypes,
  rankBoard: async () => ({ rows: [] }),
  rankPeriods: async () => rankPeriods,
  rankPeriodBoard: async () => ({ rows: [] }),
  rankRewards: async () => rankRewards,
  bossList: async () => bossList,
  bossRank: async () => ({ rows: [] }),
  gymOverview: async () => gymOverview,
  mapBossList: async () => mapBossList,

  /** 三类特殊战斗也开真战斗：只从 fixture 读王牌，不发徽章 / 次数 / 掉落真值。 */
  bossStart: async (body: any) => {
    const found = (bossList as any).bosses?.find((b: any) => b.bossId === body?.bossId);
    if (!found) throw Object.assign(new Error('未知讨伐目标'), { code: 'BOSS_UNKNOWN' });
    const b = specialBattle({
      id: nextId('demo-boss'), party: clone(liveSave.party),
      specId: found.speciesId, level: found.level, theme: found.theme,
      name: found.name, areaName: found.name,
      bossId: found.bossId, bossName: found.name,
    });
    activeBattle = b;
    return { battle: battleView(b) };
  },
  gymStart: async (body: any) => {
    const found = (gymOverview as any).gyms?.find((g: any) => g.locationId === body?.locationId);
    if (!found) throw Object.assign(new Error('未知演武堂'), { code: 'GYM_UNKNOWN' });
    const b = specialBattle({
      id: nextId('demo-gym'), party: clone(liveSave.party),
      specId: found.aceSpeciesId, level: found.aceLevel, theme: 'grass',
      name: `${found.leaderName} 的王牌`, areaName: found.leaderName,
      gymId: found.locationId,
    });
    activeBattle = b;
    return { battle: battleView(b) };
  },
  mapBossStart: async (body: any) => {
    const found = (mapBossList as any).bosses?.find((b: any) => b.mapBossId === body?.mapBossId);
    if (!found) throw Object.assign(new Error('未知地图首领'), { code: 'MAPBOSS_UNKNOWN' });
    const b = specialBattle({
      id: nextId('demo-mapboss'), party: clone(liveSave.party),
      specId: found.speciesId ?? found.aceSpeciesId, level: found.level ?? found.aceLevel,
      theme: found.theme ?? 'grass', name: found.name, areaName: found.name,
      mapBossId: found.mapBossId ?? body?.mapBossId,
    });
    activeBattle = b;
    return { battle: battleView(b) };
  },

  pvpCreate: async () => ok({ roomId: 'mock-room' }),
  pvpJoin: async () => ok(),
  roomAction: async () => ok(),
  coopCreate: async () => ok({ roomId: 'mock-room' }),
  coopJoin: async () => ok(),
  /** L1 遗留的通用写操作：至少让 heal 真回满内存存档、返回对齐主工程的 revision/effect。 */
  gameOp: async (op?: string) => {
    if (op === 'heal') healParty();
    return { ok: true, revision, effect: {}, data: JSON.stringify(liveSave), save: liveSave };
  },
};

/** 默认导出仅为兼容个别 `import api from` 写法（当前源码没有，留着无害）。 */
export default api;
