#!/usr/bin/env bash
# 把隨手截的圖轉成 Chrome Web Store 接受的尺寸。
#
# 商店只收 1280×800 或 640×400，差一個 pixel 就退件。這支腳本先等比縮到
# 放得進畫布，再補邊到剛好的尺寸 —— 不裁切、不變形。
#
#   ./scripts/make-store-screenshot.sh 輸入.png 輸出.png [寬 高] [補邊色]
#
# 例：
#   ./scripts/make-store-screenshot.sh ~/Desktop/shot.png docs/store/01.png
#   ./scripts/make-store-screenshot.sh shot.png out.png 640 400 FFFFFF

set -euo pipefail

SRC=${1:?用法: $0 <輸入圖> <輸出圖> [寬 高] [補邊色 RRGGBB]}
DST=${2:?用法: $0 <輸入圖> <輸出圖> [寬 高] [補邊色 RRGGBB]}
TARGET_W=${3:-1280}
TARGET_H=${4:-800}
PAD=${5:-0f0f10}   # 清單頁的底色，深色截圖補起來看不出接縫

[[ -f $SRC ]] || { echo "找不到檔案：$SRC" >&2; exit 1; }

read -r W H < <(sips -g pixelWidth -g pixelHeight "$SRC" |
  awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')

echo "來源：${W}×${H}  →  目標：${TARGET_W}×${TARGET_H}"

mkdir -p "$(dirname "$DST")"
TMP=$(mktemp -t lexicap-shot).png
trap 'rm -f "$TMP"' EXIT
cp "$SRC" "$TMP"

# 只在超出畫布時縮小。放大會糊，寧可補邊
if (( W > TARGET_W || H > TARGET_H )); then
  # 用整數運算比較 W/H 與 TARGET_W/TARGET_H，挑限制較緊的那一邊當基準
  if (( W * TARGET_H > H * TARGET_W )); then
    NEW_W=$TARGET_W
    NEW_H=$(( H * TARGET_W / W ))
  else
    NEW_H=$TARGET_H
    NEW_W=$(( W * TARGET_H / H ))
  fi
  echo "縮放至：${NEW_W}×${NEW_H}"
  sips -z "$NEW_H" "$NEW_W" "$TMP" --out "$TMP" >/dev/null
fi

# sips 的 -p 是「補邊到」，不是裁切 —— 上一步已保證圖不會比畫布大
sips -p "$TARGET_H" "$TARGET_W" --padColor "$PAD" "$TMP" --out "$DST" >/dev/null 2>&1

read -r OW OH < <(sips -g pixelWidth -g pixelHeight "$DST" |
  awk '/pixelWidth/{w=$2} /pixelHeight/{h=$2} END{print w, h}')

if [[ $OW == "$TARGET_W" && $OH == "$TARGET_H" ]]; then
  echo "✔ ${DST}（${OW}×${OH}）"
else
  echo "✘ 尺寸不對：${OW}×${OH}，預期 ${TARGET_W}×${TARGET_H}" >&2
  exit 1
fi
