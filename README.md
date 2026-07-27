<h1 align="center">Splat Local</h1>

<p align="center"><b>Walk through a space once. Get a 3D scene you can fly through forever.</b></p>

<p align="center">
  <img alt="100% local" src="https://img.shields.io/badge/runs-100%25_local-2ea44f">
  <img alt="Apple Silicon" src="https://img.shields.io/badge/Apple_Silicon-Metal_%2F_MPS-black?logo=apple&logoColor=white">
  <img alt="No cloud, no CUDA" src="https://img.shields.io/badge/cloud-none-blue">
  <img alt="Python 3.12" src="https://img.shields.io/badge/python-3.12-3776AB?logo=python&logoColor=white">
  <img alt="MIT License" src="https://img.shields.io/badge/license-MIT-lightgrey">
</p>

Turn a video walkthrough into a 3D Gaussian Splat and watch the scene resolve out of the fog, live, in your browser — no cloud, no CUDA, nothing leaves your Mac. Downloads as a full-resolution `.ply` (plus `.spz` when available).

<table>
<tr>
<th align="center">🎥 record a walkthrough</th>
<th align="center">✨ get an explorable 3D scene</th>
</tr>
<tr>
<td><img src="docs/demo/input.gif" width="380" alt="input: an 11s home walkthrough video"></td>
<td><img src="docs/demo/splat-tour.gif" width="380" alt="output: interactive splat, toured in the built-in viewer"></td>
</tr>
</table>

<sub>An 11 s phone-style walkthrough → a splat you can fly through with WASD/arrow keys. Reconstructed end-to-end in under 25 min on an M5 Pro MacBook — 166 frames, COLMAP poses, 30k training steps. Footage: [Pexels #7578547](https://www.pexels.com/video/video-of-a-house-interior-7578547/) (free license).</sub>

## Why

- **Actually local.** Poses, training, and the viewer all run on your machine — nothing uploaded, no API keys, no CUDA required.
- **You watch it build.** Training checkpoints stream straight into the browser viewer, so the scene sharpens from fog into a real space in real time instead of a progress bar.
- **Quality that holds up.** COLMAP-grade poses + a Metal-native trainer that matches CUDA gsplat output, not a lightweight approximation.

## How it works

```
video ──▶ sharp frames ──▶ camera poses ──▶ splat training ──▶ export
          (ffmpeg +        (COLMAP, or       (Brush: Metal-      (splat-transform:
           sharp-frames)    Depth Anything 3  native 3DGS w/      .ply/.spz archive
                            on MPS)           MCMC + mip AA)      + .sog for the viewer)
```

- **Poses**: [COLMAP](https://colmap.github.io) (`pycolmap`) with sequential matching + loop detection — best quality. Mapping runs on [GLOMAP](https://lpanaf.github.io/eccv24_glomap/)'s global solver, which is 1.2–2.0x faster than incremental mapping, with an automatic quality-gated fallback to the incremental mapper (see [Pose mapper](#pose-mapper)). Optional experimental backend: [Depth Anything 3](https://github.com/ByteDance-Seed/Depth-Anything-3) running on Apple's MPS — much faster, slightly lower fidelity.
- **Training**: [Brush](https://github.com/ArthurBrussee/brush) — a Rust/Metal Gaussian-splat trainer that matches CUDA gsplat quality (MCMC densification, Mip-Splatting antialiasing, optional LPIPS loss). It exports `.ply` checkpoints throughout training, which the UI streams into a live [Spark](https://sparkjs.dev) viewer.
- **Export**: two artifact families, split on purpose. The **archive** you download (`scene.ply`, `scene.spz`) is full resolution with SH3 and only NaN/degenerate gaussians dropped — no quality decisions applied. The **view** artifact (`scene-view.sog`) is the same scene with near-transparent splats filtered out and Morton-reordered, which is what the browser loads. Half the splats in a typical scene are nearly invisible but still cost fill rate, so filtering them cuts overdraw ~22% without touching what you keep.
- **Everything runs on your Mac.** No cloud, no CUDA.

## Quickstart

```bash
./setup.sh        # installs ffmpeg/uv if missing, syncs Python env, fetches/builds Brush
./run.sh          # serves http://127.0.0.1:8000
```

Upload a video, pick a preset, watch it build. Presets:

| Preset  | Frames | Res  | Steps | Poses    | Training | Total          |
|---------|--------|------|-------|----------|----------|----------------|
| Preview | 100    | 1536 | 10k   | ~1 min   | ~7 min   | **~8 min** ¹   |
| High    | 200    | 2048 | 30k   | 2–10 min | ~22 min  | **~25 min** ²  |
| Max     | 250    | 2560 | 45k   | 10–20 min| ~50 min  | **~1–1.5 h** ¹ |

<sub>Measured on an M5 Pro MacBook Pro (18-core, 48 GB unified memory).</sub>

<sub>² **High is measured end to end**: 166 frames at 2048 px, 30k steps → 11 s frame selection + 2 m 18 s COLMAP + 22 m 10 s training = **24 m 42 s**. This is the run in the demo GIFs above.</sub>

<sub>¹ Preview and Max are extrapolated from that run (training holds a steady ~22 steps/s across resolutions), not yet measured end to end.</sub>

**Pose time varies a lot with the scene.** COLMAP scales superlinearly with frame count and how hard the footage is to match — two runs here took 2 m 18 s at 166 frames and 10 m 1 s at 201 frames. Training time, by contrast, is predictable: it tracks step count almost exactly.

### Pose mapper

Mapping is the expensive part of the pose stage — 80% of it at 165 frames, 71% at 200. It runs
GLOMAP's global solver by default, then checks the result and automatically falls back to the
incremental mapper if it does not hold up. Measured on an M5 Pro, one paired run per scene, same
frames and identical feature settings, whole pose stage end to end:

| Frames | Incremental | GLOMAP + gate | Speedup | Mapping step alone |
|--------|-------------|---------------|---------|--------------------|
| 165    | 2 m 55 s    | **1 m 47 s**  | 1.64x   | 139.8 s → 70.6 s (1.98x) |
| 200    | 7 m 32 s    | **6 m 11 s**  | 1.22x   | 320.6 s → 238.9 s (1.34x) |

How much you save depends on the scene: the global solver's cost grows much more slowly than the
incremental one's, but so does the share of the stage it can address — feature extraction and
matching are untouched, and on the 200-frame scene they are already 28% of the total.

The gate exists because pose error is the one error training cannot recover from — no number of
steps fixes a blurred, ghosted scene — and global SfM is weakest exactly where this project
lives: low-parallax forward motion. Registering every frame is not enough evidence on its own,
so the gate also checks reprojection error, track length, observations per image, that the
recovered focal length is physically plausible, and that consecutive camera centres trace a
smooth path rather than jumping off it.

```bash
SPLAT_MAPPER=incremental ./run.sh   # off: incremental mapper only, exactly as before
SPLAT_MAPPER=glomap      ./run.sh   # forced: global mapper, fail instead of falling back
SPLAT_MAPPER=auto        ./run.sh   # default: global mapper, gated, auto-fallback
```

## Capture tips (quality lives and dies here)

- Move **slowly** in an orbit/arc with lots of overlap; end near where you started (loop closure).
- Lock exposure/white balance if you can; 4K 60 fps gives the frame picker more sharp frames.
- Avoid moving subjects, whip pans, and textureless walls/sky-only shots.

## Notes

- Optional DA3 pose backend: `uv sync --group da3` (Python 3.12 venv, installs PyTorch). Uses `depth-anything/DA3-LARGE` by default; override with `DA3_MODEL=depth-anything/DA3-SMALL ./run.sh` for speed.
- Optional `.spz` archive + `.sog` viewer export uses `npx @playcanvas/splat-transform` (needs Node). Without it you still get the raw `scene.ply`.
- Why not LingBot-World? It's an image→video *world generator* (28B params, CUDA-only, no 3D output) — the wrong tool for video→3D reconstruction, and it can't run on a Mac. This project uses the reconstruction stack that modern world-model papers themselves use for geometry.

## Layout

`server/` FastAPI + pipeline stages · `web/` vanilla-JS UI + Spark viewer · `vendor/` Brush binary + viewer libs · `jobs/` per-run work dirs (gitignored) · `docs/api.md` API contract
