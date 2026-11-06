#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MonsterPK 新机器环境自检（只读，不修改任何文件）。

运行：python scripts/check_home_env.py
输出全部为 ASCII，避免 Windows GBK / UTF-8 控制台编码差异导致乱码。
状态： [OK] 通过 | [WARN] 需人工确认 | [FAIL] 必须修复
退出码：0 = OK/WARN，1 = 有 FAIL。
"""
from pathlib import Path
import hashlib
import socket
import subprocess
import sys

ROOT = Path(__file__).resolve().parent.parent
BACK = ROOT / "backend"
COUNTS = {"OK": 0, "WARN": 0, "FAIL": 0}


def say(status, msg):
    COUNTS[status] += 1
    print(f"[{status}] {msg}")


def cmd(line, cwd=ROOT):
    try:
        r = subprocess.run(line, shell=True, cwd=str(cwd), capture_output=True,
                           text=True, timeout=30)
        return (r.stdout or "").strip()
    except Exception:
        return ""


def major(version):
    digits = "".join(c if c.isdigit() else " " for c in version).split()
    return int(digits[0]) if digits else 0


def port_open(port):
    try:
        with socket.create_connection(("127.0.0.1", port), timeout=0.5):
            return True
    except OSError:
        return False


def sha(p):
    return hashlib.sha256(p.read_bytes()).hexdigest()


# ---- toolchain ----
node_v = cmd("node -v")
npm_v = cmd("npm -v")
if major(node_v) >= 22:
    say("OK", f"node {node_v} (>=22)")
else:
    say("FAIL", f"node missing or too old: {node_v or 'N/A'} (need >= 22)")
if major(npm_v) >= 10:
    say("OK", f"npm {npm_v} (>=10)")
else:
    say("WARN", f"npm missing or old: {npm_v or 'N/A'} (recommend >= 10)")

# ---- dependencies ----
for label, p in (("frontend", ROOT / "node_modules"),
                 ("backend", BACK / "node_modules")):
    if p.is_dir():
        say("OK", f"{label} node_modules installed")
    else:
        say("FAIL", f"{label} node_modules missing -> run: npm install")
if (BACK / "node_modules" / ".prisma" / "client" / "index.js").is_file():
    say("OK", "prisma client generated")
else:
    say("WARN", "prisma client not generated -> run: npx prisma generate")

# ---- backend local config (NOT in git) ----
env_file = BACK / ".env"
if env_file.is_file():
    say("OK", "backend/.env exists")
    env_text = env_file.read_text(encoding="utf-8", errors="ignore")
    if "change-me-in-prod" in env_text:
        say("FAIL", "JWT_SECRET is still the template default -> set a random long string")
    elif "JWT_SECRET" not in env_text:
        say("FAIL", "JWT_SECRET missing in backend/.env")
    else:
        say("OK", "JWT_SECRET customized")
else:
    say("FAIL", "backend/.env missing -> cp .env.example .env then edit it")

if (BACK / "prisma" / "dev.db").is_file():
    say("OK", "backend/prisma/dev.db exists")
else:
    say("WARN", "dev.db missing -> run: npx prisma migrate deploy (new empty DB: re-register + grant admin)")

# ---- git ----
head = cmd("git rev-parse HEAD")
remote = cmd("git rev-parse origin/master")
if head and head == remote:
    say("OK", f"HEAD == origin/master ({head[:7]})")
elif head and remote:
    say("WARN", f"HEAD {head[:7]} != origin/master {remote[:7]} -> check pull/push")
else:
    say("WARN", "cannot resolve git refs -> check clone/remote")
dirty = cmd("git status --porcelain")
if dirty:
    say("WARN", f"working tree has {len(dirty.splitlines())} uncommitted item(s)")
else:
    say("OK", "working tree clean")

# ---- project memory ----
wb = ROOT / ".workbuddy" / "memory" / "MEMORY.md"
tr = ROOT / ".trae" / "documents" / "项目记忆.md"
if wb.is_file() and tr.is_file():
    if sha(wb) == sha(tr):
        say("OK", f"memory mirror in sync (sha256={sha(wb)[:12]})")
    else:
        say("FAIL", "memory mirror mismatch -> run: python scripts/sync_memory.py")
else:
    say("FAIL", "project memory files missing -> incomplete clone")

# ---- user-level memory (NOT in git) ----
home = Path.home() / ".workbuddy"
user_files = [home / "MEMORY.md", home / "IDENTITY.md", home / "SOUL.md"]
personal = list(home.glob("user-*-personal/MEMORY.md"))
if all(p.is_file() for p in user_files) and personal:
    say("OK", "user-level memory files present")
else:
    say("WARN", "user-level memory incomplete -> see HANDOFF.md section 4 (or paste the hello prompt)")

# ---- deliverables ----
for name, p in (("HANDOFF.md", ROOT / "HANDOFF.md"),
                ("doc_check.py", ROOT / "scripts" / "doc_check.py"),
                ("ui_smoke_p21.mjs", ROOT / "scripts" / "ui_smoke_p21.mjs")):
    if p.is_file():
        say("OK", f"{name} present")
    else:
        say("FAIL", f"{name} missing")

# ---- services ----
for label, port in (("frontend :5173", 5173), ("backend :3001", 3001)):
    if port_open(port):
        say("OK", f"{label} reachable")
    else:
        say("WARN", f"{label} not running -> see HANDOFF.md section 3.3")

fails, warns = COUNTS["FAIL"], COUNTS["WARN"]
print(f"SUMMARY ok={COUNTS['OK']} warn={warns} fail={fails}")
if fails:
    print("ENV_CHECK_FAILED")
    sys.exit(1)
print("ENV_CHECK_OK" if warns == 0 else "ENV_CHECK_WARN")
sys.exit(0)
