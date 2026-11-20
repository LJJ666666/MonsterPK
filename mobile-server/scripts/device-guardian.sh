#!/bin/bash
# device-guardian.sh —— 在 proot Debian 内【前台】持有后端（被 device-start.sh 的 tmux 会话调用）
# 关键：必须前台 exec，不能 & 后台+nohup——后者在 proot 会话退出时会被一起回收。
set -uo pipefail
NODEROOT=/opt/node-v20
NODE="$NODEROOT/bin/node"
BACKEND=/opt/backend
TSX_MJS="$BACKEND/node_modules/tsx/dist/cli.mjs"
echo "=== device-guardian @ $(date) pid=$$ ===" >> /sdcard/mpk/device-guardian.log
cd "$BACKEND" || exit 1
export PATH="$NODEROOT/bin:$PATH"
pkill -f 'src/index.ts' 2>/dev/null || true
sleep 1
echo "[guardian] exec backend foreground" >> /sdcard/mpk/device-guardian.log
# exec：用后端进程替换 guardian，保持前台，proot 会话不退出
exec "$NODE" "$TSX_MJS" src/index.ts >> /sdcard/mpk/backend-device.log 2>&1
