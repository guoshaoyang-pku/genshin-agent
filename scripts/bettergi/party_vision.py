"""BetterGI party and combat-target vision, GPL-3.0.

Ported from PartyAvatarSideIndexHelper, CombatScenes, Avatar, AutoFightAssets,
AvatarRecognition and ImageDifferenceDetector at c9db8b8291fe4ac25a600aee1582298005919eb2.
Original Recognition.json, side-avatar model and combat_avatar.json stay unchanged.
This module produces observations only; combat lifecycle and input belong to JS.
"""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import re
from threading import Lock
import unicodedata

import cv2
import numpy as np


VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
DAMAGE_COLORS = ((225, 155, 255), (153, 255, 255), (51, 204, 255),
                 (102, 255, 204), (255, 155, 0), (0, 234, 82), (255, 204, 102))
REACTIONS = ("免疫", "蒸发", "感电", "结晶", "扩散", "绽放", "冻结", "超载", "融化", "燃烧", "超导", "激化")
COSTUMES = dict(Flamme="殷红终夜", Bamboo="雨化竹身", Dai="冷花幽露", Yu="玄玉瑶芳",
                Dancer="帆影游风", Witch="琪花星烛", Wic="和谐", Studentin="叶隐芳名",
                Fruhling="花时来信", Highness="极夜真梦", Feather="霓裾翩跹",
                Floral="纱中幽兰", Summertime="闪耀协奏", Sea="海风之梦")


def box(x, y, width, height):
    return dict(x=int(x), y=int(y), width=int(width), height=int(height))


def rectangle(value):
    if not isinstance(value, dict):
        raise ValueError("A rectangle requires x, y, width and height")
    values = [value.get(key) for key in ("x", "y", "width", "height")]
    if any(not isinstance(v, (int, float)) or isinstance(v, bool) or not math.isfinite(v)
           or int(v) != v for v in values):
        raise ValueError("A rectangle requires finite integer coordinates")
    return tuple(map(int, values))


def bgr(pixels):
    if not isinstance(pixels, np.ndarray) or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Party vision requires nonempty uint8 pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Party vision requires gray, BGR or BGRA pixels")
    return pixels


def crop(pixels, rect, clamp=False):
    x, y, w, h = rectangle(rect)
    height, width = pixels.shape[:2]
    if clamp:
        right, bottom = min(width, x + w), min(height, y + h)
        x, y = max(0, x), max(0, y)
        w, h = right - x, bottom - y
    if min(x, y) < 0 or min(w, h) <= 0 or x + w > width or y + h > height:
        raise ValueError("Party vision crop is outside the capture")
    return pixels[y:y + h, x:x + w], box(x, y, w, h)


def system_scale(width, height):
    return min(width / 1920, height / 1080, 1)


def multi_status(value=None, peer_count=0, one_p=False):
    if value is None:
        if peer_count > 3:
            raise ValueError("当前处于联机状态，但是队伍人数超过4人，无法识别")
        in_multi, host, players = peer_count > 0 or one_p, bool(one_p), peer_count + 1
    else:
        in_multi = value.get("isInMultiGame", False)
        host = value.get("isHost", False)
        players = value.get("playerCount", 1)
        if not isinstance(in_multi, bool) or not isinstance(host, bool):
            raise ValueError("Multiplayer flags must be boolean")
        if not isinstance(players, int) or isinstance(players, bool) or not 1 <= players <= 4:
            raise ValueError("Multiplayer playerCount must be1..4")
    if not in_multi:
        maximum = 4
    elif host:
        maximum = {1: 4, 2: 2, 3: 2, 4: 1}[players]
    else:
        if players == 1:
            raise ValueError("进入别人世界时，联机总人数异常")
        maximum = {2: 2, 3: 1, 4: 1}[players]
    return dict(isInMultiGame=in_multi, isHost=host, playerCount=players, maxControlAvatarCount=maximum)


def asset_geometry(width, height):
    # CaptureSize.AssetScale is width-only, distinct from SystemInfo.AssetScale.
    s = min(width / 1920, 1)
    def right(dx, y, w, h):
        return box(width - int(dx * s), int(y * s), int(w * s), int(h * s))
    def bottom(dx, dy, w, h):
        return box(width - int(dx * s), height - int(dy * s), int(w * s), int(h * s))
    side_y = {"1p_2": [375, 470], "1p_3": [375, 470], "1p_4": [515],
              "p_2": [375, 470], "p_3": [475], "p_4": [515]}
    index_y = {"1p_2": [412, 508], "1p_3": [459, 555], "1p_4": [552],
               "p_2": [412, 508], "p_3": [412], "p_4": [507]}
    return dict(assetScale=s, systemScale=system_scale(width, height),
                teamRectNoIndex=right(355, 220, 270, 465), teamRect=right(355, 220, 355, 465),
                eRect=bottom(267, 132, 77, 77), eCooldownRect=bottom(241, 97, 41, 18),
                eRectForClassify=bottom(262, 130, 82, 82), qRect=bottom(157, 165, 110, 110),
                qRectForClassify=bottom(172, 166, 137, 137), zCooldownRect=right(130, 814, 60, 24),
                gadgetRect=right(133, 800, 60, 50),
                endTipsUpperRect=box(width // 2 - int(100 * s), int(243 * s), int(200 * s), int(50 * s)),
                endTipsRect=box(width // 2 - int(200 * s), height - int(160 * s), int(400 * s), int(80 * s)),
                avatarIndexRects=[right(61, y, 28, 24) for y in (256, 352, 448, 544)],
                avatarSideIconRects=[right(155, y, 76, 76) for y in (225, 315, 410, 500)],
                avatarQRects=[right(336, y, 64, 84) for y in (216, 316, 416, 516)],
                multiplayerIndexRects={key: [right(61, y, 28, 24) for y in ys] for key, ys in index_y.items()},
                multiplayerSideIconRects={key: [right(155, y, 76, 76) for y in ys] for key, ys in side_y.items()})


def dynamic_layout(indexes, arrow, status, scale):
    indexes = [dict(r) if r else None for r in indexes]
    if sum(r is not None for r in indexes) != status["maxControlAvatarCount"]:
        if arrow is None:
            raise ValueError("找不到出战角色编号块与当前出战角色标识！")
        known = next(((i, r) for i, r in enumerate(indexes) if r), None)
        if known is None:
            indexes = [box(arrow["x"] + int(126 * scale), arrow["y"] - int(194 * scale),
                           int(16 * scale), int(17 * scale))]
        else:
            known_index, known_rect = known
            for i, r in enumerate(indexes):
                if r is None:
                    predicted = {**known_rect, "y": known_rect["y"] + (i - known_index) * int(96 * scale)}
                    if intersects(arrow, predicted):
                        indexes[i] = predicted
            first_null = next((i for i, r in enumerate(indexes) if r is None), len(indexes))
            if any(indexes[first_null:]):
                raise ValueError("校验角色列表识别结果失败，角色编号不是连续的！")
    indexes = [r for r in indexes if r]
    icons = [box(r["x"] - int(91 * scale), r["y"] - int(47 * scale),
                 int(82 * scale), int(82 * scale)) for r in indexes]
    return indexes, icons


def fixed_layout(pixels, status):
    height, width = pixels.shape[:2]
    assets = asset_geometry(width, height)
    if status["isInMultiGame"]:
        key = ("1p" if status["isHost"] else "p") + "_" + str(status["playerCount"])
        indexes, icons = assets["multiplayerIndexRects"][key], assets["multiplayerSideIconRects"][key]
    else:
        indexes, icons = assets["avatarIndexRects"], assets["avatarSideIconRects"]
    white_count = 0
    for rect in indexes:
        x, y = rect["x"] + 2, rect["y"] - 5
        if not 0 <= x < width or not 0 <= y < height:
            raise ValueError("AvatarSideFixOffset sample is outside the capture")
        white_count += int(np.all(pixels[y, x] == 255))
    corrected = white_count >= 3
    if corrected:
        # Source subtracts14 actual pixels even at lower resolution.
        indexes, icons = ([{**r, "y": r["y"] - 14} for r in rs] for rs in (indexes, icons))
    return indexes, icons, corrected


def intersects(first, second):
    return first["y"] < second["y"] + second["height"] and second["y"] < first["y"] + first["height"]


def is_white_rect(gray):
    white = np.count_nonzero((gray >= 251) & (gray <= 255))
    dark = np.count_nonzero((gray >= 50) & (gray <= 54))
    return (white + dark) / gray.size > .35


def white_edge_ratio(gray):
    height, width = gray.shape
    if min(height, width) < 1:
        return 0.0
    total = 2 * (width + height - 2)
    count = np.count_nonzero(gray[0] == 255)
    if height > 1:
        count += np.count_nonzero(gray[-1] == 255)
    count += np.count_nonzero(gray[1:-1, 0] == 255)
    if width > 1:
        count += np.count_nonzero(gray[1:-1, -1] == 255)
    return float(count / total) if total > 0 else 0.0


def most_different(images):
    if len(images) != 4 or any(m.shape != images[0].shape for m in images):
        return -1
    votes = [0] * 4
    for i, image in enumerate(images):
        winner, maximum = -1, 0
        for j, other in enumerate(images):
            if i != j:
                difference = int(np.count_nonzero(image != other))
                if difference > maximum:
                    winner, maximum = j, difference
        if winner >= 0:
            votes[winner] += 1
    return next((i for i, count in enumerate(votes) if count >= 3), -1)


def active_by_color(pixels, indexes):
    if len(indexes) == 1:
        return 1
    gray = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2GRAY)
    images = [crop(gray, r)[0] for r in indexes]
    white = [is_white_rect(m) for m in images]
    if sum(white) == len(images) - 1:
        return white.index(False) + 1
    edges = [white_edge_ratio(m) > .5 for m in images]
    if sum(edges) == len(images) - 1:
        return edges.index(False) + 1
    if all(edges):
        # Source returns the last rectangle without exact gray50.
        nonblack = [i + 1 for i, m in enumerate(images) if not np.any(m == 50)]
        if nonblack:
            return nonblack[-1]
    different = most_different(images) if len(images) == 4 else -1
    return different + 1 if different >= 0 else -1


def active_context(color_index, arrow_index, context=None):
    context = context or {}
    counts = list(context.get("activeIndexByArrowCount", [0] * 4))
    failed = context.get("totalCheckFailedCount", 0)
    if len(counts) != 4 or any(not isinstance(c, int) or isinstance(c, bool) or c < 0 for c in counts + [failed]):
        raise ValueError("Active-avatar context requires four nonnegative counters")
    if color_index > 0:
        index, failed = color_index, 0
    elif arrow_index > 0:
        counts[arrow_index - 1] += 1
        index = arrow_index if counts[arrow_index - 1] >= 2 else -2
        if index > 0:
            failed = 0
    else:
        index, failed = -1, failed + 1
    return dict(index=index, colorIndex=color_index, arrowIndex=arrow_index,
                context=dict(activeIndexByArrowCount=counts, totalCheckFailedCount=failed))


def components(mask):
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4, ltype=cv2.CV_32S)
    return [tuple(map(int, row)) for row in stats[1:]]


def closest_weighted(items):
    if not items:
        return None
    total = sum(item["area"] for item in items)
    if total == 0:
        return None
    avg_x = sum(item["centerX"] * item["area"] for item in items) / total
    avg_y = sum(item["centerY"] * item["area"] for item in items) / total
    result = min(items, key=lambda item: abs(item["centerX"] - avg_x) + abs(item["centerY"] - avg_y))
    return {key: value for key, value in result.items() if key != "area"}


def damage_color(pixels, scale):
    roi = box(int(450 * scale), int(240 * scale), int(1150 * scale), int(660 * scale))
    source, actual = crop(pixels, roi, clamp=True)
    rgb = cv2.cvtColor(source, cv2.COLOR_BGR2RGB)
    combined = np.zeros(source.shape[:2], np.uint8)
    for color in DAMAGE_COLORS:
        combined |= cv2.inRange(rgb, color, color)
    items = []
    for x, y, w, h, area in components(combined):
        if h >= int(20 * scale):
            x, y = x + actual["x"], y + actual["y"]
            items.append(dict(centerX=x + w // 2, centerY=y + h // 2, area=area, text="", **box(x, y, w, h)))
    return closest_weighted(items)


def damage_ocr(lines):
    items = []
    for line in lines:
        text = (line.get("text") or "").strip()
        if not text:
            continue
        reaction = any(word in text for word in REACTIONS)
        # C# char.IsDigit is Unicode category Nd, not Python's wider isdigit().
        digits = sum(ord(c) <= 0xFFFF and unicodedata.category(c) == "Nd" for c in text)
        if not reaction and (text.startswith("+") or digits < 4):
            continue
        x, y, w, h = rectangle(line)
        length = len(text.encode("utf-16-le")) // 2
        items.append(dict(centerX=x + w // 2, centerY=y + h // 2, area=h * h * length,
                          text=text, **box(x, y, w, h)))
    return closest_weighted(items)


def skill_cd_number(text, maximum):
    # StringUtils.TryParseDouble calls double.TryParse: Float|AllowThousands.
    # BetterGI's Chinese/English numeric cultures use '.' and ','; Python float
    # alone would additionally accept underscores and non-ASCII digits.
    pattern = r"[\t\n\v\f\r ]*[+-]?(?:[0-9][0-9,]*(?:\.[0-9]*)?|\.[0-9]+)(?:[eE][+-]?[0-9]+)?[\t\n\v\f\r ]*"
    if re.fullmatch(pattern, text) is None:
        return None
    value = float(text.replace(",", ""))
    return value if 0 < value <= maximum else None


def feature_probability(match, table):
    if not table:
        return .5
    index = min(max(match / .05, 0), len(table) - 1)
    low = int(index)
    high = min(low + 1, len(table) - 1)
    fraction = index - low
    return table[low] * (1 - fraction) + table[high] * fraction


def feature_score(pixels, feature):
    if feature["W"] <= 0 or feature["H"] <= 0:
        return .5
    height, width = pixels.shape[:2]
    x = min(max(feature["X"], 0), width - 1)
    y = min(max(feature["Y"], 0), height - 1)
    w, h = min(feature["W"], width - x), min(feature["H"], height - y)
    channel = {"H": 0, "S": 1, "V": 2}.get(feature["Channel"])
    if w <= 0 or h <= 0 or channel is None:
        return .5
    if feature["Type"] == "F1":
        hsv = cv2.cvtColor(pixels[y:y + h, x:x + w], cv2.COLOR_BGR2HSV)
        values = hsv[:, :, channel].astype(np.float64).reshape(-1)
        if feature["Channel"] == "H":
            radians = values * 2 * math.pi / 180
            value = (math.atan2(np.sin(radians).mean(), np.cos(radians).mean()) * 180 / math.pi + 360) % 360
        else:
            value = (values / 255).mean()
        if feature["IsCircular"]:
            diff = abs((value - feature["RefVal"] + 360) % 360)
            if diff > 180:
                diff = 360 - diff
            match = (math.cos(diff * math.pi / 180) + 1) / 2
        else:
            match = max(0, 1 - abs(value - feature["RefVal"]) / feature["Range"])
    elif feature["Type"] == "F2":
        reference = feature.get("RefHist")
        if reference is None or len(reference) != 8:
            return .5
        crop_x, crop_y = max(0, x - 1), max(0, y - 1)
        crop_w, crop_h = min(w + 2, width - crop_x), min(h + 2, height - crop_y)
        hsv = cv2.cvtColor(pixels[crop_y:crop_y + crop_h, crop_x:crop_x + crop_w], cv2.COLOR_BGR2HSV)
        single = np.ascontiguousarray(hsv[:, :, channel])
        gx = cv2.Sobel(single, cv2.CV_32F, 1, 0, ksize=3)
        gy = cv2.Sobel(single, cv2.CV_32F, 0, 1, ksize=3)
        magnitude, angle = cv2.cartToPolar(gx, gy, angleInDegrees=True)
        inner = np.s_[y - crop_y:y - crop_y + h, x - crop_x:x - crop_x + w]
        angle, magnitude = angle[inner], magnitude[inner]
        valid = np.isfinite(angle) & ~np.isnan(magnitude)
        if np.count_nonzero(valid) < 4:
            return .5
        bins = np.clip(((angle[valid] % np.float32(180)) / 22.5).astype(int), 0, 7)
        histogram = np.bincount(bins, weights=magnitude[valid], minlength=8)
        total = histogram.sum()
        if total > 0:
            histogram /= total
        reference = np.asarray(reference, dtype=np.float64)
        denominator = np.linalg.norm(histogram) * np.linalg.norm(reference)
        match = min(1, max(0, float(np.dot(histogram, reference)) / denominator)) if denominator > 1e-10 else 0
    else:
        return .5
    return feature_probability(match, feature.get("ProbTable"))


def image_feature_score(pixels, features):
    if not features:
        return .5
    total_weight = sum(f["Weight"] for f in features)
    weighted = sum(feature_score(pixels, f) * f["Weight"] for f in features)
    return min(1, max(0, weighted / total_weight)) if total_weight > 0 else .5


class PartyVision:
    def __init__(self, bridge):
        self.bridge = bridge
        root = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source"))
        self.source_root = root if (root / "GameTask").is_dir() else root / "BetterGenshinImpact"
        self.recognitions = {}
        self.catalog = None
        self.predictor = None
        self.e_predictor = None
        self.q_predictor = None
        self.e_classifier_lock = Lock()
        self.legendary_tracker = {}
        self.overheat_features = None
        self.overheat_threshold = None

    def _find(self, image, category, name, multi=False):
        key = (image.width, image.height, category, name)
        if key not in self.recognitions:
            folder = "GameTask/Common/Element/Assets" if category == "Element" else "GameTask/AutoFight/Assets"
            self.recognitions[key] = self.bridge.dispatch("recognition.load", {
                "path": str(self.source_root / folder / "Recognition.json"), "objectName": name,
                "width": image.width, "height": image.height})
        found = self.bridge.find_template(image, self.recognitions[key], multi)
        rects = [box(*(r[key] for key in ("x", "y", "width", "height"))) for r in found]
        return rects if multi else rects[0] if rects else None

    def layout(self, image, status=None):
        if status is None:
            peers = self._find(image, "AutoFight", "P", True)
            if len(peers) > 3:
                raise ValueError("当前处于联机状态，但是队伍人数超过4人，无法识别")
            one_p = self._find(image, "AutoFight", "OneP") is not None
            status = multi_status(peer_count=len(peers), one_p=one_p)
        else:
            status = multi_status(status)
        recognized = [self._find(image, "Element", "Index" + str(i)) for i in range(1, 5)]
        arrow = None
        method, corrected, reason = "dynamic", False, None
        try:
            if sum(r is not None for r in recognized) != status["maxControlAvatarCount"]:
                arrow = self._find(image, "Element", "CurrentAvatarThreshold")
            indexes, icons = dynamic_layout(recognized, arrow, status, system_scale(image.width, image.height))
        except Exception as error:
            indexes, icons, corrected = fixed_layout(bgr(image.pixels), status)
            method, reason = "fixed", str(error)
        return dict(multiGameStatus=status, indexRects=indexes, sideIconRects=icons,
                    layoutMethod=method, offsetCorrected=corrected, fallbackReason=reason,
                    recognizedIndexRects=recognized, recognizedIndexCount=sum(r is not None for r in recognized), arrowRect=arrow)

    def avatars(self):
        if self.catalog is None:
            filename = self.source_root / "GameTask/AutoFight/Assets/combat_avatar.json"
            catalog = json.loads(filename.read_text(encoding="utf-8-sig"))
            self.catalog = {avatar["nameEn"]: avatar for avatar in catalog}
        return self.catalog

    def classifier(self, kind="avatar"):
        attribute, filename = {"avatar": ("predictor", "avatar_side_classify_sim.onnx"),
                               "e": ("e_predictor", "e_classify_sim.onnx"),
                               "q": ("q_predictor", "q_classify_sim.onnx")}[kind]
        predictor = getattr(self, attribute)
        if predictor is None:
            from yolo_vision import YoloPredictor
            model_root = self.bridge.model_root or os.environ.get("BETTERGI_MODEL_ROOT")
            if model_root is None:
                model_root = VENDOR / "assets/bettergi.assets.model/Assets/Model"
            predictor = YoloPredictor(Path(model_root) / "Common" / filename)
            setattr(self, attribute, predictor)
        return predictor

    def read_skill_cd(self, image, maximum):
        rect = asset_geometry(image.width, image.height)["eCooldownRect"]
        source, _ = crop(bgr(image.pixels), rect, clamp=True)
        mask = cv2.inRange(cv2.cvtColor(source, cv2.COLOR_BGR2HSV), (0, 0, 235), (0, 25, 255))
        text, _ = self.bridge.ocr().recognize(mask)
        return skill_cd_number(text, maximum)

    def skill(self, image, name_en, maximum, enable_classifier=False, only_code01_ready=True):
        if not isinstance(maximum, (int, float)) or isinstance(maximum, bool) or not math.isfinite(maximum) or maximum < 0:
            raise ValueError("maxSkillCd must be a finite nonnegative number")
        if not enable_classifier:
            return dict(state="Unknown", code=None, cd=self.read_skill_cd(image, maximum))
        if not isinstance(name_en, str) or not name_en:
            raise ValueError("E skill classification requires the avatar's original nameEn")
        rect = asset_geometry(image.width, image.height)["eRectForClassify"]
        source, _ = crop(bgr(image.pixels), rect, clamp=True)
        with self.e_classifier_lock:
            top = self.classifier("e").predict(source)[0]
        label, confidence = top["name"]["name"], top["confidence"]
        parts = label.split(" ")
        if confidence <= .7 or len(parts) < 4 or parts[1].lower() != name_en.lower():
            return dict(state="Unknown", code=None, cd=None)
        code = parts[2]
        if only_code01_ready and code.lower() != "01":
            state = "Cooldown"
        elif "nocd" in label.lower():
            state = "Ready"
        elif "cd" in label.lower():
            state = "Cooldown"
        else:
            state = "Unknown"
        cd = 0 if state == "Ready" else self.read_skill_cd(image, maximum) if state == "Cooldown" else None
        return dict(state=state, code=code, cd=cd)

    def burst(self, image):
        rect = asset_geometry(image.width, image.height)["qRectForClassify"]
        source, _ = crop(bgr(image.pixels), rect, clamp=True)
        top = self.classifier("q").predict(source)[0]
        label, confidence = top["name"]["name"], float(top["confidence"])
        state = "Unknown"
        if confidence > .7:
            if "cd 1" in label.lower():
                state = "Cooldown"
            elif "energy 1 cd 0" in label.lower():
                state = "Ready"
        return dict(state=state, confidence=confidence, className=label)

    def overheat(self, image):
        try:
            if self.overheat_features is None:
                filename = self.source_root / "GameTask/AutoFight/Model/AvatarSpecialActions.cs"
                text = filename.read_text(encoding="utf-8-sig")
                model = text.split("FeatureScorerExportData _overheatModel = new()", 1)[1]
                model = model.split("private static bool IsOverheated", 1)[0]
                blocks = re.findall(r"new FeatureScorerItem\s*\{([^{}]+)\}", model)
                features = [{key: json.loads(value) for key, value in
                             re.findall(r'(\w+)\s*=\s*(\[[^\]]*\]|"[^"]*"|true|false|[-+\d.eE]+)', block)}
                            for block in blocks]
                if not features:
                    raise ValueError("Original overheat FeatureScorerExportData is missing")
                threshold = re.search(r"const double OverheatThreshold\s*=\s*([\d.]+)", text)
                if threshold is None:
                    raise ValueError("Original overheat threshold is missing")
                self.overheat_features = features
                self.overheat_threshold = float(threshold.group(1))
            # Original scorer uses raw1080p feature coordinates without scaling.
            score = float(image_feature_score(bgr(image.pixels), self.overheat_features))
            return dict(score=score, overheated=score >= self.overheat_threshold)
        except Exception as error:
            # IsOverheated returns false on a scoring exception; keep missing
            # evidence explicit instead of fabricating a zero probability.
            return dict(score=None, overheated=False, error=str(error))

    def recognize(self, image, status=None):
        layout = self.layout(image, status)
        catalog = self.avatars()
        by_cn = {avatar["name"]: avatar for avatar in catalog.values()}
        scale = system_scale(image.width, image.height)
        avatars = []
        for i, (index, icon) in enumerate(zip(layout["indexRects"], layout["sideIconRects"])):
            name_rect = box(index["x"] - int(240 * scale), index["y"] - index["height"],
                            int(240 * scale), index["height"] * 3)
            class_name, confidence, costume, method, error_text = None, None, "", "classifier", None
            try:
                source, _ = crop(bgr(image.pixels), icon, clamp=True)
                prediction = self.classifier().predict(source)[0]
                class_name, confidence = prediction["name"]["name"], prediction["confidence"]
                threshold = .51 if class_name.startswith("Qin") or "Costume" in class_name else .7
                if confidence < threshold:
                    raise ValueError("无法识别第" + str(i + 1) + "位角色，分类置信度低于原始阈值")
                split = class_name.find("Costume")
                name_en = class_name if split <= 0 else class_name[:split]
                costume = "" if split <= 0 else class_name[split + 7:]
                name = catalog[name_en]["name"]
            except Exception as error:
                method, costume, error_text = "ocr", "", str(error)
                result = self.bridge.find_ocr(image, {"type": "Ocr", "roi": name_rect}, False)
                raw = result[0]["text"] if result else ""
                name = "".join(re.findall("[\u4e00-\u9fa5]", raw))
                if name not in by_cn:
                    name = "未知角色"
                name_en = by_cn[name]["nameEn"]
            display_name = name + "(" + COSTUMES.get(costume, costume) + ")" if costume else name
            avatars.append(dict(index=i + 1, name=name, nameEn=name_en, costume=costume, displayName=display_name,
                                className=class_name, confidence=confidence, recognitionMethod=method,
                                classifierError=error_text, indexRect=index, sideIconRect=icon, nameRect=name_rect))
        return {**layout, "avatars": avatars}

    def active(self, image, indexes, context=None):
        if not 1 <= len(indexes) <= 4:
            raise ValueError("Active-avatar detection needs1..4 index rectangles")
        color_index = active_by_color(image.pixels, indexes)
        arrow_index = -1
        if color_index <= 0:
            arrow = self._find(image, "Element", "CurrentAvatarThreshold")
            if arrow:
                arrow_index = next((i + 1 for i, rect in enumerate(indexes) if intersects(arrow, rect)), -1)
        return active_context(color_index, arrow_index, context)

    def blood_bars(self, pixels, scale):
        source, _ = crop(pixels, box(0, 0, int(1500 * scale), int(900 * scale)), clamp=True)
        mask = cv2.inRange(cv2.cvtColor(source, cv2.COLOR_BGR2RGB), (255, 90, 90), (255, 90, 90))
        bars = [box(x, y, w, h) for x, y, w, h, _ in components(mask)]
        bins = {(r["x"] // 5 * 5, r["y"] // 2 * 2) for r in bars if r["x"] > int(200 * scale)}
        for key in bins:
            self.legendary_tracker[key] = min(self.legendary_tracker.get(key, 0) + 1, 10)
        for key in list(self.legendary_tracker):
            if key not in bins:
                self.legendary_tracker[key] -= 1
                if self.legendary_tracker[key] <= 0:
                    del self.legendary_tracker[key]
        results = []
        for rect in bars:
            y = rect["y"]
            threshold = 2 if y < int(100 * scale) else 4 if y < int(200 * scale) else 10
            key = (rect["x"] // 5 * 5, y // 2 * 2)
            results.append({**rect, "legendary": self.legendary_tracker.get(key, 0) >= threshold})
        return results

    def dispatch(self, op, args):
        if op == "party.resetTargetTracker":
            self.legendary_tracker.clear()
            return None
        image = self.bridge.image(args["handle"])
        if op == "party.layout":
            return self.layout(image, args.get("multiGameStatus"))
        if op == "party.recognize":
            return self.recognize(image, args.get("multiGameStatus"))
        if op == "party.assets":
            return asset_geometry(image.width, image.height)
        if op == "party.skill":
            return self.skill(image, args.get("nameEn"), args["maxSkillCd"],
                              args.get("enableClassifier", False), args.get("onlyCode01Ready", True))
        if op == "party.burst":
            return self.burst(image)
        if op == "party.overheat":
            return self.overheat(image)
        if op == "party.lowHp":
            scale = system_scale(image.width, image.height)
            pixel = bgr(image.pixels)[int(1010 * scale), int(808 * scale)]
            return bool(np.array_equal(pixel, (90, 90, 255)))
        if op == "party.active":
            return self.active(image, args["indexRects"], args.get("context"))
        if op == "party.avatarIsActive":
            index, _ = crop(cv2.cvtColor(bgr(image.pixels), cv2.COLOR_BGR2GRAY), args["indexRect"], clamp=True)
            return bool(np.count_nonzero(index >= 251) / index.size <= .5)
        pixels = bgr(image.pixels)
        scale = system_scale(image.width, image.height)
        if op == "party.bloodBars":
            return self.blood_bars(pixels, scale)
        if op == "party.damageNumber":
            mode = args.get("mode", "Color")
            if mode == "Disabled":
                return None
            if mode == "Color":
                return damage_color(pixels, scale)
            if mode != "Ocr":
                raise ValueError("Damage recognition mode must be Color, Ocr or Disabled")
            roi = box(int(450 * scale), int(240 * scale), int(1150 * scale), int(660 * scale))
            lines = self.bridge.find_ocr(image, {"type": "Ocr", "roi": roi}, True)
            return damage_ocr(lines)
        raise NotImplementedError("Unknown party vision operation: " + op)
