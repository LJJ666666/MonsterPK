#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# mobile-server / device-start.sh —— 真机 arm64 日常启动（Termux 内执行）
#
# 关键：proot 子进程会随发起它的 shell 退出而被杀（雷电上 nohup/setsid 都无效）。
#       正解是让 proot 会话在一个 tmux 会话里【前台常驻】，tmux daemon 由 Termux 持有，
#       配合 termux-wake-lock + 系统电池白名单，切到游戏 App 后端也不会断。
#
# 前置：device-setup.sh 已成功跑过一次（PG/Redis/proot Debian/后端就位）。
# 用法：bash /sdcard/mpk/device-start.sh
# 幂等：重复执行会先停旧会话再起新的。
# 停止：bash /sdcard/mpk/device-stop.sh
# 自检：bash /sdcard/mpk/device-check.sh
# ============================================================================
set -uo pipefail
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
SHARE=/sdcard/mpk
LOGD="$HOME/logs"
SESS=mpk
mkdir -p "$LOGD"

log() { echo "[ms] $*"; }

echo "=== device-start @ $(date) ==="
ARCH=$(uname -m)
log "arch=$ARCH"
[ "$ARCH" = "aarch64" ] || log "WARN: 非 arm64（本脚本为真机设计）"

command -v tmux >/dev/null 2>&1 || { echo "[ms] ERROR: 缺 tmux，先跑 device-setup.sh"; exit 1; }

# ---- 1. 唤醒锁（防 CPU 深睡冻结定时器）----
if command -v termux-wake-lock >/dev/null 2>&1; then
  termux-wake-lock 2>&1 && log "wake-lock 已获取"
else
  log "WARN: 无 termux-wake-lock（装 termux-api 后可防深睡）"
fi

# ---- 2. Termux 原生 PG / Redis ----
PGDATA="$HOME/pgdata"
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  log "启动 PostgreSQL ..."
  pg_ctl -D "$PGDATA" -l "$LOGD/pg.log" -o "-h 127.0.0.1 -p 5432" start 2>&1 | tail -4
fi
pg_isready -h 127.0.0.1 -p 5432 && log "PG ready" || echo "[ms] ERROR: PG 未就绪"

if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$HOME" 2>&1 | tail -2
fi
redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1 && log "Redis ready" || echo "[ms] ERROR: Redis 未就绪"

# ---- 3. 后端放进 tmux 会话前台常驻 ----
# guardian 脚本在 proot 内 exec 后端（前台），tmux 会话活着 = proot 活着 = 后端活着
GUARDIAN="$SHARE/device-guardian.sh"
[ -f "$GUARDIAN" ] || { echo "[ms] ERROR: 缺 $GUARDIAN"; exit 1; }

tmux has-session -t "$SESS" 2>/dev/null && {
  log "会话 $SESS 已存在，先销毁重建"
  tmux kill-session -t "$SESS" 2>/dev/null || true
  sleep 1
}

tmux new-session -d -s "$SESS" \
  "proot-distro login debian -- bash $GUARDIAN >> $LOGD/tmux-guardian.log 2>&1"
log "tmux 会话 $SESS 已起（proot 前台持有后端）"

# ---- 4. 等 health 200（轮询，不 sleep 赌窗口）----
log "等待后端 health=200（最多 60s）..."
ok=0
for i in $(seq 1 30); do
  code=$(curl -s -m 3 -o /dev/null -w '%{http_code}' http://127.0.0.1:3001/api/health 2>/dev/null || echo 000)
  if [ "$code" = "200" ]; then ok=1; break; fi
  sleep 2
done
if [ "$ok" = "1" ]; then
  log "✅ HEALTH=200 后端已就绪，打开游戏 APK 即可真登录/真战斗"
else
  echo "[ms] ❌ 后端 60s 内未就绪，诊断："
  echo "  tmux attach -t $SESS        # 看前台输出"
  echo "  cat $LOGD/tmux-guardian.log"
  echo "  cat $LOGD/device-guardian.log 2>/dev/null || cat /sdcard/mpk/device-guardian.log"
fi

# ---- 5. 会话状态快照 ----
echo "=== tmux sessions ===" >> "$LOGD/device-start-snapshot.log"
tmux list-sessions >> "$LOGD/device-start-snapshot.log" 2>&1
echo "=== processes ===" >> "$LOGD/device-start-snapshot.log"
ps -A 2>/dev/null | grep -E 'proot|node|postgres|redis' | grep -v grep >> "$LOGD/device-start-snapshot.log"
echo "=== DEVICE_START_DONE (health=$code) ==="
