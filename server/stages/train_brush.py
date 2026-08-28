import os
import queue
import re
import subprocess
import threading
from pathlib import Path

from ..pipeline import JobCancelled
from .preview import PartialFile, write_preview

_PROJECT_ROOT = Path(__file__).resolve().parents[2]
_STEP_RE = re.compile(r"(\d+)\s*/\s*(\d+)")


def _resolve_bin() -> str:
    env = os.environ.get("BRUSH_BIN")
    if env:
        return env
    main_build = _PROJECT_ROOT / "vendor" / "brush_src" / "target" / "release" / "brush"
    if main_build.exists():
        return str(main_build)
    return str(_PROJECT_ROOT / "vendor" / "brush")


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
    previews: list[Path] = []
    last_streamed: dict = {}

    # What the browser should load for checkpoint p: an SH1 preview when one
    # can be written (see preview.py), the original when it can't — or when
    # this is the final checkpoint, where the full scene belongs on screen.
    def stream_name(p: Path, step) -> str:
        if step == preset.total_steps:
            return p.name
        preview = export_dir / p.name.replace("export_", "preview_")
        try:
            ok = write_preview(p, preview)
        except PartialFile:
            raise
        except Exception:
            ok = False
        if not ok:
            return p.name
        previews.append(preview)
        # Keep the newest two: the one before last may still be streaming to a
        # browser tab. (A badly throttled tab could still 404 on an older URL —
        # SSE sends whole snapshots, so the next one supersedes it in a beat.)
        for old in previews[:-2]:
            old.unlink(missing_ok=True)
        del previews[:-2]
        return preview.name

    def scan_checkpoints():
        nonlocal best_progress
        for p in sorted(export_dir.glob("export_*.ply"),
                        key=lambda p: int(re.search(r"export_(\d+)", p.name).group(1))):
            if p.name in seen_checkpoints:
                continue
            m = re.search(r"export_(\d+)\.ply", p.name)
            step = int(m.group(1)) if m else None
            try:
                name = stream_name(p, step)
            except PartialFile:
                return  # Brush is still writing it; the next scan will get it
            seen_checkpoints.add(p.name)
            last_streamed.update(file=p.name, streamed=name, step=step)
            job.update(checkpoint={
                "url": job.file_url(f"checkpoints/{name}"),
                "step": step,
                "total_steps": preset.total_steps,
            })
            if step is not None:
                best_progress = max(best_progress, min(step / preset.total_steps, 1.0))
                job.update(progress=best_progress)

    eof = False
    try:
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

        # The stream ends on the full-quality scene. Normally the final
        # checkpoint already went out untruncated (step == total_steps skips
        # the preview), but a run that stopped short leaves an SH1 preview on
        # screen — re-announce its original. The originals stay for export/eval.
        if last_streamed and last_streamed["streamed"] != last_streamed["file"]:
            job.update(checkpoint={
                "url": job.file_url(f"checkpoints/{last_streamed['file']}"),
                "step": last_streamed["step"],
                "total_steps": preset.total_steps,
            })
        job.update(progress=1.0, message="training complete")
    finally:
        # Previews are stream-only artifacts: never left behind, whether the
        # stage finished, failed, or was cancelled.
        for p in previews:
            p.unlink(missing_ok=True)
