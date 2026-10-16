"""Original reward geometry, model/Paddle execution and lifecycle; no live claim."""
from pathlib import Path
import sys
import tempfile
import unittest
import weakref
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from reward_vision import BAND, RewardVision, create_reward_band_mask, detect_card_rects
from vision import VisionBridge

PROJECT = Path(__file__).resolve().parents[1]
MODELS = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"
TEMPLATE = PROJECT / "third_party/bettergi/source/BetterGenshinImpact/GameTask/AutoWood/Assets/1920x1080/TheBoonOfTheElderTree.png"
COLOR = (220, 229, 233)


def card(text=None, original_asset=False):
    image = np.full((153, 125, 3), 100, np.uint8)
    image[125:] = COLOR
    if original_asset:
        icon = cv2.imread(str(TEMPLATE))
        image[50:71, 49:75] = icon
    if text:
        cv2.putText(image, text, (8, 147), cv2.FONT_HERSHEY_SIMPLEX, .55, (60, 60, 60), 1, cv2.LINE_AA)
    return image


def screen(cards):
    image = np.zeros((1080, 1920, 3), np.uint8)
    for index, pixels in enumerate(cards):
        image[488:641, 250 + index * 150:375 + index * 150] = pixels
    return image


def strip_band(rectangles, height=220, width=1480):
    image = np.zeros((height, width, 3), np.uint8)
    for x, y, w, h in rectangles:
        image[y:y + h, x:x + w] = COLOR
    return image


class RewardGeometryTest(unittest.TestCase):
    def test_mask_exact_value_saturation_thresholds_and_open_close_noise(self):
        image = np.zeros((30, 150, 3), np.uint8)
        for index, value in enumerate([189, 190, 249, 250]):
            image[5:25, index * 30 + 5:index * 30 + 25] = value
        image[5:25, 125:145] = (190, 230, 230)
        image[0, 0] = 220
        image[10, 40] = 0
        mask = create_reward_band_mask(image)
        self.assertEqual([int(mask[15, x]) for x in [15, 45, 75, 105, 135]], [0, 255, 255, 0, 0])
        self.assertEqual(mask[0, 0], 0)
        self.assertEqual(mask[10, 40], 255)

    def test_component_width_height_inclusive_limits_and_area(self):
        for width, height, accepted in [(68, 30, False), (69, 30, True), (168, 30, True),
                                        (169, 30, False), (100, 15, False), (100, 16, True),
                                        (100, 76, True), (100, 77, False), (69, 17, False),
                                        (75, 16, True)]:
            with self.subTest(width=width, height=height):
                pixels = strip_band([(100, 190 - height, width, height)])
                result = detect_card_rects(pixels)
                self.assertEqual(len(result), int(accepted))
                if accepted:
                    self.assertEqual(result[0], (100 + width // 2 - 62, 37, 125, 153))

    def test_center_cutoff_before_median_and_no_outside_card_clamping(self):
        self.assertEqual(detect_card_rects(strip_band([(100, 0, 125, 28)])), [])
        self.assertEqual(detect_card_rects(strip_band([(0, 130, 100, 30)])), [])
        self.assertEqual(detect_card_rects(strip_band([(1410, 130, 70, 30)])), [])
        self.assertEqual(detect_card_rects(strip_band([(100, 100, 125, 30)])), [])
        self.assertEqual(detect_card_rects(np.zeros((220, 1480, 3), np.uint8)), [])

    def test_upper_median_row_bottom_is_shared_and_x_sort_integer_center(self):
        pixels = strip_band([(500, 170, 124, 27), (300, 163, 125, 30),
                             (100, 150, 126, 20), (700, 168, 125, 30)])
        result = detect_card_rects(pixels)
        self.assertEqual(result, [(101, 44, 125, 153), (300, 44, 125, 153),
                                  (500, 44, 125, 153), (700, 44, 125, 153)])

    def test_median_removes_distant_row_then_recomputes_upper_median(self):
        pixels = strip_band([(100, 90, 125, 20), (300, 182, 125, 28),
                             (500, 177, 125, 28), (700, 172, 125, 28)])
        self.assertEqual(detect_card_rects(pixels), [(300, 52, 125, 153),
                                                    (500, 52, 125, 153), (700, 52, 125, 153)])


class RewardBridgeTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge(MODELS)
        self.reward = RewardVision(self.bridge)

    def mocked_page(self, cards, icons, ocr=("1850", .9)):
        recognizer = Mock()
        recognizer.recognize.side_effect = icons
        self.reward.sessions["mock"] = recognizer
        self.bridge.ocr_engine = Mock()
        self.bridge.ocr_engine.recognize.return_value = ocr
        frame = self.bridge.put(screen(cards))
        result = self.reward.dispatch("reward.page", dict(session="mock", handle=frame["handle"]))
        return result, recognizer, frame

    def test_fullscreen_band_and_original_top125_icon_count_crop_and_quality_discard(self):
        pixels = card("1850")
        icon = dict(name="苹果", candidateName="苹果", score=.99, qualityLevel=5, scoreKind="cosine")
        result, recognizer, frame = self.mocked_page([pixels], [icon])
        self.assertEqual(result["cardRects"], [dict(x=30, y=44, width=125, height=153)])
        np.testing.assert_array_equal(recognizer.recognize.call_args.args[0], pixels[:125])
        self.assertEqual(result["rewards"][0]["count"], 1850)
        self.assertEqual(result["rewards"][0]["qualityLevel"], -1)
        self.assertEqual(result["rewards"][0]["icon"]["qualityLevel"], 5)
        self.assertEqual(result["rewards"][0]["countRecognition"]["rawText"], "1850")
        self.assertFalse(result["evidence"]["verifiedRewards"])
        self.assertEqual(len(self.bridge.images), 1)
        self.bridge.dispatch("image.dispose", dict(handle=frame["handle"]))
        self.assertEqual(len(self.bridge.images), 0)

    def test_unknown_and_exception_icons_skip_ocr_but_empty_string_is_source_reward(self):
        icons = [dict(name=None, candidateName="?", score=.1), RuntimeError("icon failed"), dict(name="")]
        result, _, _ = self.mocked_page([card("1850")] * 3, icons)
        self.assertEqual(len(result["rewards"]), 1)
        self.assertEqual(result["rewards"][0]["name"], "")
        self.assertEqual([w["code"] for w in result["warnings"]], ["unknownIcon", "unknownIcon"])
        self.assertEqual(result["observations"][1]["iconError"], "icon failed")
        self.bridge.ocr_engine.recognize.assert_called_once()

    def test_negative_or_empty_count_becomes_minus_one_with_raw_diagnostics(self):
        result, _, _ = self.mocked_page([card()], [dict(name="苹果")])
        self.assertEqual(result["rewards"][0]["count"], -1)
        self.assertEqual(result["rewards"][0]["countRecognition"]["count"], -2)
        self.assertEqual(result["rewards"][0]["countRecognition"]["reason"], "EMPTY")
        self.bridge.ocr_engine.recognize.assert_not_called()
        result, _, _ = self.mocked_page([card("1850")], [dict(name="苹果")], ("invalid", .9))
        self.assertEqual(result["rewards"][0]["count"], -1)
        self.assertEqual(result["rewards"][0]["countRecognition"]["rawText"], "invalid")

    def test_ocr_exception_is_per_card_not_global_failure(self):
        self.reward.sessions["mock"] = Mock()
        self.reward.sessions["mock"].recognize.return_value = dict(name="苹果")
        self.bridge.ocr_engine = Mock()
        self.bridge.ocr_engine.recognize.side_effect = [RuntimeError("ocr failed"), ("1850", .9)]
        frame = self.bridge.put(screen([card("1850")] * 2))
        result = self.reward.page(dict(session="mock", handle=frame["handle"]))
        self.assertEqual([r["count"] for r in result["rewards"]], [-1, 1850])
        self.assertEqual(result["observations"][0]["countError"], "ocr failed")

    def test_real_paddle_counts_original_crop(self):
        self.reward.sessions["mock"] = Mock()
        self.reward.sessions["mock"].recognize.return_value = dict(name="synthetic fixture")
        frame = self.bridge.put(screen([card("1850"), card("1234"), card("7")]))
        result = self.reward.page(dict(session="mock", handle=frame["handle"]))
        self.assertEqual([r["count"] for r in result["rewards"]], [1850, 1234, 7])
        self.assertEqual([r["countRecognition"]["rawText"] for r in result["rewards"]], ["1850", "1234", "7"])

    def test_original_both_models_hashes_actual_pixels_and_fresh_session_release(self):
        frame = self.bridge.put(screen([card("1850", original_asset=True)]))
        expected = {"Item": (3617, "637b5179efae1eda1c575c4da1840bd1e6f6cc20613dac58728239cb6b9fd87f"),
                    "GridIcon": (918, "ac56acadfe8b8ffdf2bfeac2c3b56415d2aa2c51c2d4f9c4264ef2f40de8cd18")}
        for mode, (prototypes, sha) in expected.items():
            created = self.reward.dispatch("reward.create", dict(mode=mode))
            session = created["session"]
            self.assertEqual(created["model"]["prototypes"], prototypes)
            self.assertEqual(created["model"]["files"][0]["sha256"], sha)
            result = self.reward.page(dict(session=session, handle=frame["handle"]))
            icon = result["observations"][0]["icon"]
            self.assertIsInstance(icon["candidateName"], str)
            self.assertTrue(np.isfinite(icon["score"]))
            if mode == "GridIcon":
                self.assertEqual(result["rewards"][0]["count"], 1850)
                self.assertEqual(result["rewards"][0]["qualityLevel"], -1)
            other = self.reward.create(mode)["session"]
            self.assertIsNot(self.reward.sessions[session], self.reward.sessions[other])
            reference = weakref.ref(self.reward.sessions[session])
            self.assertTrue(self.reward.dispatch("reward.release", dict(session=session))["released"])
            self.assertIsNone(reference())
            self.assertFalse(self.reward.dispatch("reward.release", dict(session=session))["released"])
            self.reward.dispatch("reward.release", dict(session=other))
        self.assertEqual(self.reward.sessions, {})
        self.assertEqual(len(self.bridge.images), 1)

    def test_model_initialization_invalid_mode_missing_session_and_small_image_fail(self):
        with patch("reward_vision.OriginalItemRecognizer", side_effect=RuntimeError("model failed")):
            with self.assertRaisesRegex(RuntimeError, "model failed"):
                self.reward.create("Item")
        self.assertEqual(self.reward.sessions, {})
        for mode in [True, "bad", -1]:
            with self.assertRaises(ValueError): self.reward.create(mode)
        with self.assertRaises(KeyError): self.reward.page(dict(session="missing", handle=1))
        frame = self.bridge.put(np.zeros((200, 200, 3), np.uint8))
        self.reward.sessions["mock"] = Mock()
        with self.assertRaisesRegex(ValueError, "beyond"):
            self.reward.page(dict(session="mock", handle=frame["handle"]))

    def test_debug_binary_mask_limegreen_box_and_save_failure_is_observation(self):
        self.reward.sessions["mock"] = Mock()
        self.reward.sessions["mock"].recognize.return_value = dict(name="苹果")
        frame = self.bridge.put(screen([card()]))
        with tempfile.TemporaryDirectory() as directory:
            target = Path(directory) / "RewardRecognition/rewardRecDebug1.png"
            result = self.reward.page(dict(session="mock", handle=frame["handle"], debugPath=str(target)))
            self.assertTrue(result["debug"]["saved"])
            debug = cv2.imread(str(target))
            self.assertEqual(debug.shape, (220, 1480, 3))
            self.assertEqual(tuple(debug[44, 30]), (50, 205, 50))
            self.assertEqual(tuple(debug[180, 90]), (255, 255, 255))
            blocker = Path(directory) / "file"
            blocker.write_text("not a folder")
            result = self.reward.page(dict(session="mock", handle=frame["handle"], debugPath=str(blocker / "out.png")))
            self.assertFalse(result["debug"]["saved"])
            self.assertIsNotNone(result["debug"]["error"])
            self.assertEqual(result["warnings"][-1]["code"], "debugSave")
            self.assertEqual(len(result["rewards"]), 1)


if __name__ == "__main__":
    unittest.main()
