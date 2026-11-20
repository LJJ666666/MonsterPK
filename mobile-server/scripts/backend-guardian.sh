#!/bin/bash
# proot 内前台守护：启动后端并 wait，永不退出（保持 proot 会话存活）
NODEROOT=/opt/node-v20
NODE="$NODEROOT/bin/node"
BACKEND=/opt/backend
TSX_MJS="$BACKEND/node_modules/tsx/dist/cli.mjs"
echo "=== guardian @ $(date) pid=$$ ===" >> /sdcard/mpk/guardian.log
cd "$BACKEND" || exit 1
export PATH="$NODEROOT/bin:$PATH"
pkill -f 'src/index.ts' 2>/dev/null || true
sleep 1
# 前台运行后端（不用 &），这样 proot 会话一直被占用，进程不会被清理
echo "guardian: starting backend foreground" >> /sdcard/mpk/guardian.log
exec "$NODE" "$TSX_MJS" src/index.ts >> /sdcard/mpk/backend-debian.log 2>&1
