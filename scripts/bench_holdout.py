"""Held-out view selection for scripts/bench.py. Pure Python, so CI can test it without the
pipeline's dependencies.

Two groups of frames are withheld from training:

- **far**: a few short runs of consecutive frames, spread through the clip. A view in the middle
  of a run is several frames of camera motion from the nearest training view, so its score says
  how quickly quality falls off between (and, roughly, away from) the captured views.
- **near**: every Nth remaining frame, one frame from a training view on each side. This is the
  usual interpolation score, and the one scripts/eval.py reports.

Brush cannot be told which views to hold out. After sorting images by name it holds out view i
when ``i % eval_split_every == 0`` (brush-dataset/src/formats/mod.rs, ``split_eval_every``).
assign_slots() orders the frames so that the chosen eval frames land on exactly those positions;
bench.py then renames copies of the images to fix that order. Training samples views at random,
so the order means nothing else to Brush.
"""

from __future__ import annotations

import math
import statistics


def plan_holdout(n: int, blocks: int = 3, block_len: int = 9, every: int = 8):
    """Choose held-out frames from ``n`` registered frames in capture order.

    Returns ``(far, near)`` as sorted index lists. Far runs are centred at evenly spaced points
    of the sequence and never touch its first or last frame, so each one has training views on
    both sides. Short sequences get shorter runs: together they never exceed a third of the
    frames. Near frames start half a period in (the first frame would be extrapolation, not
    interpolation) and skip anything next to a far run, which would otherwise lose a neighbour.
    ``blocks=0`` or ``every=0`` turns a group off.
    """
    if n < 4:
        return [], []
    far: set[int] = set()
    block_len = min(block_len, n // (3 * blocks)) if blocks > 0 else 0
    if block_len >= 1:
        for b in range(blocks):
            start = round((b + 0.5) * n / blocks - block_len / 2)
            start = max(1, min(start, n - 1 - block_len))
            far.update(range(start, start + block_len))
    touching = far | {i - 1 for i in far} | {i + 1 for i in far}
    near = [i for i in range(every // 2, n, every) if i not in touching] if every > 0 else []
    return sorted(far), near


def _thin(items: list, count: int) -> tuple[list, list]:
    """Split ``items`` into ``count`` kept items spread evenly through it, and the rest."""
    if count >= len(items):
        return list(items), []
    if count <= 0:
        return [], list(items)
    # Spacing len/count > 1, so the rounded positions are distinct and stay in range.
    keep = {round((j + 0.5) * len(items) / count - 0.5) for j in range(count)}
    return ([x for i, x in enumerate(items) if i in keep],
            [x for i, x in enumerate(items) if i not in keep])


def assign_slots(train, required, optional=()):
    """Order frames so that Brush's ``i % split == 0`` rule holds out exactly the eval frames.

    Returns ``(split, order, evals, returned)``: the ``--eval-split-every`` value, the frames as
    ``(item, is_eval)`` pairs in the order they must sort in, the frames actually held out, and
    the planned eval frames that did not fit and were moved to training.

    With m frames of which k are eval, split = ceil(m / k) gives ceil(m / split) <= k eval
    positions. When that is fewer than k, the surplus goes back to training: optional frames
    first, evenly thinned so the rest stay spread out, then required ones the same way.
    """
    train, required, optional = list(train), list(required), list(optional)
    k = len(required) + len(optional)
    m = len(train) + k
    if k == 0:
        return None, [(t, False) for t in train], [], []
    if not train:
        raise ValueError("at least one frame has to stay in training")
    split = math.ceil(m / k)
    excess = k - math.ceil(m / split)
    optional, returned = _thin(optional, len(optional) - excess)
    excess -= len(returned)
    if excess > 0:
        required, back = _thin(required, len(required) - excess)
        returned += back
    evals = required + optional
    pending_eval, pending_train = iter(evals), iter(train + returned)
    order = [(next(pending_eval), True) if p % split == 0 else (next(pending_train), False)
             for p in range(m)]
    return split, order, evals, returned


def path_distances(centers, train, evals) -> dict:
    """How far each held-out camera is from the nearest training camera.

    ``frames_away`` counts frames in capture order. ``steps_away`` is the straight-line distance
    in units of the median spacing between consecutive cameras: scale-free, and comparable
    between clips walked at different speeds. It is None when the camera never moved.
    """
    spacing = [math.dist(a, b) for a, b in zip(centers, centers[1:])]
    median = statistics.median(spacing) if spacing else 0.0
    out = {}
    for e in evals:
        nearest = min(math.dist(centers[e], centers[t]) for t in train)
        out[e] = {
            "frames_away": min(abs(e - t) for t in train),
            "steps_away": nearest / median if median > 0 else None,
        }
    return out
