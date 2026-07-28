"""Resolution-normalised PSNR/SSIM for Brush eval renders.

Brush evaluates at the *training* resolution: a 1536 px run renders its held-out views at
1536 px and scores them against a 1536 px ground truth, while a 2048 px run scores against a
2048 px one. Those PSNR values are not comparable — the low-resolution run is being marked
against an easier target, so it looks better for free.

Everything here therefore resamples *both* the render and its ground-truth frame to one fixed
reference resolution before a metric is computed. The reference resolution is a parameter of
the comparison, not of the run.

Resampling rule (applied identically to render and ground truth): downscale with `INTER_AREA`
(box average — the correct antialiasing filter for a size reduction), upscale with
`INTER_LANCZOS4`, and skip the resample entirely when the image is already at the target size.
Target dimensions come from the ground-truth aspect ratio, so they are the same for every
config compared on the same dataset.

SSIM is implemented here rather than imported: `skimage` is not in the default install. This is
the standard Wang et al. formulation — 11x11-equivalent Gaussian window (sigma 1.5, truncated at
3.5 sigma), C1 = (0.01 L)^2, C2 = (0.03 L)^2, population (not sample) covariance, border pixels
within one window radius dropped — computed per channel and averaged. It matches
`skimage.metrics.structural_similarity(..., gaussian_weights=True, sigma=1.5,
use_sample_covariance=False, data_range=255)`.
"""

from __future__ import annotations

import math
from pathlib import Path

import cv2
import numpy as np
from scipy.ndimage import gaussian_filter

DATA_RANGE = 255.0
_SSIM_SIGMA = 1.5
_SSIM_TRUNCATE = 3.5


def reference_size(width: int, height: int, ref_long_edge: int) -> tuple[int, int]:
    """Target (w, h) for a source of the given shape, scaled so its long edge is `ref_long_edge`."""
    scale = ref_long_edge / max(width, height)
    return max(1, round(width * scale)), max(1, round(height * scale))


def load_rgb(path: Path) -> np.ndarray:
    img = cv2.imread(str(path), cv2.IMREAD_COLOR)
    if img is None:
        raise ValueError(f"could not read image: {path}")
    return cv2.cvtColor(img, cv2.COLOR_BGR2RGB)


def resample(img: np.ndarray, size: tuple[int, int]) -> np.ndarray:
    """Resize to (w, h). INTER_AREA down, INTER_LANCZOS4 up, no-op when already there."""
    w, h = size
    if (img.shape[1], img.shape[0]) == (w, h):
        return img
    shrinking = w * h < img.shape[1] * img.shape[0]
    interp = cv2.INTER_AREA if shrinking else cv2.INTER_LANCZOS4
    return cv2.resize(img, (w, h), interpolation=interp)


def psnr(a: np.ndarray, b: np.ndarray) -> float:
    mse = float(np.mean((a.astype(np.float64) - b.astype(np.float64)) ** 2))
    if mse == 0.0:
        return float("inf")
    return float(10.0 * math.log10(DATA_RANGE**2 / mse))


def ssim(a: np.ndarray, b: np.ndarray) -> float:
    x = a.astype(np.float64)
    y = b.astype(np.float64)
    if x.ndim == 2:
        x, y = x[..., None], y[..., None]

    c1 = (0.01 * DATA_RANGE) ** 2
    c2 = (0.03 * DATA_RANGE) ** 2
    pad = int(math.ceil(_SSIM_TRUNCATE * _SSIM_SIGMA))

    def blur(v: np.ndarray) -> np.ndarray:
        return gaussian_filter(v, sigma=_SSIM_SIGMA, truncate=_SSIM_TRUNCATE, mode="reflect")

    per_channel = []
    for c in range(x.shape[2]):
        xc, yc = x[..., c], y[..., c]
        ux, uy = blur(xc), blur(yc)
        vx = blur(xc * xc) - ux * ux
        vy = blur(yc * yc) - uy * uy
        vxy = blur(xc * yc) - ux * uy
        num = (2 * ux * uy + c1) * (2 * vxy + c2)
        den = (ux**2 + uy**2 + c1) * (vx + vy + c2)
        s = num / den
        # Drop the border, where the window runs off the image.
        if s.shape[0] > 2 * pad and s.shape[1] > 2 * pad:
            s = s[pad:-pad, pad:-pad]
        per_channel.append(float(np.mean(s)))
    return float(np.mean(per_channel))


def compare(render_path: Path, gt_path: Path, ref_long_edge: int) -> dict:
    """PSNR/SSIM between a render and its ground truth, both normalised to the reference res."""
    gt = load_rgb(gt_path)
    render = load_rgb(render_path)
    size = reference_size(gt.shape[1], gt.shape[0], ref_long_edge)
    gt_n = resample(gt, size)
    render_n = resample(render, size)
    return {
        "image": gt_path.name,
        "psnr": psnr(render_n, gt_n),
        "ssim": ssim(render_n, gt_n),
        "render_size": [render.shape[1], render.shape[0]],
        "gt_size": [gt.shape[1], gt.shape[0]],
        "compared_size": list(size),
    }
