# -*- coding: utf-8 -*-
"""
把用户提供的 Hello Kitty 图片处理成 App 素材：
  1. 抠掉粉色背景（按颜色距离+边缘连通判断，保留猫的白脸）
  2. 生成全套尺寸：180 / 192 / 512 / maskable 512 / favicon 32
  3. 输出成 Base64，供内嵌进 CSS（不提交独立图片文件）
  4. 额外输出一张用于空状态的中等尺寸图

用法： python tools/kitty_assets.py
"""
import base64
import io
import os

from PIL import Image, ImageFilter

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ICONS = os.path.join(ROOT, 'icons')
OUT_B64 = os.path.join(ICONS, 'kitty-b64.css')


def dist(c1, c2):
    return sum((a - b) ** 2 for a, b in zip(c1[:3], c2[:3])) ** 0.5


def remove_bg_flood(img, bg_color, tol=60):
    """从四条边做洪水填充，把与背景色接近且连通的像素设为透明。"""
    img = img.convert('RGBA')
    w, h = img.size
    px = img.load()

    # 用 BFS 从边缘向内扩散
    from collections import deque
    visited = [[False] * w for _ in range(h)]
    q = deque()

    for x in range(w):
        q.append((x, 0)); q.append((x, h - 1))
    for y in range(h):
        q.append((0, y)); q.append((w - 1, y))

    while q:
        x, y = q.popleft()
        if x < 0 or y < 0 or x >= w or y >= h:
            continue
        if visited[y][x]:
            continue
        visited[y][x] = True
        r, g, b, a = px[x, y]
        if dist((r, g, b), bg_color) > tol:
            continue
        px[x, y] = (r, g, b, 0)
        q.append((x + 1, y)); q.append((x - 1, y))
        q.append((x, y + 1)); q.append((x, y - 1))

    return img


def trim(img, pad_ratio=0.04):
    """裁掉四周透明区域，再留一点边距。"""
    bbox = img.getbbox()
    if not bbox:
        return img
    img = img.crop(bbox)
    w, h = img.size
    side = max(w, h)
    pad = int(side * pad_ratio)
    canvas = Image.new('RGBA', (side + pad * 2, side + pad * 2), (0, 0, 0, 0))
    canvas.paste(img, ((side - w) // 2 + pad, (side - h) // 2 + pad), img)
    return canvas


def add_soft_shadow(img, blur=18, opacity=26):
    """给透明图加一层柔和投影，让它在浅色背景上更立体。"""
    w, h = img.size
    pad = blur * 2
    canvas = Image.new('RGBA', (w + pad * 2, h + pad * 2), (0, 0, 0, 0))
    alpha = img.split()[-1]
    shadow = Image.new('RGBA', canvas.size, (0, 0, 0, 0))
    shadow.putalpha(Image.new('L', canvas.size, 0))
    core = Image.new('L', canvas.size, 0)
    core.paste(alpha, (pad, pad + blur // 2), alpha)
    core = core.filter(ImageFilter.GaussianBlur(blur))
    core = core.point(lambda v: int(v * opacity / 255))
    shadow.putalpha(core)
    canvas.alpha_composite(shadow)
    canvas.alpha_composite(img, (pad, pad))
    return canvas


def square_fit(img, size, bg=None, content_ratio=0.88):
    """把图缩放到 size×size，保持比例，可选铺底色。"""
    w, h = img.size
    scale = (size * content_ratio) / max(w, h)
    nw, nh = max(1, int(w * scale)), max(1, int(h * scale))
    img2 = img.resize((nw, nh), Image.LANCZOS)
    if bg is None:
        canvas = Image.new('RGBA', (size, size), (0, 0, 0, 0))
        canvas.paste(img2, ((size - nw) // 2, (size - nh) // 2), img2)
    else:
        canvas = Image.new('RGBA', (size, size), bg)
        canvas.paste(img2, ((size - nw) // 2, (size - nh) // 2), img2)
    return canvas


def png_b64(img, quality=None):
    buf = io.BytesIO()
    img.save(buf, 'PNG', optimize=True)
    return base64.b64encode(buf.getvalue()).decode('ascii')


def main():
    head_path = os.path.join(ICONS, 'kitty-head.jpg')
    full_path = os.path.join(ICONS, 'kitty-full.webp')

    head = Image.open(head_path)
    head.load()
    print('head 原始尺寸:', head.size)

    # 背景色取左上角像素
    bg = head.convert('RGB').getpixel((2, 2))
    print('检测背景色:', bg)

    cut = remove_bg_flood(head, bg, tol=70)
    cut = trim(cut, 0.04)
    print('抠图后尺寸:', cut.size)

    # 存一份透明底原图备用
    cut.save(os.path.join(ICONS, '_kitty-cut.png'), 'PNG', optimize=True)

    assets = {}

    # --- 图标：暖白底 + 粉色描边感，适合 iOS 主屏 ---
    icon_bg = (255, 241, 246, 255)          # 极浅粉
    for size, name, ratio in [
        (512, 'icon512', 0.86),
        (192, 'icon192', 0.86),
        (180, 'apple180', 0.86),
        (32,  'favicon32', 0.94),
    ]:
        im = square_fit(cut, size, bg=icon_bg, content_ratio=ratio)
        im.save(os.path.join(ICONS, {
            'icon512': 'icon-512.png', 'icon192': 'icon-192.png',
            'apple180': 'apple-touch-icon.png', 'favicon32': 'favicon.png'
        }[name]), 'PNG', optimize=True)
        assets[name] = png_b64(im)
        print('生成', name, size)

    # --- maskable：内容缩到 66%，背景满幅 ---
    mask = square_fit(cut, 512, bg=icon_bg, content_ratio=0.62)
    mask.save(os.path.join(ICONS, 'icon-maskable-512.png'), 'PNG', optimize=True)
    assets['maskable'] = png_b64(mask)
    print('生成 maskable')

    # --- 空状态插画：透明底 + 柔和投影 ---
    empty_size = 260
    empty = square_fit(cut, empty_size, bg=None, content_ratio=0.92)
    empty = add_soft_shadow(empty)
    empty.save(os.path.join(ICONS, '_kitty-empty.png'), 'PNG', optimize=True)
    assets['empty'] = png_b64(empty)

    # --- 顶栏小图标：透明底 72px ---
    small = square_fit(cut, 72, bg=None, content_ratio=0.96)
    small.save(os.path.join(ICONS, '_kitty-small.png'), 'PNG', optimize=True)
    assets['small'] = png_b64(small)

    # --- 全身图（第二张）用于欢迎/关于区 ---
    if os.path.exists(full_path):
        full = Image.open(full_path)
        full.load()
        fbg = full.convert('RGB').getpixel((2, 2))
        fcut = remove_bg_flood(full, fbg, tol=60)
        fcut = trim(fcut, 0.03)
        fsize = 280
        fimg = square_fit(fcut, fsize, bg=None, content_ratio=0.94)
        fimg = add_soft_shadow(fimg)
        fimg.save(os.path.join(ICONS, '_kitty-full.png'), 'PNG', optimize=True)
        assets['full'] = png_b64(fimg)
        print('全身图处理完成')

    # 写 CSS（必须包在 :root {} 里，裸声明会被浏览器丢弃）
    lines = ['/* ============================================================',
             '   自动生成：Hello Kitty 素材（Base64 内嵌）',
             '   由 tools/kitty_assets.py 生成，请勿手改。',
             '   ------------------------------------------------------------',
             '   说明：素材仅用于个人自用项目，非官方授权素材。',
             '   ============================================================ */',
             ':root {']
    for k, v in assets.items():
        lines.append('  --kitty-%s: url("data:image/png;base64,%s");' % (k, v))
    lines.append('}')
    with io.open(OUT_B64, 'w', encoding='utf-8', newline='\n') as f:
        f.write('\n'.join(lines) + '\n')

    total = sum(len(v) for v in assets.values())
    print('\nBase64 CSS 已写出: %s (%.0f KB, 共 %d 张)' % (OUT_B64, len(open(OUT_B64, 'rb').read()) / 1024, len(assets)))


if __name__ == '__main__':
    main()
