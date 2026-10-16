"""BetterGI AutoFightSeek and ExperienceDetector observations, GPL-3.0.

Source c9db8b8291fe4ac25a600aee1582298005919eb2. The original RGB thresholds,
four-connected label order, guardian crops and masked experience templates are
retained. This module neither issues input nor latches combat completion.
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from party_vision import asset_geometry, bgr, box, crop

VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
EXPERIENCE_VALUES = (57, 58, 60)


def color_components(pixels, roi, rgb):
    pixels, roi = crop(bgr(pixels), roi, clamp=True)
    mask = cv2.inRange(cv2.cvtColor(pixels, cv2.COLOR_BGR2RGB), rgb, rgb)
    count, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=4, ltype=cv2.CV_32S)
    components = [{**box(*row[:4]), "area": int(row[cv2.CC_STAT_AREA])} for row in stats[1:]]
    return count, components, roi


def seek_components(pixels, mode="seek"):
    pixels = bgr(pixels)
    height, width = pixels.shape[:2]
    if mode == "seek":
        roi = box(0, 0, 1500, 900)
    elif mode == "move":
        roi = box(0, 0, width * 1570 // 1920, height * 970 // 1080)
    else:
        raise ValueError("Fight seek mode must be seek or move")
    _, components, roi = color_components(pixels, roi, (255, 90, 90))
    return dict(components=components, width=width, height=height, roi=roi)


def guardian_cooldown(pixels, skill="E"):
    pixels = bgr(pixels)
    height, width = pixels.shape[:2]
    if skill == "E":
        x, y, w, h = 1688, 988, 22, 12
    elif skill == "Q":
        x, y, w, h = 1809, 968, 30, 15
    else:
        raise ValueError("Guardian skill must be E or Q")
    roi = box(width * x // 1920, height * y // 1080, width * w // 1920, height * h // 1080)
    count, _, roi = color_components(pixels, roi, (255, 255, 255))
    return dict(cooldown=count > 2, componentCount=count, roi=roi)


def guardian_burst(pixels, index=1, q_rect=None):
    pixels = bgr(pixels)
    if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= 4:
        raise ValueError("Guardian index must be1..4")
    height, width = pixels.shape[:2]
    roi = q_rect if q_rect is not None else asset_geometry(width, height)["avatarQRects"][index - 1]
    pixels, roi = crop(pixels, roi, clamp=True)
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    mean = cv2.mean(gray)[0]
    edges = cv2.Canny(gray, float(np.float32(mean * .9)), float(np.float32(mean * 2)))
    circles = cv2.HoughCircles(edges, cv2.HOUGH_GRADIENT, dp=1.2, minDist=20,
                               param1=70, param2=30, minRadius=25, maxRadius=34)
    values = [] if circles is None else [dict(x=float(x), y=float(y), radius=float(r)) for x, y, r in circles.reshape(-1, 3)]
    return dict(ready=bool(values), circles=values, roi=roi, meanBrightness=mean)


def q_ready(pixels, active_index=0):
    pixels = bgr(pixels)
    if not isinstance(active_index, int) or isinstance(active_index, bool) or active_index > 4:
        raise ValueError("Active avatar index must be an integer no greater than4")
    height, width = pixels.shape[:2]
    contrasted = np.clip(pixels.astype(np.int16) * 2 - 200, 0, 255).astype(np.uint8)
    ready, observations = set(), []
    regions = [(index, roi, False) for index, roi in enumerate(asset_geometry(width, height)["avatarQRects"], 1)]
    if active_index > 0:
        regions.append((active_index, box(1762, 915, 114, 111), True))
    for index, roi, center in regions:
        if center:
            contrasted = np.clip(contrasted.astype(np.int16) * 2 - 200, 0, 255).astype(np.uint8)
        area, roi = crop(contrasted, roi, clamp=True)
        gray = cv2.cvtColor(area, cv2.COLOR_BGR2GRAY)
        mean = cv2.mean(gray)[0]
        edges = cv2.Canny(gray, float(np.float32(mean * .9)), float(np.float32(mean * 2)))
        circles = cv2.HoughCircles(edges, cv2.HOUGH_GRADIENT, dp=1.2, minDist=20,
                                   param1=90, param2=35 if center else 25,
                                   minRadius=50 if center else 25, maxRadius=60 if center else 34)
        detected = circles is not None and circles.size > 0
        if detected:
            ready.add(index)
        observations.append(dict(index=index, center=center, roi=roi, ready=detected))
    return dict(readyIndexes=sorted(ready), observations=observations)


def experience_pixel(pixels, match):
    x, y = match["x"] - 147, match["y"]
    height, width = pixels.shape[:2]
    in_bounds = 0 <= x < width and 0 <= y < height
    pixel = pixels[y, x].tolist() if in_bounds else None
    valid = in_bounds and all(lo <= value <= hi for value, lo, hi in zip(pixel, (200, 200, 150), (255, 255, 200)))
    return dict(x=x, y=y, bgr=pixel, inBounds=in_bounds, valid=valid)


class FightVision:
    def __init__(self, bridge):
        self.bridge = bridge
        source = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source"))
        self.source_root = source if (source / "GameTask").is_dir() else source / "BetterGenshinImpact"
        self.templates = {}

    def experience_templates(self, width, height):
        key = (width, height)
        if key not in self.templates:
            root = self.source_root / "GameTask/AutoFight/Assets"
            folder = root / f"{width}x{height}"
            if not folder.is_dir():
                folder = root / "1920x1080"
            values = []
            for value in EXPERIENCE_VALUES:
                path = folder / f"experience_{value}.png"
                if not path.is_file():
                    continue
                try:
                    pixels = cv2.imdecode(np.frombuffer(path.read_bytes(), np.uint8), cv2.IMREAD_COLOR)
                    if pixels is None:
                        continue
                    if width < 1920 and abs(width / 1920 - 1) > .00001:
                        size = int(pixels.shape[1] * width / 1920), int(pixels.shape[0] * width / 1920)
                        if min(size) <= 0:
                            continue
                        pixels = cv2.resize(pixels, size, interpolation=cv2.INTER_LINEAR)
                except (OSError, cv2.error):
                    continue
                mask = cv2.bitwise_not(cv2.inRange(pixels, (0, 255, 0), (0, 255, 0)))
                values.append(dict(name=f"Experience_{value}", path=str(path),
                                   gray=cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY), mask=mask))
            self.templates[key] = values
        return self.templates[key]

    @staticmethod
    def match_experience(pixels, template, roi, threshold):
        x, y, width, height = (roi[key] for key in ("x", "y", "width", "height"))
        source = pixels[y:y + height, x:x + width]
        target = template["gray"]
        if source.shape[0] < target.shape[0] or source.shape[1] < target.shape[1]:
            return None
        source = cv2.cvtColor(source, cv2.COLOR_BGR2GRAY)
        try:
            response = cv2.matchTemplate(source, target, cv2.TM_CCOEFF_NORMED, mask=template["mask"])
        except cv2.error:
            return None
        valid = ~np.isnan(response) & (response >= threshold)
        if not np.any(valid):
            return None
        row, col = np.unravel_index(np.argmax(np.where(valid, response, -np.inf)), response.shape)
        raw = float(response[row, col])
        return {**box(x + col, y + row, target.shape[1], target.shape[0]), "score": raw if np.isfinite(raw) else None}

    def experience(self, pixels):
        pixels = bgr(pixels)
        height, width = pixels.shape[:2]
        roi = box(int(width * .145), int(height * .5), int(width * .02), int(height * .22))
        threshold = .6 if width > 1920 else .9
        result = dict(detected=False, template=None, match=None, pixel=None)
        for template in self.experience_templates(width, height):
            match = self.match_experience(pixels, template, roi, threshold)
            if match is None:
                continue
            pixel = experience_pixel(pixels, match)
            result = dict(detected=pixel["valid"], template=template["name"], match=match, pixel=pixel)
            if pixel["valid"]:
                return result
        return result

    def dispatch(self, op, args):
        pixels = self.bridge.image(args["handle"]).pixels
        if op == "fight.seekComponents":
            return seek_components(pixels, args.get("mode", "seek"))
        if op == "fight.guardianCooldown":
            return guardian_cooldown(pixels, args.get("skill", "E"))
        if op == "fight.guardianBurst":
            return guardian_burst(pixels, args.get("index", 1), args.get("qRect"))
        if op == "fight.qReady":
            return q_ready(pixels, args.get("activeIndex", 0))
        if op == "fight.experience":
            return self.experience(pixels)
        raise NotImplementedError(f"Unknown fight vision operation {op}")
