/**
 * L2 战斗引擎单测（演示包独立套件，不进主工程 verify）。
 * 覆盖：开局视图契约 / 技能真推进 / PP / 捕获 / 换人 / 逃跑 / 胜负 / 特殊战禁捕。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { createInstance } from '@/game/rules';
import {
  applyAction, applyTestFlags, battleView, createBattle, specialBattle,
  type DemoBattle,
} from './battle.engine';

const party = () => [
  createInstance('sprout_owl', 5, false, true, true),
  createInstance('tide_newt', 5, false, true, true),
];

function makeBattle(overrides: Partial<Parameters<typeof createBattle>[0]> = {}): DemoBattle {
  return createBattle({
    id: 't1', theme: 'forest', areaName: '微风林道', areaId: 'forest_1',
    levelMin: 5, levelMax: 8, party: party(),
    enemy: createInstance('rock_golem', 5, false, true, true),
    encounterLabel: '野生 岩岩巨像', ...overrides,
  });
}

const inventory: Record<string, number> = { capsule_master: 5, potion_small: 3, heal_antidote: 2 };

describe('L2 战斗引擎', () => {
  beforeEach(() => { vi.spyOn(Math, 'random').mockReturnValue(0.5); });
  afterEach(() => { vi.restoreAllMocks(); });

  it('开局：视图形状对齐 ServerBattleView，回合/队伍/日志齐备', () => {
    const b = makeBattle();
    const v = battleView(b);
    expect(v.battleId).toBe('t1');
    expect(v.turn).toBe(1);
    expect(v.finished).toBe(false);
    expect(v.result).toBeNull();
    expect(v.areaName).toBe('微风林道');
    expect(v.party).toHaveLength(2);
    expect(v.enemy.hp).toBeGreaterThan(0);
    expect(v.log[0]).toContain('遭遇');
    expect(v.ppByMonster[b.party[0].id]).toBeDefined();
  });

  it('技能：回合+1、动作数+1、PP 扣减、战斗日志增长、敌方掉血', () => {
    const b = makeBattle();
    const moveId = b.party[0].moveIds[0];
    const ppBefore = b.ppByMonster[b.party[0].id][moveId];
    const hpBefore = b.enemy.hp;
    const logBefore = b.log.length;
    const next = applyAction(b, { type: 'move', moveId }, inventory);
    expect(next.turn).toBe(2);
    expect(next.actions).toBe(1);
    expect(next.ppByMonster[b.party[0].id][moveId]).toBe(ppBefore - 1);
    expect(next.log.length).toBeGreaterThan(logBefore);
    expect(next.enemy.hp).toBeLessThanOrEqual(hpBefore);
    expect(next.damageDealt).toBeGreaterThanOrEqual(0);
    // 不改传入状态（服务端权威语义的演示版：视图不可变）
    expect(b.turn).toBe(1);
    expect(b.enemy.hp).toBe(hpBefore);
  });

  it('管理员标记：1 HP 开局，一个技能即击杀并结算经验与金钱', () => {
    let b = applyTestFlags(makeBattle(), { testOHKO: true });
    expect(b.enemy.hp).toBe(1);
    const moveId = b.party[0].moveIds[0];
    b = applyAction(b, { type: 'move', moveId }, inventory);
    expect(b.finished).toBe(true);
    expect(b.result).toBe('enemy_fainted');
    expect(b.rewards?.expGain).toBeGreaterThan(0);
    expect(b.rewards?.moneyGain).toBeGreaterThan(0);
    expect(b.log.some((l) => l.includes('倒下了'))).toBe(true);
    expect(() => applyAction(b, { type: 'move', moveId }, inventory)).toThrow(/结束/);
  });

  it('捕获：大师球成功 → result=captured，敌人满血入队，不再结算经验', () => {
    const b = makeBattle();
    const next = applyAction(b, { type: 'capture', itemId: 'capsule_master' }, inventory);
    expect(next.finished).toBe(true);
    expect(next.result).toBe('captured');
    expect(next.captured).not.toBeNull();
    expect(next.captured?.hp).toBe(next.captured?.maxHp);
    expect(next.rewards).toBeNull();
    expect(next.consumed.capsule_master).toBe(1);
  });

  it('换人：出战索引切换，敌方照常行动', () => {
    const b = makeBattle();
    const next = applyAction(b, { type: 'switch', partyIndex: 1 }, inventory);
    expect(next.playerActiveIndex).toBe(1);
    expect(next.log.some((l) => l.includes('换上'))).toBe(true);
    expect(next.turn).toBe(2);
  });

  it('逃跑：速度占优时成功撤离', () => {
    const b = makeBattle();
    const next = applyAction(b, { type: 'flee' }, inventory);
    expect(next.finished).toBe(true);
    expect(next.result).toBe('fled');
  });

  it('PP 耗尽后拒绝同一技能；错误道具 / 未掌握技能报错', () => {
    let b = makeBattle();
    const moveId = b.party[0].moveIds[0];
    const maxPP = b.ppByMonster[b.party[0].id][moveId];
    for (let i = 0; i < maxPP && !b.finished; i += 1) b = applyAction(b, { type: 'move', moveId }, inventory);
    if (!b.finished) expect(() => applyAction(b, { type: 'move', moveId }, inventory)).toThrow(/PP/);
    const fresh = makeBattle();
    expect(() => applyAction(fresh, { type: 'item', itemId: 'potion_small' as any }, {})).toThrow(/道具不足/);
    expect(() => applyAction(fresh, { type: 'move', moveId: 'hyper_beam' }, inventory)).toThrow(/掌握/);
  });

  it('特殊战：gymId / bossId / mapBossId 落视图，且禁止捕获', () => {
    const gym = specialBattle({
      id: 'g1', party: party(), specId: 'sprout_owl', level: 8,
      theme: 'grass', name: '青岚', areaName: '青岚', gymId: 'town_starter',
    });
    expect(battleView(gym).gymId).toBe('town_starter');
    expect(() => applyAction(gym, { type: 'capture', itemId: 'capsule_master' }, inventory)).toThrow(/无法捕获/);

    const boss = specialBattle({
      id: 'b1', party: party(), specId: 'ember_behemoth', level: 12,
      theme: 'volcano', name: '烈焰巨兽', areaName: '烈焰巨兽', bossId: 'boss_ember_behemoth',
    });
    expect(battleView(boss).bossId).toBe('boss_ember_behemoth');
    const mb = specialBattle({
      id: 'm1', party: party(), specId: 'sprout_owl', level: 8,
      theme: 'forest', name: '萌芽守望者', areaName: '萌芽守望者', mapBossId: 'mb_starter_guardian',
    });
    expect(battleView(mb).mapBossId).toBe('mb_starter_guardian');
  });
});
