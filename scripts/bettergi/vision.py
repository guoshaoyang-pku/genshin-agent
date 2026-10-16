#!/usr/bin/env python3
"""BetterGI image/recognition bridge (persistent UTF-8 JSONL).

Source port: BetterGI c9db8b8291fe4ac25a600aee1582298005919eb2, GPL-3.0.
RecognitionObjectJsonLoader, ImageRegion, ImageRegionReferenceSearchHelper,
MatchTemplateHelper and Paddle/{Det,Rec,DbPostProcessor}. Original assets and
PaddleOCR ONNX files are read without conversion. See tasks/vision-protocol.md.
"""

from __future__ import annotations

import argparse
import ast
import copy
from dataclasses import dataclass
import hashlib
import json
import math
import operator
import os
from pathlib import Path
import re
import sys
from typing import Any

import cv2
import numpy as np

UPSTREAM_COMMIT = "c9db8b8291fe4ac25a600aee1582298005919eb2"


def field(value: dict, *names: str, default=None):
    normalized = {str(k).replace("_", "").lower(): v for k, v in value.items()}
    for name in names:
        key = name.replace("_", "").lower()
        if key in normalized:
            return normalized[key]
    return default


def rect(value) -> tuple[int, int, int, int]:
    if isinstance(value, dict):
        value = [field(value, key, default=0) for key in ("x", "y", "width", "height")]
    if not isinstance(value, (list, tuple)) or len(value) != 4:
        raise ValueError("A rectangle needs x, y, width and height")
    return tuple(round(float(v)) for v in value)


def size(value) -> tuple[int, int]:
    if isinstance(value, dict):
        value = [field(value, "width"), field(value, "height")]
    if not isinstance(value, (list, tuple)) or len(value) != 2:
        raise ValueError("A size needs width and height")
    return tuple(round(float(v)) for v in value)


def clamp_rect(box, width, height):
    x, y, w, h = rect(box)
    left, top = max(0, x), max(0, y)
    right, bottom = min(width, x + w), min(height, y + h)
    return left, top, max(0, right - left), max(0, bottom - top)


def bgr(image):
    if image.ndim == 2:
        return cv2.cvtColor(image, cv2.COLOR_GRAY2BGR)
    if image.shape[2] == 4:
        return cv2.cvtColor(image, cv2.COLOR_BGRA2BGR)
    return image


def gray(image):
    return image if image.ndim == 2 else cv2.cvtColor(bgr(image), cv2.COLOR_BGR2GRAY)


def enum_value(value, prefix, aliases=None):
    if isinstance(value, (int, float)):
        return int(value)
    name = str(value).rsplit(".", 1)[-1]
    normalized = re.sub(r"[^a-z0-9]", "", name.lower())
    if aliases and normalized in aliases:
        return aliases[normalized]
    for key in dir(cv2):
        if key.startswith(prefix):
            suffix = key[len(prefix):].replace("_", "").lower()
            short_prefix = prefix.split("_", 1)[-1].replace("_", "").lower()
            if normalized in (suffix, short_prefix + suffix):
                return getattr(cv2, key)
    raise ValueError(f"Unknown OpenCV enum {value}")


def read_image(path, mode="Color"):
    flag = enum_value(mode, "IMREAD_")
    data = np.frombuffer(Path(path).read_bytes(), dtype=np.uint8)
    image = cv2.imdecode(data, flag)
    if image is None:
        raise ValueError(f"Unable to decode image: {path}")
    return image


def resolve_alias(expression, aliases):
    seen = set()
    expression = expression.strip()
    while expression.startswith("@"):
        key = expression[1:]
        if key in seen:
            raise ValueError(f"Circular BetterGI alias: {key}")
        seen.add(key)
        expression = aliases[key].strip()
    return expression


class RectExpression:
    """The arithmetic/Rect subset used by original Recognition.json files."""

    binary = {ast.Add: operator.add, ast.Sub: operator.sub, ast.Mult: operator.mul,
              ast.Div: operator.truediv, ast.Mod: operator.mod}

    def __init__(self, config, width, height, extra=None):
        if width <= 0 or height <= 0:
            raise ValueError("Capture dimensions must be positive")
        self.config = config
        self.width, self.height = width, height
        self.parameters = {"cw": width, "ch": height, "cx": 0, "cy": 0,
                           "s": min(width / 1920, 1), **(extra or {})}
        self.resolving = set()

    def evaluate(self, expression):
        if isinstance(expression, (int, float)):
            return expression
        expression = resolve_alias(expression, self.config.get("regions", {}))
        expression = re.sub(r"\[([A-Za-z_]\w*)\]", r"\1", expression)
        return self.visit(ast.parse(expression, mode="eval").body)

    def rectangle(self, expression):
        return list(rect(self.evaluate(expression)))

    def variable(self, name):
        variables = self.config.get("vars", {})
        if name not in variables:
            return self.parameters[name]
        if name in self.resolving:
            raise ValueError(f"Circular BetterGI variable: {name}")
        self.resolving.add(name)
        try:
            return float(self.evaluate(variables[name]))
        finally:
            self.resolving.remove(name)

    def visit(self, node):
        if isinstance(node, ast.Constant) and type(node.value) in (int, float):
            return node.value
        if isinstance(node, ast.Name):
            return self.variable(node.id)
        if isinstance(node, ast.BinOp) and type(node.op) in self.binary:
            return self.binary[type(node.op)](self.visit(node.left), self.visit(node.right))
        if isinstance(node, ast.UnaryOp) and isinstance(node.op, (ast.UAdd, ast.USub)):
            return self.visit(node.operand) * (-1 if isinstance(node.op, ast.USub) else 1)
        if isinstance(node, ast.Call) and isinstance(node.func, ast.Name) and not node.keywords:
            args = [self.visit(arg) for arg in node.args]
            if node.func.id == "rect" and len(args) == 4:
                return [round(v) for v in args]
            if node.func.id.startswith("cut"):
                return self.cut(node.func.id[3:], args)
        raise ValueError(f"Unsupported BetterGI expression: {ast.dump(node)}")

    def cut(self, side, args):
        w, h = self.width, self.height
        if side in ("Left", "Right") and len(args) == 1:
            return [int(w * (1 - args[0])) if side == "Right" else 0, 0, int(w * args[0]), h]
        if side in ("Top", "Bottom") and len(args) == 1:
            return [0, int(h * (1 - args[0])) if side == "Bottom" else 0, w, int(h * args[0])]
        if side in ("LeftTop", "RightTop", "LeftBottom", "RightBottom") and len(args) == 2:
            return [int(w * (1 - args[0])) if side.startswith("Right") else 0,
                    int(h * (1 - args[1])) if side.endswith("Bottom") else 0,
                    int(w * args[0]), int(h * args[1])]
        raise ValueError(f"Invalid BetterGI rectangle function: cut{side}")


def expand_percent(value):
    if isinstance(value, dict):
        value = [field(value, side) for side in ("left", "top", "right", "bottom")]
    values = [float(v) for v in value]
    if len(values) not in (1, 2, 4) or any(not math.isfinite(v) or v < 0 for v in values):
        raise ValueError("expandPercent needs 1, 2 or 4 finite nonnegative numbers")
    return values * 4 if len(values) == 1 else values * 2 if len(values) == 2 else values


def load_recognition(path, object_name, width, height, extra=None):
    path = Path(path).resolve()
    config = json.loads(path.read_text(encoding="utf-8-sig"))
    result = copy.deepcopy(config["objects"][object_name])
    evaluator = RectExpression(config, width, height, extra)
    if result.get("roi"):
        result["roi"] = evaluator.rectangle(result["roi"])
    for parent, key in (("reference", "bbox"), ("search", "box")):
        if result.get(parent, {}).get(key):
            result[parent][key] = evaluator.rectangle(result[parent][key])
    if result.get("search", {}).get("expandPercent") is not None:
        result["search"]["expandPercent"] = expand_percent(result["search"]["expandPercent"])
    if result["type"] == "TemplateMatch":
        name = resolve_alias(result["template"], config.get("templates", {})).replace("\\", "/")
        folder = path.parent / f"{width}x{height}"
        if not folder.is_dir():
            folder = path.parent / "1920x1080"
        template_path = (folder / name).resolve()
        if not template_path.is_relative_to(folder.resolve()):
            raise ValueError("A template must stay inside its asset directory")
        if not template_path.is_file():
            raise FileNotFoundError(template_path)
        result["template"] = name
        result["template_path"] = str(template_path)
        result["template_scale"] = min(width / 1920, 1)
        result.setdefault("name", Path(name).stem)
    else:
        result.setdefault("name", object_name)
    return result


@dataclass
class Image:
    pixels: np.ndarray
    kind: str = "Mat"
    x: int = 0
    y: int = 0
    global_x: int = 0
    global_y: int = 0
    text: str = ""
    reference_allowed: bool = False

    @property
    def width(self):
        return self.pixels.shape[1]

    @property
    def height(self):
        return self.pixels.shape[0]


def effective_search(image, recognition):
    roi = rect(field(recognition, "roi", "RegionOfInterest", default=[0, 0, 0, 0]))
    if roi != (0, 0, 0, 0):
        return clamp_rect(roi, image.width, image.height), None
    reference = field(recognition, "reference", default={}) or {}
    options = field(recognition, "search", "SearchOptions", default=None)
    ref_size = field(recognition, "ReferenceImageSize", default=field(reference, "size"))
    ref_box = field(recognition, "ReferenceBoundingBox", default=field(reference, "bbox"))
    if ref_size is None and ref_box is None and options is None:
        return (0, 0, image.width, image.height), None
    if ref_size is None or ref_box is None or not image.reference_allowed:
        return None
    rw, rh = size(ref_size)
    rx, ry, bw, bh = rect(ref_box)
    if min(rw, rh, bw, bh) <= 0:
        return None
    options = options or {}
    anchor = str(field(options, "anchor", "AnchorMode", default="Auto")).lower()
    anchors = {"topleft": (0, 0), "topright": (1, 0), "bottomleft": (0, 1),
               "bottomright": (1, 1), "center": (.5, .5)}
    ax, ay = anchors.get(anchor, (0 if rx + bw / 2 < rw * .4 else 1 if rx + bw / 2 > rw * .6 else .5,
                                  0 if ry + bh / 2 < rh * .4 else 1 if ry + bh / 2 > rh * .6 else .5))
    scale = min(image.width / rw, image.height / rh)
    ox, oy = (image.width - rw * scale) * ax, (image.height - rh * scale) * ay
    sx, sy, sw, sh = rect(field(options, "box", "ReferenceSearchBox", default=ref_box))
    if sw <= 0 or sh <= 0:
        return None
    left, top = round(ox + sx * scale), round(oy + sy * scale)
    right, bottom = round(ox + (sx + sw) * scale), round(oy + (sy + sh) * scale)
    right, bottom = max(left + 1, right), max(top + 1, bottom)
    percent = field(options, "expandPercent")
    if percent is not None:
        try:
            l, t, r, b = expand_percent(percent)
        except (TypeError, ValueError):
            return None
        l, t, r, b = l * image.width, t * image.height, r * image.width, b * image.height
    else:
        l, t = size(field(options, "expand", "ExpandSize", default=[10, 10]))
        r, b = l, t
    left, right = (round(min(image.width, max(0, v))) for v in (left - l, right + r))
    top, bottom = (round(min(image.height, max(0, v))) for v in (top - t, bottom + b))
    target = max(1, round(bw * scale)), max(1, round(bh * scale))
    if right <= left or bottom <= top:
        return None
    return (left, top, right - left, bottom - top), target


def template_matches(source, template, mode, mask, threshold, maximum):
    if source.size == 0 or template.size == 0:
        return []
    h, w = template.shape[:2]
    if source.shape[0] < h or source.shape[1] < w:
        return []
    if maximum < 0:
        maximum = source.shape[0] * source.shape[1] // w // h
    if maximum <= 0:
        return []
    response = cv2.matchTemplate(source, template, mode, mask=mask)
    if mode in (cv2.TM_SQDIFF, cv2.TM_CCOEFF, cv2.TM_CCORR):
        response = cv2.normalize(response, None, 0, 1, cv2.NORM_MINMAX)
    lower = mode in (cv2.TM_SQDIFF, cv2.TM_SQDIFF_NORMED)
    cutoff = 1 - threshold if lower else threshold
    valid = np.isfinite(response) & ((response <= cutoff) if lower else (response >= cutoff))
    results = []
    dx, dy = math.floor(w / 3) + 1, math.floor(h / 3) + 1
    while len(results) < maximum and np.any(valid):
        scores = np.where(valid, response, np.inf if lower else -np.inf)
        index = np.argmin(scores) if lower else np.argmax(scores)
        y, x = np.unravel_index(index, response.shape)
        raw = float(response[y, x])
        results.append((int(x), int(y), 1 - raw if lower else raw))
        x0, x1 = max(0, x - dx), min(response.shape[1], x + dx + 1)
        y0, y1 = max(0, y - dy), min(response.shape[0], y + dy + 1)
        yy, xx = np.ogrid[y0:y1, x0:x1]
        intersection = np.maximum(0, w - np.abs(xx - x)) * np.maximum(0, h - np.abs(yy - y))
        valid[y0:y1, x0:x1] &= intersection / (w * h * 2 - intersection) < .5
    return results


class PaddleOcr:
    """CPU inference using BetterGI's original V5 mobile detector/recognizer."""

    def __init__(self, model_root):
        import onnxruntime as ort
        import yaml

        if model_root is None:
            raise FileNotFoundError("Set BETTERGI_MODEL_ROOT or --model-root to the original Assets/Model directory")
        self.root = Path(model_root).resolve()
        base = self.root / "PaddleOCR"
        self.det_path = base / "Det/V5/PP-OCRv5_mobile_det_infer/slim.onnx"
        self.rec_path = base / "Rec/V5/PP-OCRv5_mobile_rec_infer/slim.onnx"
        self.labels_path = self.rec_path.with_name("inference.yml")
        for path in (self.det_path, self.rec_path, self.labels_path):
            if not path.is_file():
                raise FileNotFoundError(path)
        config = yaml.safe_load(self.labels_path.read_text(encoding="utf-8-sig"))
        self.labels = config["PostProcess"]["character_dict"]
        options = ort.SessionOptions()
        options.intra_op_num_threads = max(1, min(4, os.cpu_count() or 1))
        options.inter_op_num_threads = 1
        self.det = ort.InferenceSession(str(self.det_path), options, providers=["CPUExecutionProvider"])
        self.rec = ort.InferenceSession(str(self.rec_path), options, providers=["CPUExecutionProvider"])

    @staticmethod
    def ordered_box(points):
        points = np.array(sorted(points, key=lambda p: p[0]), dtype=np.float32)
        left = sorted(points[:2], key=lambda p: p[1])
        right = sorted(points[2:], key=lambda p: p[1])
        return np.array([left[0], right[0], right[1], left[1]], dtype=np.float32)

    def detection(self, image):
        import pyclipper

        image = bgr(image)
        original_h, original_w = image.shape[:2]
        if original_h + original_w < 64:
            image = cv2.copyMakeBorder(image, 0, max(32 - original_h, 0), 0, max(32 - original_w, 0), cv2.BORDER_CONSTANT)
        h, w = image.shape[:2]
        ratio = min(1, 960 / max(h, w))
        rh, rw = int(h * ratio), int(w * ratio)
        if max(rh, rw) > 4000:
            cap = 4000 / max(rh, rw)
            rh, rw = int(rh * cap), int(rw * cap)
        rh, rw = max(32, round(rh / 32) * 32), max(32, round(rw / 32) * 32)
        resized = cv2.resize(image, (rw, rh)).astype(np.float32) / 255
        resized = (resized - np.array([.485, .456, .406], dtype=np.float32)) / np.array([.229, .224, .225], dtype=np.float32)
        tensor = np.ascontiguousarray(resized.transpose(2, 0, 1)[None])
        prediction = self.det.run(None, {self.det.get_inputs()[0].name: tensor})[0][0, 0, :rh, :rw]
        bitmap = (prediction > .3).astype(np.uint8) * 255
        contours, _ = cv2.findContours(bitmap, cv2.RETR_LIST, cv2.CHAIN_APPROX_SIMPLE)
        boxes = []
        for contour in contours[:1000]:
            fitted = cv2.minAreaRect(contour)
            if min(fitted[1]) < 3:
                continue
            points = self.ordered_box(cv2.boxPoints(fitted))
            xmin, ymin = np.floor(points.min(axis=0)).astype(int)
            xmax, ymax = np.ceil(points.max(axis=0)).astype(int)
            xmin, ymin = max(0, xmin), max(0, ymin)
            xmax, ymax = min(prediction.shape[1] - 1, xmax), min(prediction.shape[0] - 1, ymax)
            mask = np.zeros((ymax - ymin + 1, xmax - xmin + 1), dtype=np.uint8)
            cv2.fillPoly(mask, [(points - [xmin, ymin]).astype(np.int32)], 1)
            score = cv2.mean(prediction[ymin:ymax + 1, xmin:xmax + 1], mask)[0]
            if score < .6:
                continue
            area, length = cv2.contourArea(points), cv2.arcLength(points, True)
            if length <= 0:
                continue
            offset = pyclipper.PyclipperOffset()
            offset.AddPath(points.astype(np.int64).tolist(), pyclipper.JT_ROUND, pyclipper.ET_CLOSEDPOLYGON)
            expanded = offset.Execute(area * 1.5 / length)
            if len(expanded) != 1:
                continue
            fitted = cv2.minAreaRect(np.asarray(expanded[0], dtype=np.float32))
            if min(fitted[1]) < 5:
                continue
            points = self.ordered_box(cv2.boxPoints(fitted))
            points[:, 0] = np.clip(np.rint(points[:, 0] / prediction.shape[1] * original_w), 0, original_w - 1)
            points[:, 1] = np.clip(np.rint(points[:, 1] / prediction.shape[0] * original_h), 0, original_h - 1)
            if int(np.linalg.norm(points[0] - points[1])) <= 3 or int(np.linalg.norm(points[0] - points[3])) <= 3:
                continue
            boxes.append(points)
        boxes.sort(key=lambda p: (p[0, 1], p[0, 0]))
        for i in range(len(boxes) - 1):
            j = i
            while j >= 0 and abs(boxes[j + 1][0, 1] - boxes[j][0, 1]) < 10 and boxes[j + 1][0, 0] < boxes[j][0, 0]:
                boxes[j], boxes[j + 1] = boxes[j + 1], boxes[j]
                j -= 1
        return boxes

    def recognize(self, crop):
        crop = bgr(crop)
        h, w = crop.shape[:2]
        width = max(1, math.ceil(w / h * 48))
        tensor = cv2.resize(crop, (width, 48)).astype(np.float32)
        tensor = np.ascontiguousarray(((tensor - 127.5) * (2 / 255)).transpose(2, 0, 1)[None])
        output = self.rec.run(None, {self.rec.get_inputs()[0].name: tensor})[0][0]
        indices = output.argmax(axis=1)
        probabilities = output.max(axis=1)
        text, confidence, previous = [], [], 0
        for index, probability in zip(indices, probabilities):
            if index > 0 and index != previous:
                if index == len(self.labels) + 1:
                    text.append(" ")
                elif index <= len(self.labels):
                    text.append(self.labels[index - 1])
                else:
                    raise ValueError(f"CTC label index {index} exceeds original character dictionary")
                confidence.append(float(probability))
            previous = index
        decoded = "".join(text)
        text_length = len(decoded.encode("utf-16-le")) // 2
        return decoded, sum(confidence) / text_length if text_length else 0

    def run(self, image):
        image = bgr(image)
        results = []
        for points in self.detection(image):
            w = int(max(np.linalg.norm(points[0] - points[1]), np.linalg.norm(points[2] - points[3])))
            h = int(max(np.linalg.norm(points[0] - points[3]), np.linalg.norm(points[1] - points[2])))
            target = np.array([[0, 0], [w, 0], [w, h], [0, h]], dtype=np.float32)
            transform = cv2.getPerspectiveTransform(points, target)
            crop = cv2.warpPerspective(image, transform, (w, h), flags=cv2.INTER_CUBIC, borderMode=cv2.BORDER_REPLICATE)
            if h / w >= 1.5:
                crop = cv2.rotate(crop, cv2.ROTATE_90_COUNTERCLOCKWISE)
            text, score = self.recognize(crop)
            if score >= .5 and text:
                x, y, bw, bh = cv2.boundingRect(points)
                results.append({"rect": [x, y, bw, bh], "text": text, "score": score, "points": points.tolist()})
        return results

    def status(self):
        return {"backend": "onnxruntime", "providers": self.det.get_providers(),
                "model": "BetterGI PaddleOCR V5 mobile",
                "models": [{"path": str(p), "sha256": hashlib.sha256(p.read_bytes()).hexdigest()}
                           for p in (self.det_path, self.rec_path, self.labels_path)],
                "geometry": "pyclipper (Clipper1); upstream uses Clipper2"}


class VisionBridge:
    def __init__(self, model_root=None):
        self.images = {}
        self.next_handle = 1
        self.model_root = model_root or os.environ.get("BETTERGI_MODEL_ROOT")
        self.ocr_engine = None
        self.map_vision = None
        self.yolo_vision = None
        self.realtime_vision = None
        self.party_vision = None
        self.party_grid_vision = None
        self.fishing_vision = None
        self.fight_vision = None
        self.music_vision = None
        self.inventory_vision = None
        self.tcg_vision = None
        self.reward_vision = None
        self.salvage_vision = None

    def put(self, pixels, kind="Mat", **kwargs):
        handle = self.next_handle
        self.next_handle += 1
        self.images[handle] = Image(pixels=pixels, kind=kind, **kwargs)
        return self.descriptor(handle)

    @staticmethod
    def handle(value):
        return int(field(value, "handle")) if isinstance(value, dict) else int(value)

    def image(self, value):
        handle = self.handle(value)
        if handle not in self.images:
            raise ValueError(f"Image handle {handle} is disposed or unknown")
        return self.images[handle]

    def descriptor(self, handle):
        image = self.images[handle]
        channels = image.pixels.shape[2] if image.pixels.ndim == 3 else 1
        return {"__bgiType": image.kind, "handle": handle, "x": image.x, "y": image.y,
                "width": image.width, "height": image.height, "globalX": image.global_x,
                "globalY": image.global_y, "channels": channels, "text": image.text, "matchScore": 0}

    @staticmethod
    def region(image=None, box=(0, 0, 0, 0), text="", score=0):
        x, y, w, h = box
        return {"__bgiType": "Region", "handle": 0, "x": x, "y": y, "width": w,
                "height": h, "globalX": image.global_x + x if image else 0,
                "globalY": image.global_y + y if image else 0,
                "text": text, "matchScore": score, "channels": 0}

    def ocr(self):
        if self.ocr_engine is None:
            self.ocr_engine = PaddleOcr(self.model_root)
        return self.ocr_engine

    def template(self, recognition):
        value = field(recognition, "TemplateMat", "TemplateImageMat")
        if value is not None:
            return self.image(value).pixels
        path = field(recognition, "template_path", "template")
        if not path:
            raise ValueError("TemplateMatch requires TemplateImageMat or a template path")
        pixels = read_image(path, field(recognition, "templateMode", default="Color"))
        scale = float(field(recognition, "template_scale", default=1))
        if not math.isfinite(scale) or scale <= 0:
            raise ValueError("Template scale must be positive and finite")
        if scale != 1:
            pixels = cv2.resize(pixels, (max(1, round(pixels.shape[1] * scale)), max(1, round(pixels.shape[0] * scale))))
        return pixels

    def find_template(self, image, recognition, multi):
        search = effective_search(image, recognition)
        if search is None:
            return []
        (rx, ry, rw, rh), target = search
        if min(rw, rh) <= 0:
            return []
        template = self.template(recognition)
        mask_value = field(recognition, "MaskMat")
        mask = self.image(mask_value).pixels if mask_value is not None else None
        if mask is None and field(recognition, "useMask", default=False):
            color = field(recognition, "maskColor", default="#00FF00")
            if isinstance(color, str):
                value = color.lstrip("#")
                if len(value) != 6:
                    raise ValueError("MaskColor needs an RGB hex color")
                color = [int(value[i:i + 2], 16) for i in (4, 2, 0)]
            elif isinstance(color, dict):
                color = [field(color, c) for c in ("B", "G", "R")]
            else:
                color = list(reversed(color[:3]))
            mask = cv2.bitwise_not(cv2.inRange(bgr(template), tuple(color), tuple(color)))
        if target is not None and template.shape[1::-1] != target:
            template = cv2.resize(template, target)
        if mask is not None and mask.shape[:2] != template.shape[:2]:
            mask = cv2.resize(mask, template.shape[1::-1], interpolation=cv2.INTER_NEAREST)
        source = image.pixels[ry:ry + rh, rx:rx + rw]
        if field(recognition, "use3Channels", default=False):
            source, template = bgr(source), bgr(template)
        else:
            source = gray(source)
            grey_mat = field(recognition, "TemplateImageGreyMat")
            template = gray(self.image(grey_mat).pixels) if grey_mat is not None else gray(template)
            if target is not None and template.shape[1::-1] != target:
                template = cv2.resize(template, target)
            if field(recognition, "UseBinaryMatch", default=False):
                _, source = cv2.threshold(source, field(recognition, "BinaryThreshold", default=128), 255, cv2.THRESH_BINARY)
        mode = enum_value(field(recognition, "TemplateMatchMode", "mode", default="CCoeffNormed"), "TM_")
        count = int(field(recognition, "MaxMatchCount", default=-1)) if multi else 1
        matches = template_matches(source, template, mode, mask, float(field(recognition, "threshold", default=.8)), count)
        return [self.region(image, (x + rx, y + ry, template.shape[1], template.shape[0]), score=score) for x, y, score in matches]

    @staticmethod
    def replace_text(text, recognition):
        replacements = field(recognition, "replace", "ReplaceDictionary", default={}) or {}
        for expected, alternatives in replacements.items():
            for value in alternatives:
                text = text.replace(value, expected)
        return text

    def find_ocr(self, image, recognition, multi):
        kind = str(field(recognition, "type", "RecognitionType", default="Ocr")).lower()
        all_text = field(recognition, "allContains", "AllContainMatchText", default=[])
        one_text = field(recognition, "oneContains", "OneContainMatchText", default=[])
        patterns = field(recognition, "regex", "RegexMatchText", default=[])
        if not multi and kind == "ocrmatch" and not (all_text or one_text or patterns):
            raise ValueError("OcrMatch requires allContains, oneContains or regex")
        search = effective_search(image, recognition)
        if search is None:
            return []
        (rx, ry, rw, rh), _ = search
        if min(rw, rh) <= 0:
            return []
        source = image.pixels[ry:ry + rh, rx:rx + rw]
        if kind == "colorrangeandocr":
            code = enum_value(field(recognition, "colorCode", "ColorConversionCode", default="BGR2RGB"), "COLOR_")
            if code != cv2.COLOR_BGRA2BGR:
                source = cv2.cvtColor(source, code)
            source = cv2.inRange(source, self.scalar(field(recognition, "lowerColor")), self.scalar(field(recognition, "upperColor")))
        lines = self.ocr().run(source)
        if multi:
            results = []
            for line in lines:
                x, y, w, h = clamp_rect(line["rect"], rw, rh)
                if w > 0 and h > 0:
                    results.append(self.region(image, (x + rx, y + ry, w, h), self.replace_text(line["text"], recognition), line["score"]))
            return results
        text = self.replace_text(re.sub(r"\s+", "", "\n".join(line["text"] for line in lines)), recognition)
        if kind == "ocrmatch":
            if not all(value in text for value in all_text) or (one_text and not any(value in text for value in one_text)) or not all(re.search(value, text) for value in patterns):
                return []
            explicit = rect(field(recognition, "roi", "RegionOfInterest", default=[0, 0, 0, 0]))
            return [self.region(image, explicit if search[1] is None else (rx, ry, rw, rh))]
        elif not text:
            return []
        else:
            raw_roi = rect(field(recognition, "roi", "RegionOfInterest", default=[0, 0, 0, 0]))
            if raw_roi == (0, 0, 0, 0) and search[1] is None:
                image.text = text
                for handle, candidate in self.images.items():
                    if candidate is image:
                        return [self.descriptor(handle)]
        return [self.region(image, (rx, ry, rw, rh), text)]

    @staticmethod
    def scalar(value):
        if isinstance(value, dict):
            value = [field(value, f"val{i}", default=0) for i in range(4)]
        if isinstance(value, (list, tuple)):
            return tuple(float(v) for v in value)
        return float(value)

    def mat(self, args):
        method = str(args["method"]).replace("_", "").lower()
        values = args.get("args", [])
        if method in ("contourarea", "boundingrect"):
            contour = np.asarray([[field(p, "x"), field(p, "y")] if isinstance(p, dict) else p for p in values[0]], np.float32)
            if method == "contourarea":
                return cv2.contourArea(contour, oriented=bool(values[1]) if len(values) > 1 else False)
            x, y, w, h = cv2.boundingRect(contour)
            return {"x": x, "y": y, "width": w, "height": h}
        if method == "getstructuringelement":
            return self.put(cv2.getStructuringElement(enum_value(values[0], "MORPH_"), size(values[1])))
        if method in ("new", "zeros", "ones"):
            h, w = (int(values[0]), int(values[1])) if len(values) >= 2 else (0, 0)
            channels = int(args.get("channels", 3))
            shape = (h, w) if channels == 1 else (h, w, channels)
            return self.put(np.ones(shape, np.uint8) if method == "ones" else np.zeros(shape, np.uint8))
        image = self.image(args["handle"])
        pixels = image.pixels
        if method in ("roi", "submat"):
            x, y, w, h = rect(values[0])
            if min(x, y, w, h) < 0 or x + w > image.width or y + h > image.height:
                raise ValueError("Mat ROI must be inside its parent")
            return self.put(pixels[y:y + h, x:x + w])
        if method == "setto":
            value = self.scalar(values[0])
            if isinstance(value, tuple):
                value = value[:pixels.shape[2]] if pixels.ndim == 3 else value[0]
            if len(values) > 1:
                pixels[self.image(values[1]).pixels != 0] = value
            else:
                pixels[:] = value
            return self.descriptor(self.handle(args["handle"]))
        if method == "empty":
            return pixels.size == 0
        if method == "width" or method == "cols":
            return image.width
        if method == "height" or method == "rows":
            return image.height
        if method == "channels":
            return pixels.shape[2] if pixels.ndim == 3 else 1
        if method == "size":
            return {"width": image.width, "height": image.height}
        if method in ("at", "get"):
            y, x = int(values[0]), int(values[1])
            if not 0 <= y < image.height or not 0 <= x < image.width:
                raise IndexError("Pixel index outside image")
            return pixels[y, x].tolist()
        if method == "countnonzero":
            return int(cv2.countNonZero(pixels))
        if method == "minmaxloc":
            minimum, maximum, minpoint, maxpoint = cv2.minMaxLoc(pixels)
            return {"minVal": minimum, "maxVal": maximum, "minLoc": list(minpoint), "maxLoc": list(maxpoint)}
        if method in ("findcontours", "findcontoursasarray"):
            retrieval = enum_value(values[0], "RETR_") if values else cv2.RETR_LIST
            approximation = enum_value(values[1], "CHAIN_APPROX_") if len(values) > 1 else cv2.CHAIN_APPROX_SIMPLE
            contours, hierarchy = cv2.findContours(pixels, retrieval, approximation)
            points = [[{"x": int(x), "y": int(y)} for x, y in contour.reshape(-1, 2)] for contour in contours]
            return points if method == "findcontoursasarray" else {"contours": points, "hierarchy": hierarchy[0].tolist() if hierarchy is not None else []}
        if method == "clone" or method == "copyto":
            result = pixels.copy()
        elif method == "cvtcolor":
            result = cv2.cvtColor(pixels, enum_value(values[0], "COLOR_"))
        elif method == "inrange":
            result = cv2.inRange(pixels, self.scalar(values[0]), self.scalar(values[1]))
        elif method == "resize":
            target = size(values[0])
            fx, fy = (values[1:3] + [0, 0])[:2] if len(values) > 1 else (0, 0)
            interpolation = enum_value(values[3], "INTER_") if len(values) > 3 else cv2.INTER_LINEAR
            result = cv2.resize(pixels, target, fx=float(fx), fy=float(fy), interpolation=interpolation)
        elif method == "threshold":
            threshold_type = enum_value(values[2], "THRESH_") if len(values) > 2 else cv2.THRESH_BINARY
            _, result = cv2.threshold(pixels, float(values[0]), float(values[1]), threshold_type)
        elif method == "bitwisenot":
            result = cv2.bitwise_not(pixels)
        elif method in ("bitwiseand", "bitwiseor", "absdiff"):
            other = self.image(values[0]).pixels
            function = {"bitwiseand": cv2.bitwise_and, "bitwiseor": cv2.bitwise_or, "absdiff": cv2.absdiff}[method]
            result = function(pixels, other)
        elif method == "gaussianblur":
            result = cv2.GaussianBlur(pixels, size(values[0]), float(values[1]))
        elif method in ("morphologyex", "erode", "dilate"):
            if method == "morphologyex":
                operation, kernel = enum_value(values[0], "MORPH_"), self.image(values[1]).pixels
                result = cv2.morphologyEx(pixels, operation, kernel)
            else:
                result = getattr(cv2, method)(pixels, self.image(values[0]).pixels)
        else:
            raise NotImplementedError(f"OpenCV Mat.{args['method']} is not implemented")
        if args.get("destination") is not None:
            handle = self.handle(args["destination"])
            self.image(handle).pixels = result
            return self.descriptor(handle)
        return self.put(result)

    def dispatch(self, op, args):
        if op.startswith("salvage."):
            if self.salvage_vision is None:
                from salvage_vision import SalvageVision
                self.salvage_vision = SalvageVision(self)
            return self.salvage_vision.dispatch(op, args)
        if op.startswith("reward."):
            if self.reward_vision is None:
                from reward_vision import RewardVision
                self.reward_vision = RewardVision(self)
            return self.reward_vision.dispatch(op, args)
        if op == "combo.burstSidebar":
            from combo_vision import burst_sidebar
            return burst_sidebar(self.image(args["handle"]).pixels, args.get("index", 1), args.get("qRect"))
        if op.startswith("tcg."):
            if self.tcg_vision is None:
                from tcg_vision import TcgVision
                self.tcg_vision = TcgVision(self)
            return self.tcg_vision.dispatch(op, args)
        if op.startswith("music."):
            if self.music_vision is None:
                from music_vision import MusicVision
                self.music_vision = MusicVision(self)
            return self.music_vision.dispatch(op, args)
        if op.startswith("inventory."):
            if self.inventory_vision is None:
                from inventory_vision import InventoryVision
                self.inventory_vision = InventoryVision(self)
            return self.inventory_vision.dispatch(op, args)
        if op in ("party.grid", "party.gridMetadata", "party.gridModelStatus"):
            if self.party_grid_vision is None:
                from party_grid_vision import PartyGridVision
                self.party_grid_vision = PartyGridVision(self)
            return self.party_grid_vision.dispatch(op, args)
        if op.startswith("fishing."):
            if self.fishing_vision is None:
                from fishing_vision import FishingVision
                self.fishing_vision = FishingVision(self)
            return self.fishing_vision.dispatch(op, args)
        if op.startswith("fight."):
            if self.fight_vision is None:
                from fight_vision import FightVision
                self.fight_vision = FightVision(self)
            return self.fight_vision.dispatch(op, args)
        if op.startswith("party."):
            if self.party_vision is None:
                from party_vision import PartyVision
                self.party_vision = PartyVision(self)
            return self.party_vision.dispatch(op, args)
        if op.startswith("realtime."):
            if self.realtime_vision is None:
                from realtime_vision import RealtimeVision
                self.realtime_vision = RealtimeVision(self)
            return self.realtime_vision.dispatch(op, args, self.image(args["handle"]).pixels)
        if op.startswith("yolo."):
            if self.yolo_vision is None:
                from yolo_vision import YoloVision
                self.yolo_vision = YoloVision(self)
            return self.yolo_vision.dispatch(op, args)
        if op.startswith("map."):
            if self.map_vision is None:
                from map_vision import MapVision
                self.map_vision = MapVision()
            pixels = None if op == "map.status" else self.image(args["handle"]).pixels
            return self.map_vision.dispatch(op, args, pixels)
        if op == "image.load":
            kind = args.get("type", "Mat")
            if kind not in ("Mat", "ImageRegion"):
                raise ValueError("Images must be Mat or ImageRegion")
            return self.put(read_image(args["path"], args.get("mode", "Color")), kind,
                            x=int(args.get("x", 0)), y=int(args.get("y", 0)),
                            global_x=int(args.get("globalX", args.get("x", 0))),
                            global_y=int(args.get("globalY", args.get("y", 0))),
                            reference_allowed=kind == "ImageRegion")
        if op == "image.crop":
            image = self.image(args["handle"])
            x, y, w, h = clamp_rect([args[k] for k in ("x", "y", "width", "height")], image.width, image.height)
            if min(w, h) <= 0:
                raise ValueError("Crop rectangle has no pixels inside the source image")
            return self.put(image.pixels[y:y + h, x:x + w].copy(), "ImageRegion", x=x, y=y,
                            global_x=image.global_x + x, global_y=image.global_y + y)
        if op == "image.ocrWithoutDetector":
            text, score = self.ocr().recognize(self.image(args["handle"]).pixels)
            return {"text": text, "score": float(score)}
        if op in ("image.find", "image.findMulti", "image.ocr"):
            image = self.image(args["handle"])
            recognition = args.get("recognition") or {"type": "Ocr"}
            multi = op != "image.find"
            kind = str(field(recognition, "type", "RecognitionType", default="TemplateMatch")).lower()
            if op == "image.ocr":
                kind = "ocr"
            if kind == "templatematch":
                results = self.find_template(image, recognition, multi)
            elif kind in ("ocr", "ocrmatch", "colorrangeandocr"):
                results = self.find_ocr(image, recognition, multi)
            else:
                raise NotImplementedError(f"ImageRegion recognition type {kind} is not supported by upstream ImageRegion")
            return results if multi else results[0] if results else self.region()
        if op == "image.dispose":
            self.images.pop(self.handle(args["handle"]), None)
            return None
        if op == "image.save":
            path = Path(args["path"])
            success, encoded = cv2.imencode(path.suffix or ".png", self.image(args["handle"]).pixels)
            if not success:
                raise ValueError(f"Unable to encode image: {path}")
            path.write_bytes(encoded.tobytes())
            return {"path": str(path.resolve())}
        if op == "image.mat":
            return self.mat(args)
        if op == "recognition.load":
            return load_recognition(args["path"], args["objectName"], int(args["width"]), int(args["height"]), args.get("extraParameters"))
        if op == "recognition.evaluate":
            evaluator = RectExpression(args, args["width"], args["height"], args.get("extraParameters"))
            return evaluator.evaluate(args["expression"])
        if op == "vision.status":
            result = {"opencv": cv2.__version__, "numpy": np.__version__, "upstreamCommit": UPSTREAM_COMMIT,
                      "imageHandles": len(self.images), "modelRoot": self.model_root, "ocrLoaded": self.ocr_engine is not None}
            if args.get("loadOcr"):
                self.ocr()
                result["ocrLoaded"] = True
            if self.ocr_engine:
                result["ocr"] = self.ocr_engine.status()
            return result
        raise NotImplementedError(f"Unknown vision operation: {op}")


def serve(bridge, source=sys.stdin, target=sys.stdout):
    for line in source:
        request = None
        try:
            request = json.loads(line)
            response = {"id": request.get("id"), "result": bridge.dispatch(request["op"], request.get("args", {}))}
            encoded = json.dumps(response, ensure_ascii=False, allow_nan=False)
        except Exception as error:
            encoded = json.dumps({"id": request.get("id") if isinstance(request, dict) else None,
                                  "error": {"name": type(error).__name__, "message": str(error)}}, ensure_ascii=False)
        target.write(encoded + "\n")
        target.flush()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--model-root", default=os.environ.get("BETTERGI_MODEL_ROOT"))
    options = parser.parse_args()
    serve(VisionBridge(options.model_root))
