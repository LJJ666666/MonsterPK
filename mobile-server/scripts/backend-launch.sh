#!/data/data/com.termux/files/usr/bin/bash
# Termux 层启动器：把整个 proot 会话放到后台常驻（在 proot 之外 nohup）
export PATH=/data/data/com.termux/files/usr/bin:$PATH
echo "=== launcher @ $(date) ===" > /sdcard/mpk/launcher.log
# 先在 Termux 层杀掉旧的 proot guardian
pkill -f 'backend-guardian' 2>/dev/null || true
sleep 1
# nohup + setsid 在 Termux 层（不进 proot），让 proot 会话本身后台常驻
nohup setsid proot-distro login debian -- bash /sdcard/mpk/backend-guardian.sh >> /sdcard/mpk/guardian-stdout.log 2>&1 < /dev/null &
echo "guardian proot session pid=$!" >> /sdcard/mpk/launcher.log
sleep 12
echo "== 进程 ==" >> /sdcard/mpk/launcher.log
ps -A | grep -E 'node|proot' | grep -v grep >> /sdcard/mpk/launcher.log 2>&1
echo "== health ==" >> /sdcard/mpk/launcher.log
curl -s -m 5 -o /dev/null -w "HTTP=%{http_code}\n" http://127.0.0.1:3001/api/health >> /sdcard/mpk/launcher.log 2>&1
echo done
