#!/data/data/com.termux/files/usr/bin/bash
# device-stop.sh —— 停止真机自托管后端（Termux 内执行）：停 tmux 会话 + 后端；PG/Redis 保留
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
echo "=== device-stop @ $(date) ==="
tmux kill-session -t mpk 2>/dev/null && echo "已停 tmux 会话 mpk" || echo "会话 mpk 本就不存在"
pkill -f 'src/index.ts' 2>/dev/null && echo "已停后端进程" || echo "无后端进程"
echo "PG/Redis 保留运行（如需停：pg_ctl -D ~/pgdata stop / redis-cli shutdown）"
echo "=== END ==="
