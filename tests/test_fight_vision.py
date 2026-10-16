"""Source-contract checks using original templates; no game input or live claims."""
from pathlib import Path
import hashlib
import sys
import tempfile
import unittest
from unittest.mock import Mock, patch

import cv2
import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts/bettergi"))
from fight_vision import (FightVision, box, experience_pixel,
                          guardian_burst, guardian_cooldown, q_ready, seek_components)
from vision import VisionBridge

PROJECT = Path(__file__).resolve().parents[1]
ASSETS = PROJECT / "third_party/bettergi/source/BetterGenshinImpact/GameTask/AutoFight/Assets"


def frame(width=1920, height=1080):
    return np.zeros((height, width, 3), np.uint8)


class FightComponentsTest(unittest.TestCase):
    def test_seek_exact_rgb_not_bgr_and_no_tolerance(self):
        pixels = frame()
        pixels[10:14, 20:25] = (90, 90, 255)
        pixels[30:33, 50:55] = (255, 90, 90)
        pixels[40:44, 70:75] = (90, 90, 254)
        pixels[50:54, 90:95] = (89, 90, 255)
        result = seek_components(pixels)
        self.assertEqual(result["components"], [{**box(20, 10, 5, 4), "area": 20}])
        self.assertEqual((result["width"], result["height"]), (1920, 1080))

    def test_four_connectivity_keeps_diagonal_pixels_distinct(self):
        pixels = frame(20, 20)
        pixels[1, 1] = pixels[2, 2] = (90, 90, 255)
        result = seek_components(pixels)
        self.assertEqual(result["components"], [{**box(1, 1, 1, 1), "area": 1}, {**box(2, 2, 1, 1), "area": 1}])

    def test_first_label_order_preserved_instead_of_largest_area(self):
        pixels = frame(400, 300)
        pixels[1, 350] = (90, 90, 255)
        pixels[30:50, 1:100] = (90, 90, 255)
        result = seek_components(pixels)
        self.assertEqual(result["components"][0], {**box(350, 1, 1, 1), "area": 1})
        self.assertEqual(result["components"][1]["area"], 1980)

    def test_seek_raw_roi_clamps_to_small_capture_and_excludes_right_bottom(self):
        small = seek_components(frame(1280, 720))
        self.assertEqual(small["roi"], box(0, 0, 1280, 720))
        pixels = frame()
        pixels[899, 1499] = pixels[899, 1500] = pixels[900, 1499] = (90, 90, 255)
        result = seek_components(pixels)
        self.assertEqual(result["roi"], box(0, 0, 1500, 900))
        self.assertEqual(result["components"], [{**box(1499, 899, 1, 1), "area": 1}])

    def test_move_uses_integer_scaled_crop_and_full_dimensions(self):
        pixels = frame(1281, 721)
        width, height = 1281 * 1570 // 1920, 721 * 970 // 1080
        pixels[height - 1, width - 1] = pixels[height, width] = (90, 90, 255)
        result = seek_components(pixels, "move")
        self.assertEqual(result["roi"], box(0, 0, width, height))
        self.assertEqual((result["width"], result["height"]), (1281, 721))
        self.assertEqual(result["components"], [{**box(width - 1, height - 1, 1, 1), "area": 1}])

    def test_background_is_not_in_seek_result_and_gray_bgra_supported(self):
        self.assertEqual(seek_components(frame())["components"], [])
        self.assertEqual(seek_components(np.zeros((10, 10), np.uint8))["components"], [])
        pixels = np.zeros((10, 10, 4), np.uint8)
        pixels[2, 3] = (90, 90, 255, 0)
        self.assertEqual(seek_components(pixels)["components"], [{**box(3, 2, 1, 1), "area": 1}])

    def test_invalid_mode_empty_or_wrong_pixels_rejected(self):
        with self.assertRaises(ValueError):
            seek_components(frame(), "invented")
        for pixels in (np.zeros((0, 2, 3), np.uint8), np.zeros((4, 4, 3), np.float32)):
            with self.assertRaises(ValueError):
                seek_components(pixels)


class GuardianCooldownTest(unittest.TestCase):
    def test_source_background_count_and_strict_greater_than_two(self):
        pixels = frame()
        self.assertEqual(guardian_cooldown(pixels)["componentCount"], 1)
        pixels[990, 1690] = 255
        one = guardian_cooldown(pixels)
        self.assertEqual(one["componentCount"], 2)
        self.assertFalse(one["cooldown"])
        pixels[994, 1694] = 255
        two = guardian_cooldown(pixels)
        self.assertEqual(two["componentCount"], 3)
        self.assertTrue(two["cooldown"])

    def test_exact_white_and_four_connected_diagonal(self):
        pixels = frame()
        pixels[990, 1690] = (254, 255, 255)
        self.assertFalse(guardian_cooldown(pixels)["cooldown"])
        pixels[990, 1690] = pixels[991, 1691] = 255
        self.assertTrue(guardian_cooldown(pixels)["cooldown"])

    def test_e_and_q_scaled_regions_use_source_integer_ratios(self):
        pixels = frame(1281, 721)
        for skill, values in (("E", (1688, 988, 22, 12)), ("Q", (1809, 968, 30, 15))):
            x, y, w, h = values
            expected = box(1281 * x // 1920, 721 * y // 1080, 1281 * w // 1920, 721 * h // 1080)
            self.assertEqual(guardian_cooldown(pixels, skill)["roi"], expected)

    def test_non_skill_area_is_excluded_and_invalid_skill_rejected(self):
        pixels = frame()
        pixels[968, 1809] = pixels[970, 1811] = 255
        self.assertFalse(guardian_cooldown(pixels, "E")["cooldown"])
        self.assertTrue(guardian_cooldown(pixels, "Q")["cooldown"])
        with self.assertRaises(ValueError):
            guardian_cooldown(pixels, "Z")


class GuardianBurstTest(unittest.TestCase):
    @patch("fight_vision.cv2.HoughCircles", return_value=None)
    def test_original_sidebar_geometry_scale_and_blank_not_ready(self, hough):
        result = guardian_burst(frame(), 3)
        self.assertEqual(result["roi"], box(1584, 416, 64, 84))
        self.assertFalse(result["ready"])
        self.assertEqual(result["circles"], [])
        half = guardian_burst(frame(960, 540), 2)
        self.assertEqual(half["roi"], box(792, 158, 32, 42))
        large = guardian_burst(frame(2560, 1440), 4)
        self.assertEqual(large["roi"], box(2224, 516, 64, 84))

    @patch("fight_vision.cv2.HoughCircles", return_value=np.array([[[25.5, 26.25, 30.75]]], np.float32))
    @patch("fight_vision.cv2.Canny")
    def test_mean_float_thresholds_and_guardian_hough_parameters(self, canny, hough):
        pixels = frame()
        roi = box(100, 200, 64, 84)
        pixels[200:284, 100:164] = (30, 80, 110)
        canny.return_value = np.zeros((84, 64), np.uint8)
        result = guardian_burst(pixels, 1, roi)
        gray = cv2.cvtColor(pixels[200:284, 100:164], cv2.COLOR_BGR2GRAY)
        mean = cv2.mean(gray)[0]
        np.testing.assert_array_equal(canny.call_args.args[0], gray)
        self.assertEqual(canny.call_args.args[1:], (float(np.float32(mean * .9)), float(np.float32(mean * 2))))
        self.assertIs(hough.call_args.args[0], canny.return_value)
        self.assertEqual(hough.call_args.kwargs, dict(dp=1.2, minDist=20, param1=70, param2=30, minRadius=25, maxRadius=34))
        self.assertTrue(result["ready"])
        self.assertEqual(result["circles"], [dict(x=25.5, y=26.25, radius=30.75)])

    @patch("fight_vision.cv2.HoughCircles", return_value=None)
    def test_explicit_crop_preserves_source_clamping(self, _):
        result = guardian_burst(frame(100, 100), q_rect=box(80, 80, 64, 84))
        self.assertEqual(result["roi"], box(80, 80, 20, 20))
        for index in (0, 5, True, 1.5):
            with self.assertRaises(ValueError):
                guardian_burst(frame(), index)

    def test_real_hough_detects_source_sized_circle(self):
        pixels = frame()
        cv2.circle(pixels, (1616, 258), 30, (240, 240, 240), 2)
        result = guardian_burst(pixels, 1)
        self.assertTrue(result["ready"])
        self.assertTrue(any(25 <= circle["radius"] <= 34 for circle in result["circles"]))


class QReadyTest(unittest.TestCase):
    @patch("fight_vision.cv2.HoughCircles")
    @patch("fight_vision.cv2.Canny")
    def test_source_sidebar_center_union_double_contrast_and_input_unchanged(self, canny, hough):
        pixels = np.full((1080, 1920, 3), 160, np.uint8)
        before = pixels.copy()
        canny.side_effect = lambda image, *_: image.copy()
        circle = np.array([[[30, 30, 30]]], np.float32)
        hough.side_effect = [circle, None, None, None, circle]
        result = q_ready(pixels, 3)
        self.assertEqual(result["readyIndexes"], [1, 3])
        self.assertEqual(len(result["observations"]), 5)
        for call in canny.call_args_list[:4]:
            self.assertTrue(np.all(call.args[0] == 120))
            self.assertEqual(call.args[1:], (float(np.float32(108)), float(np.float32(240))))
        self.assertTrue(np.all(canny.call_args_list[4].args[0] == 40))
        self.assertEqual(hough.call_args_list[0].kwargs, dict(dp=1.2, minDist=20, param1=90, param2=25, minRadius=25, maxRadius=34))
        self.assertEqual(hough.call_args_list[4].kwargs, dict(dp=1.2, minDist=20, param1=90, param2=35, minRadius=50, maxRadius=60))
        self.assertEqual(result["observations"][4]["roi"], box(1762, 915, 114, 111))
        np.testing.assert_array_equal(pixels, before)

    @patch("fight_vision.cv2.HoughCircles", return_value=None)
    def test_no_active_omits_center_dispatch_borrows_handle(self, hough):
        bridge = VisionBridge()
        handle = bridge.put(frame(960, 540))["handle"]
        result = bridge.dispatch("fight.qReady", dict(handle=handle, activeIndex=0))
        self.assertEqual(result["readyIndexes"], [])
        self.assertEqual(hough.call_count, 4)
        self.assertEqual(len(bridge.images), 1)
        for value in (5, True, 1.5):
            with self.assertRaises(ValueError):
                q_ready(frame(), value)


    @patch("fight_vision.cv2.HoughCircles", return_value=None)
    def test_source_fixed_center_crop_intersects_capture_and_empty_intersection_rejects(self, hough):
        result = q_ready(frame(1800, 1000), 2)
        self.assertEqual(result["observations"][-1]["roi"], box(1762, 915, 38, 85))
        self.assertEqual(hough.call_args.args[0].shape, (85, 38))
        self.assertEqual(hough.call_count, 5)
        hough.reset_mock()
        pixels = frame(960, 540)
        before = pixels.copy()
        with self.assertRaises(ValueError):
            q_ready(pixels, 2)
        self.assertEqual(hough.call_count, 4)
        np.testing.assert_array_equal(pixels, before)

    @patch("fight_vision.cv2.HoughCircles")
    def test_sidebar_and_center_same_avatar_is_reported_once(self, hough):
        circle = np.array([[[30, 30, 30]]], np.float32)
        hough.side_effect = [circle, None, None, None, circle]
        result = q_ready(frame(), 1)
        self.assertEqual(result["readyIndexes"], [1])
        self.assertTrue(result["observations"][0]["ready"])
        self.assertTrue(result["observations"][-1]["ready"])

    def test_real_hough_detects_sidebar_and_fixed_center_circles(self):
        pixels = frame()
        cv2.circle(pixels, (1616, 258), 30, (240, 240, 240), 2)
        cv2.circle(pixels, (1819, 970), 54, (240, 240, 240), 2)
        before = pixels.copy()
        result = q_ready(pixels, 3)
        self.assertEqual(result["readyIndexes"], [1, 3])
        self.assertEqual([item["ready"] for item in result["observations"]],
                         [True, False, False, False, True])
        np.testing.assert_array_equal(pixels, before)


class ExperiencePixelTest(unittest.TestCase):
    def test_fixed_unscaled_offset_and_inclusive_bgr_range(self):
        pixels = frame(2560, 1440)
        match = box(400, 720, 31, 20)
        for value in ((200, 200, 150), (255, 255, 200)):
            pixels[720, 253] = value
            result = experience_pixel(pixels, match)
            self.assertTrue(result["valid"])
            self.assertEqual((result["x"], result["y"]), (253, 720))
            self.assertEqual(result["bgr"], list(value))

    def test_each_outside_channel_rejected_and_pixel_bounds_checked(self):
        pixels = frame(400, 300)
        for value in ((199, 200, 150), (200, 199, 150), (200, 200, 149), (255, 255, 201)):
            pixels[100, 53] = value
            self.assertFalse(experience_pixel(pixels, box(200, 100, 31, 20))["valid"])
        for match in (box(146, 100, 31, 20), box(200, 300, 31, 20), box(547, 100, 31, 20)):
            result = experience_pixel(pixels, match)
            self.assertFalse(result["valid"])
            self.assertFalse(result["inBounds"])
            self.assertIsNone(result["bgr"])


class ExperienceTemplatesTest(unittest.TestCase):
    def setUp(self):
        self.bridge = VisionBridge()
        self.fight = FightVision(self.bridge)

    def test_original_template_hashes_order_green_mask_and_no_handles_leaked(self):
        hashes = ("c42f8a8411b12f3fe1ea11b344f13163bc58adb4e083a922f0157da0af6c7200",
                  "76e0e2ff092f70caf3c910f8df4af4de2f9f258c744e0426a0aeb7843bffa62f",
                  "601aa3216b1d7b7ab427a897d5bd6e947e94119d8fe5474d19c1c14a0ddceec7")
        templates = self.fight.experience_templates(1920, 1080)
        self.assertEqual([template["name"] for template in templates], ["Experience_57", "Experience_58", "Experience_60"])
        for template, digest in zip(templates, hashes):
            path = Path(template["path"])
            self.assertEqual(hashlib.sha256(path.read_bytes()).hexdigest(), digest)
            pixels = cv2.imread(str(path))
            np.testing.assert_array_equal(template["mask"], np.where(np.all(pixels == (0, 255, 0), axis=2), 0, 255).astype(np.uint8))
        self.assertEqual(len(self.bridge.images), 0)
        self.assertIs(templates, self.fight.experience_templates(1920, 1080))

    def test_original_resize_truncates_size_and_never_upscales(self):
        small = self.fight.experience_templates(1280, 720)
        self.assertEqual(small[0]["gray"].shape, (13, 20))
        large = self.fight.experience_templates(2560, 1440)
        self.assertEqual(large[0]["gray"].shape, (20, 31))

    def test_capture_specific_folder_fallback_and_missing_files_skipped(self):
        with tempfile.TemporaryDirectory() as temporary:
            self.fight.source_root = Path(temporary)
            assets = Path(temporary) / "GameTask/AutoFight/Assets"
            (assets / "1920x1080").mkdir(parents=True)
            (assets / "1280x720").mkdir()
            original = cv2.imread(str(ASSETS / "1920x1080/experience_57.png"))
            cv2.imwrite(str(assets / "1920x1080/experience_57.png"), original)
            (assets / "1920x1080/experience_58.png").write_bytes(b"")
            (assets / "1920x1080/experience_60.png").write_bytes(b"invalid png")
            self.assertEqual(self.fight.experience_templates(1280, 720), [])
            cv2.imwrite(str(assets / "1280x720/experience_58.png"), original)
            self.fight.templates.clear()
            small = self.fight.experience_templates(1280, 720)
            self.assertEqual([value["name"] for value in small], ["Experience_58"])
            other = self.fight.experience_templates(1600, 900)
            self.assertEqual([value["name"] for value in other], ["Experience_57"])

    def test_original_templates_match_at_actual_roi_and_guard_color_required(self):
        for value in (57, 58, 60):
            with self.subTest(value=value):
                pixels = np.random.default_rng(value).integers(0, 100, (1080, 1920, 3), np.uint8)
                template = cv2.imread(str(ASSETS / f"1920x1080/experience_{value}.png"))
                mask = np.any(template != (0, 255, 0), axis=2)
                x, y = 280, 600
                pixels[y:y + 20, x:x + 31][mask] = template[mask]
                pixels[y, x - 147] = (200, 200, 150)
                result = self.fight.experience(pixels)
                self.assertTrue(result["detected"])
                self.assertEqual(result["template"], f"Experience_{value}")
                self.assertEqual({key: result["match"][key] for key in ("x", "y", "width", "height")}, box(x, y, 31, 20))
                pixels[y, x - 147] = (200, 200, 201)
                self.assertFalse(self.fight.experience(pixels)["detected"])

    def test_masked_green_background_does_not_participate(self):
        pixels = np.random.default_rng(7).integers(0, 255, (1080, 1920, 3), np.uint8)
        template = cv2.imread(str(ASSETS / "1920x1080/experience_57.png"))
        mask = np.any(template != (0, 255, 0), axis=2)
        x, y = 278, 550
        pixels[y:y + 20, x:x + 31][mask] = template[mask]
        pixels[y, x - 147] = (255, 255, 200)
        self.assertTrue(self.fight.experience(pixels)["detected"])

    def test_raw_roi_truncation_threshold_boundary_and_original_order(self):
        self.fight.experience_templates = Mock(return_value=[dict(name=f"Experience_{value}") for value in (57, 58, 60)])
        self.fight.match_experience = Mock(return_value=None)
        self.fight.experience(frame(1920, 1080))
        self.assertEqual(self.fight.match_experience.call_args.args[2:], (box(278, 540, 38, 237), .9))
        self.assertEqual([call.args[1]["name"] for call in self.fight.match_experience.call_args_list], ["Experience_57", "Experience_58", "Experience_60"])
        self.fight.experience(frame(1921, 1081))
        self.assertEqual(self.fight.match_experience.call_args.args[2:], (box(int(1921 * .145), 540, int(1921 * .02), int(1081 * .22)), .6))

    def test_pixel_failure_continues_next_template_and_success_returns_immediately(self):
        pixels = frame()
        pixels[600, 133] = (200, 200, 150)
        self.fight.experience_templates = Mock(return_value=[dict(name=f"Experience_{value}") for value in (57, 58, 60)])
        self.fight.match_experience = Mock(side_effect=[box(279, 600, 31, 20), box(280, 600, 31, 20), box(281, 600, 31, 20)])
        result = self.fight.experience(pixels)
        self.assertTrue(result["detected"])
        self.assertEqual(result["template"], "Experience_58")
        self.assertEqual(self.fight.match_experience.call_count, 2)

    def test_template_best_only_source_does_not_search_second_match_after_pixel_failure(self):
        pixels = frame()
        self.fight.experience_templates = Mock(return_value=[dict(name="Experience_57")])
        self.fight.match_experience = Mock(return_value=box(280, 600, 31, 20))
        result = self.fight.experience(pixels)
        self.assertFalse(result["detected"])
        self.assertEqual(result["template"], "Experience_57")
        self.fight.match_experience.assert_called_once()

    def test_no_template_or_too_small_capture_returns_false(self):
        self.assertFalse(self.fight.experience(frame(10, 10))["detected"])
        self.fight.experience_templates = Mock(return_value=[])
        self.assertEqual(self.fight.experience(frame()), dict(detected=False, template=None, match=None, pixel=None))

    def test_match_threshold_inclusive_nan_ignored_inf_kept_json_safe(self):
        pixels = frame(10, 10)
        template = dict(gray=np.zeros((2, 2), np.uint8), mask=np.ones((2, 2), np.uint8) * 255)
        response = np.array([[np.nan, .8999, .9, np.inf]], np.float32)
        with patch("fight_vision.cv2.matchTemplate", return_value=response):
            match = self.fight.match_experience(pixels, template, box(0, 0, 10, 10), .9)
            self.assertEqual(match["x"], 3)
            self.assertIsNone(match["score"])
        response[0, 3] = .8999
        with patch("fight_vision.cv2.matchTemplate", return_value=response):
            self.assertEqual(self.fight.match_experience(pixels, template, box(0, 0, 10, 10), .9)["x"], 2)

    def test_dispatch_all_operations_and_unknown_error(self):
        pixels = frame()
        handle = self.bridge.put(pixels)["handle"]
        self.assertEqual(self.fight.dispatch("fight.seekComponents", dict(handle=handle))["components"], [])
        self.assertFalse(self.fight.dispatch("fight.guardianCooldown", dict(handle=handle, skill="Q"))["cooldown"])
        self.assertFalse(self.fight.dispatch("fight.guardianBurst", dict(handle=handle, index=4))["ready"])
        self.fight.experience_templates = Mock(return_value=[])
        self.assertFalse(self.fight.dispatch("fight.experience", dict(handle=handle))["detected"])
        with self.assertRaises(NotImplementedError):
            self.fight.dispatch("fight.invented", dict(handle=handle))
        with self.assertRaises(ValueError):
            self.fight.dispatch("fight.experience", dict(handle=-1))
