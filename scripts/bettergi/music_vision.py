"""BetterGI AutoMusicGameTask / AutoAlbumTask pixel and template observations.

GPL-3.0-or-later; upstream c9db8b8291fe4ac25a600aee1582298005919eb2.
Native GDI reads are adapted to actual browser screenshot pixels. No timing,
score, input delivery or reward claims are made by this module.
"""
from __future__ import annotations

from dataclasses import replace
import os
from pathlib import Path

import cv2
import numpy as np

VENDOR = Path(__file__).resolve().parents[2] / "third_party/bettergi"
LANES = (("VK_A", 417), ("VK_S", 628), ("VK_D", 844),
         ("VK_J", 1061), ("VK_K", 1277), ("VK_L", 1493))
KEY_Y = 921
UI_NAMES = ("UiLeftTopAlbumIcon", "BtnPause", "AlbumMusicComplate", "BtnList",
            "MusicCanorusLevel1", "MusicCanorusLevel2", "MusicCanorusLevel3",
            "MusicCanorusLevel4", "BtnWhiteConfirm")


def bgr(pixels):
    if not isinstance(pixels, np.ndarray) or pixels.dtype != np.uint8 or pixels.size == 0:
        raise ValueError("Music vision requires nonempty uint8 pixels")
    if pixels.ndim == 2:
        return cv2.cvtColor(pixels, cv2.COLOR_GRAY2BGR)
    if pixels.ndim == 3 and pixels.shape[2] == 4:
        return cv2.cvtColor(pixels, cv2.COLOR_BGRA2BGR)
    if pixels.ndim != 3 or pixels.shape[2] != 3:
        raise ValueError("Music vision requires gray, BGR or BGRA pixels")
    return pixels


def capture_geometry(pixels):
    height, width = pixels.shape[:2]
    if min(width, height) <= 0 or width * 9 != height * 16:
        raise ValueError("自动音游要求游戏画面分辨率为 16:9")
    ratio = min(width / 1920, height / 1080)
    nw, nh = (1920, 1080) if ratio > 1 else (width, height)
    return dict(width=width, height=height, normalizedWidth=nw, normalizedHeight=nh,
                assetScale=min(ratio, 1))


def normalized(pixels, geometry):
    size = geometry["normalizedWidth"], geometry["normalizedHeight"]
    return pixels if pixels.shape[1::-1] == size else cv2.resize(pixels, size, interpolation=cv2.INTER_LINEAR)


def sample_lanes(pixels, use_capture_pipeline=False):
    if not isinstance(use_capture_pipeline, bool):
        raise TypeError("UseCapturePipeline must be boolean")
    pixels = bgr(pixels)
    geometry = capture_geometry(pixels)
    scale = geometry["assetScale"]
    source = normalized(pixels, geometry) if use_capture_pipeline else pixels
    ratio = geometry["width"] / geometry["normalizedWidth"]
    lanes = []
    for key, original_x in LANES:
        x, y = int(original_x * scale), int(KEY_Y * scale)
        if not use_capture_pipeline:
            x, y = int(x * ratio), int(y * ratio)
        inside = 0 <= x < source.shape[1] and 0 <= y < source.shape[0]
        lanes.append(dict(key=key, x=x, y=y, blue=int(source[y, x, 0]) if inside else None,
                          inBounds=inside))
    return dict(**geometry, samplingSpace="normalizedCapture" if use_capture_pipeline else "rawCapture",
                minimumHoldMs=80 if use_capture_pipeline else 0, lanes=lanes)


class MusicVision:
    def __init__(self, bridge):
        self.bridge = bridge
        root = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source"))
        self.source_root = root if (root / "GameTask").is_dir() else root / "BetterGenshinImpact"
        self.recognitions = {}

    def _normalized(self, image):
        pixels = bgr(image.pixels)
        geometry = capture_geometry(pixels)
        return replace(image, pixels=normalized(pixels, geometry), x=0, y=0, global_x=0, global_y=0), geometry

    def _find(self, image, name):
        if name not in UI_NAMES:
            raise ValueError(f"Unknown original music template: {name}")
        key = image.width, image.height, name
        if key not in self.recognitions:
            group = "Common/Element" if name == "BtnWhiteConfirm" else "AutoMusicGame"
            self.recognitions[key] = self.bridge.dispatch("recognition.load", {
                "path": str(self.source_root / f"GameTask/{group}/Assets/Recognition.json"),
                "objectName": name, "width": image.width, "height": image.height})
        matches = self.bridge.find_template(image, self.recognitions[key], False)
        return matches[0] if matches else None

    @staticmethod
    def _raw_region(region, image, geometry):
        if region is None:
            return None
        ratio = geometry["width"] / geometry["normalizedWidth"]
        rect = {key: int(region[key] * ratio) for key in ("x", "y", "width", "height")}
        return dict(**rect, globalX=image.global_x + rect["x"], globalY=image.global_y + rect["y"],
                    matchScore=region["matchScore"])

    def dispatch(self, op, args):
        image = self.bridge.image(args["handle"])
        if op == "music.sample":
            return sample_lanes(image.pixels, args.get("useCapturePipeline", False))
        if op not in ("music.ui", "music.albumPage"):
            raise NotImplementedError(f"Unknown music vision operation: {op}")
        view, geometry = self._normalized(image)
        if op == "music.ui":
            return {name: self._raw_region(self._find(view, name), image, geometry)
                    for name in args.get("names", UI_NAMES)}
        icon = self._find(view, "UiLeftTopAlbumIcon")
        texts = []
        if icon is not None:
            # ImageRegion.DeriveCrop(double) uses Math.Round (ties to even).
            x, y, width, height = map(round, (icon["x"] + icon["width"], icon["y"],
                                              view.width * .16, icon["height"]))
            right, bottom = min(view.width, x + width), min(view.height, y + height)
            x, y = max(0, x), max(0, y)
            if right <= x or bottom <= y:
                raise ValueError("Album OCR crop contains no pixels")
            lines = self.bridge.find_ocr(view, {"type": "Ocr", "roi": [x, y, right - x, bottom - y]}, True)
            texts = [line["text"] for line in lines]
        return dict(**geometry, icon=self._raw_region(icon, image, geometry), texts=texts,
                    allSongs=any("全部" in text for text in texts))
