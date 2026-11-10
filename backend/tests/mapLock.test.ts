import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  LOCATION_ORDER, requiredBadgeFor, unlockedLocations, isLocationUnlocked,
} from '../src/game/mapLock';

test('LOCATION_ORDER 与 7 城线性顺序一致', () => {
  assert.equal(LOCATION_ORDER.length, 7);
  assert.deepEqual([...LOCATION_ORDER], [
    'town_starter', 'city_pebble', 'town_leafy', 'city_spring',
    'town_sun', 'city_shadow', 'town_winter',
  ]);
});

test('requiredBadgeFor：首城无需徽章，其余取上一相邻城徽章', () => {
  assert.equal(requiredBadgeFor('town_starter'), null);
  assert.equal(requiredBadgeFor('city_pebble'), 'badge_sprout');
  assert.equal(requiredBadgeFor('town_leafy'), 'badge_stone');
  assert.equal(requiredBadgeFor('city_spring'), 'badge_leaf');
  assert.equal(requiredBadgeFor('town_sun'), 'badge_spring');
  assert.equal(requiredBadgeFor('city_shadow'), 'badge_flame');
  assert.equal(requiredBadgeFor('town_winter'), 'badge_shadow');
});

test('requiredBadgeFor：未知城返回 null（视为锁定）', () => {
  assert.equal(requiredBadgeFor('nowhere'), null);
});

test('unlockedLocations：空徽章只解锁首城', () => {
  const u = unlockedLocations([]);
  assert.equal(u.has('town_starter'), true);
  assert.equal(u.has('city_pebble'), false);
});

test('unlockedLocations：持有初心镇徽章解锁坚石市（线性不越级）', () => {
  const u = unlockedLocations(['badge_sprout']);
  assert.equal(u.has('town_starter'), true);
  assert.equal(u.has('city_pebble'), true);
  assert.equal(u.has('town_leafy'), false); // 需 badge_stone
});

test('unlockedLocations：中段徽章解锁至当前城及之后所有已满足城', () => {
  // 持有 badge_sprout, badge_stone, badge_leaf → 解锁到 city_spring
  const u = unlockedLocations(['badge_sprout', 'badge_stone', 'badge_leaf']);
  assert.equal(u.has('town_starter'), true);
  assert.equal(u.has('city_pebble'), true);
  assert.equal(u.has('town_leafy'), true);
  assert.equal(u.has('city_spring'), true);
  assert.equal(u.has('town_sun'), false); // 需 badge_spring
  assert.equal(u.has('city_shadow'), false);
  assert.equal(u.has('town_winter'), false);
});

test('isLocationUnlocked 与 unlockedLocations 语义一致', () => {
  assert.equal(isLocationUnlocked('town_starter', []), true);
  assert.equal(isLocationUnlocked('city_pebble', []), false);
  assert.equal(isLocationUnlocked('city_pebble', ['badge_sprout']), true);
  assert.equal(isLocationUnlocked('town_winter', ['badge_sprout']), false);
});
