"""BetterGI ONNX inference using the pinned YoloSharp 6.0.3 processing rules.

Derived from YoloSharp f970826 (AGPL-3.0-or-later); retained source and license:
third_party/bettergi/dependencies/YoloSharp. Captures contain decoded BGR pixels,
so EXIF AutoOrient has already been applied by the image decoder.
"""
from __future__ import annotations

import ast
import hashlib
from pathlib import Path

import cv2
import numpy as np
import onnxruntime as ort

DEFAULTS = dict(confidence=.3, iou=.45, keepAspectRatio=True, applyAutoOrient=True,
                suppressParallelInference=False)


def configuration(base=None, options=None):
    result = {**DEFAULTS, **(base or {})}
    for key, value in (options or {}).items():
        name = next((name for name in DEFAULTS if name.lower() == key.lower()), None)
        if name is None or value is None:
            continue
        if isinstance(DEFAULTS[name], bool):
            if isinstance(value, str):
                if value.lower() not in ("true", "false"):
                    raise ValueError(f"{name} must be boolean")
                value = value.lower() == "true"
            else:
                value = bool(value)
        else:
            value = float(np.float32(value))
            if not np.isfinite(value):
                raise ValueError(f"{name} must be finite")
        result[name] = value
    return result


def preprocess(pixels, size, keep_aspect=True):
    height, width = pixels.shape[:2]
    model_width, model_height = size
    if min(height, width) <= 0:
        raise ValueError("YOLO input image is empty")
    if pixels.ndim == 2:
        pixels = cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    elif pixels.shape[2] == 4:
        pixels = cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    resized_width, resized_height = size
    if keep_aspect:
        if np.float32(height / width) < np.float32(model_height / model_width):
            resized_height = max(1, int(np.rint(np.float32(height) * np.float32(model_width / width))))
        else:
            resized_width = max(1, int(np.rint(np.float32(width) * np.float32(model_height / height))))
    # ImageSharp NearestNeighbor uses truncation of single-precision coordinates.
    xs = (np.arange(resized_width, dtype=np.float32) * np.float32(width / resized_width)).astype(np.int32)
    ys = (np.arange(resized_height, dtype=np.float32) * np.float32(height / resized_height)).astype(np.int32)
    resized = pixels[ys[:, None], xs[None, :], :3]
    pad_x, pad_y = (model_width - resized_width) // 2, (model_height - resized_height) // 2
    tensor = np.zeros((1, 3, model_height, model_width), np.float32)
    tensor[0, :, pad_y:pad_y + resized_height, pad_x:pad_x + resized_width] = resized[:, :, ::-1].transpose(2, 0, 1) / np.float32(255)
    return tensor


def overlap(a, b):
    ax, ay, aw, ah = a; bx, by, bw, bh = b
    if aw * ah <= 0 or bw * bh <= 0:
        return 0.0
    intersection = max(np.float32(0), min(ax + aw, bx + bw) - max(ax, bx)) * max(np.float32(0), min(ay + ah, by + bh) - max(ay, by))
    return float(intersection / (aw * ah + bw * bh - intersection))


def parse_detection(output, names, image_size, model_size, config):
    raw = np.asarray(output, dtype=np.float32)
    boxes = []
    if raw.ndim != 3 or raw.shape[0] != 1:
        raise ValueError(f"Unsupported detection output shape: {raw.shape}")
    threshold = np.float32(config["confidence"])
    if raw.shape[2] == 6:  # Original YoloV10 architecture selection.
        for index, (left, top, right, bottom, confidence, class_id) in enumerate(raw[0]):
            bounds = tuple(map(np.float32, (int(left), int(top), int(right) - int(left), int(bottom) - int(top))))
            if confidence > threshold and bounds[2] != 0 and bounds[3] != 0:
                boxes.append((index, int(class_id), confidence, bounds))
    else:
        if raw.shape[1] != 4 + len(names):
            raise ValueError(f"Model classes and output shape disagree: {raw.shape}")
        # Yolo11RawBoundingBoxParser retains every qualifying class for each box.
        indexes, classes = np.nonzero(raw[0, 4:].T > threshold)
        for index, class_id in zip(indexes, classes):
            x, y, width, height = raw[0, :4, index]
            if width == 0 or height == 0:
                continue
            boxes.append((int(index), int(class_id), raw[0, class_id + 4, index],
                          (x - width / np.float32(2), y - height / np.float32(2), width, height)))
    boxes.sort(key=lambda box: float(box[2]), reverse=True)
    kept = []
    for box in boxes:
        if not any(box[1] == other[1] and overlap(box[3], other[3]) > config["iou"] for other in kept):
            kept.append(box)
    width, height = image_size; model_width, model_height = model_size
    ratios = np.array([width / model_width, height / model_height], dtype=np.float32)
    padding = (0, 0)
    if config["keepAspectRatio"]:
        reduction = min(np.float32(model_width / width), np.float32(model_height / height))
        padding = (int((np.float32(model_width) - np.float32(width) * reduction) / np.float32(2)),
                   int((np.float32(model_height) - np.float32(height) * reduction) / np.float32(2)))
        ratios[:] = max(ratios)
    result = []
    for _index, class_id, confidence, (x, y, w, h) in kept:
        if not 0 <= class_id < len(names):
            raise ValueError(f"Unknown YOLO class {class_id}")
        bounds = dict(zip(("x", "y", "width", "height"), map(int,
            ((x - padding[0]) * ratios[0], (y - padding[1]) * ratios[1], w * ratios[0], h * ratios[1]))))
        result.append({"name": {"id": class_id, "name": names[class_id]}, "confidence": float(confidence), "bounds": bounds})
    return result


class YoloPredictor:
    def __init__(self, filename, options=None, require_detection=False):
        self.path = Path(filename)
        if self.path.suffix.lower() != ".onnx":
            raise ValueError("模型文件必须是.onnx")
        self.config = configuration(options=options)
        self.require_detection = require_detection
        self.session = None
        self.disposed = False

    def load(self):
        if self.disposed:
            raise ValueError("YOLO predictor is disposed")
        if self.session is not None:
            return
        session_options = ort.SessionOptions()
        session_options.intra_op_num_threads = 4
        session = ort.InferenceSession(str(self.path), sess_options=session_options, providers=["CPUExecutionProvider"])
        metadata = session.get_modelmeta().custom_metadata_map
        task = metadata["task"]
        if task not in ("detect", "classify"):
            raise NotImplementedError(f"YOLO task not migrated: {task}")
        raw_names = ast.literal_eval(metadata["names"])
        names = [raw_names[i].replace("_", " ") for i in range(len(raw_names))]
        if self.require_detection and (task != "detect" or not names):
            raise ValueError("模型必须是类别名非空的检测模型")
        height, width = ast.literal_eval(metadata["imgsz"])
        shape = session.get_inputs()[0].shape
        if shape != [1, 3, height, width]:
            raise NotImplementedError(f"Unsupported YOLO input shape: {shape}")
        self.task, self.names, self.size = task, names, (width, height)
        self.session = session

    def predict(self, pixels, options=None):
        self.load()
        config = configuration(self.config, options)
        tensor = preprocess(pixels, self.size, config["keepAspectRatio"])
        output = self.session.run(None, {self.session.get_inputs()[0].name: tensor})[0]
        if self.task == "detect":
            return parse_detection(output, self.names, (pixels.shape[1], pixels.shape[0]), self.size, config)
        scores = np.asarray(output).reshape(-1)
        if len(scores) != len(self.names):
            raise ValueError("Classification labels and output shape disagree")
        return [{"name": {"id": int(i), "name": self.names[i]}, "confidence": float(scores[i])}
                for i in np.argsort(-scores, kind="stable")]

    def status(self):
        self.load()
        return {"path": str(self.path.resolve()), "sha256": hashlib.sha256(self.path.read_bytes()).hexdigest(),
                "task": self.task, "classes": self.names, "inputSize": list(self.size),
                "providers": self.session.get_providers(), "parser": "YoloSharp 6.0.3"}

    def dispose(self):
        self.disposed = True
        self.session = None


class YoloVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.predictors = {}
        self.next_id = 1

    def dispatch(self, op, args):
        if op == "yolo.create":
            predictor = YoloPredictor(args["path"], args.get("options"), args.get("requireDetection", False))
            key = self.next_id; self.next_id += 1
            self.predictors[key] = predictor
            return {"predictor": key}
        key = int(args["predictor"])
        if key not in self.predictors:
            raise ValueError("YOLO predictor is disposed or unknown")
        predictor = self.predictors[key]
        if op == "yolo.dispose":
            predictor.dispose()
            del self.predictors[key]
            return None
        if op == "yolo.status":
            return predictor.status()
        if op not in ("yolo.predict", "yolo.regions"):
            raise NotImplementedError(f"Unknown YOLO operation: {op}")
        image = self.bridge.image(args["handle"])
        predictions = predictor.predict(image.pixels, args.get("options"))
        if op == "yolo.predict":
            return predictions
        if predictor.task != "detect":
            raise ValueError("YOLO Regions require a detection model")
        return [{**self.bridge.region(image, tuple(prediction["bounds"][key] for key in ("x", "y", "width", "height"))),
                 "__bgiType": "YoloRegion", "detection": prediction} for prediction in predictions]
