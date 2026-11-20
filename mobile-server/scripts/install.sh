#!/usr/bin/env bash
# ============================================================================
# mobile-server / install.sh —— 宿主机（Windows Git Bash）执行
# 把两个 APK 装进雷电 + push 后端包进模拟器 + 启动 Termux
# 之后在 Termux 里手动跑 setup-termux.sh（一条命令，见 README）
# env: MPK_ADB 覆盖 adb 路径
# ============================================================================
set -uo pipefail
BASE="$(cd "$(dirname "$0")/.." && pwd)"
ADB="${MPK_ADB:-/d/game/leidian/LDPlayer14/adb.exe}"
[ -x "$ADB" ] || ADB="adb"
command -v "$ADB" >/dev/null 2>&1 || { echo "找不到 adb，请设 MPK_ADB"; exit 1; }

echo "[ms] 设备列表："; "$ADB" devices

for apk in "$BASE/output/termux-x86_64.apk" "$BASE/output/monsterpk-debug.apk"; do
  [ -f "$apk" ] || { echo "[ms] 缺少 $apk"; exit 1; }
  echo "[ms] 安装 $(basename "$apk") ..."
  "$ADB" install -r "$apk" || { echo "[ms] 安装失败：$apk"; exit 1; }
done

echo "[ms] push 后端包与脚本到模拟器共享存储 ..."
"$ADB" shell mkdir -p /sdcard/mpk
"$ADB" push "$BASE/output/backend-src.tar.gz" /sdcard/mpk/backend-src.tar.gz
"$ADB" push "$BASE/scripts/setup-termux.sh" /sdcard/mpk/setup-termux.sh

echo "[ms] 关掉游戏（避免占前台），启动 Termux ..."
"$ADB" shell am force-stop com.monster.game
"$ADB" shell am start -n com.termux/.app.TermuxActivity >/dev/null 2>&1 || true

echo "============================================================"
echo "[ms] 完成。接下来在雷电里的 Termux 窗口执行："
echo "     cp /sdcard/mpk/* \$HOME/ 2>/dev/null; cp /sdcard/mpk/* ~/"
echo "     bash ~/setup-termux.sh"
echo "[ms] 或者逐条按 README『手机内操作』章节执行。"
