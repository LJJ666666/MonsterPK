#!/usr/bin/env bash
# ============================================================================
# mobile-server / fetch-arm64.sh —— 宿主机执行，下载真机 arm64 三件套
#   Termux arm64-v8a APK + Node linux-arm64 + Debian trixie aarch64 rootfs
# 单连接断点续传 + 大小校验；GitHub 走 ghfast 镜像，Node 走 npmmirror。
# env: MPK_OUT 覆盖输出目录；MPK_GH_MIRROR 覆盖 GitHub 镜像前缀。
# 幂等：已存在且大小一致的包直接跳过。
# ============================================================================
set -uo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
OUT="${MPK_OUT:-$(cd "$HERE/.." && pwd)/output}"
MIRROR="${MPK_GH_MIRROR:-https://ghfast.top/https://github.com}"
mkdir -p "$OUT"
cd "$OUT"

fetch() {  # name url expected_size
  local name="$1" url="$2" want="$3" got
  if [ -f "$name" ]; then
    got=$(stat -c %s "$name" 2>/dev/null || echo 0)
    if [ "$got" = "$want" ]; then echo "[skip] $name ($got B)"; return 0; fi
    echo "[redo] $name size $got != $want, re-download"
    rm -f "$name"
  fi
  echo "[get ] $name <- $url"
  curl -fL --retry 5 --retry-delay 2 -C - -o "$name" "$url" || { echo "[FAIL] curl $name"; return 1; }
  got=$(stat -c %s "$name" 2>/dev/null || echo 0)
  if [ "$got" != "$want" ]; then echo "[FAIL] $name size $got != $want"; return 1; fi
  echo "[ ok ] $name ($got B)"
}

fetch "termux-arm64-v8a.apk" \
  "$MIRROR/termux/termux-app/releases/download/v0.118.3/termux-app_v0.118.3%2Bgithub-debug_arm64-v8a.apk" \
  35106607 || exit 1

fetch "node-v20.19.2-linux-arm64.tar.xz" \
  "https://registry.npmmirror.com/-/binary/node/v20.19.2/node-v20.19.2-linux-arm64.tar.xz" \
  25114376 || exit 1

fetch "debian-trixie-aarch64-pd-v4.29.0.tar.xz" \
  "$MIRROR/termux/proot-distro/releases/download/v4.29.0/debian-trixie-aarch64-pd-v4.29.0.tar.xz" \
  35409704 || exit 1

echo "=== 校验 APK 签名头 / tar.xz 魔数 ==="
python - <<'PY'
import os
base = os.getcwd()
apk = os.path.join(base, "termux-arm64-v8a.apk")
with open(apk, "rb") as f:
    head = f.read(4)
print("APK magic:", head.hex(), "PK\\x03\\x04=ok" if head == b"PK\x03\x04" else "BAD")
for f in ("node-v20.19.2-linux-arm64.tar.xz", "debian-trixie-aarch64-pd-v4.29.0.tar.xz"):
    with open(os.path.join(base, f), "rb") as fh:
        m = fh.read(6)
    print(f, "magic:", m.hex(), "ok" if m == b"\xfd7zXZ\x00" else "BAD")
PY
echo "=== ARM64_ASSETS_DONE ==="
