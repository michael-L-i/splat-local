#!/usr/bin/env python3
"""Run the native pipeline over a fixed set of hard clips and score each one.

scripts/eval.py answers "which training config is better on this one dataset". This answers
the question pipeline work needs: does a change make more of the clips that fail today work,
and does the result hold up away from the frames it trained on? It runs the shipped stages
(frames, poses, then Brush) on every clip in a manifest and records, per clip:

- capture: duration, resolution, codec, frame rate, rotation.
- poses: frames extracted and by what, cameras registered, which mapper produced them (and why
  GLOMAP was rejected, if it was), and the health numbers the GLOMAP gate reads: reprojection
  error, track length, observations per image, trajectory jumps. A failing clip is recorded
  with its stage and error, and the run moves on.
- quality (unless --poses-only): held-out PSNR/SSIM in two groups. "near" views are every
  8th frame, one frame from a training view: the usual interpolation score. "far" views sit
  inside short runs of consecutive frames withheld from training, several frames of camera
  motion from the nearest training view. far - near is how fast quality falls off between
  captured views. bench_holdout.py explains how the split reaches Brush unpatched.

A run measures one variant: whatever the checkout, preset and environment are when it starts.
Compare variants by running each and passing both results files to `summarize`.

    # robustness only: frames + poses, a few minutes per clip
    uv run scripts/bench.py run --manifest jobs/bench_clips.json --poses-only

    # full run, three training replicates per clip
    uv run scripts/bench.py run --manifest jobs/bench_clips.json --label baseline --reps 3

    # tables, and per-clip deltas when given two runs
    uv run scripts/bench.py summarize jobs/_bench/<run-a>/results.json jobs/_bench/<run-b>/results.json

Use the project venv's Python (uv run): the frames stage runs the sharp-frames executable next
to it. docs/benchmark.md covers the clip set, the protocol and what the numbers cannot show.
"""

from __future__ import annotations

import argparse
import dataclasses
import json
import math
import os
import platform
import re
import shutil
import statistics
import subprocess
import sys
import time
from pathlib import Path
from types import SimpleNamespace

_PROJECT_ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(_PROJECT_ROOT))
sys.path.insert(0, str(Path(__file__).resolve().parent))

from bench_holdout import assign_slots, path_distances, plan_holdout  # noqa: E402
from server.pipeline import Job  # noqa: E402
from server.presets import PRESETS  # noqa: E402

_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# Environment that changes what the pipeline does; recorded with every run.
_ENV_KEYS = ("SPLAT_MAPPER", "DA3_MODEL", "BRUSH_BIN")
# Clip states --resume keeps. "missing" is retried: the video may have been added since.
_FINISHED = ("ok", "failed", "train-failed")


class BenchJob(Job):
    """A pipeline Job that prints and keeps its progress messages instead of feeding the UI."""

    def __init__(self, name: str, preset_name: str, preset, backend: str, work: Path):
        super().__init__(name, preset_name, backend)
        self.preset = preset
        self.work = work
        self.messages: list[str] = []

    def update(self, **fields):
        super().update(**fields)
        message = fields.get("message")
        if message and (not self.messages or self.messages[-1] != message):
            self.messages.append(message)
            print(f"  [{self.id}] {message}", flush=True)


# --- inputs -------------------------------------------------------------------------------

def load_manifest(path: Path, only: list[str] | None) -> list[dict]:
    data = json.loads(path.read_text())
    entries = data.get("clips") if isinstance(data, dict) else data
    if not isinstance(entries, list) or not entries:
        raise SystemExit(f'{path}: expected a non-empty "clips" list')
    clips, seen = [], set()
    for entry in entries:
        name = entry.get("name", "")
        if not _NAME_RE.match(name) or name in seen:
            raise SystemExit(f"{path}: clip names must be unique and filename-safe, got {name!r}")
        seen.add(name)
        video = Path(os.path.expanduser(entry["video"]))
        if not video.is_absolute():
            video = path.parent / video
        clips.append({
            "name": name,
            "video": video.absolute(),
            "tags": list(entry.get("tags", [])),
            "notes": entry.get("notes", ""),
        })
    if only:
        unknown = set(only) - seen
        if unknown:
            raise SystemExit(f"unknown clip(s): {', '.join(sorted(unknown))}")
        clips = [c for c in clips if c["name"] in only]
    return clips


def apply_overrides(preset, specs: list[str]):
    """`--set total_steps=7000` style overrides of the preset's fields."""
    fields = {f.name for f in dataclasses.fields(preset)}
    changes = {}
    for spec in specs:
        key, sep, value = spec.partition("=")
        key = key.strip().replace("-", "_")
        if not sep or key not in fields:
            raise SystemExit(f"--set expects FIELD=VALUE, FIELD one of {', '.join(sorted(fields))}; "
                             f"got {spec!r}")
        kind = float if isinstance(getattr(preset, key), float) else int
        changes[key] = kind(value.strip())
    preset = dataclasses.replace(preset, **changes)
    if preset.growth_stop > preset.total_steps:
        print(f"note: growth_stop {preset.growth_stop} > total_steps {preset.total_steps}; "
              "splats will grow for the whole run", flush=True)
    return preset


def probe_video(video: Path) -> dict:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-select_streams", "v:0",
             "-show_entries", "format=duration,size:stream=codec_name,width,height,avg_frame_rate"
             ":stream_side_data=rotation",
             "-of", "json", str(video)],
            capture_output=True, text=True, check=True,
        )
        data = json.loads(out.stdout)
    except (OSError, subprocess.CalledProcessError, json.JSONDecodeError):
        return {}
    stream = (data.get("streams") or [{}])[0]
    fmt = data.get("format", {})
    num, _, den = stream.get("avg_frame_rate", "").partition("/")
    try:
        fps = round(float(num) / float(den), 2) if den and float(den) else None
    except ValueError:
        fps = None
    rotation = next((int(s["rotation"]) for s in stream.get("side_data_list", [])
                     if "rotation" in s), 0)
    return {
        "duration_s": round(float(fmt.get("duration", 0) or 0), 2),
        "width": stream.get("width"),
        "height": stream.get("height"),
        "codec": stream.get("codec_name"),
        "fps": fps,
        "rotation": rotation,
        "size_mb": round(int(fmt.get("size", 0) or 0) / 2**20, 1),
    }


def git_info() -> dict:
    def git(*args):
        return subprocess.run(["git", *args], cwd=_PROJECT_ROOT, capture_output=True,
                              text=True, check=True).stdout.strip()
    try:
        return {"commit": git("rev-parse", "--short", "HEAD"),
                "branch": git("rev-parse", "--abbrev-ref", "HEAD"),
                "dirty": bool(git("status", "--porcelain"))}
    except (OSError, subprocess.CalledProcessError):
        return {}


def machine_info() -> dict:
    info = {"machine": platform.machine(), "macos": platform.mac_ver()[0] or None}
    try:
        info["cpu"] = subprocess.run(["sysctl", "-n", "machdep.cpu.brand_string"],
                                     capture_output=True, text=True, check=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        pass
    return info


def sharp_frames_runs() -> bool:
    """The frames stage quietly falls back to evenly spaced ffmpeg frames when sharp-frames
    cannot start (a venv whose scripts point at a moved checkout, say). Say so up front."""
    from server.stages.frames import _SHARP_FRAMES_BIN
    try:
        subprocess.run([_SHARP_FRAMES_BIN, "--help"], capture_output=True, timeout=120, check=True)
        return True
    except (OSError, subprocess.SubprocessError):
        return False


# --- poses ----------------------------------------------------------------------------------

def sparse_dir(dataset: Path) -> Path:
    nested = dataset / "sparse" / "0"
    return nested if (nested / "cameras.bin").exists() else dataset / "sparse"


def mapper_used(messages: list[str], backend: str) -> tuple[str | None, str | None]:
    """Which mapper produced the poses, and GLOMAP's rejection message when it fell back."""
    if backend == "da3":
        return "da3", None
    if "running incremental mapping" in messages:
        fallback = next((m for m in messages
                         if m.startswith("global mapping") and "incremental" in m), None)
        return "incremental", fallback
    if "running global mapping" in messages:
        return "glomap", None
    return None, None


def pose_metrics(work: Path) -> dict:
    import pycolmap
    from server.stages.poses_colmap import gate_metrics

    n_frames = len(list((work / "frames").glob("*.jpg")))
    recon = pycolmap.Reconstruction(sparse_dir(work / "dataset"))
    return {"frames": n_frames, **gate_metrics(recon, n_frames)}


# --- quality --------------------------------------------------------------------------------

def _link(src: Path, dst: Path):
    try:
        os.link(src, dst)
    except OSError:
        shutil.copy2(src, dst)


def build_holdout(dataset: Path, dest: Path, blocks: int, block_len: int, every: int):
    """Copy the dataset with images renamed so Brush holds out the planned frames.

    Images are hard links, so the copy costs no disk. Returns None when the clip has too few
    registered frames to hold any out.
    """
    import pycolmap

    recon = pycolmap.Reconstruction(sparse_dir(dataset))
    images = sorted(recon.images.values(), key=lambda im: im.name)
    if any(not im.has_pose for im in images):
        raise RuntimeError("dataset model holds unregistered images; Brush's split order "
                           "would not match the plan")
    far, near = plan_holdout(len(images), blocks, block_len, every)
    held = set(far) | set(near)
    split, order, evals, returned = assign_slots(
        [i for i in range(len(images)) if i not in held], far, near)
    if split is None:
        return None
    train = [i for i, is_eval in order if not is_eval]
    centers = [tuple(float(x) for x in im.cam_from_world().inverse().translation)
               for im in images]
    distances = path_distances(centers, train, evals)
    kinds = {i: "far" for i in far} | {i: "near" for i in near}

    if dest.exists():
        shutil.rmtree(dest)
    (dest / "images").mkdir(parents=True)
    (dest / "sparse").mkdir()
    views = {}
    for position, (i, is_eval) in enumerate(order):
        image = images[i]
        source = image.name
        renamed = f"{position:05d}_{source.replace('/', '_')}"
        _link(dataset / "images" / source, dest / "images" / renamed)
        image.name = renamed
        if is_eval:
            views[renamed] = {"source": source, "kind": kinds[i], **distances[i]}
    recon.write(dest / "sparse")
    return {
        "split_every": split,
        "train_views": len(train),
        "near_views": sum(v["kind"] == "near" for v in views.values()),
        "far_views": sum(v["kind"] == "far" for v in views.values()),
        "returned_to_train": len(returned),
        "views": views,
    }


def _mean(rows: list[dict], key: str, kind: str | None = None):
    values = [r[key] for r in rows if (kind is None or r["kind"] == kind) and math.isfinite(r[key])]
    return round(statistics.fmean(values), 4) if values else None


def train_and_score(dataset: Path, holdout: dict, out_dir: Path, preset, args, rep: int) -> dict:
    """One Brush run with the preset's training flags, scored like scripts/eval.py scores."""
    from eval import brush_capabilities, run_config, score
    from server.stages.train_brush import _resolve_bin

    bin_path = _resolve_bin()
    steps_flag, supports_mip = brush_capabilities(bin_path)
    eval_args = SimpleNamespace(
        verbose=args.verbose, curve=False, eval_every=None, steps=preset.total_steps,
        seed=args.seed + rep, max_splats=preset.max_splats, growth_stop=preset.growth_stop,
        eval_split_every=holdout["split_every"],
    )
    flags = {"--max-resolution": str(preset.max_resolution)}
    if preset.lpips_weight:
        flags["--lpips-loss-weight"] = str(preset.lpips_weight)
    result = run_config(f"rep{rep}", flags, eval_args, dataset, out_dir, holdout["train_views"],
                        bin_path, steps_flag, supports_mip)
    result = score(result, dataset / "images", args.ref_res)

    per_image = []
    for scored in result["per_image"]:
        view = holdout["views"][scored["image"]]
        per_image.append({
            "image": view["source"],
            "kind": view["kind"],
            "frames_away": view["frames_away"],
            "steps_away": view["steps_away"],
            "psnr": scored["psnr"],
            "ssim": scored["ssim"],
        })
    return {
        "rep": rep,
        "seed": eval_args.seed,
        "psnr": _mean(per_image, "psnr"),
        "ssim": _mean(per_image, "ssim"),
        "psnr_near": _mean(per_image, "psnr", "near"),
        "ssim_near": _mean(per_image, "ssim", "near"),
        "psnr_far": _mean(per_image, "psnr", "far"),
        "ssim_far": _mean(per_image, "ssim", "far"),
        "splats": result["splats"],
        "train_s": result["train_s"],
        "steps_per_s": result["steps_per_s"],
        "wall_s": result["wall_s"],
        "out_dir": str(out_dir),
        "per_image": per_image,
    }


# --- one clip ---------------------------------------------------------------------------------

def _error_text(exc: Exception) -> str:
    text = str(exc)
    if isinstance(exc, subprocess.CalledProcessError) and exc.stderr:
        text += "\n" + str(exc.stderr)[-1500:]
    return text[-2000:]


def run_clip(clip: dict, record: dict, args, preset, out_root: Path, save) -> None:
    """Run one clip, filling in `record` as it goes; `save` persists partial results."""
    from server.stages import frames as frames_stage
    from server.stages import poses_colmap, poses_da3

    record["capture"] = probe_video(clip["video"])
    work = out_root / clip["name"]
    if work.exists():
        shutil.rmtree(work)  # an unfinished attempt from a resumed run
    work.mkdir(parents=True)
    (work / f"input{clip['video'].suffix.lower() or '.mp4'}").symlink_to(clip["video"])

    job = BenchJob(clip["name"], args.preset, preset, args.backend, work)
    poses_stage = poses_da3 if args.backend == "da3" else poses_colmap
    stage = "frames"
    try:
        started = time.monotonic()
        frames_stage.run(job, work, preset)
        record["frames_s"] = round(time.monotonic() - started, 1)
        stage = "poses"
        started = time.monotonic()
        poses_stage.run(job, work, preset)
        record["poses_s"] = round(time.monotonic() - started, 1)
    except Exception as exc:  # a failing clip is a result, not a crash
        record.update(status="failed", failed_stage=stage, error=_error_text(exc))
    finally:
        record["frame_extractor"] = ("ffmpeg-fallback"
                                     if any("sharp-frames failed" in m for m in job.messages)
                                     else "sharp-frames")
        record["mapper"], record["mapper_fallback"] = mapper_used(job.messages, args.backend)
        record["messages"] = job.messages
    if record.get("status") == "failed":
        record["poses"] = {"frames": len(list((work / "frames").glob("*.jpg")))}
        return
    try:
        record["poses"] = pose_metrics(work)
    except Exception as exc:
        record["poses_error"] = _error_text(exc)
    save()

    if args.poses_only:
        record["status"] = "ok"
        return
    try:
        holdout = build_holdout(work / "dataset", work / "bench_dataset",
                                args.blocks, args.block_len, args.every)
    except Exception as exc:
        record.update(status="train-failed", error=_error_text(exc))
        return
    if holdout is None:
        record.update(status="ok", note="too few registered frames to hold any out; not trained")
        return
    record["holdout"] = {k: v for k, v in holdout.items() if k != "views"}
    record["train"] = []
    for rep in range(args.reps):
        print(f"  [{clip['name']}] training rep {rep + 1}/{args.reps}", flush=True)
        try:
            record["train"].append(train_and_score(
                work / "bench_dataset", holdout, work / "train" / f"rep{rep}", preset, args, rep))
        except Exception as exc:
            record["train"].append({"rep": rep, "error": _error_text(exc)})
        save()
    record["status"] = ("train-failed" if any("error" in r for r in record["train"]) else "ok")


# --- output -----------------------------------------------------------------------------------

def _finite(value):
    """JSON has no NaN/Infinity; a perfect or degenerate metric becomes null."""
    if isinstance(value, float) and not math.isfinite(value):
        return None
    if isinstance(value, dict):
        return {k: _finite(v) for k, v in value.items()}
    if isinstance(value, list):
        return [_finite(v) for v in value]
    return value


def write_json(path: Path, data: dict):
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(_finite(data), indent=2))
    tmp.replace(path)


def _table(headers: list[str], rows: list[list[str]]):
    widths = [max([len(h)] + [len(r[i]) for r in rows]) for i, h in enumerate(headers)]
    print("  ".join(h.ljust(w) for h, w in zip(headers, widths)))
    print("  ".join("-" * w for w in widths))
    for row in rows:
        print("  ".join(cell.ljust(w) for cell, w in zip(row, widths)))


def _rep_values(clip: dict, key: str) -> list[float]:
    return [r[key] for r in clip.get("train", []) if r.get(key) is not None]


def _mean_sd(values: list[float]) -> str:
    if not values:
        return "-"
    if len(values) == 1:
        return f"{values[0]:.2f}"
    return f"{statistics.fmean(values):.2f}±{statistics.stdev(values):.2f}"


def _duration(seconds) -> str:
    if seconds is None:
        return "-"
    return f"{int(seconds) // 60}:{int(seconds) % 60:02d}"


def _status(clip: dict) -> str:
    status = clip.get("status", "?")
    return f"failed:{clip['failed_stage']}" if status == "failed" and "failed_stage" in clip else status


def print_run(path: Path, run: dict):
    settings, git = run.get("settings", {}), run.get("git", {})
    preset = settings.get("preset", {})
    print(f"\n{path}\n{run.get('label')} · {git.get('commit', '?')}{' (dirty)' if git.get('dirty') else ''}"
          f" · {settings.get('preset_name')} ({preset.get('frames')} frames, "
          f"{preset.get('max_resolution')} px, {preset.get('total_steps')} steps)"
          f" · {settings.get('backend')} · reps {settings.get('reps')}"
          + (f" · {run['env']}" if run.get("env") else ""))
    rows = []
    for clip in run.get("clips", []):
        poses, capture = clip.get("poses", {}), clip.get("capture", {})
        near, far = _rep_values(clip, "psnr_near"), _rep_values(clip, "psnr_far")
        gaps = [f - n for n, f in zip(near, far)]
        mapper = clip.get("mapper") or "-"
        rows.append([
            clip["name"],
            _status(clip),
            f"{capture['duration_s']:.0f}s" if capture.get("duration_s") else "-",
            (f"{poses['registered']}/{poses['frames']}" if "registered" in poses
             else f"-/{poses['frames']}" if "frames" in poses else "-"),
            mapper + ("*" if clip.get("mapper_fallback") else ""),
            f"{poses['mean_reproj_px']:.2f}" if poses.get("mean_reproj_px") is not None else "-",
            (f"{100 * poses['trajectory_outlier_ratio']:.1f}%"
             if poses.get("trajectory_outlier_ratio") is not None else "-"),
            _duration((clip.get("frames_s") or 0) + (clip.get("poses_s") or 0)
                      if clip.get("poses_s") is not None else None),
            _mean_sd(near),
            _mean_sd(far),
            _mean_sd(gaps),
        ])
    _table(["clip", "status", "length", "registered", "mapper", "reproj px", "jumps",
            "frames+poses", "PSNR near", "PSNR far", "far-near"], rows)
    fallbacks = [c["name"] for c in run.get("clips", [])
                 if c.get("frame_extractor") == "ffmpeg-fallback"]
    if any(c.get("mapper_fallback") for c in run.get("clips", [])):
        print("* GLOMAP was rejected and the incremental mapper ran; the reason is in results.json")
    if fallbacks:
        print(f"! frames came from the ffmpeg fallback, not sharp-frames: {', '.join(fallbacks)}")


def print_delta(a: dict, b: dict):
    clips_a = {c["name"]: c for c in a.get("clips", [])}
    rows = []
    for clip_b in b.get("clips", []):
        clip_a = clips_a.get(clip_b["name"])
        if clip_a is None:
            continue

        def ratio(clip):
            poses = clip.get("poses", {})
            if "registered" not in poses or not poses.get("frames"):
                return None
            return poses["registered"] / poses["frames"]

        def diff(x, y, fmt):
            return fmt.format(y - x) if x is not None and y is not None else "-"

        def mean(clip, key):
            values = _rep_values(clip, key)
            return statistics.fmean(values) if values else None

        def pose_time(clip):
            return ((clip.get("frames_s") or 0) + clip["poses_s"]
                    if clip.get("poses_s") is not None else None)

        status_a, status_b = _status(clip_a), _status(clip_b)
        rows.append([
            clip_b["name"],
            status_b if status_a == status_b else f"{status_a} -> {status_b}",
            diff(ratio(clip_a), ratio(clip_b), "{:+.0%}"),
            diff(pose_time(clip_a), pose_time(clip_b), "{:+.0f}s"),
            diff(mean(clip_a, "psnr_near"), mean(clip_b, "psnr_near"), "{:+.2f}"),
            diff(mean(clip_a, "psnr_far"), mean(clip_b, "psnr_far"), "{:+.2f}"),
            f"{len(_rep_values(clip_a, 'psnr'))}/{len(_rep_values(clip_b, 'psnr'))}",
        ])
    print(f"\n{b.get('label')} vs {a.get('label')} (second minus first)")
    _table(["clip", "status", "registered", "frames+poses", "near dB", "far dB", "reps"], rows)
    print("Identical full-length runs differ by up to ~0.5 dB (docs/step-count.md). Below ~1 dB, "
          "a single rep is noise.")


# --- commands ---------------------------------------------------------------------------------

def cmd_run(args) -> int:
    preset = apply_overrides(PRESETS[args.preset], args.set)
    clips = load_manifest(args.manifest, args.clip)
    git = git_info()
    label = re.sub(r"[^A-Za-z0-9._-]+", "-", args.label or git.get("commit") or "run")
    out_root = (args.out or _PROJECT_ROOT / "jobs" / "_bench"
                / f"{time.strftime('%Y%m%d-%H%M%S')}-{label}").resolve()
    results_path = out_root / "results.json"

    settings = {
        "preset_name": args.preset,
        "preset": dataclasses.asdict(preset),
        "overrides": args.set,
        "backend": args.backend,
        "poses_only": args.poses_only,
        "reps": args.reps,
        "seed": args.seed,
        "holdout": {"blocks": args.blocks, "block_len": args.block_len, "every": args.every},
        "ref_res": args.ref_res,
    }
    finished = {}
    if out_root.exists() and any(out_root.iterdir()):
        if not args.resume:
            raise SystemExit(f"{out_root} already exists; pass --resume to continue it")
        if results_path.exists():
            prior = json.loads(results_path.read_text())
            if prior.get("settings") != _finite(settings):
                raise SystemExit(f"{out_root} was run with different settings; "
                                 "start a new run instead of resuming it")
            finished = {c["name"]: c for c in prior.get("clips", [])
                        if c.get("status") in _FINISHED}
    out_root.mkdir(parents=True, exist_ok=True)

    if not sharp_frames_runs():
        print("WARNING: sharp-frames will not start, so every clip gets evenly spaced ffmpeg "
              "frames instead of the sharpest ones. Recreate the venv (rm -rf .venv && uv sync) "
              "unless that is what you want to measure.", flush=True)

    run = {
        "label": label,
        "created": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "manifest": str(args.manifest.resolve()),
        "git": git,
        "machine": machine_info(),
        "env": {k: os.environ[k] for k in _ENV_KEYS if os.environ.get(k)},
        "settings": settings,
        "clips": [],
    }

    def save():
        write_json(results_path, run)

    print(f"bench: {len(clips)} clip(s) -> {out_root}", flush=True)
    for clip in clips:
        if clip["name"] in finished:
            print(f"\n=== {clip['name']}: already {finished[clip['name']]['status']}, kept ===")
            run["clips"].append(finished[clip["name"]])
            continue
        print(f"\n=== {clip['name']} ===", flush=True)
        record = {"name": clip["name"], "tags": clip["tags"], "notes": clip["notes"],
                  "video": str(clip["video"]), "status": "running"}
        run["clips"].append(record)
        if not clip["video"].is_file():
            print(f"  missing: {clip['video']}", flush=True)
            record["status"] = "missing"
        else:
            try:
                run_clip(clip, record, args, preset, out_root, save)
            except KeyboardInterrupt:
                record["status"] = "interrupted"
                save()
                raise
        save()

    print_run(results_path, run)
    print(f"\nresults: {results_path}")
    return 0


def cmd_summarize(args) -> int:
    runs = [json.loads(p.read_text()) for p in args.results]
    for path, run in zip(args.results, runs):
        print_run(path, run)
    if len(runs) == 2:
        print_delta(*runs)
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    run = sub.add_parser("run", help="run the pipeline over every clip in a manifest")
    run.add_argument("--manifest", type=Path, required=True,
                     help="clip list (see scripts/bench_clips.example.json)")
    run.add_argument("--clip", action="append", metavar="NAME", help="only this clip; repeatable")
    run.add_argument("--label", help="name for this variant (default: the git commit)")
    run.add_argument("--preset", choices=sorted(PRESETS), default="high")
    run.add_argument("--set", action="append", default=[], metavar="FIELD=VALUE",
                     help="override a preset field, e.g. --set frames=400; repeatable")
    run.add_argument("--backend", choices=("colmap", "da3"), default="colmap")
    run.add_argument("--poses-only", action="store_true",
                     help="stop after poses: robustness numbers only, no training")
    run.add_argument("--reps", type=int, default=1,
                     help="training replicates per clip, on the same poses (default 1)")
    run.add_argument("--seed", type=int, default=42, help="seed of the first replicate")
    run.add_argument("--blocks", type=int, default=3, help="far runs per clip (default 3)")
    run.add_argument("--block-len", type=int, default=9, help="frames per far run (default 9)")
    run.add_argument("--every", type=int, default=8, help="near period in frames (default 8)")
    run.add_argument("--ref-res", type=int, default=2048,
                     help="long edge renders and ground truth are compared at (default 2048)")
    run.add_argument("--out", type=Path, help="run directory (default jobs/_bench/<time>-<label>)")
    run.add_argument("--resume", action="store_true",
                     help="continue --out, keeping clips that already finished")
    run.add_argument("--verbose", action="store_true", help="echo every Brush log line")

    summarize = sub.add_parser("summarize", help="print tables from results files")
    summarize.add_argument("results", nargs="+", type=Path)

    args = parser.parse_args()
    if args.command == "summarize":
        return cmd_summarize(args)
    if args.reps < 1 or args.blocks < 0 or args.block_len < 1 or args.every < 0 or args.every == 1:
        parser.error("--reps and --block-len must be >= 1, --blocks >= 0, --every 0 or >= 2")
    return cmd_run(args)


if __name__ == "__main__":
    raise SystemExit(main())
