"""UseGadget's recognizer bridge contract; never substitutes detector OCR."""

from pathlib import Path
import io
import json
import os
import sys
import unittest
from unittest.mock import Mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from vision import VisionBridge, serve

MODEL_ROOT = Path(os.environ.get("BETTERGI_MODEL_ROOT", Path(__file__).resolve().parents[1]
                                / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"))


class OcrWithoutDetectorTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.engine = Mock()
        self.engine.recognize.return_value = ("  12.5 ", np.float32(.02))
        self.bridge.ocr_engine = self.engine

    def test_recognizes_raw_handle_pixels_without_detector_score_filter_or_cleaning(self):
        pixels = np.zeros((18, 77), np.uint8)
        pixels[4:14, 9:63] = 255
        handle = self.bridge.put(pixels)
        result = self.bridge.dispatch("image.ocrWithoutDetector", {"handle": handle})
        self.assertEqual(result["text"], "  12.5 ")
        self.assertIsInstance(result["score"], float)
        self.assertAlmostEqual(result["score"], .02)
        self.assertEqual(len(self.bridge.images), 1)
        self.assertIs(self.engine.recognize.call_args.args[0], pixels)
        self.engine.run.assert_not_called()
        self.engine.detection.assert_not_called()

    def test_empty_recognized_text_is_explicit_result(self):
        self.engine.recognize.return_value = ("", 0)
        descriptor = self.bridge.put(np.zeros((12, 20, 3), np.uint8))
        self.assertEqual(self.bridge.dispatch("image.ocrWithoutDetector", {"handle": descriptor["handle"]}),
                         {"text": "", "score": 0})

    def test_unknown_handle_and_recognizer_failure_propagate(self):
        with self.assertRaises((KeyError, ValueError)):
            self.bridge.dispatch("image.ocrWithoutDetector", {"handle": 100})
        descriptor = self.bridge.put(np.zeros((12, 20, 3), np.uint8))
        self.engine.recognize.side_effect = RuntimeError("fixture inference failure")
        with self.assertRaisesRegex(RuntimeError, "fixture inference"):
            self.bridge.dispatch("image.ocrWithoutDetector", {"handle": descriptor})
        self.assertEqual(len(self.bridge.images), 1)

    def test_original_crop_hsv_white_threshold_pipeline_disposes_all_derived_handles(self):
        pixels = np.zeros((70, 100, 3), np.uint8)
        pixels[25:38, 33:57] = 255
        original = self.bridge.put(pixels)
        crop = self.bridge.dispatch("image.crop", {"handle": original, "x": 20, "y": 20, "width": 57, "height": 35})
        hsv = self.bridge.dispatch("image.mat", {"handle": crop, "method": "CvtColor", "args": ["BGR2HSV"]})
        binary = self.bridge.dispatch("image.mat", {"handle": hsv, "method": "InRange", "args": [[0, 0, 235], [0, 25, 255]]})
        result = self.bridge.dispatch("image.ocrWithoutDetector", {"handle": binary})
        expected = cv2.inRange(cv2.cvtColor(pixels[20:55, 20:77], cv2.COLOR_BGR2HSV), (0, 0, 235), (0, 25, 255))
        np.testing.assert_array_equal(self.engine.recognize.call_args.args[0], expected)
        self.assertEqual(result["text"], "  12.5 ")
        for handle in (binary, hsv, crop, original):
            self.bridge.dispatch("image.dispose", {"handle": handle})
        self.assertEqual(self.bridge.images, {})

    def test_jsonl_serializes_native_score_and_keeps_request_id(self):
        descriptor = self.bridge.put(np.zeros((12, 20), np.uint8))
        request = dict(id=7, op="image.ocrWithoutDetector", args=dict(handle=descriptor))
        output = io.StringIO()
        serve(self.bridge, io.StringIO(json.dumps(request) + chr(10)), output)
        result = json.loads(output.getvalue())
        self.assertEqual(result["id"], 7)
        self.assertEqual(result["result"]["text"], "  12.5 ")
        self.assertAlmostEqual(result["result"]["score"], .02)


@unittest.skipUnless((MODEL_ROOT / "PaddleOCR").is_dir(), "Original BetterGI Paddle model unavailable")
class OriginalRecognizerTest(unittest.TestCase):
    def test_original_number_fixture_uses_recognizer_without_running_detector(self):
        bridge = VisionBridge(str(MODEL_ROOT))
        descriptor = bridge.dispatch("image.load", {"path": str(MODEL_ROOT / "PaddleOCR/test_pp_ocr_number.png")})
        engine = bridge.ocr()
        engine.detection = Mock(side_effect=AssertionError("Detector must not run"))
        result = bridge.dispatch("image.ocrWithoutDetector", {"handle": descriptor})
        self.assertEqual(result["text"], "7686")
        self.assertGreater(result["score"], .99)
        engine.detection.assert_not_called()
        bridge.dispatch("image.dispose", {"handle": descriptor})
        self.assertEqual(bridge.images, {})

    def test_binary_white_mask_matches_original_direct_recognizer_without_filtering(self):
        bridge = VisionBridge(str(MODEL_ROOT))
        image = cv2.imread(str(MODEL_ROOT / "PaddleOCR/test_pp_ocr.png"))[140:200]
        binary = cv2.inRange(cv2.cvtColor(image, cv2.COLOR_BGR2HSV), (0, 0, 235), (0, 25, 255))
        descriptor = bridge.put(binary)
        engine = bridge.ocr()
        expected_text, expected_score = engine.recognize(binary)
        engine.detection = Mock(side_effect=AssertionError("Detector must not run"))
        result = bridge.dispatch("image.ocrWithoutDetector", {"handle": descriptor})
        self.assertEqual(result["text"], expected_text)
        self.assertAlmostEqual(result["score"], expected_score)
        engine.detection.assert_not_called()


if __name__ == "__main__":
    unittest.main()
