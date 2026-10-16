"""Source geometry and original-resource execution checks; no live fishing claims."""
from pathlib import Path
import hashlib
import math
import sys
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from fishing_vision import (FishingVision, OriginalItemRecognizer, UI_NAMES, bgr, box,
                            control_observation, crop, fish_bar_rects, fish_box,
                            fishpond, load_catalog, match_bite_words, rod_input)
from vision import VisionBridge, load_recognition

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "third_party/bettergi/source/BetterGenshinImpact"
MODELS = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"


def frame(width=1920, height=1080):
    return np.zeros((height, width, 3), np.uint8)


def detection(name="medaka", confidence=.9, rect=None):
    return dict(name=dict(name=name, id=0), confidence=confidence, bounds=rect or box(200, 200, 50, 40))


class FishingCatalogPondTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.catalog = load_catalog(SOURCE)

    def pond(self, values, width=1920, height=1080, **kwargs):
        return fishpond(values, width, height, self.catalog, **kwargs)

    def test_catalog_reuses_original_order_baits_and_net_index_aliases(self):
        self.assertEqual(len(self.catalog["fishTypes"]), 23)
        self.assertEqual(len(self.catalog["baits"]), 12)
        self.assertEqual(self.catalog["fishTypes"][0], dict(name="medaka", chineseName="花鳉", baitType="FruitPasteBait", baitName="果酿饵", netIndex=0))
        types = {f["name"]: f for f in self.catalog["fishTypes"]}
        self.assertEqual(types["koi"]["netIndex"], types["koi head"]["netIndex"])
        self.assertEqual(types["snowfin"]["netIndex"], 5)
        self.assertEqual(types["starbloom"]["baitName"], "闪烁饵")

    def test_confidence_point4_inclusive_and_stable_descending(self):
        result = self.pond([detection("medaka", .4), detection("ray", .91), detection("angler", .91), detection("koi", .39999)])
        self.assertEqual([f["name"] for f in result["fishes"]], ["ray", "angler", "medaka"])
        self.assertEqual(result["detectionCount"], 4)
        self.assertEqual(result["fishpondRect"], box(200, 200, 50, 40))

    def test_rod_last_accepted_in_source_order_target_does_not_extend_pond(self):
        result = self.pond([detection("rod", .99, box(0, 0, 20, 20)), detection("medaka"),
                            detection("err rod", .5, box(900, 800, 15, 15)), detection("rod", .3)])
        self.assertEqual(result["targetRect"], box(900, 800, 15, 15))
        self.assertEqual(len(result["fishes"]), 1)
        self.assertEqual(result["fishpondRect"], box(200, 200, 50, 40))

    def test_koi_ignored_only_with_include_target(self):
        detections = [detection("koi"), detection("koi head")]
        self.assertEqual(len(self.pond(detections)["fishes"]), 2)
        self.assertEqual([f["name"] for f in self.pond(detections, include_target=True)["fishes"]], ["koi head"])

    def test_obtained_left_icon_width_based_height_and_containment(self):
        width, height = 1000, 500
        left = box(43, 233, 35, 35)
        outside = box(42, 233, 35, 35)
        boundary = box(43, 233, 36, 35)
        values = [detection(rect=left), detection("ray", rect=outside), detection("angler", rect=boundary)]
        result = self.pond(values, width, height, ignore_obtained=True)
        self.assertEqual([f["name"] for f in result["fishes"]], ["ray", "angler"])
        self.assertEqual(len(self.pond(values, width, height)["fishes"]), 3)

    def test_obtained_center_strict_size_bounds_and_target_bypass(self):
        values = [detection(rect=box(410, 223, 40, 40)), detection("ray", rect=box(410, 223, 30, 40)),
                  detection("angler", rect=box(410, 223, 60, 40)), detection("rod", rect=box(410, 223, 40, 40))]
        result = self.pond(values, 1000, 500, ignore_obtained=True)
        self.assertEqual([f["name"] for f in result["fishes"]], ["ray", "angler"])
        self.assertEqual(result["targetRect"], box(410, 223, 40, 40))

    def test_empty_pond_and_unknown_case_sensitive_label(self):
        result = self.pond([detection("rod")])
        self.assertEqual(result["fishpondRect"], box(0, 0, 0, 0))
        self.assertEqual(result["fishes"], [])
        with self.assertRaises(KeyError):
            self.pond([detection("Medaka")])
        self.assertEqual(self.pond([detection("unknown", .1)])["fishes"], [])

    def test_union_extents_use_fishes(self):
        result = self.pond([detection(rect=box(50, 100, 10, 20)), detection("ray", rect=box(10, 90, 80, 100))])
        self.assertEqual(result["fishpondRect"], box(10, 90, 80, 100))

    def test_rod_selects_nearest_applicable_and_confidence_for_distance_ties(self):
        pond = self.pond([detection("rod", rect=box(500, 300, 20, 20)),
                          detection("ray", .9, box(520, 300, 20, 20)), detection("medaka", .99, box(500, 300, 20, 20)),
                          detection("koi head", .95, box(480, 300, 20, 20))])
        result = rod_input(pond, 1920, 1080, "FakeFlyBait")
        self.assertEqual(result["currentFish"]["name"], "koi head")
        self.assertEqual(result["rodInput"]["fish_label"], 3)
        self.assertAlmostEqual(result["dx"], -20 * 1024 / 1920)
        self.assertEqual(result["dy"], 0)
        self.assertAlmostEqual(result["distance"], abs(result["dx"]))
        ignored = rod_input(pond, 1920, 1080, "FakeFlyBait", ["FakeFlyBait"])
        self.assertIsNone(ignored["currentFish"])
        self.assertIsNone(ignored["rodInput"])

    def test_rod_nearest_uses_integer_center_but_network_float_edges(self):
        pond = self.pond([detection("rod", rect=box(0, 0, 1, 1)),
                          detection("medaka", .9, box(1, 0, 1, 1)), detection("large medaka", .8, box(0, 0, 3, 1))])
        result = rod_input(pond, 1024, 576, "FruitPasteBait")
        self.assertEqual(result["currentFish"]["name"], "medaka")
        self.assertEqual(result["rodInput"]["fish_x1"], 1)
        self.assertEqual(result["dx"], 1)

    def test_source_large_capture_normalization_and_no_target(self):
        pond = self.pond([detection("rod", rect=box(960, 540, 20, 20)), detection("medaka", rect=box(1000, 560, 20, 20))])
        result = rod_input(pond, 2560, 1441, "FruitPasteBait")
        self.assertEqual(result["normalizationSize"], dict(width=1920, height=1080))
        self.assertEqual(result["rodInput"]["rod_x1"], 512)
        self.assertEqual(result["rodInput"]["rod_y1"], 288)
        pond["targetRect"] = None
        result = rod_input(pond, 1280, 720, "FruitPasteBait")
        self.assertIsNone(result["distance"])


class FishingBarGeometryTest(unittest.TestCase):
    def bars(self, values, width=1000, height=300, color=(192, 255, 255)):
        pixels = frame(width, height)
        for r in values:
            x, y, w, h = r
            pixels[y:y + h, x:x + w] = color
        return pixels

    def test_hsv_full_source_helper_and_yellow_width_height_filters(self):
        pixels = self.bars([(100, 80, 10, 20), (300, 80, 150, 20), (600, 80, 5, 20), (800, 86, 30, 20)])
        self.assertEqual(fish_bar_rects(pixels), [box(300, 80, 150, 20), box(100, 80, 10, 20)])
        # Source uses HSV_FULL with helper H=60/255*180, not ordinary HSV H=30.
        orange = cv2.cvtColor(np.full((1, 1, 3), (30, 64, 255), np.uint8), cv2.COLOR_HSV2BGR)[0, 0]
        self.assertEqual(tuple(orange), (191, 255, 255))
        self.assertIsNotNone(fish_bar_rects(self.bars([(100, 80, 100, 20)], color=tuple(map(int, orange)))))

    def test_strict_alignment_height_integer_cutoffs(self):
        pixels = self.bars([(100, 80, 100, 20), (300, 83, 20, 20), (400, 84, 20, 20),
                            (500, 83, 20, 14), (600, 83, 20, 15)])
        rects = fish_bar_rects(pixels)
        self.assertIn(box(300, 83, 20, 20), rects)
        self.assertNotIn(box(400, 84, 20, 20), rects)
        self.assertNotIn(box(500, 83, 20, 14), rects)
        self.assertIn(box(600, 83, 20, 15), rects)

    def test_widest_tie_is_last_source_contour_and_empty_postfilter(self):
        pixels = self.bars([(100, 80, 100, 20), (300, 140, 100, 20)])
        self.assertEqual(fish_bar_rects(pixels), [box(100, 80, 100, 20)])
        self.assertEqual(fish_bar_rects(self.bars([(100, 80, 100, 4)])), [])

    def test_source_negative_remainder_accepts_rotation_and_positive_angles_filter(self):
        pixels = frame(1000, 300)
        cv2.fillPoly(pixels, [cv2.boxPoints(((300, 120), (140, 20), 15)).astype(np.int32)], (192, 255, 255))
        self.assertIsNotNone(fish_bar_rects(pixels))
        with patch("fishing_vision.cv2.minAreaRect", return_value=((300, 120), (140, 20), 15)):
            self.assertIsNone(fish_bar_rects(pixels))
        with patch("fishing_vision.cv2.minAreaRect", return_value=((300, 120), (140, 20), 45)):
            self.assertIsNotNone(fish_bar_rects(pixels))
        pixels[:] = 0
        cv2.fillPoly(pixels, [cv2.boxPoints(((300, 120), (100, 20), 45)).astype(np.int32)], (192, 255, 255))
        self.assertIsNotNone(fish_bar_rects(pixels))

    def test_no_contours_invalid_pixels_source_null(self):
        self.assertIsNone(fish_bar_rects(frame(100, 50)))
        self.assertIsNone(fish_bar_rects(np.zeros((0, 0, 3), np.uint8)))
        self.assertIsNone(fish_bar_rects(np.zeros((20, 20, 3), np.float32)))

    def test_fishbox_source_initial_constraints_and_padding(self):
        rects = [box(350, 80, 100, 20), box(100, 80, 10, 20)]
        result = fish_box(rects, 1000, 600)
        self.assertEqual(result["rect"], box(80, 75, 840, 30))
        self.assertIsNone(result["reason"])
        self.assertEqual(fish_box(None, 1000, 600)["reason"], "bar-count")
        self.assertEqual(fish_box([box(0, 0, 5, 20), box(200, 0, 100, 31)], 1000, 600)["reason"], "height-difference")

    def test_fishbox_boundary_equalities_allowed_and_clamping(self):
        result = fish_box([box(0, 0, 10, 20), box(100, 0, 180, 20)], 1000, 600)
        self.assertEqual(result["rect"], box(0, 0, 1000, 25))
        # cursor.right == right.x - right.width/2 is allowed.
        self.assertIsNotNone(fish_box([box(100, 100, 10, 20), box(160, 100, 100, 20)], 1000, 600)["rect"])
        self.assertIsNone(fish_box([box(101, 100, 10, 20), box(160, 100, 100, 20)], 1000, 600)["rect"])

    def test_fishbox_rejects_cursor_right_of_screen_left_half_or_target(self):
        for rects in ([box(600, 80, 10, 20), box(300, 80, 100, 20)],
                      [box(450, 80, 10, 20), box(700, 80, 100, 20)]):
            self.assertEqual(fish_box(rects, 1000, 600)["reason"], "initial-geometry")

    def test_two_bar_control_down_up_exact10_ratio_and_invalid_early_return(self):
        self.assertTrue(control_observation([box(10, 0, 10, 20), box(100, 0, 100, 20)])["desiredPressed"])
        self.assertFalse(control_observation([box(300, 0, 10, 20), box(100, 0, 100, 20)])["desiredPressed"])
        result = control_observation([box(10, 0, 10, 20), box(100, 0, 99, 20)])
        self.assertIsNone(result["desiredPressed"])
        self.assertTrue(result["invalidTwoRects"])
        self.assertFalse(result["resetNoDetectionTimer"])
        self.assertFalse(result["missing"])

    def test_three_bar_balance_equality_up_and_sort_by_x(self):
        rects = [box(100, 0, 40, 20), box(0, 0, 10, 20), box(60, 0, 10, 20)]
        result = control_observation(rects)
        self.assertTrue(result["desiredPressed"])
        self.assertEqual([r["x"] for r in result["rects"]], [0, 60, 100])
        rects[0] = box(100, 0, 30, 20)
        self.assertFalse(control_observation(rects)["desiredPressed"])

    def test_more_than_three_tallest_then_source_count_and_missing_timer(self):
        values = [box(0, 0, 10, 10), box(100, 0, 40, 20), box(60, 0, 10, 30), box(0, 0, 10, 40)]
        result = control_observation(values)
        self.assertEqual((result["sourceCount"], result["count"]), (4, 3))
        self.assertTrue(result["resetNoDetectionTimer"])
        self.assertIsNone(control_observation([box(0, 0, 10, 10)])["desiredPressed"])
        for value in ([], None):
            result = control_observation(value)
            self.assertTrue(result["missing"])
            self.assertFalse(result["resetNoDetectionTimer"])


class FishingItemRecognizerTest(unittest.TestCase):
    def recognizer(self, mode, feature, prototypes):
        result = OriginalItemRecognizer.__new__(OriginalItemRecognizer)
        result.mode, result.prototypes, result.session = mode, prototypes, Mock()
        result.session.run.return_value = [np.asarray([feature], np.float32), np.zeros((1, 3)), np.array([[0, 1, 0, 0, 0, 0]])]
        return result

    def test_item_rgb_normalization_cosine_inclusive_threshold_and_stable_ties(self):
        recognizer = self.recognizer("Item", [1, 0], [("果酿饵", -1, np.array([.75, math.sqrt(1 - .75 ** 2)], np.float32)),
                                                     ("赤糜饵", -1, np.array([.75, math.sqrt(1 - .75 ** 2)], np.float32))])
        pixels = np.full((125, 125, 3), (0, 127, 255), np.uint8)
        result = recognizer.recognize(pixels)
        self.assertEqual(result["name"], "果酿饵")
        self.assertEqual(result["score"], .75)
        tensor = recognizer.session.run.call_args.args[1]["input_image"]
        self.assertEqual(tensor.shape, (1, 3, 125, 125))
        self.assertEqual(tensor[0, 0, 0, 0], 1)
        self.assertEqual(tensor[0, 2, 0, 0], -1)
        self.assertAlmostEqual(float(tensor[0, 1, 0, 0]), (127 / 255 - .5) / .5)

    def test_item_l2_normalizes_feature_and_keeps_best_name_quality_group(self):
        recognizer = self.recognizer("Item", [3, 4], [("food", -1, np.array([0, 1], np.float32)),
                                                     ("food", -1, np.array([1, 0], np.float32)), ("relic", 5, np.array([.6, .8], np.float32))])
        result = recognizer.recognize(frame(125, 125))
        self.assertEqual(result["name"], "relic")
        self.assertEqual(result["qualityLevel"], 5)
        self.assertAlmostEqual(result["score"], 1, places=6)
        recognizer.session.run.return_value[0] = np.zeros((1, 2), np.float32)
        with self.assertRaisesRegex(ValueError, "L2"):
            recognizer.recognize(frame(125, 125))

    def test_item_low_score_is_unknown_and_rejects_wrong_icon_size(self):
        recognizer = self.recognizer("Item", [1, 0], [("果酿饵", -1, np.array([.7499, .6], np.float32))])
        self.assertIsNone(recognizer.recognize(frame(125, 125))["name"])
        self.assertEqual(recognizer.recognize(frame(125, 125))["candidateName"], "果酿饵")
        with self.assertRaises(ValueError):
            recognizer.recognize(frame(124, 125))

    def test_item_float_products_accumulate_in_source_order_before_ranking(self):
        first = np.zeros(8, np.float32)
        first[:4] = [.70710677, 2 ** -60, -.70710677, 2 ** -60]
        second = first.copy()
        second[3] = 2 ** -59
        recognizer = self.recognizer("Item", np.ones(8), [("first", -1, first), ("second", -1, second)])
        result = recognizer.recognize(frame(125, 125))
        self.assertEqual(result["candidateName"], "second")
        self.assertEqual(result["score"], float(second[3] * np.float32(1 / math.sqrt(8))))

    def test_legacy_gridicon_uses_unscaled_rgb_distance_strict100_and_star_argmax(self):
        prototype = np.zeros(64, np.float32)
        prototype[0] = 10
        recognizer = self.recognizer("GridIcon", np.zeros(64), [("果酿饵", -1, prototype)])
        pixels = np.full((125, 125, 3), (0, 127, 255), np.uint8)
        result = recognizer.recognize(pixels)
        self.assertIsNone(result["name"])
        self.assertEqual(result["score"], 100)
        self.assertEqual(result["qualityLevel"], 1)
        tensor = recognizer.session.run.call_args.args[1]["input_image"]
        self.assertEqual(tensor[0, 2, 0, 0], 0)
        prototype[0] = 9.99
        self.assertEqual(recognizer.recognize(pixels)["name"], "果酿饵")


class FishingBridgeTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge(str(MODELS))
        self.fishing = FishingVision(self.bridge)
        self.pixels = frame()
        self.handle = self.bridge.put(self.pixels)["handle"]

    def test_dispatch_fishpond_and_rod_reuses_supplied_prediction_result(self):
        self.fishing.predictor = Mock()
        self.fishing.predictor.predict.return_value = [detection("rod"), detection()]
        pond = self.fishing.dispatch("fishing.fishpond", dict(handle=self.handle))
        result = self.fishing.dispatch("fishing.rodInput", dict(handle=self.handle, fishpond=pond, selectedBait="FruitPasteBait"))
        self.assertIsNotNone(result["rodInput"])
        self.assertEqual(self.fishing.predictor.predict.call_count, 1)
        self.assertEqual(self.fishing.dispatch("fishing.catalog", {})["baits"][0]["name"], "FruitPasteBait")

    def test_selected_bait_width_square_crop_and_actual_pixels(self):
        x, y, size = int(.824 * 1920), int(.669 * 1080), int(.065 * 1920)
        self.pixels[y:y + size, x:x + size] = (11, 22, 33)
        item = Mock()
        item.recognize.return_value = dict(name="果酿饵", score=.9, scoreKind="cosine")
        self.fishing.item_recognizers["Item"] = item
        result = self.fishing.dispatch("fishing.selectedBait", dict(handle=self.handle))
        self.assertEqual(result["rect"], box(x, y, size, size))
        self.assertEqual(result["baitType"], "FruitPasteBait")
        pixels = item.recognize.call_args.args[0]
        self.assertEqual(pixels.shape, (125, 125, 3))
        self.assertTrue(np.all(pixels == (11, 22, 33)))

    def test_nonbait_match_is_not_accepted_and_selected_crop_strict(self):
        item = Mock()
        item.recognize.return_value = dict(name="甜甜花", score=.99, scoreKind="cosine")
        self.fishing.item_recognizers["Item"] = item
        result = self.fishing.dispatch("fishing.selectedBait", dict(handle=self.handle))
        self.assertIsNone(result["name"])
        self.assertIsNone(result["baitType"])
        handle = self.bridge.put(frame(1920, 100))["handle"]
        with self.assertRaises(ValueError):
            self.fishing.dispatch("fishing.selectedBait", dict(handle=handle))

    def test_bait_grid_canny_filters_and_upstream125x153_top125_crop(self):
        # A real contour at source aspect ratio; the bottom color is excluded by GetGridIcon.
        x, y, w, h = 600, 430, 125, 153
        self.pixels[y:y + h, x:x + w] = (70, 70, 70)
        self.pixels[y + 126:y + h, x:x + w] = (160, 160, 160)
        cv2.rectangle(self.pixels, (x, y), (x + w - 1, y + h - 1), (255, 255, 255), 1)
        cv2.rectangle(self.pixels, (900, 440), (925, 470), (255, 255, 255), 1)
        item = Mock()
        item.recognize.return_value = dict(name="果酿饵", score=.9, scoreKind="cosine")
        self.fishing.item_recognizers["Item"] = item
        results = self.fishing.dispatch("fishing.baitGrid", dict(handle=self.handle))
        self.assertEqual(len(results), 1)
        self.assertEqual(results[0]["baitType"], "FruitPasteBait")
        self.assertEqual(results[0]["rect"], box(599, 429, 127, 155))
        icon = item.recognize.call_args.args[0]
        self.assertEqual(icon.shape, (125, 125, 3))
        self.assertLess(float(icon[-5, 60, 0]), 100)

    def test_original_ui_templates_match_at_actual_capture_coordinates(self):
        root = SOURCE / "GameTask/AutoFishing/Assets"
        pixels = frame()
        positions = dict(SpaceButton=(1100, 600), BaitButton=(1200, 900), WaitBiteButton=(1500, 600),
                         LiftRodButton=(1600, 700), ExitFishingButton=(1800, 950))
        for name, (x, y) in positions.items():
            recognition = load_recognition(root / "Recognition.json", name, 1920, 1080)
            template = cv2.imread(recognition["template_path"])
            pixels[y:y + template.shape[0], x:x + template.shape[1]] = template
        handle = self.bridge.put(pixels)["handle"]
        results = self.fishing.dispatch("fishing.ui", dict(handle=handle))
        for name, (x, y) in positions.items():
            self.assertIsNotNone(results[name], name)
            self.assertEqual((results[name]["x"], results[name]["y"]), (x, y), name)
        with self.assertRaises(ValueError):
            self.fishing.dispatch("fishing.ui", dict(handle=handle, names=["InventedButton"]))

    def test_bar_roi_local_coordinates_and_fishbox_full_image(self):
        self.pixels[80:100, 100:110] = (192, 255, 255)
        self.pixels[80:100, 350:450] = (192, 255, 255)
        roi = box(50, 50, 500, 150)
        rects = self.fishing.dispatch("fishing.barRects", dict(handle=self.handle, roi=roi))
        self.assertEqual(rects, [box(300, 30, 100, 20), box(50, 30, 10, 20)])
        result = self.fishing.dispatch("fishing.fishBox", dict(handle=self.handle))
        self.assertEqual(result["rect"], box(80, 75, 1760, 30))
        control = self.fishing.dispatch("fishing.control", dict(handle=self.handle, fishBoxRect=result["rect"]))
        self.assertTrue(control["desiredPressed"])
        self.assertEqual(control["rects"], [box(270, 5, 100, 20), box(20, 5, 10, 20)])

    def test_crop_validation_and_gray_bgra_support(self):
        self.assertEqual(bgr(np.zeros((20, 20), np.uint8)).shape, (20, 20, 3))
        self.assertEqual(bgr(np.zeros((20, 20, 4), np.uint8)).shape, (20, 20, 3))
        for roi in (box(-1, 0, 10, 10), box(0, 0, 0, 10), dict(x=0, y=0, width=1.5, height=2)):
            with self.assertRaises(ValueError):
                crop(self.pixels, roi)
        with self.assertRaises(NotImplementedError):
            self.fishing.dispatch("fishing.invented", dict(handle=self.handle))


class FishingBiteTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge(str(MODELS))
        self.fishing = FishingVision(self.bridge)
        self.pixels = frame()
        self.handle = self.bridge.put(self.pixels)["handle"]
        self.fishing._find = Mock(return_value=None)
        self.bridge.ocr_engine = Mock()
        self.bridge.ocr_engine.run.return_value = []

    def test_words_white_dilation_center_geometry_and_precedence(self):
        self.pixels[100:105, 915:1005] = 253
        result = self.fishing.dispatch("fishing.bite", dict(handle=self.handle))
        self.assertTrue(result["bite"])
        self.assertEqual(result["method"], "words")
        self.assertEqual(result["wordsAreaRect"], box(640, 0, 640, 540))
        self.assertEqual(result["tipsRect"], box(906, 91, 109, 24))
        self.fishing._find.assert_not_called()
        self.bridge.ocr_engine.run.assert_not_called()

    def test_words_strict_color_width_center_and_tallest_only(self):
        pixels = frame(640, 540)
        pixels[100:105, 275:365] = 252
        self.assertIsNone(match_bite_words(pixels, 640))
        pixels[100:105, 275:365] = 255
        self.assertIsNotNone(match_bite_words(pixels, 640))
        pixels[200:250, 20:30] = 255
        self.assertIsNone(match_bite_words(pixels, 640))
        pixels[:] = 0
        pixels[100:105, 275:480] = 255
        self.assertIsNone(match_bite_words(pixels, 640))

    def test_template_before_ocr(self):
        self.fishing._find.return_value = box(1800, 700, 20, 20)
        result = self.fishing.dispatch("fishing.bite", dict(handle=self.handle))
        self.assertEqual(result["method"], "template")
        self.assertIsNone(result["tipsRect"])
        self.bridge.ocr_engine.run.assert_not_called()

    def test_ocr_removes_only_ascii_space_tab_preserves_newline_and_sort(self):
        self.bridge.ocr_engine.run.return_value = [dict(text="上 \t钩", rect=[100, 20, 30, 10]), dict(text="鱼儿", rect=[100, 0, 30, 10])]
        result = self.fishing.dispatch("fishing.bite", dict(handle=self.handle))
        self.assertTrue(result["bite"])
        self.assertEqual(result["method"], "ocr")
        self.assertEqual(result["text"], "鱼儿\n上 \t钩")
        self.bridge.ocr_engine.run.return_value = [dict(text="上", rect=[0, 0, 20, 10]), dict(text="钩", rect=[0, 20, 20, 10])]
        self.assertFalse(self.fishing.dispatch("fishing.bite", dict(handle=self.handle))["bite"])
        self.bridge.ocr_engine.run.return_value = [dict(text="上\u3000钩", rect=[0, 0, 20, 10])]
        self.assertFalse(self.fishing.dispatch("fishing.bite", dict(handle=self.handle))["bite"])

    def test_ocr_localized_string_and_empty_no_bite(self):
        self.bridge.ocr_engine.run.return_value = [dict(text="Bite!", rect=[0, 0, 30, 10])]
        self.assertTrue(self.fishing.dispatch("fishing.bite", dict(handle=self.handle, getABiteText="Bite"))["bite"])
        self.bridge.ocr_engine.run.return_value = []
        result = self.fishing.dispatch("fishing.bite", dict(handle=self.handle))
        self.assertFalse(result["bite"])
        self.assertIsNone(result["method"])


class FishingOriginalModelSmokeTest(unittest.TestCase):
    def test_original_fish_model_loading_labels_hash_and_zero_image_inference(self):
        fishing = FishingVision(VisionBridge(str(MODELS)))
        status = fishing.dispatch("fishing.modelStatus", {})["fish"]
        self.assertEqual(status["sha256"], "f8da8779ff0be7d21ed1dd1c8a92807f684701df926174558135e68b4fa545ce")
        self.assertEqual(status["inputSize"], [1280, 1280])
        self.assertEqual(len(status["classes"]), 25)
        self.assertEqual(set(status["classes"]), {f["name"] for f in fishing._catalog()["fishTypes"]} | {"rod", "err rod"})
        self.assertEqual(fishing._predictor().predict(frame(1280, 720)), [])

    def test_original_item_models_tables_and_inference_execute_without_accuracy_claim(self):
        expected = dict(Item=(3617, "637b5179efae1eda1c575c4da1840bd1e6f6cc20613dac58728239cb6b9fd87f"),
                        GridIcon=(918, "ac56acadfe8b8ffdf2bfeac2c3b56415d2aa2c51c2d4f9c4264ef2f40de8cd18"))
        for mode, (count, digest) in expected.items():
            recognizer = OriginalItemRecognizer(MODELS, mode)
            status = recognizer.status()
            self.assertEqual(status["prototypes"], count)
            self.assertEqual(status["files"][0]["sha256"], digest)
            result = recognizer.recognize(frame(125, 125))
            self.assertIsNone(result["name"])
            self.assertTrue(math.isfinite(result["score"]))


if __name__ == "__main__":
    unittest.main()
