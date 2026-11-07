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

checks = [
    ("记忆镜像 sha256 一致", sha(a) == sha(b), sha(a)[:12]),
    ("MEMORY.md 已无旧数字 75/75 / **75**", "75/75" not in memory_text and "**75**" not in memory_text),
    ("MEMORY.md 写入最终数字（160 / 81 / 34 / 24 / 48 / 114 / 15）",
     all(x in memory_text for x in ["**160**", "**81**", "**34**", "**24**", "**48**", "114", "**15/15**"])),
    ("MEMORY.md 记录降级与旧意图下线",
     "不做离线降级" in memory_text and "下线 `battle_reward`" in memory_text),
    ("MEMORY.md 下一步为 P3-2", "下一步 P3-2" in memory_text),
    ("MEMORY.md 已登记 commit", "`fe159eb`" in memory_text and "`2f2c8b7`" in memory_text),
    ("MEMORY.md 体积已收敛", a.stat().st_size < 15_000, f"{a.stat().st_size} bytes"),
    ("bug_log 含 §17 ~ §24", all(f"## {n}." in bug_text for n in (17, 18, 19, 20, 21, 22, 23, 24))),
    ("规范含 §19.5 降级决策与 §19.6 意图下线",
     "### 19.5" in spec_text and "### 19.6" in spec_text),
    ("任务表 P2-2 ✅ 与 24/24 已回填", "P2-2 ✅" in task_text and "24/24" in task_text),
    ("任务表 P3-1a / P3-1b ✅ 与 39/39 已回填",
     "P3-1a" in task_text and "P3-1b" in task_text and "39/39" in task_text),
    ("任务表下一步为 P3-2", "下一步建议" in task_text and "P3-2" in task_text),
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
]

for name, ok, *detail in checks:
    suffix = f"  {detail[0]}" if detail and detail[0] else ""
    print(("[OK] " if ok else "[FAIL] ") + name + suffix)

all_ok = all(c[1] for c in checks)
print("DOC_CHECK_OK" if all_ok else "DOC_CHECK_FAILED")
sys.exit(0 if all_ok else 1)
