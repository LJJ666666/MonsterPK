#!/usr/bin/env bash
# 分段下载 Termux x86_64 APK（GitHub blob 直链限速 ~80KB/s，单连接易超时）。
# 用法：bash scripts/fetch-termux.sh <signed-url-file> <out.apk>
set -euo pipefail
URL_FILE="${1:?usage: fetch-termux.sh <url-file> <out>}"
OUT="${2:?usage: fetch-termux.sh <url-file> <out>}"
LOC=$(grep -i '^location:' "$URL_FILE" | sed 's/^[Ll]ocation: //' | tr -d '\r')
CHUNK=$((1024*1024))          # 1MB 每片
TOTAL=35189933                # v0.118.3 x86_64 精确字节数（来自 GitHub API size）
TMPDIR="$(dirname "$OUT")/.termux_parts"
mkdir -p "$TMPDIR"
n=0
start=0
echo "total=$TOTAL chunk=$CHUNK" >&2
while [ "$start" -lt "$TOTAL" ]; do
  end=$((start + CHUNK - 1))
  [ "$end" -ge "$TOTAL" ] && end=$((TOTAL - 1))
  part="$TMPDIR/part.$(printf '%04d' "$n")"
  if [ -f "$part" ] && [ "$(stat -c %s "$part" 2>/dev/null || echo 0)" -eq "$((end - start + 1))" ]; then
    echo "[$n] cached $((end-start+1))B" >&2
  else
    ok=0
    for attempt in 1 2 3; do
      if curl -sL -r "${start}-${end}" -m 90 -o "$part" "$LOC" && \
         [ "$(stat -c %s "$part" 2>/dev/null || echo 0)" -eq "$((end - start + 1))" ]; then
        ok=1; break
      fi
      echo "[$n] attempt $attempt failed, retry" >&2
    done
    [ "$ok" -eq 1 ] || { echo "FAILED chunk $n" >&2; exit 1; }
    echo "[$n] got $((end-start+1))B" >&2
  fi
  start=$((end + 1))
  n=$((n + 1))
done
cat "$TMPDIR"/part.* > "$OUT"
SIZE=$(stat -c %s "$OUT")
echo "merged=$SIZE" >&2
[ "$SIZE" -eq "$TOTAL" ] || { echo "SIZE MISMATCH expected $TOTAL got $SIZE" >&2; exit 1; }
echo "TERMUX_DOWNLOADED_OK" >&2
