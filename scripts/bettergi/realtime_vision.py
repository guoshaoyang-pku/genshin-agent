"""BetterGI AutoPick/AutoSkip pixel algorithms, GPL-3.0.

Source: c9db8b8291fe4ac25a600aee1582298005919eb2. Recognition gating,
configuration, timers and game input remain in the realtime JS state machine.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path

import cv2
import numpy as np


def _bgr(pixels):
    if not isinstance(pixels, np.ndarray) or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Realtime vision requires nonempty uint8 image pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Realtime vision requires gray, BGR or BGRA images")
    return pixels


def _rect(x, y, width, height):
    return dict(x=int(x), y=int(y), width=int(width), height=int(height))


def _roi(value, width, height):
    if not isinstance(value, dict) or any(key not in value for key in ("x", "y", "width", "height")):
        raise ValueError("pickText roi requires x, y, width and height")
    values = [value[key] for key in ("x", "y", "width", "height")]
    if not all(isinstance(v, (int, float)) and not isinstance(v, bool)
               and math.isfinite(v) and int(v) == v for v in values):
        raise ValueError("pickText roi requires finite integer coordinates")
    x, y, w, h = map(int, values)
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
        raise ValueError("pickText roi is outside the capture")
    return x, y, w, h


def projection_rect(binary, max_gap=30):
    """TextRectExtractor.ProjectionRect, including lastNonEmpty as width."""
    last_nonempty, gap = -1, 0
    for x, column_sum in enumerate(binary.sum(axis=0, dtype=np.int32)):
        if column_sum > 0:
            last_nonempty, gap = x, 0
        else:
            gap += 1
            if gap > max_gap:
                break
    return _rect(0, 0, 0, 0) if last_nonempty == -1 else _rect(0, 0, last_nonempty, binary.shape[0])


def text_bounding_rect(pixels):
    gray = cv2.cvtColor(_bgr(pixels), cv2.COLOR_BGR2GRAY)
    _, binary = cv2.threshold(gray, 160, 255, cv2.THRESH_BINARY)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3))
    binary = cv2.erode(binary, kernel, iterations=1)
    binary = cv2.dilate(binary, kernel, iterations=2)
    return projection_rect(binary)


def _gradient(gray, roi):
    # OpenCV C# Mat ROIs retain their parent border pixels for Sobel's default
    # non-isolated border. Keep one context pixel instead of reflecting at ROI.
    x, y, width, height = roi
    rows = min(height, 3)
    left, top = max(0, x - 1), max(0, y - 1)
    right, bottom = min(gray.shape[1], x + width + 1), min(gray.shape[0], y + rows + 1)
    context = gray[top:bottom, left:right]
    sobel = cv2.Sobel(context, cv2.CV_32F, 1, 0)
    return float(cv2.mean(sobel[y - top:y - top + rows, x - left:x - left + width])[0])


def _ocr_center(line):
    if line.get("points") is not None:
        points = np.asarray(line["points"], dtype=np.float64)
        x, y = points.mean(axis=0)
    else:
        x, y, width, height = line["rect"]
        x, y = x + width / 2, y + height / 2
    return float(y), float(x)


def black_rate(pixels):
    gray = cv2.cvtColor(_bgr(pixels), cv2.COLOR_BGR2GRAY)
    rows = gray.shape[0] // 3
    if rows == 0:
        raise ValueError("skipScene requires at least three capture rows")
    middle = gray[rows:rows * 2]
    return float(np.count_nonzero(middle == 0) / middle.size)


def _asset_scale(pixels):
    return min(pixels.shape[1] / 1920, pixels.shape[0] / 1080, 1)


def bottom_triangle(pixels):
    pixels = _bgr(pixels)
    scale = _asset_scale(pixels)
    # ImageRegion.DeriveCrop(double) uses Math.Round (ties to even) then clamps.
    x, y, width, height = (round(v * scale) for v in (945, 980, 30, 80))
    width, height = min(width, pixels.shape[1] - x), min(height, pixels.shape[0] - y)
    if width <= 0 or height <= 0:
        return None
    hsv = cv2.cvtColor(pixels[y:y + height, x:x + width], cv2.COLOR_BGR2HSV)
    yellow = cv2.inRange(hsv, (0, 240, 229), (25, 255, 255))
    blue = cv2.inRange(hsv, (90, 156, 145), (99, 208, 253))
    for mask in (yellow, blue):
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        for contour in contours:
            area = cv2.contourArea(contour)
            approx = cv2.approxPolyDP(contour, .04 * cv2.arcLength(contour, True), True)
            if 10 <= area <= 50 and len(approx) == 3:
                xx, yy, w, h = cv2.boundingRect(approx)
                return {**_rect(x + xx, y + yy, w, h), "area": float(area)}
    return None


def character_popup(pixels):
    pixels = _bgr(pixels)
    scale = _asset_scale(pixels)
    image = pixels.copy()
    for box, color in (((240, 395, 300, 50), (229, 241, 245)),
                       ((290, 660, 210, 40), (101, 82, 74))):
        x, y, width, height = (int(v * scale) for v in box)
        image[y:y + height, x:x + width] = color
    hsv = cv2.cvtColor(image, cv2.COLOR_BGR2HSV)
    light = cv2.inRange(hsv, (18, 16, 234), (27, 19, 250))
    dark = cv2.inRange(hsv, (101, 57, 95), (118, 85, 106))
    combined = cv2.bitwise_or(light, dark)
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (21, 21))
    combined = cv2.morphologyEx(combined, cv2.MORPH_CLOSE, kernel)
    combined = cv2.morphologyEx(combined, cv2.MORPH_OPEN, kernel)
    contours, _ = cv2.findContours(combined, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    height, width = image.shape[:2]
    for contour in contours:
        x, y, w, h = cv2.boundingRect(contour)
        if h == 0 or not .24 < w * h / (width * height) < .3:
            continue
        if not 5.6 <= w / h <= 7.2 or y <= height * .3 or y + h >= height * .7:
            continue
        if cv2.countNonZero(light[y:y + h, x:x + w]) and cv2.countNonZero(dark[y:y + h, x:x + w]):
            return _rect(x, y, w, h)
    return None


def goods_rects(pixels):
    rgb = cv2.cvtColor(_bgr(pixels), cv2.COLOR_BGR2RGB)
    mask = cv2.inRange(rgb, (233, 229, 220), (233, 229, 220))
    kernel = cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5))
    mask = cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel, iterations=2)
    contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    boxes = [cv2.boundingRect(contour) for contour in contours]
    return [_rect(*box) for box in boxes if box[2] >= 100 and box[3] >= 20]


def yap_tensor(gray):
    """OcrUtils.ToTensorYapDnn for the capture-gray ROI used by AutoPick."""
    if not isinstance(gray, np.ndarray) or gray.dtype != np.uint8 or gray.ndim != 2 or gray.size == 0:
        raise ValueError("Yap preprocessing requires nonempty uint8 grayscale pixels")
    resized = cv2.resize(gray, (221, 32), interpolation=cv2.INTER_LINEAR)
    padded = np.zeros((32, 384), np.uint8)
    padded[:, :221] = resized
    return cv2.dnn.blobFromImage(padded, 1 / 255, swapRB=False, crop=False)


def decode_yap(output, words):
    """PickTextInference's string deduplication and initial -1 maximum."""
    if output.ndim != 3 or output.shape[1] != 1 or output.shape[2] < len(words):
        raise ValueError("Yap output requires [time,1,vocabulary] matching the original dictionary")
    result, previous = [], None
    for row in output[:, 0, :len(words)]:
        # C# leaves maxIndex at zero when every score is <= -1, including NaN.
        index = int(np.argmax(np.where(row > -1, row, -1)))
        word = words[index]
        if word != previous and word != "|":
            result.append(word)
        previous = word
    return "".join(result)


class YapOcr:
    def __init__(self, model_root):
        import onnxruntime as ort

        if model_root is None:
            raise FileNotFoundError("Set BETTERGI_MODEL_ROOT or --model-root to the original Assets/Model directory")
        root = Path(model_root).resolve() / "Yap"
        self.model_path, self.dictionary_path = root / "model_training.onnx", root / "index_2_word.json"
        for path in (self.model_path, self.dictionary_path):
            if not path.is_file():
                raise FileNotFoundError(path)
        dictionary = json.loads(self.dictionary_path.read_text(encoding="utf-8-sig"))
        if not dictionary or set(dictionary) != {str(i) for i in range(len(dictionary))}:
            raise ValueError("Yap dictionary requires contiguous zero-based indices")
        self.words = [dictionary[str(i)] for i in range(len(dictionary))]
        if not all(isinstance(word, str) for word in self.words):
            raise ValueError("Yap dictionary values must be strings")
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
        options.inter_op_num_threads = 1
        self.session = ort.InferenceSession(str(self.model_path), options, providers=["CPUExecutionProvider"])

    def recognize(self, gray):
        output = self.session.run(None, {"input": yap_tensor(gray)})[0]
        return decode_yap(output, self.words)


class RealtimeVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.yap_engine = None

    def yap(self):
        if self.yap_engine is None:
            root = self.bridge.model_root
            if root is None:
                root = getattr(getattr(self.bridge, "ocr_engine", None), "root", None)
            self.yap_engine = YapOcr(root)
        return self.yap_engine

    def pick_text(self, pixels, roi, ocr_engine="Paddle"):
        pixels = _bgr(pixels)
        x, y, width, height = _roi(roi, pixels.shape[1], pixels.shape[0])
        gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
        gradient = _gradient(gray, (x, y, width, height))
        if gradient < -3:
            return {"text": "", "alreadyPicking": True, "textBounds": None, "avgGradient": gradient}
        if ocr_engine == "Yap":
            text = self.yap().recognize(gray[y:y + height, x:x + width])
            return {"text": text, "alreadyPicking": False, "textBounds": None, "avgGradient": gradient}
        cropped = pixels[y:y + height, x:x + width]
        bounds = text_bounding_rect(cropped)
        if bounds["x"] < 20 and bounds["width"] > 5 and bounds["height"] > 5:
            text, _ = self.bridge.ocr().recognize(cropped[:, :min(bounds["x"] + bounds["width"] + 5, width)])
        else:
            lines = self.bridge.ocr().run(cropped)
            text = "\n".join(line["text"] for line in sorted(lines, key=_ocr_center))
        return {"text": text, "alreadyPicking": False, "textBounds": bounds, "avgGradient": gradient}

    def dispatch(self, operation, args, pixels):
        if operation == "realtime.pickText":
            return self.pick_text(pixels, args.get("roi"), args.get("ocrEngine", "Paddle"))
        if operation == "realtime.skipScene":
            pixels = _bgr(pixels)
            return {"blackRate": black_rate(pixels), "bottomTriangle": bottom_triangle(pixels),
                    "characterPopup": character_popup(pixels), "goodsRects": goods_rects(pixels)}
        raise ValueError(f"Unknown realtime vision operation: {operation}")
