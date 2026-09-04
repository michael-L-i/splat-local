import subprocess
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import Mock, patch

from server.pipeline import Job, JobCancelled
from server.presets import PRESETS
from server.stages import export, train_brush


class ArtifactHandoffTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.work = Path(self.temp.name)
        self.job = Job("test", "high", "colmap")
        self.job.work = self.work
        self.preset = PRESETS["high"]

    def test_failed_conversions_preserve_ply_and_hide_partial_files(self):
        checkpoints = self.work / "checkpoints"
        checkpoints.mkdir()
        (checkpoints / "export_18000.ply").write_bytes(b"original checkpoint")
        exports = self.work / "exports"
        exports.mkdir()
        (exports / "stale.spz").write_bytes(b"old partial output")

        def fail(job, command, **kwargs):
            Path(command[-1]).write_bytes(b"partial conversion")
            raise subprocess.CalledProcessError(1, command)

        with patch.object(export, "_npx_available", return_value=True), \
             patch.object(export, "run_subprocess", side_effect=fail), \
             patch.object(export, "_stats", return_value=None):
            export.run(self.job, self.work, self.preset)

        self.assertEqual((exports / "scene.ply").read_bytes(), b"original checkpoint")
        self.assertEqual([a["name"] for a in self.job.state["artifacts"]], ["scene.ply"])
        self.assertEqual(sorted(p.name for p in exports.iterdir()), ["scene.ply", "stale.spz"])

    def test_conversion_publishes_only_nonempty_successful_output(self):
        for payload in (None, b"", b"converted"):
            with self.subTest(payload=payload):
                target = self.work / "scene.ply"
                target.write_bytes(b"original")

                def convert(job, command, **kwargs):
                    if payload is not None:
                        Path(command[-1]).write_bytes(payload)
                    self.assertEqual(target.read_bytes(), b"original")

                with patch.object(export, "run_subprocess", side_effect=convert):
                    ok = export._transform(self.job, target.name, ["input.ply", str(target)])
                self.assertEqual(ok, bool(payload))
                self.assertEqual(target.read_bytes(), payload or b"original")
                self.assertEqual(list(self.work.iterdir()), [target])

    def test_cancelled_conversion_preserves_original_and_cleans_temporary_output(self):
        target = self.work / "scene.ply"
        target.write_bytes(b"original")

        def cancel(job, command, **kwargs):
            Path(command[-1]).write_bytes(b"partial")
            raise JobCancelled()

        with patch.object(export, "run_subprocess", side_effect=cancel):
            with self.assertRaises(JobCancelled):
                export._transform(self.job, target.name, ["input.ply", str(target)])
        self.assertEqual(target.read_bytes(), b"original")
        self.assertEqual(list(self.work.iterdir()), [target])

    def test_final_checkpoint_waits_for_successful_exit(self):
        self.exercise_training()

    def test_failed_training_does_not_publish_final_checkpoint(self):
        self.exercise_training(returncode=1)

    def test_cancelled_training_does_not_publish_final_checkpoint(self):
        self.exercise_training(cancelled=True)

    def exercise_training(self, returncode=0, cancelled=False):
        checkpoints = self.work / "checkpoints"
        checkpoints.mkdir()
        (checkpoints / "export_1000.ply").write_bytes(b"intermediate")
        final = checkpoints / "export_18000.ply"
        final.write_bytes(b"still writing")
        proc = Mock(returncode=None)

        def finish():
            final.write_bytes(b"complete")
            proc.returncode = returncode
            self.job.cancelled = cancelled

        proc.wait.side_effect = finish
        announcements = []
        update = self.job.update

        def record(**fields):
            if checkpoint := fields.get("checkpoint"):
                announcements.append((checkpoint["step"], proc.returncode))
            update(**fields)

        self.job.update = record
        with patch.object(train_brush.subprocess, "run", return_value=SimpleNamespace(stdout="--total-train-iters")), \
             patch.object(train_brush.subprocess, "Popen", return_value=proc), \
             patch.object(train_brush.threading, "Thread"), \
             patch.object(train_brush.queue, "Queue") as queue, \
             patch.object(train_brush, "write_preview", return_value=False):
            queue.return_value.get.side_effect = ["", None]
            if cancelled or returncode:
                with self.assertRaises(JobCancelled if cancelled else RuntimeError):
                    train_brush.run(self.job, self.work, self.preset)
            else:
                train_brush.run(self.job, self.work, self.preset)
        self.assertIn((1000, None), announcements)  # Live previews still stream.
        finals = [event for event in announcements if event[0] == 18000]
        self.assertEqual(finals, [] if cancelled or returncode else [(18000, 0)])


if __name__ == "__main__":
    unittest.main()
