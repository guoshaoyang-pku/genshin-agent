"""BetterGI AutoGeniusInvokation pixel observations, GPL-3.0-or-later.

Ported from c9db8b8291fe4ac25a600aee1582298005919eb2. All inputs are
borrowed screenshots; this module neither mutates nor disposes their handles.
"""
from __future__ import annotations

import os
from pathlib import Path
import re

import cv2
import numpy as np

from vision import bgr, gray, template_matches

VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
ELEMENTS = ("anemo", "electro", "dendro", "hydro", "pyro", "cryo", "geo", "omni")
UI_NAMES = ("ConfirmButton", "RoundEndButton", "ElementalTuningConfirmButton",
            "ExitDuelButton", "InOpponentAction", "EndPhase", "ElementalDiceLackWarning",
            "CharacterTakenOut", "InCharacterPick", "CharacterHpUpper")


def box(value):
    if isinstance(value, dict):
        lowered = {k.lower(): v for k, v in value.items()}
        value = [lowered[k] for k in ("x", "y", "width", "height")]
    if len(value) != 4 or any(isinstance(v, bool) or not isinstance(v, (int, float)) or
                              not np.isfinite(v) or int(v) != v for v in value):
        raise ValueError("TCG rectangles require four integer coordinates")
    x, y, width, height = map(int, value)
    if min(width, height) <= 0:
        raise ValueError("TCG rectangle dimensions must be positive")
    return x, y, width, height


def rects(values):
    if len(values) != 3:
        raise ValueError("未能获取到我方三个角色卡位置")
    return [box(value) for value in values]


def crop(pixels, region, clamp=False):
    x, y, width, height = region
    right, bottom = x + width, y + height
    if clamp:
        x, y, right, bottom = max(0, x), max(0, y), min(pixels.shape[1], right), min(pixels.shape[0], bottom)
    if x < 0 or y < 0 or right > pixels.shape[1] or bottom > pixels.shape[0] or right <= x or bottom <= y:
        raise ValueError("TCG OCR/status crop is outside the screenshot")
    return pixels[y:bottom, x:right]


def intersection(first, second):
    x, y = max(first[0], second[0]), max(first[1], second[1])
    right = min(first[0] + first[2], second[0] + second[2])
    bottom = min(first[1] + first[3], second[1] + second[3])
    return max(0, right - x) * max(0, bottom - y)


def iou(first, second):
    area = intersection(first, second)
    return area / (first[2] * first[3] + second[2] * second[3] - area) if area else 0


def character_rects(pixels):
    half = pixels.shape[0] // 2
    rgb = cv2.cvtColor(bgr(pixels)[half:], cv2.COLOR_BGR2RGB)
    mask = cv2.inRange(rgb, (235, 245, 198), (255, 255, 236))
    horizontal = np.count_nonzero(mask, axis=1)
    average = float(horizontal.mean())
    y1 = y2 = start = 0
    in_line = False
    for index, count in enumerate(horizontal):
        if count > average * 10:
            if not in_line:
                in_line, start = True, index
        elif in_line:
            in_line = False
            if y1 == 0:
                y1 = start
            elif y2 == 0 and index - y1 > 20:
                y2 = index
                break
    if not y1 or not y2:
        return dict(rects=[], reason="horizontalProjection")
    vertical = np.count_nonzero(mask, axis=0)
    starts, in_line, start = [], False, 0
    for index, count in enumerate(vertical):
        if count > average * 5:
            if not in_line:
                in_line, start = True, index
        elif index - start > 30 and in_line:
            in_line = False
            starts.append(start)
    if len(starts) != 6:
        return dict(rects=[], reason="verticalProjection", columnStarts=starts)
    return dict(rects=[dict(x=starts[i], y=half + y1, width=starts[i + 1] - starts[i], height=y2 - y1)
                       for i in (0, 2, 4)], method="originalRgbProjection")


class TcgVision:
    def __init__(self, bridge):
        self.bridge = bridge
        root = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source"))
        self.source_root = root if (root / "GameTask").is_dir() else root / "BetterGenshinImpact"
        self.assets = self.source_root / "GameTask/AutoGeniusInvokation/Assets"
        self.recognitions, self.templates = {}, {}

    def _template(self, relative, color=False):
        key = relative, color
        if key not in self.templates:
            self.templates[key] = self.bridge.template({
                "template_path": str(self.assets / "1920x1080" / relative),
                "templateMode": "Color" if color else "Grayscale"})
        return self.templates[key]

    def _matches(self, pixels, relative, threshold=.8, maximum=8):
        template = self._template(relative)
        return template_matches(gray(pixels), template, cv2.TM_CCOEFF_NORMED, None, threshold, maximum)

    def _ui(self, image, names):
        result = {}
        for name in names:
            if name not in UI_NAMES:
                raise ValueError(f"Unknown original TCG template: {name}")
            if name not in self.recognitions:
                self.recognitions[name] = self.bridge.dispatch("recognition.load", {
                    "path": str(self.assets / "Recognition.json"), "objectName": name,
                    "width": image.width, "height": image.height})
            matches = self.bridge.find_template(image, self.recognitions[name], False)
            result[name] = matches[0] if matches else None
        return result

    def _dice(self, pixels, phase, order):
        order = [str(element).lower() for element in order]
        if len(order) != 8 or set(order) != set(ELEMENTS):
            raise ValueError("TCG dice template order must contain all eight original elements once")
        source = bgr(pixels)
        offset = source.shape[1] - source.shape[1] // 5 if phase == "action" else 0
        source = source[:, offset:]
        candidates = []
        for element in order:
            template = self._template(f"dice/{phase}_{element}.png", True)
            matches = template_matches(source, template, cv2.TM_CCOEFF_NORMED, None,
                                       .73 if phase == "roll" else .7, -1)
            for x, y, score in matches:
                candidates.append(dict(element=element, x=x + offset, y=y,
                                       width=template.shape[1], height=template.shape[0], matchScore=score))
        selected = []
        for candidate in sorted(candidates, key=lambda match: -match["matchScore"]):
            region = tuple(candidate[k] for k in ("x", "y", "width", "height"))
            if not any(iou(region, tuple(match[k] for k in ("x", "y", "width", "height"))) >= .5
                       for match in selected):
                selected.append(candidate)
        counts = {element: 0 for element in order}
        for match in selected:
            counts[match["element"]] += 1
        return dict(counts=counts, matches=selected, total=len(selected),
                    upper=sum(match["y"] < pixels.shape[0] // 2 for match in selected),
                    lower=sum(match["y"] >= pixels.shape[0] // 2 for match in selected))

    def _status(self, pixels, region, hp=-2):
        x, y, width, height = region
        view = crop(gray(pixels), (x, y, width + 40, height + 10), True)
        statuses, templates = [], []
        for name in ("角色状态_冻结.png", "角色状态_水泡.png"):
            matches = self._matches(view, f"other/{name}", maximum=1)
            if matches and matches[0][:2] != (0, 0):
                # Upstream assigns Frozen to both templates; preserve its action-blocking rule.
                statuses.append("Frozen")
                templates.append(name)
        energy = len(self._matches(view, "other/满能量.png"))
        return dict(hp=hp, statuses=statuses, statusTemplates=templates, energy=energy)

    def _ocr(self, pixels):
        return "\n".join(line["text"] for line in self.bridge.ocr().run(pixels))

    def _active_hp(self, pixels, regions, defeated, space):
        if len(defeated) != 3 or any(not isinstance(value, bool) for value in defeated):
            raise ValueError("TCG defeated flags require three booleans")
        if isinstance(space, bool) or not isinstance(space, int):
            raise ValueError("ActiveCharacterCardSpace must be an integer")
        hp_array, texts = [0, 0, 0], []
        for index, (x, y, _, _) in enumerate(regions):
            if defeated[index]:
                hp_array[index] = 1
                continue
            text = self._ocr(crop(pixels, (x - 20, y, 60, 55)))
            texts.append(dict(index=index + 1, position="inactive", text=text))
            if text.strip():
                hp_array[index] = 1
                continue
            text = self._ocr(crop(pixels, (x - 20, y - space, 60, 55), True))
            texts.append(dict(index=index + 1, position="active", text=text))
            if text.strip():
                hp_array[index] = 2
                hp = int(text) if re.fullmatch(r"[0-9]+", text) else -2
                return dict(index=index + 1, method="hpOcr", hpArray=hp_array, texts=texts,
                            **self._status(pixels, regions[index], hp))
        if hp_array.count(1) == 2:
            index = next(i for i, state in enumerate(hp_array) if state != 1)
            return dict(index=index + 1, method="hpExclusion", hpArray=hp_array, texts=texts,
                        **self._status(pixels, regions[index]))
        return dict(index=None, method="hpUnresolved", hpArray=hp_array, texts=texts)

    def _active_word(self, pixels, regions):
        half = pixels.shape[0] // 2
        rgb = cv2.cvtColor(bgr(pixels)[half:], cv2.COLOR_BGR2RGB)
        mask = cv2.inRange(rgb, (239, 239, 239), (255, 255, 255))
        mask = cv2.dilate(mask, cv2.getStructuringElement(cv2.MORPH_RECT, (15, 10)))
        contours, _ = cv2.findContours(mask, cv2.RETR_EXTERNAL, cv2.CHAIN_APPROX_SIMPLE)
        candidates = sorted((cv2.boundingRect(contour) for contour in contours), key=lambda rect: rect[1])
        for x, y, width, height in candidates:
            extended = x, half + y, width + 20, height + 20
            for index, region in enumerate(regions):
                if half + y < region[1] and intersection(extended, region):
                    return dict(index=index + 1, method="whiteHpWord", wordRect=list(extended),
                                **self._status(pixels, region))
        return dict(index=None, method="whiteHpWordUnresolved")

    def dispatch(self, op, args):
        image = self.bridge.image(args["handle"])
        if (image.width, image.height) != (1920, 1080):
            raise ValueError("自动七圣召唤要求游戏画面分辨率为1920x1080")
        pixels = image.pixels
        if op == "tcg.ui":
            return self._ui(image, args.get("names", UI_NAMES))
        if op == "tcg.characterRects":
            return character_rects(pixels)
        if op in ("tcg.rollDice", "tcg.actionDice"):
            return self._dice(pixels, "roll" if op == "tcg.rollDice" else "action", args.get("order", ELEMENTS))
        if op == "tcg.diceCount":
            raw, score = self.bridge.ocr().recognize(crop(gray(pixels), (68, 642, 25, 31)))
            text = raw.replace(" ", "")
            for index, char in enumerate("①②③④⑤⑥⑦⑧⑨⑩⑪⑫⑬⑭⑮", 1):
                text = text.replace(char, str(index))
            return dict(count=int(text) if re.fullmatch(r"[0-9]+", text) else -10, raw=raw, text=text, score=score)
        regions = rects(args.get("rects", []))
        if op == "tcg.defeated":
            template = self._template("other/角色被打败.png")
            matches = self._matches(pixels, "other/角色被打败.png")
            boxes = [(x, y, template.shape[1], template.shape[0]) for x, y, _ in matches]
            return dict(defeated=[any(intersection(region, candidate) > 0 for candidate in boxes) for region in regions],
                        matches=[dict(x=x, y=y, width=template.shape[1], height=template.shape[0], matchScore=score)
                                 for x, y, score in matches])
        if op == "tcg.activeHp":
            return self._active_hp(pixels, regions, args.get("defeated", [False] * 3), args.get("activeCharacterCardSpace", 41))
        if op == "tcg.activeWord":
            return self._active_word(pixels, regions)
        raise NotImplementedError(f"Unknown TCG vision operation: {op}")
