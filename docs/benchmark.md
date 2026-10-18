# Benchmark: does a change help the clips that fail today?

`scripts/eval.py` compares training configs on one dataset with the poses held fixed. That is
the right tool for "is 18k steps as good as 30k", and the wrong one for most of what comes next:
longer videos, unusual camera paths, new frame selection, new feature matchers, feed-forward
poses. Those change which frames are used, whether they register, and what poses they get. The
question becomes whether more of the hard clips work, and whether the scene holds up away from
the frames it trained on.

`scripts/bench.py` runs the shipped pipeline (frames → poses → Brush) over a fixed list of
clips and records the answer per clip. A run measures one variant: whatever the checkout, preset
and environment are when it starts. Comparing two variants means running both and passing both
results files to `summarize`.

## The clip set

Each clip covers one way real captures go wrong. Keep the set small (6–10 clips): every variant
pays a full pipeline run per clip.

| Clip | What it stresses | Status |
|---|---|---|
| `interior-baseline` | Nothing. Smooth 11 s 4K interior; every default was tuned on it | have: Pexels #7578547 (the demo scene) |
| `exterior-foliage` | Fine foliage, sky | have: the 17.6 s exterior from the browser README |
| `bedroom-fast-turns` | ~60 s, fast turns, white walls, phone HEVC portrait with stabilization | have (private) |
| `multi-room-loop` | Length (2–5 min), several rooms, loop closure | to capture |
| `pan-in-place` | Pure rotation: no parallax to triangulate from | to capture |
| `forward-corridor` | Forward motion, little parallax at the image centre | to capture |
| `exposure-swing` | Auto-exposure changing through the clip | to capture |
| `people-moving` | Something in the scene that moves | to capture |

Capture the missing clips the way a first-time user would: phone defaults, handheld, no special
care. The point is to measure what breaks. Videos stay out of git (size, and some are private).
Copy `scripts/bench_clips.example.json` to `jobs/bench_clips.json`, which is gitignored, and
point it at your files; relative paths resolve against the manifest's folder. A clip whose
video is missing is recorded as `missing` and skipped, so the example works before every clip
exists.

## What gets measured

**Robustness**, for every clip and cheap enough to run on its own (`--poses-only`):

- frames extracted, and whether they came from sharp-frames or the ffmpeg fallback
- cameras registered out of frames extracted
- which mapper produced the poses: `glomap`, or `incremental*` when GLOMAP was rejected (the
  gate's reason is kept in `results.json`)
- the gate's health numbers: mean reprojection error, track length, observations per image,
  focal length, and the share of camera steps that jump off the path
- wall time of the frames and poses stages
- for a clip that fails, the stage and the error. Failures are results here, not crashes.

**Quality**, from one Brush training run per replicate, at the preset's training settings.
Held-out views are scored with `scripts/eval.py`'s resolution-normalised PSNR/SSIM, in two
groups:

- **near**: every 8th frame, starting at the 4th, skipping frames next to a far run. Each is one
  frame from a training view on both sides. This is the usual interpolation score.
- **far**: three runs of nine consecutive frames, centred at 1/6, 1/2 and 5/6 of the sequence
  and never at its ends. The middle of a run is five frames of camera motion from any training
  view. Shorter sequences get shorter runs, never more than a third of the frames together.

`far − near` is how fast quality falls off between captured views: the gap that matters when
someone looks around instead of retracing the path. Every held-out view also records its
distance to the nearest training camera, in frames and in *steps* (straight-line distance over
the median spacing between consecutive cameras), for plotting quality against distance from
`results.json`.

Brush cannot be told which views to hold out: it sorts images by name and holds out every Nth.
The bench copies the dataset with images renamed (hard links, no extra disk) so that the planned
frames land on those positions. When the planned set does not fit the every-Nth pattern exactly,
a few near frames go back to training; the count is recorded as `returned_to_train`.
`scripts/bench_holdout.py` has the details and `tests/test_bench_holdout.py` checks the result.

## Running it

```bash
cp scripts/bench_clips.example.json jobs/bench_clips.json   # then edit the paths

# robustness only: frames + poses, minutes per clip
uv run scripts/bench.py run --manifest jobs/bench_clips.json --poses-only --label baseline

# everything, three training replicates per clip
uv run scripts/bench.py run --manifest jobs/bench_clips.json --reps 3 --label baseline

# a variant, then the comparison
SPLAT_MAPPER=incremental uv run scripts/bench.py run --manifest jobs/bench_clips.json --label incremental
uv run scripts/bench.py summarize jobs/_bench/<baseline>/results.json jobs/_bench/<incremental>/results.json
```

Use the project venv (`uv run`); the frames stage runs the `sharp-frames` executable next to its
Python. The run warns when sharp-frames will not start, because the stage then quietly falls back
to evenly spaced frames. A venv made before the checkout was moved does this; recreate it with
`rm -rf .venv && uv sync`.

Other useful flags: `--clip NAME` (repeatable) to run a subset, `--set FIELD=VALUE` to override
a preset field (`--set frames=400` tries more frames on long clips without a code change),
`--backend da3`, `--resume` with `--out` to continue an interrupted run, and `--blocks`,
`--block-len`, `--every` to change the held-out groups.

**Cost.** On the M5 Pro, the `high` poses stage took 2–10 minutes on short clips and grows
faster than linearly with frames. Training is ~11 minutes per replicate per clip. Eight clips at
three replicates is therefore most of a day. To screen ideas, train cheaper and confirm
winners at full settings:

```bash
uv run scripts/bench.py run --manifest jobs/bench_clips.json \
  --set max_resolution=1024 --set total_steps=7000 --set growth_stop=5000 --label screen
```

Everything lands in `jobs/_bench/<time>-<label>/`: the clip work dirs, Brush's eval renders and
`results.json`. Expect a few GB per full run; delete old runs when done.

## Reading the numbers

- **The noise floor is ~0.5 dB.** Identical full-length runs differ by that much
  ([step-count.md](step-count.md)). A single replicate cannot resolve a change under ~1 dB;
  use `--reps 3` or more before believing one.
- **`--reps` only resamples training.** Replicates share one set of poses. COLMAP's RANSAC is
  random too; for a change to the pose stage, repeat the whole run with different labels.
- **Per-view scores inside a run are correlated.** A lucky run lifts every view together, so
  "40 of 45 views improved" is close to one sample, not 40.
- **Held-out frames help pose the scene.** They go through SfM with everything else, as in the
  standard every-8th protocol. They are never trained on.
- **When frame selection changes, the held-out frames change with it.** Groups are chosen by
  position in the selected sequence, not by timestamp, so far runs cover the same part of the
  clip but not the same frames.
- **Far is still on the captured path.** It measures fall-off between captured views, not
  free-viewpoint quality. The honest off-path test is a second pass over the same space,
  registered together with the first and never trained on. That is the next step for this
  benchmark, not something it does yet.
