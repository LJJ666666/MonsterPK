#!/usr/bin/env bash
# ============================================================================
# mobile-server / setup-termux.sh —— 在雷电模拟器（Android14 x86_64，无 root）内运行
# 目标：Termux → proot Debian(x86_64) → PostgreSQL16 + Redis + Node → 部署后端 → 起服务
# 前置：Termux 已装、已换源；backend-src.tar.gz 已 push 到 $HOME/storage/shared/mpk/
# 幂等：重复执行安全（已装的跳过、已初始化的库不重建）
# ============================================================================
set -uo pipefail
log() { echo "[ms] $*"; }
die() { echo "[ms] ERROR: $*" >&2; exit 1; }

SHARE="$HOME/storage/shared/mpk"       # adb push 落地目录（Termux 可见的共享存储）
PKG="$SHARE/backend-src.tar.gz"
DEB="$HOME/ms-debian"                   # proot Debian rootfs
BACKEND="$HOME/backend"                 # 后端源码（Debian 内挂载点用绝对路径）
CFG="$HOME/.ms_config"

# ---- 1. 前置检查 ----
command -v proot-distro >/dev/null 2>&1 || log "proot-distro 未装（脚本会尝试装）"
[ -f "$PKG" ] || die "找不到后端包 $PKG —— 请先 adb push"
arch=$(uname -m); log "arch=$arch (期望 x86_64)"
[ "$arch" = "x86_64" ] || log "WARN: 非 x86_64，PG/Node 二进制需对应架构"

# ---- 2. 装 proot-distro + Debian ----
if ! command -v proot-distro >/dev/null 2>&1; then
  log "安装 proot-distro..."; pkg install -y proot-distro || die "proot-distro 安装失败"
fi
if ! proot-distro list 2>/dev/null | grep -q '^debian'; then
  log "安装 Debian rootfs（约 100MB）..."; proot-distro install debian || die "Debian 安装失败"
fi
log "proot Debian 就绪"

# ---- 3. Debian 内装 PG / Redis / Node ----
# proot-distro login 支持 --user root；用一次性脚本执行，避免交互。
BOOTSTRAP="$HOME/ms-bootstrap.sh"
cat > "$BOOTSTRAP" <<'EOS'
#!/usr/bin/env bash
set -uo pipefail
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq || exit 11
# PG16：Debian bookworm 默认 PG15；但 schema 用通用特性，PG15 可跑本项目迁移。
apt-get install -y -qq postgresql postgresql-client redis-server curl ca-certificates || exit 12
# Node 20 LTS（用 nodesource 或系统源；Debian bookworm 自带 node 18，本项目需 22/20）。
if ! command -v node >/dev/null 2>&1 || [ "$(node -v | cut -d. -f1)" -lt 20 ]; then
  curl -fsSL https://deb.nodesource.com/setup_20.x | bash - >/dev/null 2>&1 || true
  apt-get install -y -qq nodejs || exit 13
fi
echo "NODE=$(node -v 2>/dev/null) PG=$(pg_config --version 2>/dev/null) REDIS=$(redis-server --version 2>/dev/null | cut -d= -f2 | cut -d' ' -f1)"
EOS
chmod +x "$BOOTSTRAP"
# 把脚本放进 Debian 可见路径（$HOME 在 proot 内映射到 /root 或 home）
log "Debian 内安装 PostgreSQL / Redis / Node（首次约 2-5 分钟）..."
proot-distro login debian -- bash "$BOOTSTRAP" || die "Debian 引导安装失败"
cp "$BOOTSTRAP" "$SHARE/bootstrap-result.log" 2>/dev/null || true

# ---- 4. 部署后端源码 ----
log "部署后端源码到 $BACKEND ..."
mkdir -p "$BACKEND"
tar -xzf "$PKG" -C "$BACKEND" || die "解压后端包失败"
# 从 Termux 视角把后端路径写进配置（proot 内 $BACKEND 映射到同一 $HOME/backend）
echo "BACKEND=$BACKEND" > "$CFG"

# ---- 5. Debian 内：初始化 PG + npm install + prisma migrate + 起服务 ----
DEPLOY="$HOME/ms-deploy.sh"
cat > "$DEPLOY" <<'EOS'
#!/usr/bin/env bash
set -uo pipefail
cd "$HOME/backend" || exit 21
# PG 初始化（proot 无 systemd，手工起）
PGDATA="/var/lib/postgresql/15/main"
[ -d "$PGDATA" ] || PGDATA=$(find /var/lib/postgresql -name main -type d 2>/dev/null | head -1)
if [ -z "$PGDATA" ] || [ ! -f "$PGDATA/PG_VERSION" ]; then
  PGDATA="/var/lib/postgresql/data"
  mkdir -p "$PGDATA"; chown -R postgres:postgres "$PGDATA"
  su postgres -c "/usr/lib/postgresql/*/bin/initdb -D $PGDATA -A trust" || exit 22
fi
# 起 PG（若未运行）
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  su postgres -c "/usr/lib/postgresql/*/bin/pg_ctl -D $PGDATA -l /tmp/pg.log -o '-h 127.0.0.1 -p 5432' start" || exit 23
fi
# 建库/用户（幂等）
su postgres -c "psql -h 127.0.0.1 -c \"DO \\\$\\\$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname='mpk') THEN CREATE ROLE mpk LOGIN; END IF; END \\\$\\\$;\"" || true
su postgres -c "psql -h 127.0.0.1 -lqt" | cut -d'|' -f1 | grep -qw monsterpk || su postgres -c "createdb -h 127.0.0.1 -O mpk monsterpk" || true
echo "[deploy] PG ready"
# Redis
redis-server --daemonize yes --bind 127.0.0.1 --port 6379 2>/dev/null || true
echo "[deploy] Redis ready"
# Node 依赖 + Prisma（debian-openssl 引擎自动下载）
[ -d node_modules ] || npm install --no-audit --no-fund || exit 24
npx prisma generate || exit 25
npx prisma migrate deploy || exit 26
echo "[deploy] prisma ready"
# 起后端（后台，日志落文件）
pkill -f 'tsx watch src/index.ts' 2>/dev/null || true
nohup npx tsx src/index.ts > /tmp/mpk-backend.log 2>&1 &
echo "[deploy] backend started pid=$!"
sleep 3
curl -s -m 5 -o /dev/null -w "HEALTH=%{http_code}\n" http://127.0.0.1:3001/api/health || echo "HEALTH=fail"
EOS
chmod +x "$DEPLOY"
log "Debian 内初始化 PG/Redis/Prisma 并起后端..."
proot-distro login debian -- bash "$DEPLOY" 2>&1 | tee "$SHARE/deploy.log" || die "部署失败（见 $SHARE/deploy.log）"

log "=========================================="
log "完成。游戏 APK 打开 → 任意账号登录 → 打一场验证。"
log "后端日志：进入 proot-distro login debian 后 tail -f /tmp/mpk-backend.log"
