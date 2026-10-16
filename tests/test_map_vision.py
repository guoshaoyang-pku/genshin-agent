"""Map algorithm checks against the unchanged BetterGI resource package."""

from __future__ import annotations

import json
import math
import os
from pathlib import Path
import sys
import tempfile
import unittest

import cv2
import numpy as np

PROJECT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(PROJECT / "scripts/bettergi"))
from map_vision import MapVision, MiniMapPreprocessor, icon_mask, load_feature_pair

VENDOR = PROJECT / "third_party/bettergi"
MAP_ROOT = Path(os.environ.get("BETTERGI_MAP_ROOT", VENDOR / "assets/bettergi.assets.map/Assets/Map"))
SOURCE_ROOT = Path(os.environ.get("BETTERGI_SOURCE_ROOT", VENDOR / "source/BetterGenshinImpact"))


def camera_cone(angle):
    y, x = np.indices((212, 212), dtype=np.float32)
    radius = np.hypot(x - 106, y - 106)
    theta = np.degrees(np.arctan2(y - 106, x - 106)) % 360
    difference = (theta - angle + 180) % 360 - 180
    image = np.full((212, 212, 3), [100, 125, 130], np.uint8)
    alpha = np.minimum(137 + 1.43 * radius, 255) / 255
    cone = (radius > 10) & (radius < 78) & (np.abs(difference) < 45)
    mixed = image.astype(np.float32) * alpha[:, :, None] + 255 * (1 - alpha[:, :, None])
    image[cone] = np.rint(mixed[cone]).astype(np.uint8)
    return image


class OrientationTest(unittest.TestCase):
    def setUp(self):
        self.vision = MapVision(MAP_ROOT, SOURCE_ROOT)

    def test_source_camera_v2_and_gia_directions(self):
        for expected in (0, 45, 90, 180, 270):
            image = camera_cone(expected)
            for method, tolerance in (("v2", .6), ("gia", 2)):
                result = self.vision.dispatch("map.cameraOrientation", {"minimap": True, "method": method}, image)
                self.assertTrue(result["valid"], (expected, method, result))
                error = abs((result["angle"] - expected + 180) % 360 - 180)
                self.assertLessEqual(error, tolerance, (expected, method, result))
                self.assertGreater(result["confidence"], .85)
                json.dumps(result, allow_nan=False)

    def test_camera_scaled_capture_and_explicit_roi(self):
        image = camera_cone(90)
        capture = np.zeros((540, 960, 3), np.uint8)
        capture[9:115, 31:137] = cv2.resize(image, (106, 106))
        result = self.vision.dispatch("map.cameraOrientation", {}, capture)
        self.assertEqual(result["roi"], [31, 9, 106, 106])
        self.assertTrue(result["valid"])
        self.assertLess(abs(result["angle"] - 90), 1)
        capture = np.zeros((300, 400, 3), np.uint8)
        capture[40:252, 50:262] = image
        result = self.vision.dispatch("map.cameraOrientation", {"roi": [50, 40, 212, 212]}, capture)
        self.assertEqual(result["angle"], 90)

    def test_uniform_camera_is_not_evidence(self):
        for shade in (0, 25, 100, 150, 200, 255):
            for method in ("auto", "v2", "gia"):
                result = self.vision.dispatch("map.cameraOrientation", {"minimap": True, "method": method},
                                              np.full((212, 212, 3), shade, np.uint8))
                self.assertFalse(result["valid"], (shade, method, result))
                self.assertIsNone(result["angle"])
        image = np.full((212, 212, 3), [100, 125, 130], np.uint8)
        self.assertFalse(self.vision.dispatch("map.cameraOrientation", {"minimap": True}, image)["valid"])

    def test_character_notch_and_source_early_return(self):
        image = np.zeros((212, 212, 3), np.uint8)
        triangle = np.array([(106, 80), (90, 120), (122, 120)])
        cv2.fillPoly(image, [triangle], (255, 220, 0))
        image[115:121, 103:110] = 0
        result = self.vision.dispatch("map.characterOrientation", {"minimap": True}, image)
        self.assertEqual(result["angle"], -90)
        self.assertTrue(result["valid"])
        # This hue lies outside the source HSV mask; source returns on the first edge.
        cv2.fillPoly(image, [triangle], (255, 255, 0))
        self.assertEqual(self.vision.dispatch("map.characterOrientation", {"minimap": True}, image)["angle"], 39)
        image[:] = 0
        result = self.vision.dispatch("map.characterOrientation", {"minimap": True}, image)
        self.assertEqual(result["angle"], -1)
        self.assertFalse(result["valid"])

    def test_preprocessor_masks_and_numeric_bounds(self):
        preprocessor = MiniMapPreprocessor()
        image = camera_cone(45)
        image[55:63, 65:73] = 255
        image[65:73, 65:73] = 80
        image[75:83, 65:73] = [150, 0, 0]
        mask = icon_mask(image)
        self.assertEqual((int(mask[58, 68]), int(mask[68, 68]), int(mask[78, 68])), (255, 255, 0))
        processed, allowed = preprocessor.process(image)
        self.assertEqual(processed.shape, (156, 156, 3))
        self.assertEqual(allowed.shape, (156, 156))
        self.assertEqual(processed.dtype, np.uint8)
        self.assertEqual(allowed.dtype, np.uint8)
        self.assertEqual(allowed[0, 0], 0)
        self.assertTrue(set(np.unique(allowed)).issubset({0, 255}))
        self.assertTrue(np.isfinite(preprocessor.radial_alpha1).all())
        self.assertEqual(preprocessor.radial_alpha2.dtype, np.float32)

    def test_explicit_errors(self):
        image = camera_cone(0)
        with self.assertRaisesRegex(ValueError, "Unknown camera"):
            self.vision.dispatch("map.cameraOrientation", {"minimap": True, "method": "invented"}, image)
        with self.assertRaisesRegex(ValueError, "no pixels"):
            self.vision.dispatch("map.cameraOrientation", {"roi": [1000, 1000, 2, 2]}, image)
        with self.assertRaisesRegex(ValueError, "finite"):
            self.vision.dispatch("map.cameraOrientation", {"roi": [math.nan, 0, 2, 2]}, image)
        with self.assertRaisesRegex(ValueError, "uint8"):
            self.vision.dispatch("map.cameraOrientation", {}, image.astype(np.float32))
        with self.assertRaises(NotImplementedError):
            self.vision.dispatch("map.unknown", {}, image)


@unittest.skipUnless((MAP_ROOT / "Teyvat/Teyvat_0_256.png").is_file(), "Original BetterGI map package is required")
class OriginalMapTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.vision = MapVision(MAP_ROOT, SOURCE_ROOT)
        image = cv2.imread(str(MAP_ROOT / "Teyvat/Teyvat_0_256.png"))
        cls.big_map = cv2.resize(image[2000:2240, 4000:4300], None, fx=4, fy=4)

    def assert_position(self, result, x, y, tolerance=.2):
        self.assertTrue(result["found"], result)
        self.assertLess(abs(result["position"]["x"] - x), tolerance, result)
        self.assertLess(abs(result["position"]["y"] - y), tolerance, result)
        json.dumps(result, allow_nan=False)

    def test_original_binary_keypoints_and_descriptors(self):
        layer = load_feature_pair(MAP_ROOT / "Teyvat/Teyvat_0_256")
        self.assertEqual(layer.points.shape, (38343, 2))
        self.assertEqual(layer.descriptors.shape, (38343, 128))
        self.assertEqual(layer.descriptors.dtype, np.float32)
        self.assertTrue(np.isfinite(layer.points).all())
        with tempfile.TemporaryDirectory() as directory:
            prefix = Path(directory) / "bad"
            Path(str(prefix) + "_SIFT.kp.bin").write_bytes(b"bad")
            with self.assertRaisesRegex(ValueError, "byte count"):
                load_feature_pair(prefix)
            record = np.zeros(7, np.float32)
            record[2] = 1
            Path(str(prefix) + "_SIFT.kp.bin").write_bytes(record.tobytes())
            cv2.imwrite(str(prefix) + "_SIFT.mat.png", np.zeros((2, 128), np.uint8))
            with self.assertRaisesRegex(ValueError, "dimensions"):
                load_feature_pair(prefix)

    def test_original_teyvat_big_map_scale_world_and_homography(self):
        result = self.vision.dispatch("map.locateBigMap", {}, self.big_map)
        self.assert_position(result, 33200, 16960, .2)
        self.assertGreater(result["matches"], 250)
        self.assertGreater(result["inlierRatio"], .95)
        self.assertEqual(result["coordinateScale"], 8)
        self.assertAlmostEqual(result["resourcePosition"]["x"] * 8, result["position"]["x"])
        self.assertAlmostEqual(result["genshin"]["x"], -216, delta=.1)
        self.assertAlmostEqual(result["genshin"]["y"], 3808, delta=.1)
        center = np.array([[[self.big_map.shape[1] / 2, self.big_map.shape[0] / 2]]], np.float32)
        mapped = cv2.perspectiveTransform(center, np.array(result["homography"]))[0, 0]
        np.testing.assert_allclose(mapped, [33200, 16960], atol=.2)

    def test_big_map_local_and_global_fallback(self):
        local = self.vision.dispatch("map.locateBigMap", {"previous": {"x": 33200, "y": 16960}}, self.big_map)
        self.assert_position(local, 33200, 16960)
        self.assertEqual(local["method"], "sift-knn-ransac-local")
        local = self.vision.dispatch("map.locateBigMap", {"previousRect": [32000, 16000, 2400, 1920]}, self.big_map)
        self.assert_position(local, 33200, 16960)
        self.assertEqual(local["method"], "sift-knn-ransac-local")
        fallback = self.vision.dispatch("map.locateBigMap", {"previousRect": [0, 0, 100, 100]}, self.big_map)
        self.assert_position(fallback, 33200, 16960)
        self.assertEqual(fallback["method"], "sift-knn-ransac")
        global_result = self.vision.dispatch("map.locateBigMap", {"previous": {"x": 0, "y": 0}}, self.big_map)
        self.assertEqual(global_result["method"], "sift-knn-ransac")

    def test_original_ordinary_center_match_and_local_knn(self):
        result = self.vision.dispatch("map.locateBigMap", {"matchTarget": "position"}, self.big_map)
        self.assert_position(result, 33200, 16960, .2)
        self.assertEqual(result["method"], "sift-match-ransac")
        self.assertGreaterEqual(result["matches"], 20)
        local = self.vision.dispatch("map.locateBigMap", {"matchTarget": "position",
                                     "previous": {"x": 33200, "y": 16960}}, self.big_map)
        self.assert_position(local, 33200, 16960)
        self.assertEqual(local["method"], "sift-knn-ransac-local")

    def test_generated_sift_from_original_scene(self):
        image = cv2.imread(str(MAP_ROOT / "TheChasm/TheChasm_0_1024.png"))
        query = image[1000:1260, 1000:1260]
        args = {"mapName": "TheChasm", "minimap": True, "preprocess": False, "matchingMethod": "SIFT"}
        result = self.vision.dispatch("map.locateMinimap", args, query)
        self.assert_position(result, 1130, 1130, .1)
        self.assertTrue(result["generatedFeatures"])
        self.assertGreater(result["matches"], 450)
        self.assertEqual(result["coordinateScale"], 1)
        local = self.vision.dispatch("map.locateMinimap", {**args, "previous": result["position"]}, query)
        self.assert_position(local, 1130, 1130, .1)

    def test_other_source_scenes_and_floor_selection(self):
        cases = (("TempleOfSpace", 0, 2340, 1560),
                 ("AncientSacredMountain", -1, 2340, 1300),
                 ("SeaOfBygoneEras", -2, 1560, 1300))
        for name, floor, x, y in cases:
            prefix = next(prefix for level, prefix in self.vision._resources(name) if level == floor)
            path = next(path for path in (Path(str(prefix) + ".png"), Path(str(prefix) + ".webp")) if path.is_file())
            image = cv2.imread(str(path))
            query = image[y:y + 260, x:x + 260]
            result = self.vision.dispatch("map.locateMinimap", {"mapName": name, "floor": floor,
                                          "minimap": True, "preprocess": False}, query)
            self.assert_position(result, x + 130, y + 130, .1)
            self.assertEqual(result["matchingMethod"], "SIFT")
            self.assertEqual(result["floor"], floor)
        moon = load_feature_pair(MAP_ROOT / "MoonCanon/MoonCanon_0_1024")
        self.assertEqual(len(moon.points), 65964)

    def test_default_template_global_local_and_no_guessed_fallback(self):
        image = cv2.imread(str(MAP_ROOT / "TheChasm/MapBack_TheChasm_gray.webp"))
        query = np.zeros((212, 212, 3), np.uint8)
        query[28:184, 28:184] = cv2.resize(image[1000:1260, 1000:1260], (156, 156), interpolation=cv2.INTER_AREA)
        args = {"mapName": "TheChasm", "minimap": True, "preprocess": False}
        result = self.vision.dispatch("map.locateMinimap", args, query)
        self.assert_position(result, 1130, 1130, .1)
        self.assertEqual(result["matchingMethod"], "TemplateMatch")
        self.assertGreater(result["confidence"], .99)
        self.assertEqual(result["layerId"], "MapBack_TheChasm")
        self.assertIsNone(result["homography"])
        local = self.vision.dispatch("map.locateMinimap", {**args, "previous": result["position"], "rank": 0}, query)
        self.assert_position(local, 1130, 1130, .1)
        self.assertEqual(local["method"], "BetterGI-TemplateMatch-local")
        missing = self.vision.dispatch("map.locateMinimap", {**args, "previous": {"x": 50, "y": 50}}, query)
        self.assertFalse(missing["found"])
        self.assertIsNone(missing["position"])

    def test_original_template_layer_coordinates_teyvat_and_enkanomiya(self):
        cases = (("Teyvat", "MapBack_0", 500, 600),
                 ("Enkanomiya", "MapBack_AbyssalPalace", 300, 250))
        for name, layer_id, x, y in cases:
            layer = next(item for item in self.vision._templates(name) if item["LayerId"] == layer_id)
            color = self.vision._template_image(name, layer, True)
            mini = np.zeros((212, 212, 3), np.uint8)
            mini[28:184, 28:184] = cv2.resize(color[y:y + 52, x:x + 52], (156, 156), interpolation=cv2.INTER_LINEAR)
            result = self.vision.dispatch("map.locateMinimap", {"mapName": name,
                                          "preprocess": False, "minimap": True}, mini)
            self.assertTrue(result["found"], result)
            self.assertEqual(result["layerId"], layer_id)
            expected = (layer["Left"] - (x + 26) * 5 / layer.get("Scale", 1),
                        layer["Top"] - (y + 26) * 5 / layer.get("Scale", 1))
            self.assertAlmostEqual(result["genshin"]["x"], expected[0], delta=.2)
            self.assertAlmostEqual(result["genshin"]["y"], expected[1], delta=.2)

    def test_source_global_rank_is_fixed_and_local_rank_is_applied(self):
        layer = next(item for item in self.vision._templates("Teyvat") if item["LayerId"] == "MapBack_0")
        color = self.vision._template_image("Teyvat", layer, True)
        mini = np.zeros((212, 212, 3), np.uint8)
        mini[28:184, 28:184] = cv2.resize(color[800:852, 400:452], (156, 156))
        args = {"layerId": "MapBack_0", "preprocess": False, "minimap": True, "rank": 0}
        result = self.vision.dispatch("map.locateMinimap", args, mini)
        self.assertTrue(result["found"], result)
        self.assertGreater(result["confidence"], .95)
        self.assertLess(result["confidence"], .99)
        local = self.vision.dispatch("map.locateMinimap", {**args, "previous": result["position"]}, mini)
        self.assertFalse(local["found"])

    @unittest.skipUnless((SOURCE_ROOT / "GameTask/AutoTrackPath/Assets/tp.json").is_file(), "Original source assets are required")
    def test_sea_original_teleport_catalog_and_exact_constellation(self):
        icon, points, _ = self.vision._sea_resources()
        self.assertEqual(len(points), 17)
        self.assertEqual(points[0].tolist(), [1284, 1659])
        capture = np.full((1080, 1920, 3), 35, np.uint8)
        for point in points:
            x, y = (point - [1100, 1000] - 12).astype(int)
            capture[y:y + icon.shape[0], x:x + icon.shape[1]] = icon[:, :, :3]
        result = self.vision.dispatch("map.locateBigMap", {"mapName": "SeaOfBygoneEras"}, capture)
        self.assert_position(result, 2060, 1540)
        self.assertEqual(result["rect"], {"x": 1100, "y": 1000, "width": 1920, "height": 1080})
        self.assertEqual(result["method"], "BetterGI-teleport-constellation")
        self.assertEqual(result["teleportCount"], 17)
        self.assertEqual(result["deviation"], 0)
        self.assertIsNone(self.vision._sea_rect(np.zeros((1080, 1920), np.uint8), {}, 1920))

    def test_scene_inventory_and_explicit_failures(self):
        status = self.vision.dispatch("map.status")
        self.assertEqual(len(status["scenes"]), 7)
        self.assertEqual(status["templateLayers"], {"Teyvat": 342, "TheChasm": 1, "Enkanomiya": 1})
        self.assertEqual([layer["floor"] for layer in status["scenes"]["SeaOfBygoneEras"]], [0, -1, -2])
        json.dumps(status, allow_nan=False)
        for operation in ("map.locateMinimap", "map.locateBigMap"):
            result = self.vision.dispatch(operation, {"minimap": True}, np.zeros((212, 212, 3), np.uint8))
            self.assertFalse(result["found"])
            self.assertIsNone(result["position"])
            self.assertIsNone(result["genshin"])
        with self.assertRaisesRegex(ValueError, "Unknown BetterGI map:"):
            self.vision.dispatch("map.locateBigMap", {"mapName": "unknown"}, self.big_map)
        with self.assertRaisesRegex(ValueError, "matching method"):
            self.vision.dispatch("map.locateBigMap", {"matchingMethod": "invented"}, self.big_map)
        with self.assertRaisesRegex(ValueError, "finite"):
            self.vision.dispatch("map.locateBigMap", {"previous": {"x": math.nan, "y": 1}}, self.big_map)
        with self.assertRaisesRegex(ValueError, "positive"):
            self.vision.dispatch("map.locateBigMap", {"previousRect": [0, 0, -1, 20]}, self.big_map)
        with self.assertRaises(FileNotFoundError):
            self.vision.dispatch("map.locateBigMap", {"floor": 99}, self.big_map)
        with self.assertRaises(FileNotFoundError):
            MapVision("/nonexistent/bettergi-map").dispatch("map.locateBigMap", {}, self.big_map)


class SubpixelTest(unittest.TestCase):
    def test_original_quadratic_fit_and_small_result_error(self):
        y, x = np.indices((7, 8), dtype=np.float64)
        scores = 2 * (x - 3.25) ** 2 + 3 * (y - 2.6) ** 2 + .1 * (x - 3.25) * (y - 2.6)
        result = MapVision._subpixel(scores.astype(np.float32), (3, 3))
        np.testing.assert_allclose(result, [3.25, 2.6], atol=1e-6)
        self.assertEqual(MapVision._subpixel(np.ones((3, 3), np.float32), (1, 1)), (1, 1))
        with self.assertRaises(ValueError):
            MapVision._subpixel(np.zeros((2, 3), np.float32), (0, 0))


if __name__ == "__main__":
    unittest.main()
