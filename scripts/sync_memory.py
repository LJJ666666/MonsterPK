#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
MonsterPK 记忆双向同步脚本
--------------------------------------------------
把 .workbuddy/memory/MEMORY.md 与 .trae/documents/项目记忆.md 保持一致。

用法:
    python scripts/sync_memory.py            # 默认: .workbuddy -> .trae
    python scripts/sync_memory.py --reverse  # 反向: .trae -> .workbuddy
    python scripts/sync_memory.py --check    # 只校验两边是否一致, 不写入

退出码: 0 一致/同步成功; 2 两边不一致(仅 --check); 1 文件缺失或参数错误
"""
import hashlib
import os
import shutil
import sys

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
WB = os.path.join(ROOT, ".workbuddy", "memory", "MEMORY.md")
TRAE = os.path.join(ROOT, ".trae", "documents", "项目记忆.md")


def sha(path):
    with open(path, "rb") as f:
        return hashlib.sha256(f.read()).hexdigest()


def main():
    args = set(sys.argv[1:])
    if args - {"--reverse", "--check"}:
        print("未知参数, 只支持 --reverse / --check")
        return 1

    if not os.path.isfile(WB):
        print("缺少文件: " + WB)
        return 1
    if not os.path.isfile(TRAE) and ("--reverse" in args or "--check" in args):
        print("缺少文件: " + TRAE)
        return 1

    if "--check" in args:
        if not os.path.isfile(TRAE):
            print("[不一致] 镜像文件不存在")
            return 2
        same = sha(WB) == sha(TRAE)
        print(("[一致] " if same else "[不一致] ") + "workbuddy sha256=" + sha(WB)[:12]
              + "  trae sha256=" + sha(TRAE)[:12])
        return 0 if same else 2

    if "--reverse" in args:
        src, dst = TRAE, WB
        direction = ".trae -> .workbuddy"
    else:
        src, dst = WB, TRAE
        direction = ".workbuddy -> .trae"

    same = os.path.isfile(dst) and sha(src) == sha(dst)
    if same:
        print("[跳过] 两边已一致, 无需写入")
        return 0

    bak_dir = os.path.join(ROOT, ".workbuddy", "memory", "_backup")
    if os.path.isfile(dst):
        os.makedirs(bak_dir, exist_ok=True)
        shutil.copyfile(dst, os.path.join(bak_dir, os.path.basename(dst) + ".bak"))
    shutil.copyfile(src, dst)
    print("[已同步] " + direction)
    print("  src: " + src)
    print("  dst: " + dst + "  (旧版本已备份到 .workbuddy/memory/_backup/)")
    return 0


if __name__ == "__main__":
    sys.exit(main())
