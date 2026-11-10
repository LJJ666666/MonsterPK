/**
 * P4-2a 只读派生榜单测：四榜口径、稳定排序、脏档与伪造字段。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RANK_TYPES, RANK_META, parseRankType, deriveMetrics,
  rankValue, buildBoard, type RankSource,
} from '../src/game/rank.ts';
import { POWER_DISCLAIMER } from '../src/game/power.ts';
import { BASE_PLAYER_LEVEL } from '../src/game/playerLevel.ts';

const mon = (over: Record<string, unknown> = {}) => ({
  id: 'm1', specId: 'sprout_owl', level: 9,
  maxHp: 72, hp: 72, atk: 78, def: 66, spAtk: 88, spDef: 74, spd: 90,
  ...over,
});

const mkSave = (over: Record<string, unknown> = {}) => ({
  version: '10', party: [mon()], box: [], collection: {}, clearedAreas: {},
  ...over,
});

const src = (username: string, save: unknown, userId = username): RankSource => ({
  userId, username, metrics: deriveMetrics(save)!,
});

test('四榜类型固定，parseRankType 拒绝未知/伪造类型', () => {
  assert.equal(RANK_TYPES.length, 4);
  for (const t of RANK_TYPES) assert.equal(parseRankType(t), t);
  assert.equal(parseRankType('power'), null);
  assert.equal(parseRankType(null), null);
  assert.equal(parseRankType(42), null);
  assert.equal(RANK_META.monster_power.disclaimer, POWER_DISCLAIMER);
  assert.equal(RANK_META.team_power.disclaimer, POWER_DISCLAIMER);
});

test('deriveMetrics 派生四榜指标，六维口径与 power.ts 一致', () => {
  const m = deriveMetrics(mkSave())!;
  assert.equal(m.teamPower, 468);
  assert.equal(m.monsterPower, 468);
  assert.equal(m.partySize, 1);
  assert.equal(m.partyLevelSum, 9);
  assert.equal(m.clearedCount, 0);
  assert.equal(m.dexCaptured, 0);
  assert.equal(rankValue('monster_power', m).value, 468);
  assert.equal(rankValue('team_power', m).value, 468);
});

test('hp 变化不影响战力，maxHp 变化才影响', () => {
  const hurt = deriveMetrics(mkSave({ party: [mon({ hp: 1 })] }))!;
  assert.equal(hurt.teamPower, 468);
  const buff = deriveMetrics(mkSave({ party: [mon({ maxHp: 100, hp: 1 })] }))!;
  assert.equal(buff.teamPower, 496);
});

test('客户端伪造 power / playerLevel / rankScore / clearedAreas 上报一律不参与派生', () => {
  const forged = deriveMetrics(mkSave({
    power: 999_999_999, playerLevel: 9999, rankScore: 1e12,
    monsterPower: 1e9, teamPower: 1e9,
  }))!;
  assert.equal(forged.teamPower, 468);
  assert.equal(forged.monsterPower, 468);
  assert.equal(forged.summonerLevel, BASE_PLAYER_LEVEL);
});

test('F04：召唤师等级占位派生已下线，存档字段影响不了榜单', () => {
  const m = deriveMetrics(mkSave({
    party: [mon({ level: 25 }), mon({ level: 15 })],
    clearedAreas: { a: { level: 5 }, b: { level: 12 } },
    collection: { x: { captured: true }, z: { timesCaptured: 2 } },
    playerLevel: 999, badges: ['badge_flame'], achievements: ['ach_veteran'],
  }))!;
  assert.equal(m.clearedCount, 2);
  assert.equal(m.maxClearedLevel, 12);
  assert.equal(m.dexCaptured, 2);
  assert.equal(m.partyLevelSum, 40);
  assert.equal(m.summonerLevel, BASE_PLAYER_LEVEL, '真值由 modules/rank.ts 读 Grant 表覆盖');
});

test('脏档 / 非对象返回 null，不进榜', () => {
  assert.equal(deriveMetrics(null), null);
  assert.equal(deriveMetrics('oops'), null);
  assert.equal(deriveMetrics([]), null);
  assert.equal(deriveMetrics(42), null);
  const messy = deriveMetrics(mkSave({ party: 'oops', box: null, clearedAreas: 5, collection: [] }))!;
  assert.equal(messy.teamPower, 0);
  assert.equal(messy.clearedCount, 0);
  assert.equal(messy.dexCaptured, 0);
});

test('四张榜都按主值降序，且行内不含 userId', () => {
  const low = src('low', mkSave({ party: [mon({ spd: 1 })] }), 'u-low');
  const high = src('high', mkSave({ party: [mon(), mon({ spd: 200 })] }), 'u-high');
  for (const t of RANK_TYPES) {
    const board = buildBoard(t, [low, high]);
    assert.equal(board.length, 2, `${t} 应有两行`);
    assert.equal(board[0].rank, 1);
    assert.equal(board[1].rank, 2);
    assert.ok(board[0].value >= board[1].value, `${t} 未按值降序`);
    assert.equal((board[0] as any).userId, undefined);
  }
  assert.equal(buildBoard('team_power', [low, high])[0].username, 'high');
});

test('推图榜首通数相同时比较最高区域难度（secondary）', () => {
  const shallow = src('shallow', mkSave({
    clearedAreas: { a: { level: 3 }, b: { level: 4 } },
  }));
  const deep = src('deep', mkSave({
    clearedAreas: { a: { level: 20 }, b: { level: 8 } },
  }));
  const board = buildBoard('progress', [shallow, deep]);
  assert.equal(board[0].value, 2);
  assert.equal(board[0].username, 'deep');
  assert.equal(board[0].secondary, 20);
  assert.match(board[0].detail, /Lv\.20/);
});

test('同分按用户名稳定排序，可复现', () => {
  const b = src('bob', mkSave());
  const a = src('amy', mkSave());
  const a2 = src('amy', mkSave(), 'amy');
  const board = buildBoard('team_power', [b, a2, a]);
  assert.deepEqual(board.map((r) => r.username), ['amy', 'amy', 'bob']);
  assert.deepEqual(buildBoard('team_power', [a2, b, a]).map((r) => r.rank), [1, 2, 3]);
});

test('limit 钳制 1~50，isMe 只标记不参与排序', () => {
  const rows = Array.from({ length: 60 }, (_, i) => src(`u${String(i).padStart(2, '0')}`, mkSave()));
  assert.equal(buildBoard('team_power', rows, 0).length, 1);
  assert.equal(buildBoard('team_power', rows, 999).length, 50);
  assert.equal(buildBoard('team_power', rows, 3).length, 3);
  const board = buildBoard('team_power', rows, 60, 'u01');
  assert.equal(board.filter((r) => r.isMe).length, 1);
  assert.equal(board.find((r) => r.isMe)!.username, 'u01');
  assert.equal(board[0].username, 'u00', 'isMe 不得把自己顶到第一');
});
