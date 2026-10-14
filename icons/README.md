# 图标说明

这里的所有图标都由 `tools/make_icons.py` 用 Pillow 自动生成，
是**原创绘制**的粉色小猫形象（只取"可爱猫咪"的通用风格），
未使用任何受版权保护的卡通角色素材，可自由使用、修改、商用。

## 文件用途

| 文件 | 尺寸 | 用途 |
| --- | --- | --- |
| `apple-touch-icon.png` | 180×180 | **iOS 添加到主屏幕时的图标**。必须是不透明 PNG，iOS 会自己加圆角，所以这里背景满幅 |
| `icon-192.png` | 192×192 | Android / Chrome 安装时使用（`purpose: any`） |
| `icon-512.png` | 512×512 | 高清图标、应用商店清单、PWA 安装弹窗 |
| `icon-maskable-512.png` | 512×512 | Android 自适应图标（`purpose: maskable`）。背景满幅、主体缩到中间安全区，被裁成圆形/水滴形都不会切到脸 |
| `favicon.png` | 32×32 | 浏览器标签页小图标 |

## 换成自己的图

### 方法一：直接替换（最省事）

准备两张 PNG：

- `apple-touch-icon.png` —— 180×180，**不要透明背景**（iOS 会把透明区域填成黑色）
- `icon-512.png` —— 512×512
- `icon-192.png` —— 192×192（可以由 512 那张缩出来）

覆盖同名文件即可，不用改任何代码。

### 方法二：改脚本重新生成

编辑 `tools/make_icons.py` 顶部的配色常量：

```python
PINK_TOP    = (255, 232, 243)   # 背景渐变起点
PINK_BOTTOM = (255, 173, 205)   # 背景渐变终点
LINE        = (240, 150, 185)   # 轮廓粉
BOW         = (255, 92, 138)    # 蝴蝶结主色
BOW_DARK    = (226, 62, 110)    # 蝴蝶结阴影
```

然后运行：

```bash
python tools/make_icons.py
```

脚本会一次性重新生成全部 5 个尺寸。`draw_kitty(size, content_scale, bg_full)` 里的
`content_scale` 控制小猫在画面中的占比（maskable 版本用 0.66，保证在安全区内）。

## 注意事项

- **不要改文件名**，`index.html` 和 `manifest.json` 里都是按上面的名字引用的
- iOS 图标缓存很顽固：换图后如果主屏幕上还是旧图标，先把图标从主屏幕删掉，再重新「添加到主屏幕」
- 图标必须是 **PNG**，且 `apple-touch-icon.png` 建议保持不透明
