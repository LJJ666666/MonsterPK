/**
 * 服务端内容表派生（P3-1）。
 *
 * 单一真源仍是前端 `src/game/data.ts`：战斗/捕获/商店的服务端校验需要读技能、幻兽、
 * 道具与遭遇表，但后端 tsconfig 的 rootDir 是 `src`，不能直接跨包 import。
 * 因此这里把真源**生成**为 `backend/src/game/content.json`，由 `check:content` 保证不漂移：
 * 改了 data.ts 却没重新生成，`npm run check:content` 会失败。
 *
 * 用法：
 *   npx tsx scripts/gen-content.ts           写出 content.json
 *   npx tsx scripts/gen-content.ts --check   只比对（CI / 提交前用），不一致退出 1
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  ELEMENT_LABEL, IDLE_CONFIG, INITIAL_INVENTORY, ITEM_SPECS, LOCATIONS, MONSTER_SPECS,
  MOVE_SPECS, START_LOCATION_ID, STARTERS, THEME_TABLE, TYPE_CHART,
} from '../../src/game/data.js';

const here = dirname(fileURLToPath(import.meta.url));
const outPath = join(here, '..', 'src', 'game', 'content.generated.ts');

const payload = {
  generatedFrom: 'src/game/data.ts',
  moves: MOVE_SPECS,
  items: ITEM_SPECS,
  monsters: MONSTER_SPECS,
  themes: THEME_TABLE,
  locations: LOCATIONS,
  elementLabel: ELEMENT_LABEL,
  typeChart: TYPE_CHART,
  starters: STARTERS,
  startLocationId: START_LOCATION_ID,
  initialInventory: INITIAL_INVENTORY,
  idleConfig: IDLE_CONFIG,
};

// 生成 .ts 而不是 .json：tsc 会把 .ts 一起编译进 dist，json 不会（避免 build 后运行时缺文件）。
// 用 `any` 标注避免 294 个技能字面量触发超大类型推断。
const next = `/* eslint-disable */\n/**\n * 自动生成，请勿手改。\n * 来源：src/game/data.ts；重新生成：cd backend && npm run gen:content\n */\nexport const CONTENT: any = ${JSON.stringify(payload)};\n`;
const checkOnly = process.argv.includes('--check');
const prev = existsSync(outPath) ? readFileSync(outPath, 'utf8') : null;

if (checkOnly) {
  if (prev === next) {
    console.log(`[一致] content.generated.ts 与 src/game/data.ts 同步（${next.length} 字节）`);
    process.exit(0);
  }
  const before = prev?.length ?? 0;
  console.error(`[不一致] content.generated.ts 已过期（现有 ${before} 字节 / 应为 ${next.length} 字节）`);
  console.error('        请运行 npm run gen:content 重新生成并一起提交');
  process.exit(1);
}

mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(outPath, next, 'utf8');
const moves = Object.keys(MOVE_SPECS).length;
const monsters = Object.keys(MONSTER_SPECS).length;
const items = Object.keys(ITEM_SPECS).length;
console.log(`[已生成] ${outPath}`);
console.log(`         技能 ${moves} / 幻兽 ${monsters} / 道具 ${items} / 遭遇主题 ${Object.keys(THEME_TABLE).length} / 城镇 ${Object.keys(LOCATIONS).length}`);
console.log(`         共 ${next.length} 字节，来源 src/game/data.ts`);
