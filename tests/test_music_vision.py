"""Original music pixel coordinates, normalized matching and resource execution."""
from pathlib import Path
import json
import sys
import unittest
from unittest.mock import Mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from music_vision import (KEY_Y, LANES, UI_NAMES, MusicVision, bgr,
                          capture_geometry, sample_lanes)
from vision import VisionBridge, load_recognition

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "third_party/bettergi/source/BetterGenshinImpact"
MUSIC_ASSETS = SOURCE / "GameTask/AutoMusicGame/Assets"


def frame(width=1920, height=1080, color=255):
    return np.full((height, width, 3), color, np.uint8)


class MusicPixelsTest(unittest.TestCase):
    def test_active_lane_coordinates_and_bgr_blue_channel(self):
        pixels = frame()
        for i, (_, x) in enumerate(LANES):
            pixels[KEY_Y, x] = (219 if i % 2 == 0 else 220, 2, 0)
        result = sample_lanes(pixels)
        self.assertEqual(result["minimumHoldMs"], 0)
        self.assertEqual(result["samplingSpace"], "rawCapture")
        self.assertEqual([(r["key"], r["x"], r["y"], r["blue"]) for r in result["lanes"]],
                         [(key, x, 921, 219 if i % 2 == 0 else 220) for i, (key, x) in enumerate(LANES)])
        self.assertTrue(all(r["inBounds"] for r in result["lanes"]))

    def test_under1080_coordinates_truncate_before_sampling(self):
        pixels = frame(1280, 720)
        for i, (_, x) in enumerate(LANES):
            pixels[int(921 * 2 / 3), int(x * 2 / 3)] = (i, 200, 255)
        for pipeline in (False, True):
            result = sample_lanes(pixels, pipeline)
            self.assertEqual(result["assetScale"], 2 / 3)
            self.assertEqual([r["x"] for r in result["lanes"]], [278, 418, 562, 707, 851, 995])
            self.assertEqual([r["y"] for r in result["lanes"]], [614] * 6)
            self.assertEqual([r["blue"] for r in result["lanes"]], list(range(6)))

    def test_4k_default_samples_source_convert_position_before_any_resize(self):
        pixels = frame(3840, 2160)
        for _, x in LANES:
            pixels[1842, x * 2] = (0, 255, 255)
        raw = sample_lanes(pixels, False)
        pipeline = sample_lanes(pixels, True)
        self.assertEqual([r["x"] for r in raw["lanes"]], [x * 2 for _, x in LANES])
        self.assertEqual([r["blue"] for r in raw["lanes"]], [0] * 6)
        self.assertEqual([r["x"] for r in pipeline["lanes"]], [x for _, x in LANES])
        self.assertEqual([r["blue"] for r in pipeline["lanes"]], [192] * 6)
        self.assertEqual(pipeline["minimumHoldMs"], 80)
        self.assertEqual(pipeline["normalizedWidth"], 1920)

    def test_pipeline_uses_exact_linear_normalization_at1440p(self):
        rng = np.random.default_rng(17)
        pixels = rng.integers(0, 256, (1440, 2560, 3), dtype=np.uint8)
        expected = cv2.resize(pixels, (1920, 1080), interpolation=cv2.INTER_LINEAR)
        result = sample_lanes(pixels, True)
        self.assertEqual([r["blue"] for r in result["lanes"]], [int(expected[921, x, 0]) for _, x in LANES])
        raw = sample_lanes(pixels, False)
        self.assertEqual([r["x"] for r in raw["lanes"]], [int(x * 4 / 3) for _, x in LANES])

    def test_gray_bgra_and_invalid_pixels(self):
        self.assertEqual(bgr(np.full((2, 2), 17, np.uint8))[0, 0].tolist(), [17, 17, 17])
        self.assertEqual(bgr(np.full((2, 2, 4), (7, 8, 9, 0), np.uint8))[0, 0].tolist(), [7, 8, 9])
        for pixels in (np.zeros((0, 2, 3), np.uint8), np.zeros((2, 2, 2), np.uint8), np.zeros((2, 2, 3), np.float32), None):
            with self.assertRaises(ValueError):
                bgr(pixels)
        with self.assertRaises(ValueError):
            sample_lanes(frame(1920, 1200))
        with self.assertRaises(TypeError):
            sample_lanes(frame(), "false")

    def test_geometry_is_exact16by9_and_capped_at1080(self):
        self.assertEqual(capture_geometry(frame(1280, 720)), dict(width=1280, height=720, normalizedWidth=1280, normalizedHeight=720, assetScale=2 / 3))
        self.assertEqual(capture_geometry(frame(3840, 2160)), dict(width=3840, height=2160, normalizedWidth=1920, normalizedHeight=1080, assetScale=1))


class MusicTemplateTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.music = MusicVision(self.bridge)

    def descriptor(self, pixels):
        return self.bridge.put(pixels, "ImageRegion")

    def recognition(self, name, width=1920, height=1080):
        group = "Common/Element" if name == "BtnWhiteConfirm" else "AutoMusicGame"
        return load_recognition(SOURCE / f"GameTask/{group}/Assets/Recognition.json", name, width, height)

    def assembled(self, name, width=1920, height=1080):
        pixels = frame(width, height, 0)
        recognition = self.recognition(name, width, height)
        template = self.bridge.template(recognition)
        rx, ry, rw, rh = recognition.get("roi", [0, 0, width, height])
        x, y = rx + 2, ry + 2
        self.assertLessEqual(template.shape[1] + 2, rw)
        self.assertLessEqual(template.shape[0] + 2, rh)
        pixels[y:y + template.shape[0], x:x + template.shape[1]] = template
        return pixels, (x, y, template.shape[1], template.shape[0])

    def test_all_retained_original_templates_match_actual_pixels(self):
        for name in UI_NAMES:
            with self.subTest(name=name):
                pixels, rect = self.assembled(name)
                handle = self.descriptor(pixels)["handle"]
                result = self.music.dispatch("music.ui", {"handle": handle, "names": [name]})[name]
                self.assertIsNotNone(result)
                self.assertEqual(tuple(result[k] for k in ("x", "y", "width", "height")), rect)
                self.assertGreater(result["matchScore"], .99)
                self.bridge.dispatch("image.dispose", {"handle": handle})
        self.assertEqual(self.bridge.images, {})

    def test_template_does_not_match_outside_original_roi(self):
        recognition = self.recognition("AlbumMusicComplate")
        template = self.bridge.template(recognition)
        pixels = frame(color=0)
        pixels[100:100 + template.shape[0], 100:100 + template.shape[1]] = template
        handle = self.descriptor(pixels)["handle"]
        self.assertIsNone(self.music.dispatch("music.ui", {"handle": handle, "names": ["AlbumMusicComplate"]})["AlbumMusicComplate"])

    def test_4k_ui_normalizes_original_assets_then_maps_to_raw_capture(self):
        pixels, rect = self.assembled("BtnList")
        pixels = cv2.resize(pixels, (3840, 2160), interpolation=cv2.INTER_NEAREST)
        handle = self.descriptor(pixels)["handle"]
        self.bridge.image(handle).global_x = 7
        self.bridge.image(handle).global_y = 11
        result = self.music.dispatch("music.ui", {"handle": handle, "names": ["BtnList"]})["BtnList"]
        self.assertEqual(tuple(result[k] for k in ("x", "y", "width", "height")), tuple(v * 2 for v in rect))
        self.assertEqual(result["globalX"], result["x"] + 7)
        self.assertEqual(result["globalY"], result["y"] + 11)
        self.assertEqual(len(self.bridge.images), 1, "observation creates no image handles")

    def test_under1080_template_uses_original_scaled_asset(self):
        pixels, rect = self.assembled("UiLeftTopAlbumIcon", 1280, 720)
        handle = self.descriptor(pixels)["handle"]
        found = self.music.dispatch("music.ui", {"handle": handle, "names": ["UiLeftTopAlbumIcon"]})["UiLeftTopAlbumIcon"]
        self.assertEqual(tuple(found[k] for k in ("x", "y", "width", "height")), rect)

    def test_album_page_reads_exact_right_of_icon_crop_and_contains_all(self):
        pixels, rect = self.assembled("UiLeftTopAlbumIcon")
        handle = self.descriptor(pixels)["handle"]
        ocr = Mock()
        ocr.run.return_value = [dict(text="全部歌曲", rect=[0, 0, 60, 20], score=.98)]
        self.bridge.ocr_engine = ocr
        page = self.music.dispatch("music.albumPage", {"handle": handle})
        self.assertTrue(page["allSongs"])
        self.assertEqual(page["texts"], ["全部歌曲"])
        expected = pixels[rect[1]:rect[1] + rect[3], rect[0] + rect[2]:rect[0] + rect[2] + round(1920 * .16)]
        np.testing.assert_array_equal(ocr.run.call_args.args[0], expected)

    def test_missing_icon_does_not_initialize_or_call_ocr(self):
        handle = self.descriptor(frame(color=0))["handle"]
        self.bridge.ocr_engine = Mock()
        page = self.music.dispatch("music.albumPage", {"handle": handle})
        self.assertIsNone(page["icon"])
        self.assertFalse(page["allSongs"])
        self.bridge.ocr_engine.run.assert_not_called()

    def test_unknown_template_op_or_disposed_handle_is_explicit_failure(self):
        handle = self.descriptor(frame())["handle"]
        with self.assertRaises(ValueError):
            self.music.dispatch("music.ui", {"handle": handle, "names": ["Invented"]})
        with self.assertRaises(NotImplementedError):
            self.music.dispatch("music.fake", {"handle": handle})
        self.bridge.dispatch("image.dispose", {"handle": handle})
        with self.assertRaises(ValueError):
            self.music.dispatch("music.sample", {"handle": handle})

    def test_original_recognition_asset_names_and_rois_remain_exact(self):
        objects = json.loads((MUSIC_ASSETS / "Recognition.json").read_text())["objects"]
        self.assertEqual(objects["AlbumMusicComplate"]["template"], "album_music_complate.png")
        self.assertEqual(objects["BtnList"]["roi"], "cutRightBottom(0.4, 0.2)")
        self.assertEqual([self.recognition(f"MusicCanorusLevel{i}")["roi"] for i in range(1, 5)],
                         [[450, y, 200, 60] for y in (430, 520, 610, 690)])


if __name__ == "__main__":
    unittest.main()
