/**
 * 剧情看完后的权益发放映射（W4，2026-11-16）。
 *
 * 与 F18-d「已读只记事实、不含权益」不同，这里明确记录「看哪条剧情发什么」：
 *  - 唯一一处：第三关馆主 gym_town_leafy 看完发学习装置 exp_share；
 *  - 决策是纯函数，便于单测钉死；实际写档仍走服务端唯一入口（幂等 + commitState）。
 * 任何新增映射都必须在这里显式列出，禁止在路由里散落 if。
 */

/** 第三关馆主剧情 beat id（绿荫镇·疾风馆主 翠翎）。 */
export const STORY_REWARD_BEAT = 'gym_town_leafy' as const;

/** beatId → 发放的道具 id；未登记的 beat 返回 null。 */
const REWARDS: Record<string, string> = {
  [STORY_REWARD_BEAT]: 'exp_share',
};

export function decideStoryReward(beatId: string): string | null {
  return REWARDS[beatId] ?? null;
}
