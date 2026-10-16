#!/usr/bin/env python3
"""两张截图的差异度：用于验证输入注入是否生效（画面是否变化）。

用法:
    img-diff.py <图A> <图B> [crop_x1 crop_y1 crop_x2 crop_y2]

输出 JSON：
    {"meanAbsDiff": float,  # 0-255 平均绝对差
     "changedRatio": float, # 差异>25 的像素占比 0-1
     "same": bool}          # changedRatio < 0.01 视为无变化
"""
import json
import sys

import cv2
import numpy as np


def main():
    a = cv2.imread(sys.argv[1])
    b = cv2.imread(sys.argv[2])
    if a is None or b is None:
        print(json.dumps({"error": "无法读取图片"}))
        return
    if a.shape != b.shape:
        b = cv2.resize(b, (a.shape[1], a.shape[0]))
    if len(sys.argv) >= 6:
        x1, y1, x2, y2 = (int(v) for v in sys.argv[3:7])
        a = a[y1:y2, x1:x2]
        b = b[y1:y2, x1:x2]
    diff = cv2.absdiff(a, b)
    gray = cv2.cvtColor(diff, cv2.COLOR_BGR2GRAY)
    mean_abs = float(np.mean(diff))
    changed = float(np.mean(gray > 25))
    print(json.dumps({
        "meanAbsDiff": round(mean_abs, 2),
        "changedRatio": round(changed, 4),
        "same": changed < 0.01,
    }))


if __name__ == "__main__":
    main()
