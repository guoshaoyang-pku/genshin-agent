"""Original BetterGI fixed card detector and avatar grid ONNX recognition.

Source c9db8b8291fe4ac25a600aee1582298005919eb2, GPL-3.0:
FixedSizeGridCardDetector.cs and AvatarGridIconRecognizer.cs. Models and CSV
prototypes are read unchanged from the imported BetterGI resource package.
"""

from __future__ import annotations

import base64
import csv
import hashlib
import json
import math
from pathlib import Path

import cv2
import numpy as np

UPSTREAM_COMMIT = "c9db8b8291fe4ac25a600aee1582298005919eb2"
LAYOUTS = {"CharacterDevelopment": (115, 140, 115, 2000, 3000),
           "PartySetupCharacters": (132, 161, 132, 2500, 4000)}


def rectangle(x, y, width, height):
    return {"x": int(x), "y": int(y), "width": int(width), "height": int(height)}


def rect(value):
    if isinstance(value, dict):
        value = [value.get(name) for name in ("x", "y", "width", "height")]
    if not isinstance(value, (list, tuple)) or len(value) != 4 or any(
            not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v) for v in value):
        raise ValueError("A party grid rectangle requires four finite coordinates")
    return tuple(round(v) for v in value)


def bgr(pixels):
    if not isinstance(pixels, np.ndarray) or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Party grid vision requires nonempty uint8 pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Party grid vision requires gray, BGR or BGRA pixels")
    return pixels


def correct_by_median(values, tolerance):
    ordered = sorted(enumerate(values), key=lambda item: item[1])
    result = [0] * len(values)
    group = []

    def flush():
        if not group:
            return
        middle = len(group) // 2
        median = (group[middle][1] if len(group) % 2
                  else round((group[middle - 1][1] + group[middle][1]) / 2))
        for index, _ in group:
            result[index] = median
        group.clear()

    for item in ordered:
        if group and item[1] - group[-1][1] > tolerance:
            flush()
        group.append(item)
    flush()
    return result


def build_cards(bottom_rects, grid_size, asset_scale, layout="PartySetupCharacters"):
    if layout not in LAYOUTS:
        raise ValueError(f"Unknown fixed card layout: {layout}")
    width, height, avatar_size, _, _ = LAYOUTS[layout]
    card_width, card_height, avatar_size = (
        max(1, round(value * asset_scale)) for value in (width, height, avatar_size))
    boxes = [rect(box) for box in bottom_rects]
    rights = correct_by_median([x + w for x, y, w, h in boxes], max(3, card_width // 3))
    bottoms = correct_by_median([y + h for x, y, w, h in boxes], max(3, card_height // 3))
    cards, seen, rejected_count = [], set(), 0
    grid_width, grid_height = grid_size
    for right, bottom in zip(rights, bottoms):
        if (right, bottom) in seen:
            continue
        seen.add((right, bottom))
        x, y = right - card_width, bottom - card_height
        if x < 0 or y < 0 or right > grid_width or bottom > grid_height:
            rejected_count += 1
            continue
        cards.append({"cardRect": rectangle(x, y, card_width, card_height),
                      "avatarRect": rectangle(x, y, avatar_size, avatar_size)})
    return cards, rejected_count


def detect_cards(pixels, asset_scale, layout="PartySetupCharacters"):
    if layout not in LAYOUTS:
        raise ValueError(f"Unknown fixed card layout: {layout}")
    if not math.isfinite(asset_scale) or asset_scale <= 0:
        raise ValueError("Asset scale must be positive and finite")
    hsv = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (20, 12, 233), (35, 16, 237))
    closed = cv2.morphologyEx(mask, cv2.MORPH_CLOSE,
                             cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)), iterations=1)
    count, _, stats, _ = cv2.connectedComponentsWithStats(closed, connectivity=8, ltype=cv2.CV_32S)
    *_, min_area, max_area = LAYOUTS[layout]
    min_area, max_area = min_area * asset_scale ** 2, max_area * asset_scale ** 2
    bottoms = [tuple(int(value) for value in row[:4]) for row in stats[1:]
               if min_area <= int(row[cv2.CC_STAT_AREA]) <= max_area]
    cards, rejected = build_cards(bottoms, (pixels.shape[1], pixels.shape[0]), asset_scale, layout)
    return {"cards": cards, "rejectedCount": rejected, "connectedComponentCount": max(0, count - 1)}


def normalize_vector(vector):
    values = np.asarray(vector, dtype=np.float32).reshape(-1)
    norm2 = 0.
    for value in values:
        norm2 += float(value) * float(value)
    norm = math.sqrt(norm2)
    with np.errstate(invalid="ignore", divide="ignore"):
        return (values.astype(np.float64) / norm).astype(np.float32)


def normalized_rgb_tensor(pixels):
    rgb = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2RGB).astype(np.float32)
    normalized = (rgb / np.float32(255) - np.float32(.5)) / np.float32(.5)
    return np.ascontiguousarray(normalized.transpose(2, 0, 1)[None])


def create_input_tensors(pixels, element_pixels=None):
    avatar = cv2.resize(bgr(pixels), (115, 115), interpolation=cv2.INTER_LINEAR)
    element = avatar[:48, :48] if element_pixels is None else bgr(element_pixels)
    element = cv2.resize(element, (64, 64), interpolation=cv2.INTER_LINEAR)
    return {"input_image": normalized_rgb_tensor(avatar),
            "input_element_image": normalized_rgb_tensor(element)}


def parse_element_types(metadata):
    if "element_types" not in metadata:
        raise ValueError("Avatar model is missing required element_types metadata")
    try:
        labels = json.loads(metadata["element_types"])
    except (TypeError, json.JSONDecodeError) as error:
        raise ValueError("Avatar model element_types must be a JSON string array") from error
    if not isinstance(labels, list) or not labels or any(not isinstance(x, str) or not x.strip() for x in labels):
        raise ValueError("Avatar model element_types must be a nonempty string array without blank labels")
    return labels


def predict_element_type(logits, labels):
    values = np.asarray(logits).reshape(-1)
    if len(values) == 0 or len(values) != len(labels):
        raise ValueError(f"Avatar model element output count mismatch: logits={len(values)}, elements={len(labels)}")
    best = 0
    for index in range(1, len(values)):
        if values[index] > values[best]:
            best = index
    return labels[best]


class AvatarGridIconRecognizer:
    def __init__(self, model_root):
        self.root = Path(model_root) / "AvatarGridIcon"
        self.model_path, self.csv_path = self.root / "avatar.onnx", self.root / "avatar.csv"
        self.prototypes, self.characters = [], {}
        with self.csv_path.open(encoding="utf-8-sig", newline="") as stream:
            reader = csv.DictReader(stream)
            reader.fieldnames = [name.strip().lower() for name in reader.fieldnames]
            for row in reader:
                embedding = np.frombuffer(base64.b64decode(row["embedding"].strip()), dtype="<f4").copy()
                candidate = {"name": row["character_name"].strip(), "elementType": row["element_type"].strip(),
                             "weaponType": row["weapon_type"].strip()}
                self.prototypes.append({**candidate, "embedding": normalize_vector(embedding)})
                self.characters.setdefault(candidate["name"], candidate)
        self.session = None
        self.element_types = None

    def load(self):
        if self.session is None:
            import onnxruntime
            session = onnxruntime.InferenceSession(str(self.model_path), providers=["CPUExecutionProvider"])
            labels = parse_element_types(session.get_modelmeta().custom_metadata_map)
            self.element_types, self.session = labels, session
        return self.session

    def candidate(self, embedding):
        feature = normalize_vector(embedding)
        groups = {}
        for prototype in self.prototypes:
            products = prototype["embedding"] * feature
            score = 0.
            for value in products:
                score += float(value)
            result = {"name": prototype["name"], "elementType": prototype["elementType"], "score": score}
            if prototype["name"] not in groups or score > groups[prototype["name"]]["score"]:
                groups[prototype["name"]] = result
        return max(groups.values(), key=lambda item: item["score"],
                   default={"name": "", "elementType": "", "score": -float.fromhex("0x1.fffffffffffffp+1023")})

    def recognize(self, pixels, element_pixels=None, recognize_element_type=False):
        session = self.load()
        names = [value.name for value in session.get_outputs()]
        outputs = dict(zip(names, session.run(None, create_input_tensors(pixels, element_pixels))))
        result = self.candidate(outputs["embedding"])
        if recognize_element_type and result["name"]:
            result["elementType"] = predict_element_type(outputs["element_logits"], self.element_types)
        return result

    def metadata(self):
        return {"characters": list(self.characters.values()), "prototypeCount": len(self.prototypes),
                "characterCount": len(self.characters)}

    def status(self):
        session = self.load()
        return {"upstreamCommit": UPSTREAM_COMMIT, "model": str(self.model_path),
                "modelSha256": hashlib.sha256(self.model_path.read_bytes()).hexdigest(),
                "prototypes": str(self.csv_path),
                "prototypeSha256": hashlib.sha256(self.csv_path.read_bytes()).hexdigest(),
                "prototypeCount": len(self.prototypes), "characterCount": len(self.characters),
                "inputs": [{"name": value.name, "shape": value.shape} for value in session.get_inputs()],
                "outputs": [{"name": value.name, "shape": value.shape} for value in session.get_outputs()],
                "elementTypes": self.element_types}


class PartyGridVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.model_root = (bridge.model_root or Path(__file__).resolve().parents[2]
                           / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model")
        self.recognizer = None

    def avatar_recognizer(self):
        if self.recognizer is None:
            self.recognizer = AvatarGridIconRecognizer(self.model_root)
        return self.recognizer

    def dispatch(self, operation, arguments):
        if operation == "party.gridMetadata":
            return self.avatar_recognizer().metadata()
        if operation == "party.gridModelStatus":
            return self.avatar_recognizer().status()
        if operation != "party.grid":
            raise NotImplementedError(f"Unknown party grid operation: {operation}")
        image = self.bridge.image(arguments["handle"])
        pixels = image.pixels
        height, width = pixels.shape[:2]
        scale = min(width / 1920, height / 1080, 1)
        roi = rect(arguments.get("roi", [round(value * scale) for value in (24, 86, 766, 743)]))
        x, y, w, h = roi
        if x < 0 or y < 0 or w <= 0 or h <= 0 or x + w > width or y + h > height:
            raise ValueError("Party grid ROI must have pixels and stay inside the capture")
        grid = pixels[y:y + h, x:x + w]
        result = detect_cards(grid, scale, arguments.get("layout", "PartySetupCharacters"))
        for card in result["cards"]:
            ax, ay, aw, ah = rect(card["avatarRect"])
            card.update(self.avatar_recognizer().recognize(grid[ay:ay + ah, ax:ax + aw]))
            for key in ("cardRect", "avatarRect"):
                card[key]["x"] += x + image.global_x
                card[key]["y"] += y + image.global_y
        return {**result, "roi": rectangle(x, y, w, h), "assetScale": scale}
