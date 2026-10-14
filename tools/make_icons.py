# -*- coding: utf-8 -*-
"""
生成 PWA 图标（原创"粉粉小猫"风格，避免直接复制受版权保护的卡通角色）。

输出：
  icons/icon-192.png           普通图标
  icons/icon-512.png           普通图标
  icons/icon-maskable-512.png  Android 自适应图标（内容在安全区内，背景满幅）
  icons/apple-touch-icon.png   iOS 主屏图标 180x180（满幅、不透明）
  icons/favicon.png            浏览器标签页图标 32x32

用法： python tools/make_icons.py
"""
import os
from PIL import Image, ImageDraw, ImageFilter

SS = 4  # 超采样倍数，先大后小，边缘更平滑
OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")

PINK_TOP = (255, 232, 243)
PINK_BOTTOM = (255, 173, 205)
LINE = (240, 150, 185)          # 轮廓粉
WHITE = (255, 255, 255)
INK = (58, 46, 52)              # 眼睛/胡须（比纯黑柔和）
NOSE = (255, 190, 60)
BOW = (255, 92, 138)
BOW_DARK = (226, 62, 110)
BLUSH = (255, 170, 195)


def lerp(a, b, t):
    return tuple(round(a[i] + (b[i] - a[i]) * t) for i in range(3))


def gradient(size):
    """竖向渐变背景。"""
    img = Image.new("RGB", (1, size), PINK_TOP)
    px = img.load()
    for y in range(size):
        px[0, y] = lerp(PINK_TOP, PINK_BOTTOM, y / max(1, size - 1))
    return img.resize((size, size), Image.BILINEAR)


def heart(draw, cx, cy, r, fill, alpha=110):
    """画一个心形（用两个圆 + 一个三角近似）。"""
    layer = Image.new("RGBA", (int(r * 4), int(r * 4)), (0, 0, 0, 0))
    d = ImageDraw.Draw(layer)
    w = r * 2
    d.ellipse([0, 0, w, w], fill=fill + (alpha,))
    d.ellipse([w, 0, w * 2, w], fill=fill + (alpha,))
    d.polygon([(0, w * 0.55), (w * 2, w * 0.55), (w, w * 2)], fill=fill + (alpha,))
    layer = layer.resize((int(r * 2), int(r * 2)), Image.LANCZOS)
    draw._image.alpha_composite(layer, (int(cx - r), int(cy - r * 0.8)))


def draw_kitty(size, content_scale=0.80, bg_rounded=True, bg_full=False):
    """画一只小猫头像。content_scale 控制内容占比（maskable 要小一些）。"""
    S = size * SS
    canvas = Image.new("RGBA", (S, S), (0, 0, 0, 0))

    # ---------- 背景 ----------
    if bg_full:
        bg = gradient(S).convert("RGBA")
        canvas.alpha_composite(bg, (0, 0))
    else:
        bg = gradient(S).convert("RGBA")
        mask = Image.new("L", (S, S), 0)
        ImageDraw.Draw(mask).rounded_rectangle([0, 0, S - 1, S - 1], radius=int(S * 0.225), fill=255)
        canvas.paste(bg, (0, 0), mask)

    # 背景小爱心装饰
    deco = ImageDraw.Draw(canvas)
    for (fx, fy, fr, fa) in ((0.14, 0.16, S * 0.045, 120), (0.86, 0.20, S * 0.035, 100),
                             (0.20, 0.86, S * 0.032, 100), (0.82, 0.84, S * 0.042, 120)):
        heart(deco, S * fx, S * fy, fr, (255, 255, 255), fa)

    # ---------- 小猫剪影（头 + 两只耳朵）----------
    cx = S * 0.5
    cy = S * 0.56 * (1 / content_scale) * content_scale + S * 0.02
    k = content_scale
    head_w = S * 0.74 * k
    head_h = S * 0.62 * k
    head = [cx - head_w / 2, cy - head_h / 2, cx + head_w / 2, cy + head_h / 2]

    ear_dx = head_w * 0.34
    ear_top = cy - head_h / 2 - head_h * 0.46
    ear_w = head_w * 0.30
    ear_h = head_h * 0.60

    sil = Image.new("L", (S, S), 0)
    sd = ImageDraw.Draw(sil)
    # 左耳
    sd.polygon([(cx - ear_dx - ear_w * 0.5, cy - head_h * 0.18),
                (cx - ear_dx + ear_w * 0.06, ear_top),
                (cx - ear_dx + ear_w * 0.62, cy - head_h * 0.30)], fill=255)
    # 右耳
    sd.polygon([(cx + ear_dx + ear_w * 0.5, cy - head_h * 0.18),
                (cx + ear_dx - ear_w * 0.06, ear_top),
                (cx + ear_dx - ear_w * 0.62, cy - head_h * 0.30)], fill=255)
    # 头
    sd.ellipse(head, fill=255)
    sil = sil.filter(ImageFilter.GaussianBlur(S * 0.004))

    # 轮廓 = 剪影膨胀 - 剪影
    dil = sil.filter(ImageFilter.GaussianBlur(S * 0.012)).point(lambda v: 255 if v > 60 else 0)
    ring = Image.new("L", (S, S), 0)
    ring.paste(dil, (0, 0))
    ring.paste(0, (0, 0), sil)

    body = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    body.paste(Image.new("RGBA", (S, S), LINE + (255,)), (0, 0), ring)
    body.paste(Image.new("RGBA", (S, S), WHITE + (255,)), (0, 0), sil)
    canvas.alpha_composite(body)

    d = ImageDraw.Draw(canvas)

    # ---------- 腮红 ----------
    blush = Image.new("RGBA", (S, S), (0, 0, 0, 0))
    bd = ImageDraw.Draw(blush)
    bw, bh = head_w * 0.17, head_h * 0.11
    for sx in (-1, 1):
        bx = cx + sx * head_w * 0.31
        by = cy + head_h * 0.20
        bd.ellipse([bx - bw / 2, by - bh / 2, bx + bw / 2, by + bh / 2], fill=BLUSH + (150,))
    blush = blush.filter(ImageFilter.GaussianBlur(S * 0.012))
    canvas.alpha_composite(blush)

    # ---------- 眼睛 ----------
    eye_w, eye_h = head_w * 0.088, head_h * 0.135
    for sx in (-1, 1):
        ex = cx + sx * head_w * 0.185
        ey = cy - head_h * 0.055
        d.ellipse([ex - eye_w / 2, ey - eye_h / 2, ex + eye_w / 2, ey + eye_h / 2], fill=INK)
        # 高光
        hw = eye_w * 0.34
        hx, hy = ex - eye_w * 0.16, ey - eye_h * 0.22
        d.ellipse([hx - hw / 2, hy - hw / 2, hx + hw / 2, hy + hw / 2], fill=(255, 255, 255, 235))

    # ---------- 鼻子 ----------
    nose_w, nose_h = head_w * 0.095, head_h * 0.075
    ny = cy + head_h * 0.115
    d.ellipse([cx - nose_w / 2, ny - nose_h / 2, cx + nose_w / 2, ny + nose_h / 2], fill=NOSE)

    # ---------- 胡须 ----------
    ww = max(2, int(S * 0.0075))
    for sx in (-1, 1):
        for i, dy in enumerate((-0.10, 0.0, 0.10)):
            x1 = cx + sx * head_w * 0.40
            y1 = cy + head_h * (0.10 + dy)
            x2 = cx + sx * head_w * 0.60
            y2 = cy + head_h * (0.06 + dy * 1.7)
            d.line([x1, y1, x2, y2], fill=INK + (235,), width=ww)
            for (px_, py_) in ((x1, y1), (x2, y2)):
                d.ellipse([px_ - ww / 2, py_ - ww / 2, px_ + ww / 2, py_ + ww / 2], fill=INK + (235,))

    # ---------- 蝴蝶结 ----------
    bx = cx + head_w * 0.375
    by = cy - head_h * 0.50
    bw2 = head_w * 0.155
    bh2 = head_h * 0.145
    d.polygon([(bx, by), (bx - bw2, by - bh2), (bx - bw2 * 1.05, by + bh2)], fill=BOW, outline=BOW_DARK, width=max(2, int(S * 0.004)))
    d.polygon([(bx, by), (bx + bw2, by - bh2), (bx + bw2 * 1.05, by + bh2)], fill=BOW, outline=BOW_DARK, width=max(2, int(S * 0.004)))
    knot = bw2 * 0.36
    d.ellipse([bx - knot, by - knot, bx + knot, by + knot], fill=BOW_DARK)

    return canvas.resize((size, size), Image.LANCZOS)


def save(img, name):
    os.makedirs(OUT, exist_ok=True)
    path = os.path.join(OUT, name)
    img.save(path, "PNG", optimize=True)
    print("wrote", path, img.size)


def main():
    save(draw_kitty(192, content_scale=0.92), "icon-192.png")
    save(draw_kitty(512, content_scale=0.92), "icon-512.png")
    # maskable：背景满幅，内容缩到 66% 安全区
    save(draw_kitty(512, content_scale=0.66, bg_full=True), "icon-maskable-512.png")
    # iOS 主屏：满幅不透明，iOS 自己会加圆角
    save(draw_kitty(180, content_scale=0.86, bg_full=True), "apple-touch-icon.png")
    save(draw_kitty(32, content_scale=1.0), "favicon.png")


if __name__ == "__main__":
    main()
