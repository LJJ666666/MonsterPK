/**
 * 服务端存档数值校验单测（P1-1）。
 * 运行：cd backend && npx tsx --test tests/saveValidator.test.ts
 *
 * 覆盖三类：
 *  A. 结构层回归（P0-2 的既有能力不能被破坏）
 *  B. 典型改档（负数 / 超上限 / 类型伪造 / 版本伪造）→ 必须硬拒绝
 *  C. 合法但极端（测试菜单满属性、旧版存档、旧档缺字段）→ 校验层放行，避免误杀；
 *     是否放行/封号由 antiCheat.test.ts 覆盖（管理员放行、普通账号封号）
 *  D. 未来时间戳不再判违规（改系统时间不封号，由 serverClock.test.ts 覆盖钳制）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { validateSaveData, EXPECTED_SAVE_VERSION } from '../src/lib/saveValidator.ts';

const NOW = Date.parse('2026-11-05T10:00:00.000Z');
const PAST = '2026-11-05T09:59:00.000Z';

const STATS = { hp: 45, atk: 55, def: 46, spAtk: 63, spDef: 53, spd: 68 };
const GROWTH = { hp: 3, atk: 2, def: 2, spAtk: 2, spDef: 2, spd: 2 };

/** 构造一份与前端 exportSaveJson 结构一致的合法存档。 */
function validSave(overrides: Record<string, unknown> = {}) {
  return {
    version: String(EXPECTED_SAVE_VERSION),
    playerName: '旅行者',
    money: 1200,
    steps: 340,
    locationId: 'town_starter',
    lastHealLocationId: 'town_starter',
    visitedLocationIds: ['town_starter'],
    party: [
      {
        id: 'abc123', specId: 'sprout_owl', level: 5, exp: 12,
        element: 'grass', maxHp: 57, hp: 57,
        atk: 63, def: 54, spAtk: 71, spDef: 61, spd: 76,
        status: 'none', moveIds: ['tackle', 'vine_whip'],
        initStats: STATS, growthRates: GROWTH, isShiny: false,
      },
    ],
    box: [],
    inventory: { capsule_basic: 6, potion_small: 3, amulet_coin: 0 },
    collection: { sprout_owl: { seen: true, captured: true, timesCaptured: 1 } },
    lastSavedAt: PAST,
    ...overrides,
  };
}

function validate(save: unknown, now = NOW) {
  return validateSaveData(typeof save === 'string' ? save : JSON.stringify(save), { now });
}
function codes(r: { hard: { code: string }[]; soft: { code: string }[] }, type: 'hard' | 'soft' = 'hard') {
  return r[type].map((x) => x.code);
}

// ——————————————— A. 结构层回归（P0-2 行为保持）———————————————
test('合法新档通过校验，并抽出摘要指标', () => {
  const r = validate(validSave());
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.equal(r.schemaVersion, String(EXPECTED_SAVE_VERSION));
  assert.deepEqual(r.hard, []);
  assert.equal(r.stats.money, 1200);
  assert.equal(r.stats.partySize, 1);
  assert.equal(r.stats.maxLevel, 5);
  assert.equal(r.stats.totalCaptured, 1);
});

test('非 JSON 文本 → NOT_JSON 硬拒绝', () => {
  const r = validate('not a json');
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('NOT_JSON'));
});

test('顶层为数组 → NOT_OBJECT 硬拒绝', () => {
  const r = validate('[]');
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('NOT_OBJECT'));
});

test('缺 version / version 非字符串 → VERSION_MISSING 硬拒绝', () => {
  const a = validate(validSave({ version: undefined }));
  assert.equal(a.ok, false);
  assert.ok(codes(a).includes('VERSION_MISSING'));
  const b = validate(validSave({ version: 10 }));
  assert.equal(b.ok, false);
  assert.ok(codes(b).includes('VERSION_MISSING'));
});

test('缺 party / inventory → 结构硬拒绝', () => {
  const a = validate(validSave({ party: null }));
  assert.equal(a.ok, false);
  assert.ok(codes(a).includes('PARTY_MISSING'));
  const b = validate(validSave({ inventory: [] }));
  assert.equal(b.ok, false);
  assert.ok(codes(b).includes('INVENTORY_MISSING'));
});

// ——————————————— B. 典型改档一律拒绝 ———————————————
test('金钱：负数 / 小数 / 字符串 / 超上限 全部拒绝', () => {
  for (const money of [-1, 1.5, '999999', 10_000_000, null]) {
    const r = validate(validSave({ money }));
    assert.equal(r.ok, false, `money=${String(money)} 应被拒绝`);
    assert.ok(codes(r).includes('MONEY'), `money=${String(money)} 应命中 MONEY`);
  }
});

test('金钱：NaN / Infinity 不能以 JSON 数值形式混入（null / 字符串均被拒）', () => {
  for (const raw of ['{"version":"10","party":[],"inventory":{},"money":1e400}']) {
    const r = validate(raw);
    assert.equal(r.ok, false);
    assert.ok(codes(r).includes('MONEY'));
  }
});

test('版本号伪造：非数字字符串 / 高于服务端版本 全部拒绝', () => {
  const a = validate(validSave({ version: '999' }));
  assert.equal(a.ok, false);
  assert.ok(codes(a).includes('VERSION_TOO_NEW'));
  const b = validate(validSave({ version: 'abc' }));
  assert.equal(b.ok, false);
  assert.ok(codes(b).includes('VERSION_FORMAT'));
  const c = validate(validSave({ version: '0' }));
  assert.equal(c.ok, false);
  assert.ok(codes(c).includes('VERSION_FORMAT'));
});

test('lastSavedAt 填未来时间 → 不再判违规（改系统时间不封号，交给 serverClock 钳制）', () => {
  const r = validate(validSave({ lastSavedAt: '2099-01-01T00:00:00.000Z' }));
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(!codes(r).includes('TIMESTAMP_FUTURE'));
  assert.ok(!codes(r, 'soft').includes('TIMESTAMP_FUTURE'));
});

test('lastSavedAt 允许 5 分钟内的正常时钟偏差', () => {
  const r = validate(validSave({ lastSavedAt: '2026-11-05T10:04:00.000Z' }));
  assert.equal(r.ok, true, JSON.stringify(r.hard));
});

test('幻兽：等级 0 / 负 / 超上限 → MONSTER_LEVEL 拒绝', () => {
  for (const level of [0, -5, 5000, '30']) {
    const save = validSave();
    (save.party[0] as any).level = level;
    const r = validate(save);
    assert.equal(r.ok, false, `level=${String(level)} 应被拒绝`);
    assert.ok(codes(r).includes('MONSTER_LEVEL'));
  }
});

test('幻兽：hp > maxHp → MONSTER_HP_EXCEED 拒绝', () => {
  const save = validSave();
  (save.party[0] as any).hp = 99999;
  const r = validate(save);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('MONSTER_HP_EXCEED'));
});

test('幻兽：maxHp / 六维为负数或非整数 → 拒绝', () => {
  for (const key of ['maxHp', 'atk', 'def', 'spAtk', 'spDef', 'spd']) {
    const save = validSave();
    (save.party[0] as any)[key] = -1;
    const r = validate(save);
    assert.equal(r.ok, false, `${key}=-1 应被拒绝`);
  }
});

test('幻兽：技能数 > 4 → MONSTER_MOVES_MAX 拒绝', () => {
  const save = validSave();
  (save.party[0] as any).moveIds = ['a', 'b', 'c', 'd', 'e'];
  const r = validate(save);
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('MONSTER_MOVES_MAX'));
});

test('幻兽：属性 / 异常状态枚举伪造 → 拒绝', () => {
  const a = validSave();
  (a.party[0] as any).element = 'god';
  assert.ok(codes(validate(a)).includes('MONSTER_ELEMENT'));
  const b = validSave();
  (b.party[0] as any).status = 'invincible';
  assert.ok(codes(validate(b)).includes('MONSTER_STATUS'));
});

test('队伍 > 6 只 → MONSTER_LIST_MAX 拒绝', () => {
  const one = validSave().party[0];
  const r = validate(validSave({ party: Array(7).fill(one) }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('MONSTER_LIST_MAX'));
});

test('背包：负数 / 小数 / 超上限 → INVENTORY_VALUE 拒绝', () => {
  for (const inv of [
    { capsule_basic: -1 },
    { capsule_basic: 1.5 },
    { capsule_basic: '99' },
    { capsule_basic: 2_000_000 },
  ]) {
    const r = validate(validSave({ inventory: inv }));
    assert.equal(r.ok, false, JSON.stringify(inv));
    assert.ok(codes(r).includes('INVENTORY_VALUE'));
  }
});

test('图鉴：捕获次数负数 / 超上限 → COLLECTION_TIMES 拒绝', () => {
  const r = validate(validSave({ collection: { sprout_owl: { seen: true, captured: true, timesCaptured: -3 } } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('COLLECTION_TIMES'));
});

test('挂机：clearedAreas.level 越界 → 拒绝', () => {
  const r = validate(validSave({ clearedAreas: { area_a: { name: 'x', level: 99999, theme: 'grass', clearedAt: PAST } } }));
  assert.equal(r.ok, false);
  assert.ok(codes(r).includes('CLEARED_AREA_LEVEL'));
});

// ——————————————— C. 合法极端值必须放行（不误杀）———————————————
test('测试菜单满属性 + 高等级 + 巨额金钱 → 放行，仅记软告警', () => {
  const save = validSave({ money: 1_500_000 });
  Object.assign(save.party[0], {
    level: 120, exp: 0, maxHp: 4000, hp: 4000,
    atk: 900, def: 900, spAtk: 900, spDef: 900, spd: 900,
    isShiny: true,
  });
  const r = validate(save);
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(codes(r, 'soft').includes('MONEY_HIGH'));
  assert.ok(codes(r, 'soft').includes('MONSTER_LEVEL_HIGH'));
});

test('旧版存档（version=9）→ 放行并记 VERSION_OLD 告警', () => {
  const r = validate(validSave({ version: '9' }));
  assert.equal(r.ok, true);
  assert.ok(codes(r, 'soft').includes('VERSION_OLD'));
});

test('旧档缺 initStats / growthRates → 放行并记告警（兼容迁移前存档）', () => {
  const save = validSave();
  delete (save.party[0] as any).initStats;
  delete (save.party[0] as any).growthRates;
  const r = validate(save);
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(codes(r, 'soft').includes('MONSTER_STATS_MISSING'));
});

test('idle.startedAt 未来时间不拒绝也不告警（由 serverClock 钳制，挂机收益归零、不封号）', () => {
  const r = validate(validSave({ idle: { areaId: 'a', areaName: 'A', level: 10, startedAt: '2099-01-01T00:00:00.000Z' } }));
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(!codes(r, 'soft').includes('TIMESTAMP_FUTURE'));
});

test('exp 达到升级阈值却未升级 → 只记软告警（前端旧档可能存在）', () => {
  const save = validSave();
  (save.party[0] as any).level = 5;
  (save.party[0] as any).exp = 9999;
  const r = validate(save);
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.ok(codes(r, 'soft').includes('MONSTER_EXP_OVERFLOW'));
});

test('空队伍 + 空背包 + 空图鉴（全新档边界）→ 通过', () => {
  const r = validate(validSave({ party: [], box: [], inventory: {}, collection: {}, money: 0, steps: 0 }));
  assert.equal(r.ok, true, JSON.stringify(r.hard));
  assert.equal(r.stats.partySize, 0);
});
