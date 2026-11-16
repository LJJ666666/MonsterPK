/**
 * 剧情 beat id 白名单与上报校验单测（F18-d，2026-11-16）。
 * 运行：cd backend && npx tsx --test tests/storyBeats.test.ts
 *
 * 核心验收：
 *  - 白名单与内容表一致：21 条 beat（7 城到达 + 7 城演武堂 + 7 座地图首领），
 *    且与 `src/game/story.ts` 的 STORY_BEATS 逐条对齐（防生成物漂移）；
 *  - 合法 id 通过、空白去除；
 *  - 未知 id / 空值 / 非字符串 / 超长 → 拒绝且给出可判定的 code。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  KNOWN_BEAT_IDS,
  MAX_BEAT_ID_LENGTH,
  STORY_BEAT_INVALID_CODE,
  STORY_BEAT_UNKNOWN_CODE,
  storyStats,
  validateStoryBeatId,
} from '../src/game/storyBeats.ts';

const here = dirname(fileURLToPath(import.meta.url));

/** 从前端内容表源码里抓 beat id，作为「生成物是否漂移」的独立证据。 */
function sourceStoryBeatIds(): string[] {
  const src = readFileSync(join(here, '..', '..', 'src', 'game', 'story.ts'), 'utf8');
  return [...src.matchAll(/^\s{4}id:\s*"([a-z0-9_]+)",$/gm)].map((m) => m[1]);
}

test('白名单覆盖全部内容表 beat，无多无少', () => {
  const fromSource = sourceStoryBeatIds();
  assert.equal(fromSource.length, 21, `src/game/story.ts 应有 21 条 beat，实际 ${fromSource.length}`);
  assert.deepEqual([...KNOWN_BEAT_IDS].sort(), fromSource.sort());
  assert.equal(storyStats().beats, 21);
});

test('合法 beatId 通过，首尾空白被去掉', () => {
  const r = validateStoryBeatId('  arrival_town_starter  ');
  assert.equal(r.ok, true);
  assert.equal(r.ok && r.beatId, 'arrival_town_starter');
});

test('未知 beatId 被拒，code 可判定', () => {
  const r = validateStoryBeatId('arrival_atlantis');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, STORY_BEAT_UNKNOWN_CODE);
});

test('空值 / 非字符串 / 仅空白 → INVALID', () => {
  for (const bad of ['', '   ', null, undefined, 42, {}, []]) {
    const r = validateStoryBeatId(bad);
    assert.equal(r.ok, false, `应拒绝 ${JSON.stringify(bad)}`);
    assert.equal(r.ok === false && r.code, STORY_BEAT_INVALID_CODE);
  }
});

test('超长 beatId 被拒且优先判 INVALID（不进白名单查找）', () => {
  const r = validateStoryBeatId('a'.repeat(MAX_BEAT_ID_LENGTH + 1));
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, STORY_BEAT_INVALID_CODE);
});

test('id 大小写敏感：不接受大写变体', () => {
  const r = validateStoryBeatId('Arrival_Town_Starter');
  assert.equal(r.ok, false);
  assert.equal(r.ok === false && r.code, STORY_BEAT_UNKNOWN_CODE);
});
