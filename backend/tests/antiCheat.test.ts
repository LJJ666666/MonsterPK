/**
 * 存档风控决策单测（P1-1b）。
 * 运行：cd backend && npx tsx --test tests/antiCheat.test.ts
 *
 * 核心验收（杰哥 2026-11-05 拍板）：
 *  - 满属性 / 高等级 / 满金币等测试菜单数值：普通账号 ban，管理员 allow；
 *  - 结构格式问题只 reject 不封号（防误封）；
 *  - 改系统时间（未来时间戳）不产生任何违规，绝不封号。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSaveData, EXPECTED_SAVE_VERSION } from '../src/lib/saveValidator.ts';
import { decideSaveAction, isCheatCode, CHEAT_CODES } from '../src/lib/antiCheat.ts';

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };

function validSave(overrides: Record<string, unknown> = {}) {
  return {
    version: String(EXPECTED_SAVE_VERSION),
    playerName: '旅行者',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [{
      id: 'abc123', specId: 'sprout_owl', level: 5, exp: 12,
      element: 'grass', maxHp: 57, hp: 57,
      atk: 63, def: 54, spAtk: 71, spDef: 61, spd: 76,
      status: 'none', moveIds: ['tackle', 'vine_whip'],
      initStats: STATS, growthRates: GROWTH, isShiny: false,
    }],
    box: [],
    inventory: { capsule_basic: 6 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    lastSavedAt: '2026-11-05T09:59:00.000Z',
    ...overrides,
  };
}

const decide = (save: unknown, isAdmin: boolean) =>
  decideSaveAction(validateSaveData(typeof save === 'string' ? save : JSON.stringify(save)), isAdmin);

// ——————————————— 正常存档 ———————————————
test('合法存档：普通账号放行，无 override', () => {
  const a = decide(validSave(), false);
  assert.equal(a.kind, 'allow');
  if (a.kind === 'allow') assert.equal(a.adminOverride, false);
});

test('合法存档：管理员同样放行', () => {
  assert.equal(decide(validSave(), true).kind, 'allow');
});

// ——————————————— 测试菜单数值：普通账号封号 / 管理员放行 ———————————————
test('满金币（money > 999999）→ 普通账号 ban', () => {
  const a = decide(validSave({ money: 1_200_000 }), false);
  assert.equal(a.kind, 'ban');
  if (a.kind === 'ban') {
    assert.ok(a.codes.includes('MONEY_HIGH'));
    assert.match(a.reason, /异常游戏数据/);
  }
});

test('满金币 → 管理员 allow 且标记 adminOverride', () => {
  const a = decide(validSave({ money: 1_200_000 }), true);
  assert.equal(a.kind, 'allow');
  if (a.kind === 'allow') {
    assert.equal(a.adminOverride, true);
    assert.ok(a.codes.includes('MONEY_HIGH'));
  }
});

test('高等级（level 200）→ 普通账号 ban', () => {
  const save = validSave();
  (save.party[0] as any).level = 200;
  const a = decide(save, false);
  assert.equal(a.kind, 'ban');
  if (a.kind === 'ban') assert.ok(a.codes.includes('MONSTER_LEVEL_HIGH'));
});

test('满属性（六维超上限）→ 普通账号 ban', () => {
  const save = validSave();
  (save.party[0] as any).atk = 999_999;
  const a = decide(save, false);
  assert.equal(a.kind, 'ban');
  if (a.kind === 'ban') assert.ok(a.codes.includes('MONSTER_STAT_RANGE'));
});

test('经验溢出（exp 达阈值却未升级）→ 普通账号 ban', () => {
  const save = validSave();
  (save.party[0] as any).exp = 9999;
  const a = decide(save, false);
  assert.equal(a.kind, 'ban');
  if (a.kind === 'ban') assert.ok(a.codes.includes('MONSTER_EXP_OVERFLOW'));
});

test('负金钱属于格式错误 → 只 reject，不封号（格式错不是改档证据）', () => {
  const a = decide(validSave({ money: -1 }), false);
  assert.equal(a.kind, 'reject');
  if (a.kind === 'reject') assert.ok(a.codes.includes('MONEY_FORMAT'));
});

// ——————————————— 防误封：格式 / 兼容问题只拒绝，不封号 ———————————————
test('非 JSON → reject，不封号', () => {
  const a = decide('not-json', false);
  assert.equal(a.kind, 'reject');
  if (a.kind === 'reject') assert.ok(a.codes.includes('NOT_JSON'));
});

test('版本高于服务端 → reject，不封号（部署错配不是玩家作弊）', () => {
  const a = decide(validSave({ version: String(EXPECTED_SAVE_VERSION + 1) }), false);
  assert.equal(a.kind, 'reject');
  if (a.kind === 'reject') assert.ok(a.codes.includes('VERSION_TOO_NEW'));
});

test('旧版存档 → allow，不封号', () => {
  const a = decide(validSave({ version: '9' }), false);
  assert.equal(a.kind, 'allow');
});

test('旧档缺 initStats → allow，不封号', () => {
  const save = validSave();
  delete (save.party[0] as any).initStats;
  const a = decide(save, false);
  assert.equal(a.kind, 'allow');
});

test('结构问题 + 改档同时出现 → reject 优先，绝不封号', () => {
  const save = validSave({ money: -1 });
  (save as any).party = 'broken';
  const a = decide(save, false);
  assert.equal(a.kind, 'reject');
});

test('管理员也不能把结构损坏的存档写进库', () => {
  assert.equal(decide('{bad json', true).kind, 'reject');
});

// ——————————————— 系统时间：不封号 ———————————————
test('未来时间戳 → allow，且不产生 TIMESTAMP_FUTURE', () => {
  const a = decide(validSave({ lastSavedAt: '2099-01-01T00:00:00.000Z' }), false);
  assert.equal(a.kind, 'allow');
  if (a.kind === 'allow') assert.ok(!a.codes.includes('TIMESTAMP_FUTURE'));
});

test('idle.startedAt 未来 → allow，不封号', () => {
  const a = decide(validSave({ idle: { areaId: 'a', areaName: 'A', level: 10, startedAt: '2099-01-01T00:00:00.000Z' } }), false);
  assert.equal(a.kind, 'allow');
});

// ——————————————— 白名单本身 ———————————————
test('CHEAT_CODES 不含任何格式/兼容类 code', () => {
  for (const code of ['NOT_JSON', 'VERSION_OLD', 'VERSION_TOO_NEW', 'MONSTER_STATS_MISSING', 'TIMESTAMP_MISSING', 'TIMESTAMP_FUTURE', 'PARTY_MISSING']) {
    assert.equal(isCheatCode(code), false, `${code} 不该触发封号`);
  }

  // 格式 / 脏档 / 内部矛盾类：一律不封号。这类值脏档、旧版迁移、客户端 bug 都能产生，
  // 拿它们封号会误封正常玩家（2026-11-07 起 money 负数/小数即属此列）。
  const formatCodes = [
    'MONEY_FORMAT', 'STEPS_FORMAT',
    'MONSTER_LEVEL_FORMAT', 'MONSTER_EXP_FORMAT', 'MONSTER_MAX_HP_FORMAT',
    'MONSTER_HP_FORMAT', 'MONSTER_HP_EXCEED',
    'MONSTER_STAT_FORMAT', 'MONSTER_STATS_VALUE_FORMAT',
    'INVENTORY_VALUE_FORMAT', 'COLLECTION_TIMES_FORMAT',
    'IDLE_LEVEL_FORMAT', 'CLEARED_AREA_LEVEL_FORMAT', 'CLEARED_AREA',
  ];
  for (const code of formatCodes) {
    assert.equal(isCheatCode(code), false, `${code} 是格式/脏档类，不该封号`);
  }

  // 越界 / 容量类：必须封号，缺一个就等于开了后门。
  const cheatCodes = [
    'MONEY_RANGE', 'STEPS_RANGE',
    'MONSTER_LEVEL_RANGE', 'MONSTER_EXP_RANGE', 'MONSTER_MAX_HP_RANGE',
    'MONSTER_STAT_RANGE', 'MONSTER_STATS_VALUE_RANGE',
    'INVENTORY_VALUE_RANGE', 'COLLECTION_TIMES_RANGE',
    'IDLE_LEVEL_RANGE', 'CLEARED_AREA_LEVEL_RANGE',
    'MONSTER_MOVES_MAX', 'MONSTER_LIST_MAX', 'INVENTORY_KEYS', 'COLLECTION_KEYS',
    'MONEY_HIGH', 'MONSTER_LEVEL_HIGH', 'MONSTER_EXP_OVERFLOW', 'COLLECTION_TIMES_HIGH',
  ];
  for (const code of cheatCodes) {
    assert.equal(isCheatCode(code), true, `${code} 必须触发封号`);
  }
  // 白名单不允许出现约定之外的新 code：新增风控码必须同步本用例与文档。
  assert.equal(CHEAT_CODES.size, cheatCodes.length);
});
