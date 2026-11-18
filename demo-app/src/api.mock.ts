/**
 * L1 演示包的 API 替身。
 *
 * 只在 MPK_MOCK=1 的构建里经 Vite 插件把 `@/lib/api` / `./api` 重定向到这里，
 * 默认构建完全不引用本文件。接口形状与 src/lib/api.ts 一一对应（导出符号齐全），
 * 这样所有业务模块无需改动即可跑起来。
 *
 * 行为契约（L1 = 看界面，不测玩法）：
 *  - 读操作：返回 src/mock/fixtures/*.json 的真实结构快照；
 *  - 登录/注册：返回一个本地伪造但格式合法的 JWT（exp=2100），让 isLoggedIn() 通过；
 *  - 写操作 / 战斗动作：返回「看起来成功」的空结果，不推进任何状态——
 *    战斗界面能进、按钮能点，但回合不会真的变化（这是 L1 的既定边界）。
 *  - 绝不写 localStorage 存档、绝不发任何网络请求。
 */
import save from './fixtures/save.json';
import me from './fixtures/me.json';
import progress from './fixtures/progress.json';
import storySeen from './fixtures/storySeen.json';
import rankTypes from './fixtures/rankTypes.json';
import rankPeriods from './fixtures/rankPeriods.json';
import rankRewards from './fixtures/rankRewards.json';
import bossList from './fixtures/bossList.json';
import gymOverview from './fixtures/gymOverview.json';
import mapBossList from './fixtures/mapBossList.json';

export const API_BASE = 'mock://local';
export const UNAUTHORIZED_EVENT = 'mpk:unauthorized';
export const BANNED_EVENT = 'mpk:banned';
export const BAN_CODE = 'ACCOUNT_BANNED';
export const SESSION_REPLACED_EVENT = 'mpk:session-replaced';
export const SESSION_REPLACED_CODE = 'SESSION_REPLACED';
export type PutExtra = { revision: number; intentNonce?: string };

// exp=2100 年的假 JWT（header.payload.sig），只用于通过 isTokenValid() 的本地粗判。
// ⚠️ 2026-11-17 真机黑屏根因：username 曾用中文「演示账号」，btoa() 只接受 Latin1，
// 含中文直接抛 InvalidCharacterError，模块顶层崩溃 → React 挂不上 → 全黑屏。
// 规则：btoa() 的 payload 必须纯 ASCII；要显示中文请放在渲染层（fixture 的 me.json），
// 不要塞进 JWT payload。
const FAKE_JWT = (() => {
  const b64 = (o: unknown) => btoa(JSON.stringify(o)).replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ sub: 'mock-demo', username: 'demo', exp: 4102444800 })}.mock`;
})();

const SAVE_STRING = JSON.stringify(save);
const ok = (extra: Record<string, unknown> = {}) => ({ ok: true, ...extra });

export const api = {
  health: async () => ({ ok: true, mock: true }),
  playerProgress: async () => progress,
  storySeen: async () => storySeen,
  markStorySeen: async () => ok(),
  me: async () => me,
  register: async () => ({ token: FAKE_JWT }),
  login: async () => ({ token: FAKE_JWT }),
  getSave: async () => ({ data: SAVE_STRING, revision: 1 }),
  putSave: async () => ({ revision: 2 }),
  dispatchIntent: async () => ok({ nonce: 'mock-nonce' }),

  battleStart: async (body: any) => ({
    battle: {
      battleId: 'mock-battle-1', turn: 1, finished: false, result: null,
      areaName: body?.areaName ?? '微风林道', theme: body?.theme ?? 'forest',
      areaId: body?.areaId ?? null, levelMin: body?.levelMin ?? 5, levelMax: body?.levelMax ?? 8,
      playerActiveIndex: 0, playerMods: {}, enemyMods: {},
      enemy: save.party[0], party: save.party,
      ppByMonster: {}, rewards: null, captured: null, consumed: {}, actions: 0,
      bossId: null, bossName: null, damageDealt: 0,
    },
  }),
  battleAction: async () => ({ battle: { battleId: 'mock-battle-1', turn: 2, finished: false, result: null, log: ['（演示包：回合未真实推进）'], party: save.party, enemy: save.party[0], playerActiveIndex: 0, playerMods: {}, enemyMods: {}, ppByMonster: {}, rewards: null, captured: null, consumed: {}, actions: 1 } }),
  battleCurrent: async () => ({ battle: null }),
  battleAbandon: async () => ok(),

  wildList: async () => ({ areaId: '', monsters: [], revision: 1 }),
  rankTypes: async () => rankTypes,
  rankBoard: async () => ({ rows: [] }),
  rankPeriods: async () => rankPeriods,
  rankPeriodBoard: async () => ({ rows: [] }),
  rankRewards: async () => rankRewards,
  bossList: async () => bossList,
  bossStart: async () => ok({ battleId: 'mock-boss-1' }),
  bossRank: async () => ({ rows: [] }),
  gymStart: async () => ok({ battleId: 'mock-gym-1' }),
  gymOverview: async () => gymOverview,
  mapBossList: async () => mapBossList,
  mapBossStart: async () => ok({ battleId: 'mock-mapboss-1' }),
  pvpCreate: async () => ok({ roomId: 'mock-room' }),
  pvpJoin: async () => ok(),
  roomAction: async () => ok(),
  coopCreate: async () => ok({ roomId: 'mock-room' }),
  coopJoin: async () => ok(),
  gameOp: async () => ok({ data: SAVE_STRING, save: save }),
};

/** 默认导出仅为兼容个别 `import api from` 写法（当前源码没有，留着无害）。 */
export default api;
