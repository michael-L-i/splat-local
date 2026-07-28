# API contract

## Endpoints

- `POST /api/jobs` — multipart form: `video` (file), `preset` (`preview|high|max`, default `high`), `pose_backend` (`colmap|da3`, default `colmap`). Returns `{"job_id": str}`. 409 if a job is already running.
- `GET /api/jobs/active` — `{"job_id": str | null}` for the currently running job (lets any tab attach).
- `GET /api/jobs/{id}` — JSON snapshot of job state (same shape as SSE `state` payload).
- `GET /api/jobs/{id}/events` — SSE stream. On connect, emits current state, then updates.
- `POST /api/jobs/{id}/cancel` — cancel the job (kills running stage process).
- `GET /api/jobs/{id}/files/{path}` — serves files from the job dir (frames, sparse.ply, checkpoints, exports).

Static mounts, in match order: `/vendor/spark` and `/vendor/three` (the two viewer libraries only — `vendor/` also holds the ~5 GB Brush source tree), `/viewer` (the viewer engine shared with the demo site), then `/` -> `web/`.

## SSE events

Every event is `event: state` with a full JSON job snapshot:

```json
{
  "job_id": "abc123",
  "stage": "frames|poses|train|export|done|error|cancelled",
  "progress": 0.42,
  "message": "human-readable status line",
  "frames": {"count": 200, "sample": ["/api/jobs/abc123/files/frames/00001.jpg"]},
  "sparse_url": "/api/jobs/abc123/files/sparse.ply",
  "cameras": [{"position": [x,y,z], "rotation": [qw,qx,qy,qz]}],
  "checkpoint": {"url": ".../checkpoints/splat_10000.ply", "step": 10000, "total_steps": 30000},
  "artifacts": [{"name": "scene.ply", "url": "...", "bytes": 123, "gaussians": 135575, "fill_ratio": 46.7}],
  "error": null
}
```

Fields are null/absent until their stage produces them. `checkpoint` is what the viewer loads: the latest exported `.ply` during training, then `exports/scene-view.sog` once the export stage has built it (`step`/`total_steps` stay as they were).

`gaussians` and `fill_ratio` (average overdraw layers per pixel, from `splat-transform --stats`) are present per artifact when Node is available; `name`/`url`/`bytes` are always present.

## Export artifacts

- **Archive** — `scene.ply`, `scene.spz`: what the user downloads. Full resolution, SH3, only NaN/Inf/degenerate gaussians removed. No quality decision is applied.
- **View** — `scene-view.sog`: what the viewer loads. Same scene with an opacity floor (`Preset.view_opacity_min`) and Morton reordering, so viewer-side cleanup never affects the download.

Without Node (`npx`), only the raw `scene.ply` checkpoint copy is produced and the viewer keeps the last training checkpoint.

## Job directory layout

`jobs/{id}/`: `input.<ext>`, `frames/*.jpg`, `colmap/` (db + sparse), `dataset/` (undistorted images + sparse for Brush), `sparse.ply`, `checkpoints/*.ply`, `exports/*`
