"""Original fixed-card geometry, tensor protocol and retained avatar resources."""

from __future__ import annotations

import base64
import csv
import json
from pathlib import Path
import sys
import tempfile
import types
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "scripts/bettergi"))
from party_grid_vision import (AvatarGridIconRecognizer, PartyGridVision, build_cards, correct_by_median,
                               create_input_tensors, detect_cards, normalize_vector, parse_element_types,
                               predict_element_type, rectangle)
from vision import VisionBridge

MODEL_ROOT = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"


def bottom_color():
    return tuple(int(value) for value in cv2.cvtColor(np.uint8([[[25, 14, 235]]]), cv2.COLOR_HSV2BGR)[0, 0])


def paint_bottom(image, right, bottom, width=120, height=25):
    image[bottom - height:bottom, right - width:right] = bottom_color()


class FixedCardGeometryTest(unittest.TestCase):
    def test_consecutive_gap_groups_can_span_more_than_tolerance(self):
        self.assertEqual(correct_by_median([140, 100, 120, 230], 20), [120, 120, 120, 230])
        self.assertEqual(correct_by_median([10, 14], 3), [10, 14])
        self.assertEqual(correct_by_median([], 3), [])

    def test_median_even_counts_use_source_ties_to_even(self):
        self.assertEqual(correct_by_median([100, 101, 200, 203], 3), [100, 100, 202, 202])

    def test_detector_order_preserved_and_duplicate_corrected_coordinates_removed(self):
        cards, rejected = build_cards([(250, 300, 50, 22), (89, 139, 43, 22), (90, 138, 43, 24)],
                                     (500, 500), 1)
        self.assertEqual(cards, [
            {"cardRect": rectangle(168, 161, 132, 161), "avatarRect": rectangle(168, 161, 132, 132)},
            {"cardRect": rectangle(0, 1, 132, 161), "avatarRect": rectangle(0, 1, 132, 132)}])
        self.assertEqual(rejected, 0)

    def test_unique_invalid_cards_rejected_once_and_exact_grid_edges_accepted(self):
        cards, rejected = build_cards([(0, 0, 30, 20), (1, 1, 29, 19), (30, 241, 102, 20),
                                      (368, 339, 132, 161), (550, 600, 50, 30)], (500, 500), 1)
        self.assertEqual(rejected, 2)
        self.assertEqual(len(cards), 2)
        self.assertEqual(cards[0]["cardRect"], rectangle(0, 100, 132, 161))
        self.assertEqual(cards[1]["cardRect"], rectangle(368, 339, 132, 161))

    def test_original_two_layouts_and_scale_rounding(self):
        cards, _ = build_cards([(0, 0, 58, 70)], (58, 70), .5, "CharacterDevelopment")
        self.assertEqual(cards[0]["cardRect"], rectangle(0, 0, 58, 70))
        self.assertEqual(cards[0]["avatarRect"], rectangle(0, 0, 58, 58))
        cards, _ = build_cards([(0, 0, 66, 80)], (66, 80), .5)
        self.assertEqual(cards[0]["cardRect"], rectangle(0, 0, 66, 80))
        with self.assertRaisesRegex(ValueError, "layout"):
            build_cards([], (1, 1), 1, "invented")

    def test_hsv_detection_uses_area_inclusive_and_counts_unmatched_components(self):
        image = np.zeros((500, 800, 3), np.uint8)
        paint_bottom(image, 132, 161, 100, 25)
        paint_bottom(image, 432, 161, 100, 40)
        paint_bottom(image, 732, 161, 100, 24)
        result = detect_cards(image, 1)
        self.assertEqual(result["connectedComponentCount"], 3)
        self.assertEqual(result["rejectedCount"], 0)
        self.assertEqual([card["cardRect"] for card in result["cards"]],
                         [rectangle(300, 0, 132, 161), rectangle(0, 0, 132, 161)])

    def test_morphology_closes_small_holes_and_uses_8_connectivity(self):
        image = np.zeros((300, 300, 3), np.uint8)
        paint_bottom(image, 132, 161, 100, 25)
        image[140:142, 50:52] = 0
        result = detect_cards(image, 1)
        self.assertEqual(len(result["cards"]), 1)
        image = np.zeros((10, 10, 3), np.uint8)
        image[0, 0] = image[1, 1] = bottom_color()
        self.assertEqual(detect_cards(image, 1)["connectedComponentCount"], 1)

    def test_area_scale_squared_and_color_rejection(self):
        image = np.zeros((200, 300, 3), np.uint8)
        paint_bottom(image, 66, 80, 50, 15)
        self.assertEqual(len(detect_cards(image, .5)["cards"]), 1)
        self.assertEqual(len(detect_cards(image, 1)["cards"]), 0)
        image[:] = (235, 235, 235)
        self.assertEqual(detect_cards(image, .5)["connectedComponentCount"], 0)
        for scale in (0, -1, float("nan"), float("inf")):
            with self.assertRaisesRegex(ValueError, "scale"):
                detect_cards(image, scale)


class AvatarTensorProtocolTest(unittest.TestCase):
    def test_exact_rgb_float32_minus_one_to_one(self):
        image = np.full((115, 115, 3), [0, 127, 255], np.uint8)
        inputs = create_input_tensors(image)
        tensor = inputs["input_image"]
        self.assertEqual(tensor.shape, (1, 3, 115, 115))
        self.assertEqual(tensor.dtype, np.float32)
        self.assertTrue(tensor.flags.c_contiguous)
        expected = (np.float32(127) / np.float32(255) - np.float32(.5)) / np.float32(.5)
        np.testing.assert_array_equal(tensor[0, :, 0, 0], [1, expected, -1])

    def test_element_is_top_left48_from_resized_avatar_then64(self):
        image = np.full((230, 230, 3), [0, 255, 0], np.uint8)
        image[:96, :96] = [0, 0, 255]
        inputs = create_input_tensors(image)
        self.assertEqual(inputs["input_element_image"].shape, (1, 3, 64, 64))
        np.testing.assert_array_equal(inputs["input_element_image"][0, :, 20, 20], [1, -1, -1])
        np.testing.assert_array_equal(inputs["input_image"][0, :, 100, 100], [-1, 1, -1])

    def test_separate_element_overload_uses_supplied_crop(self):
        image = np.zeros((115, 115, 3), np.uint8)
        element = np.full((48, 48, 3), [255, 0, 0], np.uint8)
        inputs = create_input_tensors(image, element)
        np.testing.assert_array_equal(inputs["input_element_image"][0, :, 20, 20], [-1, -1, 1])

    def test_l2_uses_double_norm_and_final_float_cast(self):
        values = np.array([1.234567, -9.876543, 1e-9], np.float32)
        norm = sum(float(value) ** 2 for value in values) ** .5
        expected = np.array([float(value) / norm for value in values], np.float32)
        np.testing.assert_array_equal(normalize_vector(values), expected)
        self.assertTrue(np.isnan(normalize_vector(np.zeros(3, np.float32))).all())

    def test_required_element_metadata_and_stable_argmax(self):
        labels = parse_element_types({"element_types": '["冰","岩","水","火","草","雷","风"]'})
        self.assertEqual(predict_element_type([1, 1, 0, -1, -2, -3, -4], labels), "冰")
        self.assertEqual(predict_element_type([0, 0, 0, 0, 0, 0, 1], labels), "风")
        for metadata in ({}, {"element_types": "bad"}, {"element_types": "[]"},
                         {"element_types": '[" "]'}, {"element_types": '"冰"'}):
            with self.assertRaisesRegex(ValueError, "element_types"):
                parse_element_types(metadata)
        with self.assertRaisesRegex(ValueError, "count mismatch"):
            predict_element_type([], labels)

    def test_source_float_products_double_accumulation(self):
        recognizer = object.__new__(AvatarGridIconRecognizer)
        vector = normalize_vector(np.array([1.234567, 9.876543, .3333333], np.float32))
        recognizer.prototypes = [{"name": "A", "elementType": "火", "embedding": vector}]
        result = recognizer.candidate(vector)
        feature = normalize_vector(vector)
        expected = sum(float(value) for value in vector * feature)
        self.assertEqual(result["score"], expected)

    def test_character_group_tie_prefers_first_character_not_first_max_prototype(self):
        recognizer = object.__new__(AvatarGridIconRecognizer)
        recognizer.prototypes = [
            {"name": "A", "elementType": "冰", "embedding": np.array([0, 1], np.float32)},
            {"name": "B", "elementType": "火", "embedding": np.array([1, 0], np.float32)},
            {"name": "A", "elementType": "水", "embedding": np.array([1, 0], np.float32)}]
        self.assertEqual(recognizer.candidate([1, 0]), {"name": "A", "elementType": "水", "score": 1})

    def test_default_recognize_keeps_prototype_element_and_optional_overload_uses_head(self):
        recognizer = object.__new__(AvatarGridIconRecognizer)
        recognizer.element_types = ["冰", "火"]
        recognizer.prototypes = [{"name": "A", "elementType": "冰", "embedding": np.array([1, 0], np.float32)}]
        session = Mock()
        session.get_outputs.return_value = [types.SimpleNamespace(name=name) for name in ("embedding", "element_logits")]
        session.run.return_value = [np.array([[1, 0]], np.float32), np.array([[0, 1]], np.float32)]
        recognizer.load = Mock(return_value=session)
        image = np.zeros((132, 132, 3), np.uint8)
        self.assertEqual(recognizer.recognize(image)["elementType"], "冰")
        self.assertEqual(recognizer.recognize(image, image, True)["elementType"], "火")
        self.assertEqual(set(session.run.call_args.args[1]), {"input_image", "input_element_image"})

    def test_csv_trim_quoted_fields_and_first_character_metadata(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory) / "AvatarGridIcon"
            root.mkdir()
            with (root / "avatar.csv").open("w", encoding="utf-8-sig", newline="") as stream:
                writer = csv.writer(stream)
                writer.writerow([" Character_Name ", "ELEMENT_TYPE", "weapon_type", "embedding"])
                vector = base64.b64encode(np.array([3, 4], dtype="<f4").tobytes()).decode()
                writer.writerow([" 角色,甲 ", " 冰 ", " 单手剑 ", vector])
                writer.writerow(["角色,甲", "火", "长柄武器", vector])
            recognizer = AvatarGridIconRecognizer(directory)
            self.assertIsNone(recognizer.session)
            self.assertEqual(recognizer.metadata(), {"characters": [{"name": "角色,甲", "elementType": "冰", "weaponType": "单手剑"}],
                                                     "prototypeCount": 2, "characterCount": 1})
            np.testing.assert_allclose(recognizer.prototypes[0]["embedding"], [.6, .8], rtol=1e-7)


class PartyGridBridgeTest(unittest.TestCase):
    def make_bridge(self, width=1920, height=1080, **kwargs):
        bridge = VisionBridge(str(MODEL_ROOT))
        handle = bridge.put(np.zeros((height, width, 3), np.uint8), **kwargs)["handle"]
        return bridge, handle, PartyGridVision(bridge)

    def test_default_roi_source_system_scale_and_global_card_coordinates(self):
        bridge, handle, vision = self.make_bridge(global_x=7, global_y=9)
        paint_bottom(bridge.image(handle).pixels, 24 + 132, 86 + 161)
        recognizer = Mock()
        recognizer.recognize.return_value = {"name": "A", "elementType": "水", "score": .69}
        vision.recognizer = recognizer
        result = vision.dispatch("party.grid", {"handle": handle})
        self.assertEqual(result["roi"], rectangle(24, 86, 766, 743))
        self.assertEqual(result["assetScale"], 1)
        self.assertEqual(result["cards"][0]["cardRect"], rectangle(31, 95, 132, 161))
        self.assertEqual(result["cards"][0]["avatarRect"], rectangle(31, 95, 132, 132))
        self.assertEqual(result["cards"][0]["score"], .69)
        self.assertEqual(recognizer.recognize.call_args.args[0].shape, (132, 132, 3))

    def test_low_scores_are_returned_for_source_js_threshold(self):
        bridge, handle, vision = self.make_bridge()
        paint_bottom(bridge.image(handle).pixels, 132, 161)
        vision.recognizer = Mock()
        vision.recognizer.recognize.return_value = {"name": "A", "elementType": "水", "score": .1}
        self.assertEqual(len(vision.dispatch("party.grid", {"handle": handle, "roi": [0, 0, 800, 743]})["cards"]), 1)

    def test_height_limits_asset_scale_and_model_not_needed_on_empty_grid(self):
        bridge, handle, vision = self.make_bridge(1920, 540)
        with patch.object(vision, "avatar_recognizer", side_effect=AssertionError("No cards must not load model")):
            result = vision.dispatch("party.grid", {"handle": handle})
        self.assertEqual(result["assetScale"], .5)
        self.assertEqual(result["roi"], rectangle(12, 43, 383, 372))
        self.assertEqual(result["cards"], [])
        _, handle, vision = self.make_bridge(3840, 2160)
        self.assertEqual(vision.dispatch("party.grid", {"handle": handle})["assetScale"], 1)

    def test_explicit_roi_global_translation_and_out_of_bounds_errors(self):
        bridge, handle, vision = self.make_bridge()
        paint_bottom(bridge.image(handle).pixels, 400 + 132, 200 + 161)
        vision.recognizer = Mock()
        vision.recognizer.recognize.return_value = {"name": "A", "elementType": "水", "score": 1}
        result = vision.dispatch("party.grid", {"handle": handle, "roi": [400, 200, 700, 500]})
        self.assertEqual(result["cards"][0]["cardRect"], rectangle(400, 200, 132, 161))
        json.dumps(result, allow_nan=False)
        for roi in ((-1, 0, 100, 100), (0, 0, 0, 100), (1900, 0, 100, 100)):
            with self.assertRaisesRegex(ValueError, "ROI"):
                vision.dispatch("party.grid", {"handle": handle, "roi": roi})
        with self.assertRaisesRegex(ValueError, "finite"):
            vision.dispatch("party.grid", {"handle": handle, "roi": [0, float("nan"), 100, 100]})

    def test_metadata_no_handle_and_unknown_operation(self):
        _, _, vision = self.make_bridge()
        vision.recognizer = Mock()
        vision.recognizer.metadata.return_value = {"characters": []}
        self.assertEqual(vision.dispatch("party.gridMetadata", {}), {"characters": []})
        vision.recognizer.status.return_value = {"model": "original"}
        self.assertEqual(vision.dispatch("party.gridModelStatus", {}), {"model": "original"})
        with self.assertRaises(NotImplementedError):
            vision.dispatch("party.notGrid", {})


@unittest.skipUnless((MODEL_ROOT / "AvatarGridIcon/avatar.onnx").is_file(), "Original avatar package required")
class OriginalAvatarResourcesTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.recognizer = AvatarGridIconRecognizer(MODEL_ROOT)

    def test_exact_original_hashes_metadata_and_prototype_count(self):
        status = self.recognizer.status()
        self.assertEqual(status["modelSha256"], "e774efe6f9ba6f5866557845e93f28723eec950e3a7b8375caf2292c2802b4a1")
        self.assertEqual(status["prototypeSha256"], "11291487d029cef3f0bb04cc698a2f7e0449e2f4294853adc9eb03df5cc7a17a")
        self.assertEqual(status["prototypeCount"], 190)
        self.assertEqual(status["characterCount"], 124)
        self.assertEqual(status["elementTypes"], ["冰", "岩", "水", "火", "草", "雷", "风"])
        self.assertEqual(self.recognizer.metadata()["characters"][0],
                         {"name": "神里绫华", "elementType": "冰", "weaponType": "单手剑"})

    def test_original_prototype_self_match_and_unit_norms(self):
        for prototype in self.recognizer.prototypes:
            self.assertAlmostEqual(float(np.linalg.norm(prototype["embedding"])), 1, places=6)
            result = self.recognizer.candidate(prototype["embedding"])
            self.assertEqual(result["name"], prototype["name"])
            self.assertGreater(result["score"], .999999)

    def test_original_model_zero_frame_inference_execution_only(self):
        result = self.recognizer.recognize(np.zeros((132, 132, 3), np.uint8))
        self.assertIn(result["name"], self.recognizer.characters)
        self.assertLess(result["score"], .7)
        self.assertTrue(np.isfinite(result["score"]))
        json.dumps(result, allow_nan=False)


if __name__ == "__main__":
    unittest.main()
