#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# mobile-server / device-setup.sh —— 真机 arm64 一次性部署（在 Termux 内执行）
#
# 架构拓扑（与雷电 proot-deploy3 路线一致，已取证）：
#   Termux 原生：PostgreSQL(5432) + Redis(6379)   ← Bionic 原生包，arm64 直接可用
#   proot Debian：Node20(glibc) + Prisma + 后端(3001) ← engine 是 glibc 二进制
#   两者通过 127.0.0.1 互通（proot 共享宿主网络命名空间）
#
# 前置：
#   1) Termux（GitHub 版 arm64-v8a）已装、已 termux-setup-storage
#   2) /sdcard/mpk/ 下已有：backend-src.tar.gz、node-v20.19.2-linux-arm64.tar.xz、
#      debian-trixie-aarch64-pd-v4.29.0.tar.xz（宿主机 install-device.sh 会 push）
#   3) 已换国内源（termux-change-repo），保证 pkg/apt 可用
#
# 用法：在 Termux 里  bash /sdcard/mpk/device-setup.sh
# 幂等：重复执行安全（已装跳过、已初始化不重建）。
# 后续日常启动用 device-start.sh（本脚本只做一次性部署 + 首次验证）。
# ============================================================================
set -uo pipefail
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
SHARE=/sdcard/mpk
LOGD="$HOME/logs"
mkdir -p "$LOGD"
exec > >(tee -a "$LOGD/device-setup.log") 2>&1
log() { echo "[ms] $*"; }
die() { echo "[ms] ERROR: $*"; exit 1; }

echo "=== device-setup @ $(date) ==="
ARCH=$(uname -m)
log "arch=$ARCH uid=$(id -u) prefix=$PREFIX"
[ "$ARCH" = "aarch64" ] || die "本脚本仅用于 arm64 真机，当前 arch=$ARCH（x86_64 请用雷电那套）"

NODE_TAR="$SHARE/node-v20.19.2-linux-arm64.tar.xz"
DEB_TAR="$SHARE/debian-trixie-aarch64-pd-v4.29.0.tar.xz"
PKG="$SHARE/backend-src.tar.gz"
for f in "$NODE_TAR" "$DEB_TAR" "$PKG"; do
  [ -f "$f" ] || die "缺少 $f —— 请先在宿主机跑 install-device.sh 推送"
done

# ---- 1. Termux 层工具（proot-distro + tmux 保活）----
if ! command -v proot-distro >/dev/null 2>&1 || ! command -v tmux >/dev/null 2>&1; then
  log "pkg install proot-distro tmux ..."
  pkg install -y proot-distro tmux 2>&1 | tail -8 || die "pkg 安装失败（检查换源：termux-change-repo）"
fi
log "proot-distro=$(command -v proot-distro) tmux=$(command -v tmux)"

# ---- 2. Termux 原生 PostgreSQL + Redis ----
if ! command -v initdb >/dev/null 2>&1 || ! command -v redis-server >/dev/null 2>&1; then
  log "安装 Termux 原生 postgresql / redis ..."
  pkg install -y postgresql redis 2>&1 | tail -10 || die "PG/Redis 安装失败"
fi
PGDATA="$HOME/pgdata"
if [ ! -f "$PGDATA/PG_VERSION" ]; then
  log "initdb → $PGDATA"
  initdb -D "$PGDATA" -A trust -U mpk 2>&1 | tail -6 || die "initdb 失败"
fi
if ! pg_isready -h 127.0.0.1 -p 5432 >/dev/null 2>&1; then
  log "启动 PostgreSQL ..."
  pg_ctl -D "$PGDATA" -l "$LOGD/pg.log" -o "-h 127.0.0.1 -p 5432" start 2>&1 | tail -5 || die "PG 启动失败"
fi
pg_isready -h 127.0.0.1 -p 5432 && log "PG ready"
psql -h 127.0.0.1 -U mpk -d postgres -lqt 2>/dev/null | cut -d'|' -f1 | grep -qw monsterpk || \
  createdb -h 127.0.0.1 -U mpk monsterpk 2>&1 | tail -2
log "DB monsterpk ready"

if ! redis-cli -h 127.0.0.1 -p 6379 ping >/dev/null 2>&1; then
  redis-server --daemonize yes --bind 127.0.0.1 --port 6379 --dir "$HOME" 2>&1 | tail -3
fi
redis-cli -h 127.0.0.1 -p 6379 ping && log "Redis ready"

# ---- 3. 安装 proot Debian（从本地 aarch64 rootfs，避免网络拉镜像）----
if ! proot-distro list 2>/dev/null | grep -qi '^debian'; then
  log "安装 Debian(aarch64) rootfs（本地包，约 35MB）..."
  # 拷到 Termux 私有目录再装，规避 /sdcard 映射刷新问题
  cp "$DEB_TAR" "$HOME/debian-trixie-aarch64.tar.xz"
  xz -t "$HOME/debian-trixie-aarch64.tar.xz" 2>&1 && log "rootfs xz 校验 OK" || die "rootfs 损坏"
  if ! proot-distro install -n debian "$HOME/debian-trixie-aarch64.tar.xz" 2>&1 | tail -8; then
    log "本地 rootfs 安装失败，退回在线安装（arm64 自动选架构）..."
    proot-distro install debian 2>&1 | tail -8 || die "proot Debian 安装失败（本地+在线都失败）"
  fi
fi
log "proot Debian 就绪：$(proot-distro list 2>/dev/null | grep -i debian)"

# ---- 4. proot Debian 内：Node(glibc) + 后端 + Prisma ----
BOOT="$HOME/device-debian-bootstrap.sh"
cat > "$BOOT" <<'EOS'
#!/usr/bin/env bash
set -uo pipefail
SHARE=/sdcard/mpk
NODEROOT=/opt/node-v20
BACKEND=/opt/backend
echo "[debian] start $(date) uid=$(id -u) arch=$(uname -m)"

# Node（手工解压 arm64 glibc 官方包，apt 那条路会拖 210+ 包且易失败）
if [ ! -x "$NODEROOT/bin/node" ]; then
  echo "[debian] 解压 Node arm64 → $NODEROOT"
  mkdir -p "$NODEROOT"
  tar -xJf "$SHARE/node-v20.19.2-linux-arm64.tar.xz" -C "$NODEROOT" --strip-components=1 2>&1 | tail -3 || exit 11
fi
export PATH="$NODEROOT/bin:$PATH"
NODE="$NODEROOT/bin/node"
NPM="$NODEROOT/bin/npm"
echo "[debian] node=$($NODE -v) npm=$($NPM -v 2>/dev/null) openssl=$($NODE -e 'console.log(process.versions.openssl)' 2>/dev/null)"

# 后端源码
echo "[debian] 解压后端 → $BACKEND"
rm -rf "$BACKEND"; mkdir -p "$BACKEND"
tar -xzf "$SHARE/backend-src.tar.gz" -C "$BACKEND" 2>&1 | tail -3 || exit 12
[ -f "$BACKEND/package.json" ] || exit 13
cat > "$BACKEND/.env" <<'ENVEOF'
DATABASE_URL="postgresql://mpk@127.0.0.1:5432/monsterpk?schema=public"
REDIS_URL="redis://127.0.0.1:6379"
JWT_SECRET="mobile-server-local-self-test-secret-32chars"
JWT_TTL="30d"
PORT=3001
CORS_ORIGIN="http://localhost:5173,http://127.0.0.1:5173,http://localhost,https://localhost,capacitor://localhost"
ADMIN_USERNAMES=""
ENVEOF

cd "$BACKEND" || exit 14
export NPM_CONFIG_ALLOW_REMOTE=all
export NPM_CONFIG_REGISTRY=https://registry.npmmirror.com
echo "[debian] npm install ..."
$NPM install --no-audit --no-fund 2>&1 | tail -10 || exit 15

echo "[debian] prisma generate ..."
PRISMA_JS="$BACKEND/node_modules/prisma/build/index.js"
[ -f "$PRISMA_JS" ] || { echo "[debian] prisma 入口缺失"; exit 16; }
$NODE "$PRISMA_JS" generate 2>&1 | tail -10 || exit 17
ls "$BACKEND/node_modules/.prisma/client/" 2>/dev/null | grep -i 'arm64' && echo "[debian] engine=arm64 OK" || echo "[debian] WARN 未见 arm64 engine"

echo "[debian] prisma migrate deploy ..."
$NODE "$PRISMA_JS" migrate deploy 2>&1 | tail -14 || exit 18

echo "[debian] bootstrap OK"
EOS
chmod +x "$BOOT"
log "proot Debian 内安装 Node + npm + Prisma（首次约 3-8 分钟，proot ptrace 较慢）..."
# 用 stdin 传脚本（bash -s），不依赖 proot 内对 Termux $HOME 路径的可见性
proot-distro login debian -- bash -s < "$BOOT" 2>&1 | tee "$LOGD/device-bootstrap.log" || die "Debian bootstrap 失败（见 $LOGD/device-bootstrap.log）"

# ---- 5. 首次启动验证（前台 exec 由 device-start.sh 的 tmux 会话持有）----
log "部署完成。接下来在 Termux 里执行：bash /sdcard/mpk/device-start.sh"
log "（device-start.sh 会起 PG/Redis + tmux 会话跑后端 + wake-lock）"
echo "=== DEVICE_SETUP_DONE ==="
