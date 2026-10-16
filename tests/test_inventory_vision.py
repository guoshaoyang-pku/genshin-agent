"""Source grid/count behavior and original-model execution; no live inventory claim."""
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from inventory_vision import (InventoryVision, cells_cluster, correct_bottom_color, grid_items,
                              grid_params, mode_name, page_name, post_process,
                              recognize_count, scrolling, strict_count)
from vision import VisionBridge

PROJECT = Path(__file__).resolve().parents[1]
MODELS = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"
COLOR = (220, 229, 233)


def card(text=None):
    image = np.full((153, 125, 3), COLOR, np.uint8)
    if text:
        cv2.putText(image, text, (8, 147), cv2.FONT_HERSHEY_SIMPLEX, .55, (60, 60, 60), 1, cv2.LINE_AA)
    return image


def numeric_component(width=3):
    image = card()
    image[133:148, 50:50 + width] = 60
    return image


class InventoryGridTest(unittest.TestCase):
    def test_page_enum_descriptions_and_original_integer_truncation(self):
        self.assertEqual(page_name(0), "Weapons")
        self.assertEqual(page_name("食物"), "Food")
        self.assertEqual(page_name("materials"), "Materials")
        self.assertEqual(grid_params("Weapons", 1280, 720)["roi"], dict(x=70, y=73, width=780, height=563))
        self.assertEqual(grid_params("Weapons", 1920, 720)["roi"], dict(x=70, y=73, width=780, height=563))
        self.assertEqual(grid_params("Weapons", 3840, 2160)["roi"], dict(x=106, y=110, width=1171, height=845))
        self.assertEqual(grid_params("Artifacts", 1920, 1080)["roi"]["y"], 162)
        self.assertEqual(grid_params("ArtifactSalvage", 1920, 1080)["columns"], 9)
        self.assertEqual(grid_params("Crafting", 1920, 1080)["columns"], 5)
        self.assertEqual(grid_params("PartySetupCharacters", 1920, 1080)["s2Round"], 28)
        for bad in [True, -1, 14, "bad"]:
            with self.assertRaises(ValueError): page_name(bad)
        with self.assertRaises(ValueError): grid_params("ArtifactSetFilter", 1920, 1080)
        for value, name in [(0, "GridIcon"), (1, "Item"), ("Item", "Item")]:
            self.assertEqual(mode_name(value), name)
        with self.assertRaises(ValueError): mode_name(True)

    def test_real_cv_contours_and_row_major_postprocessing(self):
        image = np.zeros((360, 350, 3), np.uint8)
        for y in [20, 140]:
            for x in [20, 130, 240]: cv2.rectangle(image, (x, y), (x + 80, y + 99), COLOR, -1)
        for alpha in [False, True]:
            raw = grid_items(image, 3, alpha)
            self.assertEqual(len(raw), 6)
            cells = post_process(image, raw, 9)
            self.assertEqual([(c["rowNum"], c["colNum"]) for c in cells], [(r, c) for r in range(2) for c in range(3)])
            self.assertTrue(all(not cell["isPhantom"] for cell in cells))

    def test_cluster_uses_consecutive_gap_and_float32_even_rounding(self):
        cells = cells_cluster([(0, 0, 10, 20), (15, 30, 10, 20), (60, 120, 10, 20)], 5)
        self.assertEqual([c["colNum"] for c in cells], [0, 1, 4])
        self.assertEqual([c["rowNum"] for c in cells], [0, 1, 5])
        ties = cells_cluster([(0, 0, 10, 20), (22, 0, 10, 20)], 1)
        self.assertEqual(ties[1]["colNum"], 2)

    def test_missing_cells_and_extra_bottom_row_need_original_bottom_color(self):
        image = np.zeros((360, 350, 3), np.uint8)
        rects = [(20, 10, 81, 100), (130, 10, 81, 100), (240, 10, 81, 100),
                 (20, 130, 81, 100), (240, 130, 81, 100)]
        for y in [10, 130, 250]:
            for x in [20, 130, 240]: image[y:y + 100, x:x + 81] = COLOR
        cells = post_process(image, rects, 9)
        self.assertEqual(len(cells), 9)
        self.assertEqual(sum(c["isPhantom"] for c in cells), 4)
        image[250:] = 0
        cells = post_process(image, rects, 9)
        self.assertEqual(len(cells), 6)
        self.assertEqual([c["colNum"] for c in cells if c["isPhantom"]], [1])

    def test_oversized_selected_cell_normalization_uses_away_from_zero(self):
        image = np.full((220, 400, 3), COLOR, np.uint8)
        rects = [(20, 10, 81, 100), (130, 10, 81, 100), (238, 8, 86, 105)]
        cells = post_process(image, rects, 10)
        self.assertEqual(cells[-1]["rect"], [241, 11, 81, 100])

    def test_bottom_color_ignores_text_rectangle_and_inclusive_tolerance(self):
        image = np.full((27, 125, 3), COLOR, np.uint8)
        image[:21, 6:119] = 0
        self.assertTrue(correct_bottom_color(image))
        image[:] = np.array(COLOR) - 29
        self.assertTrue(correct_bottom_color(image))
        with patch("inventory_vision.cv2.mean", return_value=(190., 199., 203., 0.)):
            self.assertTrue(correct_bottom_color(image))
        image[:] = np.array(COLOR) - 31
        self.assertFalse(correct_bottom_color(image))
        with self.assertRaises(ValueError): correct_bottom_color(np.empty((0, 0, 3), np.uint8))

    def test_no_grid_does_not_invent_cells(self):
        image = np.zeros((360, 350, 3), np.uint8)
        self.assertEqual(grid_items(image, 8), [])
        self.assertEqual(post_process(image, [], 10), [])

    def test_phase_correlation_shift_bounds_and_same_frame(self):
        rng = np.random.default_rng(5)
        image = rng.integers(0, 256, (128, 128, 3), np.uint8)
        moved = np.zeros_like(image); moved[10:] = image[:-10]
        result = scrolling(image, moved, .5, .99)
        self.assertTrue(result["isScrolling"])
        self.assertAlmostEqual(result["shift"]["y"], 10, delta=.2)
        self.assertFalse(scrolling(image, image)["isScrolling"])
        self.assertFalse(scrolling(image, np.zeros_like(image))["isScrolling"])
        with patch("inventory_vision.cv2.phaseCorrelate", return_value=((0, 0), .5)):
            self.assertFalse(scrolling(image, image)["isScrolling"])
        with patch("inventory_vision.cv2.phaseCorrelate", return_value=((0, 0), .95)):
            self.assertFalse(scrolling(image, image)["isScrolling"])


class InventoryCountTest(unittest.TestCase):
    def test_strict_fullwidth_whitespace_and_int32_boundary(self):
        for text, count in [(" １２３４\n", 1234), ("0001", 1), ("2147483647", 2147483647), ("0", 0)]:
            self.assertEqual(strict_count(text), count)
        for text in ["", "1 2", "1.0", "-1", "+1", "2147483648", "一", "١"]:
            self.assertIsNone(strict_count(text))

    def test_empty_foreground_skips_ocr(self):
        recognize = Mock(side_effect=AssertionError("must not OCR empty"))
        result = recognize_count(card(), recognize)
        self.assertEqual(result, dict(count=-2, rawText="", reason="EMPTY", componentCount=0, foregroundBounds=dict(x=0, y=0, width=0, height=0)))
        recognize.assert_not_called()

    def test_normalization_and_detector_free_recognition(self):
        observed = []
        result = recognize_count(card("1850"), lambda image: (observed.append(image.copy()) or "１８５０", .9))
        self.assertEqual(result["count"], 1850)
        self.assertEqual(result["rawText"], "１８５０")
        self.assertIsNone(result["reason"])
        self.assertEqual(observed[0].shape[0], 60)
        self.assertTrue(np.all(observed[0][:6] == 255))
        self.assertTrue(np.all(observed[0][:, :24] == 255))
        self.assertEqual(observed[0].ndim, 2)

    def test_narrow_one_corrects_bad_parse_and_zero_padding(self):
        for raw in ["", "10", "0", "not a number"]:
            result = recognize_count(numeric_component(3), lambda _: raw)
            self.assertEqual(result["count"], 1)
            self.assertEqual(result["reason"], "NARROW_ONE")
        result = recognize_count(numeric_component(3), lambda _: "1")
        self.assertIsNone(result["reason"])

    def test_wide_one_correction_and_parse_failure(self):
        result = recognize_count(numeric_component(12), lambda _: "１")
        self.assertEqual(result["count"], 7)
        self.assertEqual(result["reason"], "WIDE_SEVEN")
        result = recognize_count(numeric_component(12), lambda _: "12x")
        self.assertEqual(result["count"], -2)
        self.assertEqual(result["reason"], "PARSE")

    def test_ocr_exception_propagates_without_bridge_handle_allocation(self):
        with self.assertRaisesRegex(RuntimeError, "ocr error"):
            recognize_count(card("1234"), Mock(side_effect=RuntimeError("ocr error")))


class InventoryBridgeTest(unittest.TestCase):
    def test_food_item_text_uses_original_double_resize_without_count_corrections(self):
        bridge = VisionBridge(MODELS)
        pixels = card('12')
        descriptor = bridge.put(pixels)
        observed = []
        ocr = Mock()
        ocr.recognize.side_effect = lambda image: (observed.append(image.copy()) or '１２')
        with patch.object(bridge, 'ocr', return_value=ocr):
            result = bridge.dispatch('inventory.itemText', {'handle': descriptor['handle'], 'rect': [0, 0, 125, 153]})
        self.assertEqual(result, {'text': '１２'})
        self.assertEqual(observed[0].shape[:2], (44, 230))
        self.assertTrue(np.array_equal(observed[0], cv2.resize(pixels[128:150, 5:120], (230, 44))))

    def setUp(self):
        self.bridge = VisionBridge(MODELS)
        self.inventory = InventoryVision(self.bridge)

    def test_original_metadata_page_grouping_last_variant_sort_and_hash(self):
        result = self.inventory.dispatch("inventory.metadata", dict(names=["苹果", "日落果", "精锻用魔矿", "甜甜花", "missing"]))
        self.assertEqual(result["entryCount"], 2577)
        self.assertEqual(result["entries"][0], dict(name="苹果", page="Food", pageIndex=3, sortOrder=1))
        self.assertEqual(result["entries"][2]["page"], "Weapons")
        self.assertIsNone(result["entries"][2]["sortOrder"])
        self.assertEqual(result["missing"], ["missing"])
        self.assertEqual(result["table"]["sha256"], "3c8b07777f0129003d770c1e022dbe77da00237519dda979139652189cf25e6c")

    def test_metadata_tolerates_missing_file_like_upstream(self):
        self.inventory.table = PROJECT / "missing-inventory-table.csv"
        result = self.inventory.metadata(["苹果"])
        self.assertEqual(result["entries"], [])
        self.assertEqual(result["missing"], ["苹果"])
        self.assertIsNotNone(result["error"])

    def test_metadata_csv_header_case_duplicates_and_invalid_page_sort(self):
        with tempfile.TemporaryDirectory() as directory:
            table = Path(directory) / "item.csv"
            table.write_text(' ITEM_NAME ,PAGE,SORT_ORDER\n苹果,食物,1\n苹果,食物,22\n错误,unknown,1\n溢出,材料,2147483648\n', encoding="utf-8")
            self.inventory.table = table
            result = self.inventory.metadata()
            self.assertEqual(result["entries"], [dict(name="苹果", page="Food", pageIndex=3, sortOrder=22), dict(name="溢出", page="Materials", pageIndex=4, sortOrder=None)])

    def test_grid_bridge_actual_global_coordinates_and_no_new_handles(self):
        image = np.zeros((500, 500, 3), np.uint8)
        cv2.rectangle(image, (40, 60), (120, 159), COLOR, -1)
        frame = self.bridge.put(image, global_x=10, global_y=20)
        result = self.inventory.dispatch("inventory.grid", dict(handle=frame["handle"], page="Weapons", roi=dict(x=20, y=40, width=350, height=360), columns=3))
        self.assertEqual(result["roi"], dict(x=30, y=60, width=350, height=360))
        self.assertEqual(result["cells"][0]["rect"], dict(x=49, y=79, width=82, height=101))
        self.assertEqual(len(self.bridge.images), 1)
        raw = self.inventory.dispatch("inventory.grid", dict(handle=frame["handle"], page="Weapons", roi=dict(x=20, y=40, width=350, height=360), columns=3, postProcess=False))
        self.assertEqual(raw["cells"], [])
        self.assertEqual(len(raw["rawRects"]), 1)

    def test_item_crop_original_resize_then_top_and_count_not_called_unless_requested(self):
        image = np.zeros((300, 300, 3), np.uint8)
        image[100:253, 50:175] = card("1850")
        frame = self.bridge.put(image, global_x=10, global_y=20)
        recognizer = Mock()
        recognizer.recognize.return_value = dict(name="苹果", candidateName="苹果", score=.9, scoreKind="cosine", qualityLevel=-1)
        self.inventory.recognizers["Item"] = recognizer
        self.bridge.ocr_engine = Mock()
        self.bridge.ocr_engine.recognize.return_value = ("1850", .9)
        args = dict(handle=frame["handle"], rect=dict(x=60, y=120, width=125, height=153))
        result = self.inventory.dispatch("inventory.item", args)
        self.assertEqual(result["rect"], args["rect"])
        np.testing.assert_array_equal(recognizer.recognize.call_args.args[0], image[100:225, 50:175])
        self.bridge.ocr_engine.recognize.assert_not_called()
        result = self.inventory.dispatch("inventory.item", dict(args, readCount=True))
        self.assertEqual(result["count"], 1850)
        self.assertEqual(len(self.bridge.images), 1)
        self.inventory.dispatch("inventory.release", dict(mode=1))
        self.assertEqual(self.inventory.recognizers, {})

    def test_original_paddle_counts_synthetic_multidigit_card(self):
        for text in ["1850", "1234", "7"]:
            with self.subTest(text=text):
                frame = self.bridge.put(card(text))
                result = self.inventory.dispatch("inventory.count", dict(handle=frame["handle"]))
                self.assertEqual(result["count"], int(text))
                self.assertEqual(result["rawText"], text)
                self.bridge.dispatch("image.dispose", dict(handle=frame["handle"]))
        self.assertEqual(len(self.bridge.images), 0)

    def test_original_item_modes_execute_and_release_real_sessions(self):
        frame = self.bridge.put(card())
        expected = {"Item": (3617, "637b5179efae1eda1c575c4da1840bd1e6f6cc20613dac58728239cb6b9fd87f"),
                    "GridIcon": (918, "ac56acadfe8b8ffdf2bfeac2c3b56415d2aa2c51c2d4f9c4264ef2f40de8cd18")}
        for mode, (count, sha) in expected.items():
            with self.subTest(mode=mode):
                status = self.inventory.dispatch("inventory.modelStatus", dict(mode=mode))
                self.assertEqual(status["prototypes"], count)
                self.assertEqual(status["files"][0]["sha256"], sha)
                result = self.inventory.dispatch("inventory.item", dict(handle=frame["handle"], mode=mode))
                self.assertIsInstance(result["candidateName"], str)
                self.assertTrue(np.isfinite(result["score"]))
                self.inventory.dispatch("inventory.release", dict(mode=mode))
        self.assertEqual(self.inventory.recognizers, {})


if __name__ == "__main__":
    unittest.main()
