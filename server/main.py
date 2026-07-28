import asyncio
import json
import shutil
import time
from pathlib import Path
from uuid import uuid4

from fastapi import FastAPI, Form, HTTPException, Request, UploadFile
from fastapi.responses import FileResponse, StreamingResponse
from fastapi.staticfiles import StaticFiles

from . import pipeline
from .presets import DEFAULT_PRESET, PRESETS
from .pipeline import Job

app = FastAPI()

# Every job this process has seen, running or finished, so its state and files
# stay reachable after it ends. Which one is *running* is pipeline's to say.
JOBS: dict[str, Job] = {}
# Held only so the event loop cannot garbage-collect a running pipeline task.
_background_tasks: set[asyncio.Task] = set()


@app.post("/api/jobs")
async def create_job(
    video: UploadFile,
    preset: str = Form(DEFAULT_PRESET),
    pose_backend: str = Form("colmap"),
):
    if preset not in PRESETS:
        raise HTTPException(400, f"unknown preset '{preset}'")
    if pose_backend not in ("colmap", "da3"):
        raise HTTPException(400, f"unknown pose_backend '{pose_backend}'")

    job_id = uuid4().hex[:12]
    job = Job(job_id, preset, pose_backend)
    if not pipeline.try_start(job):
        raise HTTPException(409, "a job is already running")

    # The slot is claimed but the job has not started, so nothing else can free
    # it: an upload that dies here has to hand it back itself.
    try:
        job.work.mkdir(parents=True, exist_ok=True)
        ext = Path(video.filename or "input.mp4").suffix or ".mp4"
        with (job.work / f"input{ext}").open("wb") as f:
            shutil.copyfileobj(video.file, f)
    except Exception:
        pipeline.release(job)
        raise

    JOBS[job_id] = job
    task = asyncio.create_task(pipeline.start(job))
    _background_tasks.add(task)
    task.add_done_callback(_background_tasks.discard)

    return {"job_id": job_id}


@app.get("/api/jobs/active")
async def active_job():
    """The running job, if any — lets a fresh tab attach to a run in progress."""
    return {"job_id": pipeline.active_job_id()}


@app.get("/api/jobs/{job_id}")
async def get_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    state, _ = job.snapshot()
    return state


@app.get("/api/jobs/{job_id}/events")
async def job_events(job_id: str, request: Request):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")

    async def stream():
        last_version = None
        last_sent = 0.0
        while True:
            if await request.is_disconnected():
                return
            state, version = job.snapshot()
            if version != last_version:
                yield f"event: state\ndata: {json.dumps(state)}\n\n"
                last_version = version
                last_sent = time.monotonic()
                if state["stage"] in pipeline.TERMINAL_STAGES:
                    return
            elif time.monotonic() - last_sent > 15:
                yield ": heartbeat\n\n"
                last_sent = time.monotonic()
            await asyncio.sleep(0.5)

    return StreamingResponse(stream(), media_type="text/event-stream")


@app.post("/api/jobs/{job_id}/cancel")
async def cancel_job(job_id: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    job.cancel()
    state, _ = job.snapshot()
    return state


@app.get("/api/jobs/{job_id}/files/{path:path}")
async def job_file(job_id: str, path: str):
    job = JOBS.get(job_id)
    if job is None:
        raise HTTPException(404, "job not found")
    root = job.work.resolve()
    target = (root / path).resolve()
    if root not in target.parents and target != root:
        raise HTTPException(403, "invalid path")
    if not target.is_file():
        raise HTTPException(404, "file not found")
    return FileResponse(target)


# Mount the two viewer libraries individually rather than all of vendor/: that
# directory also holds the Brush source tree and its build output (~5 GB), none
# of which the browser has any business fetching.
app.mount("/vendor/spark", StaticFiles(directory="vendor/spark"), name="vendor_spark")
app.mount("/vendor/three", StaticFiles(directory="vendor/three"), name="vendor_three")
app.mount("/", StaticFiles(directory="web", html=True), name="web")


if __name__ == "__main__":
    import uvicorn

    uvicorn.run("server.main:app", host="127.0.0.1", port=8000)
