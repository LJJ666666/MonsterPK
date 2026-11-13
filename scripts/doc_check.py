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

# Windows 本机 stdout 默认 GBK（cp936），断言名里的 ✅ 等符号会抛
# UnicodeEncodeError 直接把自检打挂（沙箱内 PYTHONIOENCODING=utf-8 才不暴露）。
# 保持原编码、只把不可编码字符替换掉：中文照常可读，符号退化成 ?，绝不中断。
for _stream in (sys.stdout, sys.stderr):
    try:
        _stream.reconfigure(errors="replace")
    except Exception:
        pass

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
    ("任务表固化 P4-2 全阶段验收 token（不绑 MEMORY 精确数字）",
     all(x in task_text for x in [
         "E2E_P42A_OK", "E2E_P42B_OK", "E2E_P42C_OK", "E2E_P42D_OK",
         "UI_SMOKE_P42A_OK", "UI_SMOKE_P42C_OK", "UI_SMOKE_P42D_OK"])),
    ("MEMORY.md 记录降级与旧意图下线（决策，非技术细节）",
     "不做离线降级" in memory_text and "下线 `battle_reward`" in memory_text),
    ("MEMORY.md 标 P4-2 收官并给出下一步（F16 → F04）",
     "P4-2 五阶段全部完成" in memory_text and "下一步" in memory_text
     and "F16" in memory_text and "F04" in memory_text),
    ("MEMORY.md 记 P3-2 写操作上移（细节在规范 §20）",
     "P3-2" in memory_text and "## 20." in spec_text),
    ("MEMORY.md 记 P4-0 写入并发控制（细节在规范 §21）",
     "P4-0" in memory_text and "写入并发控制" in memory_text and "## 21." in spec_text),
    ("MEMORY.md 记 P4-1 顶号与共享野怪（细节在规范 §22）",
     "P4-1 ✅" in memory_text and "## 22." in spec_text and "SESSION_REPLACED" in spec_text),
    ("每日日志固化 P4-1 回滚点（不绑 MEMORY 精确 tag 名）",
     "rollback-20261107-pre-p41" in log_text and "rollback-20261107-post-p41" in log_text),
    ("P4-2 排期契约文档齐全（口径 / 参数 / 五阶段 / 边界）",
     plan_path.exists()
     and all(x in plan_text for x in [
         "全员掉线", "不扣次数", "可选", "ROUND_TIMEOUT_MS", "AUTOPILOT_OFFER_MS",
         "ALL_OFFLINE_GRACE_MS", "hold", "commit", "release", "pickUsableMove",
         "roomId", "P4-2a", "P4-2e", "本排期已走完", "同一 token 同一设备",
         "playerLevel", "SCHEMA_VERSION", "共享存储"])),
    ("任务表已拆 P4-2 五阶段并写明排期状态",
     all(f"| P4-2{c}" in task_text for c in "abcde")
     and "P4-2 五阶段全部" in task_text and "不扣次数" in task_text),
    ("MEMORY.md 进度快照含 P4-2a~e ✅ 与 P4-2 收官（指向排期文档）",
     "P4-2a ✅" in memory_text and "P4-2b ✅" in memory_text and "P4-2c ✅" in memory_text
     and "P4-2d ✅" in memory_text and "P4-2e ✅" in memory_text
     and "P4-2 五阶段全部" in memory_text
     and "P4-2_多人玩法排期_2026-11-07.md" in memory_text),
    ("规范/排期固化 P4-2 技术细节（rank/pvp/boss/room/bossQuota）",
     all(x in spec_text for x in ["GET /api/rank", "effectiveStats", "RoomRegistry", "quota",
                                  "BossDamageEvent", "applySettlementToSave", "RoomState.pvp", "pvpViewFor"])
     and "RoomState.pvp" in plan_text),
    ("每日日志记 P4-2 排期拍板", "P4-2 多人玩法排期" in log_text and "全员掉线" in log_text),
    ("每日日志记 P4-2a 实现", "P4-2a 只读派生榜" in log_text and "E2E_P42A_OK" in log_text),
    ("P4-2a 战力定义已钉死（六维 / maxHp / 不代表强弱 / 装备扩展）",
     all(x in plan_text for x in [
         "maxHp", "spAtk", "六维总属性", "不代表实战强弱", "effectiveStats",
         "宠物装备", "公式本身待定", "不写回 `MonsterInstance`"])),
    ("任务表/排期固化战力口径（不绑 MEMORY）",
     "六维总属性" in task_text and "不代表" in task_text and "maxHp" in task_text
     and "不代表实战强弱" in plan_text),
    ("每日日志记战力口径补充", "六维总属性" in log_text and "effectiveStats" in log_text),
    ("每日日志固化早期 commit 锚点（不绑 MEMORY）",
     "`fe159eb`" in log_text and "`2f2c8b7`" in log_text),
    ("MEMORY.md 体积合理（< 20_000，宽松防无限膨胀）", a.stat().st_size < 20_000, f"{a.stat().st_size} bytes"),
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
    ("任务表标 P4-2 收官并有下一步建议",
     "下一步建议" in task_text and "P4-2 五阶段全部完成" in task_text),
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
     (ROOT / "backend" / "prisma" / "migrations_sqlite_archive" / "20261107164000_add_session_version" / "migration.sql").exists()
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
    ("任务表下一步指向 F04 且无过期待开工",
     "下一步建议" in task_text and "P4-3" in task_text and "F16" in task_text
     and "F04" in task_text and "下一步 P4-2c" not in task_text
     and "d/e 待开工" not in task_text and "下一步待杰哥排期" not in task_text),
    ("P4-3 C2C 冻结口径已固化（当前所有资产不可交易）",
     "当前所有资产一律不可交易" in task_text and "阶段冻结" in memory_text
     and "当前冻结" in handoff_text),
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
    # ——— 跨机器交接：给接手 AI 的意图与避坑入口（11-09） ———
    ("内容表比对已规范化换行（跨机器 CRLF 不误报）",
     "normalizeEol" in text(ROOT / "backend" / "scripts" / "gen-content.ts")
     and "统一按 LF" in text(ROOT / "backend" / "scripts" / "gen-content.ts")),
    ("HANDOFF 含 AI 接手必读（意图 / 避坑 / 自检三段）",
     all(x in handoff_text for x in [
         "## AI 接手必读", "### A. 先读懂意图", "### B. 最容易踩的坑",
         "### C. 落地自检", "服务端权威", "commitState()", "产品语义",
         "JWT_SECRET", "DOC_CHECK_OK", "git ls-remote"])),
    ("HANDOFF 机器无关、无过期进度与待办",
     "机器无关" in handoff_text and "P4-2 五阶段全部" in handoff_text
     and "P4-3" in handoff_text and "以命令输出为准" in handoff_text
     and "下一步 P4-2c" not in handoff_text and "d/e 待开工" not in task_text),
    ("MEMORY / HANDOFF 不写死本机盘符或用户名",
     "D:\\MyJob" not in memory_text and "D:\\MyJob" not in handoff_text
     and "盘符" in handoff_text and "user-*-personal" in handoff_text),
    ("环境自检脚本存在", (ROOT / "scripts" / "check_home_env.py").exists()),
    # ——— P4-2 未来规划台账与口径修正 ———
    ("未来规划台账存在且 F01~F16 齐全",
     future_path.exists()
     and all(f"F{n:02d}" in future_text for n in range(1, 16))
     and "最终是要设计偿还的" in future_text and "不阻塞" in future_text),
    ("台账 F04 已按 11-10 口径修订（不本地存储 / 徽章 / 成就 / F17 / F18）",
     all(x in future_text for x in [
         "F04 召唤师等级 / 徽章 / 成就", "不写 `SaveData`", "演武堂",
         "超帽不降级", "F17 单档化", "F18 地图内容", "规范 §31"])),
    ("后端规范含 §31 F04 工程契约与实现记录",
     "## 31." in spec_text and "不本地存储" in spec_text
     and "演武堂" in spec_text and "PLAYER_LEVEL_CAP_BONUS" in spec_text
     and "94 个文件" in spec_text and "不钳等级" in spec_text
     and "### 31.10" in spec_text and "F04-3 已实现" in spec_text),
    ("F04 已偿还：台账 ✅ / 任务表进度 / 规范实现记录",
     "✅ 已偿还 2026-11-10" in future_text
     and "F04 召唤师等级" in task_text
     and "SAVE_INPUT_FORBIDDEN" in spec_text),
    ("F04 等级帽链路：注入 / 冻结 / 捕获不钳 / 伪字段闸门 / 首通发徽章",
     "levelCap" in text(ROOT / "backend" / "src" / "game" / "battle.ts")
     and "expGrantAllowed" in text(ROOT / "backend" / "src" / "game" / "playerLevel.ts")
     and "capturedLevelOf" in text(ROOT / "backend" / "src" / "game" / "settlement.ts")
     and "FORBIDDEN_PROGRESS_SAVE_FIELDS" in text(ROOT / "backend" / "src" / "modules" / "save.ts")
     and "grantBadgeForAreaClear" in text(ROOT / "backend" / "src" / "modules" / "battle.ts")),
    ("F04 E2E / 冒烟接入 verify 且 STAGES + GROUPS 两处齐全",
     text(ROOT / "scripts" / "verify.mjs").count("e2e:f04") >= 2
     and text(ROOT / "scripts" / "verify.mjs").count("smoke:f04") >= 2),
    ("HANDOFF / 任务表 / MEMORY 记 F04 不动 SCHEMA_VERSION 与 F17 单档化",
     "不动 `SCHEMA_VERSION`" in handoff_text and "F17 单档化" in handoff_text
     and "旧口径作废" in task_text and "不写 `SaveData`" in memory_text
     and "F17 单档化" in memory_text),
    ("台账 F01/F02/F03 登记周期结算 / 榜单奖励 / 单机隔离版",
     all(x in future_text for x in ["周期结算", "榜单奖励", "单机隔离版", "现在先不用纠结"])),
    ("F04 收官：契约 §4 召唤师等级已改读服务端 BadgeGrant 真值",
     "已实现" in plan_text and "BadgeGrant" in plan_text
     and "账号等级决定宠物等级帽" in plan_text),
    ("F04 收官：占位派生已删除，榜单真值来自 Grant 表",
     "占位派生已下线" in text(ROOT / "backend" / "src" / "game" / "rank.ts")
     and "badgeGrant.findMany" in text(ROOT / "backend" / "src" / "modules" / "rank.ts")
     and "summonerLevelOf" not in text(ROOT / "backend" / "src" / "game" / "rank.ts")),
    ("任务表 P4-2a 行标注已知偏差并指向 F04",
     "已知偏差" in task_text and "F04" in task_text),
    ("台账 F12 已标偿还、F14 登记 Boss 产出规则",
     "F12" in future_text and "✅ 已偿还" in future_text
     and "F14" in future_text and "不发任何奖励" in future_text),
    # MEMORY 只需索引台账文件名（已在 §1 引用）；口径细节由 F04 台账断言（上条）覆盖
    ("每日日志记台账建立与口径修正", "未来规划台账" in log_text and "账号等级" in log_text),
    # ——— P4-2b 房间内核 ———
    ("规范含 §24 房间内核（状态域 / quota / 掉线 / 协议）",
     "## 24." in spec_text
     and all(x in spec_text for x in [
         "roomLockKey", "hold", "commit", "release", "tokenDigest",
         "ROOM_WS_REQUIRED", "250ms", "RoomStorage", "room.action"])),
    ("bug_log 含 §17 ~ §32", all(f"## {n}." in bug_text for n in range(17, 33))),
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
         "backend/prisma/migrations_sqlite_archive/20261107233000_add_boss_damage_event/migration.sql",
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

    # ——— P4-2d 玩家对战 1v1 ———
    ("规范含 §26 1v1 对战（镜像态 / 意图 / 裁剪 / 结算幂等）",
     "## 26. P4-2d 玩家对战 1v1" in spec_text
     and all(x in spec_text for x in [
         "RoomState.pvp", "PvpSide", "applyPvpTurn", "encodePvpIntent", "pvpViewFor",
         "PVP_INPUT_FORBIDDEN", "settlePvpRoom", "pvpSettled", "seatOf", "sides"])),
    ("bug_log 含 §17 ~ §31", all(f"## {n}." in bug_text for n in range(17, 32))),
    ("任务表记 P4-2d ✅ 与 16/15 验收",
     "**✅ 已实现（2026-11-07）**" in task_text
     and "E2E_P42D_OK" in task_text and "UI_SMOKE_P42D_OK" in task_text
     and "RoomState.pvp" in task_text),
    ("排期文档记 P4-2d 已实现与实现记录",
     "P4-2d 玩家对战 1v1 — ✅ 已实现" in plan_text
     and "E2E_P42D" in plan_text and "sides" in plan_text
     and "pvpViewFor" in plan_text and "不发奖励" in plan_text),
    ("台账记 F15 1v1 对战奖励 / 排位分",
     "F15" in future_text and "排位分" in future_text and "settlePvpRoom" in future_text),
    ("verify 已注册 e2e:p42d 与 smoke:p42d",
     "e2e:p42d" in verify_text and "smoke:p42d" in verify_text
     and '"e2e:p42d"' in pkg_text and "ui_smoke_p42d.mjs" in verify_text),
    ("P4-2d 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/pvp.ts",
         "backend/src/modules/pvp.ts",
         "backend/tests/pvp.test.ts",
         "backend/tests/e2e_p42d_pvp.mjs",
         "scripts/ui_smoke_p42d.mjs",
         "src/lib/pvp.ts",
         "src/components/PvpModal.tsx"])),
    ("pvp 意图正则放宽冒号且视图按接收者裁剪",
     "[A-Za-z0-9_:\\-]" in text(ROOT / "backend" / "src" / "lib" / "roomRegistry.ts")
     and "pvpViewFor" in text(ROOT / "backend" / "src" / "game" / "pvp.ts")
     and "viewerUserId" in text(ROOT / "backend" / "src" / "game" / "pvp.ts")),
    ("测试账号清理前缀含 p42d_",
     "p42d_" in text(ROOT / "backend" / "tests" / "lib" / "harness.mjs")),
    ("每日日志记 P4-2d 实现", "P4-2d" in log_text and "E2E_P42D_OK" in log_text),

    # ——— P4-2e 共斗 Boss / 副本 ———
    ("规范含 §27 共斗（房间真值 / N 人排序 / 降级 / 结算不发奖）",
     "## 27. P4-2e 共斗 Boss / 副本" in spec_text
     and all(x in spec_text for x in [
         "RoomState.coop.boss.hp", "CoopState", "applyCoopTurn", "encodeCoopIntent",
         "coopViewFor", "COOP_INPUT_FORBIDDEN", "settleCoopRoom", "coopSettled",
         "COOP_INTENT_INVALID", "withRoomLock"])),
    ("bug_log 含 §17 ~ §32", all(f"## {n}." in bug_text for n in range(17, 33))),
    ("任务表记 P4-2e ✅ 与 22/16 验收",
     "| P4-2e ✅ |" in task_text
     and "E2E_P42E_OK" in task_text and "UI_SMOKE_P42E_OK" in task_text
     and "RoomState.coop" in task_text),
    ("排期文档记 P4-2e 已实现与实现记录",
     "P4-2e 共斗 Boss / 副本 — ✅" in plan_text
     and "E2E_P42E" in plan_text and "CoopState" in plan_text
     and "coopViewFor" in plan_text and "不发奖励" in plan_text),
    ("台账记 F16 共斗榜 / 奖励分配",
     "F16" in future_text and "共斗榜" in future_text and "settleCoopRoom" in future_text),
    ("verify 已注册 e2e:p42e 与 smoke:p42e",
     "e2e:p42e" in verify_text and "smoke:p42e" in verify_text
     and '"e2e:p42e"' in pkg_text and "ui_smoke_p42e.mjs" in verify_text),
    ("P4-2e 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/coop.ts",
         "backend/src/modules/coop.ts",
         "backend/tests/coop.test.ts",
         "backend/tests/e2e_p42e_coop.mjs",
         "scripts/ui_smoke_p42e.mjs",
         "src/lib/coop.ts",
         "src/components/CoopModal.tsx"])),
    ("共斗拒绝 flee 且视图按接收者裁剪",
     "COOP_INTENT_INVALID" in text(ROOT / "backend" / "src" / "modules" / "room.ts")
     and "coopViewFor" in text(ROOT / "backend" / "src" / "game" / "coop.ts")
     and "viewerUserId" in text(ROOT / "backend" / "src" / "game" / "coop.ts")),
    ("测试账号清理前缀含 p42e_",
     "p42e_" in text(ROOT / "backend" / "tests" / "lib" / "harness.mjs")),
    ("每日日志记 P4-2e 实现", "P4-2e" in log_text and "E2E_P42E_OK" in log_text),

    # ——— F01/F02 台账偿还（11-09） ———
    ("F01/F02 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/game/period.ts",
         "backend/src/game/rankReward.ts",
         "backend/src/modules/rankSettlement.ts",
         "backend/src/modules/rankPeriod.ts",
         "backend/scripts/settle-ranks.ts",
         "backend/tests/period.test.ts",
         "backend/tests/rankReward.test.ts",
         "backend/tests/e2e_f01f02.mjs",
         "scripts/ui_smoke_f01f02.mjs",
         "src/lib/rankPeriod.test.ts",
         "backend/prisma/migrations_sqlite_archive/20261109040021_add_rank_period_and_reward/migration.sql",
     ])),
    ("P4-3 编号冲突已定死（交易/赠送，不再是周期结算）",
     "P4-3（交易 / 赠送）" in task_text and "P4-3（周期结算" not in plan_text
     and "F01 / F02（周期结算" in plan_text),
    ("任务表与台账记 F01/F02 已偿还",
     "F01/F02 已偿还" in task_text and "✅ 已偿还 2026-11-09" in future_text
     and "E2E_F01F02_OK" in task_text),
    ("规范含 §28 F01/F02 与发奖顺序",
     "## 28." in spec_text and "authority.expected" in spec_text
     and "commitState(source='action')" in spec_text and "唯一键" in spec_text),
    ("bug_log 含 §34 旧库迁移与残留账号",
     "## 34." in bug_text and "migrate deploy" in bug_text and "256 个测试账号" in bug_text),
    ("verify 已注册 e2e:f01f02 与 smoke:f01f02（STAGES + GROUPS）",
     "e2e:f01f02" in verify_text and "smoke:f01f02" in verify_text
     and '"e2e:f01f02"' in pkg_text and "ui_smoke_f01f02.mjs" in verify_text
     and "前置清理" in verify_text),
    ("HANDOFF / MEMORY 记 F01/F02 已偿还",
     "F01/F02" in handoff_text and "已偿还" in handoff_text
     and "F01/F02 已偿还" in memory_text),
    ("每日日志记 F01/F02 偿还",
     "F01/F02" in log_text and "E2E_F01F02_OK" in log_text),
    ("F14 Boss 双档奖励已偿还（规范 §29 + 台账 + 任务表）",
     "## 29." in spec_text and "BOSS_FIRST_REWARD" in spec_text
     and "F14" in future_text and "F14" in task_text and "E2E_F14_OK" in task_text),
    ("F15 零产出冻结 / P4-3 C2C 不开放口径固化",
     "仅供娱乐" in future_text and "阶段冻结" in future_text
     and "不打算开放交易系统" in memory_text and "C2C" in handoff_text),
    ("F16 六房副本已实现（规范 §30 + 台账 + 任务表）",
     "## 30." in spec_text and "6 个房间" in spec_text
     and "最低贡献门槛" in spec_text and "pending" in spec_text
     and "✅ 已实现" in spec_text and "✅ 已偿还 2026-11-09" in future_text
     and "E2E_F16_OK" in task_text),
    ("verify 已注册 e2e:f16 与 smoke:f16（STAGES + GROUPS）",
     "e2e:f16" in verify_text and "smoke:f16" in verify_text
     and '"e2e:f16"' in pkg_text and "ui_smoke_f16.mjs" in verify_text),
    ("F16 关键文件齐全",
     all((ROOT / p).exists() for p in [
         "backend/src/modules/coopReward.ts",
         "backend/tests/e2e_f16.mjs",
         "scripts/ui_smoke_f16.mjs",
         "backend/prisma/migrations_sqlite_archive/20261109181400_add_coop_reward_grant/migration.sql",
     ])),
    ("F16 发奖表与幂等键已落 schema",
     "model CoopRewardGrant" in text(ROOT / "backend" / "prisma" / "schema.prisma")
     and "grantKey" in text(ROOT / "backend" / "prisma" / "schema.prisma")),
    ("测试账号清理前缀含 f16_",
     "f16_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")),
    ("每日日志记 F16 实现", "F16 六房副本" in log_text and "E2E_F16_OK" in log_text),
    ("bug_log 含 §37 等级上界与视图字段",
     "## 37." in bug_text and "levelMax + 6" in bug_text and "occupantSeat" in bug_text),
    ("verify 已注册 e2e:f14（STAGES + GROUPS）",
     "e2e:f14" in verify_text and '"e2e:f14"' in pkg_text
     and "前置清理" in verify_text),
    ("HANDOFF / MEMORY 记 F14 已偿还与 F16 已实现",
     "F14" in handoff_text and "F16" in handoff_text
     and "F14" in memory_text and "F16" in memory_text),
    ("bug_log 含 §36 同锁重入死锁",
     "## 36." in bug_text and "alreadyLocked" in bug_text),
    ("每日日志记 F14 偿还与共斗 6 房设计",
     "F14" in log_text and "E2E_F14_OK" in log_text and "6 房" in log_text),
    # ——— F17 单档化 ———
    ("规范含 §32 F17 单档化工程契约",
     "## 32." in spec_text and "SAVE_SLOT_FORBIDDEN" in spec_text
     and "第 11 条迁移" in spec_text and "106" in spec_text),
    ("F17 闸门：400 / 版本三处 11 / 第 11 条迁移存在",
     "SAVE_SLOT_FORBIDDEN" in text(ROOT / "backend" / "src" / "modules" / "save.ts")
     and "SCHEMA_VERSION = 11" in text(ROOT / "src" / "stores" / "saveVersion.ts")
     and "EXPECTED_SAVE_VERSION = 11" in text(ROOT / "backend" / "src" / "lib" / "saveValidator.ts")
     and (ROOT / "backend" / "prisma" / "migrations_sqlite_archive" / "20261110113000_f17_single_save" / "migration.sql").exists()),
    ("F17 E2E 接入 verify 两处且清理前缀含 f17_",
     verify_text.count("e2e:f17") >= 2 and '"e2e:f17"' in pkg_text
     and "f17_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")
     and (ROOT / "backend" / "tests" / "e2e_f17.mjs").exists()),
    ("F17 已偿还：台账 / 任务表 / HANDOFF / MEMORY / 日志 / bug_log",
     "F17 单档化 ✅ 已偿还" in future_text
     and "F17 单档化已实现并偿还" in task_text
     and "F17 单档化已实现并偿还" in handoff_text
     and "F17 单档化已实现并偿还" in memory_text
     and "F17 单档化" in log_text and "## 39." in bug_text),
    ("bug_log 含 §39 F17 踩坑", "## 39." in bug_text and "admin.ts" in bug_text),
    # ——— F18-a 地图锁 ———
    ("规范含 §33 F18 契约", "## 33." in spec_text and "LOCATION_LOCKED" in spec_text and "mapLock" in spec_text),
    ("F18-a 双点闸门：game.ts+save.ts LOCATION_LOCKED + mapLock.ts 存在",
     "LOCATION_LOCKED" in text(ROOT / "backend" / "src" / "modules" / "game.ts")
     and "LOCATION_LOCKED" in text(ROOT / "backend" / "src" / "modules" / "save.ts")
     and (ROOT / "backend" / "src" / "game" / "mapLock.ts").exists()),
    ("F18-a E2E 接入 verify 两处且清理前缀含 f18_",
     verify_text.count("e2e:f18a") >= 2 and '"e2e:f18a"' in pkg_text
     and "f18_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")
     and (ROOT / "backend" / "tests" / "e2e_f18a.mjs").exists()),
    ("F18 进度：台账/任务表/HANDOFF/MEMORY/bug_log",
     "F18-a 地图锁 ✅ 已偿还" in future_text
     and "F18-a 地图锁已实现并偿还" in task_text
     and "F18-b" in handoff_text and "F18-a" in memory_text and "## 40." in bug_text),
    ("bug_log 含 §40 F18-a 收官", "## 40." in bug_text and "LOCATION_LOCKED" in bug_text),
    # ——— 回归 B/C/E 补齐（2026-11-11）———
    ("回归 B/E：内容矩阵 E2E 存在且 verify 两处注册 + 清理前缀",
     (ROOT / "backend" / "tests" / "e2e_content_matrix.mjs").exists()
     and verify_text.count("e2e:content_matrix") >= 2
     and '"e2e:content_matrix"' in pkg_text
     and "matrix_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")),
    ("回归 C：全局状态与弹窗 UX 冒烟存在且 verify 两处注册 + 清理前缀",
     (ROOT / "scripts" / "ui_smoke_ux.mjs").exists()
     and verify_text.count("smoke:ux") >= 2
     and "ux_" in text(ROOT / "backend" / "scripts" / "clean-test-data.mjs")),
    ("bug_log 含 §43 回归 B/C/E 收官与只读闸门口径差异",
     "## 43." in bug_text and "PROGRESS_INPUT_FORBIDDEN" in bug_text
     and "RANK_INPUT_FORBIDDEN" in bug_text and "PARTY_EMPTY" in bug_text),
    ("HANDOFF 不再写死 SCHEMA_VERSION=10 且 F18 全阶段收官",
     "SCHEMA_VERSION`(=10)" not in handoff_text
     and "F18 地图内容全阶段已收官" in handoff_text
     and "saveValidator.ts" in handoff_text),
    ("任务表与每日日志均记回归 B/C/E 补齐",
     "回归 B/C/E" in task_text and "回归 B/C/E" in log_text),
    ("verify 头部注释不再写死 17 组 E2E",
     "e2e    后端端到端（含对抗套件，阶段数以脚本输出为准）" in verify_text),
    # ——— P5-1 / F10 共享存储迁移评估（2026-11-11）———
    ("P5-1/F10 迁移评估文档存在且结构完整",
     (DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md").exists()
     and all(k in text(DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md")
             for k in ("8 类进程内状态", "六个必须成组改造的耦合点",
                       "需要杰哥拍板 / 提供的前置输入", "本文件不含任何产品代码改动"))),
    ("评估钉住三处修正口径（revision 非列 / RoomStorage 同步 / 定时器重复）",
     all(k in text(DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md")
         for k in ("`revision` 不是 DB 独立列", "`RoomStorage` 是同步接口",
                   "两个 `setInterval` 每个进程各跑一遍", "Redis 只放锁"))),
    ("F10 台账指向迁移评估文档且标注口径修正",
     "P5-1_F10_共享存储迁移评估_2026-11-11.md"
     in text(DOCS / "未来规划与技术债_2026-11-07.md")
     and "偏乐观口径"
     in text(DOCS / "未来规划与技术债_2026-11-07.md")),
    ("MEMORY 与每日日志均记 P5-1 评估且未擅自开工",
     "P5-1 / F10 共享存储迁移评估" in memory_text
     and "P5-1 / F10 共享存储迁移评估" in log_text
     and "不改任何产品代码" in log_text),
    ("实施设计定稿含选型 B / W0~W9 / 12 处勘误",
     "实施设计定稿" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "选型定稿：B" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "专家复核勘误（12 处" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W0" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W9" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")),
    ("评估初稿已挂定稿取代与 12 处勘误指针",
     "本稿已被定稿取代" in text(DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md")
     and "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md" in text(DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md")
     and "12 处结论" in text(DOCS / "P5-1_F10_共享存储迁移评估_2026-11-11.md")),
    ("F10 台账与 HANDOFF 均指向定稿且标注选型 B 已拍板",
     "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md" in text(DOCS / "未来规划与技术债_2026-11-07.md")
     and "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md" in text(ROOT / "HANDOFF.md")
     and "选型 B" in text(ROOT / "HANDOFF.md")
     and "W0" in text(ROOT / "HANDOFF.md")),
    ("定稿钉住 PG 基线重置与 Redis 不存权益真值",
     "一条 PG 基线 init" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "schema.prisma:2" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "Redis 不存任何影响玩家权益的真值" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")),
    ("MEMORY 与日志均记实施设计定稿且未改产品代码",
     "实施设计定稿" in memory_text
     and "实施设计定稿" in log_text
     and "不改任何产品代码" in log_text
     and "W0" in memory_text),
    ("bug_log §44 记录专家复核勘误",
     "## 44." in bug_text
     and "三组独立后端架构专家" in bug_text),
    ("A3 CI 工作流存在且覆盖前后端静态与单测",
     (ROOT / ".github" / "workflows" / "ci.yml").exists()
     and all(k in text(ROOT / ".github" / "workflows" / "ci.yml")
             for k in ("22.22.2", "npm run check", "npm test", "check:content",
                       "prisma generate", "doc_check.py"))),
    ("A6 台账补齐 F19~F26 并标注单机时代设想须重评",
     all(f"| F{i} |" in text(DOCS / "未来规划与技术债_2026-11-07.md") for i in range(19, 27))
     and "服务端权威重评" in text(DOCS / "未来规划与技术债_2026-11-07.md")),
    ("A6 可玩性补全文档挂台账指针",
     "F19" in text(DOCS / "游戏设计分析_可玩性补全.md")
     and "服务端权威" in text(DOCS / "游戏设计分析_可玩性补全.md")),
    ("性能基线 §6 四项真机补测已回填",
     all(k in text(DOCS / "性能基线_web.md") for k in
         ("- [x] APK 冷启动到首帧", "- [x] WebView 内实际 FPS", "- [x] JS 堆峰值",
          "- [x] 后台切回", "12/12 全绿"))
     and (DOCS / "性能基线_adb_真机数据_2026-11-11.json").exists()
     and "scripts/perf-adb.mjs" in text(DOCS / "性能基线_web.md")),
    ("bug_log §45 记录构建链与补测",
     "## 45." in bug_text
     and "vite-plugin-trae-solo-badge" in bug_text
     and "JDK 21" in bug_text),
    ("生产包不再含 Trae 外链角标插件",
     "vite-plugin-trae-solo-badge" not in root_pkg_text
     and "traeBadgePlugin" not in text(ROOT / "vite.config.ts")
     and "补测执行结果（2026-11-11，12/12 全绿）" in text(DOCS / "雷电模拟器_adb操作规范_2026-11-11.md")),
    ("A1 分包复核定稿：移除人工分包，回到 Vite 默认单包",
     "manualChunks(id)" not in text(ROOT / "vite.config.ts")
     and "return 'vendor-react'" not in text(ROOT / "vite.config.ts")
     and "rollupOptions" not in text(ROOT / "vite.config.ts")
     and "Capacitor" in text(ROOT / "vite.config.ts")
     and "## 50." in bug_text
     and "770,965" in bug_text),
    ("A2 后端 requestId 追踪与 CORS 暴露",
     "genReqId" in text(ROOT / "backend/src/index.ts")
     and "X-Request-Id" in text(ROOT / "backend/src/index.ts")
     and "exposedHeaders" in text(ROOT / "backend/src/index.ts")),
    ("A4 ErrorBoundary 接入入口与单测",
     "ErrorBoundary" in text(ROOT / "src/main.tsx")
     and (ROOT / "src/components/ErrorBoundary.tsx").exists()
     and (ROOT / "src/components/ErrorBoundary.test.tsx").exists()),
    ("A5 登录失败限流（只计失败 / 成功清零 / 可重建临时态）",
     (ROOT / "backend/src/lib/loginRateLimit.ts").exists()
     and "recordFailure" in text(ROOT / "backend/src/modules/auth.ts")
     and "LOGIN_RATE_LIMITED" in text(ROOT / "backend/tests/e2e_hardening.mjs")
     and "P5-1" in text(ROOT / "backend/src/lib/loginRateLimit.ts")),
    ("bug_log §46 记录 A1/A2/A4/A5 收官与 5173 端口坑",
     "## 46." in bug_text and "A5" in bug_text and "5173" in bug_text),
    ("前端端口单一真值源 MPK_FRONT_PORT 已接入脚本",
     (ROOT / "scripts/lib/devConfig.mjs").exists()
     and "MPK_FRONT_PORT" in text(ROOT / "scripts/lib/devConfig.mjs")
     and "devConfig" in text(ROOT / "scripts/verify.mjs")
     and "devConfig" in text(ROOT / "scripts/ui_smoke_ux.mjs")
     and "MPK_FRONT_PORT" in text(ROOT / "vite.config.ts")
     and "MPK_FRONT_PORT" in text(ROOT / "backend/src/index.ts")),
    ("W0 锁与广播接口化并删掉 broadcastToMany 死代码",
     (ROOT / "backend/src/lib/lockProvider.ts").exists()
     and (ROOT / "backend/src/lib/broadcastTransport.ts").exists()
     and "setLockProvider" in text(ROOT / "backend/src/lib/slotLock.ts")
     and "setBroadcastTransport" in text(ROOT / "backend/src/modules/sessionBus.ts")
     and "broadcastToMany" not in text(ROOT / "backend/src/lib/wsRegistry.ts")),
    ("W0 CAS 基线可注入 / pvpSettled 写回 / quota key 去截断",
     (ROOT / "backend/src/lib/revisionSource.ts").exists()
     and "readRevision" in text(ROOT / "backend/src/modules/save.ts")
     and "setSettledFlag" in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "slice(-8)" not in text(ROOT / "backend/src/modules/coop.ts")),
    ("W0 心跳拆分与确定性单测模板",
     "runGlobalSweep" in text(ROOT / "backend/src/modules/realtime.ts")
     and (ROOT / "backend/tests/lib/deterministic.ts").exists()
     and all((ROOT / f"backend/tests/{n}").exists() for n in (
         "w0LockProvider.test.ts", "w0BroadcastTransport.test.ts",
         "w0RevisionSource.test.ts", "w0QuotaSettled.test.ts"))),
    ("bug_log §47 与任务表 / 定稿 / HANDOFF 记录 W0 收官",
     "## 47." in bug_text
     and "MPK_FRONT_PORT" in bug_text
     and "P5-1 W0 收官" in task_text
     and "2026-11-12 已完成并验收" in text(DOCS / "P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W1 起进入批次 B" in text(ROOT / "HANDOFF.md")),
    ("偶发红修复：Vite 原生别名 + 卸载 tsconfigPaths + IPv4 全网卡",
     "resolve" in text(ROOT / "vite.config.ts")
     and "alias" in text(ROOT / "vite.config.ts")
     and "^@" in text(ROOT / "vite.config.ts")
     and "tsconfigPaths()" not in text(ROOT / "vite.config.ts")
     and "import tsconfigPaths" not in text(ROOT / "vite.config.ts")
     and "vite-tsconfig-paths" not in root_pkg_text
     and "host: '0.0.0.0'" in text(ROOT / "vite.config.ts")),
    ("生产模板不再含内联 module script（Vite html-proxy 大小写坑）",
     "import.meta.hot" not in text(ROOT / "index.html")
     and '<script type="module">' not in text(ROOT / "index.html")),
    ("verify 逐阶段完整日志留痕",
     (ROOT / "scripts/lib/verifyLogger.mjs").exists()
     and "createLogSession" in verify_text
     and "outTail" in verify_text
     and "SPAWN_ERROR" in verify_text
     and ".verify-logs/" in text(ROOT / ".gitignore")),
    ("E2E 异常与 HTTP 上下文不再被截断",
     all(k in text(ROOT / "backend/tests/lib/harness.mjs")
         for k in ("formatFatal", "uncaughtException", "[CONTEXT]", "E2E_HTTP_NETWORK"))
     and "[FATAL:main]" in text(ROOT / "backend/tests/e2e_f18c.mjs")),
    ("7 个 E2E 套件 catch 统一打完整堆栈",
     all("formatFatal" in text(ROOT / f"backend/tests/{n}") for n in (
         "e2e_content_matrix.mjs", "e2e_core_loop.mjs", "e2e_f17.mjs",
         "e2e_f18a.mjs", "e2e_f18b.mjs", "e2e_f18c.mjs", "e2e_f18c_security.mjs"))),
    ("bug_log §48 记录偶发红根因与四轮验收",
     "## 48." in bug_text
     and "resolversByDir" in bug_text
     and "45/47" in bug_text
     and "47/47" in bug_text
     and "偶发红定位与修复" in task_text
     and "验收留痕（2026-11-12" in handoff_text),
    ("逃跑 RNG 偶发红：f18b/f18c E2E 重试到终态",
     all("fleeUntilDone" in text(ROOT / f"backend/tests/{n}")
         and "result === 'fled'" in text(ROOT / f"backend/tests/{n}")
         for n in ("e2e_f18b.mjs", "e2e_f18c.mjs"))
     and "fleeUntilDone" in text(ROOT / "backend/tests/e2e_f14.mjs")),
    ("bug_log §49 记录逃跑 RNG 根因与订正指针",
     "## 49." in bug_text
     and "MAPBOSS_BATTLE_IN_PROGRESS" in bug_text
     and "撤离失败" in bug_text
     and "2026-11-12 订正" in bug_text
     and "E2E 偶发红第二个根因收敛" in task_text
     and "fleeUntilDone" in handoff_text),
    ("W1：provider 切 Postgres、Save.revision 提列、PG 基线 init 落盘",
     'provider = "postgresql"' in text(ROOT / "backend/prisma/schema.prisma")
     and 'provider = "sqlite"' not in text(ROOT / "backend/prisma/schema.prisma")
     and 'revision      Int      @default(0)' in text(ROOT / "backend/prisma/schema.prisma")
     and '"revision" INTEGER NOT NULL DEFAULT 0' in text(ROOT / "backend/prisma/migrations/20261112123700_init/migration.sql")
     and 'CREATE TABLE "Save"' in text(ROOT / "backend/prisma/migrations/20261112123700_init/migration.sql")),
    ("W1：11 条 SQLite 迁移归档、lock 重置、只剩一条 PG 基线",
     # W1 收官时 PG 基线恰为 1 条；W6.0/W6.1 起合法新增迁移（room_storage/room_quota），
     # 故放宽为 >=1（归档仍须恰好 11 条、provider 须 postgresql）。
     len(list((ROOT / "backend/prisma/migrations_sqlite_archive").glob("*/migration.sql"))) == 11
     and 'provider = "postgresql"' in text(ROOT / "backend/prisma/migrations/migration_lock.toml")
     and len(list((ROOT / "backend/prisma/migrations").glob("*/migration.sql"))) >= 1
     and (ROOT / "backend/prisma/migrations_sqlite_archive/README.md").exists()),
    ("W1：revision 回填幂等脚本与事务回滚验证脚本存在",
     (ROOT / "backend/prisma/backfill_revision.sql").exists()
     and "regexp_match" in text(ROOT / "backend/prisma/backfill_revision.sql")
     and 'WHERE "revision" = 0' in text(ROOT / "backend/prisma/backfill_revision.sql")
     and (ROOT / "backend/scripts/w1_backfill_check.mjs").exists()
     and "W1_BACKFILL_RESULT" in text(ROOT / "backend/scripts/w1_backfill_check.mjs")),
    ("W1：SQLite 专属 PRAGMA 已换 information_schema、新机自检认 PG",
     "PRAGMA table_info" not in text(ROOT / "backend/tests/e2e_f17.mjs")
     and "information_schema.columns" in text(ROOT / "backend/tests/e2e_f17.mjs")
     and "DATABASE_URL uses postgresql provider" in text(ROOT / "scripts/check_home_env.py")
     and "dev.db exists" not in text(ROOT / "scripts/check_home_env.py")
     and "postgresql://" in text(ROOT / "backend/.env.example")),
    ("bug_log §51 与任务表 / HANDOFF / 定稿记录 W1 收官",
     "## 51." in bug_text
     and "20261112123700_init" in bug_text
     and "P5-1 W1 收官" in task_text
     and "W1 起进入批次 B" in handoff_text
     and "W1 ✅ 2026-11-12" in handoff_text
     and "W1 ✅ 2026-11-12" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")),
    ("W2：CAS 策略层落盘且 commitState 用条件 updateMany 裁决 409",
     (ROOT / "backend/src/lib/saveCas.ts").exists()
     and "updateIfRevision" in text(ROOT / "backend/src/lib/saveCas.ts")
     and "count !== 1" in text(ROOT / "backend/src/lib/saveCas.ts")
     and "P2002" in text(ROOT / "backend/src/lib/saveCas.ts")
     and "RevisionConflictError" in text(ROOT / "backend/src/modules/session.ts")
     and "updateMany({" in text(ROOT / "backend/src/modules/session.ts")
     and "revision: baseRevision" in text(ROOT / "backend/src/modules/session.ts")
     and "不 apply 内存" in text(ROOT / "backend/src/modules/session.ts")),
    ("W2：内存 +1 已废除、CAS 基线只读 DB 列",
     "monotonicAuthority" not in text(ROOT / "backend/src/lib/gameSession.ts")
     and "revision: prev.revision + 1" not in text(ROOT / "backend/src/lib/authority.ts")
     and "currentState(userId)" in text(ROOT / "backend/src/lib/revisionSource.ts")
     and "baseRevision: currentRev" in text(ROOT / "backend/src/modules/save.ts")
     and "baseRevision: server?.revision ?? 0" in text(ROOT / "backend/src/modules/actions.ts")),
    ("W2：确定性单测含 barrier 与无条件 upsert 反证",
     (ROOT / "backend/tests/w2SaveCas.test.ts").exists()
     and "function barrier" in text(ROOT / "backend/tests/w2SaveCas.test.ts")
     and "unconditional: true" in text(ROOT / "backend/tests/w2SaveCas.test.ts")
     and "反证" in text(ROOT / "backend/tests/w2SaveCas.test.ts")),
    ("W2：双进程 E2E 注册到 npm / STAGES / GROUPS / 清理前缀",
     "e2e:w2" in text(ROOT / "backend/package.json")
     and "{ id: 'e2e:w2'" in text(ROOT / "scripts/verify.mjs")
     and "'e2e:p41'," in text(ROOT / "scripts/verify.mjs")
     and "'w2'" in text(ROOT / "backend/scripts/clean-test-data.mjs")
     and "--import" in text(ROOT / "backend/tests/e2e_w2_cas.mjs")
     and "stopSecondInstance" in text(ROOT / "backend/tests/e2e_w2_cas.mjs")),
    ("W2：E2E 不做时序概率硬断言（分支类型只作 INFO）",
     "分支类型只作 INFO" in text(ROOT / "backend/tests/e2e_w2_cas.mjs")
     and "[INFO] 双进程 5 组并发中命中 DB 条件更新分支" in text(ROOT / "backend/tests/e2e_w2_cas.mjs")),
    ("bug_log §52 / 任务表 / HANDOFF / 定稿记录 W2 收官与 48/48",
     "## 52." in bug_text
     and "P5-1 W2 收官" in task_text
     and "W2 ✅ 2026-11-12" in handoff_text
     and "48/48" in handoff_text
     and "W2 ✅ 2026-11-12" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "48/48" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "48/48" in text(ROOT / ".trae/documents/未来规划与技术债_2026-11-07.md")),
    ("W2：HANDOFF 不再保留 SQLite DATABASE_URL 过期口径",
     'DATABASE_URL="file:./dev.db"' not in handoff_text
     and "postgresql://" in handoff_text),
    ("headless Edge 错误页重试加固（§53）落地且断言未放宽",
     (ROOT / "scripts/lib/edgeDom.mjs").exists()
     and "createRetriedExec" in text(ROOT / "scripts/lib/edgeDom.mjs")
     and "RETRY_EXHAUSTED" in text(ROOT / "scripts/lib/edgeDom.mjs")
     and all("createRetriedExec" in text(p) for p in (ROOT / "scripts").glob("ui_smoke_*.mjs"))
     and "seedDom.includes('SEEDED')" in text(ROOT / "scripts/ui_smoke_p42d.mjs")),
    ("bug_log §53 与任务表记录冒烟偶发红第三类根因",
     "## 53." in bug_text
     and "headless Edge 单次导航失败" in task_text
     and "round14" in bug_text),
    ("W3：Redis 锁后端（SET NX PX + Lua token 比对）与 Provider 落地",
     (ROOT / "backend/src/lib/redisLockBackend.ts").exists()
     and (ROOT / "backend/src/lib/redisLockProvider.ts").exists()
     and "RENEW_SCRIPT" in text(ROOT / "backend/src/lib/redisLockBackend.ts")
     and "RELEASE_SCRIPT" in text(ROOT / "backend/src/lib/redisLockBackend.ts")
     and "'PX', ttlMs, 'NX'" in text(ROOT / "backend/src/lib/redisLockBackend.ts")
     and "AsyncLocalStorage" in text(ROOT / "backend/src/lib/redisLockProvider.ts")
     and "LOCK_RENEW_INTERVAL_MS" in text(ROOT / "backend/src/lib/redisLockProvider.ts")
     and "maxAttempts" in text(ROOT / "backend/src/lib/redisLockProvider.ts")
     and "lock:acct:" in text(ROOT / "backend/src/lib/redisLockProvider.ts")
     and "lock:mapbossq:" in text(ROOT / "backend/src/lib/redisLockProvider.ts")),
    ("W3：启动装配不静默降级，health 暴露锁模式，env 模板默认注释",
     (ROOT / "backend/src/lib/lockBootstrap.ts").exists()
     and "拒绝以进程内锁降级启动" in text(ROOT / "backend/src/lib/lockBootstrap.ts")
     and "getLockDiagnostics" in text(ROOT / "backend/src/index.ts")
     and "initializeLockProvider()" in text(ROOT / "backend/src/index.ts")
     and "shutdownLockProvider()" in text(ROOT / "backend/src/index.ts")
     and "# REDIS_URL=" in text(ROOT / "backend/.env.example")
     and "REDIS_URL" in text(ROOT / "backend/.env.example")),
    ("W3：确定性单测含去锁反证 / barrier / watchdog / 嵌套不死锁",
     (ROOT / "backend/tests/w3RedisLock.test.ts").exists()
     and "function barrier" in text(ROOT / "backend/tests/w3RedisLock.test.ts")
     and "去掉锁必然交错" in text(ROOT / "backend/tests/w3RedisLock.test.ts")
     and "watchdog 续租" in text(ROOT / "backend/tests/w3RedisLock.test.ts")
     and "嵌套同 key 不死锁" in text(ROOT / "backend/tests/w3RedisLock.test.ts")
     and "LOCK_ACQUIRE_TIMEOUT" in text(ROOT / "backend/tests/w3RedisLock.test.ts")),
    ("W3：E2E 注册到 npm / STAGES / GROUPS / 清理前缀且用产品 TS 模块",
     "e2e:w3" in text(ROOT / "backend/package.json")
     and "--import tsx" in text(ROOT / "backend/package.json")
     and "{ id: 'e2e:w3'" in text(ROOT / "scripts/verify.mjs")
     and "'e2e:p41'," in text(ROOT / "scripts/verify.mjs")
     and "'w3'" in text(ROOT / "backend/scripts/clean-test-data.mjs")
     and "redisLockProvider.ts" in text(ROOT / "backend/tests/e2e_w3_lock.mjs")
     and "预占账号锁" in text(ROOT / "backend/tests/e2e_w3_lock.mjs")
     and "拒绝以进程内锁降级启动" in text(ROOT / "backend/tests/e2e_w3_lock.mjs")),
    ("bug_log §54 / 任务表 / HANDOFF / 定稿 / 台账记录 W3 收官与 49/49",
     "## 54." in bug_text
     and "P5-1 W3 收官" in task_text
     and "W3 ✅ 2026-11-12" in handoff_text
     and "49/49" in handoff_text
     and "W3 ✅ 2026-11-12" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "49/49" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W3 ✅ 2026-11-12" in text(ROOT / ".trae/documents/未来规划与技术债_2026-11-07.md")),    ("bug_log §55 / 任务表记录 core_loop 偶发全灭根因",
     "## 55." in bug_text
     and "单强宠" in bug_text
     and "round19" in bug_text
     and "30/30" in bug_text
     and "core_loop 共斗单强宠" in task_text),
    ("core_loop 共斗测试档已与 f16 对齐（全强宠 + guest 多宠），断言未放宽",
     "core_g_strong_" in text(ROOT / "backend/tests/e2e_core_loop.mjs")
     and "level: 40, exp: 0" in text(ROOT / "backend/tests/e2e_core_loop.mjs")
     and "六房全清 → settled / result=win / cleared=6" in text(ROOT / "backend/tests/e2e_core_loop.mjs")
     and "COOP_REWARD_MONEY = 40" in text(ROOT / "backend/tests/e2e_core_loop.mjs")),
    ("bug_log §56 记录沙箱代理错配与 W3 推送收官",
     "## 56." in bug_text
     and "sandbox-cli.exe" in bug_text
     and "8693" in bug_text
     and "11811" in bug_text
     and "HEAD == origin/master == 2ad52b3" in bug_text),
    ("HANDOFF / MEMORY / 任务表固化 git 502 时的系统代理口径",
     "8693" in handoff_text
     and "8693" in memory_text
     and "W3 推送收官" in task_text),
    ("bug_log §57 固化配置分层与防再犯六条硬规则",
     "## 57." in bug_text
     and "沙箱 / 工具层" in bug_text
     and "系统 / 本机层" in bug_text
     and "项目层（唯一可提交真值）" in bug_text
     and "防再犯六条硬规则" in bug_text
     and "11811" in bug_text
     and "8693" in bug_text),
    ("HANDOFF / MEMORY 固化配置分层，避免沙箱配置混入项目配置",
     "配置分层" in handoff_text
     and "配置分层硬约束" in memory_text
     and "curl --noproxy" in handoff_text
     and "唯一可提交真值" in handoff_text),
    ("W4：选主 / fencing / 幂等键 / 启动装配 / health 诊断落地",
     (ROOT / "backend/src/lib/sweepLeader.ts").exists()
     and "ACQUIRE_SCRIPT" in text(ROOT / "backend/src/lib/sweepLeader.ts")
     and "IS_CURRENT_SCRIPT" in text(ROOT / "backend/src/lib/sweepLeader.ts")
     and "guardedCommit" in text(ROOT / "backend/src/lib/sweepLeader.ts")
     and "lightContext" in text(ROOT / "backend/src/lib/sweepLeader.ts")
     and "initializeSweepLeader" in text(ROOT / "backend/src/index.ts")
     and "getSweepDiagnostics" in text(ROOT / "backend/src/index.ts")
     and "sessionVersion" in text(ROOT / "backend/src/lib/wsRegistry.ts")
     # W6.2 起房间写入统一走 withRoomUnit；房间锁本身仍由 slotLock 的 withRoomLock 提供。
     and "withRoomUnit" in text(ROOT / "backend/src/modules/room.ts")
     and "withRoomLock" in text(ROOT / "backend/src/lib/roomUnitOfWork.ts")),
    ("W4：确定性单测 / 真 Redis E2E / verify 三处注册齐全",
     (ROOT / "backend/tests/w4SweepLeader.test.ts").exists()
     and (ROOT / "backend/tests/e2e_w4_sweep.mjs").exists()
     and "sweepLeader.ts" in text(ROOT / "backend/tests/e2e_w4_sweep.mjs")
     and "生产租约隔离" in text(ROOT / "backend/tests/e2e_w4_sweep.mjs")
     and "e2e:w4" in text(ROOT / "backend/package.json")
     and "{ id: 'e2e:w4'" in text(ROOT / "scripts/verify.mjs")
     and "'e2e:w4'," in text(ROOT / "scripts/verify.mjs")),
    ("bug_log §58 / 任务表 / HANDOFF / 定稿 / 台账 / MEMORY 记录 W4 收官与 50/50",
     "## 58." in bug_text
     and "P5-1 W4 收官" in task_text
     and "W4 ✅ 2026-11-12" in handoff_text
     and "50/50" in handoff_text
     and "W4 ✅ 2026-11-12" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "50/50" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W4 ✅ 2026-11-12" in text(ROOT / ".trae/documents/未来规划与技术债_2026-11-07.md")
     and "P5-1 W4 ✅" in memory_text),

    # ─── W6.2（#183）：room + quota + 结算写档 + 发奖同一事务边界 ───
    ("W6.2：工作单元 / 事务客户端 / 提交后副作用落地",
     (ROOT / "backend/src/lib/roomUnitOfWork.ts").exists()
     and all(k in text(ROOT / "backend/src/lib/roomUnitOfWork.ts") for k in (
         "AsyncLocalStorage", "roomDb", "onRoomCommit", "runInRoomUnit",
         "withRoomUnit", "withRoomLock", "$transaction"))
     and all("roomDb()" in text(ROOT / f"backend/src/{p}") for p in (
         "lib/pgRoomStorage.ts", "modules/session.ts",
         "modules/saveRead.ts", "modules/coopReward.ts"))
     and "onRoomCommit" in text(ROOT / "backend/src/modules/session.ts")
     and "onRoomCommit" in text(ROOT / "backend/src/modules/room.ts")
     and "skipDuplicates" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")),
    ("W6.2：结算改为事务内 await，杜绝 fire-and-forget 脱离边界",
     "await import('./coop')" in text(ROOT / "backend/src/modules/room.ts")
     and "await import('./pvp')" in text(ROOT / "backend/src/modules/room.ts")
     and "isRoomUnitActive()" in text(ROOT / "backend/src/modules/coop.ts")
     and "isRoomUnitActive()" in text(ROOT / "backend/src/modules/coopReward.ts")),
    ("W6.2：确定性单测 / 真 PG E2E / verify 两处注册齐全",
     (ROOT / "backend/tests/w62RoomUnit.test.ts").exists()
     and (ROOT / "backend/tests/e2e_w62_room_tx.mjs").exists()
     and "E2E_W62_OK" in text(ROOT / "backend/tests/e2e_w62_room_tx.mjs")
     and "e2e:w62" in text(ROOT / "backend/package.json")
     and "{ id: 'e2e:w62'" in text(ROOT / "scripts/verify.mjs")
     and "'e2e:w62'," in text(ROOT / "scripts/verify.mjs")),
    ("bug_log §64 / 任务表 / 定稿 / MEMORY 记录 W6.2 收官",
     "## 64." in bug_text
     and "W6.2 收官" in bug_text
     and "P5-1 W6.2 收官" in task_text
     and "W6.2 ✅ 2026-11-13" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W6.2 事务边界" in memory_text),
    ("W6.3：房间 quota 改 DB 原子条件更新，不再 read-modify-write",
     "tryHoldQuota" in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "tryHoldQuota" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")
     and "$executeRaw" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")
     and "roomQuotaDaily" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")
     and "return this.storage.tryHoldQuota(key, limit);" in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "this.storage.settleQuota(q.key, commit, limit)" in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "setQuota(" not in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "setQuota(" not in text(ROOT / "backend/src/lib/pgRoomStorage.ts")),
    ("W6.3：结算事务二次 count + 超限整包回滚",
     "dailyCommitted" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")
     and "RoomQuotaExceededError" in text(ROOT / "backend/src/lib/roomRegistry.ts")
     and "periodKeyForQuota" in text(ROOT / "backend/src/lib/pgRoomStorage.ts")
     and "limit?: number" in text(ROOT / "backend/src/lib/roomTypes.ts")),
    ("W6.3：确定性单测 / 真 PG 并发 E2E / verify 两处注册齐全",
     (ROOT / "backend/tests/w63RoomQuota.test.ts").exists()
     and (ROOT / "backend/tests/e2e_w63_quota.mjs").exists()
     and "E2E_W63_OK" in text(ROOT / "backend/tests/e2e_w63_quota.mjs")
     and "e2e:w63" in text(ROOT / "backend/package.json")
     and "{ id: 'e2e:w63'" in text(ROOT / "scripts/verify.mjs")
     and "'e2e:w63'," in text(ROOT / "scripts/verify.mjs")),
    ("bug_log §65 / 任务表 / 定稿 / MEMORY 记录 W6.3 收官",
     "## 65." in bug_text
     and "W6.3 收官" in bug_text
     and "P5-1 W6.3 收官" in task_text
     and "W6.3 ✅ 2026-11-13" in text(ROOT / ".trae/documents/P5-1_F10_迁移实施设计定稿与工单_2026-11-11.md")
     and "W6.3 DB 计数" in memory_text),
]

for name, ok, *detail in checks:
    suffix = f"  {detail[0]}" if detail and detail[0] else ""
    print(("[OK] " if ok else "[FAIL] ") + name + suffix)

all_ok = all(c[1] for c in checks)
print("DOC_CHECK_OK" if all_ok else "DOC_CHECK_FAILED")
sys.exit(0 if all_ok else 1)
