/**
 * F18-a 地图锁 E2E（2026-11-10）。
 *
 * 验证口径（服务端权威解锁，门槛=持有上一相邻城镇徽章，规范 §33）：
 *  - travel 到未解锁城市 → 400 LOCATION_LOCKED；
 *  - travel 到未知城市 → 400 LOCATION_UNKNOWN（不影响原有校验）；
 *  - 整包 PUT 伪造 locationId 跳关 → 400 LOCATION_LOCKED（防作弊，非 admin）；
 *  - 直写 BadgeGrant 模拟「已获初心镇徽章」后，city_pebble 解锁可前往，PUT 也不再被锁。
 *
 * 运行：cd backend && npm run e2e:f18a（需要 :3001 后端在线）
 */
import {
  Suite, api, asText, newAccount, cleanupAccounts, requireBackend,
  validSave, save, loadBackendEnv,
} from './lib/harness.mjs';

const s = new Suite('E2E_F18A');
const names = [];

async function main() {
  await requireBackend();
  const a = await newAccount('f18_');
  names.push(a.username);
  const token = a.token;

  // —— 建档（travel / PUT 都要求已有存档）——
  const first = await save.put(token, validSave({ version: '11' }));
  s.check('建档 PUT v11 → 200', first.status === 200 && first.data?.ok === true,
    `${first.status} ${asText(first.data).slice(0, 120)}`);

  // —— 闸门 1：travel 到未解锁城市 ——
  const travelLocked = await api('/api/game/travel', {
    method: 'POST', token,
    body: { locationId: 'city_pebble' },
  });
  s.check('travel 到未解锁的 city_pebble → 400 LOCATION_LOCKED',
    travelLocked.status === 400 && travelLocked.data?.code === 'LOCATION_LOCKED',
    `${travelLocked.status} ${asText(travelLocked.data).slice(0, 160)}`);
  s.check('LOCATION_LOCKED 附带 requiredBadge=badge_sprout',
    travelLocked.data?.requiredBadge === 'badge_sprout',
    `requiredBadge=${travelLocked.data?.requiredBadge}`);

  // —— 回归：travel 到未知城市仍走原有 LOCATION_UNKNOWN ——
  const travelUnknown = await api('/api/game/travel', {
    method: 'POST', token,
    body: { locationId: 'nowhere' },
  });
  s.check('travel 到未知城市 → 400 LOCATION_UNKNOWN',
    travelUnknown.status === 400 && travelUnknown.data?.code === 'LOCATION_UNKNOWN',
    `${travelUnknown.status} ${asText(travelUnknown.data).slice(0, 160)}`);

  // —— 闸门 2：整包 PUT 伪造 locationId 跳关 ——
  const forged = validSave({ version: '11' });
  forged.locationId = 'city_pebble';
  const putForged = await save.put(token, forged);
  s.check('PUT 整包伪造 locationId=city_pebble → 400 LOCATION_LOCKED',
    putForged.status === 400 && putForged.data?.code === 'LOCATION_LOCKED',
    `${putForged.status} ${asText(putForged.data).slice(0, 160)}`);

  // —— 模拟「已获初心镇徽章」（测试数据直写 BadgeGrant），解锁后应可前往 ——
  loadBackendEnv();
  const { PrismaClient } = await import('@prisma/client');
  const prisma = new PrismaClient();
  let user;
  try {
    user = await prisma.user.findUnique({ where: { username: a.username }, select: { id: true } });
    await prisma.badgeGrant.create({ data: { userId: user.id, badgeId: 'badge_sprout', source: 'test:e2e:f18a' } });
  } finally {
    await prisma.$disconnect();
  }

  const travelOk = await api('/api/game/travel', {
    method: 'POST', token,
    body: { locationId: 'city_pebble' },
  });
  s.check('持有 badge_sprout 后 travel 到 city_pebble → 200',
    travelOk.status === 200,
    `${travelOk.status} ${asText(travelOk.data).slice(0, 160)}`);

  // —— 解锁后 PUT locationId=city_pebble 不再被锁（对照闸门 2）——
  const putOk = await save.put(token, validSave({ version: '11', locationId: 'city_pebble' }));
  s.check('持有徽章后 PUT locationId=city_pebble 不再报 LOCATION_LOCKED',
    putOk.status !== 400 || putOk.data?.code !== 'LOCATION_LOCKED',
    `${putOk.status} ${asText(putOk.data).slice(0, 160)}`);

  // —— 反向：仍不能跳到未持有的 town_leafy（需 badge_stone）——
  const travelFurther = await api('/api/game/travel', {
    method: 'POST', token,
    body: { locationId: 'town_leafy' },
  });
  s.check('仅持 badge_sprout 时 travel 到 town_leafy → 400 LOCATION_LOCKED（线性不越级）',
    travelFurther.status === 400 && travelFurther.data?.code === 'LOCATION_LOCKED',
    `${travelFurther.status} ${asText(travelFurther.data).slice(0, 160)}`);
}

try {
  await main();
} catch (e) {
  s.check('套件执行未抛异常', false, String(e?.stack || e).replace(/\s+/g, ' ').slice(0, 280));
} finally {
  try { await cleanupAccounts(names); } catch (e) { console.log(`[WARN] 清理测试账号失败: ${e}`); }
}

s.done();
