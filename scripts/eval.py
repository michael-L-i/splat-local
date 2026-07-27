#!/usr/bin/env python3
"""Held-out PSNR/SSIM + throughput for Brush training configs.

Dev tooling, not part of the pipeline. It exists so that quality/speed trades — dropping `high`
from 2048 to 1536 px, lowering SH degree, turning mip off — can be argued from numbers.

Each named config is trained on the same dataset with the same held-out eval split
(`--eval-split-every`, deterministic in Brush, so every config is scored on the *same* images,
which are never trained on). Brush saves its eval renders; this script pairs each with its
ground-truth frame, normalises both to a fixed reference resolution, and computes PSNR and SSIM
alongside wall time, steps/s and final splat count.

Cross-resolution fairness: Brush evaluates at the training resolution, so raw PSNR from a
1536 px run and a 2048 px run are not comparable — the lower-resolution run is scored against a
smaller, easier target. Both render and ground truth are therefore resampled to `--ref-res`
(long edge, default 2048 = the current `high` preset's training resolution) before any metric
runs. A lower-resolution run gets upsampled to the reference, which is the point: it pays for
detail it never reconstructed, at the resolution the scene is actually viewed at. See
`eval_metrics.py` for the resampling filters. The `PSNR@train` column is Brush's own number at
the training resolution — printed as a cross-check, and precisely the number you must not
compare across resolutions.

Runs are driven with `RUST_LOG=info` (Brush's progress UI is invisible when stdout is not a
tty), and the full log is kept next to each config's renders. steps/s is measured over the
training loop only, so it excludes dataset load — but it is only comparable between configs run
at the same `--steps`, since per-step cost grows with splat count.

    # smoke run (~1 min)
    scripts/eval.py --dataset jobs/934589be6407/dataset --config res1024 --steps 1000

    # the real thing (hours — see below)
    scripts/eval.py --dataset jobs/934589be6407/dataset --config high --config res1536

    # re-print / diff tables from previous runs
    scripts/eval.py --summarize jobs/_eval/*/results.json

Expected runtime of a real comparison. Measured on an M5 Pro, 165 images, one variable at a
time: 2048 px runs at ~34 steps/s, 1536 px at ~54, 1024 px at ~91. A full 30k-step run is
therefore ~15 min at 2048 px and ~9 min at 1536 px of training alone, plus ~1 min dataset load
and ~10 s per eval pass. A two-config A/B at 30k steps is roughly **40-50 minutes**; the six
configs below are **~2.5 hours**. Budget accordingly — and use `--steps` to smoke-test the
plumbing first.
"""

from __future__ import annotations

import argparse
import json
import os
import re
import statistics
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from eval_metrics import compare  # noqa: E402
from server.stages.train_brush import _resolve_bin  # noqa: E402

# Flags shared by every config: the current `high` preset's quality knobs.
BASE_FLAGS = {
    "--sh-degree": "3",
    "--max-resolution": "2048",
    "--render-mode": "mip",
}

# Named configs, as overrides on BASE_FLAGS. These mirror the throughput sweep already measured
# on this machine (steps/s at 165 images, 4000 steps, M5 Pro), noted here so a quality number
# can be read against its speed cost.
CONFIGS: dict[str, dict[str, str]] = {
    "high": {},                                     # 34.3 steps/s — the incumbent
    "res1536": {"--max-resolution": "1536"},        # 54.3
    "res1024": {"--max-resolution": "1024"},        # 91.1
    "sh2": {"--sh-degree": "2"},                    # 34.5
    "sh1": {"--sh-degree": "1"},                    # 34.8
    "nomip": {"--render-mode": "default"},          # 35.4
    "ssim0": {"--ssim-weight": "0"},                # 39.0
}

# Brush's CLI draws with indicatif, which goes silent when stdout is not a tty — RUST_LOG=info
# is the only way to see anything from a piped run. These are the lines worth reading.
_LOG_LINE_RE = re.compile(r"^\[(\S+) +\w+ +([\w:]+)\] (.*)$")
_TRAIN_START = "Start training loop"
_TRAIN_DONE = "Done training"
_EVAL_RE = re.compile(r"Eval iter (\d+): PSNR ([\d.]+), ssim ([\d.]+)")
_SPLIT_RE = re.compile(r"Loaded dataset with (\d+) training, (\d+) eval views")
_INTERESTING = ("brush_cli", "brush_process", "brush_dataset")


def _stamp(text: str) -> datetime | None:
    try:
        return datetime.strptime(text, "%Y-%m-%dT%H:%M:%SZ")
    except ValueError:
        return None


def ply_splat_count(path: Path) -> int | None:
    with path.open("rb") as f:
        for _ in range(64):
            line = f.readline().decode("ascii", "replace").strip()
            if line.startswith("element vertex"):
                return int(line.split()[-1])
            if line == "end_header" or not line:
                break
    return None


def brush_capabilities(bin_path: str) -> tuple[str, bool]:
    help_text = subprocess.run(
        [bin_path, "--help"], capture_output=True, text=True, timeout=30,
    ).stdout
    steps_flag = "--total-train-iters" if "--total-train-iters" in help_text else "--total-steps"
    return steps_flag, "--render-mode" in help_text


def flatten(flags: dict[str, str]) -> list[str]:
    return [tok for k, v in flags.items() for tok in ((k, v) if v is not None else (k,))]


def run_config(name: str, flags: dict[str, str], args, dataset: Path, out_dir: Path,
               n_train_views: int, bin_path: str, steps_flag: str, supports_mip: bool) -> dict:
    verbose = args.verbose
    out_dir.mkdir(parents=True, exist_ok=True)
    merged = {**BASE_FLAGS, **flags}
    if not supports_mip:
        merged.pop("--render-mode", None)

    cmd = [
        bin_path, str(dataset),
        steps_flag, str(args.steps),
        "--seed", str(args.seed),
        "--max-splats", str(args.max_splats),
        "--growth-stop-iter", str(args.growth_stop or args.steps // 2),
        "--refine-every", str(max(n_train_views, 1)),
        "--eval-split-every", str(args.eval_split_every),
        "--eval-every", str(args.eval_every or args.steps),
        "--eval-save-to-disk",
        "--export-every", str(args.steps),
        "--export-path", str(out_dir),
        "--export-name", "export_{iter}.ply",
        *flatten(merged),
    ]

    print(f"\n=== {name} ===\n{' '.join(cmd)}", flush=True)
    env = {**os.environ}
    env.setdefault("RUST_LOG", "info")

    started = time.monotonic()
    proc = subprocess.Popen(
        cmd, stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1, env=env,
    )
    log_lines: list[str] = []
    train_start = train_end = None
    native_evals: list[dict] = []
    reported_split = None
    for line in proc.stdout:
        log_lines.append(line)
        m = _LOG_LINE_RE.match(line.strip())
        if not m:
            continue
        stamp, module, body = m.group(1), m.group(2), m.group(3)
        if body.startswith(_TRAIN_START):
            train_start = _stamp(stamp)
        elif body.startswith(_TRAIN_DONE):
            train_end = _stamp(stamp)
        elif ev := _EVAL_RE.search(body):
            # Brush's own PSNR/SSIM, at the *training* resolution: kept only as a cross-check,
            # never compared across configs with different --max-resolution.
            native_evals.append({
                "iter": int(ev.group(1)),
                "psnr": float(ev.group(2)),
                "ssim": float(ev.group(3)),
            })
        elif sp := _SPLIT_RE.search(body):
            reported_split = {"train": int(sp.group(1)), "eval": int(sp.group(2))}
        if verbose or module.split("::")[0] in _INTERESTING:
            print(f"  [{name}] {body}", flush=True)
    proc.wait()
    wall_s = time.monotonic() - started
    (out_dir / "brush.log").write_text("".join(log_lines))
    if proc.returncode != 0:
        raise RuntimeError(
            f"brush failed for config '{name}' (see {out_dir / 'brush.log'}):\n"
            + "".join(log_lines[-20:])
        )
    if reported_split and reported_split["eval"] == 0:
        raise RuntimeError(f"config '{name}': brush held out 0 eval views")

    plys = sorted(out_dir.glob("export_*.ply"),
                  key=lambda p: int(re.search(r"(\d+)", p.name).group(1)))
    eval_dirs = sorted(out_dir.glob("eval_*"),
                       key=lambda p: int(re.search(r"(\d+)", p.name).group(1)))
    if not eval_dirs:
        raise RuntimeError(
            f"config '{name}' produced no eval renders — is --eval-split-every too large "
            f"for a {n_train_views}-view dataset?"
        )

    # steps/s is measured over the training loop only (Brush's own log timestamps), so dataset
    # load is excluded and the number is comparable with the throughput sweep in the docstring.
    # It is only meaningful between configs run at the *same* --steps: splat count grows during
    # training, so a short run is cheap per step.
    train_s = (train_end - train_start).total_seconds() if train_start and train_end else None
    timed_s = train_s or wall_s
    return {
        "config": name,
        "flags": merged,
        "cmd": cmd,
        "wall_s": round(wall_s, 1),
        "train_s": round(train_s, 1) if train_s else None,
        "steps_per_s": round(args.steps / timed_s, 1) if timed_s else None,
        "steps_per_s_basis": "training loop" if train_s else "wall clock (no brush log)",
        "splats": ply_splat_count(plys[-1]) if plys else None,
        "brush_native_eval": native_evals[-1] if native_evals else None,
        "brush_split": reported_split,
        "eval_dir": str(eval_dirs[-1]),
    }


def score(result: dict, gt_dir: Path, ref_res: int) -> dict:
    """Pair each saved eval render with its ground-truth frame and score it."""
    eval_dir = Path(result["eval_dir"])
    renders = sorted(eval_dir.glob("*.png"))
    per_image = []
    for render in renders:
        # Brush names eval renders "<original filename>.png", e.g. frame_00009.jpg.png.
        gt = gt_dir / render.name[: -len(".png")]
        if not gt.exists():
            matches = list(gt_dir.glob(Path(render.name).stem.split(".")[0] + ".*"))
            if not matches:
                raise RuntimeError(f"no ground-truth frame for eval render {render.name}")
            gt = matches[0]
        per_image.append(compare(render, gt, ref_res))

    if not per_image:
        raise RuntimeError(f"no eval renders in {eval_dir}")
    result["eval_images"] = len(per_image)
    result["psnr"] = round(statistics.fmean(p["psnr"] for p in per_image), 3)
    result["ssim"] = round(statistics.fmean(p["ssim"] for p in per_image), 4)
    result["compared_size"] = per_image[0]["compared_size"]
    result["render_size"] = per_image[0]["render_size"]
    native = result.get("brush_native_eval")
    result["psnr_train_res"] = round(native["psnr"], 3) if native else None
    result["per_image"] = per_image
    return result


def print_table(runs: list[dict], header: str = "") -> None:
    cols = [
        ("config", "config", "{}"),
        ("psnr", "PSNR", "{:.2f}"),
        ("ssim", "SSIM", "{:.4f}"),
        ("psnr_train_res", "PSNR@train", "{:.2f}"),
        ("steps_per_s", "steps/s", "{:.1f}"),
        ("wall_s", "wall", "{:.0f}s"),
        ("splats", "splats", "{:,}"),
        ("render_size", "render", "{}"),
    ]
    rows = []
    for r in runs:
        row = []
        for key, _, fmt in cols:
            v = r.get(key)
            if key == "render_size" and v:
                v = f"{v[0]}x{v[1]}"
                row.append(v)
            else:
                row.append(fmt.format(v) if v is not None else "-")
        rows.append(row)
    widths = [max(len(h), *(len(row[i]) for row in rows)) for i, (_, h, _) in enumerate(cols)]
    if header:
        print(f"\n{header}")
    print("  ".join(h.ljust(w) for (_, h, _), w in zip(cols, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths)))


def summarize(paths: list[Path]) -> None:
    for path in paths:
        data = json.loads(path.read_text())
        print_table(
            data["results"],
            f"{path}  ·  {data['dataset']}  ·  {data['steps']} steps  ·  "
            f"ref {data['ref_res']} px  ·  eval split every {data['eval_split_every']} "
            f"({data.get('eval_views', '?')} held-out views)",
        )


def main() -> int:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter,
    )
    p.add_argument("--dataset", type=Path, help="COLMAP dataset dir (contains images/ and sparse/)")
    p.add_argument("--config", action="append", dest="configs", metavar="NAME",
                   help=f"config to run, repeatable. Known: {', '.join(CONFIGS)}")
    p.add_argument("--define", action="append", default=[], metavar="NAME=--flag val,...",
                   help="ad-hoc config, e.g. --define res1280=--max-resolution 1280")
    p.add_argument("--steps", type=int, default=30_000, help="training steps (default 30000)")
    p.add_argument("--ref-res", type=int, default=2048,
                   help="reference long edge every render and GT is resampled to (default 2048)")
    p.add_argument("--eval-split-every", type=int, default=8,
                   help="hold out every Nth image (default 8)")
    p.add_argument("--eval-every", type=int, default=None,
                   help="eval frequency in steps (default: only at the final step)")
    p.add_argument("--seed", type=int, default=42)
    p.add_argument("--max-splats", type=int, default=4_000_000)
    p.add_argument("--growth-stop", type=int, default=None, help="default: steps/2")
    p.add_argument("--out", type=Path, default=None,
                   help="output dir (default jobs/_eval/<timestamp>, gitignored)")
    p.add_argument("--list-configs", action="store_true")
    p.add_argument("--verbose", action="store_true", help="echo every Brush log line")
    p.add_argument("--summarize", nargs="+", type=Path, metavar="RESULTS.JSON",
                   help="print tables from previous results files and exit")
    args = p.parse_args()

    if args.list_configs:
        for name, flags in CONFIGS.items():
            print(f"{name:<10} {flags or '(baseline)'}")
        return 0
    if args.summarize:
        summarize(args.summarize)
        return 0
    if not args.dataset:
        p.error("--dataset is required")

    configs = dict(CONFIGS)
    for spec in args.define:
        name, _, flag_str = spec.partition("=")
        toks = flag_str.replace(",", " ").split()
        configs[name] = dict(zip(toks[::2], toks[1::2]))
        args.configs = (args.configs or []) + [name]

    names = args.configs or ["high"]
    unknown = [n for n in names if n not in configs]
    if unknown:
        p.error(f"unknown config(s): {', '.join(unknown)}. Known: {', '.join(configs)}")

    dataset = args.dataset.resolve()
    gt_dir = dataset / "images"
    if not gt_dir.is_dir():
        p.error(f"no images/ under {dataset}")
    n_images = len([f for f in gt_dir.iterdir() if f.is_file() and not f.name.startswith(".")])
    n_eval = len(range(0, n_images, args.eval_split_every))
    n_train = n_images - n_eval

    out_root = args.out or _PROJECT_ROOT / "jobs" / "_eval" / time.strftime("%Y%m%d-%H%M%S")
    out_root.mkdir(parents=True, exist_ok=True)

    bin_path = _resolve_bin()
    steps_flag, supports_mip = brush_capabilities(bin_path)
    print(f"brush:   {bin_path}\ndataset: {dataset} ({n_images} images -> "
          f"{n_train} train / {n_eval} held out)\nout:     {out_root}\n"
          f"configs: {', '.join(names)}  ·  {args.steps} steps  ·  ref {args.ref_res} px")

    results = []
    for name in names:
        run = run_config(name, configs[name], args, dataset, out_root / name,
                         n_train, bin_path, steps_flag, supports_mip)
        results.append(score(run, gt_dir, args.ref_res))
        payload = {
            "dataset": str(dataset),
            "images": n_images,
            "train_views": n_train,
            "eval_views": n_eval,
            "eval_split_every": args.eval_split_every,
            "ref_res": args.ref_res,
            "steps": args.steps,
            "seed": args.seed,
            "brush_bin": bin_path,
            "generated_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
            "results": results,
        }
        (out_root / "results.json").write_text(json.dumps(payload, indent=2))

    print_table(results, f"held-out eval · {n_eval} views · normalised to {args.ref_res} px "
                         f"long edge · {args.steps} steps")
    print(f"\nresults: {out_root / 'results.json'}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
