#!/usr/bin/env bash
# ============================================================================
# mobile-server / install-device.sh —— 宿主机（Git Bash）执行
# 把 arm64 三件套 + 游戏 APK + 全部 device 脚本装进真机（vivo Android 16）
#
# 前置：
#   1) 手机开 USB 调试，数据线连 PC（或 adb connect 无线调试 IP:端口）
#   2) 已跑 fetch-arm64.sh（output/ 下有 arm64 三件套）
#   3) 已跑 build-game-apk.mjs（output/monsterpk-debug.apk，真后端版）
#
# env: MPK_ADB 覆盖 adb 路径（默认探测常见位置）。
# 幂等：adb install -r 覆盖安装。
# ============================================================================
set -uo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
OUT="$BASE/output"

# adb 路径：env 覆盖 → 常见位置探测 → PATH
ADB="${MPK_ADB:-}"
if [ -z "$ADB" ]; then
  for c in "/d/game/leidian/LDPlayer14/adb.exe" "$BASE/../platform-tools/adb.exe" "/e/Six/platform-tools/adb.exe"; do
    [ -x "$c" ] && { ADB="$c"; break; }
  done
fi
[ -z "$ADB" ] && ADB="adb"
command -v "$ADB" >/dev/null 2>&1 || { echo "[ms] ERROR: 找不到 adb，请设 MPK_ADB"; exit 1; }

echo "[ms] adb=$(command -v "$ADB")"
echo "[ms] 设备列表："
"$ADB" devices
DEVICE_COUNT=$("$ADB" devices | grep -c $'\tdevice')
[ "$DEVICE_COUNT" -ge 1 ] || { echo "[ms] ERROR: 无已连接设备"; exit 1; }

# 1. 装两个 App
for apk in "$OUT/termux-arm64-v8a.apk" "$OUT/monsterpk-debug.apk"; do
  [ -f "$apk" ] || { echo "[ms] ERROR: 缺 $apk"; exit 1; }
  echo "[ms] 安装 $(basename "$apk") ..."
  "$ADB" install -r "$apk" || { echo "[ms] ERROR: 安装失败 $apk"; exit 1; }
done

# 2. push 三件套 + 后端包
echo "[ms] push 交付物到 /sdcard/mpk/ ..."
"$ADB" shell mkdir -p /sdcard/mpk
for f in backend-src.tar.gz node-v20.19.2-linux-arm64.tar.xz debian-trixie-aarch64-pd-v4.29.0.tar.xz; do
  [ -f "$OUT/$f" ] || { echo "[ms] ERROR: 缺 $OUT/$f（先跑 fetch-arm64.sh / pack-backend.mjs）"; exit 1; }
  echo "[ms] push $f ($(stat -c %s "$OUT/$f") B) ..."
  "$ADB" push "$OUT/$f" "/sdcard/mpk/$f" || exit 1
done

# 3. push 全部真机脚本
echo "[ms] push device 脚本 ..."
for s in device-setup.sh device-start.sh device-guardian.sh device-check.sh device-stop.sh; do
  "$ADB" push "$BASE/scripts/$s" "/sdcard/mpk/$s" || exit 1
done

# 4. 拉起 Termux
echo "[ms] 启动 Termux ..."
"$ADB" shell am force-stop com.monster.game >/dev/null 2>&1 || true
"$ADB" shell am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1 || true

echo "============================================================"
echo "[ms] 完成。接下来在手机 Termux 里依次执行："
echo "     1) termux-setup-storage        # 首次授权存储"
echo "     2) termux-change-repo          # 换国内源（可选但推荐）"
echo "     3) bash /sdcard/mpk/device-setup.sh   # 一次性部署"
echo "     4) bash /sdcard/mpk/device-start.sh   # 起服务"
echo "     5) bash /sdcard/mpk/device-check.sh   # 自检 health=200"
echo "[ms] 详见 DEVICE.md（vivo Android 16 保活设置也在里面）。"
