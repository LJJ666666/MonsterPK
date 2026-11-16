/**
 * 剧情发放学习装置单测（W4，2026-11-16）。
 *
 * 锁定杰哥拍板：第三关馆主剧情（gym_town_leafy）**看完对话后**服务端幂等发放 exp_share；
 * 重复看完不重复发；其他 beat 不发；客户端不能靠伪造 beatId 领（白名单校验在 storyBeats）。
 *
 * 这是纯逻辑层测试：抽出发奖决策函数 decideStoryReward(beatId) → itemId|null，
 * 保证「哪个 beat 发什么」是内容 Semantic 的唯一真值。HTTP 幂等由 e2e 覆盖。
 *
 * 红测先行：当前无此函数，应全红（import 失败）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { decideStoryReward, STORY_REWARD_BEAT } from '../src/game/storyRewards.js';

test('W4-1 第三关馆主剧情看完发学习装置', () => {
  assert.equal(decideStoryReward('gym_town_leafy'), 'exp_share');
});

test('W4-2 其他剧情不发任何道具', () => {
  for (const id of ['gym_town_starter', 'gym_city_pebble', 'gym_city_spring',
    'gym_town_sun', 'gym_city_shadow', 'gym_town_winter', 'arrival_town_starter']) {
    assert.equal(decideStoryReward(id), null, `${id} 不应发道具`);
  }
  assert.equal(decideStoryReward('unknown_beat'), null);
});

test('W4-3 发放映射只有一个 beat（防止误配多点发放）', () => {
  assert.equal(STORY_REWARD_BEAT, 'gym_town_leafy');
});
