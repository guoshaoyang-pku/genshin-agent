"""BetterGI RewardResultRecognizer pixel port, GPL-3.0-or-later.

Source c9db8b8291fe4ac25a600aee1582298005919eb2. Original inventory
icon models and GridItemCount OCR are reused; observations are estimates.
"""
from __future__ import annotations

import os
from pathlib import Path

import cv2
import numpy as np

from fishing_vision import OriginalItemRecognizer, bgr, box
from inventory_vision import VENDOR, mode_name, recognize_count

BAND = (220, 444, 1480, 220)
CARD_WIDTH, CARD_HEIGHT = 125, 153


def create_reward_band_mask(pixels):
    hsv = cv2.cvtColor(bgr(pixels), cv2.COLOR_BGR2HSV)
    mask = cv2.inRange(hsv, (0, 0, 190), (179, 20, 249))
    kernel = np.ones((3, 3), np.uint8)
    mask = cv2.morphologyEx(mask, cv2.MORPH_OPEN, kernel)
    return cv2.morphologyEx(mask, cv2.MORPH_CLOSE, kernel)


def detect_card_rects(pixels, mask=None):
    if mask is None:
        mask = create_reward_band_mask(pixels)
    _, _, stats, _ = cv2.connectedComponentsWithStats(mask, connectivity=8, ltype=cv2.CV_32S)
    strips = []
    for x, y, width, height, area in stats[1:]:
        if not (.55 * CARD_WIDTH <= width <= 1.35 * CARD_WIDTH
                and .10 * CARD_HEIGHT <= height <= .50 * CARD_HEIGHT
                and area >= 1200 and y + height / 2 >= .40 * pixels.shape[0]):
            continue
        strips.append(tuple(map(int, (x, y, width, height))))
    if not strips:
        return []
    strips.sort(key=lambda r: r[1] + r[3])
    middle = strips[len(strips) // 2]
    median_bottom = middle[1] + middle[3]
    strips = [r for r in strips if abs(r[1] + r[3] - median_bottom) <= CARD_HEIGHT * .5]
    strips.sort(key=lambda r: r[1] + r[3])
    middle = strips[len(strips) // 2]
    row_bottom = middle[1] + middle[3]
    result = []
    for x, _, width, _ in strips:
        card_x, card_y = x + width // 2 - CARD_WIDTH // 2, row_bottom - CARD_HEIGHT
        if card_x < 0 or card_y < 0 or card_x + CARD_WIDTH > pixels.shape[1] or card_y + CARD_HEIGHT > pixels.shape[0]:
            continue
        result.append((card_x, card_y, CARD_WIDTH, CARD_HEIGHT))
    return sorted(result, key=lambda r: r[0])


class RewardVision:
    def __init__(self, bridge):
        self.bridge = bridge
        self.model_root = Path(bridge.model_root or os.environ.get(
            "BETTERGI_MODEL_ROOT") or VENDOR / "assets/bettergi.assets.model/Assets/Model")
        self.sessions = {}
        self.next_session = 1

    def create(self, mode):
        recognizer = OriginalItemRecognizer(self.model_root, mode_name(mode))
        model = recognizer.status()
        session = f"reward-{self.next_session}"
        self.next_session += 1
        self.sessions[session] = recognizer
        return dict(session=session, model=model, sessions=len(self.sessions))

    def page(self, args):
        recognizer = self.sessions[args["session"]]
        image = self.bridge.image(args["handle"])
        x, y, width, height = BAND
        if image.width < x + width or image.height < y + height:
            raise ValueError("Reward band extends beyond the screenshot")
        band = bgr(image.pixels[y:y + height, x:x + width])
        mask = create_reward_band_mask(band)
        rects = detect_card_rects(band, mask)
        rewards, observations, warnings = [], [], []
        for index, (left, top, card_width, card_height) in enumerate(rects):
            card = band[top:top + card_height, left:left + card_width]
            observed = dict(cardIndex=index, rect=box(left, top, card_width, card_height),
                            icon=None, countRecognition=None, iconError=None, countError=None)
            observations.append(observed)
            try:
                icon = recognizer.recognize(cv2.resize(card, (125, 153))[:125])
                observed["icon"] = icon
                name = icon["name"]
            except Exception as error:
                name = None
                observed["iconError"] = str(error)
            if name is None:
                warnings.append(dict(code="unknownIcon", cardIndex=index,
                                     message="奖励识别：已跳过一个未识别的奖励图标"))
                continue
            count = -1
            try:
                count_result = recognize_count(card, lambda pixels: self.bridge.ocr().recognize(pixels))
                observed["countRecognition"] = count_result
                if count_result["count"] >= 0:
                    count = count_result["count"]
            except Exception as error:
                observed["countError"] = str(error)
            if count < 0:
                warnings.append(dict(code="unknownCount", cardIndex=index,
                                     message="奖励识别：数量识别失败，按原版规则估计为 1 个"))
            rewards.append(dict(name=name, count=count, qualityLevel=-1, cardIndex=index,
                                icon=observed["icon"], countRecognition=observed["countRecognition"]))
        debug = None
        if args.get("debugPath") is not None:
            debug = dict(path=str(args["debugPath"]), saved=False, error=None)
            try:
                target = Path(args["debugPath"])
                target.parent.mkdir(parents=True, exist_ok=True)
                debug_pixels = cv2.cvtColor(mask, cv2.COLOR_GRAY2BGR)
                for left, top, card_width, card_height in rects:
                    cv2.rectangle(debug_pixels, (left, top),
                                  (left + card_width - 1, top + card_height - 1), (50, 205, 50), 2)
                if not cv2.imwrite(str(target), debug_pixels):
                    raise OSError("OpenCV could not save reward debug image")
                debug["saved"] = True
            except Exception as error:
                debug["error"] = str(error)
                warnings.append(dict(code="debugSave", message=str(error)))
        return dict(rewards=rewards, cardRects=[box(*r) for r in rects],
                    observations=observations, warnings=warnings, band=box(*BAND), debug=debug,
                    evidence=dict(kind="model-and-ocr-estimate", verifiedRewards=False))

    def dispatch(self, op, args):
        if op == "reward.create":
            return self.create(args.get("mode", "Item"))
        if op == "reward.page":
            return self.page(args)
        if op == "reward.release":
            released = self.sessions.pop(args["session"], None) is not None
            return dict(released=released, sessions=len(self.sessions))
        raise ValueError(f"Unknown reward operation: {op}")
