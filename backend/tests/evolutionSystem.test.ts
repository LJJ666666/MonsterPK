/**
 * 进化体系改造单测（W1，2026-11-16）。
 *
 * 锁定杰哥两轮拍板的新规则：
 *  1. 所有 22 条进化条件必须是 `item` 类型 + `minLevel` 门槛（等级 + 道具双条件）；
 *  2. 18 属性之石 + 4 种精华齐全，且都被至少一条进化条件引用（不出现"买了用不了"）；
 *  3. 进化道具不出现在任何普通商店（只靠掉落 / 未来钻石商店）。
 *
 * 红测先行：当前内容表还是 level 触发，本文件应全红；改完 data.ts 并 gen:content 后转绿。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { MONSTER_SPECS, ITEM_SPECS, LOCATIONS } from '../src/game/content.js';
import { MAP_BOSSES } from '../src/game/mapBosses.js';

const STONE_IDS = [
  'stone_fire', 'stone_water', 'stone_leaf', 'stone_thunder', 'stone_rock',
  'stone_steel', 'stone_ghost', 'stone_ice', 'stone_bug', 'stone_normal',
  'stone_ground', 'stone_poison', 'stone_dark', 'stone_psychic', 'stone_fairy',
  'stone_dragon', 'stone_fighting', 'stone_flying',
];
const ESSENCE_IDS = ['essence_flame', 'essence_tide', 'essence_forest', 'essence_dragon'];
const EVO_ITEM_IDS = [...STONE_IDS, ...ESSENCE_IDS];

function allEvolutions() {
  const out: Array<{ from: string; to: string; condition: Record<string, any> }> = [];
  for (const [id, spec] of Object.entries(MONSTER_SPECS)) {
    for (const e of (spec as any).evolutions ?? []) {
      out.push({ from: id, to: e.targetId, condition: e.condition });
    }
  }
  return out;
}

const evolutions = allEvolutions();

test('W1-1 全部进化条件为 item + minLevel 双门槛（共 22 条）', () => {
  assert.equal(evolutions.length, 22, `进化条数应为 22，实际 ${evolutions.length}`);
  const bad = evolutions.filter(
    (e) => e.condition?.type !== 'item' || typeof e.condition?.minLevel !== 'number',
  );
  assert.deepEqual(bad, [], `仍有非"道具+等级"双门槛的进化：${bad.map((e) => `${e.from}->${e.to}=${JSON.stringify(e.condition)}`).join(', ')}`);
});

test('W1-2 18 石 + 4 精华齐全，且都被至少一条进化引用（无买了用不了）', () => {
  for (const id of EVO_ITEM_IDS) {
    assert.ok(ITEM_SPECS[id], `缺少进化道具 ${id}`);
    assert.equal((ITEM_SPECS[id] as any).kind, 'evolution', `${id} 的 kind 应为 evolution`);
  }
  const referenced = new Set(evolutions.map((e) => e.condition?.itemId));
  const unused = EVO_ITEM_IDS.filter((id) => !referenced.has(id));
  assert.deepEqual(unused, [], `以下进化道具没有对应幻兽：${unused.join(', ')}`);
  const unknown = [...referenced].filter((id) => !EVO_ITEM_IDS.includes(String(id)));
  assert.deepEqual(unknown, [], `进化条件引用了未登记道具：${unknown.join(', ')}`);
});

test('W1-3 精华只用于第二次进化（minLevel ≥ 30），之石用于第一次（minLevel ≤ 30）', () => {
  const essenceEvos = evolutions.filter((e) => ESSENCE_IDS.includes(e.condition?.itemId));
  assert.equal(essenceEvos.length, 4, `精华进化应 4 条，实际 ${essenceEvos.length}`);
  for (const e of essenceEvos) {
    assert.ok(e.condition.minLevel >= 30, `${e.from} 用精华但门槛仅 ${e.condition.minLevel}`);
  }
  for (const e of evolutions.filter((x) => STONE_IDS.includes(x.condition?.itemId))) {
    assert.ok(e.condition.minLevel <= 30, `${e.from} 用之石但门槛 ${e.condition.minLevel} 过高`);
  }
});

test('W1-4 普通商店不再售卖进化石 / 精华（只靠掉落）', () => {
  const offenders: string[] = [];
  for (const [locId, loc] of Object.entries(LOCATIONS)) {
    const shop = ((loc as any).shop ?? []) as string[];
    for (const id of shop) if (EVO_ITEM_IDS.includes(id)) offenders.push(`${locId}:${id}`);
  }
  assert.deepEqual(offenders, [], `普通商店仍在卖进化道具：${offenders.join(', ')}`);
});

test('W1-6 22 种进化道具全部可从地图首领掉落（普通商店不卖，必须能产出）', () => {
  const droppable = new Set<string>();
  for (const boss of Object.values(MAP_BOSSES)) {
    for (const id of Object.keys((boss as any).drop?.items ?? {})) droppable.add(id);
  }
  const missing = EVO_ITEM_IDS.filter((id) => !droppable.has(id));
  assert.deepEqual(missing, [], `以下进化道具无掉落来源（买不到也打不到）：${missing.join(', ')}`);
});

test('W1-5 每种属性都有且仅有一个对应之石（element 一致）', () => {
  const ELEMENTS = ['normal', 'fire', 'water', 'grass', 'electric', 'ice', 'fighting', 'poison',
    'ground', 'flying', 'psychic', 'bug', 'rock', 'ghost', 'dragon', 'dark', 'steel', 'fairy'];
  for (const element of ELEMENTS) {
    const stones = STONE_IDS.filter((id) => (ITEM_SPECS[id] as any)?.element === element);
    assert.equal(stones.length, 1, `属性 ${element} 应恰有 1 种之石，实际 ${stones.join(',') || '0'}`);
  }
});
