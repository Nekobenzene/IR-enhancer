# -*- coding: utf-8 -*-
"""用 Pillow 独立交叉校验 HTML 版导出的 PNG 与 ZIP（可选，需要 Python + Pillow）。

先运行 node build/test_html_core.mjs 与 node build/test_html_browser.mjs 生成导出物，再运行本脚本。
目录约定见 test_html_core.mjs 顶部说明：<项目>/index.html + <项目>/fixtures + <项目>/build/。
"""
import json
import os
import sys
import zipfile

import numpy as np
from PIL import Image

here = os.path.dirname(os.path.abspath(__file__))


def _first_existing(paths):
    for p in paths:
        if os.path.exists(p):
            return p
    return paths[0]


tmp = os.environ.get("IR_TEST_OUT") or os.path.join(here, ".test_tmp")
fixture_dir = os.environ.get("IR_FIXTURE_DIR") or _first_existing([
    os.path.join(here, "..", "fixtures"),      # <项目>/fixtures（现在的布局）
    os.path.join(here, "fixtures"),            # 旧布局：基准图片放在 build/ 里
    os.path.join(here, "..", "..", "fixtures"),
])
out_png = os.path.join(tmp, "node_out.png")
out_zip = os.path.join(tmp, "node_out.zip")

ok = fail = 0


def check(name, cond, extra=""):
    global ok, fail
    if cond:
        ok += 1
        print(f"  [OK]   {name}")
    else:
        fail += 1
        print(f"  [FAIL] {name} {extra}")


# 1) HTML 版导出的 PNG 能否被标准工具正确读取
im = Image.open(out_png)
im.load()
arr = np.asarray(im.convert("RGBA"))
W, H = 9, 5
check("PNG 尺寸正确", arr.shape[:2] == (H, W), arr.shape)
check("PNG 带 Alpha 通道", im.mode in ("RGBA", "LA"), im.mode)

expect = np.zeros((H, W, 4), np.uint8)
for i in range(W * H):
    v = (i * 17) % 256
    y, x = divmod(i, W)
    expect[y, x] = (v, v, v, [0, 1, 128, 254, 255][i % 5])
check("RGBA 逐字节一致（含 Alpha=1/128/254/255）", np.array_equal(arr, expect),
      f"{arr.reshape(-1,4)[:3].tolist()} vs {expect.reshape(-1,4)[:3].tolist()}")

# 2) ZIP 结构
with zipfile.ZipFile(out_zip) as zf:
    names = zf.namelist()
    check("ZIP 内文件名带文件夹前缀", names == ["IR_Enhance_x/a.png", "IR_Enhance_x/b.png"], str(names))
    data = zf.read(names[0])
    inner = np.asarray(Image.open(__import__("io").BytesIO(data)).convert("RGBA"))
    check("ZIP 内 PNG 与源一致", np.array_equal(inner, expect))

# 3) 浏览器里导出的 PNG（导出时用的是 23x17 的测试图 + 默认黑白色标）
browser_png = os.path.join(tmp, "browser_out.png")
exp = json.load(open(os.path.join(fixture_dir, "expected.json"), encoding="utf-8"))
BW, BH = exp["width"], exp["height"]
want_gray = np.array(exp["gray"], np.uint8).reshape(BH, BW)
want_alpha = np.array(exp["alpha"], np.uint8).reshape(BH, BW)
if os.path.exists(browser_png):
    bim = Image.open(browser_png)
    bim.load()
    barr = np.asarray(bim.convert("RGBA"))
    check("浏览器导出的 PNG 尺寸正确", barr.shape == (BH, BW, 4), barr.shape)
    check("浏览器导出的 Alpha 与源逐字节一致", np.array_equal(barr[..., 3], want_alpha))
    rgb = barr[..., :3]
    check("浏览器导出的 RGB = 默认黑白色标下的灰度", np.array_equal(rgb[..., 0], want_gray)
          and np.array_equal(rgb[..., 1], want_gray) and np.array_equal(rgb[..., 2], want_gray))
else:
    print("  [skip] 未找到 browser_out.png")

# 4) 浏览器里导出的 JPEG（源为 JPG 时输出 JPEG）
browser_jpg = os.path.join(tmp, "browser_out.jpg")
if os.path.exists(browser_jpg):
    jimg = Image.open(browser_jpg)
    jimg.load()
    check("浏览器导出的 JPEG 是有效图片", jimg.format == "JPEG", str(jimg.format))
    check("JPEG 尺寸与源一致", jimg.size == (exp["jpgWidth"], exp["jpgHeight"]), str(jimg.size))
    check("JPEG 为 RGB（无 Alpha）", jimg.mode == "RGB", jimg.mode)
else:
    print("  [skip] 未找到 browser_out.jpg")

print(f"\nHTML 导出物校验：通过 {ok} 项，失败 {fail} 项。")
sys.exit(1 if fail else 0)
