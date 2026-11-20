#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# mobile-server / deploy-native.sh
# 在 Termux（Android14 x86_64）内以 app 用户身份原生部署：
#   PostgreSQL + Redis + Node → 后端源码 → prisma → 起服务
# 不用 proot：Termux 源已提供全套原生包（PG18 / Redis8 / Node20+）。
# 调用方式（宿主机）：
#   adb shell run-as com.termux /data/data/com.termux/files/usr/bin/bash /sdcard/mpk/deploy-native.sh
# 幂等：可重复执行。
# ============================================================================
set -uo pipefail
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
HOME_DIR="$HOME"
SHARE="$HOME_DIR/storage/shared/mpk"
PKG="$SHARE/backend-src.tar.gz"
BACKEND="$HOME_DIR/backend"
PGDATA="$HOME_DIR/pgdata"
LOGD="$HOME_DIR/logs"
mkdir -p "$LOGD"
exec > >(tee -a "$LOGD/deploy-native.log") 2>&1
log() { echo "[ms] $*"; }
die() { echo "[ms] ERROR: $*"; exit 1; }

echo "=== deploy-native @ $(date) ==="
log "uid=$(id -u) arch=$(uname -m) shell=$BASH_VERSION"
[ -f "$PKG" ] || die "后端包不存在: $PKG"

# ---- 1. apt 装三件套（已齐全则整体跳过，避免重复 update 拉索引）----
if command -v node >/dev/null 2>&1 && command -v initdb >/dev/null 2>&1 && command -v redis-server >/dev/null 2>&1; then
  log "三件套已安装，跳过 apt"
else
  log "安装 PostgreSQL / Redis / Node（Termux 原生包）..."
  apt-get update -qq 2>&1 | tail -3
  if ! command -v node >/dev/null 2>&1; then
    apt-get install -y -qq postgresql redis nodejs-lts 2>&1 | tail -10 || \
    apt-get install -y -qq postgresql redis nodejs 2>&1 | tail -10 || die "apt 安装失败"
  else
    apt-get install -y -qq postgresql redis 2>&1 | tail -8 || die "apt 安装失败"
  fi
fi
log "版本: node=$(node -v 2>/dev/null) PG=$(pg_config --version 2>/dev/null) redis=$(redis-server --version 2>/dev/null)"

# ---- 2. 初始化 PostgreSQL ----
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  log "initdb → $PGDATA"
  initdb -D "$PGDATA" -A trust -U mpk 2>&1 | tail -6 || die "initdb 失败"
fi
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  log "启动 PostgreSQL..."
  pg_ctl -D "$PGDATA" -l "$LOGD/pg.log" -o "-h 127.0.0.1 -p 5432" start 2>&1 | tail -5 || die "PG 启动失败"
fi
pg_isready -h 127.0.0.1 -p 5432 && log "PG ready"

psql -h 127.0.0.1 -U mpk -d postgres -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw monsterpk || \
  createdb -h 127.0.0.1 -U mpk monsterpk 2>&1 | tail -2
log "DB monsterpk ready"

# ---- 3. 启动 Redis ----
if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  log "启动 Redis..."
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$HOME_DIR" 2>&1 | tail -3
fi
redis-cli -h 127.0.0.1 -p 6379 ping && log "Redis ready"

# ---- 4. 部署后端源码 ----
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
log "npm install（首次较慢）..."
cd "$BACKEND" || die "cd backend 失败"
# npm 12 安全策略：EALLOWREMOTE 拒绝 lock 里指向 registry.npmmirror.com 的远程 tgz；
# 且默认用 allowScripts 白名单阻止 prisma/esbuild 等包的 install scripts。
# 本机自测环境可控，显式全放行。
# - allow-remote=all 用环境变量
# - install scripts 用 npm 12 的 `npm install-scripts approve --all` 批准后 rebuild
export NPM_CONFIG_ALLOW_REMOTE=all
npm install --no-audit --no-fund 2>&1 | tail -8 || die "npm install 失败"
npm install-scripts approve --all 2>&1 | tail -6 || true
npm rebuild 2>&1 | tail -8 || true
log "prisma 命令: $(command -v prisma || echo '走 npx')"

log "prisma generate + migrate deploy..."
# Termux 上 npx 12 解析本地 bin 有异常（prisma: not found），直接用 node_modules/.bin
PRISMA="$BACKEND/node_modules/.bin/prisma"
[ -x "$PRISMA" ] || die "prisma 二进制不存在: $PRISMA"
"$PRISMA" generate 2>&1 | tail -10 || die "prisma generate 失败"
"$PRISMA" migrate deploy 2>&1 | tail -14 || die "prisma migrate 失败"

# ---- 6. 起后端 ----
log "启动后端..."
pkill -f 'tsx src/index.ts' 2>/dev/null || true
TSX="$BACKEND/node_modules/.bin/tsx"
[ -x "$TSX" ] || die "tsx 二进制不存在: $TSX"
nohup "$TSX" src/index.ts > "$LOGD/backend.log" 2>&1 &
sleep 6
curl -s -m 5 -o /dev/null -w "HEALTH=%{http_code}\n" http://127.0.0.1:3001/api/health || echo "HEALTH=fail"
log "后端日志: $LOGD/backend.log"
echo "=== DEPLOY_NATIVE_DONE ==="
