"""Test the command list and the argument checks of the root runner."""

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "tokiwa_run", Path(__file__).resolve().parents[1] / "tokiwa-run.py"
)
run = importlib.util.module_from_spec(spec)
spec.loader.exec_module(run)

REVIEW_PR = {
    "description": "Run the review script of one repository for a pull request.",
    "argv": ["{clone}/scripts/review.sh", "--pr", "{pr}", "--commit", "{commit}"],
    "args": {
        "repo": {"choice": {"repo-a": "/w/repo-a"}, "as": "clone"},
        "pr": {"pattern": "^[1-9][0-9]{0,6}$"},
        "commit": {"pattern": "^[0-9a-f]{7,40}$"},
    },
    "cwd": "fresh",
    "home": "workbench",
    "secrets": [],
    "timeout_seconds": 1800,
    "output_bytes": 200000,
}
GOOD = {"repo": "repo-a", "pr": "42", "commit": "1a2b3c4"}


def entry(**changes):
    return {**REVIEW_PR, **changes}


class ListAndArguments(unittest.TestCase):
    def write_list(self, text):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        path = Path(folder.name) / "commands.json"
        path.write_text(text)
        return path

    def test_valid_list_loads(self):
        path = self.write_list(json.dumps({"entries": {"review-pr": REVIEW_PR}}))
        self.assertEqual(run.load_list(path)["review-pr"]["home"], "workbench")

    def test_invalid_lists_are_refused(self):
        cases = {
            "unknown key": json.dumps({"entries": {"a": entry(shell=True)}}),
            "unanchored pattern": json.dumps(
                {"entries": {"a": entry(args={"pr": {"pattern": "[0-9]+"}}, argv=["x"])}}
            ),
            "placeholder without arg": json.dumps(
                {"entries": {"a": entry(argv=["{missing}"], args={}, cwd="fresh")}}
            ),
            "worktree without clone": json.dumps(
                {
                    "entries": {
                        "a": entry(
                            cwd="worktree",
                            argv=["x"],
                            args={"commit": {"pattern": "^[0-9a-f]+$"}},
                        )
                    }
                }
            ),
            "not json": "{not json",
        }
        for label, text in cases.items():
            with self.subTest(label):
                with self.assertRaises(run.Refused) as caught:
                    run.load_list(self.write_list(text))
                self.assertTrue(str(caught.exception).endswith("Nothing was run."))

    def test_check_call_fills_and_renames(self):
        self.assertEqual(
            run.check_call(REVIEW_PR, GOOD),
            {"clone": "/w/repo-a", "pr": "42", "commit": "1a2b3c4"},
        )

    def test_missing_extra_and_bad_values_are_refused(self):
        without_pr = {k: v for k, v in GOOD.items() if k != "pr"}
        cases = {
            "missing pr": without_pr,
            "extra x": {**GOOD, "x": "1"},
            "pr zero": {**GOOD, "pr": "0"},
            "bad commit": {**GOOD, "commit": "XYZ"},
            "unknown repo": {**GOOD, "repo": "repo-b"},
        }
        for label, values in cases.items():
            with self.subTest(label):
                with self.assertRaises(run.Refused) as caught:
                    run.check_call(REVIEW_PR, values)
                self.assertTrue(str(caught.exception).endswith("Nothing was run."))

    def test_leading_dash_is_refused_by_anchored_patterns(self):
        with self.assertRaises(run.Refused):
            run.check_call(REVIEW_PR, {**GOOD, "commit": "--upload-pack=x"})

    def test_path_below_refuses_escape(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        base = Path(folder.name).resolve()
        root = base / "root"
        (root / "sub").mkdir(parents=True)
        (root / "sub/file").write_text("x")
        (base / "outside").mkdir()
        (root / "link").symlink_to(base / "outside")
        spec_ = entry(
            argv=["cat", "{path}"], args={"path": {"path_below": str(root)}}, cwd="fresh"
        )
        for value in ("sub/../../outside", "link", "sub/missing"):
            with self.subTest(value):
                with self.assertRaises(run.Refused):
                    run.check_call(spec_, {"path": value})
        self.assertEqual(
            run.check_call(spec_, {"path": "sub/file"}),
            {"path": str(root / "sub/file")},
        )

    def test_path_below_refuses_a_nul_byte(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        spec_ = entry(
            argv=["cat", "{path}"], args={"path": {"path_below": folder.name}}, cwd="fresh"
        )
        with self.assertRaises(run.Refused) as caught:
            run.check_call(spec_, {"path": "a\x00b"})
        self.assertTrue(str(caught.exception).endswith("Nothing was run."))

    def test_fill_argv_keeps_each_value_whole(self):
        filled = {"clone": "/w/repo-a", "pr": "4 2"}
        self.assertEqual(
            run.fill_argv(["{clone}/scripts/review.sh", "--pr", "{pr}"], filled),
            ["/w/repo-a/scripts/review.sh", "--pr", "4 2"],
        )

    def test_public_view_hides_choice_values(self):
        view = run.public_view({"review-pr": REVIEW_PR})
        self.assertEqual(view[0]["args"]["repo"], {"choice": ["repo-a"]})
        self.assertNotIn("/w/", json.dumps(view))


if __name__ == "__main__":
    unittest.main()
