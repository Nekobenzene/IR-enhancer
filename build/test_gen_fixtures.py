# -*- coding: utf-8 -*-
"""生成测试用的基准 PNG 与期望值。

默认输出到 <项目>/fixtures（与 index.html 同级，已随工具一起提供），
也可以把目标目录作为第一个参数传进来；仅在需要重新生成时才运行本脚本。
主自检 test_html_core.mjs / test_html_browser.mjs 不依赖 Python。
"""
import json
import os
import sys

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))
default_dir = os.path.join(here, "..", "fixtures")      # <项目>/fixtures
if not os.path.isdir(os.path.dirname(default_dir)):
    default_dir = os.path.join(here, "fixtures")        # 兼容旧布局
tmp = sys.argv[1] if len(sys.argv) > 1 else default_dir
os.makedirs(tmp, exist_ok=True)

rng = np.random.default_rng(11)
w, h = 23, 17
gray = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
# Alpha 覆盖 0 / 255 / 中间值，验证 Alpha 逐字节精确
alpha = rng.integers(0, 256, size=(h, w), dtype=np.uint8)
alpha[0, 0] = 0
alpha[0, 1] = 255
alpha[1, 0] = 1
alpha[1, 1] = 254

Image.fromarray(np.dstack((gray, alpha)), "LA").save(os.path.join(tmp, "la.png"))

# RGBA：灰度三分量相同 + 半透明
rgba = np.dstack((gray, gray, gray, alpha))
Image.fromarray(rgba, "RGBA").save(os.path.join(tmp, "rgba.png"))

# 调色板 + tRNS
pal_img = Image.fromarray(gray, "L").convert("P", palette=Image.ADAPTIVE, colors=256)
pal_img.save(os.path.join(tmp, "pal.png"))

# 16 位灰度
g16 = (gray.astype(np.uint16) * 257).astype(np.uint16)
Image.fromarray(g16, "I;16").save(os.path.join(tmp, "gray16.png"))

# 截图用的大图（红外风格：灰度梯度 + 噪声 + 圆形 Alpha）
h2, w2 = 420, 560
yy, xx = np.mgrid[0:h2, 0:w2]
base2 = np.sin(xx / 55.0) * 60 + np.cos(yy / 40.0) * 45 + 128
rng2 = np.random.default_rng(3)
g2 = (base2 + rng2.normal(0, 12, (h2, w2))).clip(0, 255).astype(np.uint8)
cy, cx, r = h2 / 2, w2 / 2, min(h2, w2) / 2 - 6
dist = (yy - cy) ** 2 + (xx - cx) ** 2
a2 = np.where(dist <= r * r, np.clip(255 - dist / (r * r) * 90, 0, 255), 0).astype(np.uint8)
Image.fromarray(np.dstack((g2, a2)), "LA").save(os.path.join(tmp, "shot_src.png"))

# JPEG 测试图：平滑灰度梯度（JPEG 有损，比对时用容差）
jw, jh = 32, 24
jpg_gray = np.zeros((jh, jw), np.uint8)
for x in range(jw):
    jpg_gray[:, x] = int(round(x * 255 / (jw - 1)))
Image.fromarray(np.dstack((jpg_gray, jpg_gray, jpg_gray)), "RGB").save(
    os.path.join(tmp, "gray.jpg"), quality=95, subsampling=0
)
# 彩色 JPEG：只验证能正常解码，不做逐字节比对
color = np.dstack((
    np.tile(np.linspace(20, 220, jw, dtype=np.uint8), (jh, 1)),
    np.tile(np.linspace(200, 40, jw, dtype=np.uint8), (jh, 1)),
    np.full((jh, jw), 90, np.uint8),
))
Image.fromarray(color, "RGB").save(os.path.join(tmp, "color.jpg"), quality=95, subsampling=0)

json.dump(
    {
        "width": w,
        "height": h,
        "gray": gray.reshape(-1).tolist(),
        "alpha": alpha.reshape(-1).tolist(),
        "jpgWidth": jw,
        "jpgHeight": jh,
        "jpgGray": jpg_gray.reshape(-1).tolist(),
        "gray16": gray.reshape(-1).tolist(),
    },
    open(os.path.join(tmp, "expected.json"), "w", encoding="utf-8"),
)
print("tmp:", tmp)
