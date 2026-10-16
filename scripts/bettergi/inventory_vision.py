"""BetterGI GridScreen and CountInventoryItem observations, GPL-3.0.

Source: c9db8b8291fe4ac25a600aee1582298005919eb2. Reuses the retained
ItemV2/GridIcon recognizer and Paddle models; no input or page lifecycle here.
"""
from __future__ import annotations

import csv
import hashlib
import math
import os
from pathlib import Path

import cv2
import numpy as np

from fishing_vision import OriginalItemRecognizer, bgr, box

VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
PAGES = ("Weapons", "Artifacts", "CharacterDevelopmentItems", "Food", "Materials",
         "Gadget", "Quest", "PreciousItems", "Furnishings", "ArtifactSalvage",
         "ArtifactSetFilter", "Crafting", "PartySetupCharacters")
PAGE_DESCRIPTIONS = ("武器", "圣遗物", "养成道具", "食物", "材料", "小道具", "任务",
                     "贵重道具", "摆设", "圣遗物分解", "圣遗物套装筛选", "合成", "队伍配置角色")


def page_name(value):
    if isinstance(value, int) and not isinstance(value, bool) and 0 <= value < len(PAGES):
        return PAGES[value]
    if isinstance(value, str):
        for name, description in zip(PAGES, PAGE_DESCRIPTIONS):
            if value.lower() == name.lower() or value == description:
                return name
    raise ValueError(f"Unknown GridScreenName: {value}")


def mode_name(value):
    if value in (0, "GridIcon") and not isinstance(value, bool):
        return "GridIcon"
    if value in (1, "Item") and not isinstance(value, bool):
        return "Item"
    raise ValueError(f"Unknown ItemIconRecognitionMode: {value}")


def grid_params(page, width, height):
    page = page_name(page)
    if min(width, height) <= 0:
        raise ValueError("Capture size must be positive")
    roi, columns, s2, s3 = (106, 110, 1171, 845), 8, 32, .024
    if page == "Artifacts":
        roi = (106, 162, 1171, 783)
    elif page == "ArtifactSalvage":
        roi, columns, s2, s3 = (48, 106, 1267, 768), 9, 28, .018
    elif page == "Crafting":
        roi, columns = (45, 170, 705, 790), 5
    elif page == "PartySetupCharacters":
        roi, columns, s2, s3 = (24, 86, 766, 743), 5, 28, .018
    elif page == "ArtifactSetFilter":
        raise ValueError("ArtifactSetFilter has no original GridParams template")
    scale = min(width / 1920, height / 1080, 1)
    return dict(page=page, roi=box(*(int(v * scale) for v in roi)), columns=columns,
                s1Round=3, roundMilliseconds=40, s2Round=s2, s3Scale=s3)


def rectangle(value):
    values = [value[k] for k in ("x", "y", "width", "height")] if isinstance(value, dict) else list(value)
    if len(values) != 4 or any(isinstance(v, bool) or not isinstance(v, (int, float))
                               or not math.isfinite(v) or int(v) != v for v in values):
        raise ValueError("Grid rectangle requires four finite integers")
    if min(values[2:]) <= 0:
        raise ValueError("Grid rectangle must have positive size")
    return tuple(map(int, values))


def clamp(rect, width, height):
    x, y, w, h = rect
    left, top = max(x, 0), max(y, 0)
    return left, top, max(0, min(x + w, width) - left), max(0, min(y + h, height) - top)


def crop(pixels, rect):
    x, y, w, h = clamp(rect, pixels.shape[1], pixels.shape[0])
    if min(w, h) <= 0:
        raise ValueError("Grid rectangle has no pixels inside the source")
    return pixels[y:y + h, x:x + w], (x, y, w, h)


def grid_items(pixels, columns, alpha=False):
    if not isinstance(columns, int) or isinstance(columns, bool) or columns < 1:
        raise ValueError("Grid columns must be positive integer")
    pixels = bgr(pixels)
    if alpha:
        hsv = cv2.cvtColor(pixels, cv2.COLOR_BGR2HSV)
        edges = [cv2.convertScaleAbs(cv2.Laplacian(hsv[:, :, channel], cv2.CV_64F, ksize=3))
                 for channel in (1, 2)]
        blurred = cv2.GaussianBlur(cv2.bitwise_or(*edges), (3, 3), .5)
        binary = cv2.threshold(blurred, 50, 255, cv2.THRESH_BINARY)[1]
    else:
        grey = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
        edge = cv2.Canny(grey, 20, 40)
        binary = cv2.morphologyEx(edge, cv2.MORPH_CLOSE, cv2.getStructuringElement(cv2.MORPH_RECT, (5, 5)))
    contours = cv2.findContours(binary, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_NONE)[0]
    result = []
    for contour in contours:
        points = contour.reshape(-1, 2)
        x, y, width, height = cv2.boundingRect(points)
        keep = ~((points[:, 0] - x > width * .60) & (points[:, 1] - y < height * .28))
        points = points[keep]
        if not len(points):
            continue
        rect = cv2.boundingRect(points)
        width, height = rect[2:]
        ratio = float(np.float32(width) / np.float32(height)) if height else 0
        if width >= (pixels.shape[1] // columns) * .66 and height and abs(ratio - .81) < .03:
            result.append(tuple(map(int, rect)))
    return result


def away(value):
    return int(math.copysign(math.floor(abs(value) + .5), value))


def cells_cluster(rects, threshold):
    cells = [dict(rect=list(rect), colNum=0, rowNum=0, isPhantom=False) for rect in rects]
    if not cells:
        return cells
    for coordinate, size, key in ((0, 2, "colNum"), (1, 3, "rowNum")):
        average = int(sum(c["rect"][size] for c in cells) / len(cells))
        index, last = 0, None
        for cell in sorted(cells, key=lambda c: c["rect"][coordinate]):
            value = cell["rect"][coordinate]
            if last is not None and value - last > threshold:
                index += round(float(np.float32(value - last) / np.float32(average + threshold)))
            cell[key], last = index, value
    return cells


def average(values):
    values = list(values)
    return sum(values) / len(values) if values else 0.


def cell_spacing(cells, group_key, index_key, coordinate, size):
    spacings = []
    for group in dict.fromkeys(c[group_key] for c in cells):
        selected = [c for c in cells if c[group_key] == group]
        for i in range(max(c[index_key] for c in selected)):
            left = [c for c in selected if c[index_key] == i]
            right = [c for c in selected if c[index_key] == i + 1]
            if len(left) > 1 or len(right) > 1:
                raise ValueError("Original GridCell.SingleOrDefault found duplicate row/column")
            if left and right:
                spacings.append(right[0]["rect"][coordinate] - left[0]["rect"][coordinate] - left[0]["rect"][size])
    return average(spacings)


def correct_bottom_color(pixels, tolerance=30):
    if not pixels.size:
        raise ValueError("Bottom image is empty")
    mask = np.full(pixels.shape[:2], 255, np.uint8)
    x, y, w, h = clamp((6, 0, 113, 21), pixels.shape[1], pixels.shape[0])
    mask[y:y + h, x:x + w] = 0
    if not cv2.countNonZero(mask):
        return False
    color = cv2.mean(pixels, mask=mask)
    return sum(abs(color[i] - target) for i, target in enumerate((220, 229, 233))) <= tolerance * 3


def post_process(pixels, rects, threshold):
    cells = cells_cluster(rects, threshold)
    if not cells:
        return []
    if len(cells) >= 3:
        medians = []
        for size in (2, 3):
            ordered = sorted(c["rect"][size] for c in cells)
            middle = len(ordered) // 2
            medians.append(ordered[middle] if len(ordered) % 2 else away((ordered[middle - 1] + ordered[middle]) / 2))
        width, height = medians
        tolerance = max(2, threshold // 4)
        for cell in cells:
            x, y, w, h = cell["rect"]
            if w > width + tolerance or h > height + tolerance:
                cell["rect"] = list(clamp((away(x + w / 2 - width / 2), away(y + h / 2 - height / 2), width, height),
                                          pixels.shape[1], pixels.shape[0]))
    width = average(c["rect"][2] for c in cells)
    height = average(c["rect"][3] for c in cells)
    col_spacing = cell_spacing(cells, "rowNum", "colNum", 0, 2)
    row_spacing = cell_spacing(cells, "colNum", "rowNum", 1, 3)
    left = average(c["rect"][0] - (width + col_spacing) * c["colNum"] for c in cells)
    top = average(c["rect"][1] - (height + row_spacing) * c["rowNum"] for c in cells)
    max_col, max_row = max(c["colNum"] for c in cells), max(c["rowNum"] for c in cells)
    for column in range(max_col + 1):
        for row in range(max_row + 1):
            if not any(c["colNum"] == column and c["rowNum"] == row for c in cells):
                cells.append(dict(rect=[away(left + (width + col_spacing) * column), away(top + (height + row_spacing) * row),
                                        away(width), away(height)], colNum=column, rowNum=row, isPhantom=True))
    rows = []
    for row in sorted(set(c["rowNum"] for c in cells)):
        selected = [c for c in cells if c["rowNum"] == row]
        rows.append((row, average(c["rect"][1] for c in selected), average(c["rect"][3] for c in selected)))
    spacings = [b[1] - a[1] - a[2] for a, b in zip(rows, rows[1:]) if b[1] - a[1] - a[2] >= 0]
    if len(rows) >= 2 and spacings:
        width = average(c["rect"][2] for c in cells)
        height = average(c["rect"][3] for c in cells)
        next_y = rows[-1][1] + rows[-1][2] + average(spacings)
        if next_y + height <= pixels.shape[0]:
            spacings = []
            for row in sorted(set(c["rowNum"] for c in cells)):
                selected = sorted((c for c in cells if c["rowNum"] == row), key=lambda c: c["colNum"])
                for a, b in zip(selected, selected[1:]):
                    spacing = b["rect"][0] - a["rect"][0] - a["rect"][2]
                    if b["colNum"] == a["colNum"] + 1 and spacing >= 0:
                        spacings.append(spacing)
            col_spacing = average(spacings)
            left = average(c["rect"][0] - (width + col_spacing) * c["colNum"] for c in cells)
            for column in range(max_col + 1):
                cells.append(dict(rect=[away(left + (width + col_spacing) * column), away(next_y), away(width), away(height)],
                                  colNum=column, rowNum=max_row + 1, isPhantom=True))
    result = []
    for cell in cells:
        if cell["isPhantom"]:
            x, y, w, h = cell["rect"]
            if min(x, y) < 0 or x + w > pixels.shape[1] or y + h > pixels.shape[0] or min(w, h) <= 0:
                continue
            bottom = cv2.resize(pixels[y:y + h, x:x + w], (125, 153))[126:153]
            if not correct_bottom_color(bottom):
                continue
        result.append(cell)
    return sorted(result, key=lambda c: (c["rowNum"], c["colNum"]))


def normalize_number_text(text):
    return "".join(chr(ord(c) - 0xFEE0) if "０" <= c <= "９" else c for c in (text or "")).strip()


def strict_count(text):
    text = normalize_number_text(text)
    if not text or any(c < "0" or c > "9" for c in text):
        return None
    value = int(text)
    return value if value <= 2147483647 else None


def prepare_count(pixels):
    h, w = pixels.shape[:2]
    count = pixels[h * 128 // 153:h * 150 // 153, w * 5 // 125:w * 120 // 125]
    if not count.size:
        raise ValueError("Inventory count crop is empty")
    resized = cv2.resize(bgr(count), (count.shape[1] * 3, count.shape[0] * 3))
    mask = cv2.inRange(cv2.cvtColor(resized, cv2.COLOR_BGR2HSV), (0, 0, 0), (180, 140, 210))
    contours = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)[0]
    components = sorted((cv2.boundingRect(c) for c in contours), key=lambda r: r[0])
    components = [(x, y, w, h) for x, y, w, h in components
                  if w > 1 and h >= 12 and w * h >= 20 and y + h >= mask.shape[0] * .55]
    result = dict(count=-2, rawText="", reason="EMPTY", componentCount=0, foregroundBounds=box(0, 0, 0, 0))
    if not components:
        return result, None
    x, y = min(r[0] for r in components), min(r[1] for r in components)
    width = max(r[0] + r[2] for r in components) - x
    height = max(r[1] + r[3] for r in components) - y
    inverted = cv2.bitwise_not(mask[y:y + height, x:x + width])
    scaled_width = max(1, round(width * 48 / height))
    scaled = cv2.resize(inverted, (scaled_width, 48), interpolation=cv2.INTER_NEAREST)
    normalized = np.full((60, scaled_width + 48), 255, np.uint8)
    normalized[6:54, 24:24 + scaled_width] = scaled
    result.update(componentCount=len(components), foregroundBounds=box(x, y, width, height), reason=None)
    return result, normalized


def recognize_count(pixels, recognize):
    result, normalized = prepare_count(pixels)
    if normalized is None:
        return result
    raw = recognize(normalized)
    raw = raw[0] if isinstance(raw, tuple) else raw
    text = normalize_number_text(raw)
    count = strict_count(text)
    bounds = result["foregroundBounds"]
    ratio = bounds["width"] / bounds["height"]
    result["rawText"] = raw
    if result["componentCount"] == 1 and ratio <= .45 and count != 1:
        result.update(count=1, reason="NARROW_ONE")
    elif count is None:
        result.update(reason="PARSE")
    elif result["componentCount"] == 1 and text == "1" and ratio >= .65:
        result.update(count=7, reason="WIDE_SEVEN")
    else:
        result["count"] = count
    return result


def scrolling(previous, following, lower=.5, upper=.95):
    def grey(image):
        return cv2.cvtColor(bgr(image), cv2.COLOR_BGR2GRAY).astype(np.float32)
    previous, following = grey(previous), grey(following)
    if previous.shape != following.shape:
        raise ValueError("Scroll captures must have equal size")
    shift, response = cv2.phaseCorrelate(previous, following)
    return dict(isScrolling=lower < response < upper, shift=dict(x=float(shift[0]), y=float(shift[1])), response=float(response))


class InventoryVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.model_root = Path(bridge.model_root or os.environ.get("BETTERGI_MODEL_ROOT") or VENDOR / "assets/bettergi.assets.model/Assets/Model")
        self.table = self.model_root / "ItemV2/item.csv"
        self.entries = None
        self.recognizers = {}
        self.metadata_error = None

    def metadata(self, names=None):
        if self.entries is None:
            self.entries = {}
            try:
                entries = {}
                with self.table.open(encoding="utf-8-sig", newline="") as stream:
                    rows = csv.DictReader(stream)
                    rows.fieldnames = [key.strip().lower() for key in rows.fieldnames]
                    for row in rows:
                        name, description = row["item_name"].strip(), row["page"].strip()
                        if description not in PAGE_DESCRIPTIONS:
                            continue
                        index = PAGE_DESCRIPTIONS.index(description)
                        raw = row["sort_order"].strip()
                        try:
                            order = int(raw) if raw and raw.lstrip("+-").isascii() and raw.lstrip("+-").isdigit() else None
                        except ValueError:
                            order = None
                        if order is not None and not -2147483648 <= order <= 2147483647:
                            order = None
                        entries[name] = dict(name=name, page=PAGES[index], pageIndex=index, sortOrder=order)
                self.entries = entries
            except (OSError, csv.Error, KeyError, TypeError, AttributeError, UnicodeError) as error:
                self.metadata_error = str(error)
        names = list(self.entries) if names is None else names
        return dict(entries=[self.entries[name] for name in names if name in self.entries],
                    missing=[name for name in names if name not in self.entries], entryCount=len(self.entries),
                    table=dict(path=str(self.table.resolve()), sha256=hashlib.sha256(self.table.read_bytes()).hexdigest() if self.table.is_file() else None),
                    error=self.metadata_error)

    def recognizer(self, mode):
        mode = mode_name(mode)
        if mode not in self.recognizers:
            self.recognizers[mode] = OriginalItemRecognizer(self.model_root, mode)
        return self.recognizers[mode]

    def roi(self, args, image):
        params = grid_params(args.get("page", "Weapons"), image.width, image.height)
        rect = rectangle(args.get("roi", params["roi"]))
        pixels, rect = crop(image.pixels, rect)
        return bgr(pixels), rect, params

    def item_pixels(self, args):
        image = self.bridge.image(args["handle"])
        if "rect" not in args:
            return bgr(image.pixels), box(image.global_x, image.global_y, image.width, image.height)
        x, y, w, h = rectangle(args["rect"])
        pixels, rect = crop(image.pixels, (x - image.global_x, y - image.global_y, w, h))
        return bgr(pixels), box(rect[0] + image.global_x, rect[1] + image.global_y, rect[2], rect[3])

    def dispatch(self, op, args):
        if op == "inventory.metadata":
            return self.metadata(args.get("names"))
        if op == "inventory.params":
            return grid_params(args["page"], args["width"], args["height"])
        if op == "inventory.modelStatus":
            return self.recognizer(args.get("mode", "Item")).status()
        if op == "inventory.release":
            if "mode" in args:
                self.recognizers.pop(mode_name(args["mode"]), None)
            else:
                self.recognizers.clear()
            return dict(released=True)
        if op == "inventory.count":
            pixels, _ = self.item_pixels(args)
            return recognize_count(pixels, lambda image: self.bridge.ocr().recognize(image))
        if op == "inventory.itemText":
            pixels, _ = self.item_pixels(args)
            height, width = pixels.shape[:2]
            text = pixels[height * 128 // 153:height * 150 // 153, width * 5 // 125:width * 120 // 125]
            if not text.size:
                raise ValueError("Grid item text crop is empty")
            resized = cv2.resize(text, (text.shape[1] * 2, text.shape[0] * 2))
            result = self.bridge.ocr().recognize(resized)
            return {"text": result[0] if isinstance(result, tuple) else result}
        if op == "inventory.item":
            pixels, rect = self.item_pixels(args)
            icon = cv2.resize(pixels, (125, 153))[:125]
            result = self.recognizer(args.get("mode", "Item")).recognize(icon)
            result["rect"] = rect
            if args.get("readCount", False):
                result.update(recognize_count(pixels, lambda image: self.bridge.ocr().recognize(image)))
            return result
        if op == "inventory.grid":
            image = self.bridge.image(args["handle"])
            pixels, roi, params = self.roi(args, image)
            columns = args.get("columns", params["columns"])
            rects = grid_items(pixels, columns, args.get("findContoursAlpha", False))
            cells = post_process(pixels, rects, int(.025 * roi[3])) if args.get("postProcess", True) else []
            x, y = roi[0] + image.global_x, roi[1] + image.global_y
            def global_rect(rect):
                return box(rect[0] + x, rect[1] + y, rect[2], rect[3])
            return dict(roi=box(x, y, roi[2], roi[3]), columns=columns,
                        rawRects=[global_rect(r) for r in rects],
                        cells=[dict(c, rect=global_rect(c["rect"])) for c in cells], width=image.width, height=image.height)
        if op == "inventory.scrolling":
            previous = self.bridge.image(args["previousHandle"])
            following = self.bridge.image(args["nextHandle"])
            return scrolling(self.roi(args, previous)[0], self.roi(args, following)[0],
                             args.get("lowerThreshold", .5), args.get("upperThreshold", .95))
        raise NotImplementedError(f"Unknown inventory observation: {op}")
