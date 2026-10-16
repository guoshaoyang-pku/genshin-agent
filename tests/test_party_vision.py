"""BetterGI source thresholds, original assets and observation-only party vision."""

from pathlib import Path
import hashlib
import sys
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from party_vision import (PartyVision, DAMAGE_COLORS, active_by_color, active_context, asset_geometry,
                          box, crop, damage_color, damage_ocr, dynamic_layout, fixed_layout,
                          feature_probability, feature_score, image_feature_score, is_white_rect, most_different,
                          multi_status, skill_cd_number, system_scale, white_edge_ratio)
from vision import VisionBridge, load_recognition

PROJECT = Path(__file__).resolve().parents[1]
ROOT = PROJECT / "third_party/bettergi/source/BetterGenshinImpact"
MODELS = PROJECT / "third_party/bettergi/assets/bettergi.assets.model/Assets/Model"


def frame(width=1920, height=1080):
    return np.zeros((height, width, 3), np.uint8)


def prediction(name, confidence):
    return [{"name": {"id": 0, "name": name}, "confidence": confidence}]


class PartyLayoutTest(unittest.TestCase):
    def test_multiplayer_source_limits_host_and_guest(self):
        self.assertEqual(multi_status()["maxControlAvatarCount"], 4)
        self.assertEqual(multi_status(one_p=True), dict(isInMultiGame=True, isHost=True, playerCount=1, maxControlAvatarCount=4))
        for host, counts in ((True, (4, 2, 2, 1)), (False, (None, 2, 1, 1))):
            for players, expected in enumerate(counts, 1):
                if expected is None:
                    with self.assertRaises(ValueError):
                        multi_status(dict(isInMultiGame=True, isHost=host, playerCount=players))
                else:
                    self.assertEqual(multi_status(dict(isInMultiGame=True, isHost=host, playerCount=players))["maxControlAvatarCount"], expected)
        with self.assertRaises(ValueError):
            multi_status(peer_count=4)

    def test_capture_assets_and_system_scale_preserve_source_difference(self):
        assets = asset_geometry(1280, 720)
        self.assertEqual(assets["avatarIndexRects"][0], box(1240, 170, 18, 16))
        self.assertEqual(assets["eCooldownRect"], box(1120, 656, 27, 12))
        self.assertEqual(assets["zCooldownRect"], box(1194, 542, 40, 16))
        self.assertEqual(assets["gadgetRect"], box(1192, 533, 40, 33))
        self.assertEqual(assets["multiplayerIndexRects"]["1p_3"][0]["y"], 306)
        wide = asset_geometry(1920, 720)
        self.assertEqual(wide["assetScale"], 1)
        self.assertAlmostEqual(wide["systemScale"], 2 / 3)
        self.assertEqual(wide["avatarIndexRects"][0]["y"], 256)
        self.assertEqual(asset_geometry(2560, 1440)["avatarIndexRects"][0], box(2499, 256, 28, 24))

    def test_dynamic_all_recognized_returns_source_order_even_noncontiguous(self):
        indexes = [None, box(1800, 350, 16, 17), None, box(1800, 542, 16, 17)]
        status = multi_status(dict(isInMultiGame=True, isHost=True, playerCount=2))
        result, icons = dynamic_layout(indexes, None, status, 1)
        self.assertEqual(result, [indexes[1], indexes[3]])
        self.assertEqual(icons[0], box(1709, 303, 82, 82))
        self.assertIsNone(indexes[0])

    def test_dynamic_arrow_predicts_missing_active_and_trailing_missing_allowed(self):
        indexes = [box(1800, 256, 16, 17), None, box(1800, 448, 16, 17), None]
        result, _ = dynamic_layout(indexes, box(1700, 350, 40, 20), multi_status(), 1)
        self.assertEqual(result, [indexes[0], box(1800, 352, 16, 17), indexes[2]])
        self.assertIsNone(indexes[1])
        with self.assertRaisesRegex(ValueError, "不是连续"):
            dynamic_layout(indexes, box(1700, 331, 40, 21), multi_status(), 1)
        with self.assertRaises(ValueError):
            dynamic_layout(indexes, None, multi_status(), 1)

    def test_arrow_only_single_avatar_and_fractional_scale_truncation(self):
        indexes, icons = dynamic_layout([None] * 4, box(900, 335, 10, 10), multi_status(), 2 / 3)
        self.assertEqual(indexes, [box(984, 206, 10, 11)])
        self.assertEqual(icons, [box(924, 175, 54, 54)])

    def test_fixed_solo_offset_uses_exact_three_whites_and_unscaled14pixels(self):
        pixels = frame(1280, 720)
        original = asset_geometry(1280, 720)["avatarIndexRects"]
        for r in original[:2]:
            pixels[r["y"] - 5, r["x"] + 2] = 255
        r = original[2]
        pixels[r["y"] - 5, r["x"] + 2] = (255, 255, 254)
        self.assertFalse(fixed_layout(pixels, multi_status())[2])
        pixels[r["y"] - 5, r["x"] + 2] = 255
        indexes, icons, corrected = fixed_layout(pixels, multi_status())
        self.assertTrue(corrected)
        self.assertEqual(indexes[0]["y"], original[0]["y"] - 14)
        self.assertEqual(icons[0]["y"], 150 - 14)
        self.assertEqual(original[0]["y"], 170)

    def test_fixed_multiplayer_uses_original_asymmetric_layouts(self):
        pixels = frame()
        guest = multi_status(dict(isInMultiGame=True, isHost=False, playerCount=3))
        indexes, icons, corrected = fixed_layout(pixels, guest)
        self.assertEqual(indexes, [box(1859, 412, 28, 24)])
        self.assertEqual(icons, [box(1765, 475, 76, 76)])
        self.assertFalse(corrected)
        with self.assertRaises(KeyError):
            # Source has no fixed-layout1p_1 entry; dynamic lookup is necessary.
            fixed_layout(pixels, multi_status(one_p=True))

    def test_original_index_templates_and_json_drive_full_layout(self):
        bridge = VisionBridge()
        pixels = frame()
        for i, y in enumerate((240, 336, 432, 528), 1):
            rec = load_recognition(ROOT / "GameTask/Common/Element/Assets/Recognition.json", "Index" + str(i), 1920, 1080)
            template = bridge.template(rec)
            pixels[y:y + template.shape[0], 1858:1858 + template.shape[1]] = template
        handle = bridge.put(pixels, "ImageRegion")
        result = PartyVision(bridge).layout(bridge.image(handle), {})
        self.assertEqual(result["layoutMethod"], "dynamic")
        self.assertEqual(result["recognizedIndexCount"], 4)
        self.assertEqual([r["y"] for r in result["indexRects"]], [240, 336, 432, 528])
        self.assertEqual(result["sideIconRects"][0]["x"], 1767)
        self.assertEqual(len(bridge.images), 1)

    def test_original_peer_and_host_templates_determine_multiplayer(self):
        bridge = VisionBridge()
        pixels = frame()
        p = cv2.imread(str(ROOT / "GameTask/AutoFight/Assets/1920x1080/p.png"))
        one = cv2.imread(str(ROOT / "GameTask/AutoFight/Assets/1920x1080/1p.png"))
        pixels[60:60 + one.shape[0], 100:100 + one.shape[1]] = one
        for y in (240, 336):
            pixels[y:y + p.shape[0], 1800:1800 + p.shape[1]] = p
        handle = bridge.put(pixels, "ImageRegion")
        result = PartyVision(bridge).layout(bridge.image(handle))
        self.assertEqual(result["multiGameStatus"], dict(isInMultiGame=True, isHost=True, playerCount=3, maxControlAvatarCount=2))
        self.assertEqual(result["layoutMethod"], "fixed")
        self.assertEqual(result["indexRects"][0]["y"], 459)


class ActiveAvatarTest(unittest.TestCase):
    def test_white_threshold_combines_inclusive_ranges_and_strict35percent(self):
        image = np.zeros((10, 10), np.uint8)
        image.ravel()[:20] = 251
        image.ravel()[20:35] = 54
        self.assertFalse(is_white_rect(image))
        image.ravel()[35] = 50
        self.assertTrue(is_white_rect(image))
        image.ravel()[35] = 55
        self.assertFalse(is_white_rect(image))

    def test_white_edge_source_exact255_and_degenerate_denominator(self):
        self.assertEqual(white_edge_ratio(np.full((3, 5), 255, np.uint8)), 1)
        self.assertEqual(white_edge_ratio(np.full((3, 5), 254, np.uint8)), 0)
        self.assertEqual(white_edge_ratio(np.full((1, 3), 255, np.uint8)), .75)
        self.assertEqual(white_edge_ratio(np.full((3, 1), 255, np.uint8)), .75)
        self.assertEqual(white_edge_ratio(np.full((1, 1), 255, np.uint8)), 0)

    def test_color_selects_sole_nonwhite(self):
        pixels = np.full((12, 50), 255, np.uint8)
        indexes = [box(i * 12, 0, 10, 10) for i in range(4)]
        pixels[:10, 24:34] = 100
        self.assertEqual(active_by_color(pixels, indexes), 3)
        self.assertEqual(active_by_color(np.zeros((1, 1), np.uint8), [box(999, 999, 1, 1)]), 1)

    def test_edge_fallback_and_allwhite_returns_last_without_exact50(self):
        indexes = [box(i * 12, 0, 10, 10) for i in range(3)]
        pixels = np.full((10, 36), 255, np.uint8)
        pixels[0, 24:34] = pixels[9, 24:34] = 251
        pixels[:10, 24] = pixels[:10, 33] = 251
        self.assertEqual(active_by_color(pixels, indexes), 3)
        pixels[:] = 255
        pixels[5, 5] = 50
        self.assertEqual(active_by_color(pixels, indexes), 3)
        pixels[5, 17] = pixels[5, 29] = 50
        self.assertEqual(active_by_color(pixels, indexes), -1)

    def test_image_difference_counts_pixels_instead_of_magnitudes(self):
        images = [np.zeros((4, 5), np.uint8) for _ in range(4)]
        images[2][:] = 1
        self.assertEqual(most_different(images), 2)
        self.assertEqual(most_different([images[0]] * 4), -1)
        self.assertEqual(most_different(images[:3]), -1)
        indexes = [box(i * 6, 0, 5, 4) for i in range(4)]
        pixels = np.zeros((4, 24), np.uint8)
        pixels[:4, 12:17] = 1
        self.assertEqual(active_by_color(pixels, indexes), 3)

    def test_arrow_counts_are_cumulative_and_failure_resets_only_on_success(self):
        first = active_context(-1, 2, dict(activeIndexByArrowCount=[0] * 4, totalCheckFailedCount=3))
        self.assertEqual(first["index"], -2)
        self.assertEqual(first["context"]["totalCheckFailedCount"], 3)
        other = active_context(-1, 1, first["context"])
        failed = active_context(-1, -1, other["context"])
        again = active_context(-1, 2, failed["context"])
        self.assertEqual(again["index"], 2)
        self.assertEqual(again["context"], dict(activeIndexByArrowCount=[1, 2, 0, 0], totalCheckFailedCount=0))
        color = active_context(4, -1, first["context"])
        self.assertEqual(color["context"]["activeIndexByArrowCount"], [0, 1, 0, 0])
        self.assertEqual(first["context"]["totalCheckFailedCount"], 3)

    def test_arrow_only_uses_strict_vertical_overlap(self):
        bridge = VisionBridge()
        handle = bridge.put(frame())
        vision = PartyVision(bridge)
        indexes = [box(1850, y, 16, 17) for y in (256, 352)]
        vision._find = Mock(return_value=box(1700, 335, 50, 17))
        self.assertEqual(vision.active(bridge.image(handle), indexes)["index"], -1)
        vision._find.return_value = box(1700, 336, 50, 17)
        first = vision.active(bridge.image(handle), indexes)
        self.assertEqual(first["index"], -2)
        self.assertEqual(vision.active(bridge.image(handle), indexes, first["context"])["index"], 2)

    def test_avatar_isactive_preserves_distinct_strict50percent_white_rule(self):
        bridge = VisionBridge()
        pixels = np.zeros((10, 10), np.uint8)
        pixels.ravel()[:50] = 251
        handle = bridge.put(pixels)
        vision = PartyVision(bridge)
        request = dict(handle=handle, indexRect=box(0, 0, 10, 10))
        self.assertTrue(vision.dispatch("party.avatarIsActive", request))
        pixels.ravel()[50] = 255
        self.assertFalse(vision.dispatch("party.avatarIsActive", request))


class PartyRecognitionTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.handle = self.bridge.put(frame(), "ImageRegion")
        self.vision = PartyVision(self.bridge)
        self.image = self.bridge.image(self.handle)
        self.index = box(1859, 256, 16, 17)
        self.icon = box(1768, 209, 82, 82)
        self.vision.layout = Mock(return_value=dict(indexRects=[self.index], sideIconRects=[self.icon]))
        self.predictor = Mock()
        self.vision.predictor = self.predictor
        self.vision.bridge.find_ocr = Mock(return_value=[dict(text="  芭 芭 拉123!")])

    def test_original_catalog_and_regular_threshold_inclusive(self):
        self.predictor.predict.return_value = prediction("Ambor", .7)
        avatar = self.vision.recognize(self.image)["avatars"][0]
        self.assertEqual((avatar["name"], avatar["nameEn"], avatar["recognitionMethod"]), ("安柏", "Ambor", "classifier"))
        self.assertEqual(self.predictor.predict.call_args.args[0].shape, (82, 82, 3))
        self.bridge.find_ocr.assert_not_called()
        self.assertEqual(len(self.bridge.images), 1)

    def test_qin_and_costume_reduced_threshold_and_source_costume_name(self):
        self.predictor.predict.return_value = prediction("Qin", .51)
        self.assertEqual(self.vision.recognize(self.image)["avatars"][0]["name"], "琴")
        self.predictor.predict.return_value = prediction("DilucCostumeFlamme", .51)
        avatar = self.vision.recognize(self.image)["avatars"][0]
        self.assertEqual(avatar["displayName"], "迪卢克(殷红终夜)")
        self.assertEqual(avatar["costume"], "Flamme")
        self.bridge.find_ocr.assert_not_called()

    def test_classifier_low_confidence_and_unknown_label_fall_back_to_original_chinese_ocr(self):
        for name, confidence in (("Ambor", .6999), ("Qin", .5099), ("QinCostumeSea", .5099), ("Paimon", .9)):
            with self.subTest(name=name):
                self.predictor.predict.return_value = prediction(name, confidence)
                avatar = self.vision.recognize(self.image)["avatars"][0]
                self.assertEqual((avatar["name"], avatar["recognitionMethod"]), ("芭芭拉", "ocr"))
                self.assertTrue(avatar["classifierError"])
                self.assertEqual(self.bridge.find_ocr.call_args.args[1]["roi"], box(1619, 239, 240, 51))

    def test_ocr_fallback_does_not_guess_aliases_or_extended_chinese(self):
        self.predictor.predict.side_effect = RuntimeError("model unavailable")
        self.bridge.find_ocr.return_value = [dict(text="兔兔伯爵")]
        avatar = self.vision.recognize(self.image)["avatars"][0]
        self.assertEqual((avatar["name"], avatar["nameEn"]), ("未知角色", "Unknown"))
        self.bridge.find_ocr.side_effect = RuntimeError("OCR unavailable")
        with self.assertRaisesRegex(RuntimeError, "OCR unavailable"):
            self.vision.recognize(self.image)

    def test_original_classifier_model_executes_with_original_labels(self):
        from yolo_vision import YoloPredictor
        predictor = YoloPredictor(MODELS / "Common/avatar_side_classify_sim.onnx")
        prediction_result = predictor.predict(np.zeros((82, 82, 3), np.uint8))
        self.assertEqual(len(prediction_result), 161)
        self.assertEqual(predictor.task, "classify")
        catalog = self.vision.avatars()
        unmapped = {p["name"]["name"] for p in prediction_result
                    if p["name"]["name"].split("Costume")[0] not in catalog}
        self.assertEqual(unmapped, {"Hookwalker", "Mosasaurus", "Dainslaif", "Flamingo", "Drillhead",
                                    "IlPierro", "Jeht", "Shamansaurus", "Paimon"})
        self.assertEqual(hashlib.sha256(predictor.path.read_bytes()).hexdigest(),
                         "3833a142c416601534a8d1cb4e3a1d6197e1b080783b7b15c4a76072917c1cfa")
        self.assertGreater(prediction_result[0]["confidence"], 0)
        predictor.dispose()


class SkillVisionTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.pixels = frame()
        self.handle = self.bridge.put(self.pixels, "ImageRegion")
        self.vision = PartyVision(self.bridge)
        self.image = self.bridge.image(self.handle)
        self.engine = Mock()
        self.engine.recognize.return_value = (" 12.5 ", .001)
        self.bridge.ocr_engine = self.engine
        self.e = self.vision.e_predictor = Mock()
        self.q = self.vision.q_predictor = Mock()
        self.e.predict.return_value = prediction("S Arlecchino 01 nocd", .9)
        self.q.predict.return_value = prediction("energy 1 cd 0", .9)

    def skill(self, **kwargs):
        return self.vision.dispatch("party.skill", dict(handle=self.handle, nameEn="Arlecchino", maxSkillCd=15, **kwargs))

    def test_default_is_unknown_ocr_cd_without_detector_confidence_filter_or_classifier(self):
        self.assertEqual(self.skill(), dict(state="Unknown", code=None, cd=12.5))
        self.e.predict.assert_not_called()
        self.engine.run.assert_not_called()
        self.engine.detection.assert_not_called()
        self.assertEqual(self.engine.recognize.call_args.args[0].shape, (18, 41))
        self.assertEqual(len(self.bridge.images), 1)

    def test_original_hsv_threshold_and_cooldown_roi(self):
        rect = asset_geometry(1920, 1080)["eCooldownRect"]
        values = [(234, 234, 234), (235, 235, 235), (255, 255, 255),
                  (230, 230, 255), (229, 229, 255), (255, 245, 245)]
        for i, value in enumerate(values):
            self.pixels[rect["y"] + 2, rect["x"] + i] = value
        self.skill()
        actual = self.engine.recognize.call_args.args[0]
        expected = cv2.inRange(cv2.cvtColor(self.pixels[983:1001, 1679:1720], cv2.COLOR_BGR2HSV),
                               (0, 0, 235), (0, 25, 255))
        np.testing.assert_array_equal(actual, expected)
        self.assertEqual(actual[2, :6].tolist(), [0, 255, 255, 255, 0, 0])

    def test_cd_preserves_dot_decimal_ascii_numbers_thousands_and_float_syntax(self):
        for text, expected in (("12.5", 12.5), (" +.5\t", .5), ("1e-1", .1), ("1,000", 1000), ("15.", 15)):
            with self.subTest(text=text):
                self.assertEqual(skill_cd_number(text, 2000), expected)
        for text in ("0", "-1", "15.1", "nan", "Infinity", "1e400", "１２", "١٢", "1_2", "12sec", ""):
            with self.subTest(text=text):
                self.assertIsNone(skill_cd_number(text, 15))

    def test_cd_accepts_exact_maximum_but_invalid_or_zero_is_null(self):
        for text, expected in (("15", 15), ("15.01", None), ("0", None), ("bad", None), ("-2", None)):
            with self.subTest(text=text):
                self.engine.recognize.return_value = (text, 1)
                self.assertEqual(self.skill(), dict(state="Unknown", code=None, cd=expected))

    def test_classifier_exact_threshold_wrong_avatar_and_malformed_label_skip_ocr(self):
        cases = (("S Arlecchino 01 nocd", .7), ("S Arlecchino 01 nocd", .1),
                 ("S Qin 01 nocd", .99), ("Arlecchino 01 nocd", .99),
                 ("S  Arlecchino 01 nocd", .99))
        for label, confidence in cases:
            with self.subTest(label=label, confidence=confidence):
                self.e.predict.return_value = prediction(label, confidence)
                self.assertEqual(self.skill(enableClassifier=True), dict(state="Unknown", code=None, cd=None))
        self.engine.recognize.assert_not_called()
        self.assertEqual(self.e.predict.call_args.args[0].shape, (82, 82, 3))

    def test_ready_uses_nocd_before_cd_case_insensitively_and_returns_zero(self):
        self.e.predict.return_value = prediction("S arLECCHino 01 NOCD", .700001)
        self.assertEqual(self.skill(enableClassifier=True), dict(state="Ready", code="01", cd=0))
        self.engine.recognize.assert_not_called()

    def test_special_code_defaults_to_cooldown_then_ocr_even_when_label_says_nocd(self):
        self.e.predict.return_value = prediction("S Arlecchino 03 nocd", .99)
        self.assertEqual(self.skill(enableClassifier=True), dict(state="Cooldown", code="03", cd=12.5))
        self.engine.recognize.assert_called_once()
        self.engine.recognize.reset_mock()
        self.assertEqual(self.skill(enableClassifier=True, onlyCode01Ready=False), dict(state="Ready", code="03", cd=0))
        self.engine.recognize.assert_not_called()

    def test_explicit_cd_retains_state_when_number_cannot_be_read(self):
        self.e.predict.return_value = prediction("S Arlecchino 01 cd", .9)
        self.engine.recognize.return_value = ("", 0)
        self.assertEqual(self.skill(enableClassifier=True), dict(state="Cooldown", code="01", cd=None))
        self.engine.recognize.return_value = ("3.5", .1)
        self.assertEqual(self.skill(enableClassifier=True), dict(state="Cooldown", code="01", cd=3.5))

    def test_unknown_status_retains_original_code_and_skips_ocr(self):
        self.e.predict.return_value = prediction("S Arlecchino 01 other", .99)
        self.assertEqual(self.skill(enableClassifier=True), dict(state="Unknown", code="01", cd=None))
        self.engine.recognize.assert_not_called()

    def test_burst_source_threshold_and_cd1_before_energy_readiness(self):
        cases = (("energy 1 cd 0", .7, "Unknown"), ("energy 1 cd 0", .700001, "Ready"),
                 ("ENERGY 1 CD 0", .99, "Ready"), ("energy 0 cd 1", .99, "Cooldown"),
                 ("energy h cd 1", .99, "Cooldown"), ("energy 1 cd 1", .99, "Cooldown"),
                 ("energy 0 cd 0", .99, "Unknown"), ("energy h cd 0", .99, "Unknown"),
                 ("unknown", .99, "Unknown"), ("energy 1 cd 0 cd 1", .99, "Cooldown"))
        for label, confidence, state in cases:
            with self.subTest(label=label, confidence=confidence):
                self.q.predict.return_value = prediction(label, confidence)
                self.assertEqual(self.vision.dispatch("party.burst", dict(handle=self.handle)),
                                 dict(state=state, confidence=confidence, className=label))
        self.assertEqual(self.q.predict.call_args.args[0].shape, (137, 137, 3))
        self.engine.recognize.assert_not_called()

    def test_skill_and_burst_crop_use_width_scale_at_short_capture_and_cap_above1080(self):
        for width, height, e_shape, q_shape in ((1280, 720, (54, 54, 3), (91, 91, 3)),
                                              (1920, 720, (82, 82, 3), (137, 137, 3)),
                                              (2560, 1440, (82, 82, 3), (137, 137, 3))):
            with self.subTest(width=width, height=height):
                handle = self.bridge.put(frame(width, height))
                self.vision.dispatch("party.skill", dict(handle=handle, nameEn="Arlecchino", maxSkillCd=15, enableClassifier=True))
                self.vision.dispatch("party.burst", dict(handle=handle))
                self.assertEqual(self.e.predict.call_args.args[0].shape, e_shape)
                self.assertEqual(self.q.predict.call_args.args[0].shape, q_shape)

    def test_predictor_and_ocr_failures_propagate_without_fabricated_state(self):
        self.e.predict.side_effect = RuntimeError("E inference failure")
        with self.assertRaisesRegex(RuntimeError, "E inference failure"):
            self.skill(enableClassifier=True)
        self.engine.recognize.assert_not_called()
        self.q.predict.side_effect = RuntimeError("Q inference failure")
        with self.assertRaisesRegex(RuntimeError, "Q inference failure"):
            self.vision.dispatch("party.burst", dict(handle=self.handle))
        self.engine.recognize.side_effect = RuntimeError("OCR inference failure")
        with self.assertRaisesRegex(RuntimeError, "OCR inference failure"):
            self.skill()

    def test_invalid_maximum_and_missing_avatar_fail_before_inference(self):
        for maximum in (-1, True, float("inf"), float("nan"), "15"):
            with self.subTest(maximum=maximum):
                with self.assertRaises(ValueError):
                    self.vision.skill(self.image, "Arlecchino", maximum)
        with self.assertRaises(ValueError):
            self.vision.skill(self.image, None, 15, enable_classifier=True)
        self.engine.recognize.assert_not_called()
        self.e.predict.assert_not_called()

    def test_original_e_and_q_models_infer_unchanged_labels_and_hashes(self):
        from yolo_vision import YoloPredictor
        cases = (("e_classify_sim.onnx", 1082, "f2e620c0e3acb09ebe22204d4bbd0c0f16b535525ab1988b80e5b5a66678d121"),
                 ("q_classify_sim.onnx", 6, "da21c5e7eb65709d3cff0ce250c3da74bd8ffd08034da8ee9c93bc8a3ab3c612"))
        for filename, count, digest in cases:
            with self.subTest(filename=filename):
                predictor = YoloPredictor(MODELS / "Common" / filename)
                output = predictor.predict(np.zeros((82, 82, 3), np.uint8))
                self.assertEqual(len(output), count)
                self.assertEqual(predictor.task, "classify")
                self.assertEqual(hashlib.sha256(predictor.path.read_bytes()).hexdigest(), digest)
                self.assertGreater(output[0]["confidence"], 0)
                if filename.startswith("e_"):
                    self.assertIn("S Arlecchino 01 nocd", [r["name"]["name"] for r in output])
                else:
                    self.assertEqual({r["name"]["name"] for r in output},
                                     {"energy " + energy + " cd " + cd for energy in ("0", "1", "h") for cd in ("0", "1")})
                predictor.dispose()

    def test_lazy_classifier_uses_original_model_root_and_caches_each_model(self):
        vision = PartyVision(VisionBridge(str(MODELS)))
        with patch("yolo_vision.YoloPredictor") as factory:
            for kind, filename in (("e", "e_classify_sim.onnx"), ("q", "q_classify_sim.onnx")):
                factory.reset_mock()
                first = vision.classifier(kind)
                self.assertIs(first, vision.classifier(kind))
                factory.assert_called_once_with(MODELS / "Common" / filename)


class CombatTargetTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.vision = PartyVision(self.bridge)

    def test_blood_exact_rgb_and_connectivity4_without_component_filters(self):
        pixels = frame()
        pixels[30, 300] = (90, 90, 255)
        pixels[31, 301] = (90, 90, 255)
        pixels[32, 302] = (91, 90, 255)
        pixels[40, 320] = (255, 90, 90)
        pixels[70:73, 200:215] = (90, 90, 255)
        pixels[920, 310] = (90, 90, 255)
        bars = self.vision.blood_bars(pixels, 1)
        self.assertEqual([(r["x"], r["y"], r["width"], r["height"]) for r in bars],
                         [(300, 30, 1, 1), (301, 31, 1, 1), (200, 70, 15, 3)])
        self.assertTrue(all(not r["legendary"] for r in bars))
        bars = self.vision.blood_bars(pixels, 1)
        self.assertEqual([r["legendary"] for r in bars], [True, True, False])

    def test_legendary_tracker_source_layered_thresholds_decay_and_reset(self):
        pixels = frame()
        for y in (50, 100, 200):
            pixels[y:y + 2, 300:310] = (90, 90, 255)
        for i in range(1, 11):
            bars = self.vision.blood_bars(pixels, 1)
            self.assertEqual([r["legendary"] for r in bars], [i >= 2, i >= 4, i >= 10])
        self.assertEqual(set(self.vision.legendary_tracker.values()), {10})
        self.vision.blood_bars(frame(), 1)
        self.assertEqual(set(self.vision.legendary_tracker.values()), {9})
        moved = frame()
        moved[51:53, 304:314] = (90, 90, 255)
        self.assertTrue(self.vision.blood_bars(moved, 1)[0]["legendary"])
        self.assertEqual(self.vision.legendary_tracker[(300, 50)], 10)
        self.vision.dispatch("party.resetTargetTracker", {})
        self.assertEqual(self.vision.legendary_tracker, {})
        self.assertFalse(self.vision.blood_bars(moved, 1)[0]["legendary"])

    def test_damage_source_rgb_palette_and_minimum_scaled_height(self):
        for rgb in DAMAGE_COLORS:
            with self.subTest(rgb=rgb):
                pixels = frame()
                pixels[300:320, 500:509] = rgb[::-1]
                result = damage_color(pixels, 1)
                self.assertEqual(result, dict(centerX=504, centerY=310, text="", **box(500, 300, 9, 20)))
                pixels[319, 500:509] = 0
                self.assertIsNone(damage_color(pixels, 1))
        pixels = frame(1280, 720)
        pixels[200:213, 350:358] = DAMAGE_COLORS[0][::-1]
        self.assertEqual(damage_color(pixels, 2 / 3)["height"], 13)

    def test_damage_weighted_pixel_area_not_bounding_box_area(self):
        pixels = frame()
        pixels[300:320, 500:510] = DAMAGE_COLORS[0][::-1]
        pixels[300:320, 700:710] = DAMAGE_COLORS[1][::-1]
        # Both equal-area components: source stable ordering breaks distance tie.
        self.assertEqual(damage_color(pixels, 1)["x"], 500)
        pixels[300:320, 700:720] = DAMAGE_COLORS[1][::-1]
        self.assertEqual(damage_color(pixels, 1)["x"], 700)
        pixels[300:320, 700:720] = 0
        pixels[300:320, 700] = DAMAGE_COLORS[1][::-1]
        pixels[319, 700:720] = DAMAGE_COLORS[1][::-1]
        self.assertEqual(damage_color(pixels, 1)["x"], 500)

    def test_damage_ocr_source_reaction_priority_and_unicode_digit_filter(self):
        line = lambda text, x=500, height=20: dict(text=text, **box(x, 300, 30, height))
        for text in ("123", "+12345", "１２３", "x²³⁴⁵", "𝟙𝟚𝟛𝟜", "  常用字"):
            self.assertIsNone(damage_ocr([line(text)]))
        for text in ("1234", "  -12,345! 刺", "１２３４", "+免疫123", "蒸发"):
            self.assertEqual(damage_ocr([line(text)])["text"], text.strip())
        result = damage_ocr([line("1234", 500, 10), line("12345", 800, 40)])
        self.assertEqual(result["x"], 800)

    def test_damage_ocr_dispatch_uses_original_roi_and_disabled_skips_ocr(self):
        handle = self.bridge.put(frame(1280, 720), "ImageRegion")
        self.bridge.find_ocr = Mock(return_value=[dict(text="超载", **box(500, 300, 40, 20))])
        result = self.vision.dispatch("party.damageNumber", dict(handle=handle, mode="Ocr"))
        self.assertEqual(result["text"], "超载")
        self.assertEqual(self.bridge.find_ocr.call_args.args[1]["roi"], box(300, 160, 766, 440))
        self.bridge.find_ocr.reset_mock()
        self.assertIsNone(self.vision.dispatch("party.damageNumber", dict(handle=handle, mode="Disabled")))
        self.bridge.find_ocr.assert_not_called()

    def test_invalid_geometry_and_context_fail_without_synthetic_observations(self):
        with self.assertRaises(ValueError):
            crop(frame(10, 10), box(20, 20, 10, 10), clamp=True)
        with self.assertRaises(ValueError):
            active_context(-1, 1, dict(activeIndexByArrowCount=[0, 0]))
        handle = self.bridge.put(frame())
        with self.assertRaises(ValueError):
            self.vision.dispatch("party.active", dict(handle=handle, indexRects=[]))
        with self.assertRaises(ValueError):
            self.vision.dispatch("party.damageNumber", dict(handle=handle, mode="Unknown"))


class CombatStatusTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.vision = PartyVision(self.bridge)

    def test_low_hp_uses_exact_bgr_at_system_scaled_pixel(self):
        for width, height in ((1920, 1080), (1280, 720), (1920, 720), (2560, 1440)):
            with self.subTest(width=width, height=height):
                pixels = frame(width, height)
                handle = self.bridge.put(pixels)
                scale = system_scale(width, height)
                x, y = int(808 * scale), int(1010 * scale)
                for value, expected in (((90, 90, 255), True), ((255, 90, 90), False),
                                        ((89, 90, 255), False), ((90, 90, 254), False)):
                    pixels[y, x] = value
                    self.assertEqual(self.vision.dispatch("party.lowHp", dict(handle=handle)), expected)

    def test_probability_table_uses_source_point05_interpolation_and_clamps(self):
        table = [0, .2, .8]
        self.assertEqual(feature_probability(.025, table), .1)
        self.assertAlmostEqual(feature_probability(.075, table), .5)
        self.assertEqual(feature_probability(0, table), 0)
        self.assertEqual(feature_probability(-10, table), 0)
        self.assertEqual(feature_probability(10, table), .8)
        self.assertEqual(feature_probability(.9, []), .5)

    def feature(self, **kwargs):
        result = dict(Type="F1", Channel="H", X=0, Y=0, W=2, H=2, IsCircular=True,
                      Range=360, RefVal=0, Weight=1, ProbTable=[i / 20 for i in range(21)])
        result.update(kwargs)
        return result

    def test_f1_hue_mean_is_circular_and_uses_degrees(self):
        hsv = np.full((2, 2, 3), (0, 255, 255), np.uint8)
        hsv[:, 0, 0] = 179
        hsv[:, 1, 0] = 1
        pixels = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)
        self.assertAlmostEqual(feature_score(pixels, self.feature()), 1)
        self.assertAlmostEqual(feature_score(pixels, self.feature(RefVal=180)), 0)

    def test_f1_sv_mean_normalized_and_clamps_source_patch_without_scaling(self):
        pixels = np.full((4, 5, 3), 255, np.uint8)
        pixels[3, 4] = 127
        feature = self.feature(Channel="V", IsCircular=False, Range=1, RefVal=1, X=999, Y=999, W=4, H=4)
        self.assertAlmostEqual(feature_score(pixels, feature), 127 / 255)
        self.assertEqual(feature_score(pixels, self.feature(Channel="Invalid")), .5)
        self.assertEqual(feature_score(pixels, self.feature(W=0)), .5)
        self.assertEqual(feature_score(pixels, self.feature(Type="Invalid")), .5)

    def test_f2_uses_8bins_gradient_magnitudes_and_cosine_similarity(self):
        pixels = np.zeros((6, 6, 3), np.uint8)
        pixels[:, :, :] = (np.arange(6) * 20)[None, :, None]
        horizontal = self.feature(Type="F2", Channel="V", X=2, Y=1, W=1, H=4, RefHist=[1, 0, 0, 0, 0, 0, 0, 0])
        self.assertAlmostEqual(feature_score(pixels, horizontal), 1)
        self.assertAlmostEqual(feature_score(pixels, {**horizontal, "RefHist": [0, 0, 0, 0, 1, 0, 0, 0]}), 0)
        vertical = pixels.transpose(1, 0, 2).copy()
        self.assertAlmostEqual(feature_score(vertical, {**horizontal, "RefHist": [0, 0, 0, 0, 1, 0, 0, 0]}), 1)
        self.assertAlmostEqual(feature_score(np.zeros_like(pixels), horizontal), 0)
        self.assertEqual(feature_score(pixels, {**horizontal, "RefHist": None}), .5)
        self.assertEqual(feature_score(pixels, {**horizontal, "RefHist": [1] * 7}), .5)
        self.assertEqual(feature_score(pixels, {**horizontal, "W": 1, "H": 3}), .5)

    def test_feature_weighting_and_default_half(self):
        pixels = np.zeros((2, 2, 3), np.uint8)
        features = [self.feature(RefVal=0, Weight=3), self.feature(RefVal=180, Weight=1)]
        self.assertAlmostEqual(image_feature_score(pixels, features), .75)
        self.assertEqual(image_feature_score(pixels, []), .5)
        self.assertEqual(image_feature_score(pixels, [self.feature(Weight=0)]), .5)

    def test_overheat_parses_original_nine_feature_model_once_and_runs_real_scorer(self):
        pixels = frame()
        handle = self.bridge.put(pixels)
        first = self.vision.dispatch("party.overheat", dict(handle=handle))
        self.assertEqual(len(self.vision.overheat_features), 9)
        self.assertEqual(self.vision.overheat_threshold, .5)
        self.assertEqual([f["Type"] for f in self.vision.overheat_features].count("F1"), 5)
        self.assertEqual([f["Type"] for f in self.vision.overheat_features].count("F2"), 4)
        self.assertEqual(self.vision.overheat_features[0]["RefVal"], 301.808)
        self.assertEqual(self.vision.overheat_features[-1]["ProbTable"][-1], .9848)
        # Original hue features score a black frame slightly above the threshold.
        self.assertAlmostEqual(first["score"], .5031873006684254)
        self.assertTrue(first["overheated"])
        pixels[:] = cv2.cvtColor(np.array([[[60, 255, 255]]], np.uint8), cv2.COLOR_HSV2BGR)[0, 0]
        negative = self.vision.dispatch("party.overheat", dict(handle=handle))
        self.assertEqual(negative, dict(score=0, overheated=False))
        for feature in self.vision.overheat_features:
            if feature["Type"] == "F1":
                hsv = np.array([[[round(feature["RefVal"] / 2) % 180, 255, 255]]], np.uint8)
                color = cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0]
                x, y, w, h = (feature[key] for key in ("X", "Y", "W", "H"))
                pixels[y:y + h, x:x + w] = color
        with patch.object(Path, "read_text", side_effect=AssertionError("Model should be cached")):
            result = self.vision.dispatch("party.overheat", dict(handle=handle))
        self.assertGreater(result["score"], .5)
        self.assertTrue(result["overheated"])

    def test_overheat_source_threshold_is_inclusive_and_unscaled_coordinates_are_retained(self):
        handle = self.bridge.put(frame(1280, 720))
        self.vision.overheat_features = [self.feature(ProbTable=[.5] * 21)]
        self.vision.overheat_threshold = .5
        result = self.vision.dispatch("party.overheat", dict(handle=handle))
        self.assertEqual(result, dict(score=.5, overheated=True))
        source = frame(1280, 720)
        source[519, 1095] = (255, 0, 255)
        feature = self.feature(X=1095, Y=519, W=1, H=1, RefVal=300)
        self.assertEqual(feature_score(source, feature), 1)
        source[519, 1095] = 0
        source[int(519 * 2 / 3), int(1095 * 2 / 3)] = (255, 0, 255)
        self.assertAlmostEqual(feature_score(source, feature), .75)

    def test_overheat_exception_follows_source_false_fallback_with_explicit_missing_score(self):
        handle = self.bridge.put(frame())
        self.vision.source_root = Path("/nonexistent-bettergi-source")
        result = self.vision.dispatch("party.overheat", dict(handle=handle))
        self.assertFalse(result["overheated"])
        self.assertIsNone(result["score"])
        self.assertIn("AvatarSpecialActions.cs", result["error"])
        self.assertIsNone(self.vision.overheat_features)


if __name__ == "__main__":
    unittest.main()
