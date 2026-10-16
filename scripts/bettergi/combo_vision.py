"""BetterGI BvSkill inactive burst readiness, original raw-edge algorithm, GPL-3.0."""
import cv2
import numpy as np

from party_vision import asset_geometry, bgr, crop


def burst_sidebar(pixels, index=1, q_rect=None):
    pixels = bgr(pixels)
    if not isinstance(index, int) or isinstance(index, bool) or not 1 <= index <= 4:
        raise ValueError("Combo avatar index must be1..4")
    height, width = pixels.shape[:2]
    roi = q_rect if q_rect is not None else asset_geometry(width, height)["avatarQRects"][index - 1]
    pixels, roi = crop(pixels, roi, clamp=True)
    gray = cv2.cvtColor(pixels, cv2.COLOR_BGR2GRAY)
    mean = cv2.mean(gray)[0]
    edges = cv2.Canny(gray, float(np.float32(mean * .9)), float(np.float32(mean * 2)))
    circles = cv2.HoughCircles(edges, cv2.HOUGH_GRADIENT, dp=1.2, minDist=20,
                               param1=90, param2=25, minRadius=25, maxRadius=34)
    values = [] if circles is None else [dict(x=float(x), y=float(y), radius=float(r)) for x, y, r in circles.reshape(-1, 3)]
    return dict(ready=bool(values), circles=values, roi=roi, meanBrightness=mean)
