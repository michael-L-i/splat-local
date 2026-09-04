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
textured, stationary scene. Start with automatic field of view and 2,000 steps.
Keep the tab open. Cancel stops reconstruction immediately or training after
its current five-step batch. Temporary browser files are removed after success,
failure or cancellation; force-closing/reloading a tab can leave temporary data
in site storage (clear that site's data to remove it).

`npm run build` assembles `dist/` for any static HTTPS host. The Pages workflow
publishes it at `/splat-local/create/` alongside the unchanged homepage/viewer
when deploying `web-demo` or `main`. Serve WASM with `application/wasm` and gzip/Brotli compression.
Brush's generated WASM is ~67 MB uncompressed / ~6 MB gzip, and is gitignored.
OpenCV and the viewer are bundled locally; there are no runtime CDN dependencies.

## Layout

- `src/frames.js`: browser video decoder → uniformly spaced 768 px JPEG frames.
- `src/sfm.js`, `geometry.js`, `sfm-worker.js`: OpenCV/WASM AKAZE matching,
  eight-point RANSAC initialization, incremental PnP and triangulation in a worker.
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
SPLAT_TEST_VIDEO=/absolute/path/to/clip.mp4 SPLAT_TEST_STEPS=2000 npm run test:e2e
```

To test the actual deployed site instead (no local server is started):

```sh
SPLAT_TEST_URL=https://michael-l-i.github.io/splat-local/create/ \
SPLAT_TEST_VIDEO=/absolute/path/to/clip.mp4 SPLAT_TEST_STEPS=5000 npm run test:e2e
```

The browser suite builds the production bundle and runs locally installed
Chrome, including real GPU training. It verifies the downloadable PLY's size,
vertex count and finite values, successful preview loading, no external/network
uploads, temporary-file cleanup, unsupported GPUs, invalid input and cancellation
followed by another training run. Without a clip, GPU-training tests are skipped.
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
No held-out PSNR/SSIM or broad browser/hardware benchmark has been performed.

## Limits / next quality work

- Fixed pinhole lens; automatic mode tries five FOVs and ranks camera coverage
  and reprojection error. This is a heuristic, not calibrated intrinsics.
- No bundle adjustment, lens-distortion estimation, loop closure or sharp-frame
  selection. Pure rotation, moving subjects and weak texture can fail or distort
  geometry. Registration ≥75% and low reprojection error are only basic gates.
- 16–32 frames, 768 px, SH1, 100k splat cap; PLY export only. No live splat preview
  during training yet. Mobile and GPU-loss recovery are not validated.
- Before promoting this as a general-purpose creator, improve joint camera/point
  refinement and benchmark against the native solver on the same held-out views.

Dependencies retain their licenses: [Brush](https://github.com/ArthurBrussee/brush)
(Apache-2.0), [OpenCV.js](https://github.com/TechStark/opencv-js) (Apache-2.0),
[ml-matrix](https://github.com/mljs/matrix) (MIT), and the existing vendored
three.js/Spark licenses. Do not remove notices when redistributing their bundles.
