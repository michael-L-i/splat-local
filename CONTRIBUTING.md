# Contributing to Splat Local

Thanks for helping. Bug reports, capture footage that breaks things, docs fixes and
code are all welcome. For anything larger than a small fix, open an issue first so
we can agree on the approach before you spend time on it.

One rule shapes every change: **the user's video never leaves their machine.** No
uploads, no hosted inference, no runtime CDN dependencies. A feature that needs a
server does not fit this project.

## Where things live

There are two pipelines that share a viewer. Most changes touch only one.

| Area | Path | Stack |
|---|---|---|
| Native pipeline (Apple Silicon) | `server/`, `web/` | Python 3.12, FastAPI, COLMAP, Brush |
| Browser creator (any desktop Chrome/Edge) | `browser/` | Vanilla JS, Vite, OpenCV/WASM, Brush/WASM |
| Shared viewer engine | `viewer/` | three.js + Spark |
| Demo site | `site/` | static HTML, assembled by `site/build.sh` |

The [README](README.md#layout) and [browser/README.md](browser/README.md#layout)
have the file-level maps.

## Setup

Native pipeline (needs an Apple Silicon Mac):

```bash
./setup.sh        # installs ffmpeg/uv if missing, syncs Python env, fetches/builds Brush
./run.sh          # serves http://127.0.0.1:8000
```

Browser creator (any OS; needs Node 22+, plus Rust and wasm-pack to build Brush):

```bash
cd browser
npm ci
npm run build:brush
npm run dev       # http://127.0.0.1:5173
```

Demo site:

```bash
./site/build.sh && python3 -m http.server -d _site 8080
```

## Tests

Run what CI runs before opening a pull request:

```bash
python -m unittest discover -s tests -v    # pipeline tests

cd browser
npm test                                   # geometry, SfM, refinement, quality
SPLAT_JS_ONLY=1 npm run build              # JS build without the Brush WASM
npm run test:e2e                           # UI tests (GPU training cases need a real GPU)
npm run test:site                          # assembled-site navigation
```

CI has no GPU, so it skips the tests that train a splat. If your change touches
training, reconstruction or rendering, run the full `npm run test:e2e` locally in
Chrome and say so in the pull request.

## Pull requests

- Branch from `main` and keep each pull request to one change.
- Match the surrounding code: vanilla JS with no framework, small modules, comments
  that explain why rather than what.
- Back quality and speed claims with numbers. `scripts/eval.py` measures held-out
  PSNR/SSIM for the native pipeline; the browser creator's run report does the same
  when "Reserve frames for quality checks" is on. The write-ups in `docs/` show the
  level of evidence expected.
- Do not commit videos, splats or `jobs/` output. Link to footage instead, and check
  that its license allows redistribution.

## Reporting a failed reconstruction

These are the most useful bug reports, and the hardest to act on without detail.
Please include:

- which pipeline (browser creator or native) and the preset you used
- the run report (`report.json`) or the technical run log from the page
- your browser and GPU, or your Mac model
- the clip itself if you can share it, or a description: length, resolution, how
  the camera moved, what the scene was

## Good first issues

Issues labelled [`good first issue`](https://github.com/michael-L-i/splat-local/labels/good%20first%20issue)
are scoped to one area and need no GPU debugging. Comment on one to claim it.

## Share what you made

Post your splats in [Discussions](https://github.com/michael-L-i/splat-local/discussions).
Captures that worked and captures that failed both help tune the defaults.
