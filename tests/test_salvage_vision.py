"""Source-based salvage pixels, OCR parsing, real models, and session cleanup."""
from pathlib import Path
import sys
import unittest
import weakref
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from salvage_vision import (SalvageVision, artifact_status, metadata, parse_number,
                            recognize_artifact, set_grid_cells, set_grid_rects,
                            set_icon, set_params, unactivated)
from vision import VisionBridge

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "third_party/bettergi/source"
MODELS = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"


def region(text, x=0, y=0, width=100, height=12, score=.9):
    return dict(text=text, rect=[x, y, width, height], score=score)


def ocr_rows(main=None, minors=None, name="测试圣遗物"):
    return [[region(name)], [region("生之花")],
            main if main is not None else [region("攻击力", y=0), region("46.6%", y=25)],
            minors if minors is not None else [region("+20"), region("攻击力+19", y=25), region("防御力+23", y=50)]]


def parse(rows, pixels=None, culture=None):
    ocr = Mock(side_effect=rows)
    result = recognize_artifact(np.zeros((540, 528, 3), np.uint8) if pixels is None else pixels,
                                ocr, metadata(SOURCE, culture)["affixLabels"], culture)
    return result, ocr


def hsv_color(hue, saturation):
    hsv = np.uint8([[[round(hue / 255 * 180), round(saturation * 255), 255]]])
    return cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR_FULL)[0, 0]


class StatusTests(unittest.TestCase):
    def test_none_locked_selected_and_locked_priority(self):
        image = np.zeros((153, 125, 3), np.uint8)
        self.assertEqual(artifact_status(image)["statusName"], "None")
        image[2:27, 85:125] = hsv_color(80, .76)
        self.assertEqual(artifact_status(image)["statusName"], "Selected")
        image[2:16, 5:17] = hsv_color(9, .54)
        self.assertEqual(artifact_status(image)["statusName"], "Locked")
        image[:, 5:17] = 0
        image[30:50, 5:17] = hsv_color(9, .54)
        self.assertEqual(artifact_status(image)["statusName"], "Selected")

    def test_lock_all_points_must_be_left_and_small_or_thin_marks_do_not_select(self):
        image = np.zeros((100, 100, 3), np.uint8)
        image[0:10, 12:21] = hsv_color(9, .54)
        self.assertEqual(artifact_status(image)["status"], 0)
        image[:] = 0
        image[0:6, 2:9] = hsv_color(9, .54)
        self.assertEqual(artifact_status(image)["status"], 0)
        image[:] = 0
        image[0:2, :] = hsv_color(80, .76)
        self.assertEqual(artifact_status(image)["status"], 0)
        image[0:16, 70:91] = hsv_color(80, .76)
        self.assertEqual(artifact_status(image)["status"], 2)

    def test_detached_pink_contours_are_combined_and_status_rect_has_global_offset(self):
        image = np.zeros((153, 125, 3), np.uint8)
        image[0:2, 2:4] = hsv_color(9, .54)
        image[14:16, 14:16] = hsv_color(9, .54)
        self.assertEqual(artifact_status(image)["statusName"], "Locked")
        bridge = VisionBridge(MODELS)
        frame = bridge.put(image, global_x=500, global_y=100)
        result = SalvageVision(bridge).dispatch("salvage.status", {"handle": frame["handle"], "rect": [500, 100, 125, 153]})
        self.assertEqual(result["rect"], dict(x=500, y=100, width=125, height=153))
        self.assertEqual(result["lockedBounds"], dict(x=2, y=0, width=14, height=16))


class OcrTests(unittest.TestCase):
    def test_original_resx_labels_culture_fallback_and_metadata(self):
        self.assertEqual(metadata(SOURCE)["strings"]["快速选择"], "快速选择")
        self.assertEqual(metadata(SOURCE, "en-US")["strings"]["快速选择"], "Quick.*Select")
        self.assertEqual(metadata(SOURCE, "fr-FR")["affixLabels"]["DEF"], "DÉF")
        self.assertEqual(metadata(SOURCE, "zh-TW")["affixLabels"]["ATK"], "攻擊力")
        self.assertEqual(metadata(SOURCE, "unknown")["affixLabels"]["ATK"], "攻击力")
        with self.assertRaises(ValueError):
            metadata(SOURCE, "../../en")

    def test_original_preprocessing_rects_tophat_and_float32_values(self):
        image = np.full((540, 528, 3), 60, np.uint8)
        image[140:146, 10:50] = 230
        result, ocr = parse(ocr_rows(), image)
        self.assertEqual([call.args[0].shape for call in ocr.call_args_list], [(57, 528), (57, 528), (162, 290), (259, 528)])
        main = image[118:280, :290, 0]
        expected = cv2.threshold(cv2.morphologyEx(main, cv2.MORPH_TOPHAT, np.ones((15, 15), np.uint8)), 30, 255, cv2.THRESH_BINARY)[1]
        np.testing.assert_array_equal(ocr.call_args_list[2].args[0], expected)
        self.assertEqual(result["artifact"]["MainAffix"], dict(Type="ATKPercent", Value=float(np.float32(46.6)), IsUnactivated=False))
        self.assertEqual(result["artifact"]["Level"], 20)
        self.assertEqual([a["Type"] for a in result["artifact"]["MinorAffixes"]], ["ATK", "DEF"])

    def test_strict_score_and_left_edge_filter_and_center_order(self):
        rows = ocr_rows(main=[region("46.6%", y=25), region("攻击力"), region("HP", y=60, score=.5)],
                        minors=[region("套装攻击力+15%", x=60, y=50), region("防御力+23", y=50), region("+0"), region("攻击力+19", y=25), region("生命值+200", y=70, score=.5)])
        result, _ = parse(rows)
        self.assertEqual([a["Type"] for a in result["artifact"]["MinorAffixes"]], ["ATK", "DEF"])
        self.assertNotIn("套装", result["allText"])
        self.assertNotIn("HP", result["allText"])
        self.assertEqual(result["allText"], "测试圣遗物\n生之花\n攻击力\n46.6%\n+0\n攻击力+19\n防御力+23")

    def test_duplicate_missing_and_unknown_fields_are_errors(self):
        cases = [ocr_rows(main=[region("攻击力"), region("防御力", y=15), region("19", y=30)]),
                 ocr_rows(main=[region("攻击力"), region("19", y=20), region("23", y=40)]),
                 ocr_rows(main=[region("ATK"), region("19", y=20)]),
                 ocr_rows(minors=[region("+0"), region("+20", y=20)]),
                 ocr_rows(minors=[region("+21")]), ocr_rows(minors=[region("+")]),
                 ocr_rows(minors=[region("+0"), region("未知+15", y=30)]),
                 ocr_rows(minors=[region("+0"), region("攻击力+", y=30)])]
        for rows in cases:
            with self.subTest(rows=rows), self.assertRaises(ValueError):
                parse(rows)

    def test_localized_culture_numeric_rules_and_only_minor_chinese_dot_normalization(self):
        rows = ocr_rows(main=[region("ATQ"), region("46,6%", y=20)], minors=[region("+20"), region("DÉF+23", y=25), region("PV+1 000", y=50)])
        result, _ = parse(rows, culture="fr-FR")
        self.assertEqual(result["artifact"]["MainAffix"]["Value"], float(np.float32(46.6)))
        self.assertEqual(result["artifact"]["MinorAffixes"][1]["Value"], 1000)
        result, _ = parse(ocr_rows(minors=[region("+0"), region("暴击率+3。9%", y=25)]))
        self.assertEqual(result["artifact"]["MinorAffixes"][0]["Value"], float(np.float32(3.9)))
        self.assertEqual(parse_number("1,234.5", "en-US"), 1234.5)
        self.assertEqual(parse_number("1.234,5", "it-IT"), 1234.5)
        for text in ["1 234", "1.2.3", "", "46。6", "４６.６", ",12"]:
            with self.subTest(text=text), self.assertRaises(ValueError):
                parse_number(text, "en-US")

    def test_unactivated_histogram_only_applies_from_fourth_parsed_minor(self):
        image = np.full((540, 528, 3), 222, np.uint8)
        minors = [region("+0")]
        for index, kind in enumerate(["攻击力", "防御力", "生命值", "暴击率"]):
            y = 25 + 25 * index
            minors.append(region(kind + "+10", y=y))
            image[280 + y:280 + y + 12, :20] = 152
        result, _ = parse(ocr_rows(minors=minors), image)
        self.assertEqual([a["IsUnactivated"] for a in result["artifact"]["MinorAffixes"]], [False, False, False, True])
        valid = np.full((10, 100), 222, np.uint8); valid[:, :20] = 152
        self.assertTrue(unactivated(valid))
        valid[:, 20:41] = 100
        self.assertFalse(unactivated(valid))


class SetGridTests(unittest.TestCase):
    def test_source_custom_scale_and_icon_crop_fixed_sixty_pixels(self):
        self.assertEqual(set_params(1920, 1080)["roi"], dict(x=40, y=100, width=1300, height=852))
        self.assertEqual(set_params(3840, 2160)["roi"], set_params(1920, 1080)["roi"])
        self.assertEqual(set_params(960, 540)["roi"], dict(x=20, y=50, width=650, height=426))
        image = np.zeros((70, 604, 3), np.uint8)
        image[:, :, 0] = np.arange(604, dtype=np.uint16)[None] % 256
        icon, rect = set_icon(image, 1)
        self.assertEqual(rect, (35, 5, 60, 60)); self.assertEqual(icon.shape, (125, 125, 3))
        icon, rect = set_icon(image[:35, :302], .5)
        self.assertEqual(rect, (2, 0, 60, 35)); self.assertEqual(icon.shape, (125, 125, 3))

    def test_contour_ratio_width_filters_and_missing_cell_fill_without_extra_row(self):
        image = np.zeros((400, 1300, 3), np.uint8)
        for x, y in [(10, 10), (670, 10), (10, 100)]:
            cv2.rectangle(image, (x, y), (x + 599, y + 69), (255, 255, 255), -1)
        cv2.rectangle(image, (900, 250), (1200, 300), (255, 255, 255), -1)
        rects = set_grid_rects(image)
        self.assertEqual(len(rects), 3)
        cells = set_grid_cells(rects)
        self.assertEqual(len(cells), 4)
        self.assertEqual([(c["rowNum"], c["colNum"]) for c in cells], [(0, 0), (0, 1), (1, 0), (1, 1)])
        self.assertEqual([c["isPhantom"] for c in cells], [False, False, False, True])
        self.assertEqual(set_grid_cells([]), [])

    def test_set_grid_global_coordinates_and_observation_allocates_no_handles(self):
        bridge = VisionBridge(MODELS); adapter = SalvageVision(bridge)
        image = np.zeros((1080, 1920, 3), np.uint8)
        cv2.rectangle(image, (50, 110), (649, 179), (255, 255, 255), -1)
        frame = bridge.put(image, global_x=500, global_y=300)
        result = adapter.dispatch("salvage.setGrid", dict(handle=frame["handle"]))
        self.assertEqual(result["roi"], dict(x=540, y=400, width=1300, height=852))
        self.assertEqual(result["cells"][0]["rect"]["x"], 549)
        self.assertEqual(len(bridge.images), 1)
        self.assertEqual(adapter.dispatch("salvage.setGrid", dict(handle=frame["handle"], postProcess=False))["cells"], [])


class ModelTests(unittest.TestCase):
    def test_sessions_are_task_scoped_and_released_without_touching_inventory(self):
        bridge = VisionBridge(MODELS); adapter = SalvageVision(bridge)
        model = Mock(); model.status.return_value = {"original": True}
        with patch("salvage_vision.OriginalItemRecognizer", return_value=model) as factory:
            first = adapter.dispatch("salvage.setCreate", {"mode": 1})
            second = adapter.dispatch("salvage.setCreate", {"mode": 0})
            self.assertNotEqual(first["session"], second["session"])
            self.assertEqual([call.args[1] for call in factory.call_args_list], ["Item", "GridIcon"])
        ref = weakref.ref(model)
        self.assertTrue(adapter.dispatch("salvage.setRelease", {"session": first["session"]})["released"])
        self.assertEqual(len(adapter.sessions), 1)
        self.assertTrue(adapter.dispatch("salvage.setRelease", {"session": second["session"]})["released"])
        self.assertFalse(adapter.dispatch("salvage.setRelease", {"session": second["session"]})["released"])
        self.assertIsNotNone(ref())

    def test_real_original_models_execute_set_crop_and_hashes_match(self):
        bridge = VisionBridge(MODELS); adapter = SalvageVision(bridge)
        frame = bridge.put(np.zeros((1080, 1920, 3), np.uint8))
        hashes = {"Item": "637b5179efae1eda1c575c4da1840bd1e6f6cc20613dac58728239cb6b9fd87f",
                  "GridIcon": "ac56acadfe8b8ffdf2bfeac2c3b56415d2aa2c51c2d4f9c4264ef2f40de8cd18"}
        for mode, digest in hashes.items():
            created = adapter.dispatch("salvage.setCreate", {"mode": mode})
            try:
                self.assertEqual(created["model"]["files"][0]["sha256"], digest)
                observed = adapter.dispatch("salvage.setIcon", dict(handle=frame["handle"], rect=[50, 110, 604, 70], session=created["session"]))
                self.assertEqual(observed["crop"], dict(x=35, y=5, width=60, height=60))
                self.assertTrue(np.isfinite(observed["score"]))
                self.assertIn(observed["scoreKind"], ["cosine", "squaredDistance"])
            finally:
                adapter.dispatch("salvage.setRelease", {"session": created["session"]})
        self.assertEqual(len(adapter.sessions), 0)

    def test_real_paddle_detection_preprocessing_and_localized_stat_parse(self):
        bridge = VisionBridge(MODELS)
        card = np.full((540, 528, 3), 60, np.uint8)
        for text, y in [("TEST", 35), ("Flower", 85), ("ATK", 145), ("46.6%", 195), ("+20", 315), ("ATK+19", 355), ("DEF+23", 395)]:
            cv2.putText(card, text, (5, y), cv2.FONT_HERSHEY_SIMPLEX, .8, (240, 240, 240), 2, cv2.LINE_AA)
        result = recognize_artifact(card, bridge.ocr().run, metadata(SOURCE, "en-US")["affixLabels"], "en-US")
        self.assertEqual(result["artifact"]["MainAffix"]["Type"], "ATKPercent")
        self.assertEqual(result["artifact"]["Level"], 20)
        self.assertEqual([a["Type"] for a in result["artifact"]["MinorAffixes"]], ["ATK", "DEF"])


if __name__ == "__main__":
    unittest.main()
