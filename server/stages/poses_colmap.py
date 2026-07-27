"""COLMAP pose backend: features -> matching -> mapping -> undistorted dataset.

Mapping is the expensive step (80% of the stage at 165 frames, 71% at 200), so it runs GLOMAP's
global solver and keeps the incremental mapper as an automatically-selected fallback. Measured
on an M5 Pro, one paired run per scene, whole stage end to end:

    scene                frames  mapper       features  match  calib   map  undistort  total
    934589be6407            165  incremental      24.6    8.1      -  139.8        2.1  174.6
    934589be6407            165  glomap           25.8    8.2    4.7   65.9        2.0  106.6
    0c33c4547894            200  incremental      95.4   30.1      -  320.6        6.0  452.1
    0c33c4547894            200  glomap           95.3   30.4    4.1  234.8        6.0  370.6

1.64x and 1.22x on the stage; 1.98x and 1.34x on mapping alone. The gap between those two pairs
of numbers is the point: extraction and matching are untouched, and at 200 frames they are
already 28% of the stage, so the stage-level win shrinks as scenes get harder to match.

GLOMAP did not cost accuracy on either scene — it was slightly *better* on the pose-side metrics
that do not depend on training at all (mean reprojection error 0.83 vs 0.95 px and 0.61 vs
0.67 px), and it recovered a focal length within 0.7% and 0.05% of the incremental solution.

Downstream, which is the only measure that matters: same frames, same trainer config, 30k steps,
21 held-out views never trained on, normalised to 2048 px (`scripts/eval.py` from the eval
harness).

    poses                     PSNR    SSIM   splats
    incremental (run 1)      35.18  0.9835  135,492
    incremental (run 2)      35.99  0.9834  133,192
    glomap      (run 1)      37.52  0.9840  129,212
    glomap      (run 2)      36.10  0.9841  128,473

Read the *spread*, not the means. Two pose solutions from the same mapper on the same frames
differ by 0.81 dB (incremental) and 1.43 dB (glomap) — five to ten times the ~0.15 dB
run-to-run training noise floor, because both mappers are RANSAC-seeded and nondeterministic.
So the +1.22 dB mean gap in GLOMAP's favour is *not* a demonstrated win: at n=2 per arm the
arms nearly touch (36.10 vs 35.99). What the data does support is the decision this gate needed
— GLOMAP does not lose. Every global run scored at or above every incremental run, on a metric
where pose error shows up directly as misregistered held-out renders.

The wider lesson for anyone re-running this: a pose change cannot be evaluated against the
training noise floor. Pose-solution variance dominates it by an order of magnitude, so a single
A/B pair here is worth very little no matter how many training steps it gets.
"""
import os
import shutil
from pathlib import Path

import numpy as np
import pycolmap

from .sfm_common import cameras_json, write_sparse_ply

# Mapper selection. "auto" runs GLOMAP first and falls back to the incremental
# mapper when the quality gate rejects the global solution; "incremental" is the
# off switch; "glomap" forces the global mapper with no fallback (benchmarking).
MAPPER_ENV = "SPLAT_MAPPER"
MAPPER_MODES = ("auto", "glomap", "incremental")

# A focal length outside this fraction of the image's long edge is not a lens,
# it is a failed solve. The two sample scenes land at 0.43 and 0.70.
FOCAL_RATIO_MIN, FOCAL_RATIO_MAX = 0.2, 3.0

# Quality gate on the global solution. See _gate() for why each of these.
GATE_MIN_REGISTERED_RATIO = 0.8
GATE_MAX_MEAN_REPROJ_PX = 1.5
GATE_MIN_MEAN_TRACK_LENGTH = 4.0
GATE_MIN_OBS_PER_IMAGE = 200.0
GATE_MAX_TRAJECTORY_OUTLIER_RATIO = 0.05
TRAJECTORY_JUMP_FACTOR = 10.0


def _mapper_mode() -> str:
    mode = os.environ.get(MAPPER_ENV, "auto").strip().lower()
    return mode if mode in MAPPER_MODES else "auto"


def _trajectory_outlier_ratio(recon) -> float:
    """Fraction of consecutive-frame camera steps that jump implausibly far.

    The input is always a video walkthrough, so camera centres have to move
    smoothly. A global solve that is simply *wrong* typically flings one camera
    off the path — which reprojection error does not see, because that camera
    still fits its own tracks, but which becomes permanent ghosting downstream.
    Frames are named in capture order, so adjacency is free.
    """
    images = sorted(
        (im for im in recon.images.values() if im.has_pose), key=lambda im: im.name,
    )
    if len(images) < 3:
        return 0.0
    centers = [im.cam_from_world().inverse().translation for im in images]
    steps = [float(np.linalg.norm(b - a)) for a, b in zip(centers, centers[1:])]
    median = float(np.median(steps))
    if median <= 0.0:
        return 1.0
    return sum(s > TRAJECTORY_JUMP_FACTOR * median for s in steps) / len(steps)


def gate_metrics(recon, n_frames: int) -> dict:
    cam = next(iter(recon.cameras.values()), None)
    return {
        "registered": recon.num_reg_images(),
        "registered_ratio": recon.num_reg_images() / n_frames if n_frames else 0.0,
        "points3D": recon.num_points3D(),
        "mean_reproj_px": recon.compute_mean_reprojection_error(),
        "mean_track_length": recon.compute_mean_track_length(),
        "obs_per_image": recon.compute_mean_observations_per_reg_image(),
        "focal_ratio": (
            cam.mean_focal_length() / max(cam.width, cam.height) if cam else 0.0
        ),
        "trajectory_outlier_ratio": _trajectory_outlier_ratio(recon),
    }


def _gate(recon, n_frames: int) -> str | None:
    """Return a rejection reason, or None if the global solution is trustworthy.

    Registration count alone is not a gate — GLOMAP happily registers every frame
    of a geometrically wrong solution. Every threshold below is an absolute floor
    set well beneath what the incremental mapper actually measures on real scenes,
    so the gate fires on collapse, not on GLOMAP's normal sparser point cloud.
    """
    m = gate_metrics(recon, n_frames)
    checks = [
        (m["registered_ratio"] < GATE_MIN_REGISTERED_RATIO,
         f"registered only {m['registered']}/{n_frames} frames"),
        (not (FOCAL_RATIO_MIN <= m["focal_ratio"] <= FOCAL_RATIO_MAX),
         f"implausible focal length ({m['focal_ratio']:.2f} x long edge)"),
        (m["mean_reproj_px"] > GATE_MAX_MEAN_REPROJ_PX,
         f"mean reprojection error {m['mean_reproj_px']:.2f} px"),
        (m["mean_track_length"] < GATE_MIN_MEAN_TRACK_LENGTH,
         f"mean track length {m['mean_track_length']:.2f}"),
        (m["obs_per_image"] < GATE_MIN_OBS_PER_IMAGE,
         f"only {m['obs_per_image']:.0f} observations per image"),
        (m["trajectory_outlier_ratio"] > GATE_MAX_TRAJECTORY_OUTLIER_RATIO,
         f"{m['trajectory_outlier_ratio']:.1%} of camera steps jump off the path"),
    ]
    return next((reason for failed, reason in checks if failed), None)


def _calibrate_focal_prior(job, db_path: Path) -> None:
    """Give the global mapper the focal priors it asks for.

    GLOMAP warns when fewer than half the cameras carry a prior focal length, and
    it means it: global positioning has no incremental BA to walk a bad focal back
    with. ffmpeg frames have no EXIF, so COLMAP falls back to 1.2 x long edge and
    leaves the prior flag unset. Hardcoding a FOV instead is worse than useless —
    the two sample scenes solve to 0.43 and 0.70 of the long edge (98 deg and
    71 deg horizontal), so any single default is ~1.6x wrong for one of them.
    Estimate it from the fundamental matrices instead (COLMAP's own
    view_graph_calibrator) and only flag it as a prior when it comes back sane.
    """
    try:
        calibrated = pycolmap.calibrate_view_graph(database_path=db_path)
    except Exception:
        calibrated = False
    if not calibrated:
        job.update(message="focal calibration failed, mapping without priors")
        return

    db = pycolmap.Database.open(db_path)
    try:
        for cam in db.read_all_cameras():
            ratio = cam.mean_focal_length() / max(cam.width, cam.height)
            if cam.has_bogus_params or not (FOCAL_RATIO_MIN <= ratio <= FOCAL_RATIO_MAX):
                continue
            cam.has_prior_focal_length = True
            db.update_camera(cam)
    finally:
        db.close()


def _global_mapping(job, colmap_dir: Path, db_path: Path, frames_dir: Path, n_frames: int):
    """Run GLOMAP; return the reconstruction if it clears the gate, else None.

    Runs against a *copy* of the feature database: view-graph calibration rewrites
    two-view geometries, and the fallback has to see the same database production
    uses today, not one this attempt edited.
    """
    glomap_db = colmap_dir / "database_glomap.db"
    shutil.copyfile(db_path, glomap_db)

    job.update(message="calibrating focal length")
    try:
        _calibrate_focal_prior(job, glomap_db)
        job.check_cancelled()

        job.update(progress=0.5, message="running global mapping")
        out_dir = colmap_dir / "sparse_glomap"
        out_dir.mkdir(parents=True, exist_ok=True)
        try:
            reconstructions = pycolmap.global_mapping(
                database_path=glomap_db, image_path=frames_dir, output_path=out_dir,
            )
        except Exception as exc:
            job.update(message=f"global mapping failed ({exc}), using incremental mapper")
            return None
    finally:
        # the copy is a few hundred MB per job and the pristine database can
        # regenerate it; keeping both around doubles a job's disk for nothing
        glomap_db.unlink(missing_ok=True)
    if not reconstructions:
        job.update(message="global mapping found no model, using incremental mapper")
        return None

    best = max(reconstructions.values(), key=lambda r: r.num_reg_images())
    reason = _gate(best, n_frames)
    if reason is not None:
        job.update(message=f"global mapping rejected ({reason}), using incremental mapper")
        return None
    return best


def _incremental_mapping(job, colmap_dir: Path, db_path: Path, frames_dir: Path):
    job.update(progress=0.5, message="running incremental mapping")
    sparse_dir = colmap_dir / "sparse"
    sparse_dir.mkdir(parents=True, exist_ok=True)
    # video walkthroughs are forward-motion dominated: defaults (16° init
    # triangulation angle, forward-motion cap) reject every init pair
    opts = pycolmap.IncrementalPipelineOptions()
    opts.mapper.init_min_tri_angle = 4.0
    opts.mapper.init_max_forward_motion = 1.0
    opts.mapper.abs_pose_min_num_inliers = 20
    reconstructions = pycolmap.incremental_mapping(
        database_path=db_path, image_path=frames_dir, output_path=sparse_dir,
        options=opts,
    )
    if not reconstructions:
        return None
    return max(reconstructions.values(), key=lambda r: r.num_reg_images())


def run(job, work: Path, preset):
    frames_dir = work / "frames"
    n_frames = len(list(frames_dir.glob("*.jpg")))

    colmap_dir = work / "colmap"
    colmap_dir.mkdir(parents=True, exist_ok=True)
    db_path = colmap_dir / "database.db"

    job.update(message="extracting features", progress=0.05)
    pycolmap.extract_features(
        database_path=db_path,
        image_path=frames_dir,
        camera_mode=pycolmap.CameraMode.SINGLE,
        # SIMPLE_RADIAL: fx=fy + one distortion param. Richer models (OPENCV)
        # overfit garbage intrinsics when the init pair is forward-dominated
        reader_options=pycolmap.ImageReaderOptions(camera_model="SIMPLE_RADIAL"),
        extraction_options=pycolmap.FeatureExtractionOptions(
            sift=pycolmap.SiftExtractionOptions(
                estimate_affine_shape=True,
                domain_size_pooling=True,
            ),
        ),
    )
    job.check_cancelled()

    job.update(progress=0.2, message="matching features")
    try:
        pycolmap.match_sequential(
            database_path=db_path,
            pairing_options=pycolmap.SequentialPairingOptions(overlap=20, loop_detection=True),
        )
    except Exception:
        job.update(message="loop detection unavailable, retrying without it")
        pycolmap.match_sequential(
            database_path=db_path,
            pairing_options=pycolmap.SequentialPairingOptions(overlap=20, loop_detection=False),
        )
    job.check_cancelled()

    # Global SfM is ~2x faster but is weakest exactly where this project lives:
    # low-parallax forward motion. Pose error is the one error training cannot
    # recover from, so the global solution has to earn its way past _gate().
    mode = _mapper_mode()
    best = None
    if mode in ("auto", "glomap"):
        best = _global_mapping(job, colmap_dir, db_path, frames_dir, n_frames)
        job.check_cancelled()
        if best is None and mode == "glomap":
            raise RuntimeError(
                f"global mapping did not produce a usable reconstruction and "
                f"{MAPPER_ENV}=glomap disables the incremental fallback"
            )
    if best is None:
        best = _incremental_mapping(job, colmap_dir, db_path, frames_dir)

    if best is None:
        raise RuntimeError(
            "COLMAP could not reconstruct any camera poses — "
            "recapture the scene with more overlap between frames"
        )

    registered = best.num_reg_images()
    if n_frames and registered / n_frames < 0.3:
        raise RuntimeError(
            f"only {registered}/{n_frames} frames registered — "
            "recapture the scene with more overlap and steadier motion"
        )
    job.check_cancelled()

    model_dir = colmap_dir / "sparse" / "0"
    model_dir.mkdir(parents=True, exist_ok=True)
    best.write(model_dir)

    job.update(progress=0.9, message="undistorting images")
    dataset_dir = work / "dataset"
    pycolmap.undistort_images(
        output_path=dataset_dir,
        input_path=model_dir,
        image_path=frames_dir,
        output_type="COLMAP",
    )

    write_sparse_ply(work / "sparse.ply", best)
    cameras = cameras_json(best)

    job.update(
        progress=1.0,
        message=f"registered {registered}/{n_frames} frames",
        sparse_url=job.file_url("sparse.ply"),
        cameras=cameras,
    )
