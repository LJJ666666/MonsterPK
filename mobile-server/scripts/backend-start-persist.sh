#!/bin/bash
# 在 proot Debian 内持久启动后端（脱离 adb 会话）
set -uo pipefail
LOG=/sdcard/mpk/start-backend.log
exec > >(tee -a "$LOG") 2>&1
echo "=== start-backend @ $(date) ==="
NODEROOT=/opt/node-v20
NODE="$NODEROOT/bin/node"
BACKEND=/opt/backend
TSX_MJS="$BACKEND/node_modules/tsx/dist/cli.mjs"

# 杀掉旧的
pkill -f 'src/index.ts' 2>/dev/null || true
sleep 1

cd "$BACKEND" || exit 1
export PATH="$NODEROOT/bin:$PATH"
# setsid 脱离会话 + nohup 忽略 SIGHUP + stdin 指向 /dev/null，三重保险
setsid nohup "$NODE" "$TSX_MJS" src/index.ts > /sdcard/mpk/backend-debian.log 2>&1 < /dev/null &
PID=$!
disown 2>/dev/null || true
echo "started pid=$PID"
sleep 8
echo "== 进程检查 =="
ps -A | grep -E 'node|tsx' | grep -v grep | head -5
echo "== health =="
curl -s -m 5 -w "\nHTTP=%{http_code}\n" http://127.0.0.1:3001/api/health 2>&1 | tail -3
echo "=== START_DONE ==="
