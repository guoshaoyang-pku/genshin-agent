"""BetterGI AutoArtifactSalvage pixels and OCR, GPL-3.0-or-later.

Source c9db8b8291fe4ac25a600aee1582298005919eb2. Uses original resource
strings, inventory grid primitives, item models and the existing Paddle bridge.
"""
from __future__ import annotations

import os
from pathlib import Path
import re
import xml.etree.ElementTree as ET

import cv2
import numpy as np

from fishing_vision import OriginalItemRecognizer, bgr, box
from inventory_vision import VENDOR, average, away, cell_spacing, cells_cluster, crop, mode_name, rectangle

SOURCE_COMMIT = "c9db8b8291fe4ac25a600aee1582298005919eb2"
STATUSES = ("None", "Locked", "Selected")


def source_directory(root):
    root = Path(root)
    return root if (root / "GameTask").is_dir() else root / "BetterGenshinImpact"


def metadata(source_root, culture=None):
    folder = source_directory(source_root) / "GameTask/AutoArtifactSalvage"
    source = (folder / "ArtifactAffix.cs").read_text(encoding="utf-8-sig")
    labels = dict(re.findall(r'\{\s*ArtifactAffixType\.(\w+),\s*"([^"]+)"\s*\}', source))
    if len(labels) != 19:
        raise ValueError("Original ArtifactAffix label table is incomplete")
    strings = {key: key for key in ["快速选择", *(f"{i}星圣遗物" for i in range(1, 5))]}
    translations = {}
    if culture is not None:
        if not isinstance(culture, str) or not re.fullmatch(r"[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*", culture):
            raise ValueError("Culture must be a culture name such as zh-CN or en-US")
        language = culture.split("-")[0].lower()
        resource = {"en": "en", "fr": "fr", "it": "it"}.get(language)
        if language == "zh":
            resource = "zh-Hant" if any(p.lower() in ("hant", "tw", "hk", "mo") for p in culture.split("-")[1:]) else "zh-Hans"
        if resource:
            translations = {entry.attrib["name"]: entry.findtext("value", "")
                            for entry in ET.parse(folder / f"AutoArtifactSalvageTask.{resource}.resx").getroot().findall("data")}
    return dict(culture=culture, strings={key: translations.get(key, key) for key in strings},
                affixLabels={kind: translations.get(label, label) for kind, label in labels.items()},
                sourceCommit=SOURCE_COMMIT)


def artifact_status(pixels):
    pixels = bgr(pixels)
    height, width = pixels.shape[:2]
    strip_height = int(height * .19)
    if strip_height <= 0:
        raise ValueError("Artifact upper strip is empty")
    hsv = cv2.cvtColor(pixels[:strip_height], cv2.COLOR_BGR2HSV_FULL)
    bounds = []
    for hue, saturation, spread_s, spread_v, left_only in [(9, .54, 25, 25, True), (80, .76, 10, 5, False)]:
        # Preserve the upstream HSV_FULL helper's h / 255 * 180 conversion.
        center = (hue / 255 * 180, saturation * 255, 255)
        mask = cv2.inRange(hsv, (center[0] - 3, center[1] - spread_s, center[2] - spread_v),
                           (center[0] + 3, center[1] + spread_s, center[2]))
        contours = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
        contours = [contour for contour in contours if not left_only or contour[:, 0, 0].max() < width * .2]
        bounds.append(tuple(map(int, cv2.boundingRect(np.concatenate(contours)))) if contours else None)
    pink, green = bounds
    status = 1 if pink and pink[2] > width * .07 and pink[3] > strip_height * .3 else (
        2 if green and green[2] > width * .2 and green[3] > strip_height * .8 else 0)
    return dict(status=status, statusName=STATUSES[status],
                lockedBounds=box(*pink) if pink else None, selectedBounds=box(*green) if green else None)


def single(values, missing):
    values = list(values)
    if len(values) > 1:
        raise ValueError("Sequence contains more than one matching element")
    if not values:
        raise ValueError(missing)
    return values[0]


def parse_number(text, culture=None):
    language = (culture or "").split("-")[0].lower()
    decimal, group = (",", " " if language == "fr" else ".") if language in ("fr", "it") else (".", ",")
    value = text.strip()
    if not value or not re.fullmatch(r"[0-9., ]+", value) or value.count(decimal) > 1:
        raise ValueError("Invalid artifact numeric value: " + text)
    parts = value.split(decimal)
    if len(parts) == 2 and group in parts[1]:
        raise ValueError("Invalid artifact numeric value: " + text)
    integer = parts[0]
    if integer.startswith(group):
        raise ValueError("Invalid artifact numeric value: " + text)
    normalized = value.replace(group, "").replace(decimal, ".")
    if not re.fullmatch(r"(?:[0-9]+(?:\.[0-9]*)?|\.[0-9]+)", normalized):
        raise ValueError("Invalid artifact numeric value: " + text)
    with np.errstate(over="ignore"):
        return float(np.float32(float(normalized)))


def region_center(region):
    if region.get("points"):
        x, y = np.mean(np.asarray(region["points"], np.float32), axis=0)
        return float(y), float(x)
    x, y, width, height = region["rect"]
    return y + height / 2, x + width / 2


def ocr_text(regions):
    return "\n".join(region["text"] for region in sorted(regions, key=region_center))


def unactivated(pixels):
    histogram = cv2.calcHist([pixels], [0], None, [256], [0, 256]).reshape(-1)
    background, foreground = histogram[222], histogram[152]
    return bool(background > 0 and foreground > 0 and background > foreground
                and not any(count > min(background, foreground) for intensity, count in enumerate(histogram)
                            if intensity not in (222, 152)))


def recognize_artifact(pixels, ocr, labels, culture=None):
    gray = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2GRAY)
    height, width = gray.shape
    rects = [(0, 0, width, int(height * .106)),
             (0, int(height * .106), width, int(height * .106)),
             (0, int(height * .22), int(width * .55), int(height * .30)),
             (0, int(height * .52), width, int(height * .48))]
    regions = []
    crops = []
    for index, rect in enumerate(rects):
        x, y, w, h = rect
        if min(w, h) <= 0 or x + w > width or y + h > height:
            raise ValueError("Artifact OCR crop is empty or outside the card")
        image = gray[y:y + h, x:x + w]
        crops.append(image)
        if index == 2:
            hat = cv2.morphologyEx(image, cv2.MORPH_TOPHAT, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 15)))
            image = cv2.threshold(hat, 30, 255, cv2.THRESH_BINARY)[1]
        regions.append(ocr(image))
    main_regions = sorted((r for r in regions[2] if r["score"] > .5), key=region_center)
    minor_regions = sorted((r for r in regions[3] if r["score"] > .5 and r["rect"][0] < width * .1), key=region_center)
    main_text = ocr_text(main_regions)
    main_lines = main_text.split("\n")
    name = ocr_text(regions[0])
    all_text = "\n".join([name, ocr_text(regions[1]), main_text, *(r["text"] for r in minor_regions)])
    label = single((line for line in main_lines if line in set(labels.values())), "未找到主词条对应的行：\n" + main_text)
    kind = next(kind for kind, text in labels.items() if text == label)
    matches = [match for line in main_lines if (match := re.fullmatch(r"([\d., ]*)(%?)", line))]
    match = single(matches, "未找到主词条数值对应的行：\n" + main_text)
    if kind in ("ATK", "DEF", "HP") and match[2]:
        kind += "Percent"
    try:
        main_value = parse_number(match[1], culture)
    except ValueError as error:
        raise ValueError("未识别的主词条数值：" + match[1]) from error
    main = dict(Type=kind, Value=main_value, IsUnactivated=False)
    minor = []
    for region in minor_regions:
        match = re.match(r"^([^+:：]+)\+([\d., 。]*)(%?).*$", region["text"])
        if not match:
            continue
        kind = next((kind for kind in ("ATK", "DEF", "HP", "CRITRate", "CRITDMG", "ElementalMastery", "EnergyRecharge")
                     if labels[kind] in match[1]), None)
        if kind is None:
            raise ValueError("未识别的副词条：" + match[1])
        if kind in ("ATK", "DEF", "HP") and match[3]:
            kind += "Percent"
        try:
            value = parse_number(match[2].replace("。", "."), culture)
        except ValueError as error:
            raise ValueError("未识别的副词条数值：" + match[2]) from error
        inactive = False
        if len(minor) >= 3:
            x, y, w, h = rectangle(region["rect"])
            image = crops[3]
            if min(x, y) < 0 or x + w > image.shape[1] or y + h > image.shape[0]:
                raise ValueError("Artifact minor-affix histogram crop is outside its ROI")
            inactive = unactivated(image[y:y + h, x:x + w])
        minor.append(dict(Type=kind, Value=value, IsUnactivated=inactive))
    level_text = single((match[1] for r in minor_regions if (match := re.fullmatch(r"\+(\d*)", r["text"]))),
                        "未找到等级对应的行：\n" + "\n".join(r["text"] for r in minor_regions))
    if not re.fullmatch(r"[0-9]+", level_text) or int(level_text) > 20:
        raise ValueError("未识别的等级：" + level_text)
    return dict(artifact=dict(Name=name, MainAffix=main, MinorAffixes=minor, Level=int(level_text)),
                allText=all_text, regions=dict(zip(("name", "type", "main", "minorAndLevel"), regions)))


def set_params(width, height):
    if min(width, height) <= 0:
        raise ValueError("Capture size must be positive")
    scale = min(width / 1920, height / 1080, 1)
    return dict(roi=box(*(int(value * scale) for value in (40, 100, 1300, 852))), columns=2,
                s1Round=3, roundMilliseconds=40, s2Round=40, s3Scale=.024)


def set_grid_rects(pixels, columns=2):
    gray = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2GRAY)
    edges = cv2.Canny(gray, 20, 40)
    closed = cv2.morphologyEx(edges, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (3, 3)))
    rects = []
    for contour in cv2.findContours(closed, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]:
        rect = tuple(map(int, cv2.boundingRect(contour)))
        width, height = rect[2:]
        if width >= (pixels.shape[1] // columns) * .66 and height and abs(float(np.float32(width) / np.float32(height)) - 8.63) < .4:
            rects.append(rect)
    return rects


def set_grid_cells(rects):
    cells = cells_cluster(rects, 10)
    if not cells:
        return []
    width, height = (average(c["rect"][i] for c in cells) for i in (2, 3))
    col_spacing = cell_spacing(cells, "rowNum", "colNum", 0, 2)
    row_spacing = cell_spacing(cells, "colNum", "rowNum", 1, 3)
    left = average(c["rect"][0] - (width + col_spacing) * c["colNum"] for c in cells)
    top = average(c["rect"][1] - (height + row_spacing) * c["rowNum"] for c in cells)
    for col in range(max(c["colNum"] for c in cells) + 1):
        for row in range(max(c["rowNum"] for c in cells) + 1):
            if not any(c["colNum"] == col and c["rowNum"] == row for c in cells):
                cells.append(dict(rect=[away(left + (width + col_spacing) * col), away(top + (height + row_spacing) * row), away(width), away(height)],
                                  colNum=col, rowNum=row, isPhantom=True))
    return sorted(cells, key=lambda c: (c["rowNum"], c["colNum"]))


def set_icon(pixels, scale):
    height, width = pixels.shape[:2]
    icon, rect = crop(bgr(pixels), (int(width / 2 - 237 * scale - 30), int(height / 2 - 30), 60, 60))
    return cv2.resize(icon, (125, 125)), rect


class SalvageVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.source_root = Path(getattr(bridge, "source_root", None) or os.environ.get("BETTERGI_SOURCE_ROOT") or VENDOR / "source")
        self.model_root = Path(bridge.model_root or os.environ.get("BETTERGI_MODEL_ROOT") or VENDOR / "assets/bettergi.assets.model/Assets/Model")
        self.sessions = {}
        self.next_session = 1
        self.localizations = {}

    def localized(self, culture):
        if culture not in self.localizations:
            self.localizations[culture] = metadata(self.source_root, culture)
        return self.localizations[culture]

    def item_pixels(self, args, card=False):
        image = self.bridge.image(args["handle"])
        if "rect" in args:
            x, y, width, height = rectangle(args["rect"])
            local = (x - image.global_x, y - image.global_y, width, height)
        elif card:
            local = (int(image.width * .70), int(image.height * .112), int(image.width * .275), int(image.height * .50))
        else:
            local = (0, 0, image.width, image.height)
        pixels, rect = crop(image.pixels, local)
        return bgr(pixels), box(rect[0] + image.global_x, rect[1] + image.global_y, rect[2], rect[3])

    def dispatch(self, op, args):
        if op == "salvage.metadata":
            return self.localized(args.get("culture"))
        if op == "salvage.status":
            pixels, rect = self.item_pixels(args)
            return dict(artifact_status(pixels), rect=rect)
        if op == "salvage.artifact":
            pixels, rect = self.item_pixels(args, card=True)
            culture = args.get("culture")
            return dict(recognize_artifact(pixels, lambda image: self.bridge.ocr().run(image),
                                           self.localized(culture)["affixLabels"], culture), rect=rect)
        if op == "salvage.setParams":
            return set_params(args["width"], args["height"])
        if op == "salvage.setGrid":
            image = self.bridge.image(args["handle"])
            params = set_params(image.width, image.height)
            pixels, roi = crop(image.pixels, rectangle(params["roi"]))
            rects = set_grid_rects(pixels)
            cells = set_grid_cells(rects) if args.get("postProcess", True) else []
            def global_rect(rect):
                return box(rect[0] + roi[0] + image.global_x, rect[1] + roi[1] + image.global_y, rect[2], rect[3])
            return dict(params, roi=global_rect((0, 0, roi[2], roi[3])), rawRects=[global_rect(r) for r in rects],
                        cells=[dict(c, rect=global_rect(c["rect"])) for c in cells], width=image.width, height=image.height)
        if op == "salvage.setCreate":
            recognizer = OriginalItemRecognizer(self.model_root, mode_name(args.get("mode", "Item")))
            model = recognizer.status()
            session = f"salvage-set-{self.next_session}"
            self.next_session += 1
            self.sessions[session] = recognizer
            return dict(session=session, model=model)
        if op == "salvage.setIcon":
            pixels, rect = self.item_pixels(args)
            image = self.bridge.image(args["handle"])
            icon, icon_rect = set_icon(pixels, min(image.width / 1920, image.height / 1080, 1))
            return dict(self.sessions[args["session"]].recognize(icon), rect=rect, crop=box(*icon_rect))
        if op == "salvage.setRelease":
            return dict(released=self.sessions.pop(args["session"], None) is not None)
        raise ValueError("Unknown salvage operation: " + op)
