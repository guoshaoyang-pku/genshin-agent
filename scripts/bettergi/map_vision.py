"""BetterGI map/orientation algorithms, GPL-3.0, upstream c9db8b8291fe4ac25a600aee1582298005919eb2.

Ports GameTask/Common/Map and Core/Recognition/OpenCv/FeatureMatch. The
unchanged upstream feature files and map images remain the source of truth.
"""

from __future__ import annotations

from dataclasses import dataclass
import json
import math
import os
from pathlib import Path

import cv2
import numpy as np


ALPHA_RADII = np.array([18.632, 20.157, 24.093, 34.617, 38.566, 41.94,
                        47.654, 51.087, 58.561, 63.925, 67.759, 71.77, 75.214], np.float32)
# rows, columns, rows above origin, columns left of origin, image block width, split multiplier
SCENES = {
    "Teyvat": (19, 22, 11, 15, 2048, 2),
    "TheChasm": (2, 2, 1, 1, 1024, 0),
    "Enkanomiya": (3, 3, 1, 1, 1024, 0),
    "AncientSacredMountain": (4, 4, 1, 1, 1024, 0),
    "SeaOfBygoneEras": (3, 4, 2, 5, 1024, 0),
    "TempleOfSpace": (4, 3, 1, 1, 1024, 1),
    "MoonCanon": (9, 17, 3, 10, 1024, 0),
}


def _byte(values):
    return np.clip(np.rint(values), 0, 255).astype(np.uint8)


def _bgr(pixels):
    if pixels is None or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Map operations require nonempty uint8 image pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Map operations require gray, BGR or BGRA images")
    return pixels


def _crop(pixels, args, minimap=False, normalize=False):
    pixels = _bgr(pixels)
    height, width = pixels.shape[:2]
    if args.get("roi") is not None:
        rect = args["roi"]
        if len(rect) != 4 or not all(math.isfinite(v) for v in rect):
            raise ValueError("roi requires four finite numbers")
        x, y, w, h = map(int, rect)
    elif minimap and not args.get("minimap", False):
        scale = min(width / 1920, 1)
        x, y, w, h = (int(v * scale) for v in (62, 19, 212, 212))
    else:
        x, y, w, h = 0, 0, width, height
    right, bottom = min(width, x + w), min(height, y + h)
    x, y = max(0, x), max(0, y)
    if right <= x or bottom <= y:
        raise ValueError("Map roi contains no pixels")
    result = pixels[y:bottom, x:right]
    if normalize and result.shape[:2] != (212, 212):
        result = cv2.resize(result, (212, 212), interpolation=cv2.INTER_LINEAR)
    return result, [x, y, right - x, bottom - y]


def icon_mask(bgr):
    cmax, cmin = bgr.max(axis=2), bgr.min(axis=2)
    equal_gray = (cmax == cmin) & (cmax >= 50) & (cmax <= 127)
    diff = cmax - cmin
    diff = np.minimum(_byte((255 - cmax) / 6), diff)
    diff = cv2.add(diff, 10)
    cmax = cmax.copy()
    cmax[equal_gray] = 255
    ratio = _byte(cmax.astype(np.float32) / diff * 10)
    mask = np.where(ratio > 200, 255, 0).astype(np.uint8)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5))
    return cv2.morphologyEx(cv2.dilate(mask, kernel), cv2.MORPH_CLOSE, kernel)


def _inner(minimap):
    # Preserve upstream's square-input crop and 156-pixel inner map.
    offset = (minimap.shape[1] - 156) // 2
    if offset < 0 or offset + 156 > minimap.shape[0]:
        raise ValueError("Orientation requires a square minimap at least 156 pixels wide")
    return minimap[offset:offset + 156, offset:offset + 156]


class MiniMapPreprocessor:
    def __init__(self):
        radius = np.tile(np.linspace(19, 78, 60, dtype=np.float32), (360, 1))
        theta = np.tile(np.arange(360, dtype=np.float32)[:, None], (1, 60))
        self.map_x, self.map_y = cv2.polarToCart(radius, theta, angleInDegrees=True)
        self.map_x += 78
        self.map_y += 78
        self.radial_alpha1 = (229 + np.searchsorted(ALPHA_RADII, radius)).astype(np.float32)
        self.radial_alpha2 = (137 + 1.43 * radius).astype(np.float32)
        xx, yy = np.meshgrid(np.arange(-78, 78, dtype=np.float32), np.arange(-78, 78, dtype=np.float32))
        radius, angle = cv2.cartToPolar(xx, yy, angleInDegrees=True)
        self.radius, self.angle = _byte(radius), _byte(angle / 2)
        self.alpha1 = (229 + np.searchsorted(ALPHA_RADII, self.radius)).astype(np.uint8)
        self.alpha2 = np.minimum(137 + 1.43 * self.radius, 255).astype(np.uint8)
        self.circle = cv2.circle(np.zeros((156, 156), np.uint8), (78, 78), 78, 255, -1)

    def rotation(self, minimap):
        src = _inner(minimap)
        remap = cv2.remap(src, self.map_x, self.map_y, cv2.INTER_LINEAR)
        icons = cv2.remap(icon_mask(src), self.map_x, self.map_y, cv2.INTER_NEAREST) != 0
        hue = cv2.cvtColor(remap, cv2.COLOR_BGR2HLS_FULL)[:, :, 0].astype(np.float32)
        brightness = cv2.cvtColor(remap, cv2.COLOR_BGR2GRAY).astype(np.float32)
        fa = brightness * 255 / self.radial_alpha1
        fa[icons] = brightness[icons]
        temp = (brightness - 255) * 255 / self.radial_alpha2 + 255
        fb = temp * 255 / self.radial_alpha1
        fb[icons] = temp[icons]
        fa, fb = fa.astype(np.float32), fb.astype(np.float32)
        hist_a = cv2.calcHist([hue, fa], [0, 1], None, [256, 256], [0, 256, 0, 256])
        hist_b = cv2.calcHist([hue, fb], [0, 1], None, [256, 256], [0, 256, 0, 256])
        score = np.zeros((360, 60), np.float32)
        keep = (hue >= 0) & (hue < 256) & (fa >= 0) & (fb < 256)
        score[keep & (fa >= 256)] = 255
        score[keep & (fa < 256) & (fb < 0)] = -255
        middle = keep & (fa < 256) & (fb >= 0)
        hh, aa, bb = hue[middle].astype(int), fa[middle].astype(int), fb[middle].astype(int)
        ha, hb = hist_a[hh, aa], hist_b[hh, bb]
        score[middle] = np.where(ha > hb, 0, np.where(np.abs(ha - hb) < .0001, 100, 255))
        result = cv2.resize(score.sum(axis=1, keepdims=False)[None, :], (720, 1), interpolation=cv2.INTER_CUBIC)
        shifted = np.roll(result, 181, axis=1)
        region_sum = shifted[:, :181].sum(dtype=np.float64)
        integral = cv2.integral(result - shifted)
        _, maximum, _, location = cv2.minMaxLoc(integral)
        angle = (location[0] - 1) / 2 - 45
        if angle < 0:
            angle += 360
        confidence = (maximum + region_sum) / (181 * 60 * 255)
        return float(angle), float(confidence)

    def process(self, minimap):
        src = _inner(minimap)
        angle, _ = self.rotation(minimap)
        sector = np.repeat(self.alpha2[:, :, None], 3, axis=2)
        angle = round(angle)
        cv2.ellipse(sector, (78, 78), (156, 156), 0, angle + 45.5, angle + 314.5, (255, 255, 255), -1)
        output = (src.astype(np.float32) - 255) * 255 / sector + 255
        output = _byte(output * 255 / self.alpha1[:, :, None])
        mask = cv2.bitwise_not(icon_mask(src))
        background = cv2.inRange(output, (165, 165, 55), (180, 180, 75))
        background = cv2.morphologyEx(background, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
        if cv2.countNonZero(background):
            minimum = np.full(256, 255, np.uint8)
            np.minimum.at(minimum, self.angle[background != 0], self.radius[background != 0])
            inside = np.where(self.radius < minimum[self.angle], 255, 0).astype(np.uint8)
            light = cv2.inRange(output, (100, 100, 100), (255, 255, 255))
            mask = cv2.bitwise_or(light, inside, dst=mask, mask=mask)
        return output, cv2.bitwise_and(self.circle, mask)


def gia_rotation(minimap):
    gray = cv2.GaussianBlur(cv2.cvtColor(minimap, cv2.COLOR_BGR2GRAY), (3, 3), 0)
    height, width = gray.shape
    polar = cv2.warpPolar(gray, (360, 360), (width / 2, height / 2), 360,
                          cv2.INTER_LINEAR | cv2.WARP_POLAR_LINEAR | cv2.WARP_FILL_OUTLIERS)
    roi = cv2.rotate(polar[:, 10:80], cv2.ROTATE_90_COUNTERCLOCKWISE)
    gradient = cv2.Scharr(roi, cv2.CV_32F, 1, 0).ravel()
    peaks = np.flatnonzero((gradient[1:-1] > gradient[:-2]) & (gradient[1:-1] > gradient[2:])) + 1
    troughs = np.flatnonzero((gradient[1:-1] < gradient[:-2]) & (gradient[1:-1] < gradient[2:])) + 1
    left = np.bincount(peaks % 360, minlength=360)
    right = np.bincount(troughs % 360, minlength=360)
    left, right = np.maximum(left - right, 0), np.maximum(right - left, 0)
    products = sum(left * np.roll(right, -90 + i) * (3 - abs(i)) // 3 for i in range(-2, 3))
    result = sum(np.roll(products, i) * (3 - abs(i)) // 3 for i in range(-2, 3))
    angle = int(result.argmax()) + 45
    return float(angle - 360 if angle > 360 else angle), bool(result.max() > 0)


def _line8(start, end):
    x, y = map(int, start)
    end_x, end_y = map(int, end)
    dx, dy = abs(end_x - x), abs(end_y - y)
    sx, sy = (1 if x < end_x else -1), (1 if y < end_y else -1)
    error = dx - dy
    while True:
        yield x, y
        if x == end_x and y == end_y:
            return
        twice = 2 * error
        if twice > -dy:
            error -= dy
            x += sx
        if twice < dx:
            error += dx
            y += sy


def character_orientation(minimap):
    candidate = cv2.bitwise_and(cv2.inRange(minimap[:, :, 0], 250, 255),
                                cv2.inRange(minimap[:, :, 2], 0, 10))
    contours, _ = cv2.findContours(candidate, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
    if not contours:
        return -1
    contour = max(contours, key=lambda c: math.prod(cv2.boundingRect(c)[2:]))
    x, y, w, h = cv2.boundingRect(contour)
    triangle = cv2.approxPolyDP(contour, .08 * cv2.arcLength(contour, True), True).reshape(-1, 2)
    if len(triangle) != 3:
        return -1
    hsv = cv2.cvtColor(minimap[y:y + h, x:x + w], cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (93, 155, 170), (255, 255, 255))
    for i in range(3):
        midpoint = (triangle[i] + triangle[(i + 1) % 3]) // 2
        target = triangle[(i + 2) % 3]
        black = 0
        for px, py in _line8(midpoint - [x, y], target - [x, y]):
            if mask[py, px] == 255:
                break
            black += 1
        # The source returns on the first edge with leading black pixels.
        if black > 0:
            delta = target - midpoint
            return int(math.degrees(math.atan2(int(delta[1]), int(delta[0]))))
    return -1


@dataclass
class FeatureLayer:
    points: np.ndarray
    descriptors: np.ndarray
    resource: str
    generated: bool = False
    matcher: object = None


def load_feature_pair(prefix):
    prefix = str(prefix)
    data = Path(prefix + "_SIFT.kp.bin").read_bytes()
    if not data or len(data) % 28:
        raise ValueError("Invalid BetterGI KeyPoint byte count")
    dtype = np.dtype([("float", "<f4", (5,)), ("integer", "<i4", (2,))])
    records = np.frombuffer(data, dtype=dtype)
    if not np.isfinite(records["float"]).all() or np.any(records["float"][:, 2] <= 0):
        raise ValueError("Invalid BetterGI KeyPoint values")
    descriptors = cv2.imread(prefix + "_SIFT.mat.png", cv2.IMREAD_GRAYSCALE)
    if descriptors is None or descriptors.shape != (len(records), 128):
        raise ValueError("BetterGI SIFT descriptor dimensions do not match keypoints")
    return FeatureLayer(records["float"][:, :2].copy(), descriptors.astype(np.float32), prefix)


class MapVision:
    def __init__(self, map_root=None, source_root=None):
        vendor = Path(__file__).resolve().parents[2] / "third_party/bettergi"
        root = map_root or os.environ.get("BETTERGI_MAP_ROOT")
        if root is None:
            root = vendor / "assets/bettergi.assets.map/Assets/Map"
        self.root = Path(root).resolve()
        self.source_root = Path(source_root or os.environ.get("BETTERGI_SOURCE_ROOT")
                                or vendor / "source/BetterGenshinImpact").resolve()
        self.preprocessor = MiniMapPreprocessor()
        self.sift = cv2.SIFT_create()
        self.layers = {}
        self.template_layers = {}
        self.previous_template = {}
        self.sea_teleports = None

    def _templates(self, name):
        if name not in self.template_layers:
            layers = []
            for path in sorted((self.root / name).glob("*.json")):
                definitions = json.loads(path.read_text(encoding="utf-8-sig"))
                if not isinstance(definitions, list):
                    raise ValueError(f"Original template map manifest must be a list: {path}")
                for definition in definitions:
                    if "LayerId" not in definition:
                        raise ValueError(f"Original template map manifest has no LayerId: {path}")
                    layers.append({**definition, "manifest": str(path), "color": None, "gray": None})
            self.template_layers[name] = layers
        return self.template_layers[name]

    def _template_image(self, name, layer, color):
        key = "color" if color else "gray"
        if layer[key] is None:
            extension = ".png" if not color and layer.get("IsOverSize", False) else ".webp"
            path = self.root / name / (layer["LayerId"] + "_" + key + extension)
            layer[key] = cv2.imread(str(path), cv2.IMREAD_COLOR if color else cv2.IMREAD_GRAYSCALE)
            if layer[key] is None:
                raise FileNotFoundError(f"Original template map image missing: {path}")
        return layer[key]

    @staticmethod
    def _template_rect(layer, world, zoom, half_side, size, shape):
        scale = layer.get("Scale", 1)
        cx = round((layer.get("Left", 0) - world[0]) * scale / zoom)
        cy = round((layer.get("Top", 0) - world[1]) * scale / zoom)
        x0, y0 = cx - half_side - size // 2, cy - half_side - size // 2
        x1, y1 = x0 + half_side * 2 + size, y0 + half_side * 2 + size
        x0, y0, x1, y1 = max(0, x0), max(0, y0), min(shape[1], x1), min(shape[0], y1)
        return (x0, y0, x1, y1) if x1 - x0 >= size and y1 - y0 >= size else None

    @staticmethod
    def _template_world(layer, x, y, zoom, size):
        scale = layer.get("Scale", 1)
        return (layer.get("Left", 0) - (x + size / 2) * zoom / scale,
                layer.get("Top", 0) - (y + size / 2) * zoom / scale)

    @staticmethod
    def _rough_value(image, template, mask_f, template_sum):
        channels, templates = cv2.split(image), cv2.split(template)
        result = cv2.matchTemplate(channels[0], templates[0], cv2.TM_CCORR)
        for channel in range(1, 3):
            result = cv2.add(result, cv2.matchTemplate(channels[channel], templates[channel], cv2.TM_CCORR))
        result *= -2
        for channel in channels:
            square = channel.astype(np.float32) ** 2
            result = cv2.add(result, cv2.matchTemplate(square, mask_f, cv2.TM_CCORR))
        minimum, _, location, _ = cv2.minMaxLoc(result)
        return location, minimum + template_sum

    @staticmethod
    def _subpixel(result, location):
        height, width = result.shape
        if width < 3 or height < 3:
            raise ValueError("Original subpixel matcher requires a result at least 3x3")
        x, y = min(max(location[0], 1), width - 2), min(max(location[1], 1), height - 2)
        features = np.array([
            [1/6, -1/3, 1/6, 1/6, -1/3, 1/6, 1/6, -1/3, 1/6],
            [1/6, 1/6, 1/6, -1/3, -1/3, -1/3, 1/6, 1/6, 1/6],
            [1/4, 0, -1/4, 0, 0, 0, -1/4, 0, 1/4],
            [-1/6, 0, 1/6, -1/6, 0, 1/6, -1/6, 0, 1/6],
            [-1/6, -1/6, -1/6, 0, 0, 0, 1/6, 1/6, 1/6],
            [-1/9, 2/9, -1/9, 2/9, 5/9, 2/9, -1/9, 2/9, -1/9],
        ], np.float64)
        a, b, c, d, e, _ = features @ result[y - 1:y + 2, x - 1:x + 2].reshape(9).astype(np.float64)
        discriminant = c * c - 4 * a * b
        if abs(discriminant) < 1e-20:
            return location
        dx = np.clip((2 * b * d - c * e) / discriminant, -1, 1)
        dy = np.clip((2 * a * e - c * d) / discriminant, -1, 1)
        return float(x + dx), float(y + dy)

    def _locate_template(self, pixels, args, name):
        mini, roi = _crop(pixels, args, minimap=True, normalize=True)
        if args.get("preprocess", True):
            mini, mask = self.preprocessor.process(mini)
        else:
            mini = _inner(mini)
            mask = self.preprocessor.circle.copy()
        rough = cv2.resize(mini, (52, 52), interpolation=cv2.INTER_AREA)
        rough_mask = cv2.resize(mask, (52, 52), interpolation=cv2.INTER_NEAREST)
        rough_mask_f = cv2.normalize(rough_mask.astype(np.float32), None, 0, 1, cv2.NORM_MINMAX)
        masked = cv2.bitwise_and(rough, rough, mask=rough_mask)
        template_sum = sum(cv2.norm(channel, cv2.NORM_L2SQR) for channel in cv2.split(masked))
        worst = sum(cv2.norm(np.maximum(channel, 255 - channel), cv2.NORM_L2SQR, rough_mask)
                    for channel in cv2.split(masked))
        result = {"found": False, "position": None, "genshin": None, "rect": None,
                  "corners": None, "homography": None, "matches": 0, "inliers": 0, "inlierRatio": 0,
                  "mapName": name, "floor": None, "coordinateScale": 1, "resource": None,
                  "resourcePosition": None, "resourceRect": None, "roi": roi, "confidence": 0,
                  "method": "BetterGI-TemplateMatch", "matchingMethod": "TemplateMatch"}
        if worst == 0 or not np.any(np.ptp(mini, axis=(0, 1)) > 0):
            return result
        _, _, up, left, block, _ = SCENES[name]
        origin = np.array([(left + 1) * block, (up + 1) * block], np.float64)
        image_scale = block / 1024
        previous = args.get("previous")
        if previous is not None and (previous["x"] <= 0 or previous["y"] <= 0):
            previous = None
        previous_world = None if previous is None else (origin - [previous["x"], previous["y"]]) / image_scale
        layers = self._templates(name)
        if args.get("floor") is not None:
            layers = [layer for layer in layers if layer.get("Floor", 0) == int(args["floor"])]
        if args.get("layerId") is not None:
            layers = [layer for layer in layers if layer["LayerId"] == args["layerId"]]
        if not layers:
            raise FileNotFoundError(f"No original BetterGI template map layers for {name}")
        prior = self.previous_template.get(name)
        if previous_world is not None and prior is not None and tuple(previous_world) == prior[1] and any(layer is prior[0] for layer in layers):
            layers = [prior[0]] + [layer for layer in layers if layer is not prior[0]]
        best, best_value = None, float("inf")
        for layer in layers:
            image = self._template_image(name, layer, True)
            x0, y0, x1, y1 = 0, 0, image.shape[1], image.shape[0]
            if previous_world is not None:
                rect = self._template_rect(layer, previous_world, 5, int(50 * layer.get("Scale", 1)), 52, image.shape)
                if rect is None:
                    continue
                x0, y0, x1, y1 = rect
            if x1 - x0 < 52 or y1 - y0 < 52:
                continue
            location, value = self._rough_value(image[y0:y1, x0:x1], masked, rough_mask_f, template_sum)
            if not math.isfinite(value) or not (0 <= value <= worst) or value >= best_value:
                continue
            world = self._template_world(layer, x0 + location[0], y0 + location[1], 5, 52)
            if previous_world is not None and world == (0, 0):
                continue
            best_value, best = value, (layer, world)
            if previous_world is not None and prior is not None and layer is prior[0] and (1 - value / worst) >= .99:
                break
        result["roughConfidence"] = 1 - best_value / worst if best is not None else 0
        if best is None or result["roughConfidence"] < .95:
            return result
        layer, world = best
        gray = self._template_image(name, layer, False)
        exact = cv2.resize(cv2.cvtColor(mini, cv2.COLOR_BGR2GRAY), (260, 260), interpolation=cv2.INTER_CUBIC)
        exact_mask = cv2.resize(mask, (260, 260), interpolation=cv2.INTER_NEAREST)
        rect = self._template_rect(layer, world, 1, 20, 260, gray.shape)
        if rect is None:
            return result
        x0, y0, x1, y1 = rect
        scores = cv2.matchTemplate(gray[y0:y1, x0:x1], exact, cv2.TM_SQDIFF, mask=exact_mask)
        minimum, _, location, _ = cv2.minMaxLoc(scores)
        worst_exact = cv2.norm(np.maximum(exact, 255 - exact), cv2.NORM_L2SQR, exact_mask)
        if worst_exact <= 0 or not math.isfinite(minimum) or not (0 <= minimum <= worst_exact):
            return result
        confidence = 1 - minimum / worst_exact
        result["confidence"] = confidence
        rank = min(max(int(args.get("rank", 2)), 0), 2) if previous is not None else 2
        if confidence < (.99, .97, .95)[rank]:
            return result
        sub_x, sub_y = self._subpixel(scores, location)
        world = self._template_world(layer, x0 + sub_x, y0 + sub_y, 1, 260)
        if world == (0, 0):
            return result
        position = origin - np.array(world) * image_scale
        self.previous_template[name] = layer, tuple(world)
        result.update(found=True, position={"x": float(position[0]), "y": float(position[1])},
                      genshin={"x": float(world[0]), "y": float(world[1])}, floor=layer.get("Floor", 0),
                      resource=str(self.root / name / layer["LayerId"]), layerId=layer["LayerId"],
                      manifest=layer["manifest"], method="BetterGI-TemplateMatch-local" if previous is not None else "BetterGI-TemplateMatch")
        return result

    def _resources(self, name, big=False):
        folder = self.root / name
        if big and name == "Teyvat":
            return [(0, folder / "Teyvat_0_256")]
        block = SCENES[name][4]
        result = {}
        for path in folder.glob(f"{name}_*_{block}_SIFT.kp.bin"):
            floor = int(path.name.split("_")[1])
            result[floor] = path.with_name(path.name.removesuffix("_SIFT.kp.bin"))
        for extension in ("png", "webp"):
            for path in folder.glob(f"{name}_*_{block}.{extension}"):
                result.setdefault(int(path.name.split("_")[1]), path.with_suffix(""))
        return sorted(result.items(), reverse=True)

    def _layer(self, prefix):
        key = str(prefix)
        if key not in self.layers:
            if Path(key + "_SIFT.kp.bin").is_file():
                layer = load_feature_pair(key)
            else:
                image_path = next((Path(key + ext) for ext in (".png", ".webp") if Path(key + ext).is_file()), None)
                if image_path is None:
                    raise FileNotFoundError(f"Original BetterGI map resource missing: {prefix}")
                image = cv2.imread(str(image_path), cv2.IMREAD_GRAYSCALE)
                points, descriptors = self.sift.detectAndCompute(image, None)
                if descriptors is None:
                    raise ValueError(f"Original map contains no SIFT features: {image_path}")
                layer = FeatureLayer(np.array([point.pt for point in points], np.float32),
                                     _byte(descriptors).astype(np.float32), str(image_path), True)
            self.layers[key] = layer
        return self.layers[key]

    @staticmethod
    def _subset(layer, name, big, previous, previous_rect, query_shape):
        rows, cols, _, _, block, multiplier = SCENES[name]
        scale = 8 if big and name == "Teyvat" else 1
        width, height = cols * block / scale, rows * block / scale
        if big and name == "Teyvat":
            multiplier = 4
        if multiplier == 0 or (previous is None and previous_rect is None):
            return None
        cell_w, cell_h = int(width) // (cols * multiplier), int(height) // (rows * multiplier)
        if not big:
            col = round(float(previous["x"]) / cell_w)
            row = round(float(previous["y"]) / cell_h)
            c0, c1, r0, r1 = col - 1, col + 1, row - 1, row + 1
        else:
            if previous_rect is not None:
                if isinstance(previous_rect, dict):
                    x, y, w, h = (float(previous_rect[k]) / scale for k in ("x", "y", "width", "height"))
                else:
                    x, y, w, h = (float(v) / scale for v in previous_rect)
                expand = 1
            else:
                w, h = round(min(width, max(query_shape[1] * 2, width / 4))), round(min(height, max(query_shape[0] * 2, height / 4)))
                x = min(max(round(float(previous["x"]) / scale - w / 2), 0), width - w)
                y = min(max(round(float(previous["y"]) / scale - h / 2), 0), height - h)
                expand = 2
            c0, c1 = int(x / cell_w) - expand, int((x + w) / cell_w) + expand
            r0, r1 = int(y / cell_h) - expand, int((y + h) / cell_h) + expand
        max_col, max_row = cols * multiplier - 1, rows * multiplier - 1
        if big:
            c0, c1 = min(max(c0, 0), max_col), min(max(c1, 0), max_col)
            r0, r1 = min(max(r0, 0), max_row), min(max(r1, 0), max_row)
        else:
            c0, c1, r0, r1 = max(c0, 0), min(c1, max_col), max(r0, 0), min(r1, max_row)
        cell_cols = np.clip((layer.points[:, 0] / cell_w).astype(int), 0, max_col)
        cell_rows = np.clip((layer.points[:, 1] / cell_h).astype(int), 0, max_row)
        return np.flatnonzero((cell_cols >= c0) & (cell_cols <= c1) & (cell_rows >= r0) & (cell_rows <= r1))

    @staticmethod
    def _match(layer, query_points, query_descriptors, shape, indices=None, brute=False, ordinary=False):
        if query_descriptors is None or len(query_points) < 4:
            return None
        points = layer.points if indices is None else layer.points[indices]
        descriptors = layer.descriptors if indices is None else layer.descriptors[indices]
        if len(points) < 2:
            return None
        if brute:
            matcher = cv2.BFMatcher(cv2.NORM_L2)
        elif indices is not None:
            matcher = cv2.FlannBasedMatcher()
        else:
            if layer.matcher is None:
                layer.matcher = cv2.FlannBasedMatcher()
                layer.matcher.add([descriptors])
                layer.matcher.train()
            matcher = layer.matcher
        if ordinary:
            matches = matcher.match(query_descriptors, descriptors) if indices is not None or brute else matcher.match(query_descriptors)
            minimum = min((match.distance for match in matches), default=1000)
            good = [match for match in matches if match.distance < max(minimum * 2, .02)]
        else:
            matches = matcher.knnMatch(query_descriptors, descriptors, k=2) if indices is not None or brute else matcher.knnMatch(query_descriptors, k=2)
            good = [pair[0] for pair in matches if len(pair) == 2 and pair[0].distance < .75 * pair[1].distance]
        if len(good) < (4 if ordinary else 7):
            return None
        src = np.float64([query_points[m.queryIdx].pt for m in good])
        dst = np.float64([points[m.trainIdx] for m in good])
        homography, inlier_mask = cv2.findHomography(src, dst, cv2.RANSAC, 3)
        if homography is None or not np.isfinite(homography).all():
            return None
        height, width = shape[:2]
        query = np.float32([[[width / 2, height / 2], [0, 0], [0, height], [width, height], [width, 0]]])
        transformed = cv2.perspectiveTransform(query, homography)[0]
        if not np.isfinite(transformed).all():
            return None
        return {"position": transformed[0], "corners": transformed[1:], "homography": homography,
                "matches": len(good), "inliers": int(inlier_mask.sum())}

    def _sea_resources(self):
        if self.sea_teleports is None:
            task_root = self.source_root / "GameTask"
            icon_path = task_root / "QuickTeleport/Assets/1920x1080/TeleportTransparentBackground.png"
            icon = cv2.imread(str(icon_path), cv2.IMREAD_UNCHANGED)
            if icon is None or icon.ndim != 3 or icon.shape[2] != 4:
                raise FileNotFoundError(f"Original teleport template missing or invalid: {icon_path}")
            catalog = task_root / "AutoTrackPath/Assets/tp.json"
            scenes = json.loads(catalog.read_text(encoding="utf-8-sig"))["data"]
            scene = next(scene for scene in scenes if scene["mapName"] == "SeaOfBygoneEras")
            points = []
            for point in scene["points"]:
                if point["type"] == "TeleportWaypoint":
                    world = np.float32([point["tranPosition"][2], point["tranPosition"][0]])
                    # OpenCvSharp Point(double,double) truncates, unlike WorldToMap's Math.Round.
                    points.append(tuple(np.trunc(np.float32([6144, 3072]) - world).astype(int)))
            self.sea_teleports = icon, np.array(sorted(points), np.float64), str(catalog)
        return self.sea_teleports

    def _sea_rect(self, gray, args, capture_width):
        icon, map_points, catalog = self._sea_resources()
        asset_scale = float(args.get("assetScale", min(float(args.get("captureWidth", capture_width)) / 1920, 1)))
        if not math.isfinite(asset_scale) or asset_scale <= 0:
            raise ValueError("assetScale must be finite and positive")
        if asset_scale != 1:
            size = tuple(max(1, round(d * asset_scale)) for d in (icon.shape[1], icon.shape[0]))
            icon = cv2.resize(icon, size, interpolation=cv2.INTER_LINEAR)
        if gray.shape[0] < icon.shape[0] + 2 or gray.shape[1] < icon.shape[1] + 2:
            return None
        template = cv2.cvtColor(icon, cv2.COLOR_BGRA2GRAY)
        scores = cv2.matchTemplate(gray, template, cv2.TM_CCORR_NORMED, mask=icon[:, :, 3])
        maxima = cv2.dilate(scores, np.ones((3, 3), np.uint8))
        yy, xx = np.where((scores[1:-1, 1:-1] > .99) & np.isfinite(scores[1:-1, 1:-1])
                          & (scores[1:-1, 1:-1] >= maxima[1:-1, 1:-1]))
        points = []
        for y, x in zip(yy + 1, xx + 1):
            point = np.array([x, y], np.float64)
            if all(np.linalg.norm(point - prior) >= 50 for prior in points):
                points.append(point)
        if len(points) < 2:
            return None
        screen_points = np.array(sorted(tuple(point + 12) for point in points), np.float64)

        def angle(first, second):
            dx, dy = first - second
            return 90 if dy == 0 else math.degrees(math.atan(dx / dy))

        reference = min(((i, j) for i in range(len(screen_points)) for j in range(i + 1, len(screen_points))),
                        key=lambda pair: abs(abs(angle(screen_points[pair[0]], screen_points[pair[1]])) - 45))
        rp0, rp1 = screen_points[list(reference)]
        reference_angle = angle(rp0, rp1)
        reference_distance = np.linalg.norm(rp0 - rp1)
        best_deviation, transform = float("inf"), None
        for i, mp0 in enumerate(map_points):
            for mp1 in map_points[i + 1:]:
                if abs(angle(mp0, mp1) - reference_angle) >= 5:
                    continue
                scale = np.linalg.norm(mp0 - mp1) / reference_distance
                offset = mp0 - rp0 * scale
                transformed = np.trunc(screen_points * scale + offset)
                distances = np.linalg.norm(transformed[:, None, :] - map_points[None, :, :], axis=2)
                deviation = float(distances.min(axis=1).sum())
                if deviation < best_deviation:
                    best_deviation, transform = deviation, (scale, offset)
        if transform is None or best_deviation >= 200:
            return None
        scale, offset = transform
        first = np.trunc(offset).astype(int)
        last = np.trunc(np.array([gray.shape[1], gray.shape[0]]) * scale + offset).astype(int)
        rect = [int(first[0]), int(first[1]), int(last[0] - first[0]), int(last[1] - first[1])]
        if rect[2] <= 0 or rect[3] <= 0:
            return None
        return rect, scale, offset, len(screen_points), best_deviation, catalog

    def _locate(self, pixels, args, big):
        args = dict(args)
        previous = args.get("previous")
        if previous is not None:
            if not all(math.isfinite(float(previous[key])) for key in ("x", "y")):
                raise ValueError("previous requires finite x,y")
            if (big and previous["x"] == 0 and previous["y"] == 0) or (not big and previous["x"] <= 0 and previous["y"] <= 0):
                args.pop("previous")
        previous_rect = args.get("previousRect")
        if previous_rect is not None:
            values = [previous_rect[key] for key in ("x", "y", "width", "height")] if isinstance(previous_rect, dict) else previous_rect
            if len(values) != 4 or not all(math.isfinite(float(value)) for value in values) or values[2] <= 0 or values[3] <= 0:
                raise ValueError("previousRect requires finite x,y and positive width,height")
        name = args.get("mapName", "Teyvat")
        name = next((key for key in SCENES if key.casefold() == name.casefold()), name)
        if name not in SCENES:
            raise ValueError(f"Unknown BetterGI map: {name}")
        matching_method = args.get("matchingMethod", "SIFT" if big else "TemplateMatch")
        if matching_method not in ("SIFT", "TemplateMatch"):
            raise ValueError(f"Unknown BetterGI map matching method: {matching_method}")
        match_target = args.get("matchTarget", "rect")
        if match_target not in ("rect", "position"):
            raise ValueError(f"Unknown BetterGI map match target: {match_target}")
        if not big and matching_method == "TemplateMatch" and name in ("Teyvat", "TheChasm", "Enkanomiya"):
            return self._locate_template(pixels, args, name)
        preprocess = not big and args.get("preprocess", True)
        query, roi = _crop(pixels, args, minimap=not big, normalize=preprocess)
        mask = None
        if preprocess:
            query, mask = self.preprocessor.process(query)
        query = cv2.cvtColor(query, cv2.COLOR_BGR2GRAY)
        if big and name == "SeaOfBygoneEras":
            sea = self._sea_rect(query, args, pixels.shape[1])
            if sea is not None:
                rect, scale, offset, count, deviation, catalog = sea
                x, y, w, h = rect
                center = {"x": x + w // 2, "y": y + h // 2}
                return {"found": True, "position": center,
                        "genshin": {"x": 6144 - center["x"], "y": 3072 - center["y"]},
                        "rect": dict(zip(("x", "y", "width", "height"), rect)),
                        "corners": [[x, y], [x, y + h], [x + w, y + h], [x + w, y]],
                        "homography": [[scale, 0, float(offset[0])], [0, scale, float(offset[1])], [0, 0, 1]],
                        "matches": count, "inliers": 0, "inlierRatio": 0, "teleportCount": count,
                        "deviation": deviation, "mapName": name, "floor": 0, "coordinateScale": 1,
                        "resource": catalog, "resourcePosition": center,
                        "resourceRect": dict(zip(("x", "y", "width", "height"), rect)),
                        "method": "BetterGI-teleport-constellation", "matchingMethod": "Teleports", "roi": roi}
        coordinate_scale, query_scale = (8, .25) if big and name == "Teyvat" else (1, 1)
        if query_scale != 1:
            query = cv2.resize(query, None, fx=query_scale, fy=query_scale, interpolation=cv2.INTER_LINEAR)
        points, descriptors = self.sift.detectAndCompute(query, mask)
        if args.get("featurePrefix"):
            resources = [(int(args.get("floor", 0)), Path(args["featurePrefix"]))]
        else:
            resources = self._resources(name, big)
            if args.get("floor") is not None:
                resources = [(floor, path) for floor, path in resources if floor == int(args["floor"])]
            if big:
                resources = resources[:1]
        if not resources:
            raise FileNotFoundError(f"No original BetterGI map layers for {name}, floor={args.get('floor')}")
        result = {"found": False, "position": None, "genshin": None, "rect": None,
                  "corners": None, "homography": None, "matches": 0, "inliers": 0,
                  "inlierRatio": 0, "mapName": name, "floor": None, "coordinateScale": coordinate_scale,
                  "resource": None, "method": "sift-knn-ransac", "matchingMethod": "SIFT", "roi": roi,
                  "resourcePosition": None, "resourceRect": None}
        if descriptors is None or len(points) < 4:
            return result
        for floor, prefix in resources:
            layer = self._layer(prefix)
            previous = args.get("previous")
            previous_rect = args.get("previousRect") if big else None
            indices = self._subset(layer, name, big, previous, previous_rect, query.shape)
            ordinary = big and match_target == "position" and indices is None
            match = self._match(layer, points, descriptors, query.shape, indices,
                                brute=not big and previous is not None, ordinary=ordinary)
            local = indices is not None
            if match is None and big and local:
                ordinary = match_target == "position"
                match = self._match(layer, points, descriptors, query.shape, ordinary=ordinary)
                local = False
            if match is None:
                continue
            center = match["position"] * coordinate_scale
            corners = match["corners"] * coordinate_scale
            homography = np.diag([coordinate_scale, coordinate_scale, 1]) @ match["homography"]
            # Homography accepts coordinates of the supplied query, before its quarter-size resize.
            homography = homography @ np.diag([query_scale, query_scale, 1])
            rect = cv2.boundingRect(corners)
            resource_rect = cv2.boundingRect(match["corners"])
            _, _, up, left, block, _ = SCENES[name]
            world = ((left + 1) * block - center[0]) / (block / 1024), ((up + 1) * block - center[1]) / (block / 1024)
            result.update(found=True, position={"x": float(center[0]), "y": float(center[1])},
                          genshin={"x": float(world[0]), "y": float(world[1])},
                          rect=dict(zip(("x", "y", "width", "height"), rect)), corners=corners.tolist(),
                          homography=homography.tolist(), matches=match["matches"], inliers=match["inliers"],
                          inlierRatio=match["inliers"] / match["matches"], floor=floor, resource=layer.resource,
                          resourcePosition={"x": float(match["position"][0]), "y": float(match["position"][1])},
                          resourceRect=dict(zip(("x", "y", "width", "height"), resource_rect)),
                          method="sift-knn-ransac-local" if local else "sift-match-ransac" if ordinary else "sift-knn-ransac",
                          generatedFeatures=layer.generated)
            return result
        return result

    def dispatch(self, op, args=None, pixels=None):
        args = args or {}
        if op == "map.status":
            scenes = {}
            for name in SCENES:
                resources = self._resources(name)
                scenes[name] = [{"floor": floor, "prefix": str(path),
                                 "precomputed": Path(str(path) + "_SIFT.kp.bin").is_file()}
                                for floor, path in resources]
            return {"root": str(self.root), "available": self.root.is_dir(), "scenes": scenes,
                    "loadedLayers": len(self.layers), "algorithm": "BetterGI-TemplateMatch/SIFT",
                    "templateLayers": {name: len(self._templates(name)) for name in ("Teyvat", "TheChasm", "Enkanomiya")},
                    "sourceRoot": str(self.source_root),
                    "upstreamCommit": "c9db8b8291fe4ac25a600aee1582298005919eb2"}
        if op == "map.locateMinimap" or op == "map.locateBigMap":
            return self._locate(pixels, args, op == "map.locateBigMap")
        if op not in ("map.cameraOrientation", "map.characterOrientation"):
            raise NotImplementedError(f"Unknown map operation: {op}")
        minimap, roi = _crop(pixels, args, minimap=True, normalize=True)
        if op == "map.characterOrientation":
            angle = character_orientation(minimap)
            return {"angle": angle, "valid": angle != -1, "method": "BetterGI-character-triangle", "roi": roi}
        method = args.get("method", "auto")
        if method not in ("auto", "v2", "gia"):
            raise ValueError(f"Unknown camera orientation method: {method}")
        angle, confidence = self.preprocessor.rotation(minimap)
        valid = bool(np.any(np.ptp(minimap, axis=(0, 1)) > 0))
        used = "v2"
        if method == "gia" or (method == "auto" and confidence < .2):
            angle, evidence = gia_rotation(minimap)
            valid = valid and evidence
            used = "gia"
        elif confidence < .2:
            valid = False
        return {"angle": angle if valid else None, "confidence": confidence, "valid": valid, "method": used, "roi": roi}
