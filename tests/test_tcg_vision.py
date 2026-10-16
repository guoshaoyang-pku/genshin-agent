"""Original TCG template/pixel algorithms and borrowed frame ownership."""
from pathlib import Path
import sys
import unittest
from unittest.mock import Mock

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from tcg_vision import ELEMENTS, UI_NAMES, TcgVision, character_rects, crop, iou
from vision import VisionBridge, load_recognition

PROJECT = Path(__file__).resolve().parents[1]
SOURCE = PROJECT / "third_party/bettergi/source/BetterGenshinImpact"
ASSETS = SOURCE / "GameTask/AutoGeniusInvokation/Assets"
AREAS = [[667, 632, 165, 282], [877, 632, 165, 282], [1088, 632, 165, 282]]


def frame():
    return np.zeros((1080, 1920, 3), np.uint8)


def paste(pixels, template, x, y):
    view = cv2.cvtColor(template, cv2.COLOR_GRAY2BGR) if template.ndim == 2 else template
    pixels[y:y + view.shape[0], x:x + view.shape[1]] = view


def projection_frame():
    pixels = frame()
    color = (215, 250, 245)
    for x in (667, 832, 877, 1042, 1088, 1253):
        pixels[632:914, x:x + 2] = color
    pixels[632:634, 667:1255] = color
    pixels[912:914, 667:1255] = color
    return pixels


class TcgPixelsTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge(PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model")
        self.tcg = TcgVision(self.bridge)

    def dispatch(self, op, pixels, **args):
        descriptor = self.bridge.put(pixels, "ImageRegion")
        original = pixels.copy()
        try:
            result = self.tcg.dispatch(op, dict(handle=descriptor["handle"], **args))
            np.testing.assert_array_equal(pixels, original)
            self.assertEqual(len(self.bridge.images), 1, "no new handles for borrowed screenshot")
            return result
        finally:
            self.bridge.dispatch("image.dispose", descriptor)

    def test_all_ten_original_ui_templates_match_inside_source_rois(self):
        for name in UI_NAMES:
            with self.subTest(name=name):
                pixels = frame()
                recognition = load_recognition(ASSETS / "Recognition.json", name, 1920, 1080)
                template = self.bridge.template(recognition)
                rx, ry, rw, rh = recognition.get("roi", [0, 0, 1920, 1080])
                x, y = rx + 3, ry + 3
                self.assertLessEqual(template.shape[1] + 3, rw)
                self.assertLessEqual(template.shape[0] + 3, rh)
                paste(pixels, template, x, y)
                found = self.dispatch("tcg.ui", pixels, names=[name])[name]
                self.assertEqual(tuple(found[k] for k in ("x", "y", "width", "height")),
                                 (x, y, template.shape[1], template.shape[0]))
                self.assertGreater(found["matchScore"], .99)
        self.assertEqual(self.bridge.images, {})

    def test_ui_roi_excludes_original_template_at_wrong_position(self):
        pixels = frame()
        recognition = load_recognition(ASSETS / "Recognition.json", "RoundEndButton", 1920, 1080)
        paste(pixels, self.bridge.template(recognition), 900, 200)
        self.assertIsNone(self.dispatch("tcg.ui", pixels, names=["RoundEndButton"])["RoundEndButton"])

    def test_all_eight_roll_templates_color_match_and_original4plus4layout(self):
        pixels = frame()
        expected = {}
        for index, element in enumerate(ELEMENTS):
            x, y = 300 + index % 4 * 300, 320 if index < 4 else 620
            paste(pixels, self.tcg._template(f"dice/roll_{element}.png", True), x, y)
            expected[element] = x, y
        result = self.dispatch("tcg.rollDice", pixels)
        self.assertEqual(result["counts"], dict.fromkeys(ELEMENTS, 1))
        self.assertEqual((result["total"], result["upper"], result["lower"]), (8, 4, 4))
        self.assertEqual({match["element"]: (match["x"], match["y"]) for match in result["matches"]}, expected)

    def test_all_eight_action_templates_search_right_fifth_and_return_fullframe_positions(self):
        pixels = frame()
        for index, element in enumerate(ELEMENTS):
            paste(pixels, self.tcg._template(f"dice/action_{element}.png", True), 1700, 100 + 100 * index)
        paste(pixels, self.tcg._template("dice/action_omni.png", True), 700, 100)
        result = self.dispatch("tcg.actionDice", pixels, order=list(reversed(ELEMENTS)))
        self.assertEqual(result["counts"], dict.fromkeys(reversed(ELEMENTS), 1))
        self.assertEqual(result["total"], 8)
        self.assertTrue(all(match["x"] == 1700 for match in result["matches"]))

    def test_cross_template_nms_deduplicates_identical_assets_with_stable_order(self):
        template = self.tcg._template("dice/roll_hydro.png", True)
        self.tcg._template = Mock(return_value=template)
        pixels = frame()
        paste(pixels, template, 500, 300)
        result = self.dispatch("tcg.rollDice", pixels, order=list(reversed(ELEMENTS)))
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["matches"][0]["element"], "omni")
        self.assertEqual(result["counts"]["omni"], 1)
        self.assertEqual(iou((0, 0, 10, 10), (0, 0, 10, 10)), 1)
        self.assertEqual(iou((0, 0, 10, 10), (10, 0, 10, 10)), 0)

    def test_rgb_card_projection_preserves_original_thresholds_and_six_starts(self):
        pixels = projection_frame()
        result = self.dispatch("tcg.characterRects", pixels)
        self.assertEqual([list(region.values()) for region in result["rects"]], AREAS)
        self.assertEqual(result["method"], "originalRgbProjection")
        self.assertEqual(character_rects(frame())["reason"], "horizontalProjection")
        invalid = pixels.copy()
        invalid[632:914, 667:669] = 0
        self.assertEqual(character_rects(invalid)["reason"], "verticalProjection")
        wrong_channels = pixels[:, :, ::-1].copy()
        self.assertEqual(character_rects(wrong_channels)["rects"], [])

    def test_defeated_template_overlaps_only_corresponding_cards(self):
        pixels = frame()
        template = self.tcg._template("other/角色被打败.png")
        paste(pixels, template, 690, 700)
        paste(pixels, template, 1130, 750)
        result = self.dispatch("tcg.defeated", pixels, rects=AREAS)
        self.assertEqual(result["defeated"], [True, False, True])
        self.assertEqual(len(result["matches"]), 2)

    def test_active_hp_uses_detector_crops_and_status_energy_original_assets(self):
        pixels = frame()
        for name, x, y in (("角色状态_冻结.png", 910, 710), ("角色状态_水泡.png", 950, 710),
                           ("满能量.png", 1000, 700), ("满能量.png", 1000, 750)):
            paste(pixels, self.tcg._template("other/" + name), x, y)
        ocr = Mock()
        ocr.run.side_effect = [[dict(text="8")], [], [dict(text="10")]]
        self.bridge.ocr_engine = ocr
        result = self.dispatch("tcg.activeHp", pixels, rects=AREAS, defeated=[False] * 3, activeCharacterCardSpace=41)
        self.assertEqual((result["index"], result["hp"], result["energy"]), (2, 10, 2))
        self.assertEqual(result["statuses"], ["Frozen", "Frozen"])
        self.assertEqual(result["statusTemplates"], ["角色状态_冻结.png", "角色状态_水泡.png"])
        self.assertEqual(result["method"], "hpOcr")
        expected = [pixels[632:687, 647:707], pixels[632:687, 857:917], pixels[591:646, 857:917]]
        for call, view in zip(ocr.run.call_args_list, expected):
            np.testing.assert_array_equal(call.args[0], view)

    def test_active_hp_exclusion_treats_defeated_as_inactive_and_keeps_unknown_hp(self):
        ocr = Mock()
        ocr.run.side_effect = [[], [], [dict(text="8")]]
        self.bridge.ocr_engine = ocr
        result = self.dispatch("tcg.activeHp", frame(), rects=AREAS, defeated=[True, False, False])
        self.assertEqual(result["index"], 2)
        self.assertEqual(result["method"], "hpExclusion")
        self.assertEqual(result["hp"], -2)
        self.assertEqual(result["hpArray"], [1, 0, 1])
        self.assertEqual(ocr.run.call_count, 3)

    def test_hp_requires_full_ascii_number_but_any_nonempty_text_marks_active(self):
        for text in (" 8", "８", "8\n", "8x"):
            with self.subTest(text=text):
                ocr = Mock()
                ocr.run.side_effect = [[], [dict(text=text)]]
                self.bridge.ocr_engine = ocr
                result = self.dispatch("tcg.activeHp", frame(), rects=AREAS)
                self.assertEqual(result["index"], 1)
                self.assertEqual(result["hp"], -2)

    def test_hp_unresolved_and_white_word_fallback_follow_source_geometry(self):
        self.bridge.ocr_engine = Mock()
        self.bridge.ocr_engine.run.return_value = []
        self.assertIsNone(self.dispatch("tcg.activeHp", frame(), rects=AREAS)["index"])
        pixels = frame()
        pixels[615:623, 880:890] = 255
        result = self.dispatch("tcg.activeWord", pixels, rects=AREAS)
        self.assertEqual(result["index"], 2)
        self.assertEqual(result["method"], "whiteHpWord")
        self.assertEqual(result["hp"], -2)
        self.assertLess(result["wordRect"][1], AREAS[1][1])
        self.assertIsNone(self.dispatch("tcg.activeWord", frame(), rects=AREAS)["index"])

    def test_status_origin_sentinel_matches_original_and_crops_clamp(self):
        pixels = frame()
        paste(pixels, self.tcg._template("other/角色状态_冻结.png"), AREAS[0][0], AREAS[0][1])
        self.assertEqual(self.tcg._status(pixels, AREAS[0])["statuses"], [])
        self.tcg._status(pixels, (1900, 1060, 20, 20))
        with self.assertRaises(ValueError):
            crop(pixels, (-1, 0, 10, 10))
        self.assertEqual(crop(pixels, (-1, 0, 10, 10), True).shape, (10, 9, 3))

    def test_dice_ocr_uses_fixed_gray_no_detector_crop_and_exact_circled_replacements(self):
        pixels = np.arange(1080 * 1920 * 3, dtype=np.uint8).reshape((1080, 1920, 3))
        ocr = Mock()
        self.bridge.ocr_engine = ocr
        for raw, expected in [(" ⑧ ", 8), ("⑮", 15), ("⑩", 10), ("", -10), ("8\n", -10), ("８", -10), ("8/", -10)]:
            ocr.recognize.return_value = raw, .98
            result = self.dispatch("tcg.diceCount", pixels)
            self.assertEqual(result["count"], expected)
            self.assertEqual(result["raw"], raw)
            np.testing.assert_array_equal(ocr.recognize.call_args.args[0], cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)[642:673, 68:93])
        ocr.run.assert_not_called()

    def test_real_original_paddle_recognizer_reads_synthetic_fixed_dice_crop(self):
        pixels = frame()
        pixels[642:673, 68:93] = 255
        cv2.putText(pixels, "8", (72, 667), cv2.FONT_HERSHEY_SIMPLEX, .8, (0, 0, 0), 2, cv2.LINE_AA)
        result = self.dispatch("tcg.diceCount", pixels)
        self.assertEqual(result["count"], 8)
        self.assertGreater(result["score"], .9)

    def test_strict_resolution_unknown_operation_and_invalid_orders_fail_without_disposal(self):
        descriptor = self.bridge.put(np.zeros((720, 1280, 3), np.uint8))
        with self.assertRaisesRegex(ValueError, "1920x1080"):
            self.tcg.dispatch("tcg.rollDice", descriptor)
        self.assertEqual(len(self.bridge.images), 1)
        self.bridge.dispatch("image.dispose", descriptor)
        for op, args in (("tcg.fake", {"rects": AREAS}), ("tcg.ui", {"names": ["Invented"]}),
                         ("tcg.rollDice", {"order": ["omni"] * 8}), ("tcg.activeHp", {"rects": []})):
            with self.assertRaises((ValueError, NotImplementedError)):
                self.dispatch(op, frame(), **args)
        self.assertEqual(self.bridge.images, {})


if __name__ == "__main__":
    unittest.main()
