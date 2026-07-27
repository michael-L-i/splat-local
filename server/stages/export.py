import json
import re
import shutil
import subprocess
from pathlib import Path

from ..pipeline import JobCancelled, run_subprocess

_NPX_CMD = ["npx", "--yes", "@playcanvas/splat-transform"]

# Ceilings, not expectations: a 136K-splat scene converts in seconds and stats take ~0.1s.
# They exist so a wedged splat-transform can never sit on a job forever.
_TRANSFORM_TIMEOUT = 900
_STATS_TIMEOUT = 120

# The archive is what the user downloads and keeps: full resolution, SH3, and only
# NaN/Inf/degenerate gaussians removed. No quality decision is ever applied here.
_ARCHIVE_NAMES = ("scene.ply", "scene.spz")

# The view artifact is what the browser loads: same scene, filtered and reordered so it is
# cheap to render. Anything we do to it costs nothing in what the user actually keeps.
_VIEW_NAME = "scene-view.sog"


def _step_of(p: Path) -> int:
    m = re.search(r"export_(\d+)\.ply", p.name)
    return int(m.group(1)) if m else -1


def _npx_available() -> bool:
    try:
        subprocess.run(_NPX_CMD + ["--version"], capture_output=True, text=True, timeout=30, check=True)
        return True
    except Exception:
        return False


def _transform(job, name: str, args: list[str]) -> bool:
    """One splat-transform run (one output per invocation). False if it failed."""
    try:
        run_subprocess(job, _NPX_CMD + ["-w", *args], timeout=_TRANSFORM_TIMEOUT)
        return True
    except JobCancelled:
        raise
    except Exception:
        job.update(message=f"splat-transform failed for {name}, skipping")
        return False


def _stats(job, path: Path) -> dict | None:
    """Splat count and fill ratio (average overdraw layers per pixel) for one artifact."""
    try:
        proc = run_subprocess(
            job, _NPX_CMD + ["-q", str(path), "--stats", "json", "null"], timeout=_STATS_TIMEOUT
        )
        data = json.loads(proc.stdout)
    except JobCancelled:
        raise
    except Exception:
        return None
    lods = data.get("stats") or [{}]
    return {"gaussians": data.get("numGaussians"), "fill_ratio": lods[0].get("fillRatio")}


def run(job, work: Path, preset):
    checkpoints = sorted((work / "checkpoints").glob("export_*.ply"), key=_step_of)
    if not checkpoints:
        raise RuntimeError("no trained checkpoint to export")
    checkpoint = checkpoints[-1]

    exports_dir = work / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    scene_ply = exports_dir / "scene.ply"
    shutil.copyfile(checkpoint, scene_ply)

    job.update(message="exporting scene", progress=0.3)

    stats: dict[str, dict] = {}
    view_path = exports_dir / _VIEW_NAME

    if _npx_available():
        for name in _ARCHIVE_NAMES:
            _transform(job, name, [str(checkpoint), "--filter-nan", str(exports_dir / name)])

        job.update(message="building viewer scene", progress=0.6)
        # Near-transparent splats are where the overdraw goes; Morton order improves
        # render/sort locality. Both are view-only — the archive above is already written.
        view_ok = _transform(job, _VIEW_NAME, [
            str(checkpoint),
            "--filter-nan",
            "--filter-value", f"opacity,gt,{preset.view_opacity_min}",
            "--morton-order",
            str(view_path),
        ])

        job.update(message="measuring artifacts", progress=0.8)
        for name in (*_ARCHIVE_NAMES, _VIEW_NAME):
            measured = _stats(job, exports_dir / name) if (exports_dir / name).is_file() else None
            if measured:
                stats[name] = measured

        state, _ = job.snapshot()
        if view_ok and view_path.is_file() and state.get("checkpoint"):
            # Hand the viewer the lightened scene. The download links are untouched.
            job.update(checkpoint={**state["checkpoint"], "url": job.file_url(f"exports/{_VIEW_NAME}")})

    job.update(message="collecting artifacts", progress=0.9)

    # Archive first — it is what most people came for — then the viewer artifact.
    order = {name: i for i, name in enumerate((*_ARCHIVE_NAMES, _VIEW_NAME))}
    files = sorted(exports_dir.iterdir(), key=lambda p: (order.get(p.name, len(order)), p.name))
    artifacts = [
        {
            "name": p.name,
            "url": job.file_url(f"exports/{p.name}"),
            "bytes": p.stat().st_size,
            **stats.get(p.name, {}),
        }
        for p in files
    ]
    job.update(artifacts=artifacts, progress=1.0, message="export complete")
