#!/usr/bin/env bash
# ============================================================================
# mobile-server / proot-deploy.sh —— 在 proot Debian 内执行（stage 2）
# 触发（Termux 侧）：proot-distro login debian -- bash "$HOME/proot-deploy.sh"
# 说明：proot 用户态路径直通，Termux 的绝对 home 路径在 Debian 内可见（$HOME 本身
#       会被设成 /root，故全程用硬编码绝对路径 HOME_DIR，不依赖 $HOME 变量）。
# 幂等：可重复执行。
# ============================================================================
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
HOME_DIR=/data/data/com.termux/files/home
BACKEND="$HOME_DIR/backend"
LOG="$HOME_DIR/logs/proot-deploy.log"
mkdir -p "$HOME_DIR/logs"
exec > >(tee -a "$LOG") 2>&1
log() { echo "[ms] $*"; }
die() { echo "[ms] ERROR: $*"; exit 1; }

echo "=== proot-deploy @ $(date) ==="
log "uid=$(id -u) arch=$(uname -m) os=$(cat /etc/os-release 2>/dev/null | grep PRETTY | cut -d= -f2)"

# ---- 0. 定位后端包（proot 内共享存储路径可能不可见，故多候选探测）----
PKG=""
for cand in "$HOME_DIR/backend-src.tar.gz" "$HOME_DIR/storage/shared/mpk/backend-src.tar.gz"; do
  if [ -f "$cand" ]; then PKG="$cand"; break; fi
done
[ -n "$PKG" ] || die "后端包不存在（两处候选都没有）"
log "后端包: $PKG ($(stat -c%s "$PKG" 2>/dev/null) bytes)"

# ---- 1. Debian 内装 PG / Redis / Node / curl ----
if ! command -v psql >/dev/null 2>&1; then
  log "apt update + 装 PostgreSQL/Redis/curl..."
  apt-get update -qq 2>&1 | tail -3
  apt-get install -y -qq postgresql postgresql-client redis-server curl ca-certificates 2>&1 | tail -12 || die "apt 安装 PG/Redis 失败"
fi
if ! command -v node >/dev/null 2>&1; then
  log "装 Node 20（nodesource）..."
  curl -fsSL https://deb.nodesource.com/setup_20.x 2>/dev/null | bash - >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs 2>&1 | tail -8 || die "node 安装失败"
fi
log "版本: node=$(node -v 2>/dev/null) npm=$(npm -v 2>/dev/null) PG=$(pg_config --version 2>/dev/null)"

# ---- 2. 初始化 PG（Debian 用 postgres 用户，data 放 /var/lib/postgresql/mpkdata）----
PGDATA="/var/lib/postgresql/mpkdata"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  mkdir -p "$PGDATA"; chown -R postgres:postgres "$PGDATA"
  su postgres -c "/usr/lib/postgresql/*/bin/initdb -D $PGDATA -A trust -U mpk" 2>&1 | tail -5 || die "initdb 失败"
fi
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D $PGDATA -l $HOME_DIR/logs/pg-debian.log -o '-h 127.0.0.1 -p 5432' start" 2>&1 | tail -5 || die "PG 启动失败"
fi
pg_isready -h 127.0.0.1 -p 5432 && log "PG ready"
su postgres -c "psql -h 127.0.0.1 -U mpk -d postgres -lqt" 2>/dev/null | cut -d'|' -f1 | grep -qw monsterpk || \
  su postgres -c "createdb -h 127.0.0.1 -U mpk monsterpk" 2>&1 | tail -2
log "DB monsterpk ready"

# ---- 3. Redis ----
if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$HOME_DIR" 2>&1 | tail -3
fi
redis-cli -h 127.0.0.1 -p 6379 ping && log "Redis ready"

# ---- 4. 解压后端 + .env ----
log "解压后端源码 → $BACKEND"
rm -rf "$BACKEND"; mkdir -p "$BACKEND"
tar -xzf "$PKG" -C "$BACKEND" 2>&1 | tail -3 || die "解压失败"
[ -f "$BACKEND/package.json" ] || die "后端源码结构异常"
cat > "$BACKEND/.env" <<'EOF'
DATABASE_URL="postgresql://mpk@127.0.0.1:5432/monsterpk?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
JWT_SECRET="mobile-server-local-self-test-secret-32chars"
JWT_TTL="30d"
PORT=3001
CORS_ORIGIN="http://localhost:5173,http://127.0.0.1:5173,http://localhost,https://localhost,capacitor://localhost"
ADMIN_USERNAMES=""
EOF

# ---- 5. npm install + prisma ----
log "npm install..."
cd "$BACKEND" || die "cd backend 失败"
export NPM_CONFIG_ALLOW_REMOTE=all
npm install --no-audit --no-fund 2>&1 | tail -10 || die "npm install 失败"
# npm 12 的 allowScripts 白名单：旧版无此命令，忽略失败；新版批准 install scripts
npm install-scripts approve --all >/dev/null 2>&1 || true
npm rebuild >/dev/null 2>&1 || true

log "prisma generate + migrate deploy..."
# Debian bookworm = glibc + openssl 3，prisma 自动选 debian-openssl-3.0.x engine（能跑）
# 用 node 显式入口，避开 Android/Termux 下 npx 解析失常的问题
PRISMA_JS="$BACKEND/node_modules/prisma/build/index.js"
TSX_MJS="$BACKEND/node_modules/tsx/dist/cli.mjs"
[ -f "$PRISMA_JS" ] || die "prisma 入口不存在: $PRISMA_JS"
node "$PRISMA_JS" generate 2>&1 | tail -8 || die "prisma generate 失败"
node "$PRISMA_JS" migrate deploy 2>&1 | tail -14 || die "prisma migrate 失败"

# ---- 6. 起后端 ----
log "启动后端..."
pkill -f 'src/index.ts' 2>/dev/null || true
nohup node "$TSX_MJS" src/index.ts > "$HOME_DIR/logs/backend-debian.log" 2>&1 &
echo "backend pid=$!"
sleep 8
curl -s -m 5 -w "\nHEALTH=%{http_code}\n" http://127.0.0.1:3001/api/health 2>&1 | head -5
echo "=== PROOT_DEPLOY_DONE ==="
