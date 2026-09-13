#!/usr/bin/env python3
"""
產生擴充圖示。

設計概念：Lexicap = Lexicon + Caption + Capture
  → 畫面直接呈現那個動作：**從字幕條上把一個詞拎起來**。
    下方兩條白色字幕條，上方一塊琥珀色的詞被抬起來。

為什麼不用 Netflix 紅：擴充不該在視覺上看起來像 Netflix 官方出品
（商標與 Chrome Web Store 政策）。琥珀色也更貼近「螢光筆標記」的語意。

用法：python3 scripts/build-icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

OUT = os.path.join(os.path.dirname(__file__), '..', 'public', 'icon')
SIZES = [16, 32, 48, 96, 128]
SS = 8  # 超取樣倍率，先畫大再縮，邊緣才平滑

BG_TOP, BG_BOTTOM = (32, 32, 46), (13, 13, 20)
BAR = (238, 238, 244)
AMBER_TOP, AMBER_BOTTOM = (255, 186, 46), (247, 148, 29)
SHADOW = (0, 0, 0, 115)


def vertical_gradient(size, top, bottom):
    img = Image.new('RGB', (1, size))
    for y in range(size):
        t = y / max(size - 1, 1)
        img.putpixel((0, y), tuple(round(a + (b - a) * t) for a, b in zip(top, bottom)))
    return img.resize((size, size))


def draw_icon(px):
    """在 px × px 的畫布上畫圖。所有座標以 128 為基準等比換算。"""
    s = px / 128
    u = lambda v: v * s  # noqa: E731

    # 背景：圓角方塊 + 垂直漸層
    base = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    mask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(mask).rounded_rectangle([0, 0, px - 1, px - 1], radius=u(29), fill=255)
    base.paste(vertical_gradient(px, BG_TOP, BG_BOTTOM), (0, 0), mask)

    layer = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)

    # 下方兩條字幕條，置中、長短不一，像真的字幕換行
    bar_h = u(13)
    for x0, x1, y in ((23, 105, 77), (43, 85, 97)):
        d.rounded_rectangle([u(x0), u(y), u(x1), u(y) + bar_h], radius=bar_h / 2, fill=BAR)

    # 被拎起來的那個詞：置中懸在字幕條上方，加陰影強化「離開了原位」
    wx0, wx1, wy, wh = u(38), u(90), u(33), u(25)

    # 模糊過的陰影才像陰影 —— 實心的會變成一條黑槓
    shadow = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    ImageDraw.Draw(shadow).rounded_rectangle(
        [wx0 + u(3), wy + u(8), wx1 - u(3), wy + wh + u(6)], radius=wh / 2, fill=SHADOW
    )
    shadow = shadow.filter(ImageFilter.GaussianBlur(u(6)))
    layer = Image.alpha_composite(layer, shadow)

    word = Image.new('RGBA', (px, px), (0, 0, 0, 0))
    wmask = Image.new('L', (px, px), 0)
    ImageDraw.Draw(wmask).rounded_rectangle([wx0, wy, wx1, wy + wh], radius=wh / 2, fill=255)
    word.paste(vertical_gradient(px, AMBER_TOP, AMBER_BOTTOM), (0, 0), wmask)
    layer = Image.alpha_composite(layer, word)

    return Image.alpha_composite(base, layer)


os.makedirs(OUT, exist_ok=True)
for size in SIZES:
    big = draw_icon(size * SS)
    big.resize((size, size), Image.LANCZOS).save(os.path.join(OUT, f'{size}.png'))
    print(f'  icon/{size}.png')

# 預覽圖放 docs/，不要放 public/ —— 那裡的東西會被打包進擴充
docs = os.path.join(os.path.dirname(__file__), '..', 'docs')
os.makedirs(docs, exist_ok=True)
draw_icon(512).save(os.path.join(docs, 'icon-preview.png'))
print('✅ 完成')
