/**
 * 剧情 beat id 白名单与上报校验（纯函数，便于单测）。
 *
 * 白名单来自内容生成物 `content.generated.ts` 的 `storyBeatIds`，源头是
 * `src/game/story.ts` 的 `STORY_BEATS`（`npm run gen:content` 生成、`check:content` 防漂移）。
 * 放在 `game/` 而不是内联在路由里，是为了让「未知 id / 过长 id / 空值」三条分支
 * 能被 `tests/storyBeats.test.ts` 直接覆盖，不用起服务。
 */
import { CONTENT } from './content.generated';

/** 内容表白名单；新增剧情 beat 只需重新 `npm run gen:content`。 */
export const KNOWN_BEAT_IDS: ReadonlySet<string> = new Set<string>(
  ((CONTENT as any).storyBeatIds ?? []) as string[],
);

/** beatId 长度上限：故意给得比现有 id 长，只挡明显异常的载荷。 */
export const MAX_BEAT_ID_LENGTH = 64;

export const STORY_BEAT_UNKNOWN_CODE = 'STORY_BEAT_UNKNOWN';
export const STORY_BEAT_INVALID_CODE = 'STORY_BEAT_INVALID';

export type StoryBeatCheck =
  | { ok: true; beatId: string }
  | { ok: false; code: string; error: string };

/**
 * 校验客户端上报的 beatId。
 * - 非字符串 / 空串 / 超长 → `STORY_BEAT_INVALID`
 * - 格式合法但不在内容表 → `STORY_BEAT_UNKNOWN`
 */
export function validateStoryBeatId(raw: unknown): StoryBeatCheck {
  const beatId = typeof raw === 'string' ? raw.trim() : '';
  if (!beatId) {
    return { ok: false, code: STORY_BEAT_INVALID_CODE, error: '缺少 beatId' };
  }
  if (beatId.length > MAX_BEAT_ID_LENGTH) {
    return { ok: false, code: STORY_BEAT_INVALID_CODE, error: '剧情 id 过长' };
  }
  if (!KNOWN_BEAT_IDS.has(beatId)) {
    return { ok: false, code: STORY_BEAT_UNKNOWN_CODE, error: '未知剧情 id' };
  }
  return { ok: true, beatId };
}

/** health 用：纯常量统计，不查库。 */
export function storyStats() {
  return { beats: KNOWN_BEAT_IDS.size, storage: 'pg' as const };
}
