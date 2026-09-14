#!/usr/bin/env bash
# 產生 Chrome Web Store 的宣傳圖塊。
#
# 來源是 docs/store/src/promo-tile.html —— 用 headless Chrome 以 2 倍解析度
# 算圖再縮回目標尺寸，文字邊緣比直接畫在 440×280 上乾淨得多。
#
#   ./scripts/build-promo-tile.sh            # 小型圖塊 440×280
#   ./scripts/build-promo-tile.sh marquee    # 大型圖塊 1400×560
#
# 小型圖塊是商店列表用的，大型圖塊只有想被編輯精選時才需要。

set -euo pipefail

cd "$(dirname "$0")/.."

PRESET=${1:-small}
case $PRESET in
  small)   W=440;  H=280; SCALE=1 ;;
  marquee) W=1400; H=560; SCALE=2 ;;   # 高度只有 2 倍，寬的部分留白
  *) echo "未知的尺寸：$PRESET（可用 small / marquee）" >&2; exit 1 ;;
esac

CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
[[ -x $CHROME ]] || { echo "找不到 Chrome：$CHROME" >&2; exit 1; }

SRC=docs/store/src/promo-tile.html
DST=docs/store/promo-${W}x${H}.png

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

# 版面尺寸從外部覆寫 —— 後出現的 <style> 會蓋掉來源檔的 :root 預設值，
# 這樣兩種尺寸就能共用同一份版面，不必維護兩個檔案
{
  cat "$SRC"
  printf '<style>:root{--w:%dpx;--h:%dpx;--scale:%s}</style>\n' "$W" "$H" "$SCALE"
} > "$TMP/tile.html"

"$CHROME" --headless --disable-gpu --hide-scrollbars \
  --force-device-scale-factor=2 \
  --window-size="$W,$H" \
  --screenshot="$TMP/2x.png" \
  "file://$TMP/tile.html" >/dev/null 2>&1

[[ -f $TMP/2x.png ]] || { echo "Chrome 沒有產出圖檔" >&2; exit 1; }

sips -z "$H" "$W" "$TMP/2x.png" --out "$DST" >/dev/null 2>&1

read -r OW OH < <(sips -g pixelWidth -g pixelHeight "$DST" |
  awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')

if [[ $OW == "$W" && $OH == "$H" ]]; then
  echo "✔ ${DST}（${OW}×${OH}）"
else
  echo "✘ 尺寸不對：${OW}×${OH}，預期 ${W}×${H}" >&2
  exit 1
fi
