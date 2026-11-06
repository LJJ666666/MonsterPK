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
log_text = text(MEM / "2026-11-06.md")
spec_text = text(DOCS / "后端开发规范_backend.md")
pkg_text = text(ROOT / "backend" / "package.json")

checks = [
    ("记忆镜像 sha256 一致", sha(a) == sha(b), sha(a)[:12]),
    ("MEMORY.md 已无旧数字 75/75 / **75**", "75/75" not in memory_text and "**75**" not in memory_text),
    ("MEMORY.md 写入最终数字（92 / 37 / 34 / 13）",
     all(x in memory_text for x in ["**92**", "**37**", "**34**", "**13/13**"])),
    ("MEMORY.md 下一步为 P2-2", "下一步 P2-2" in memory_text),
    ("MEMORY.md 已登记 commit", "`fe159eb`" in memory_text),
    ("MEMORY.md 体积已收敛", a.stat().st_size < 13_000, f"{a.stat().st_size} bytes"),
    ("bug_log 含 §17 / §18 / §19", all(f"## {n}." in bug_text for n in (17, 18, 19))),
    ("任务表 P2-1 ✅ 与 34/34 已回填", "**P2-1 WebSocket 接入与鉴权** | ✅" in task_text and "34/34" in task_text),
    ("任务表下一步为 P2-2", "P2-2 服务端 GameSession 实时态**" in task_text),
    ("后端规范含 §15 实时通道", "## 15. P2-1 实时通道" in spec_text),
    ("每日日志含 P2-1 段落", "## P2-1 WebSocket 接入与鉴权" in log_text),
    ("e2e:p21 已注册且脚本存在",
     '"e2e:p21"' in pkg_text and (ROOT / "backend" / "tests" / "e2e_p21_ws.mjs").exists()),
    ("UI 冒烟脚本已固化到 scripts/ 且 ROOT 动态推导",
     (ROOT / "scripts" / "ui_smoke_p21.mjs").exists()
     and "fileURLToPath(import.meta.url)" in text(ROOT / "scripts" / "ui_smoke_p21.mjs")),
    ("交接手册 HANDOFF.md 存在", (ROOT / "HANDOFF.md").exists()),
    ("环境自检脚本存在", (ROOT / "scripts" / "check_home_env.py").exists()),
]

for name, ok, *detail in checks:
    suffix = f"  {detail[0]}" if detail and detail[0] else ""
    print(("[OK] " if ok else "[FAIL] ") + name + suffix)

all_ok = all(c[1] for c in checks)
print("DOC_CHECK_OK" if all_ok else "DOC_CHECK_FAILED")
sys.exit(0 if all_ok else 1)
