#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MonsterPK 文档 / 记忆收尾验收（只读，可反复运行，跨机器）。

运行：python scripts/doc_check.py
ROOT 由脚本位置动态推导，clone 到任意路径都能跑（不要写死 E:\\Six\\MonsterPK）。
"""
from pathlib import Path
import hashlib
import sys

ROOT = Path(__file__).resolve().parent.parent
DOCS = ROOT / ".trae" / "documents"
MEM = ROOT / ".workbuddy" / "memory"


def sha(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def text(p: Path) -> str:
    return p.read_text(encoding="utf-8")


a = MEM / "MEMORY.md"
b = DOCS / "项目记忆.md"
memory_text = text(a)
bug_text = text(DOCS / "bug_log.md")
task_text = text(DOCS / "开发任务优先级_2026-11-04.md")
# 拼接全部每日日志：跨机器 / 跨日期都能验收到最新一段，不写死某一天。
log_text = "\n".join(text(p) for p in sorted(MEM.glob("2026-*.md")))
spec_text = text(DOCS / "后端开发规范_backend.md")
pkg_text = text(ROOT / "backend" / "package.json")
root_pkg_text = text(ROOT / "package.json")
handoff_text = text(ROOT / "HANDOFF.md")
verify_text = text(ROOT / "scripts" / "verify.mjs")
plan_path = DOCS / "P4-2_多人玩法排期_2026-11-07.md"
plan_text = text(plan_path) if plan_path.exists() else ""
future_path = DOCS / "未来规划与技术债_2026-11-07.md"
future_text = text(future_path) if future_path.exists() else ""

checks = [
    ("记忆镜像 sha256 一致", sha(a) == sha(b), sha(a)[:12]),
    ("MEMORY.md 已无旧数字 75/75 / **75**", "75/75" not in memory_text and "**75**" not in memory_text),
    ("MEMORY.md 写入最终数字（306 / 122 / 44 / 19 / 62 / 30 / 41 / 25 / 48 / 50 / 41 / 30 / 39 / 43 / 115 / 24）",
     all(x in memory_text for x in ["**306**", "**122**", "**44**", "**19/19**", "**62**",
                                    "**41**", "**25**", "**48**", "**50**", "**30**",
                                    "**39**", "**43**", "115", "**17/17**", "**13/13**",
                                    "**15/15**", "**25/25**"])),
    ("MEMORY.md 记录降级与旧意图下线",
     "不做离线降级" in memory_text and "下线 `battle_reward`" in memory_text),
    ("MEMORY.md 下一步为 P4-2d", "下一步 P4-2d" in memory_text),
    ("MEMORY.md 记录 P3-2 写操作上移", "POST /api/game/:op" in memory_text and "checkPartyStateRegression" in memory_text),
    ("MEMORY.md 记录 P4-0 写入并发控制",
     "写入并发控制（P4-0）" in memory_text and "REVISION_CONFLICT" in memory_text and "slotLock.ts" in memory_text),
    ("MEMORY.md 记录 P4-1 顶号与共享野怪",
     "SESSION_REPLACED" in memory_text and "WildRegistry" in memory_text and "P4-1 ✅" in memory_text),
    ("MEMORY.md 记录 P4-1 回滚点",
     "rollback-20261107-pre-p41" in memory_text and "rollback-20261107-post-p41" in memory_text),
    ("P4-2 排期契约文档齐全（口径 / 参数 / 五阶段 / 边界）",
     plan_path.exists()
     and all(x in plan_text for x in [
         "全员掉线", "不扣次数", "可选", "ROUND_TIMEOUT_MS", "AUTOPILOT_OFFER_MS",
         "ALL_OFFLINE_GRACE_MS", "hold", "commit", "release", "pickUsableMove",
         "roomId", "P4-2a", "P4-2e", "d~e 仍为排期", "同一 token 同一设备",
         "playerLevel", "SCHEMA_VERSION", "共享存储"])),
    ("任务表已拆 P4-2 五阶段并写明排期状态",
     all(f"| P4-2{c} |" in task_text for c in "abcde")
     and "排期已定" in task_text and "不扣次数" in task_text),
    ("MEMORY.md 记 P4-2a / P4-2b / P4-2c 实现与下一步 P4-2d",
     "P4-2a ✅" in memory_text and "P4-2b ✅" in memory_text and "P4-2c ✅" in memory_text
     and "下一步 P4-2d" in memory_text
     and "P4-2_多人玩法排期_2026-11-07.md" in memory_text
     and "GET /api/rank" in memory_text and "effectiveStats" in memory_text
     and "RoomRegistry" in memory_text and "quota" in memory_text
     and "BossDamageEvent" in memory_text and "applySettlementToSave" in memory_text),
    ("每日日志记 P4-2 排期拍板", "P4-2 多人玩法排期" in log_text and "全员掉线" in log_text),
    ("每日日志记 P4-2a 实现", "P4-2a 只读派生榜" in log_text and "E2E_P42A_OK" in log_text),
    ("P4-2a 战力定义已钉死（六维 / maxHp / 不代表强弱 / 装备扩展）",
     all(x in plan_text for x in [
         "maxHp", "spAtk", "六维总属性", "不代表实战强弱", "effectiveStats",
         "宠物装备", "公式本身待定", "不写回 `MonsterInstance`"])),
    ("任务表记战力口径", "六维总属性" in task_text and "不代表" in task_text and "maxHp" in task_text),
    ("MEMORY.md 记战力口径", "六维" in memory_text and "不代表实战强弱" in memory_text),
    ("每日日志记战力口径补充", "六维总属性" in log_text and "effectiveStats" in log_text),
    ("MEMORY.md 已登记 commit", "`fe159eb`" in memory_text and "`2f2c8b7`" in memory_text),
    ("MEMORY.md 体积已收敛", a.stat().st_size < 15_000, f"{a.stat().st_size} bytes"),
    ("bug_log 含 §17 ~ §28", all(f"## {n}." in bug_text for n in range(17, 29))),
    ("规范含 §22 顶号与共享野怪", "## 22." in spec_text and "22.7" in spec_text),
    ("规范含 §23 P4-2a 只读派生榜",
     "## 23." in spec_text and "23.3 接口与只读闸门" in spec_text
     and "RANK_INPUT_FORBIDDEN" in spec_text and "TTL=0" in spec_text),
    ("排期文档记 P4-2a 实现记录与实时派生决策",
     "✅ 已实现" in plan_text and "E2E_P42A_OK" in plan_text
     and "UI_SMOKE_P42A_OK" in plan_text and "TTL=0" in plan_text),
    ("verify 已注册 e2e:p41 / smoke:p41",
     "e2e:p41" in verify_text and "smoke:p41" in verify_text and '"e2e:p41"' in pkg_text),
    ("verify 已注册 e2e:p42a / smoke:p42a",
     "e2e:p42a" in verify_text and "smoke:p42a" in verify_text
     and '"e2e:p42a"' in pkg_text and "ui_smoke_p42a.mjs" in verify_text),
    ("P4-2a 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/power.ts",
         "backend/src/game/rank.ts",
         "backend/src/modules/rank.ts",
         "backend/tests/power.test.ts",
         "backend/tests/rank.test.ts",
         "backend/tests/e2e_p42a_rank.mjs",
         "scripts/ui_smoke_p42a.mjs",
         "src/lib/rank.ts",
         "src/lib/rank.test.ts",
         "src/components/RankBoardModal.tsx",
     ])),
    ("任务表记 P4-2a ✅ 与 39/17 验收",
     "**✅ 已实现（2026-11-07）**" in task_text
     and "E2E_P42A_OK" in task_text and "UI_SMOKE_P42A_OK" in task_text),
    ("任务表下一步为 P4-2d", "下一步建议" in task_text and "下一步 P4-2d" in task_text),
    ("P4-1 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/lib/wildRegistry.ts",
         "backend/src/modules/wild.ts",
         "backend/tests/wildRegistry.test.ts",
         "backend/tests/sessionReplaced.test.ts",
         "backend/tests/e2e_p41_wild.mjs",
         "scripts/ui_smoke_p41.mjs",
         "src/lib/sessionReplaced.ts",
         "src/lib/wild.ts",
         "src/lib/wild.test.ts",
     ])),
    ("P4-1 Prisma 迁移已落盘并写进 schema",
     (ROOT / "backend" / "prisma" / "migrations" / "20261107164000_add_session_version" / "migration.sql").exists()
     and "sessionVersion" in text(ROOT / "backend" / "prisma" / "schema.prisma")),
    ("任务表记 P4-1 ✅ 与 30/30 E2E_P41_OK",
     "P4-1" in task_text and "E2E_P41_OK" in task_text and "UI_SMOKE_P41_OK" in task_text),
    ("规范含 §20 服务端存档写操作", "## 20. P3-2 瘦终端" in spec_text and "20.7" in spec_text),
    ("verify 已注册 e2e:p32", "e2e:p32" in verify_text),
    ("规范含 §21 写入并发控制", "## 21. 写入版本控制" in spec_text and "21.3 槽位锁" in spec_text),
    ("verify 已注册 e2e:p4", "e2e:p4" in verify_text and '"e2e:p4"' in pkg_text),
    ("P4-0 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/lib/revision.ts",
         "backend/src/lib/slotLock.ts",
         "backend/tests/slotLock.test.ts",
         "backend/tests/revision.test.ts",
         "backend/tests/e2e_p4_cas.mjs",
         "backend/tests/lib/saveWriter.mjs",
     ])),
    ("任务表记 P4-0 ✅", "P4-0" in task_text and "写入并发控制" in task_text),
    ("P3-2 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/mutations.ts",
         "backend/src/modules/game.ts",
         "backend/tests/mutations.test.ts",
         "backend/tests/e2e_p32_mutations.mjs",
         "src/lib/gameApi.ts",
     ])),
    ("规范含 §19.5 降级决策与 §19.6 意图下线",
     "### 19.5" in spec_text and "### 19.6" in spec_text),
    ("任务表 P2-2 ✅ 与 24/24 已回填", "P2-2 ✅" in task_text and "24/24" in task_text),
    ("任务表 P3-1a / P3-1b ✅ 与 39/39 已回填",
     "P3-1a" in task_text and "P3-1b" in task_text and "39/39" in task_text),
    ("任务表下一步为 P4-2", "下一步建议" in task_text and "下一步 P4-2" in task_text),
    ("后端规范含 §15 实时通道", "## 15. P2-1 实时通道" in spec_text),
    ("后端规范含 §16 GameSession", "## 16. P2-2 GameSession" in spec_text),
    ("后端规范含 §17 服务端战斗", "## 17. P3-1 服务端战斗" in spec_text),
    ("每日日志含 P2-2 段落", "## P2-2" in log_text),
    ("每日日志含 P3-1 段落", "P3-1" in log_text),
    ("后端单测含 gameSession.test.ts", (ROOT / "backend" / "tests" / "gameSession.test.ts").exists()),
    ("后端单测含 battleEngine / battleSession",
     (ROOT / "backend" / "tests" / "battleEngine.test.ts").exists()
     and (ROOT / "backend" / "tests" / "battleSession.test.ts").exists()),
    ("内容表已生成且派生脚本已注册",
     (ROOT / "backend" / "src" / "game" / "content.generated.ts").exists()
     and '"gen:content"' in pkg_text and '"check:content"' in pkg_text),
    ("e2e:p21 已注册且脚本存在",
     '"e2e:p21"' in pkg_text and (ROOT / "backend" / "tests" / "e2e_p21_ws.mjs").exists()),
    ("e2e:p22 已注册且脚本存在",
     '"e2e:p22"' in pkg_text and (ROOT / "backend" / "tests" / "e2e_p22_session.mjs").exists()),
    ("e2e:p31 已注册且脚本存在",
     '"e2e:p31"' in pkg_text and (ROOT / "backend" / "tests" / "e2e_p31_battle.mjs").exists()),
    ("UI 冒烟脚本已固化到 scripts/ 且 ROOT 动态推导",
     (ROOT / "scripts" / "ui_smoke_p21.mjs").exists()
     and "fileURLToPath(import.meta.url)" in text(ROOT / "scripts" / "ui_smoke_p21.mjs")),
    ("测试基础设施齐全（harness / 对抗套件 / 数值矩阵）",
     (ROOT / "backend" / "tests" / "lib" / "harness.mjs").exists()
     and (ROOT / "backend" / "tests" / "e2e_hardening.mjs").exists()
     and (ROOT / "backend" / "tests" / "numericRules.test.ts").exists()),
    ("e2e:hardening 与 clean:e2e 已注册",
     '"e2e:hardening"' in pkg_text and '"clean:e2e"' in pkg_text),
    ("统一编排器 verify 已注册且脚本存在",
     (ROOT / "scripts" / "verify.mjs").exists() and '"verify"' in root_pkg_text),
    ("后端规范含 §18 测试体系", "## 18. 测试体系" in spec_text),
    ("后端规范含 §19 前端战斗接入契约", "## 19. P3-1c" in spec_text),
    ("P3-1c 前端接线文件齐全",
     (ROOT / "src" / "lib" / "battleApi.ts").exists()
     and (ROOT / "src" / "stores" / "battleFlow.test.ts").exists()
     and (ROOT / "src" / "lib" / "battleApi.test.ts").exists()),
    ("P3-1c 浏览器冒烟已固化并注册到 verify",
     (ROOT / "scripts" / "ui_smoke_p31c.mjs").exists()
     and "smoke:p31c" in text(ROOT / "scripts" / "verify.mjs")),
    ("任务表记 P3-1c ✅", "P3-1c" in task_text and "P3-1c 前端切换到服务端战斗" in task_text),
    ("HANDOFF 验收以 npm run verify 为首选", "npm run verify" in handoff_text),
    ("交接手册 HANDOFF.md 存在", (ROOT / "HANDOFF.md").exists()),
    ("环境自检脚本存在", (ROOT / "scripts" / "check_home_env.py").exists()),
    # ——— P4-2 未来规划台账与口径修正 ———
    ("未来规划台账存在且 F01~F13 齐全",
     future_path.exists()
     and all(f"F{n:02d}" in future_text for n in range(1, 14))
     and "最终是要设计偿还的" in future_text and "不阻塞" in future_text),
    ("台账 F04：账号等级 + 宠物等级帽 + 当前为占位偏差",
     all(x in future_text for x in [
         "账号等级", "人物", "宠物等级上限", "N+5", "占位", "playerLevel",
         "SCHEMA_VERSION", "不得声称"])),
    ("台账 F01/F02/F03 登记周期结算 / 榜单奖励 / 单机隔离版",
     all(x in future_text for x in ["周期结算", "榜单奖励", "单机隔离版", "现在先不用纠结"])),
    ("契约 §4 标召唤师等级为占位、非产品口径",
     "⚠️ 占位派生" in plan_text and "已知偏差" in plan_text
     and "账号等级决定宠物等级帽" in plan_text),
    ("后端榜单描述已标占位，避免误导玩家",
     "占位派生" in text(ROOT / "backend" / "src" / "game" / "rank.ts")),
    ("任务表 P4-2a 行标注已知偏差并指向 F04",
     "已知偏差" in task_text and "F04" in task_text),
    ("台账 F12 已标偿还、F14 登记 Boss 产出规则",
     "F12" in future_text and "✅ 已偿还" in future_text
     and "F14" in future_text and "不发任何奖励" in future_text),
    ("MEMORY.md 记未来规划台账与召唤师等级口径修正",
     "未来规划与技术债_2026-11-07.md" in memory_text
     and "账号等级" in memory_text and "宠物等级帽" in memory_text),
    ("每日日志记台账建立与口径修正", "未来规划台账" in log_text and "账号等级" in log_text),
    # ——— P4-2b 房间内核 ———
    ("规范含 §24 房间内核（状态域 / quota / 掉线 / 协议）",
     "## 24." in spec_text
     and all(x in spec_text for x in [
         "roomLockKey", "hold", "commit", "release", "tokenDigest",
         "ROOM_WS_REQUIRED", "250ms", "RoomStorage", "room.action"])),
    ("bug_log 含 §17 ~ §29", all(f"## {n}." in bug_text for n in range(17, 30))),
    ("任务表记 P4-2b ✅ 与 43/43 验收",
     "P4-2b" in task_text and "E2E_P42B_OK" in task_text and "已实现" in task_text),
    ("排期文档记 P4-2b 实现记录与自选决策",
     "已实现（2026-11-07" in plan_text and "E2E_P42B" in plan_text
     and "阈值按 `mode` 分档" in plan_text and "去锁确定性" in plan_text),
    ("verify 已注册 e2e:p42b",
     "e2e:p42b" in verify_text and '"e2e:p42b"' in pkg_text
     and "e2e_p42b_room.mjs" in verify_text),
    ("P4-2b 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/lib/roomTypes.ts",
         "backend/src/lib/roomRegistry.ts",
         "backend/src/lib/roomAuth.ts",
         "backend/src/modules/room.ts",
         "backend/tests/roomRegistry.test.ts",
         "backend/tests/roomLock.test.ts",
         "backend/tests/roomProtocol.test.ts",
         "backend/tests/e2e_p42b_room.mjs",
         "src/lib/room.ts",
         "src/lib/room.test.ts"])),
    ("房间协议声明与前端幂等已落盘",
     "room.state" in text(ROOT / "backend" / "src" / "lib" / "wsProtocol.ts")
     and "applyRoomSnapshot" in text(ROOT / "src" / "lib" / "room.ts")
     and "ROOM_STATE_EVENT" in text(ROOT / "src" / "lib" / "sessionState.ts")),
    ("测试账号清理前缀含 p42b_",
     "p42b_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")
     and "p42b_" in text(ROOT / "backend" / "tests" / "lib" / "harness.mjs")),
    ("每日日志记 P4-2b 实现", "P4-2b 房间内核" in log_text and "E2E_P42B_OK" in log_text),

    # ——— P4-2c 单人 Boss 讨伐 + 伤害榜 ———
    ("规范含 §25 Boss 讨伐（伤害真值 / 次数 / 事件表 / 伪上报）",
     "## 25. P4-2c 单人 Boss 讨伐与伤害榜" in spec_text
     and all(x in spec_text for x in [
         "BOSS_UNCATCHABLE", "BOSS_IN_PROGRESS", "BOSS_INPUT_FORBIDDEN",
         "sweepExpired", "bossQuotaKey", "BossDamageEvent", "battleId @unique",
         "dayKeyOf", "applySettlementToSave", "hold", "release"])),
    ("bug_log 含 §17 ~ §30", all(f"## {n}." in bug_text for n in range(17, 31))),
    ("任务表记 P4-2c ✅ 与 44/19 验收",
     "**✅ 已实现（2026-11-07）**" in task_text
     and "E2E_P42C_OK" in task_text and "UI_SMOKE_P42C_OK" in task_text),
    ("排期文档记 P4-2c 已实现与实现记录",
     "P4-2c 单人 Boss 挑战 + 伤害排名（限次）— ✅ 已实现" in plan_text
     and "E2E_P42C" in plan_text
     and "Boss 不发奖励" in plan_text and "在途名额" in plan_text),
    ("verify 已注册 e2e:p42c 与 smoke:p42c",
     "e2e:p42c" in verify_text and "smoke:p42c" in verify_text
     and '"e2e:p42c"' in pkg_text),
    ("P4-2c 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/settlement.ts",
         "backend/src/game/boss.ts",
         "backend/src/game/bossRank.ts",
         "backend/src/lib/bossQuota.ts",
         "backend/src/modules/boss.ts",
         "backend/src/modules/saveRead.ts",
         "backend/tests/boss.test.ts",
         "backend/tests/settlement.test.ts",
         "backend/tests/bossQuota.test.ts",
         "backend/tests/e2e_p42c_boss.mjs",
         "backend/prisma/migrations/20261107233000_add_boss_damage_event/migration.sql",
         "scripts/ui_smoke_p42c.mjs",
         "src/lib/boss.ts",
         "src/lib/boss.test.ts",
         "src/components/BossBoardModal.tsx"])),
    ("Boss 伤害事件表与唯一索引已落 schema",
     "model BossDamageEvent" in text(ROOT / "backend" / "prisma" / "schema.prisma")
     and "battleId" in text(ROOT / "backend" / "prisma" / "schema.prisma")),
    ("Boss 结算明确不发奖励（finish 分支）",
     "s.rewards = null" in text(ROOT / "backend" / "src" / "game" / "battle.ts")
     and "damageDealt" in text(ROOT / "backend" / "src" / "game" / "battle.ts")),
    ("测试账号清理前缀含 p42c_",
     "p42c_" in text(ROOT / "backend" / "tests" / "lib" / "harness.mjs")),
    ("每日日志记 P4-2c 实现", "P4-2c" in log_text and "E2E_P42C_OK" in log_text),
]

for name, ok, *detail in checks:
    suffix = f"  {detail[0]}" if detail and detail[0] else ""
    print(("[OK] " if ok else "[FAIL] ") + name + suffix)

all_ok = all(c[1] for c in checks)
print("DOC_CHECK_OK" if all_ok else "DOC_CHECK_FAILED")
sys.exit(0 if all_ok else 1)
