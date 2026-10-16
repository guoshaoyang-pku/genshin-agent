#!/usr/bin/env python3
"""OpenCV 模板匹配：找模板图在截图中的最佳匹配中心点。

用法:
    template-match.py <截图> <模板png> [threshold=0.85] [crop_x1 crop_y1 crop_x2 crop_y2]

坐标一律是视口像素（截图 = 视口 1920x992）。输出 JSON：
    {"found": bool, "score": float, "center": [x, y], "box": [x, y, w, h]}
"""
import json
import sys

import cv2


def main():
    img_path, tmpl_path = sys.argv[1], sys.argv[2]
    threshold = float(sys.argv[3]) if len(sys.argv) > 3 else 0.85
    crop = None
    if len(sys.argv) >= 8:
        crop = [int(v) for v in sys.argv[4:8]]

    img = cv2.imread(img_path)
    if img is None:
        print(json.dumps({"found": False, "error": f"无法读取截图: {img_path}"}))
        return
    if crop:
        x1, y1, x2, y2 = crop
        img = img[y1:y2, x1:x2]
    tmpl = cv2.imread(tmpl_path)
    if tmpl is None:
        print(json.dumps({"found": False, "error": f"无法读取模板: {tmpl_path}"}))
        return
    if img.shape[0] < tmpl.shape[0] or img.shape[1] < tmpl.shape[1]:
        print(json.dumps({"found": False, "score": 0, "center": [0, 0], "box": [0, 0, 0, 0],
                          "note": "模板大于截图区域"}))
        return

    res = cv2.matchTemplate(img, tmpl, cv2.TM_CCOEFF_NORMED)
    _, max_val, _, max_loc = cv2.minMaxLoc(res)
    if max_val >= threshold:
        bx, by = max_loc
        if crop:
            bx += crop[0]
            by += crop[1]
        print(json.dumps({
            "found": True,
            "score": round(float(max_val), 4),
            "center": [bx + tmpl.shape[1] // 2, by + tmpl.shape[0] // 2],
            "box": [bx, by, tmpl.shape[1], tmpl.shape[0]],
        }))
    else:
        print(json.dumps({"found": False, "score": round(float(max_val), 4),
                          "center": [0, 0], "box": [0, 0, 0, 0]}))


if __name__ == "__main__":
    main()
