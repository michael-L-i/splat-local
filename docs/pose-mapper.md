# Pose mapper: why the global solver is the default

Mapping is the expensive part of the pose stage — 80% of it at 165 frames, 71% at 200. Since the
GLOMAP change it runs the global solver by default and falls back to COLMAP's incremental mapper
whenever the result does not clear a quality gate. This is the evidence behind that decision.

Everything below was measured on an M5 Pro MacBook Pro (18-core, 48 GB), one paired run per scene,
same frames and identical feature settings.

## Timing

Whole pose stage, end to end, in seconds:

| scene        | frames | mapper      | features | match | calib |   map | undistort | total |
|--------------|--------|-------------|----------|-------|-------|-------|-----------|-------|
| 934589be6407 |    165 | incremental |     24.6 |   8.1 |     — | 139.8 |       2.1 | 174.6 |
| 934589be6407 |    165 | glomap      |     25.8 |   8.2 |   4.7 |  65.9 |       2.0 | 106.6 |
| 0c33c4547894 |    200 | incremental |     95.4 |  30.1 |     — | 320.6 |       6.0 | 452.1 |
| 0c33c4547894 |    200 | glomap      |     95.3 |  30.4 |   4.1 | 234.8 |       6.0 | 370.6 |

1.64x and 1.22x on the stage; 1.98x and 1.34x on mapping alone. The gap between those two pairs is
the point: extraction and matching are untouched, and at 200 frames they are already 28% of the
stage, so the stage-level win shrinks as scenes get harder to match.

## Accuracy

GLOMAP did not cost accuracy on either scene. It was slightly *better* on the pose-side metrics
that do not depend on training at all — mean reprojection error 0.83 vs 0.95 px and 0.61 vs
0.67 px — and it recovered a focal length within 0.7% and 0.05% of the incremental solution.

Downstream, which is the only measure that matters: same frames, same trainer config, 30k steps,
21 held-out views never trained on, normalised to 2048 px.

| poses               |  PSNR |   SSIM |  splats |
|---------------------|-------|--------|---------|
| incremental (run 1) | 35.18 | 0.9835 | 135,492 |
| incremental (run 2) | 35.99 | 0.9834 | 133,192 |
| glomap      (run 1) | 37.52 | 0.9840 | 129,212 |
| glomap      (run 2) | 36.10 | 0.9841 | 128,473 |

Read the *spread*, not the means. Two pose solutions from the same mapper on the same frames differ
by 0.81 dB (incremental) and 1.43 dB (glomap) — five to ten times the ~0.15 dB run-to-run training
noise floor, because both mappers are RANSAC-seeded and nondeterministic. So the +1.22 dB mean gap
in GLOMAP's favour is **not** a demonstrated win: at n=2 per arm the arms nearly touch (36.10 vs
35.99). What the data does support is the decision the gate needed — GLOMAP does not lose. Every
global run scored at or above every incremental run, on a metric where pose error shows up directly
as misregistered held-out renders.

The wider lesson for anyone re-running this: a pose change cannot be evaluated against the training
noise floor. Pose-solution variance dominates it by an order of magnitude, so a single A/B pair is
worth very little no matter how many training steps it gets.

## Why there is a gate at all

Pose error is the one error training cannot recover from — no number of steps fixes a blurred,
ghosted scene — and global SfM is weakest exactly where this project lives: low-parallax forward
motion. Registering every frame is not evidence enough on its own, because GLOMAP will happily
register every frame of a geometrically wrong solution. So `_gate()` in
[`server/stages/poses_colmap.py`](../server/stages/poses_colmap.py) also checks reprojection error,
track length, observations per image, that the recovered focal length is physically plausible, and
that consecutive camera centres trace a smooth path rather than jumping off it.

Every threshold is an absolute floor set well beneath what the incremental mapper actually measures
on real scenes, so the gate fires on collapse rather than on GLOMAP's normally sparser point cloud.

## Switching mappers

```bash
SPLAT_MAPPER=incremental ./run.sh   # off: incremental mapper only
SPLAT_MAPPER=glomap      ./run.sh   # forced: global mapper, fail instead of falling back
SPLAT_MAPPER=auto        ./run.sh   # default: global mapper, gated, auto-fallback
```

## Reproducing

The PSNR/SSIM table came from a held-out-view eval harness that is not on `main` — it lives on the
`eval-harness-holdout-psnr` branch. The timing tables need nothing but a stopwatch and the
`SPLAT_MAPPER` switch above.
