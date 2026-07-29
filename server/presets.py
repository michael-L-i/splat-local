from dataclasses import dataclass


@dataclass(frozen=True)
class Preset:
    frames: int
    max_resolution: int
    total_steps: int
    growth_stop: int
    max_splats: int
    export_every: int
    lpips_weight: float = 0.0
    # Opacity floor for the viewer-only artifact; the downloadable archive is never filtered.
    # Measured on a 135,575-splat scene (fill ratio = average overdraw layers per pixel):
    #   no filter -> 135,575 splats, 46.7 fill · gt,0.05 -> 109,551, 36.4 · gt,0.15 -> 59,748, 22.1
    # Median splat opacity there was 0.127, so 0.15 halves the scene — a big win that needs
    # human visual sign-off first. 0.05 drops near-invisible splats only: safe as a default.
    view_opacity_min: float = 0.05


PRESETS = {
    "preview": Preset(
        frames=100,
        max_resolution=1536,
        total_steps=10_000,
        growth_stop=6_000,
        max_splats=1_500_000,
        export_every=500,
    ),
    "high": Preset(
        frames=200,
        max_resolution=2048,
        # 18k, not 30k: held-out PSNR stops moving once densification stops. Growth ends at
        # 15k either way, and the 12k steps after it were buying nothing measurable — n=5 per
        # arm puts the difference at +0.39 dB in 18k's favour, 95% CI [-0.16, +0.93], against
        # 1.78x the training speed. Not a quality *gain*: the interval includes zero. The
        # claim is that it is no worse, and 2x faster. See docs/step-count.md.
        # growth_stop stays at 15k on purpose — it is the arm that was actually measured.
        total_steps=18_000,
        growth_stop=15_000,
        max_splats=4_000_000,
        export_every=1000,
    ),
    "max": Preset(
        frames=250,
        max_resolution=2560,
        total_steps=45_000,
        growth_stop=25_000,
        max_splats=6_000_000,
        export_every=1000,
        lpips_weight=0.25,
    ),
}

DEFAULT_PRESET = "high"
