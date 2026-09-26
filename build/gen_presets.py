# -*- coding: utf-8 -*-
"""把 PreSet/*.json 同步进 index.html 里内嵌的 PRESET_SCALES。

工具的「打开色标 → 预设」列表来自 index.html 里内嵌的数据（file:// 页面不能读同级文件夹），
所以改完 PreSet/ 里的 JSON 之后，用本脚本把它们重新写进 index.html。

用法（在项目根目录或 build/ 下都能跑）：
    python build/gen_presets.py            # 按 PreSet/*.json 重写 index.html 里的 PRESET_SCALES
    python build/gen_presets.py --check    # 只检查两边是否一致，不一致时退出码 1
    python build/gen_presets.py --dir 别的目录 [--html 别的.html]

顺序：固定把「空白」放第一位，其余按文件名排序（顺序会影响弹窗里的列表顺序）。
"""
import argparse
import io
import json
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
PROJECT = os.path.dirname(HERE)

BEGIN = "const PRESET_SCALES = ["
END = "];"


def build_literal(presets):
    lines = [BEGIN]
    for name, nodes in presets:
        lines.append("  {")
        lines.append("    name: '%s'," % name)
        lines.append("    nodes: [")
        for n in nodes:
            pin = ", pinned: true" if n.get("pinned") is True else ""
            k = n["temperature_k"]
            kstr = repr(k)
            lines.append("      { temperature_k: %s, color: '%s'%s }," % (kstr, n["color"], pin))
        lines.append("    ],")
        lines.append("  },")
    lines.append(END)
    return "\n".join(lines)


def load_presets(preset_dir):
    """读目录里的所有 json → [(name, nodes)]，空白排第一，其余按文件名排序。"""
    files = sorted(f for f in os.listdir(preset_dir) if f.lower().endswith(".json"))
    items = []
    for f in files:
        raw = json.loads(io.open(os.path.join(preset_dir, f), encoding="utf-8").read())
        name = raw.get("name")
        nodes = raw.get("nodes")
        if not name or not isinstance(nodes, list) or not nodes:
            raise SystemExit("%s: 缺少 name 或 nodes" % f)
        items.append((name, nodes, f))
    # 「空白」放第一位，其余保持文件名顺序
    items.sort(key=lambda it: (0 if it[0] == "空白" else 1, it[2]))
    return [(n, nodes) for (n, nodes, _f) in items]


def find_block(text):
    i = text.find(BEGIN)
    if i < 0:
        raise SystemExit("index.html 里找不到 " + BEGIN)
    j = text.find("\n" + END, i)
    if j < 0:
        raise SystemExit("找不到 PRESET_SCALES 数组的结尾 " + END)
    return i, j + len("\n" + END)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true", help="只检查是否一致，不写文件")
    ap.add_argument("--dir", default=os.path.join(PROJECT, "PreSet"), help="预置色标目录")
    ap.add_argument("--html", default=os.path.join(PROJECT, "index.html"), help="要写入的 HTML")
    args = ap.parse_args()

    if not os.path.isdir(args.dir):
        raise SystemExit("找不到预置目录：" + args.dir)
    if not os.path.isfile(args.html):
        raise SystemExit("找不到主文件：" + args.html)

    presets = load_presets(args.dir)
    literal = build_literal(presets)
    text = io.open(args.html, encoding="utf-8").read()
    i, j = find_block(text)
    current = text[i:j].rstrip("\n")
    same = (current == literal)

    print("预置目录：%s（%d 条：%s）" % (args.dir, len(presets), "、".join(n for n, _ in presets)))
    if same:
        print("index.html 里的 PRESET_SCALES 已经与 PreSet/*.json 一致。")
        return 0
    if args.check:
        print("不一致：index.html 里的 PRESET_SCALES 与 PreSet/*.json 已经不同步。")
        print("（运行 python build/gen_presets.py 可自动重写）")
        return 1
    io.open(args.html, "w", encoding="utf-8", newline="").write(text[:i] + literal + text[j:])
    print("已把 %d 条预置写入 %s。" % (len(presets), args.html))
    print("记得跑一遍自检：node build/test_html_core.mjs")
    return 0


if __name__ == "__main__":
    sys.exit(main())
