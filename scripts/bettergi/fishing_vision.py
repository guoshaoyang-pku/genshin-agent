"""BetterGI AutoFishing observations, GPL-3.0.

Ported from AutoFishingImageRecognition, Fishpond, Behaviours/PartII and the
original ItemIconRecognizer at c9db8b8291fe4ac25a600aee1582298005919eb2.
Models, templates and catalogs are read from the retained upstream resources.
Timers, RodNet, input and inventory evidence belong to the JS lifecycle.
"""
from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
import os
from pathlib import Path
import re

import cv2
import numpy as np
import onnxruntime as ort

from yolo_vision import YoloPredictor

VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
UI_NAMES = ("SpaceButton", "BaitButton", "WaitBiteButton", "LiftRodButton", "ExitFishingButton")


def box(x, y, width, height):
    return dict(x=int(x), y=int(y), width=int(width), height=int(height))


def rectangle(value):
    values = [value.get(k) for k in ("x", "y", "width", "height")] if isinstance(value, dict) else []
    if len(values) != 4 or any(not isinstance(v, (int, float)) or isinstance(v, bool)
                              or not math.isfinite(v) or int(v) != v for v in values):
        raise ValueError("Fishing rectangle requires finite integer x, y, width and height")
    return tuple(map(int, values))


def bgr(pixels):
    if not isinstance(pixels, np.ndarray) or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Fishing vision requires nonempty uint8 pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Fishing vision requires gray, BGR or BGRA pixels")
    return pixels


def crop(pixels, rect, clamp=False):
    x, y, w, h = rectangle(rect)
    height, width = pixels.shape[:2]
    if clamp:
        right, bottom = max(0, min(width, x + w)), max(0, min(height, y + h))
        x, y = max(0, min(width, x)), max(0, min(height, y))
        w, h = right - x, bottom - y
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
        raise ValueError("Fishing crop is outside the capture")
    return pixels[y:y + h, x:x + w], box(x, y, w, h)


def load_catalog(source_root):
    folder = source_root / "GameTask/AutoFishing/Model"
    bait_source = (folder / "BaitType.cs").read_text(encoding="utf-8-sig")
    baits = [dict(name=name, description=description) for description, name in
             re.findall(r'\[Description\("([^"]+)"\)\]\s*(\w+)', bait_source)]
    bait_names = {v["name"]: v["description"] for v in baits}
    fish_source = (folder / "BigFishType.cs").read_text(encoding="utf-8-sig")
    declarations = re.findall(
        r'public static readonly BigFishType\s+(\w+)\s*=\s*new\s*\("([^"]+)",\s*BaitType\.(\w+),\s*"([^"]+)",\s*(\d+)\)',
        fish_source)
    entries = {symbol: dict(name=name, chineseName=chinese, baitType=bait,
                            baitName=bait_names[bait], netIndex=int(index))
               for symbol, name, bait, chinese, index in declarations}
    active = re.sub(r'//[^\n]*', '', fish_source)
    fishes = [entries[symbol] for symbol in re.findall(r'yield return\s+(\w+)\s*;', active)]
    if not baits or not fishes:
        raise ValueError("Original fishing catalog is empty or unsupported")
    return dict(fishTypes=fishes, baits=baits)


def _inside(outer, inner):
    ox, oy, ow, oh = rectangle(outer)
    x, y, w, h = rectangle(inner)
    return x >= ox and y >= oy and x + w <= ox + ow and y + h <= oy + oh


def fishpond(detections, width, height, catalog, include_target=False, ignore_obtained=False):
    types = {f["name"]: f for f in catalog["fishTypes"]}
    fishes, target = [], None
    for detection in detections:
        confidence = float(detection["confidence"])
        if confidence < .4:
            continue
        name, rect = detection["name"]["name"], box(*rectangle(detection["bounds"]))
        if name in ("rod", "err rod"):
            target = rect
            continue
        w, h = rect["width"], rect["height"]
        if ignore_obtained:
            left = box(int(.04375 * width), int(.4666 * height), int(.1 * width), int(.1 * width))
            center = box(int(.4 * width), int(.445 * height), int(.2 * width), int(.06125 * width))
            if w < width * .036 and h < width * .036 and _inside(left, rect):
                continue
            if width * .03 < w < width * .06 and width * .03 < h < width * .06 and _inside(center, rect):
                continue
        if include_target and name == "koi":
            continue
        if name not in types:
            raise KeyError(f"BigFishType {name} not found")
        fishes.append({**types[name], "rect": rect, "confidence": confidence})
    fishes.sort(key=lambda f: f["confidence"], reverse=True)
    pond = box(0, 0, 0, 0)
    if fishes:
        left = min(f["rect"]["x"] for f in fishes)
        top = min(f["rect"]["y"] for f in fishes)
        right = max(f["rect"]["x"] + f["rect"]["width"] for f in fishes)
        bottom = max(f["rect"]["y"] + f["rect"]["height"] for f in fishes)
        pond = box(left, top, right - left, bottom - top)
    return dict(width=width, height=height, detectionCount=len(detections),
                fishpondRect=pond, targetRect=target, fishes=fishes)


def rod_input(pond, width, height, selected_bait, ignored_baits=()):
    nw, nh = (1920, int(height / (width / 1920))) if width > 1920 else (width, height)
    result = dict(targetRect=pond["targetRect"], currentFish=None, rodInput=None,
                  dx=None, dy=None, distance=None, normalizationSize=dict(width=nw, height=nh))
    if pond["targetRect"] is None or rectangle(pond["targetRect"]) == (0, 0, 0, 0):
        return result
    rx, ry, rw, rh = rectangle(pond["targetRect"])
    candidates = [f for f in pond["fishes"] if f["baitType"] == selected_bait and f["baitType"] not in ignored_baits]
    if not candidates:
        return result
    # GetCenterPoint uses integer halves in the upstream Rect extension.
    def distance(fish):
        x, y, w, h = rectangle(fish["rect"])
        return math.hypot(x + w // 2 - (rx + rw // 2), y + h // 2 - (ry + rh // 2))
    current = sorted(candidates, key=lambda f: (distance(f), -f["confidence"]))[0]
    fx, fy, fw, fh = rectangle(current["rect"])
    dx = (fx + fx + fw - rx - rx - rw) / nw * 1024 / 2
    dy = (fy + fy + fh - ry - ry - rh) / nh * 576 / 2
    values = dict(rod_x1=rx / nw * 1024, rod_x2=(rx + rw) / nw * 1024,
                  rod_y1=ry / nh * 576, rod_y2=(ry + rh) / nh * 576,
                  fish_x1=fx / nw * 1024, fish_x2=(fx + fw) / nw * 1024,
                  fish_y1=fy / nh * 576, fish_y2=(fy + fh) / nh * 576,
                  fish_label=current["netIndex"])
    return {**result, "currentFish": current, "rodInput": values, "dx": dx, "dy": dy, "distance": math.hypot(dx, dy)}


def fish_bar_rects(pixels):
    try:
        hsv = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2HSV_FULL)
        hue, saturation, value = 60 / 255 * 180, .25 * 255, 255
        mask = cv2.inRange(hsv, (hue - 3, saturation - 20, value - 10), (hue + 3.5, saturation + 40, value))
        _, binary = cv2.threshold(mask, 0, 255, cv2.THRESH_BINARY)
        contours, _ = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        rects = [box(*cv2.boundingRect(c)) for c in contours if math.fmod(cv2.minAreaRect(c)[2], 45) <= 1]
        if not rects:
            return None
        widest = sorted(rects, key=lambda r: r["width"])[-1]
        return [r for r in rects if abs(widest["y"] + widest["height"] // 2 - r["y"] - r["height"] // 2) < widest["height"] // 5
                and abs(widest["height"] - r["height"]) < widest["height"] // 3
                and r["width"] > widest["height"] // 4]
    except (cv2.error, ValueError, TypeError):
        return None


def match_bite_words(pixels, area_width):
    rgb = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2RGB)
    mask = cv2.inRange(rgb, (253, 253, 253), (255, 255, 255))
    _, binary = cv2.threshold(mask, 0, 255, cv2.THRESH_BINARY)
    dilated = cv2.dilate(binary, cv2.getStructuringElement(cv2.MORPH_RECT, (20, 20)))
    contours, _ = cv2.findContours(dilated, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    rects = sorted((box(*cv2.boundingRect(c)) for c in contours), key=lambda r: r["height"], reverse=True)
    if rects:
        r = rects[0]
        if r["height"] < pixels.shape[0] and r["width"] / r["height"] >= 3 and area_width > r["width"] * 3 and r["x"] < area_width / 2 < r["x"] + r["width"]:
            return r
    return None


def fish_box(rects, width, height):
    result = dict(rect=None, barRects=rects, reason="bar-count")
    if rects is None or len(rects) != 2:
        return result
    if abs(rects[0]["height"] - rects[1]["height"]) > 10:
        return {**result, "reason": "height-difference"}
    cur, right = rects if rects[0]["width"] < rects[1]["width"] else reversed(rects)
    end = cur["x"] + cur["width"]
    if right["x"] < cur["x"] or cur["width"] > right["width"] or end > width // 2 or end > right["x"] - right["width"] // 2 or end > width // 2 - right["width"]:
        return {**result, "reason": "initial-geometry"}
    extra, vertical = cur["height"], cur["height"] // 4
    x, y = cur["x"] - extra, cur["y"] - vertical
    w, h = (width // 2 - cur["x"]) * 2 + extra * 2, cur["height"] + vertical * 2
    right_edge, bottom = max(0, min(width, x + w)), max(0, min(height, y + h))
    x, y = max(0, min(width, x)), max(0, min(height, y))
    return {**result, "rect": box(x, y, right_edge - x, bottom - y), "reason": None}


def control_observation(rects):
    source_count = len(rects) if rects is not None else 0
    if source_count > 3:
        rects = sorted(rects, key=lambda r: r["height"], reverse=True)[:3]
    result = dict(rects=rects, count=len(rects) if rects else 0, sourceCount=source_count,
                  desiredPressed=None, resetNoDetectionTimer=bool(rects), invalidTwoRects=False, missing=not bool(rects))
    if result["count"] == 2:
        cursor, target = rects if rects[0]["width"] < rects[1]["width"] else reversed(rects)
        if target["width"] < cursor["width"] * 10:
            return {**result, "resetNoDetectionTimer": False, "invalidTwoRects": True}
        result["desiredPressed"] = cursor["x"] < target["x"]
    elif result["count"] == 3:
        left, cursor, right = sorted(rects, key=lambda r: r["x"])
        result["rects"] = [left, cursor, right]
        result["desiredPressed"] = right["x"] + right["width"] - cursor["x"] - cursor["width"] > cursor["x"] - left["x"]
    return result


def _normalized(vector, label):
    vector = np.asarray(vector, dtype=np.float32)
    norm2 = 0.
    for value in vector:
        norm2 += float(value) * float(value)
    norm = math.sqrt(norm2)
    if norm <= 1e-12:
        raise ValueError(f"{label} 的 L2 范数为 0")
    return (vector.astype(np.float64) / norm).astype(np.float32)


class OriginalItemRecognizer:
    """Both upstream IItemIconRecognizer modes, with original ONNX/CSV data."""
    def __init__(self, model_root, mode="Item"):
        if mode not in ("Item", "GridIcon"):
            raise ValueError("Item recognition mode must be Item or GridIcon")
        self.mode = mode
        root = Path(model_root) / ("ItemV2" if mode == "Item" else "Item")
        self.path = root / ("item.onnx" if mode == "Item" else "gridIcon.onnx")
        self.table = root / ("item.csv" if mode == "Item" else "items.csv")
        options = ort.SessionOptions()
        options.intra_op_num_threads = 4
        self.session = ort.InferenceSession(str(self.path), sess_options=options, providers=["CPUExecutionProvider"])
        self.prototypes = []
        with self.table.open(encoding="utf-8-sig", newline="") as stream:
            if mode == "Item":
                rows = csv.DictReader(stream)
                required = {"item_name", "item_class_id", "quality_level", "embedding"}
                if not required.issubset(rows.fieldnames or []):
                    raise ValueError("ItemV2/item.csv 缺少必要字段")
                for row in rows:
                    name, class_id = row["item_name"].strip(), row["item_class_id"].strip()
                    quality = -1
                    if class_id.lower().startswith("relic:"):
                        try:
                            quality = int(row["quality_level"].strip())
                        except ValueError:
                            pass
                    vector = np.frombuffer(base64.b64decode(row["embedding"].strip(), validate=True), dtype="<f4").copy()
                    self.prototypes.append((name, quality, _normalized(vector, name)))
            else:
                metadata = self.session.get_modelmeta().custom_metadata_map
                if "prefix_list" not in metadata:
                    raise ValueError("模型文件缺少prefix_list")
                json.loads(metadata["prefix_list"])
                rows = csv.reader(stream)
                next(rows)
                names = set()
                for row in rows:
                    if row[0] in names:
                        raise ValueError("GridIcon prototype name is duplicated")
                    names.add(row[0])
                    vector = np.frombuffer(base64.b64decode(row[1], validate=True), dtype="<f4").copy()
                    self.prototypes.append((row[0], -1, vector))

    def recognize(self, pixels):
        pixels = bgr(pixels)
        if pixels.shape[:2] != (125, 125):
            raise ValueError("输入图标尺寸必须为125x125")
        rgb = pixels[:, :, ::-1].astype(np.float32) / np.float32(255)
        if self.mode == "Item":
            rgb = (rgb - np.float32(.5)) / np.float32(.5)
        outputs = self.session.run(None, {"input_image": np.ascontiguousarray(rgb.transpose(2, 0, 1)[None])})
        feature = np.asarray(outputs[0], np.float32).reshape(-1)
        if self.mode == "Item":
            feature = _normalized(feature, "物品图标模型特征向量")
            grouped = {}
            for name, quality, prototype in self.prototypes:
                if len(feature) != len(prototype):
                    raise ValueError("Item feature and prototype dimensions disagree")
                score = 0.
                for i in range(len(feature)):
                    score += float(prototype[i] * feature[i])
                key = (name, quality)
                grouped[key] = max(score, grouped.get(key, -math.inf))
            if not grouped:
                return dict(name=None, candidateName="", qualityLevel=-1, score=-float(np.finfo(np.float64).max), scoreKind="cosine")
            (name, quality), score = max(grouped.items(), key=lambda item: item[1])
            return dict(name=name if score >= .75 else None, candidateName=name, qualityLevel=quality, score=score, scoreKind="cosine")
        if not self.prototypes:
            raise ValueError("特征数据为空")
        distances = []
        for _, _, prototype in self.prototypes:
            distance = 0.
            for i in range(64):
                distance += math.pow(float(prototype[i] - feature[i]), 2.)
            distances.append(distance)
        index = min(range(len(distances)), key=distances.__getitem__)
        name, _, _ = self.prototypes[index]
        score = distances[index]
        return dict(name=name if score < 100 else None, candidateName=name,
                    qualityLevel=int(np.argmax(outputs[2])), score=score, scoreKind="squaredDistance")

    def status(self):
        return dict(mode=self.mode, prototypes=len(self.prototypes), providers=self.session.get_providers(),
                    files=[dict(path=str(p.resolve()), sha256=hashlib.sha256(p.read_bytes()).hexdigest()) for p in (self.path, self.table)])


class FishingVision:
    def __init__(self, bridge):
        self.bridge = bridge
        root = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source"))
        self.source_root = root if (root / "GameTask").is_dir() else root / "BetterGenshinImpact"
        self.model_root = Path(bridge.model_root or os.environ.get("BETTERGI_MODEL_ROOT") or VENDOR / "assets/bettergi.assets.model/Assets/Model")
        self.catalog = None
        self.predictor = None
        self.item_recognizers = {}
        self.recognitions = {}

    def _catalog(self):
        if self.catalog is None:
            self.catalog = load_catalog(self.source_root)
        return self.catalog

    def _predictor(self):
        if self.predictor is None:
            self.predictor = YoloPredictor(self.model_root / "Fish/bgi_fish.onnx", require_detection=True)
        return self.predictor

    def _items(self, mode):
        if mode not in self.item_recognizers:
            self.item_recognizers[mode] = OriginalItemRecognizer(self.model_root, mode)
        return self.item_recognizers[mode]

    def _find(self, image, name):
        if name not in UI_NAMES:
            raise ValueError(f"Unknown original fishing template: {name}")
        key = (image.width, image.height, name)
        if key not in self.recognitions:
            self.recognitions[key] = self.bridge.dispatch("recognition.load", {
                "path": str(self.source_root / "GameTask/AutoFishing/Assets/Recognition.json"),
                "objectName": name, "width": image.width, "height": image.height})
        matches = self.bridge.find_template(image, self.recognitions[key], False)
        return box(*(matches[0][k] for k in ("x", "y", "width", "height"))) if matches else None

    def _pond(self, image, args):
        predictions = self._predictor().predict(bgr(image.pixels))
        return fishpond(predictions, image.width, image.height, self._catalog(),
                        args.get("includeTarget", False), args.get("ignoreObtained", False))

    def _bait(self, pixels, mode):
        result = self._items(mode).recognize(pixels)
        bait = next((b for b in self._catalog()["baits"] if b["description"] == result["name"]), None)
        return dict(name=bait["description"] if bait else None, baitType=bait["name"] if bait else None,
                    score=result["score"], scoreKind=result["scoreKind"])

    def _bait_grid(self, image, mode):
        pixels, region = crop(bgr(image.pixels), box(round(.28 * image.width), round(.37 * image.height),
                                                   round(.45 * image.width), round(.22 * image.height)), clamp=True)
        edges = cv2.Canny(cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY), 20, 40)
        contours, _ = cv2.findContours(edges, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        results = []
        for contour in contours:
            x, y, w, h = cv2.boundingRect(contour)
            if w < .065 * image.width * .8 or h == 0 or abs(float(np.float32(w) / np.float32(h)) - .81) >= .05:
                continue
            icon = cv2.resize(pixels[y:y + h, x:x + w], (125, 153), interpolation=cv2.INTER_LINEAR)[:125, :125]
            results.append(dict(rect=box(region["x"] + x, region["y"] + y, w, h), **self._bait(icon, mode)))
        return results

    def _bite(self, image, text):
        roi = box(image.width // 3, 0, image.width // 3, image.height // 2)
        pixels, _ = crop(bgr(image.pixels), roi)
        tips = match_bite_words(pixels, roi["width"])
        result = dict(bite=False, method=None, wordsAreaRect=roi, tipsRect=None, text="")
        if tips is not None:
            return {**result, "bite": True, "method": "words", "tipsRect": {**tips, "x": tips["x"] + roi["x"], "y": tips["y"] + roi["y"]}}
        if self._find(image, "LiftRodButton") is not None:
            return {**result, "bite": True, "method": "template"}
        def center(line):
            if "points" in line:
                x, y = np.asarray(line["points"]).mean(axis=0)
            else:
                x, y, w, h = line["rect"]
                x, y = x + w / 2, y + h / 2
            return y, x
        recognized = "\n".join(line["text"] for line in sorted(self.bridge.ocr().run(pixels), key=center))
        clean = recognized.replace(" ", "").replace("\t", "")
        return {**result, "bite": bool(clean) and text in clean, "method": "ocr" if clean and text in clean else None, "text": recognized}

    def dispatch(self, op, args):
        if op == "fishing.catalog":
            return self._catalog()
        if op == "fishing.modelStatus":
            result = dict(fish=self._predictor().status())
            if args.get("includeItems", False):
                result["items"] = self._items(args.get("itemMode", "Item")).status()
            return result
        image = self.bridge.image(args["handle"])
        if op == "fishing.fishpond":
            return self._pond(image, args)
        if op == "fishing.rodInput":
            pond = args["fishpond"] if "fishpond" in args else self._pond(image, args)
            return rod_input(pond, image.width, image.height, args.get("selectedBait"), args.get("ignoredBaits", []))
        if op == "fishing.ui":
            return {name: self._find(image, name) for name in args.get("names", UI_NAMES)}
        if op == "fishing.baitGrid":
            return self._bait_grid(image, args.get("itemMode", "Item"))
        if op == "fishing.selectedBait":
            roi = box(int(.824 * image.width), int(.669 * image.height), int(.065 * image.width), int(.065 * image.width))
            pixels, _ = crop(bgr(image.pixels), roi)
            return dict(rect=roi, **self._bait(cv2.resize(pixels, (125, 125), interpolation=cv2.INTER_LINEAR), args.get("itemMode", "Item")))
        if op == "fishing.barRects":
            pixels = image.pixels
            if "roi" in args:
                pixels, _ = crop(pixels, args["roi"])
            return fish_bar_rects(pixels)
        if op == "fishing.fishBox":
            rects = fish_bar_rects(image.pixels[:image.height // 2])
            return fish_box(rects, image.width, image.height)
        if op == "fishing.control":
            pixels, _ = crop(image.pixels, args["fishBoxRect"])
            return control_observation(fish_bar_rects(pixels))
        if op == "fishing.bite":
            return self._bite(image, args.get("getABiteText", "上钩"))
        raise NotImplementedError(f"Unknown fishing vision operation: {op}")
