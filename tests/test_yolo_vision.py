"""Pinned YoloSharp preprocessing, parser and original ONNX smoke checks."""
from pathlib import Path
import sys
import unittest

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from yolo_vision import YoloPredictor, configuration, parse_detection, preprocess
from vision import VisionBridge

MODELS = Path(__file__).resolve().parents[1] / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"


class YoloTest(unittest.TestCase):
    def test_zero_padding_rgb_channels_and_nearest_neighbor(self):
        image = np.array([[[0, 0, 255], [255, 0, 0]]], np.uint8)
        tensor = preprocess(image, (4, 4))
        self.assertEqual(tensor.shape, (1, 3, 4, 4))
        np.testing.assert_array_equal(tensor[0, :, 0], 0)
        np.testing.assert_array_equal(tensor[0, :, 3], 0)
        np.testing.assert_array_equal(tensor[0, 0, 1:3], [[1, 1, 0, 0]] * 2)
        np.testing.assert_array_equal(tensor[0, 2, 1:3], [[0, 0, 1, 1]] * 2)
        stretch = preprocess(image, (4, 4), False)
        np.testing.assert_array_equal(stretch[0, 0], [[1, 1, 0, 0]] * 4)

    def test_class_specific_nms_strict_threshold_and_coordinate_restore(self):
        tensor = np.zeros((1, 6, 4), np.float32)
        tensor[0, :4] = np.array([[320, 320, 100, 320], [320, 320, 100, 320], [80, 80, 20, 80], [40, 40, 20, 40]])
        tensor[0, 4] = [.9, .8, .3, .3]
        tensor[0, 5] = [.7, 0, 0, 0]
        predictions = parse_detection(tensor, ["fish", "rod"], (1280, 720), (640, 640), configuration())
        self.assertEqual([p["name"]["name"] for p in predictions], ["fish", "rod"])
        self.assertEqual(predictions[0]["bounds"], dict(x=560, y=320, width=160, height=80))
        self.assertAlmostEqual(predictions[0]["confidence"], .9, places=6)

    def test_v10_integer_bounds_and_no_clipping(self):
        tensor = np.array([[[-10.8, 1.8, 10.9, 21.9, .9, 0], [1, 1, 2, 2, .3, 0]]], np.float32)
        predictions = parse_detection(tensor, ["tree"], (640, 640), (640, 640), configuration())
        self.assertEqual(len(predictions), 1)
        self.assertEqual(predictions[0]["bounds"], dict(x=-10, y=1, width=20, height=20))

    def test_case_insensitive_options_and_lazy_disposal(self):
        config = configuration(options={"CONFIDENCE": "0.7", "IoU": .2, "KeepAspectRatio": "false", "unknown": True})
        self.assertAlmostEqual(config["confidence"], .7, places=6)
        self.assertFalse(config["keepAspectRatio"])
        predictor = YoloPredictor("not-loaded.onnx")
        self.assertIsNone(predictor.session)
        predictor.dispose(); predictor.dispose()
        with self.assertRaisesRegex(ValueError, "disposed"):
            predictor.load()
        with self.assertRaisesRegex(ValueError, ".onnx"):
            YoloPredictor("model.txt")

    def test_original_five_models_execute_and_classification_preserves_probabilities(self):
        expected = {"Fish/bgi_fish.onnx": ("detect", 25), "Domain/bgi_tree.onnx": ("detect", 1),
                    "Mine/bgi_mine.onnx": ("detect", 1), "World/bgi_world.onnx": ("detect", 7),
                    "Common/avatar_side_classify_sim.onnx": ("classify", 161)}
        for relative, (task, count) in expected.items():
            with self.subTest(model=relative):
                predictor = YoloPredictor(MODELS / relative)
                result = predictor.predict(np.zeros((108, 192, 3), np.uint8))
                self.assertEqual(predictor.task, task)
                self.assertEqual(len(predictor.names), count)
                self.assertEqual(len(predictor.status()["sha256"]), 64)
                if task == "classify":
                    tensor = preprocess(np.zeros((108, 192, 3), np.uint8), predictor.size)
                    scores = predictor.session.run(None, {predictor.session.get_inputs()[0].name: tensor})[0].ravel()
                    self.assertEqual(result[0]["name"]["id"], int(np.argmax(scores)))
                    self.assertEqual(result[0]["confidence"], float(scores.max()))
                predictor.dispose()

    def test_bridge_regions_remain_clickable_after_frame_disposal(self):
        bridge = VisionBridge()
        frame = bridge.put(np.zeros((100, 200, 3), np.uint8), "ImageRegion", global_x=50, global_y=60)
        key = bridge.dispatch("yolo.create", {"path": "fake.onnx"})["predictor"]
        predictor = bridge.yolo_vision.predictors[key]
        predictor.task = "detect"
        predictor.predict = lambda pixels, options: [{"name": {"id": 0, "name": "tree"}, "confidence": .8,
                                                     "bounds": dict(x=10, y=20, width=30, height=40)}]
        regions = bridge.dispatch("yolo.regions", {"predictor": key, "handle": frame})
        bridge.dispatch("image.dispose", {"handle": frame})
        self.assertEqual((regions[0]["globalX"], regions[0]["globalY"]), (60, 80))
        self.assertEqual(regions[0]["detection"]["name"]["name"], "tree")
        bridge.dispatch("yolo.dispose", {"predictor": key})
        with self.assertRaisesRegex(ValueError, "disposed"):
            predictor.load()


if __name__ == "__main__":
    unittest.main()
