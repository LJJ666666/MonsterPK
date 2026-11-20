#!/data/data/com.termux/files/usr/bin/bash
# 启动 Termux 原生 PG/Redis（数据已持久化，断电只是停进程）
P=/data/data/com.termux/files/usr
H=/data/data/com.termux/files/home
export PATH=$P/bin:$PATH
echo "=== start-native-services @ $(date) ==="

# PG
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  echo "启动原生 PG..."
  pg_ctl -D "$H/pgdata" -l "$H/logs/pg-native-reboot.log" -o '-h 127.0.0.1 -p 5432' start 2>&1 | tail -5
fi
pg_isready -h 127.0.0.1 -p 5432 && echo "PG ready"

# Redis
if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  echo "启动原生 Redis..."
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$H" 2>&1 | tail -3
fi
redis-cli -h 127.0.0.1 -p 6379 ping && echo "Redis ready"

# DB 状态
echo "=== DB list ==="
psql -h 127.0.0.1 -U mpk -d postgres -lqt 2>&1 | head -10
echo "=== monsterpk 表数 ==="
psql -h 127.0.0.1 -U mpk -d monsterpk -tAc "select count(*) from information_schema.tables where table_schema='public'" 2>&1
echo "=== END ==="
