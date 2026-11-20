#!/data/data/com.termux/files/usr/bin/bash
# device-check.sh —— 真机自检查看（Termux 内执行）：服务状态 + health + 最近后端日志
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
LOGD="$HOME/logs"
echo "=== device-check @ $(date) ==="
echo "arch=$(uname -m)"
echo "-- PG   : $(pg_isready -h 127.0.0.1 -p 5432 2>&1)"
echo "-- Redis: $(redis-cli -h 127.0.0.1 -p 6379 ping 2>&1)"
code=$(curl -s -m 5 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null || echo 000)
echo "-- API health: HTTP=$code"
echo "-- tmux: $(tmux list-sessions 2>&1)"
echo "-- proot/node 进程:"
ps -A 2>/dev/null | grep -E 'proot|node|postgres|redis' | grep -v grep | head -15
echo "-- 后端日志尾（/sdcard/mpk/backend-device.log）:"
tail -15 /sdcard/mpk/backend-device.log 2>/dev/null || echo "  (无日志)"
echo "=== END ==="
