/**
 * 内容完整度 + 边界 + 只读闸门矩阵 E2E（回归 B / E，2026-11-11）。
 *
 * 背景：既有 E2E 都是「单条主路径」或「单模块边界」，缺一份把全部内容表
 * 与只读接口横着对一遍的矩阵。本套件补齐三块，不重复已有套件：
 *   A. 内容完整度：7 城 / 7 徽章 / 7 馆 / 7 首 / 6 房 / 21 剧情 beat，
 *      静态内容表与服务端只读下发两侧同时钉住，防止加内容时漏一侧。
 *   B. 边界：线性解锁不越级、未知城/未知馆、空队伍/空背包/空图鉴存档。
 *   C. 只读接口伪上报闸门：把 5 个只读接口的「客户端夹带真值字段」逐项对照。
 *      ⚠️ 口径差异（如实记录，不擅自改产品语义）：
 *        - progress / rank:type / boss  → 显式 400 + *_INPUT_FORBIDDEN；
 *        - gym/overview / mapboss       → 纯只读派生，忽略夹带字段、返回值不变。
 *      两类都满足「客户端上报不生效」，只是拒绝方式不同。
 *
 * 不重复：反作弊 / 封号 / 顶号 / WS 伪造 / 并发由 e2e_hardening（115 项）覆盖；
 * mapBoss 越权由 e2e_f18c_security（35 项）覆盖；跨模块累积由 e2e_core_loop 覆盖。
 *
 * 运行：cd backend && npm run e2e:content_matrix（需要 :3001 后端在线）
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  Suite, api, asText, newAccount, cleanupAccounts, requireBackend,
  validSave, save, BACKEND_ROOT,
} from './lib/harness.mjs';

const s = new Suite('E2E_CONTENT_MATRIX');
const names = [];
const ROOT = resolve(BACKEND_ROOT, '..');

/** 读源码做静态完整度校验（内容表是唯一真源，改格式会立刻红，属于预期防回归）。 */
function src(relFromRoot) {
  return readFileSync(resolve(ROOT, relFromRoot), 'utf8');
}
function count(text, re) {
  return (text.match(re) || []).length;
}
const norm = (v) => JSON.stringify(v);

const CITY_ORDER = [
  'town_starter', 'city_pebble', 'town_leafy', 'city_spring',
  'town_sun', 'city_shadow', 'town_winter',
];

async function main() {
  await requireBackend();

  // ═══════════════ A. 内容完整度矩阵（静态 + API 双侧）═══════════════
  const lockText = src('backend/src/game/mapLock.ts');
  const badgeText = src('backend/src/game/badges.ts');
  const gymText = src('backend/src/game/gyms.ts');
  const mapBossText = src('backend/src/game/mapBosses.ts');
  const coopText = src('backend/src/game/coop.ts');
  const storyText = src('src/game/story.ts');

  const orderBlock = lockText.match(/LOCATION_ORDER\s*=\s*\[([\s\S]*?)\]/)?.[1] ?? '';
  const orderIds = [...orderBlock.matchAll(/'([a-z_]+)'/g)].map((m) => m[1]);
  s.check('A1 城镇顺序表恰 7 城且顺序与内容源一致',
    orderIds.length === 7 && norm(orderIds) === norm(CITY_ORDER), norm(orderIds));

  const badgeIds = [...badgeText.matchAll(/\{\s*id:\s*'(badge_[a-z_]+)'/g)].map((m) => m[1]);
  s.check('A2 徽章目录恰 7 枚（一城一徽章）',
    badgeIds.length === 7 && new Set(badgeIds).size === 7, norm(badgeIds));

  const gymLocs = [...gymText.matchAll(/\{\s*locationId:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  s.check('A3 演武堂恰 7 馆且覆盖全部 7 城',
    gymLocs.length === 7 && norm(gymLocs) === norm(CITY_ORDER), norm(gymLocs));

  const bossLocs = [...mapBossText.matchAll(/locationId:\s*'([a-z_]+)'/g)].map((m) => m[1]);
  const mbIds = [...mapBossText.matchAll(/mapBossId:\s*'(mb_[a-z_]+)'/g)].map((m) => m[1]);
  s.check('A4 地图首领恰 7 首且覆盖全部 7 城',
    mbIds.length === 7 && bossLocs.length === 7 && norm(bossLocs) === norm(CITY_ORDER),
    `ids=${norm(mbIds)} locs=${norm(bossLocs)}`);

  const roomCount = Number(coopText.match(/COOP_ROOM_COUNT\s*=\s*(\d+)/)?.[1] ?? -1);
  const perRoom = Number(coopText.match(/COOP_ENEMIES_PER_ROOM\s*=\s*(\d+)/)?.[1] ?? -1);
  s.check('A5 共斗 6 房 / 每房 2 只（F16 内容契约）',
    roomCount === 6 && perRoom === 2, `rooms=${roomCount} enemies=${perRoom}`);

  const beats = count(storyText, /trigger:\s*\{\s*type:/g);
  const arrival = count(storyText, /trigger:\s*\{\s*type:\s*"on_arrival"/g);
  const gymClear = count(storyText, /trigger:\s*\{\s*type:\s*"on_gym_clear"/g);
  const mbClear = count(storyText, /trigger:\s*\{\s*type:\s*"on_mapboss_clear"/g);
  s.check('A6 剧情恰 21 beat（7 到达 + 7 演武堂 + 7 地图首领）',
    beats === 21 && arrival === 7 && gymClear === 7 && mbClear === 7,
    `total=${beats} arrival=${arrival} gym=${gymClear} mapboss=${mbClear}`);
  s.check('A7 F18-d 剧情占位债务已偿（无 placeholder:true）',
    count(storyText, /placeholder:\s*true/g) === 0,
    `placeholders=${count(storyText, /placeholder:\s*true/g)}`);

  // —— 账号 A：正常存档，跑全部只读矩阵 ——
  const a = await newAccount('matrix_');
  names.push(a.username);
  const token = a.token;
  const put = await save.put(token, validSave({ version: '11' }));
  s.check('A0 主账号建档 PUT v11 → 200', put.status === 200 && put.data?.ok === true,
    `${put.status} ${asText(put.data).slice(0, 140)}`);

  const progress = await api('/api/player/progress', { token });
  s.check('A8 GET /api/player/progress → 200 且 readonly=true',
    progress.status === 200 && progress.data?.readonly === true,
    `${progress.status} ${asText(progress.data).slice(0, 140)}`);
  const catalog = progress.data?.catalog ?? [];
  s.check('A9 徽章目录 API 下发恰 7 枚且 0 持有',
    catalog.length === 7 && catalog.every((b) => b.owned === false),
    `catalog=${catalog.length} owned=${catalog.filter((b) => b.owned).length}`);
  const p = progress.data?.progress;
  s.check('A10 初始进度 0 徽章 / 等级 5',
    p?.badgeCount === 0 && p?.level === 5, `badgeCount=${p?.badgeCount} level=${p?.level}`);
  const unlocked = progress.data?.unlockedLocations ?? [];
  s.check('A11 0 徽章时只解锁首城 town_starter',
    unlocked.length === 1 && unlocked[0] === 'town_starter', norm(unlocked));

  const gym = await api('/api/gym/overview', { token });
  s.check('A12 GET /api/gym/overview → 200 readonly=true 且 7 馆',
    gym.status === 200 && gym.data?.readonly === true && gym.data?.gyms?.length === 7,
    `${gym.status} gyms=${gym.data?.gyms?.length}`);
  const gyms = gym.data?.gyms ?? [];
  s.check('A13 每馆字段齐全（馆主 / 王牌种 / 王牌等级 / 徽章 id）',
    gyms.length === 7 && gyms.every((g) => g.locationId && g.leaderName
      && g.aceSpeciesId && Number.isInteger(g.aceLevel) && g.badgeId),
    norm(gyms.map((g) => ({ loc: g.locationId, badge: g.badgeId }))));
  s.check('A14 7 馆初始均未持徽章 / 未冷却',
    gyms.every((g) => g.badgeOwned === false && g.onCooldown === false),
    norm(gyms.map((g) => [g.badgeOwned, g.onCooldown])));
  const aceLevels = gyms.map((g) => g.aceLevel);
  s.check('A15 王牌等级按城镇梯度递增（8 → 30）',
    aceLevels.length === 7 && aceLevels[0] === 8 && aceLevels[6] === 30
      && aceLevels.every((v, i) => i === 0 || v > aceLevels[i - 1]), norm(aceLevels));

  const mb = await api('/api/mapboss', { token });
  s.check('A16 GET /api/mapboss → 200 readonly=true 且 7 首',
    mb.status === 200 && mb.data?.readonly === true && mb.data?.bosses?.length === 7,
    `${mb.status} bosses=${mb.data?.bosses?.length}`);
  const mbBosses = mb.data?.bosses ?? [];
  s.check('A17 地图首领仅首城解锁，其余 6 座锁定',
    mbBosses.length === 7 && mbBosses[0]?.unlocked === true
      && mbBosses.slice(1).every((b) => b.unlocked === false),
    norm(mbBosses.map((b) => [b.mapBossId, b.unlocked])));
  // 上限按城镇梯度分档（3,3,2,2,2,1,1），不是统一 3；期望从内容表读，避免硬编码漂移。
  const staticLimits = [...mapBossText.matchAll(/dailyLimit:\s*(\d+)/g)].map((m) => Number(m[1]));
  const apiLimits = mbBosses.map((b) => b.dailyLimit);
  s.check('A18 每日上限按梯度分档且与内容表一致 / used=0 / remaining=dailyLimit',
    staticLimits.length === 7 && norm(apiLimits) === norm(staticLimits)
      && staticLimits[0] === 3 && staticLimits[6] === 1
      && staticLimits.every((v, i) => i === 0 || v <= staticLimits[i - 1])
      && mbBosses.every((b) => b.used === 0
        && b.remaining === b.dailyLimit - b.used - (b.held ?? 0)),
    `static=${norm(staticLimits)} api=${norm(apiLimits)} rows=${norm(mbBosses.map((b) => [b.dailyLimit, b.used, b.held, b.remaining]))}`);

  const boss = await api('/api/boss', { token });
  s.check('A19 GET /api/boss → 200 readonly=true 且有讨伐目标',
    boss.status === 200 && boss.data?.readonly === true && (boss.data?.bosses?.length ?? 0) >= 1,
    `${boss.status} bosses=${boss.data?.bosses?.length}`);
  const rank = await api('/api/rank', { token });
  s.check('A20 GET /api/rank → 200 readonly=true 且有榜单类型',
    rank.status === 200 && rank.data?.readonly === true && (rank.data?.types?.length ?? 0) >= 1,
    `${rank.status} types=${rank.data?.types?.length}`);

  // ═══════════════ B. 边界（线性解锁 / 空状态）═══════════════
  const travelLocked = await api('/api/game/travel', {
    method: 'POST', token, body: { locationId: 'city_pebble' },
  });
  s.check('B1 0 徽章 travel 第二城 → 400 LOCATION_LOCKED',
    travelLocked.status === 400 && travelLocked.data?.code === 'LOCATION_LOCKED',
    `${travelLocked.status} ${asText(travelLocked.data).slice(0, 140)}`);
  s.check('B2 LOCATION_LOCKED 附 requiredBadge=badge_sprout',
    travelLocked.data?.requiredBadge === 'badge_sprout',
    `requiredBadge=${travelLocked.data?.requiredBadge}`);

  const travelLast = await api('/api/game/travel', {
    method: 'POST', token, body: { locationId: 'town_winter' },
  });
  s.check('B3 线性解锁不越级：直跳末城仍 400 LOCATION_LOCKED',
    travelLast.status === 400 && travelLast.data?.code === 'LOCATION_LOCKED',
    `${travelLast.status} ${asText(travelLast.data).slice(0, 140)}`);
  const travelUnknown = await api('/api/game/travel', {
    method: 'POST', token, body: { locationId: 'nowhere_city' },
  });
  s.check('B4 未知城 travel → 400 LOCATION_UNKNOWN',
    travelUnknown.status === 400 && travelUnknown.data?.code === 'LOCATION_UNKNOWN',
    `${travelUnknown.status} ${asText(travelUnknown.data).slice(0, 140)}`);

  const forged = validSave({ version: '11' });
  forged.locationId = 'city_shadow';
  const putForged = await save.put(token, forged);
  s.check('B5 整包 PUT 伪造 locationId 跳关 → 400 LOCATION_LOCKED',
    putForged.status === 400 && putForged.data?.code === 'LOCATION_LOCKED',
    `${putForged.status} ${asText(putForged.data).slice(0, 140)}`);

  const gymUnknown = await api('/api/gym/start', {
    method: 'POST', token, body: { locationId: 'gym_that_does_not_exist' },
  });
  s.check('B6 未知演武堂 → 400 GYM_UNKNOWN',
    gymUnknown.status === 400 && gymUnknown.data?.code === 'GYM_UNKNOWN',
    `${gymUnknown.status} ${asText(gymUnknown.data).slice(0, 140)}`);
  const gymEmptyBody = await api('/api/gym/start', { method: 'POST', token, body: {} });
  s.check('B7 /api/gym/start 空 body → 400（只认 locationId）',
    gymEmptyBody.status === 400, `${gymEmptyBody.status} ${asText(gymEmptyBody.data).slice(0, 140)}`);

  // 未解锁地图首领：拒绝即可，不钉具体错误码（f18c_security 已逐码覆盖）。
  const mbLocked = await mapBossStart(mbBosses[6]?.mapBossId);
  s.check('B8 未解锁城的地图首领不可开局（服务端拒绝）',
    mbLocked.status !== 200 && !!mbLocked.data?.code,
    `${mbLocked.status} ${asText(mbLocked.data).slice(0, 140)}`);

  // —— 账号 B：空状态存档（空队伍 / 空背包 / 空图鉴 / 空电脑）——
  const b = await newAccount('matrix_');
  names.push(b.username);
  const emptySave = validSave({
    version: '11', party: [], box: [], inventory: {}, collection: {}, clearedAreas: {},
  });
  const emptyPut = await save.put(b.token, emptySave);
  s.check('B9 空状态存档建档 → 200（空队伍/空背包/空图鉴/空电脑均合法）',
    emptyPut.status === 200, `${emptyPut.status} ${asText(emptyPut.data).slice(0, 140)}`);
  const emptyGet = await api('/api/save', { token: b.token });
  s.check('B10 GET /api/save 回读空状态不崩且可读',
    emptyGet.status === 200, `${emptyGet.status} ${asText(emptyGet.data).slice(0, 140)}`);
  const emptyGym = await api('/api/gym/start', {
    method: 'POST', token: b.token, body: { locationId: 'town_starter' },
  });
  s.check('B11 空队伍开演武堂 → 400 PARTY_EMPTY（不崩、不建战斗）',
    emptyGym.status === 400 && emptyGym.data?.code === 'PARTY_EMPTY',
    `${emptyGym.status} ${asText(emptyGym.data).slice(0, 140)}`);

  // ═══════════════ C. 只读接口伪上报闸门（回归 E，对照矩阵）═══════════════
  const f1 = await api('/api/player/progress?level=999', { token });
  s.check('C1 progress?level=999 → 400 PROGRESS_INPUT_FORBIDDEN',
    f1.status === 400 && f1.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `${f1.status} ${asText(f1.data).slice(0, 140)}`);
  const f2 = await api('/api/player/progress?badgeCount=7', { token });
  s.check('C2 progress?badgeCount=7 → 400（伪徽章数）',
    f2.status === 400 && f2.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `${f2.status} ${asText(f2.data).slice(0, 140)}`);
  const f3 = await api('/api/player/progress?userId=someone_else', { token });
  s.check('C3 progress?userId=他人 → 400（伪身份）',
    f3.status === 400 && f3.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `${f3.status} ${asText(f3.data).slice(0, 140)}`);
  const f4 = await api('/api/player/progress?achievements=ach_all', { token });
  s.check('C4 progress?achievements=伪成就 → 400',
    f4.status === 400 && f4.data?.code === 'PROGRESS_INPUT_FORBIDDEN',
    `${f4.status} ${asText(f4.data).slice(0, 140)}`);

  // 榜单类型是 monster_power / team_power / summoner_level / progress，不是 power。
  const rankUnknown = await api('/api/rank/not_a_rank?power=1', { token });
  s.check('C5a 未知榜单类型 → 400 RANK_TYPE_UNKNOWN（先于伪字段闸门）',
    rankUnknown.status === 400 && rankUnknown.data?.code === 'RANK_TYPE_UNKNOWN',
    `${rankUnknown.status} ${asText(rankUnknown.data).slice(0, 140)}`);
  const f5 = await api('/api/rank/monster_power?power=999999', { token });
  s.check('C5 /api/rank/:type?power=999999 → 400 RANK_INPUT_FORBIDDEN',
    f5.status === 400 && f5.data?.code === 'RANK_INPUT_FORBIDDEN',
    `${f5.status} ${asText(f5.data).slice(0, 140)}`);
  const f6 = await api('/api/rank/monster_power?rankScore=999999', { token });
  s.check('C6 /api/rank/:type?rankScore=999999 → 400',
    f6.status === 400 && f6.data?.code === 'RANK_INPUT_FORBIDDEN',
    `${f6.status} ${asText(f6.data).slice(0, 140)}`);

  const f7 = await api('/api/boss?used=99', { token });
  s.check('C7 /api/boss?used=99 → 400 BOSS_INPUT_FORBIDDEN',
    f7.status === 400 && f7.data?.code === 'BOSS_INPUT_FORBIDDEN',
    `${f7.status} ${asText(f7.data).slice(0, 140)}`);
  const f8 = await api('/api/boss?damage=999999', { token });
  s.check('C8 /api/boss?damage=999999 → 400（伪伤害）',
    f8.status === 400 && f8.data?.code === 'BOSS_INPUT_FORBIDDEN',
    `${f8.status} ${asText(f8.data).slice(0, 140)}`);

  // 口径差异：gym / mapboss 是纯只读派生，未知 query 被忽略，但返回值必须与不带参一致。
  const gymPlain = await api('/api/gym/overview', { token });
  const gymForged = await api('/api/gym/overview?badgeCount=7&badgeOwned=true', { token });
  s.check('C9 gym/overview 夹带伪字段被忽略，7 馆与未持有态不变',
    gymForged.status === 200 && norm(gymForged.data?.gyms) === norm(gymPlain.data?.gyms),
    `${gymForged.status} plain=${gymPlain.status}`);
  const mbPlain = await api('/api/mapboss', { token });
  const mbForged = await api('/api/mapboss?used=99&remaining=99', { token });
  s.check('C10 mapboss 夹带伪次数被忽略，bosses 与不带参一致',
    mbForged.status === 200 && norm(mbForged.data?.bosses) === norm(mbPlain.data?.bosses),
    `${mbForged.status} plain=${mbPlain.status}`);
  s.check('C11 对照：不带参 progress / rank / boss 三个只读接口全 200',
    progress.status === 200 && rank.status === 200 && boss.status === 200,
    `progress=${progress.status} rank=${rank.status} boss=${boss.status}`);

  // ═══════════════ D. 只读路由不存在写入口 ═══════════════
  const w1 = await api('/api/gym/overview', { method: 'POST', token, body: {} });
  s.check('D1 POST /api/gym/overview → 404（无写入口）', w1.status === 404, `${w1.status}`);
  const w2 = await api('/api/mapboss', { method: 'POST', token, body: {} });
  s.check('D2 POST /api/mapboss → 404（无写入口）', w2.status === 404, `${w2.status}`);
  const w3 = await api('/api/player/progress', { method: 'POST', token, body: {} });
  s.check('D3 POST /api/player/progress → 404（无写入口）', w3.status === 404, `${w3.status}`);

  /** 用末城首领 id 测未解锁闸门；id 缺失时返回可诊断的假对象而不是崩。 */
  function mapBossStart(id) {
    if (!id) return Promise.resolve({ status: -1, data: { code: 'NO_ID' } });
    return api('/api/mapboss/start', { method: 'POST', token, body: { mapBossId: id } });
  }
}

try {
  await main();
} catch (e) {
  s.check('套件执行未抛异常', false, String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 280));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
