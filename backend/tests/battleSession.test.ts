/**
 * 活跃战斗注册表单测（P3-1 / W8.1 异步化）。
 *
 * 重点不是战斗规则，而是**归属与生命周期**：
 *  - 别人的 battleId 拿不到状态（越权防护）；
 *  - 一个账号单档同时只有一场战斗（防并发刷奖励）；
 *  - 超时 / 封号能回收，不会永久占内存。
 *
 * W8.1 起存储接口异步（Redis 实现必然异步），用例只补 `await`，
 * 断言语义与改造前完全一致——这份文件同时是 Redis 实现的行为基线。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { BattleRegistry, battleKey, BATTLE_TTL_MS } from '../src/lib/battleSession.js';
import type { BattleState } from '../src/game/battle.js';

function fakeBattle(over: Partial<BattleState> = {}): BattleState {
  return {
    id: 'bt_1',
    userId: 'user_a',
    theme: 'grassland',
    areaName: '测试草原',
    areaId: null,
    levelMin: 1,
    levelMax: 3,
    turn: 1,
    log: [],
    playerActiveIndex: 0,
    playerMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemyMods: { atk: 0, def: 0, spAtk: 0, spDef: 0, spd: 0, accuracy: 0, evasion: 0 },
    enemy: {} as any,
    party: [],
    ppByMonster: {},
    consumed: {},
    finished: false,
    result: null,
    rewards: null,
    captured: null,
    actions: 0,
    startedAt: 1_000,
    updatedAt: 1_000,
    ...over,
  };
}

test('create / current / get：同账号可取回', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle());
  assert.equal(await reg.size(), 1);
  assert.equal((await reg.current('user_a'))?.id, 'bt_1');
  assert.equal((await reg.get('user_a', 'bt_1'))?.id, 'bt_1');
  // 别的账号没有战斗
  assert.equal(await reg.current('user_b'), undefined);
});

test('归属校验：userId / battleId 任一不符都拿不到', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle());
  assert.equal(await reg.get('user_b', 'bt_1'), undefined, '别人的 userId 不能拿到');
  assert.equal(await reg.get('user_a', 'bt_unknown'), undefined, 'battleId 不符不能拿到');
});

test('同账号再开局会覆盖旧战斗（防止并发刷奖励）', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle({ id: 'bt_old' }));
  await reg.create(fakeBattle({ id: 'bt_new' }));
  assert.equal(await reg.size(), 1);
  assert.equal((await reg.current('user_a'))?.id, 'bt_new');
  assert.equal(await reg.get('user_a', 'bt_old'), undefined, '旧战斗应被丢弃');
});

test('不同账号互不影响', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle({ id: 'bt_a1', userId: 'user_a' }));
  await reg.create(fakeBattle({ id: 'bt_b1', userId: 'user_b' }));
  await reg.create(fakeBattle({ id: 'bt_c1', userId: 'user_c' }));
  assert.equal(await reg.size(), 3);
  assert.deepEqual(await reg.stats(), { active: 3, users: 3 });
});

test('update 只更新已登记的战斗，不会凭空插入', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle());
  await reg.update(fakeBattle({ id: 'bt_1', turn: 9 }));
  assert.equal((await reg.current('user_a'))?.turn, 9);
  await reg.update(fakeBattle({ id: 'bt_ghost', turn: 3 }));
  assert.equal(await reg.size(), 1, '未登记的战斗不应插入');
});

test('drop / dropUser：单场丢弃与整账号清理', async () => {
  const reg = new BattleRegistry();
  await reg.create(fakeBattle({ id: 'bt_a1', userId: 'user_a' }));
  await reg.create(fakeBattle({ id: 'bt_b1', userId: 'user_b' }));
  assert.equal(await reg.drop('user_a'), true);
  assert.equal(await reg.drop('user_a'), false);
  assert.equal(await reg.size(), 1);
  assert.equal(await reg.dropUser('user_b'), 1);
  assert.equal(await reg.size(), 0);
  assert.equal(await reg.dropUser('nobody'), 0);
});

test('sweep：超过 TTL 才回收', async () => {
  const reg = new BattleRegistry();
  const now = 10_000_000;
  await reg.create(fakeBattle({ id: 'bt_fresh', updatedAt: now - 1_000 }));
  await reg.create(fakeBattle({ id: 'bt_stale', userId: 'user_b', updatedAt: now - BATTLE_TTL_MS - 1 }));
  assert.equal(await reg.sweep(now), 1);
  assert.equal(await reg.size(), 1);
  assert.equal((await reg.current('user_a'))?.id, 'bt_fresh');
});

test('battleKey 稳定', () => {
  assert.equal(battleKey('u'), 'u');
});
