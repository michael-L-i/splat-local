# Browser lab

Experimental video → camera poses → Brush training → view/download, entirely on
the visitor's device. No Python service, video uploads or external inference API.
The existing native app and public demo are unchanged.

## Run

Build-machine prerequisites: Node 22+, Rust with the `wasm32-unknown-unknown`
target, and [wasm-pack](https://rustwasm.github.io/wasm-pack/installer/).
Visitors only need desktop Chrome/Edge with WebGPU subgroups and browser storage.

```sh
cd browser
npm ci
npm run build:brush
npm run dev                 # http://127.0.0.1:5173
```

Choose a 1–60 second video, preferably a short, slow sideways move around a
textured, stationary scene. Start with **Balanced** and automatic field of view.
Keep the tab open. Cancel stops reconstruction immediately or training after
its current five-step batch. Temporary browser files are removed after success,
failure or cancellation; force-closing/reloading a tab can leave temporary data
in site storage (clear that site's data to remove it).

| Preset | Frames | Long edge | Steps | Splat cap | SH degree |
|---|---:|---:|---:|---:|---:|
| Quick preview | 24 | 768 px | 2,000 | 100k | 1 |
| Balanced | 32 | 960 px | 5,000 | 200k | 2 |
| More detail | 48 | 1024 px | 10,000 | 300k | 2 |

Advanced settings override frame/step counts. Frame selection first surveys three
times as many small frames, then spreads the chosen views along the camera's
movement (70% image change, 30% time), so fast turns get more views and a paused
camera fewer. Within each slot the sharpest frame wins; frames much softer than
their neighbours, or barely moved from the previous pick, are a last resort. The
survey costs one extra seek per chosen frame. Turning the option off samples
evenly in time. Optional
quality checks withhold every eighth registered view from **splat training**
(not camera reconstruction), recording PSNR/SSIM in the run report. These scores
are diagnostic, not proof of accurate geometry or good unseen viewpoints.

The interface previews the source video, shows creation stages and elapsed time,
and keeps the last successful download/scene through failed or cancelled retries.
Captured-view arrows follow the recovered path and Reset view returns to its
first camera; free orbit targets median scene depth. The preview keeps the input's
aspect ratio. Screen wake lock is best-effort; closing the tab loses the run.

`npm run build` assembles `dist/` for any static HTTPS host. The Pages workflow
publishes it at `/splat-local/create/` alongside the unchanged homepage/viewer
when deploying `web-demo` or `main`. Serve WASM with `application/wasm` and gzip/Brotli compression.
Brush's generated WASM is ~67 MB uncompressed / ~6 MB gzip, and is gitignored.
OpenCV and the viewer are bundled locally; there are no runtime CDN dependencies.

## Layout

- `../site/assets/theme.css`: shared colors and navigation for the homepage,
  viewer and creator. Vite bundles it into the creator; Pages copies it for the site.
- `src/frames.js`, `quality.js`: browser video decoder, blur/movement-aware frame selection and bounded presets.
- `src/support.js`: works out exactly which capability is missing (HTTPS, WebGPU, a GPU
  adapter, WebGPU subgroups, or browser storage) and what to tell the visitor.
- `src/sfm.js`, `geometry.js`, `sfm-worker.js`: OpenCV/WASM AKAZE matching,
  eight-point RANSAC initialization, incremental PnP and triangulation in a worker.
- `src/refine.js`: robust joint camera/point/focal/lens-distortion refinement (LM with
  Schur elimination); fixes the first pose, preserves baseline scale and rejects worsening
  steps. Manual focal length stays fixed. `sfm.js` runs it three times: a first pass, a
  final global pass after dropping observations over 4 px, and a pass that adds radial
  distortion (k1, k2). Distortion is kept only if it lowers the robust cost by at least
  3%; otherwise the lens stays a pinhole. Brush trains with the same OpenCV model.
- `src/dataset.js`: NeRF-style camera transforms, sparse PLY, temporary OPFS dataset.
- `src/train.js`: pinned Brush/WASM trainer, bounded settings, cancellation and export.
- `src/viewer.js`: existing shared Spark viewer rig, initially framed from a recovered camera.
- `src/app.js`: UI orchestration; no framework or server API.

`build-brush.sh` uses a separate source checkout pinned to
`3b80985709e2ec04fd6c8622a40e36473647a8e0`. The small `brush-export.patch` exposes
Brush's existing PLY serializer to JavaScript; it does not replace the native
trainer or implement another splat format. The lockfile is pinned too.

## Tests and actual results

```sh
npm test
npm run test:site
SPLAT_TEST_VIDEO=/absolute/path/to/clip.mp4 SPLAT_TEST_STEPS=2000 npm run test:e2e
```

`test:site` checks the assembled homepage → creator → viewer navigation, shared
theme, responsive layouts, demo rendering and file controls. It needs no test video.
The scene-rendering integration test runs locally; GitHub's software renderer
times out on this scene. CI covers navigation, layout and the no-WebGL fallback.
GPU-enabled runners can opt into the rendering test with `SPLAT_TEST_WEBGL=1`.

To test the actual deployed site instead (no local server is started):

```sh
SPLAT_TEST_URL=https://michael-l-i.github.io/splat-local/create/ \
SPLAT_TEST_VIDEO=/absolute/path/to/clip.mp4 SPLAT_TEST_STEPS=5000 npm run test:e2e
```

For a longer run with held-out image metrics:

```sh
SPLAT_TEST_VIDEO=/absolute/path/to/clip.mp4 SPLAT_TEST_QUALITY=detailed \
SPLAT_TEST_STEPS=10000 SPLAT_TEST_EVALUATE=1 npm run test:e2e
```

The browser suite builds the production bundle and runs locally installed
Chrome, including real GPU training. It verifies the downloadable PLY's size,
vertex count and finite values, successful preview loading, no external/network
uploads, temporary-file cleanup, unsupported browsers, invalid input and cancellation
followed by another training run, retained downloads after failures, preset
controls and responsive layouts. CI runs numerical tests, native regression tests,
and headless non-GPU UI checks; real GPU training is tested locally. Without a
clip, GPU-training tests are skipped.
Screenshots, a PLY and a JSON report are saved under gitignored `test-results/`.

Measured here on Apple Silicon, Chrome, 2026-09-04 (warm local asset delivery):

| Clip | Cameras | Median reprojection error | Steps | Splats | End to end |
|---|---:|---:|---:|---:|---:|
| 10.6 s indoor walkthrough | 24/24 | 0.84 px | 2,000 | ~41k | ~19 s |
| Same walkthrough | 24/24 | 0.84 px | 5,000 | 100k cap | ~48 s |
| 17.6 s house exterior | 24/24 | 0.72 px | 2,000 | ~38k | ~22 s |

Both used automatic lens selection and 768×432 frames. The scenes are
recognizable and navigable but blurry/streaky in places. These are prototype
completion measurements, **not a speed or quality comparison with native
COLMAP/Brush**: frame counts, resolution and training settings differ substantially.
Those original measurements did not include held-out PSNR/SSIM. No broad
browser/hardware benchmark has been performed.

### GitHub Pages verification (2026-09-04)

The actual public [creator](https://michael-l-i.github.io/splat-local/create/)
completed a freshly downloaded [Pexels #7578547](https://www.pexels.com/video/video-of-a-house-interior-7578547/)
video: 21.2 seconds of input, 24/24 registered cameras, 0.50 px median error,
5,000 training steps and 100,000 splats in 65.7 seconds on this Mac. The result
was recognizable but visibly blurry/streaky. All four browser tests passed
against the HTTPS URL with no local test server: export integrity, preview,
no external requests/uploads, invalid input, unsupported GPU and cancellation/retry.
GitHub served the WASM as `application/wasm` with gzip compression (~6.4 MB transfer).
The existing homepage's SHA-256 was unchanged before and after deployment.

This is a test deployment from `web-demo`, not a merge into `main`. Deploying
the old `main` workflow would restore the viewer-only site until these changes
are merged. Screenshots, the PLY, run report and network audit remain local,
gitignored test artifacts; the original video is not published with the site.

### Refinement branch measurements (2026-09-04)

Local production builds, same Mac/Chrome, full 21.2 s Pexels clip:

| Run | Cameras | Median error, before → after | Splats | End to end |
|---|---:|---:|---:|---:|
| Refinement only, original 24-frame / 768 px settings | 24/24 | 0.50 → 0.31 px | 100k | 59.7 s |
| Balanced, sharper frames | 32/32 | 0.51 → 0.27 px | 182k | 92.0 s |
| More detail, held-out check enabled | 48/48 | 0.50 → 0.28 px | 262k | 237.7 s |

The detailed run scored **26.72 dB PSNR / 0.897 SSIM** on the withheld images.
All registered views still contributed to camera reconstruction. Settings and
sample timestamps are saved in the report so comparisons can be reproduced.
The different presets are not controlled quality/speed comparisons; they use
different frames, resolutions, SH degrees and training budgets. Lower feature
reprojection error alone does not establish better rendered quality. Viewed
from the captured path the result is recognizable; free exploration still shows
blur, floaters and holes outside coverage. This is **not production-quality parity
with the native pipeline**. These improvements have not been redeployed; the
public test site remains on the previous revision pending PR review.

A second 17.6 s exterior clip also completed with Balanced + held-out checks:
32/32 cameras, 0.54 → 0.26 px median error, 200k splats in 109.9 s; held-out
23.42 dB PSNR / 0.612 SSIM. Foliage remains noticeably soft. Six browser checks
passed on that clip, including both cancellation stages and retained output.

### Frame selection, final adjustment and lens distortion (2026-09-20)

Local production builds, same Mac/Chrome, Balanced (32 frames, 960 px, 5,000 steps),
every eighth view withheld from training. "Before" is `main` at 633cfda.

| Clip | Frames | Build | Lens found | Median error | Held-out PSNR / SSIM | End to end |
|---|---|---|---|---:|---:|---:|
| 17.6 s exterior | evenly timed | before | 87° pinhole | 0.27 px | 23.21 dB / 0.605 | 102 s |
| 17.6 s exterior | evenly timed | after | 84° pinhole | 0.26 px | 23.34 dB / 0.615 | 109 s |
| 17.6 s exterior | selected | before | 87° pinhole | 0.26 px | 23.46 dB / 0.612 | 115 s |
| 17.6 s exterior | selected | after | 50°, k1 0.075, k2 0.150 | 0.25 px | 25.26 dB / 0.666 | 129 s |
| 21.2 s Pexels interior | evenly timed | before | 79° pinhole | 0.31 px | 23.10 dB / 0.839 | 84 s |
| 21.2 s Pexels interior | evenly timed | after | 81° pinhole | 0.31 px | 23.23 dB / 0.842 | 86 s |
| 21.2 s Pexels interior | selected | after | 75° pinhole | 0.32 px | 24.44 dB / 0.864 | 95 s |

What this does and does not show:

- The evenly timed rows use identical frames and withheld views, so they isolate the
  final global adjustment: about +0.1 dB, which is within run-to-run noise. Distortion
  was rejected as unnecessary in those runs.
- The "selected" rows pick different frames, so their withheld views differ too and
  the comparison is not controlled. Evenly spread views are also easier to predict
  from their neighbours. The +1.3 to +1.8 dB is encouraging, not proof.
- The exterior clip's estimated lens varies widely between frame sets (50° to 87° here,
  93° in a Node run on ffmpeg-decoded frames). Focal length and distortion are weakly
  constrained by this footage, so treat the reported lens as a fit, not a calibration.
- On copies of the exterior clip warped with ffmpeg `lenscorrection` (k1 = ±0.12), the
  Node harness recovered k1 shifted in the matching direction (−0.093 barrel, +0.046
  pincushion, −0.060 unwarped) with a 5–9% lower cost than a pinhole.
- Results are still soft in foliage and outside the captured path. This is one machine
  and two clips; it is **not parity with the native pipeline**.

## Limits / next quality work

- Automatic mode tries five FOVs, then jointly refines the selected focal length,
  radial distortion (k1, k2), cameras and points. This is not a substitute for
  calibrated intrinsics; tangential distortion, rolling shutter and a shifted
  principal point are not modelled. The in-page preview draws with a pinhole camera.
- No loop closure. Pure rotation, moving subjects and weak texture can fail or distort
  geometry. Registration ≥75% and low reprojection error are only basic gates.
- Up to 48 frames, 1024 px, SH2, 300k splat cap; PLY export plus a compressed SPZ. No live splat preview
  during training yet. Mobile and GPU-loss recovery are not validated.
- Before promoting this as production quality, benchmark against the native
  solver on the same held-out views and test multiple GPUs and capture styles.

Refinement follows the standard robust nonlinear least-squares / Schur approach
described in the [Ceres bundle-adjustment tutorial](https://ceres-solver.readthedocs.io/latest/nnls_tutorial.html#bundle-adjustment).
It uses the existing matrix dependency, not an additional runtime or backend.

Dependencies retain their licenses: [Brush](https://github.com/ArthurBrussee/brush)
(Apache-2.0), [OpenCV.js](https://github.com/TechStark/opencv-js) (Apache-2.0),
[ml-matrix](https://github.com/mljs/matrix) (MIT), and the existing vendored
three.js/Spark licenses. Do not remove notices when redistributing their bundles.
