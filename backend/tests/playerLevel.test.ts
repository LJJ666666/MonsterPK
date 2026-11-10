/**
 * F04-1 纯函数层单测（规范 §31）：徽章 / 成就内容数据、人物等级、等级帽、
 * 冻结升级、捕获不钳等级、只读进度视图。零 IO，不起 HTTP、不碰 DB。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  BADGES, BADGE_BY_ID, BADGE_BY_LOCATION, ACHIEVEMENTS,
  badgeLevelBonusOf, knownBadgeIds, badgeIdForLocation,
  aggregateAchievementBonuses, knownAchievementIds, statBonusText,
} from '../src/game/badges.js';
import {
  BASE_PLAYER_LEVEL, PLAYER_LEVEL_CAP_BONUS, PLAYER_LEVEL_MAX,
  playerLevelOf, levelCapOf, clampLevel, isLevelFrozen, expGrantAllowed,
  capturedLevelOf, buildPlayerProgress, allBadgeViews,
} from '../src/game/playerLevel.js';

const ALL_BADGE_IDS = BADGES.map((b) => b.id);

test('§31.2 默认取值：基础 5 / 帽加成 0 / 上限 1000 / 7 徽章每枚 +5', () => {
  assert.equal(BASE_PLAYER_LEVEL, 5);
  assert.equal(PLAYER_LEVEL_CAP_BONUS, 0);
  assert.equal(PLAYER_LEVEL_MAX, 1000);
  assert.equal(BADGES.length, 7);
  assert.ok(BADGES.every((b) => b.levelBonus === 5));
  assert.equal(badgeLevelBonusOf(ALL_BADGE_IDS), 35);
});

test('§31.3 七徽章对齐七个城镇，locationId 映射可逆', () => {
  const locations = ['town_starter', 'city_pebble', 'town_leafy', 'city_spring', 'town_sun', 'city_shadow', 'town_winter'];
  assert.deepEqual(BADGES.map((b) => b.locationId), locations);
  for (const loc of locations) {
    const id = badgeIdForLocation(loc);
    assert.ok(id, loc);
    assert.equal(BADGE_BY_ID[id!].locationId, loc);
    assert.equal(BADGE_BY_LOCATION[loc].id, id);
  }
  assert.equal(badgeIdForLocation('town_not_exist'), null);
  assert.equal(BADGE_BY_ID['badge_flame'].name, '赤焰徽章');
});

test('无徽章 → 人物 Lv.5 / 帽 5 / 总加成 0；满徽章 → Lv.40 / 帽 40', () => {
  assert.equal(playerLevelOf([]), 5);
  assert.equal(levelCapOf(playerLevelOf([])), 5);
  assert.equal(playerLevelOf(ALL_BADGE_IDS), 40);
  assert.equal(levelCapOf(playerLevelOf(ALL_BADGE_IDS)), 40);
  const one = buildPlayerProgress(['badge_flame'], []);
  assert.equal(one.level, 10);
  assert.equal(one.cap, 10);
  assert.equal(one.badgeBonus, 5);
  assert.equal(one.badgeCount, 1);
  assert.equal(one.badges[0].name, '赤焰徽章');
  assert.equal(one.badges[0].levelBonus, 5);
});

test('未知 / 重复 / 非字符串徽章 id 一律过滤，不虚增等级', () => {
  assert.deepEqual(knownBadgeIds(['badge_flame', 'badge_flame', 'badge_fake', 42, null]), ['badge_flame']);
  assert.equal(playerLevelOf(['badge_flame', 'badge_flame', 'badge_fake']), 10);
  assert.equal(badgeLevelBonusOf(['badge_fake']), 0);
  assert.equal(playerLevelOf(ALL_BADGE_IDS.concat(ALL_BADGE_IDS)), 40);
});

test('等级帽 N+5 只改 capBonus 入参；脏数据与上限钳制', () => {
  assert.equal(levelCapOf(10, 5), 15);
  assert.equal(levelCapOf(10, 0), 10);
  assert.equal(levelCapOf(999, 5), PLAYER_LEVEL_MAX);
  assert.equal(clampLevel('999'), 5, '非数字回落基础等级');
  assert.equal(clampLevel(-3), 1);
  assert.equal(clampLevel(99999), 1000);
});

test('§31.1 超帽不降级、只冻结升级：level >= cap 不再获得经验', () => {
  const cap = 5;
  assert.equal(isLevelFrozen(4, cap), false);
  assert.equal(expGrantAllowed(4, cap), true);
  assert.equal(isLevelFrozen(5, cap), true, '等于帽即冻结');
  assert.equal(expGrantAllowed(5, cap), false);
  assert.equal(isLevelFrozen(50, cap), true, '超帽老宠照样冻结，但不是被降级');
  assert.equal(expGrantAllowed(50, cap), false);
});

test('§31.1 捕获高等级怪不钳等级：人物 5 级抓 Lv.50 → 仍是 50', () => {
  const cap = levelCapOf(playerLevelOf([]));
  assert.equal(cap, 5);
  assert.equal(capturedLevelOf(50, cap), 50);
  assert.equal(capturedLevelOf(50), 50);
  assert.equal(capturedLevelOf(3, cap), 3);
  assert.equal(capturedLevelOf('bad', cap), 5);
  assert.equal(expGrantAllowed(capturedLevelOf(50, cap), cap), false, '入队后获取不到经验');
});

test('§31.4 成就加成聚合同类项合并，element 与 all 分组不串味', () => {
  const merged = aggregateAchievementBonuses(['ach_first_catch', 'ach_veteran', 'ach_flame_runner']);
  const atk = merged.find((b) => b.scope === 'all' && b.stat === 'atk');
  assert.equal(atk?.amount, 6, '1 + 5');
  const fireSpd = merged.find((b) => b.scope === 'element' && b.element === 'fire');
  assert.deepEqual(fireSpd, { scope: 'element', element: 'fire', stat: 'spd', amount: 1 });
  assert.equal(merged.length, 2);
  assert.equal(statBonusText({ scope: 'all', stat: 'atk', amount: 5 }), '全体物攻 +5');
  assert.equal(statBonusText({ scope: 'element', element: 'fire', stat: 'spd', amount: 1 }), '火属性速度 +1');
});

test('成就 id 过滤与空列表', () => {
  assert.deepEqual(knownAchievementIds(['ach_dex_10', 'ach_dex_10', 'ach_fake']), ['ach_dex_10']);
  assert.deepEqual(aggregateAchievementBonuses([]), []);
  assert.deepEqual(aggregateAchievementBonuses(['ach_fake']), []);
  assert.equal(ACHIEVEMENTS.length, 5);
});

test('buildPlayerProgress 只读视图：徽章 / 成就 / 总加成 / 聚合文案齐全', () => {
  const v = buildPlayerProgress(
    ['badge_sprout', 'badge_flame', 'badge_fake'],
    ['ach_veteran', 'ach_flame_runner'],
  );
  assert.equal(v.readonly, true);
  assert.equal(v.level, 15);
  assert.equal(v.cap, 15);
  assert.equal(v.baseLevel, 5);
  assert.equal(v.badgeBonus, 10);
  assert.equal(v.badgeCount, 2);
  assert.deepEqual(v.badges.map((b) => b.name), ['青苗徽章', '赤焰徽章']);
  assert.deepEqual(v.achievements.map((a) => a.name), ['百战之姿', '炎行千里']);
  assert.deepEqual(v.achievements[0].bonusText, ['全体物攻 +5']);
  assert.deepEqual(v.achievements[1].bonusText, ['火属性速度 +1']);
  assert.deepEqual(v.bonuses.map(statBonusText), ['全体物攻 +5', '火属性速度 +1']);
});

test('allBadgeViews 给弹窗提供含未获得态的七行清单', () => {
  const all = allBadgeViews();
  assert.equal(all.length, 7);
  assert.ok(all.every((b) => b.owned === false && b.levelBonus === 5));
  assert.equal(all[4].name, '赤焰徽章');
});
