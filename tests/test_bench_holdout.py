import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "scripts"))

from bench_holdout import assign_slots, path_distances, plan_holdout  # noqa: E402


def brush_eval_views(order, split):
    """What Brush does with the sorted views: view i is held out when i % split == 0."""
    return [item for i, (item, _) in enumerate(order) if i % split == 0]


def runs(indices):
    groups = []
    for i in indices:
        if groups and i == groups[-1][-1] + 1:
            groups[-1].append(i)
        else:
            groups.append([i])
    return groups


class AssignSlotsTests(unittest.TestCase):
    def test_brush_holds_out_exactly_the_returned_eval_frames(self):
        for n_train in (1, 2, 7, 50, 144, 400):
            for n_required in (0, 1, 5, 27):
                for n_optional in (0, 1, 18, 40):
                    if n_required + n_optional == 0:
                        continue
                    train = [f"t{i}" for i in range(n_train)]
                    required = [f"r{i}" for i in range(n_required)]
                    optional = [f"o{i}" for i in range(n_optional)]
                    with self.subTest(train=n_train, required=n_required, optional=n_optional):
                        split, order, evals, returned = assign_slots(train, required, optional)
                        self.assertGreaterEqual(split, 2)
                        self.assertEqual(sorted(brush_eval_views(order, split)), sorted(evals))
                        for i, (_, is_eval) in enumerate(order):
                            self.assertEqual(is_eval, i % split == 0)
                        everything = train + required + optional
                        self.assertEqual(sorted(item for item, _ in order), sorted(everything))
                        self.assertEqual(sorted(evals + returned), sorted(required + optional))

    def test_optional_frames_go_back_to_training_before_required_ones(self):
        required, optional = list(range(100, 127)), list(range(200, 240))
        split, order, evals, returned = assign_slots(range(100), required, optional)
        self.assertTrue(returned)
        self.assertLessEqual(set(required), set(evals))
        self.assertLessEqual(set(returned), set(optional))

    def test_thinned_eval_frames_stay_spread_out(self):
        optional = list(range(200, 240))
        _, _, evals, _ = assign_slots(range(100), range(100, 127), optional)
        kept = sorted(set(evals) & set(optional))
        self.assertLess(kept[0], 205)
        self.assertGreater(kept[-1], 234)

    def test_no_eval_frames_means_no_split(self):
        self.assertEqual(assign_slots(["a", "b"], []), (None, [("a", False), ("b", False)], [], []))

    def test_a_training_frame_is_required(self):
        with self.assertRaises(ValueError):
            assign_slots([], ["a"], ["b"])


class PlanHoldoutTests(unittest.TestCase):
    def test_far_frames_are_contiguous_runs_away_from_the_ends(self):
        far, _ = plan_holdout(165)
        self.assertEqual([len(r) for r in runs(far)], [9, 9, 9])
        self.assertGreater(far[0], 0)
        self.assertLess(far[-1], 164)

    def test_near_frames_never_touch_a_far_run(self):
        for n in (40, 100, 165, 600):
            far, near = plan_holdout(n)
            for i in near:
                self.assertFalse({i - 1, i, i + 1} & set(far), (n, i))

    def test_short_sequences_keep_most_frames_for_training(self):
        for n in range(0, 60):
            far, near = plan_holdout(n)
            self.assertFalse(set(far) & set(near))
            if n >= 4:
                self.assertGreaterEqual(n - len(far) - len(near), n / 2, n)
            else:
                self.assertEqual((far, near), ([], []))

    def test_either_group_can_be_turned_off(self):
        self.assertEqual(plan_holdout(100, blocks=0)[0], [])
        self.assertEqual(plan_holdout(100, every=0)[1], [])


class PathDistanceTests(unittest.TestCase):
    def test_distances_on_a_straight_path(self):
        centers = [(float(i), 0.0, 0.0) for i in range(10)]
        d = path_distances(centers, train=[0, 1, 2, 7, 8, 9], evals=[3, 4, 5, 6])
        self.assertEqual([d[i]["frames_away"] for i in (3, 4, 5, 6)], [1, 2, 2, 1])
        self.assertAlmostEqual(d[4]["steps_away"], 2.0)

    def test_a_camera_that_never_moved_has_no_step_scale(self):
        d = path_distances([(0.0, 0.0, 0.0)] * 5, train=[0, 1, 3, 4], evals=[2])
        self.assertIsNone(d[2]["steps_away"])


if __name__ == "__main__":
    unittest.main()
