"""Semantic compatibility checks, including unchanged BetterGI resources."""

from __future__ import annotations

import io
import json
import os
from pathlib import Path
import subprocess
import sys
import unittest

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from vision import RectExpression, VisionBridge, load_recognition, serve, template_matches

VENDOR_ROOT = Path(__file__).resolve().parents[1] / "third_party/bettergi"
RESOURCE_ROOT = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR_ROOT / "source"))
if (RESOURCE_ROOT / "BetterGenshinImpact").is_dir():
    RESOURCE_ROOT /= "BetterGenshinImpact"
MODEL_ROOT = Path(os.environ.get("BETTERGI_MODEL_ROOT", VENDOR_ROOT / "assets/bettergi.assets.model/Assets/Model"))


class VisionTest(unittest.TestCase):
    def setUp(self):
        self.vision = VisionBridge()
        self.random = np.random.default_rng(417)
        self.template = self.random.integers(0, 255, (13, 19, 3), dtype=np.uint8)

    def source_with_template(self, positions=((35, 22),), width=140, height=90):
        source = self.random.integers(0, 90, (height, width, 3), dtype=np.uint8)
        for x, y in positions:
            source[y:y + 13, x:x + 19] = self.template
        return self.vision.put(source, "ImageRegion", reference_allowed=True)

    def test_template_modes_and_multi(self):
        source = self.source_with_template(((35, 22), (95, 60)))
        template = self.vision.put(self.template)
        for mode in ("CCoeffNormed", "CCorrNormed", "SqDiffNormed", "SqDiff", "CCoeff", "CCorr"):
            matches = self.vision.dispatch("image.findMulti", {"handle": source, "recognition": {
                "TemplateImageMat": template, "TemplateMatchMode": mode,
                "Use3Channels": True, "threshold": .999, "maxMatchCount": 2}})
            self.assertEqual({(r["x"], r["y"]) for r in matches}, {(35, 22), (95, 60)}, mode)
            self.assertTrue(all(.999 <= r["matchScore"] <= 1.00001 for r in matches))

    def test_roi_empty_and_single_exact_size(self):
        source = self.source_with_template()
        template = self.vision.put(self.template)
        ro = {"templateMat": template, "roi": [35, 22, 19, 13]}
        found = self.vision.dispatch("image.find", {"handle": source, "recognition": ro})
        self.assertEqual((found["x"], found["y"], found["width"], found["height"]), (35, 22, 19, 13))
        ro["roi"] = [0, 0, 19, 13]
        missing = self.vision.dispatch("image.find", {"handle": source, "recognition": ro})
        self.assertTrue(all(missing[key] == 0 for key in ("x", "y", "width", "height", "globalX", "globalY")))
        ro["roi"] = [0, 0, 10, 10]
        self.assertEqual(self.vision.dispatch("image.findMulti", {"handle": source, "recognition": ro}), [])

    def test_nested_crop_coordinates_and_disposal(self):
        source = self.source_with_template()
        self.vision.image(source).global_x = 100
        self.vision.image(source).global_y = 200
        first = self.vision.dispatch("image.crop", {"handle": source, "x": 10, "y": 5, "width": 90, "height": 70})
        second = self.vision.dispatch("image.crop", {"handle": first, "x": 20, "y": 10, "width": 50, "height": 40})
        found = self.vision.dispatch("image.find", {"handle": second, "recognition": {"templateMat": self.vision.put(self.template)}})
        self.assertEqual((found["x"], found["y"]), (5, 7))
        self.assertEqual((found["globalX"], found["globalY"]), (135, 222))
        for descriptor in (source, first, second, source):
            self.vision.dispatch("image.dispose", {"handle": descriptor})
        self.assertEqual((found["globalX"], found["globalY"]), (135, 222))
        with self.assertRaisesRegex(ValueError, "disposed"):
            self.vision.image(second)

    def test_crop_clamps_and_rejects_empty(self):
        source = self.source_with_template()
        crop = self.vision.dispatch("image.crop", {"handle": source, "x": -20, "y": -10, "width": 30, "height": 20})
        self.assertEqual((crop["x"], crop["y"], crop["width"], crop["height"]), (0, 0, 10, 10))
        with self.assertRaisesRegex(ValueError, "no pixels"):
            self.vision.dispatch("image.crop", {"handle": source, "x": 1000, "y": 0, "width": 10, "height": 20})

    def test_green_mask_and_binary(self):
        self.template[:3] = [0, 255, 0]
        source = self.source_with_template()
        self.vision.image(source).pixels[22:25, 35:54] = [220, 30, 150]
        template = self.vision.put(self.template)
        found = self.vision.dispatch("image.find", {"handle": source, "recognition": {
            "templateMat": template, "useMask": True, "use3Channels": True,
            "mode": "CCorrNormed", "threshold": .999}})
        self.assertEqual((found["x"], found["y"]), (35, 22))
        binary = self.random.integers(0, 2, (13, 19), dtype=np.uint8) * 255
        pixels = np.zeros((60, 80), np.uint8)
        pixels[25:38, 10:29] = np.where(binary > 0, 210, 50)
        found = self.vision.dispatch("image.find", {"handle": self.vision.put(pixels), "recognition": {
            "templateMat": self.vision.put(binary), "useBinaryMatch": True, "binaryThreshold": 128, "threshold": .999}})
        self.assertEqual((found["x"], found["y"]), (10, 25))

    def test_nms_suppresses_overlap_and_nonfinite(self):
        source = np.full((13, 40), 127, np.uint8)
        template = np.full((13, 19), 127, np.uint8)
        matches = template_matches(source, template, cv2.TM_CCORR_NORMED, None, .99, -1)
        self.assertGreaterEqual(len(matches), 2)
        for i, (x, y, score) in enumerate(matches):
            self.assertTrue(np.isfinite(score))
            for xx, yy, _ in matches[i + 1:]:
                overlap = max(0, 19 - abs(x - xx)) * max(0, 13 - abs(y - yy))
                self.assertLess(overlap / (2 * 19 * 13 - overlap), .5)
        self.assertEqual(template_matches(source, template, cv2.TM_CCORR_NORMED, None, .99, 0), [])
        self.assertEqual(template_matches(np.zeros((13, 19), np.uint8), template, cv2.TM_CCORR_NORMED, np.zeros_like(template), .8, 1), [])

    def test_reference_anchor_scaling_and_crop_rejection(self):
        source = np.zeros((100, 200, 3), np.uint8)
        source[20:33, 135:154] = self.template
        image = self.vision.put(source, "ImageRegion", reference_allowed=True)
        ro = {"templateMat": self.vision.put(self.template),
              "reference": {"size": [100, 100], "bbox": [35, 20, 19, 13]},
              "search": {"anchor": "TopRight", "expandPercent": [0]}}
        found = self.vision.dispatch("image.find", {"handle": image, "recognition": ro})
        self.assertEqual((found["x"], found["y"]), (135, 20))
        crop = self.vision.dispatch("image.crop", {"handle": image, "x": 100, "y": 0, "width": 100, "height": 100})
        self.assertEqual(self.vision.dispatch("image.find", {"handle": crop, "recognition": ro})["width"], 0)
        ro["roi"] = [35, 20, 19, 13]
        self.assertEqual(self.vision.dispatch("image.find", {"handle": crop, "recognition": ro})["x"], 35)
        ro.pop("roi")
        ro["reference"].pop("size")
        self.assertEqual(self.vision.dispatch("image.find", {"handle": image, "recognition": ro})["width"], 0)

    def test_expressions_aliases_cycles_and_no_code_execution(self):
        evaluator = RectExpression({"vars": {"a": "cw / 4", "b": "[a] + 10"},
                                    "regions": {"top": "@alias", "alias": "rect(b, cy, 5 * s, ch)"}}, 960, 540, {"cy": 3})
        self.assertEqual(evaluator.rectangle("@top"), [250, 3, 2, 540])
        self.assertEqual(evaluator.rectangle("cutRightBottom(0.123, 0.234)"), [841, 413, 118, 126])
        for expression in ("__import__('os')", "cw.__class__", "[x for x in (1,2)]"):
            with self.assertRaises(ValueError):
                evaluator.evaluate(expression)
        with self.assertRaisesRegex(ValueError, "Circular"):
            RectExpression({"vars": {"a": "b", "b": "a"}}, 100, 100).evaluate("a")
        with self.assertRaisesRegex(ValueError, "Circular"):
            RectExpression({"regions": {"a": "@b", "b": "@a"}}, 100, 100).rectangle("@a")

    def test_mat_operations_and_explicit_unsupported(self):
        pixels = np.zeros((20, 30, 3), np.uint8)
        pixels[2:7, 4:12] = [0, 255, 0]
        image = self.vision.put(pixels)
        hsv = self.vision.dispatch("image.mat", {"handle": image, "method": "CvtColor", "args": ["BGR2HSV"]})
        mask = self.vision.dispatch("image.mat", {"handle": hsv, "method": "InRange", "args": [[50, 240, 240], [70, 255, 255]]})
        self.assertEqual(self.vision.dispatch("image.mat", {"handle": mask, "method": "CountNonZero"}), 40)
        resized = self.vision.dispatch("image.mat", {"handle": image, "method": "Resize", "args": [{"Width": 60, "Height": 40}]})
        self.assertEqual((resized["width"], resized["height"], resized["channels"]), (60, 40, 3))
        clone = self.vision.dispatch("image.mat", {"handle": image, "method": "Clone"})
        self.vision.image(image).pixels[:] = 0
        self.assertEqual(self.vision.dispatch("image.mat", {"handle": clone, "method": "At", "args": [3, 5]}), [0, 255, 0])
        with self.assertRaises(NotImplementedError):
            self.vision.dispatch("image.mat", {"handle": image, "method": "PretendSuccess"})

    def test_original_challenge_mask_contours_and_roi_mutation(self):
        pixels = np.zeros((80, 100), np.uint8)
        pixels[10:60, 10:80] = 255
        pixels[30:35, 40:45] = 0
        image = self.vision.put(pixels)
        roi = self.vision.dispatch("image.mat", {"handle": image, "method": "Roi", "args": [[10, 10, 5, 5]]})
        self.vision.dispatch("image.mat", {"handle": roi, "method": "SetTo", "args": [0]})
        self.assertEqual(int(pixels[11, 11]), 0)
        kernel = self.vision.dispatch("image.mat", {"method": "GetStructuringElement", "args": ["Rect", [7, 7]]})
        self.vision.dispatch("image.mat", {"handle": image, "method": "MorphologyEx", "args": ["Close", kernel], "destination": image})
        contours = self.vision.dispatch("image.mat", {"handle": image, "method": "FindContours", "args": ["External", "ApproxSimple"]})
        self.assertEqual(len(contours["contours"]), 1)
        contour = contours["contours"][0]
        area = self.vision.dispatch("image.mat", {"method": "ContourArea", "args": [contour]})
        self.assertGreater(area, 3000)
        box = self.vision.dispatch("image.mat", {"method": "BoundingRect", "args": [contour]})
        self.assertEqual(box, {"x": 10, "y": 10, "width": 70, "height": 50})

    def test_jsonl_recovers_after_bad_request(self):
        source = io.StringIO('{"id":1,"op":"vision.status"}\n{"id":2,"op":"no-such-op"}\n{bad}\n{"id":3,"op":"recognition.evaluate","args":{"width":100,"height":50,"expression":"rect(1,2,cw,ch)"}}\n')
        output = io.StringIO()
        serve(self.vision, source, output)
        rows = [json.loads(row) for row in output.getvalue().splitlines()]
        self.assertIn("opencv", rows[0]["result"])
        self.assertEqual(rows[1]["error"]["name"], "NotImplementedError")
        self.assertEqual(rows[2]["error"]["name"], "JSONDecodeError")
        self.assertEqual(rows[3]["result"], [1, 2, 100, 50])

    def test_process_protocol_is_clean_jsonl(self):
        path = Path(__file__).resolve().parents[1] / "scripts/bettergi/vision.py"
        run = subprocess.run([sys.executable, str(path)], input='{"id":7,"op":"vision.status"}\n', capture_output=True, text=True, check=True)
        self.assertEqual(len(run.stdout.splitlines()), 1)
        self.assertEqual(json.loads(run.stdout)["id"], 7)


@unittest.skipUnless(RESOURCE_ROOT.is_dir(), "Set BETTERGI_SOURCE_ROOT to the unchanged BetterGI source")
class OriginalAssetsTest(unittest.TestCase):
    def test_every_original_recognition_object_at_three_resolutions(self):
        count = 0
        definitions = sorted((RESOURCE_ROOT / "GameTask").rglob("Recognition.json"))
        self.assertGreaterEqual(len(definitions), 19)
        for path in definitions:
            config = json.loads(path.read_text(encoding="utf-8-sig"))
            original = path.read_bytes()
            for name in config["objects"]:
                for width, height in ((1920, 1080), (1280, 720), (2560, 1440)):
                    recognition = load_recognition(path, name, width, height)
                    self.assertIn("type", recognition)
                    if recognition["type"] == "TemplateMatch":
                        self.assertIsNotNone(cv2.imread(recognition["template_path"]))
                    count += 1
            self.assertEqual(path.read_bytes(), original)
        self.assertEqual(count, 528)

    def test_original_f_key_template_in_capture(self):
        path = RESOURCE_ROOT / "GameTask/AutoPick/Assets/Recognition.json"
        recognition = load_recognition(path, "F", 1920, 1080)
        pixels = cv2.imread(recognition["template_path"])
        h, w = pixels.shape[:2]
        capture = np.zeros((1080, 1920, 3), np.uint8)
        capture[400:400 + h, 1100:1100 + w] = pixels
        vision = VisionBridge()
        found = vision.dispatch("image.find", {"handle": vision.put(capture), "recognition": recognition})
        self.assertEqual((found["x"], found["y"]), (1100, 400))


@unittest.skipUnless((MODEL_ROOT / "PaddleOCR").is_dir(), "Set BETTERGI_MODEL_ROOT to original Assets/Model")
class OriginalOcrTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vision = VisionBridge(str(MODEL_ROOT))
        cls.image = cls.vision.dispatch("image.load", {"path": str(MODEL_ROOT / "PaddleOCR/test_pp_ocr.png"), "type": "ImageRegion"})

    def test_original_model_recognizes_menu_and_reports_hashes(self):
        lines = self.vision.dispatch("image.ocr", {"handle": self.image})
        texts = [line["text"] for line in lines]
        self.assertEqual(len(lines), 5)
        self.assertIn("探索派遣", texts)
        self.assertIn("你好，凯瑟琳。", texts)
        self.assertIn("再见。", texts)
        self.assertTrue(all(line["width"] > 0 and line["height"] > 0 and line["matchScore"] >= .5 for line in lines))
        status = self.vision.dispatch("vision.status", {})
        self.assertEqual(status["ocr"]["providers"], ["CPUExecutionProvider"])
        self.assertEqual(status["ocr"]["models"][0]["sha256"], "fd4d9b7b107ef959c5358ae567ce1ce1c6b8d61f01b6102ea42f763babb2ebda")
        self.assertEqual(status["ocr"]["models"][1]["sha256"], "3080c7ee62a4455bf2a46601928ed3c1d165ce3b3b613f4a86582c6f1c2be58a")

    def test_ocr_match_roi_regex_replacements_and_no_hit(self):
        recognition = {"type": "OcrMatch", "roi": [0, 140, 267, 60],
                       "allContains": ["探索"], "oneContains": ["派遣", "不会出现"], "regex": ["探索.*遣"]}
        found = self.vision.dispatch("image.find", {"handle": self.image, "recognition": recognition})
        self.assertEqual((found["x"], found["y"], found["width"], found["height"]), (0, 140, 267, 60))
        recognition["allContains"] = ["不会出现"]
        missing = self.vision.dispatch("image.find", {"handle": self.image, "recognition": recognition})
        self.assertEqual(missing["height"], 0)
        recognition = {"type": "Ocr", "roi": [0, 140, 267, 60], "replace": {"领取派遣": ["探索派遣"]}}
        self.assertEqual(self.vision.dispatch("image.find", {"handle": self.image, "recognition": recognition})["text"], "领取派遣")
        with self.assertRaisesRegex(ValueError, "requires"):
            self.vision.dispatch("image.find", {"handle": self.image, "recognition": {"type": "OcrMatch"}})

    def test_ocr_this_preserves_image_descriptor(self):
        found = self.vision.dispatch("image.find", {"handle": self.image, "recognition": {"type": "Ocr"}})
        self.assertEqual(found["handle"], self.image["handle"])
        self.assertIn("探索派遣", found["text"])
        self.assertEqual(found["__bgiType"], "ImageRegion")


if __name__ == "__main__":
    unittest.main()
