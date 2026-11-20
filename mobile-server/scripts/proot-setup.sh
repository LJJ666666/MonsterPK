#!/data/data/com.termux/files/usr/bin/bash
# ============================================================================
# mobile-server / proot-setup.sh —— Termux 侧执行（stage 1）
# 装 proot-distro + Debian rootfs，并把 stage2 脚本准备到共享目录。
# 前置：Termux 已 bootstrap、已换源；backend-src.tar.gz 已 push 到 $HOME/storage/shared/mpk/
# 用法：run-as com.termux <termux-bash> -s < /sdcard/mpk/proot-setup.sh
# ============================================================================
set -uo pipefail
export PREFIX=/data/data/com.termux/files/usr
export PATH="$PREFIX/bin:$PATH"
export HOME=/data/data/com.termux/files/home
SHARE="$HOME/storage/shared/mpk"
LOGD="$HOME/logs"
mkdir -p "$LOGD"
exec > >(tee -a "$LOGD/proot-setup.log") 2>&1
log() { echo "[ms] $*"; }
die() { echo "[ms] ERROR: $*"; exit 1; }

echo "=== proot-setup @ $(date) ==="
log "uid=$(id -u) arch=$(uname -m)"
[ -f "$SHARE/backend-src.tar.gz" ] || die "后端包不存在: $SHARE/backend-src.tar.gz"

# 1. 装 proot-distro
if ! command -v proot-distro >/dev/null 2>&1; then
  log "安装 proot-distro..."
  pkg install -y proot-distro 2>&1 | tail -8 || die "proot-distro 安装失败"
else
  log "proot-distro 已装"
fi

# 2. 装 Debian rootfs（~100MB，慢）
if ! proot-distro list 2>/dev/null | grep -qi '^debian'; then
  log "安装 Debian rootfs（约 100MB，耐心等）..."
  proot-distro install debian 2>&1 | tail -20 || die "Debian rootfs 安装失败"
else
  log "Debian rootfs 已装"
fi
log "proot Debian 状态:"
proot-distro list 2>&1 | head -10

# 3. 校验 stage2 脚本已在共享目录
[ -f "$SHARE/proot-deploy.sh" ] || die "缺少 $SHARE/proot-deploy.sh —— 请先 push"
log "stage2 脚本就绪: $SHARE/proot-deploy.sh"
echo "=== PROOT_SETUP_DONE ==="
