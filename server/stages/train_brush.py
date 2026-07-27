import os
import queue
import re
import subprocess
import threading
from pathlib import Path

from ..pipeline import JobCancelled

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)")

# Progressive resolution. Brush trains on downscaled frames while densification is
# running and ramps back to full resolution by growth_stop, where the extra pixels
# start to pay. Off by default: on the `high` preset it buys 1.24x wall-clock for
# -0.24 dB held-out PSNR, and the noise floor here is 0.15 dB, so the cost is real.
# SPLAT_PROGRESSIVE_RES=on takes that trade; a percentage sets the ramp's floor.
# Only the fork build understands the flag — a stock Brush just doesn't get it.
PROGRESSIVE_ENV = "SPLAT_PROGRESSIVE_RES"
PROGRESSIVE_START_PCT = 50


def _resolve_bin() -> str:
    env = os.environ.get("BRUSH_BIN")
    if env:
        return env
    main_build = _PROJECT_ROOT / "vendor" / "brush_src" / "target" / "release" / "brush"
    if main_build.exists():
        return str(main_build)
    return str(_PROJECT_ROOT / "vendor" / "brush")


def _progressive_start_pct() -> int:
    """Resolution the progressive ramp starts at, as a percentage of full. 100 = off."""
    raw = os.environ.get(PROGRESSIVE_ENV, "").strip().lower()
    if raw in ("on", "true", "yes"):
        return PROGRESSIVE_START_PCT
    if raw.isdigit() and 1 <= int(raw) <= 100:
        return int(raw)
    return 100


def _reader_thread(pipe, q: "queue.Queue[str | None]"):
    for line in iter(pipe.readline, ""):
        q.put(line)
    q.put(None)


def run(job, work: Path, preset):
    dataset_dir = (work / "dataset").resolve()
    n_images = len(list((dataset_dir / "images").glob("*")))
    export_dir = (work / "checkpoints").resolve()
    export_dir.mkdir(parents=True, exist_ok=True)

    bin_path = _resolve_bin()
    help_text = subprocess.run(
        [bin_path, "--help"], capture_output=True, text=True, timeout=30,
    ).stdout
    steps_flag = "--total-train-iters" if "--total-train-iters" in help_text else "--total-steps"
    supports_mip = "--render-mode" in help_text
    supports_progressive = "--progressive-resolution-start" in help_text

    args = [
        bin_path, str(dataset_dir),
        steps_flag, str(preset.total_steps),
        "--max-splats", str(preset.max_splats),
        "--sh-degree", "3",
        "--max-resolution", str(preset.max_resolution),
        "--refine-every", str(max(n_images, 1)),
        "--growth-stop-iter", str(preset.growth_stop),
        "--export-every", str(preset.export_every),
        "--export-path", str(export_dir),
        "--export-name", "export_{iter}.ply",
    ]
    if preset.lpips_weight:
        args += ["--lpips-loss-weight", str(preset.lpips_weight)]
    if supports_mip:
        args += ["--render-mode", "mip"]
    progressive_start = _progressive_start_pct()
    if supports_progressive and progressive_start < 100:
        args += ["--progressive-resolution-start", str(progressive_start)]

    job.update(message="training splats", progress=0.0)

    proc = subprocess.Popen(
        args, start_new_session=True,
        stdout=subprocess.PIPE, stderr=subprocess.STDOUT, text=True, bufsize=1,
    )
    job.proc = proc

    q: "queue.Queue[str | None]" = queue.Queue()
    threading.Thread(target=_reader_thread, args=(proc.stdout, q), daemon=True).start()

    seen_checkpoints: set[str] = set()
    log_tail: list[str] = []
    best_progress = 0.0

    def scan_checkpoints():
        nonlocal best_progress
        for p in sorted(export_dir.glob("export_*.ply"),
                        key=lambda p: int(re.search(r"export_(\d+)", p.name).group(1))):
            if p.name in seen_checkpoints:
                continue
            seen_checkpoints.add(p.name)
            m = re.search(r"export_(\d+)\.ply", p.name)
            step = int(m.group(1)) if m else None
            job.update(checkpoint={
                "url": job.file_url(f"checkpoints/{p.name}"),
                "step": step,
                "total_steps": preset.total_steps,
            })
            if step is not None:
                best_progress = max(best_progress, min(step / preset.total_steps, 1.0))
                job.update(progress=best_progress)

    eof = False
    while not eof:
        if job.cancelled:
            break
        try:
            line = q.get(timeout=2.0)
        except queue.Empty:
            line = ""
        if line is None:
            eof = True
        elif line:
            log_tail.append(line)
            del log_tail[:-50]
            m = _STEP_RE.search(line)
            if m:
                step, total = int(m.group(1)), int(m.group(2))
                best_progress = max(best_progress, min(step / max(total, 1), 1.0))
                job.update(progress=best_progress, message=f"training step {step}/{total}")
        scan_checkpoints()

    proc.wait()
    job.proc = None
    scan_checkpoints()

    if job.cancelled:
        raise JobCancelled()
    if proc.returncode != 0:
        raise RuntimeError("brush training failed:\n" + "".join(log_tail[-20:]))
    if not seen_checkpoints:
        raise RuntimeError("brush training produced no checkpoints")

    job.update(progress=1.0, message="training complete")
