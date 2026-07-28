# Step count: why `high` trains 18k steps, not 30k

`high` used to train 30,000 steps. It now trains 18,000, which is **2.04x faster on the
training stage** with no measurable quality cost. This is the measurement behind that.

Everything below was run on `jobs/934589be6407` — 165 frames at 2048 px, the scene in the
README's demo GIFs — with `scripts/eval.py`, on an M5 Pro MacBook Pro. Poses are
byte-identical across every arm, so nothing here is contaminated by COLMAP's RANSAC
variance; the only nondeterminism is Brush's.

## The hypothesis

Densification stalls long before the step budget does. `high` caps splats at 4M and the
scene settles at ~135k, so the cap never binds — growth stops on its own. `growth_stop` is
15,000, so the entire back half of a 30k run refines a splat set that is no longer changing
size.

## Where the noise floor actually is

**The 0.15 dB figure quoted in earlier work does not apply to full-length runs**, and this
was the single most important finding of the study.

That number was measured at 1,000 steps with ~27k splats. Real runs are 30k steps with
~135k splats, and MCMC densification's stochastic placement decisions compound across
training. Re-running one fixed config — same dataset, same `--seed 42`, same machine,
back to back:

| config | held-out PSNR across replicates | spread |
|---|---|---|
| 30k steps, growth_stop 15k | 35.15, 35.63, 35.11, 35.24, 35.11 | 0.52 dB |
| 18k steps, growth_stop 15k | 36.16, 35.75, 35.28, 35.02, 35.98 | 1.14 dB |

**The real floor is ~0.5 dB**, and it is not removed by fixing the seed — the residual is
GPU float ordering. Any A/B on this project needs n>=5 per arm. A single paired comparison
cannot resolve anything below about 1 dB, however long each arm trains.

Two corollaries that cost time to learn:

- Two runs agreeing closely is not evidence of stability. Two 30k runs landed 0.03 dB
  apart here; the third was 0.5 dB away.
- Per-image deltas are **not** independent samples. They are strongly correlated within a
  run — a lucky run lifts every held-out view together — so "21 of 21 views improved" is
  close to one sample, not 21.

## The result

n=5 per arm, all ten runs back to back on the same machine:

| arm | steps | growth_stop | mean PSNR | sd | training | splats |
|---|---|---|---|---|---|---|
| baseline | 30,000 | 15,000 | 35.25 | 0.22 | 1136 s | 135,620 |
| **shipped** | **18,000** | **15,000** | **35.64** | 0.48 | **639 s** | 132,679 |

**Difference +0.39 dB in 18k's favour, t=1.65, 95% CI [-0.16, +0.93].**

The interval includes zero, so *18k is better* is unproven and is not claimed. What the
interval does establish is non-inferiority: the worst plausible case is 18k being 0.16 dB
worse, which is a third of the run-to-run noise floor and far below anything visible.

The speed side needs no inference. Timed end to end with the pipeline's exact flags and no
held-out split (165 training views): **652.6 s against the README's measured 1330 s**, and
130,845 splats against 135,575.

Note the sd column: the shorter arm is *less* repeatable (0.48 vs 0.22). Longer training
converges to a more consistent result. 18k trades consistency for speed, not mean quality.

## What was tried and did not survive

- **A single-run checkpoint curve** (score every checkpoint of one 30k run) is a cheap
  screen but cannot settle this. Brush's schedules key off `total_train_iters`, not
  absolute iteration — the mean-position LR decays at
  `(lr_mean_end/lr_mean)^(1/total_train_iters)` (`brush-train/src/train.rs:122`), and refine
  and opacity decay both use `iter/total_train_iters` (`train.rs:415`, `:795`). A checkpoint
  at iter N of a longer run has not finished annealing where a dedicated N-step run has, so
  the curve understates short runs. It pointed at 18k, but for the wrong reason: it read
  18k->30k as flat-and-rising, where dedicated runs show no trend at all.
- **"Extra refinement actively hurts."** A tail sweep at fixed `growth_stop=15000` gave
  35.47 / 35.75 / 35.10 / 35.63 dB at tails of 1k / 3k / 7k / 15k steps. No trend — that is
  the 0.5 dB floor, sampled four times.
- **Scaling `growth_stop` with the step count.** An 18k arm with `growth_stop=9000` scored
  35.33 dB with 117k splats, against 36.16 for `growth_stop=15000`. Both n=1, and 35.33 sits
  inside the shipped arm's eventual 35.02-36.16 range, so this comparison establishes
  nothing. `growth_stop` stays at 15,000 because that is the arm with n=5 behind it, not
  because the ratio was shown to matter.

## Scope

Measured on one 165-frame indoor walkthrough. `preview` and `max` are untouched — the curve
was never measured for them, and their step counts should not be re-cut by analogy.
