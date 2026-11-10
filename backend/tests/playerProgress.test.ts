/**
 * F04-2 服务端进度层单测（只测纯函数与内容映射，零 DB）。
 * Grant 表的幂等 / 伪上报 / 只读投影由 `e2e_f04.mjs` 覆盖。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { LOCATIONS } from '../src/game/content';
import { BADGES, BADGE_BY_ID, badgeIdForWildArea, badgeIdForLocation } from '../src/game/badges';
import { buildPlayerProgress } from '../src/game/playerLevel';

test('§31.9 七个城镇的每个野区都能派生出对应徽章', () => {
  assert.equal(Object.keys(LOCATIONS).length, 7);
  let areaCount = 0;
  for (const [locationId, loc] of Object.entries(LOCATIONS)) {
    const expected = badgeIdForLocation(locationId);
    assert.ok(expected, `城镇 ${locationId} 缺徽章映射`);
    assert.equal(BADGE_BY_ID[expected!].locationId, locationId);
    const areas = (loc as any)?.wildAreas ?? [];
    assert.ok(areas.length > 0, `${locationId} 无野区`);
    for (const a of areas) {
      assert.equal(badgeIdForWildArea(a.id, LOCATIONS), expected, `${a.id} → ${expected}`);
      areaCount += 1;
    }
  }
  assert.equal(areaCount, 14, '7 城镇 × 每城 2 个野区');
  assert.equal(badgeIdForWildArea('wild_starter', LOCATIONS), 'badge_sprout');
  assert.equal(badgeIdForWildArea('wild_winter_cave', LOCATIONS), 'badge_frost');
});

test('未知 / 空 / 脏 areaId 不抛异常，返回 null', () => {
  assert.equal(badgeIdForWildArea('wild_not_exist', LOCATIONS), null);
  assert.equal(badgeIdForWildArea('', LOCATIONS), null);
  assert.equal(badgeIdForWildArea('wild_starter', {}), null);
  assert.equal(badgeIdForWildArea('wild_starter', { town_starter: { wildAreas: [] } }), null);
});

test('无 Grant 记录 → 人物 Lv.5 / 帽 5 / 0 徽章 / 0 成就（老档平滑过渡）', () => {
  const v = buildPlayerProgress([], []);
  assert.equal(v.level, 5);
  assert.equal(v.cap, 5);
  assert.equal(v.badgeBonus, 0);
  assert.equal(v.badgeCount, 0);
  assert.deepEqual(v.badges, []);
  assert.deepEqual(v.achievements, []);
  assert.deepEqual(v.bonuses, []);
  assert.equal(v.readonly, true);
});

test('全部徽章 → Lv.40 / 总加成 35 / 七行清单', () => {
  const v = buildPlayerProgress(BADGES.map((b) => b.id), []);
  assert.equal(v.level, 40);
  assert.equal(v.cap, 40);
  assert.equal(v.badgeBonus, 35);
  assert.equal(v.badgeCount, 7);
  assert.equal(v.badges.length, 7);
  assert.equal(v.badges[4].name, '赤焰徽章');
  assert.equal(v.badges[4].levelBonus, 5);
});
