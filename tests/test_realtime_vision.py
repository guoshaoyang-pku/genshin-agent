"""Pixel fixtures for the source AutoPick/AutoSkip algorithms; no game input."""

from pathlib import Path
import hashlib
import json
import os
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from realtime_vision import (RealtimeVision, YapOcr, _gradient, black_rate, bottom_triangle,
                             character_popup, decode_yap, goods_rects, projection_rect,
                             text_bounding_rect, yap_tensor)

MODEL_ROOT = Path(os.environ.get("BETTERGI_MODEL_ROOT", Path(__file__).resolve().parents[1]
                                / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"))


def color(hsv):
    return tuple(int(v) for v in cv2.cvtColor(np.uint8([[hsv]]), cv2.COLOR_HSV2BGR)[0, 0])


def triangle(image, x, y, hsv=(20, 250, 250), size=8):
    points = np.array([[x, y], [x + size, y], [x + size // 2, y + size]], np.int32)
    cv2.fillConvexPoly(image, points, color(hsv))


def popup(width=1800, height=300, y=395, dark=True):
    image = np.zeros((1080, 1920, 3), np.uint8)
    x = (1920 - width) // 2
    image[y:y + height, x:x + width] = (229, 241, 245)
    if dark:
        image[y + height // 2:y + height, x:x + width] = (101, 82, 74)
    return image


class PickTextTest(unittest.TestCase):
    def setUp(self):
        self.ocr = Mock()
        self.ocr.recognize.return_value = ('  「甜甜花」\n', .99)
        self.ocr.run.return_value = []
        self.bridge = Mock()
        self.bridge.model_root = MODEL_ROOT
        self.bridge.ocr.return_value = self.ocr
        self.vision = RealtimeVision(self.bridge)

    def test_guard_uses_first_three_rows_and_never_initializes_ocr(self):
        image = np.full((24, 80, 3), 255, np.uint8)
        image[:4] = np.repeat(np.arange(255, 15, -3, dtype=np.uint8)[None, :, None], 4, axis=0)
        result = self.vision.dispatch("realtime.pickText", {"roi": dict(x=0, y=0, width=80, height=24)}, image)
        self.assertTrue(result["alreadyPicking"])
        self.assertLess(result["avgGradient"], -3)
        self.assertEqual(result["text"], "")
        self.assertIsNone(result["textBounds"])
        self.bridge.ocr.assert_not_called()

    def test_sobel_keeps_nonisolated_csharp_mat_parent_border(self):
        image = np.zeros((9, 30), np.uint8)
        image[:, 3:12] = 255
        roi = (4, 2, 8, 6)
        expected = float(cv2.Sobel(image, cv2.CV_32F, 1, 0)[2:5, 4:12].mean())
        self.assertLess(expected, -3)
        self.assertAlmostEqual(_gradient(image, roi), expected)
        isolated = cv2.Sobel(image[2:5, 4:12], cv2.CV_32F, 1, 0).mean()
        self.assertEqual(isolated, 0)

    def test_direct_recognizer_crops_bounds_plus_five_without_normalizing_text(self):
        image = np.zeros((40, 100, 3), np.uint8)
        image[17:27, 8:32] = 255
        result = self.vision.pick_text(image, dict(x=5, y=10, width=70, height=24))
        self.assertFalse(result["alreadyPicking"])
        self.assertEqual(result["text"], '  「甜甜花」\n')
        self.assertEqual(result["textBounds"], dict(x=0, y=0, width=27, height=24))
        crop = self.ocr.recognize.call_args.args[0]
        self.assertEqual(crop.shape, (24, 32, 3))
        np.testing.assert_array_equal(crop, image[10:34, 5:37])
        self.ocr.run.assert_not_called()

    def test_direct_crop_clamps_to_original_roi(self):
        image = np.zeros((14, 35, 3), np.uint8)
        image[5:12] = 255
        result = self.vision.pick_text(image, dict(x=0, y=0, width=35, height=14))
        self.assertEqual(result["textBounds"]["width"], 34)
        self.assertEqual(self.ocr.recognize.call_args.args[0].shape, image.shape)

    def test_detector_fallback_sorts_by_center_and_preserves_newlines_and_whitespace(self):
        self.ocr.run.return_value = [
            {"rect": [0, 10, 4, 2], "text": "  下方"},
            {"rect": [20, 0, 4, 2], "text": "右边"},
            {"rect": [5, 0, 4, 2], "text": "左边\n"},
        ]
        image = np.zeros((20, 90, 3), np.uint8)
        result = self.vision.pick_text(image, dict(x=0, y=0, width=90, height=20))
        self.assertEqual(result["text"], "左边\n\n右边\n  下方")
        self.assertEqual(result["textBounds"], dict(x=0, y=0, width=0, height=0))
        self.ocr.recognize.assert_not_called()
        np.testing.assert_array_equal(self.ocr.run.call_args.args[0], image)

    def test_detector_order_uses_rotated_centers_instead_of_top_left(self):
        self.ocr.run.return_value = [
            {"rect": [0, 0, 40, 80], "points": [[0, 0], [20, 0], [20, 60], [0, 60]], "text": "后"},
            {"rect": [50, 1, 40, 80], "points": [[50, 1], [70, 1], [70, 11], [50, 11]], "text": "先"},
        ]
        result = self.vision.pick_text(np.zeros((20, 90, 3), np.uint8), dict(x=0, y=0, width=90, height=20))
        self.assertEqual(result["text"], "先\n后")

    def test_yap_is_lazy_cached_and_uses_gray_roi_without_text_extraction(self):
        image = np.zeros((20, 90, 3), np.uint8)
        image[7:15, 20:35] = (20, 120, 240)
        with patch("realtime_vision.YapOcr") as factory, patch("realtime_vision.text_bounding_rect") as bounds:
            factory.return_value.recognize.return_value = ' 「原样」\n '
            request = {"roi": dict(x=5, y=3, width=60, height=16), "ocrEngine": "Yap"}
            result = self.vision.dispatch("realtime.pickText", request, image)
            self.assertEqual(result["text"], ' 「原样」\n ')
            self.assertFalse(result["alreadyPicking"])
            self.assertIsNone(result["textBounds"])
            expected = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)[3:19, 5:65]
            np.testing.assert_array_equal(factory.return_value.recognize.call_args.args[0], expected)
            self.vision.dispatch("realtime.pickText", request, image)
            factory.assert_called_once_with(MODEL_ROOT)
            bounds.assert_not_called()
        self.bridge.ocr.assert_not_called()

    def test_yap_gradient_guard_does_not_load_yap_or_paddle(self):
        image = np.tile(np.arange(255, 15, -3, dtype=np.uint8), (20, 1))
        with patch("realtime_vision.YapOcr") as factory:
            result = self.vision.dispatch("realtime.pickText", {
                "roi": dict(x=0, y=0, width=80, height=20), "ocrEngine": "Yap"}, image)
            self.assertTrue(result["alreadyPicking"])
            self.assertIsNone(self.vision.yap_engine)
            factory.assert_not_called()
        self.bridge.ocr.assert_not_called()

    def test_yap_can_reuse_loaded_paddle_model_root_without_initializing_paddle(self):
        self.bridge.model_root = None
        self.bridge.ocr_engine = Mock(root=MODEL_ROOT)
        with patch("realtime_vision.YapOcr") as factory:
            self.assertIs(self.vision.yap(), factory.return_value)
            self.assertIs(self.vision.yap(), factory.return_value)
            factory.assert_called_once_with(MODEL_ROOT)
        self.bridge.ocr.assert_not_called()

    def test_projection_maxgap_and_original_last_index_width(self):
        binary = np.zeros((7, 100), np.uint8)
        binary[:, 0:4] = 255
        binary[:, 34:39] = 255  # Exactly 30 blank columns remains connected.
        binary[:, 70:80] = 255  # 31 blank columns breaks before this part.
        self.assertEqual(projection_rect(binary), dict(x=0, y=0, width=38, height=7))
        binary[:] = 0
        binary[:, 30:40] = 255
        self.assertEqual(projection_rect(binary)["width"], 39)
        binary[:, 30] = 0
        self.assertEqual(projection_rect(binary), dict(x=0, y=0, width=0, height=0))
        binary[:] = 0
        binary[:, 0] = 255
        self.assertEqual(projection_rect(binary), dict(x=0, y=0, width=0, height=7))

    def test_threshold_strict_160_and_erode_once_dilate_twice(self):
        image = np.zeros((12, 70), np.uint8)
        image[4:8, :10] = 160
        image[4:8, 12:24] = 161
        image[4:8, 50:54] = 255
        image[9, 0] = 255  # One-pixel noise is eroded out.
        result = text_bounding_rect(image)
        self.assertEqual(result, dict(x=0, y=0, width=54, height=12))
        image[:, 12:24] = 160
        self.assertEqual(text_bounding_rect(image), dict(x=0, y=0, width=0, height=0))

    def test_invalid_roi_and_pixels_raise_before_ocr(self):
        image = np.zeros((20, 30, 3), np.uint8)
        for roi in (None, [], {}, dict(x=-1, y=0, width=2, height=2),
                    dict(x=0, y=0, width=31, height=2), dict(x=0, y=19, width=2, height=2),
                    dict(x=0, y=0, width=0, height=2), dict(x=.5, y=0, width=2, height=2),
                    dict(x=float("nan"), y=0, width=2, height=2), dict(x=True, y=0, width=2, height=2)):
            with self.subTest(roi=roi), self.assertRaises(ValueError):
                self.vision.pick_text(image, roi)
        for pixels in (None, np.zeros((0, 3), np.uint8), np.zeros((20, 30), np.float32), np.zeros((20, 30, 2), np.uint8)):
            with self.subTest(pixels=type(pixels)), self.assertRaises(ValueError):
                self.vision.pick_text(pixels, dict(x=0, y=0, width=2, height=2))
        self.bridge.ocr.assert_not_called()


class YapOcrTest(unittest.TestCase):
    def test_tensor_resizes_to_221x32_then_pads_to_384_without_normalizing_mean(self):
        gray = np.zeros((16, 117), np.uint8)
        gray[:, :40] = 255
        gray[7:, 40:90] = 127
        original = gray.copy()
        tensor = yap_tensor(gray)
        self.assertEqual(tensor.shape, (1, 1, 32, 384))
        self.assertEqual(tensor.dtype, np.float32)
        resized = cv2.resize(gray, (221, 32), interpolation=cv2.INTER_LINEAR)
        np.testing.assert_allclose(tensor[0, 0, :, :221], resized.astype(np.float32) / 255, rtol=0, atol=6e-8)
        np.testing.assert_array_equal(tensor[0, 0, :, 221:], 0)
        np.testing.assert_array_equal(gray, original)
        for pixels in (None, np.zeros((0, 5), np.uint8), np.zeros((2, 3, 3), np.uint8), np.zeros((2, 3), np.float32)):
            with self.subTest(pixels=type(pixels)), self.assertRaises(ValueError):
                yap_tensor(pixels)

    def test_ctc_deduplicates_words_and_updates_previous_word_on_blank(self):
        words = ["|", "甜", "甜", "花", " "]
        indices = [1, 1, 2, 0, 2, 3, 3, 4, 4, 0, 4]
        logits = np.full((len(indices), 1, len(words)), -2, np.float32)
        for i, index in enumerate(indices):
            logits[i, 0, index] = -.1
        self.assertEqual(decode_yap(logits, words), "甜甜花  ")

    def test_decoder_preserves_initial_minus_one_argmax_and_first_index_ties(self):
        words = ["零", "一", "|"]
        logits = np.array([[[-2, -.8, -.9]], [[-1, -1, -1]], [[-2, -1.01, -3]],
                           [[-.2, -.2, -.3]], [[float("nan"), -.1, -.4]], [[0, 9, 99]]], np.float32)
        # Below -1 values leave source maxIndex=0. NaN fails the strict > test.
        self.assertEqual(decode_yap(logits, words), "一零一")
        self.assertEqual(decode_yap(np.empty((0, 1, 3), np.float32), words), "")
        for bad in (np.zeros((2, 3)), np.zeros((2, 2, 3)), np.zeros((2, 1, 2))):
            with self.assertRaises(ValueError):
                decode_yap(bad, words)

    def test_loader_requires_original_files_and_contiguous_dictionary(self):
        with self.assertRaises(FileNotFoundError):
            YapOcr(None)
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            with self.assertRaises(FileNotFoundError):
                YapOcr(root)
            (root / "Yap").mkdir()
            (root / "Yap/model_training.onnx").write_bytes(b"fixture")
            dictionary = root / "Yap/index_2_word.json"
            for invalid in ({"1": "|"}, {}, {"0": 5}):
                dictionary.write_text(json.dumps(invalid))
                with self.assertRaises(ValueError):
                    YapOcr(root)


class SkipSceneTest(unittest.TestCase):
    def test_black_rate_uses_exact_zero_only_in_middle_third(self):
        image = np.zeros((11, 8, 3), np.uint8)
        image[3:6, :4] = 1
        image[3:6, 4:6] = 0
        image[3:6, 6:] = 2
        self.assertEqual(black_rate(image), .25)
        image[:3] = 255
        image[6:] = 255
        self.assertEqual(black_rate(image), .25)
        self.assertEqual(black_rate(np.zeros((3, 1), np.uint8)), 1)
        with self.assertRaises(ValueError):
            black_rate(np.zeros((2, 1), np.uint8))

    def test_yellow_triangle_precedes_blue_and_returns_capture_coordinates(self):
        image = np.zeros((1080, 1920, 3), np.uint8)
        triangle(image, 951, 995, (95, 180, 200))
        triangle(image, 959, 1030)
        self.assertEqual(bottom_triangle(image), dict(x=959, y=1030, width=9, height=9, area=36))
        image[1030:1040] = 0
        self.assertEqual(bottom_triangle(image), dict(x=951, y=995, width=9, height=9, area=36))

    def test_triangle_area_polygon_color_and_roi_rejections(self):
        for size, hsv in ((3, (20, 250, 250)), (12, (20, 250, 250)), (8, (40, 250, 250))):
            image = np.zeros((1080, 1920, 3), np.uint8)
            triangle(image, 950, 990, hsv, size)
            self.assertIsNone(bottom_triangle(image))
        image = np.zeros((1080, 1920, 3), np.uint8)
        image[990:997, 950:957] = color((20, 250, 250))
        triangle(image, 100, 100)
        self.assertIsNone(bottom_triangle(image))

    def test_triangle_accepts_inclusive_area_boundaries(self):
        for width, height, area in ((4, 5, 10), (10, 10, 50)):
            image = np.zeros((1080, 1920, 3), np.uint8)
            points = np.array([[950, 990], [950 + width, 990], [950, 990 + height]], np.int32)
            cv2.fillConvexPoly(image, points, color((20, 250, 250)))
            found = bottom_triangle(image)
            self.assertEqual(found, dict(x=950, y=990, width=width + 1, height=height + 1, area=area))

    def test_triangle_downscale_rounds_like_csharp_and_uses_minimum_axis(self):
        # Width ratio > 1, height ratio = .5: scale must still be .5.
        image = np.zeros((540, 2304, 3), np.uint8)
        # 945 * .5 = 472.5 rounds to even 472, not truncation plus one.
        triangle(image, 472, 495)
        self.assertEqual(bottom_triangle(image), dict(x=472, y=495, width=9, height=9, area=36))
        self.assertIsNone(bottom_triangle(np.zeros((3, 3), np.uint8)))

    def test_character_popup_recognizes_both_source_colors_without_mutating(self):
        image = popup()
        before = image.copy()
        self.assertEqual(character_popup(image), dict(x=60, y=395, width=1800, height=305))
        np.testing.assert_array_equal(image, before)

    def test_character_source_fill_repairs_avatar_occlusion(self):
        image = popup(y=395, height=305)
        image[395:445, 240:540] = 0
        image[660:700, 290:500] = 0
        self.assertEqual(character_popup(image), dict(x=60, y=395, width=1800, height=305))

    def test_character_rejects_invalid_area_aspect_location_or_single_color(self):
        images = [popup(width=1700, height=200), popup(width=1500, height=380),
                  popup(width=1800, height=300, y=315), popup(width=1800, height=300, y=470)]
        single = popup(y=350, height=300, dark=False)
        # It excludes the artificial dark fill at y660 so two-color test fails.
        images.append(single)
        for image in images:
            with self.subTest(nonzero=np.count_nonzero(image)):
                self.assertIsNone(character_popup(image))

    def test_character_popup_scales_fill_rects_for_720p(self):
        image = np.zeros((720, 1280, 3), np.uint8)
        image[264:464, 40:1240] = (229, 241, 245)
        image[364:464, 40:1240] = (101, 82, 74)
        self.assertEqual(character_popup(image), dict(x=40, y=263, width=1200, height=203))

    def test_goods_uses_exact_rgb_color_minimums_and_original_contour_order(self):
        image = np.zeros((200, 500, 3), np.uint8)
        image[20:40, 30:130] = (220, 229, 233)
        image[100:130, 250:400] = (220, 229, 233)
        image[150:170, 10:109] = (220, 229, 233)  # Width 99.
        image[40:59, 200:310] = (220, 229, 233)  # Height 19.
        image[150:175, 250:400] = (233, 229, 220)  # Reversed color.
        image[60:80, 30:130] = (220, 229, 232)  # One channel off.
        self.assertEqual(goods_rects(image), [dict(x=250, y=100, width=150, height=30),
                                            dict(x=30, y=20, width=100, height=20)])

    def test_goods_two_close_iterations_bridge_eight_pixel_gap(self):
        image = np.zeros((70, 180, 3), np.uint8)
        image[20:40, 20:70] = (220, 229, 233)
        image[20:40, 78:130] = (220, 229, 233)
        self.assertEqual(goods_rects(image), [dict(x=20, y=20, width=110, height=20)])
        image[:, 78:130] = 0
        image[20:40, 79:131] = (220, 229, 233)
        self.assertEqual(goods_rects(image), [])

    def test_dispatch_schema_gray_bgra_support_and_unknown_operation(self):
        vision = RealtimeVision(Mock())
        for image in (np.zeros((108, 192), np.uint8), np.zeros((108, 192, 4), np.uint8)):
            result = vision.dispatch("realtime.skipScene", {}, image)
            self.assertEqual(result, dict(blackRate=1, bottomTriangle=None, characterPopup=None, goodsRects=[]))
        with self.assertRaisesRegex(ValueError, "Unknown realtime"):
            vision.dispatch("realtime.unknown", {}, None)


@unittest.skipUnless((MODEL_ROOT / "PaddleOCR").is_dir(), "Original BetterGI OCR models unavailable")
class OriginalPickOcrTest(unittest.TestCase):
    def test_original_menu_fixture_uses_original_recognizer(self):
        from vision import VisionBridge
        bridge = VisionBridge(str(MODEL_ROOT))
        image = cv2.imread(str(MODEL_ROOT / "PaddleOCR/test_pp_ocr.png"))
        result = RealtimeVision(bridge).dispatch(
            "realtime.pickText", {"roi": dict(x=0, y=140, width=267, height=60)}, image)
        self.assertEqual(result["text"], "探索派遣")
        self.assertFalse(result["alreadyPicking"])
        self.assertEqual(result["textBounds"], dict(x=0, y=0, width=112, height=60))

    @unittest.skipUnless((MODEL_ROOT / "Yap/model_training.onnx").is_file(), "Original BetterGI Yap model unavailable")
    def test_original_yap_inference_uses_original_dictionary_without_paddle(self):
        from vision import VisionBridge
        bridge = VisionBridge(str(MODEL_ROOT))
        image = cv2.imread(str(MODEL_ROOT / "PaddleOCR/test_pp_ocr.png"))
        vision = RealtimeVision(bridge)
        result = vision.dispatch("realtime.pickText", {
            "roi": dict(x=0, y=140, width=267, height=60), "ocrEngine": "Yap"}, image)
        self.assertIsNone(bridge.ocr_engine)
        self.assertIsNone(result["textBounds"])
        self.assertFalse(result["alreadyPicking"])
        self.assertEqual(len(vision.yap().words), 2201)
        self.assertEqual(vision.yap().session.get_providers(), ["CPUExecutionProvider"])
        self.assertEqual(hashlib.sha256(vision.yap().model_path.read_bytes()).hexdigest(),
                         "8165c70435c9adb94f3b9dbed8572b3bb1900da0db71a34cb7a38032864b5669")
        self.assertEqual(hashlib.sha256(vision.yap().dictionary_path.read_bytes()).hexdigest(),
                         "5f771b7815ebb74165ed02d3aea769b7a27773437e5cf1498a5619a4044248ec")
        # This is the original menu fixture, not a pickup accuracy benchmark.
        # Preserve the unchanged model's raw result even though it is inaccurate.
        self.assertEqual(result["text"], "侯素君")


if __name__ == "__main__":
    unittest.main()
