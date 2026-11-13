"""Test the command list and the argument checks of the root runner."""

import base64
import importlib.util
import json
import os
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

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


ECHO_PR = {
    "description": "Print a pull request number.",
    "argv": ["/bin/echo", "{pr}"],
    "args": {"pr": {"pattern": "^[1-9][0-9]{0,6}$"}},
    "cwd": "fresh",
    "timeout_seconds": 60,
    "output_bytes": 30000,
}
TEST_AT = {
    "description": "Run the tests of one repository at a commit.",
    "argv": ["make", "test"],
    "args": {
        "repo": {"choice": {"repo-a": "/w/repo-a"}, "as": "clone"},
        "commit": {"pattern": "^[0-9a-f]{7,40}$"},
    },
    "cwd": "worktree",
    "timeout_seconds": 600,
    "output_bytes": 30000,
}
DAY = 86400


class Runs(unittest.TestCase):
    def setUp(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        self.base = Path(folder.name).resolve()
        home = self.base / "home"
        for name, value in {
            "RUNS": self.base / "runs",
            "LOG": self.base / "log/run.jsonl",
            "LIST": self.base / "commands.json",
            "HOME": home,
            "SECRETS": home / ".tokiwa/secrets.env",
            "WAIT_SECONDS": 0,
            "command": self.fake_command,
            "chown": lambda path, user: self.owners.append((Path(path), user)),
        }.items():
            patcher = mock.patch.object(run, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.calls = []
        self.owners = []
        self.units = ""
        self.active = "active"
        self.commit_known = True
        self.write_list(
            {
                "echo-pr": ECHO_PR,
                "review-pr": REVIEW_PR,
                "test-at": TEST_AT,
                "echo-secret": {**ECHO_PR, "secrets": ["API_KEY"]},
            }
        )

    def fake_command(self, argv):
        self.calls.append(list(argv))
        code, stdout = 0, ""
        if argv[:2] == ["systemctl", "list-units"]:
            stdout = self.units
        elif argv[:2] == ["systemctl", "is-active"]:
            stdout = self.active + "\n"
            code = 0 if self.active == "active" else 3
        elif "cat-file" in argv:
            code = 0 if self.commit_known else 1
        return subprocess.CompletedProcess(argv, code, stdout, "")

    def write_list(self, entries):
        run.LIST.write_text(json.dumps({"entries": entries}))

    def log_lines(self):
        return [json.loads(line) for line in run.LOG.read_text().splitlines()]

    def calls_to(self, program):
        return [argv for argv in self.calls if argv[0] == program]

    def start(self, name="echo-pr", values=None, **keywords):
        values = {"pr": "42"} if values is None else values
        return run.start(name, values, "mcp", "orchestrator-a", **keywords)

    def run_ids(self):
        if not run.RUNS.exists():
            return []
        return sorted(p.name for p in run.RUNS.iterdir() if p.is_dir())

    def test_unit_command_for_a_fresh_run_hides_the_private_volume(self):
        folder = run.RUNS / "20261112T183000-7f3a"
        argv = ["/bin/echo", "4 2"]
        unit = run.unit_command(
            "20261112T183000-7f3a", ECHO_PR, argv, folder / "work", None
        )
        self.assertEqual(
            unit[:8],
            [
                "systemd-run",
                "--unit=tokiwa-run-20261112T183000-7f3a",
                "--uid=agent-workspace",
                "--gid=agent-workspace",
                "--slice=agent-sessions.slice",
                f"--working-directory={folder}/work",
                "--collect",
                "--no-block",
            ],
        )
        self.assertIn("--property=InaccessiblePaths=/srv/development/private", unit)
        self.assertIn(f"--property=ReadWritePaths={folder}", unit)
        self.assertIn(f"--property=StandardOutput=file:{folder}/output", unit)
        self.assertIn("--property=RuntimeMaxSec=60", unit)
        self.assertIn("--setenv=PATH=/usr/local/bin:/usr/bin:/bin", unit)
        self.assertIn(f"--setenv=HOME={folder}", unit)
        self.assertFalse([item for item in unit if "CLAUDE_CONFIG_DIR" in item])
        self.assertFalse([item for item in unit if "EnvironmentFile" in item])
        runner = Path(run.__file__).resolve()
        self.assertIn(
            f"--property=ExecStopPost=+/usr/bin/python3 -I {runner} finish "
            "20261112T183000-7f3a",
            unit,
        )
        self.assertEqual(unit[unit.index("--") + 1 :], argv)

    def test_unit_command_for_a_workbench_run_keeps_secrets_hidden(self):
        folder = run.RUNS / "20261112T183000-7f3a"
        env_file = run.RUNS / "20261112T183000-7f3a.env"
        workbench = {**REVIEW_PR, "secrets": ["API_KEY"]}
        unit = run.unit_command(
            "20261112T183000-7f3a", workbench, ["review"], folder / "work", env_file
        )
        options = unit[: unit.index("--")]
        self.assertIn(f"--property=InaccessiblePaths={run.HOME}/.tokiwa", options)
        self.assertIn(
            "--property=InaccessiblePaths=/srv/development/private/peermesh", options
        )
        self.assertNotIn(
            "--property=InaccessiblePaths=/srv/development/private", options
        )
        self.assertIn(f"--property=ReadWritePaths={run.HOME}", options)
        self.assertIn(f"--property=EnvironmentFile={env_file}", options)
        self.assertIn(f"--setenv=HOME={run.HOME}", options)
        self.assertIn(f"--setenv=CLAUDE_CONFIG_DIR={run.HOME}/.claude", options)
        self.assertIn(f"--setenv=CODEX_HOME={run.HOME}/.codex", options)
        self.assertFalse(
            [item for item in options if item.startswith("--setenv=API_KEY")]
        )

    def test_named_secrets_go_to_a_root_only_file(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export API_KEY='v a l'\nexport OTHER='x'\n")
        result = self.start("echo-secret")
        env_file = run.RUNS / f"{result['id']}.env"
        self.assertEqual(env_file.read_text(), "API_KEY=v a l\n")
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("v a l", run.LOG.read_text())
        self.assertFalse([argv for argv in self.calls if "v a l" in " ".join(argv)])
        (unit,) = self.calls_to("systemd-run")
        self.assertIn(f"--property=EnvironmentFile={env_file}", unit)

    def test_a_secret_with_quotes_is_quoted_for_the_environment_file(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export API_KEY='say \"hi\" $x'\n")
        result = self.start("echo-secret")
        env_file = run.RUNS / f"{result['id']}.env"
        self.assertEqual(env_file.read_text(), 'API_KEY="say \\"hi\\" \\$x"\n')

    def test_a_missing_secret_is_refused(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export OTHER='x'\n")
        with self.assertRaises(run.Refused) as caught:
            self.start("echo-secret")
        self.assertIn("API_KEY", str(caught.exception))
        self.assertFalse(self.calls_to("systemd-run"))
        self.assertEqual(list(run.RUNS.iterdir()), [])

    def test_start_logs_and_starts_the_unit(self):
        result = self.start()
        self.assertEqual(
            set(result),
            {"id", "entry", "state", "exit", "offset", "next_offset", "size",
             "truncated", "text"},
        )
        self.assertRegex(result["id"], run.ID_PATTERN)
        self.assertEqual((result["entry"], result["state"]), ("echo-pr", "running"))
        (line,) = self.log_lines()
        self.assertEqual(
            {k: line[k] for k in ("id", "entry", "args", "via", "actor", "state")},
            {
                "id": result["id"],
                "entry": "echo-pr",
                "args": {"pr": "42"},
                "via": "mcp",
                "actor": "orchestrator-a",
                "state": "running",
            },
        )
        (unit,) = self.calls_to("systemd-run")
        self.assertEqual(unit[unit.index("--") + 1 :], ["/bin/echo", "42"])
        folder = run.RUNS / result["id"]
        self.assertEqual(folder.stat().st_mode & 0o777, 0o700)
        self.assertIn((folder, "agent-workspace"), self.owners)
        self.assertTrue((folder / "work").is_dir())

    def test_refusals_are_logged(self):
        with self.assertRaises(run.Refused):
            self.start("unknown", {})
        (line,) = self.log_lines()
        self.assertEqual(line["entry"], "unknown")
        self.assertTrue(line["refused"].endswith("Nothing was run."))
        self.assertFalse(self.calls_to("systemd-run"))

    def test_fifth_run_is_refused(self):
        self.units = "".join(
            f"tokiwa-run-20261112T18300{n}-7f3a.service loaded active running x\n"
            for n in range(4)
        )
        with self.assertRaises(run.Refused) as caught:
            self.start()
        self.assertIn("4", str(caught.exception))
        self.assertFalse(self.calls_to("systemd-run"))
        self.assertEqual(self.run_ids(), [])

    def test_unknown_commit_is_refused(self):
        self.commit_known = False
        with self.assertRaises(run.Refused) as caught:
            self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        self.assertEqual(
            str(caught.exception),
            "The commit 1a2b3c4 is not in the clone. Nothing was run.",
        )
        self.assertIn(
            [
                "runuser", "-u", "agent-workspace", "--", "git", "-C", "/w/repo-a",
                "cat-file", "-e", "1a2b3c4^{commit}",
            ],
            self.calls,
        )
        self.assertFalse([argv for argv in self.calls if "worktree" in argv])
        self.assertFalse(self.calls_to("systemd-run"))
        self.assertEqual(self.run_ids(), [])

    def test_worktree_is_made_and_removed(self):
        result = self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        work = run.RUNS / result["id"] / "work"
        git = ["runuser", "-u", "agent-workspace", "--", "git", "-C", "/w/repo-a"]
        self.assertIn(
            git + ["worktree", "add", "--detach", str(work), "1a2b3c4"], self.calls
        )
        (unit,) = self.calls_to("systemd-run")
        self.assertIn(f"--working-directory={work}", unit)
        run.finish(result["id"], "success", "0")
        self.assertEqual(
            self.calls[-1], git + ["worktree", "remove", "--force", str(work)]
        )

    def test_finish_records_the_end(self):
        result = self.start()
        run.finish(result["id"], "timeout", "")
        end = json.loads((run.RUNS / result["id"] / "end.json").read_text())
        self.assertEqual(end, {"state": "timed-out", "exit": None})
        _, second = self.log_lines()
        self.assertEqual(set(second), {"at", "id", "state", "exit"})
        self.assertEqual(
            (second["id"], second["state"], second["exit"]),
            (result["id"], "timed-out", None),
        )
        self.assertEqual(run.status(result["id"], 0)["state"], "timed-out")
        run.finish(result["id"], "success", "0")
        self.assertEqual(
            (run.status(result["id"], 0)["state"], run.status(result["id"], 0)["exit"]),
            ("done", 0),
        )
        run.finish(result["id"], "exit-code", "2")
        self.assertEqual(run.status(result["id"], 0)["state"], "failed")
        self.assertEqual(run.status(result["id"], 0)["exit"], 2)

    def test_finish_removes_the_secret_file(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export API_KEY='v a l'\n")
        result = self.start("echo-secret")
        run.finish(result["id"], "success", "0")
        self.assertFalse((run.RUNS / f"{result['id']}.env").exists())

    def test_status_of_a_lost_run_is_failed(self):
        self.active = "inactive"
        result = self.start(now=time.time() - 60)
        self.assertEqual((result["state"], result["exit"]), ("failed", None))
        status = run.status(result["id"], 0)
        self.assertEqual((status["state"], status["exit"]), ("failed", None))

    def test_a_unit_that_systemd_has_not_loaded_yet_is_running(self):
        self.active = "inactive"
        result = self.start()
        self.assertEqual((result["state"], result["exit"]), ("running", None))

    def test_paging_and_truncation(self):
        result = self.start()
        output = run.RUNS / result["id"] / "output"
        output.write_bytes(b"a" * 40000)
        first = run.status(result["id"], 0)
        self.assertEqual(
            (first["offset"], first["next_offset"], first["size"], first["truncated"]),
            (0, 15000, 40000, True),
        )
        self.assertEqual(len(first["text"]), 15000)
        second = run.status(result["id"], 15000)
        self.assertEqual((second["next_offset"], len(second["text"])), (None, 15000))
        past = run.status(result["id"], 30000)
        self.assertEqual((past["next_offset"], past["text"]), (None, ""))
        run.finish(result["id"], "success", "0")
        self.assertEqual(output.stat().st_size, 30000)

    def test_page_splits_inside_a_character(self):
        path = self.base / "output"
        path.write_bytes("aé".encode())
        self.assertEqual(run.page(path, 0, 2), ("a\ufffd", 2, 3))
        self.assertEqual(run.page(path, 2, 2), ("\ufffd", None, 3))
        self.assertEqual(run.page(self.base / "missing", 0, 2), ("", None, 0))

    def test_status_refuses_a_bad_id(self):
        for value in ("../x", "20261112T183000-7f3a/../..", "20261112T183000-7f3a"):
            with self.subTest(value):
                with self.assertRaises(run.Refused) as caught:
                    run.status(value, 0)
                self.assertEqual(
                    str(caught.exception),
                    "Use a run id from tokiwa run. Nothing was run.",
                )
        self.assertEqual(self.calls, [])

    def test_planted_links_in_the_run_folder_are_not_followed(self):
        result = self.start()
        folder = run.RUNS / result["id"]
        target = self.base / "root-only"
        target.write_text("private")
        (folder / "output").symlink_to(target)
        (folder / "end.json").symlink_to(target)
        self.assertEqual(run.status(result["id"], 0)["text"], "")
        self.assertEqual(run.status(result["id"], 0)["state"], "running")
        run.finish(result["id"], "success", "0")
        self.assertEqual(target.read_text(), "private")
        self.assertFalse((folder / "end.json").is_symlink())

    def test_old_runs_are_pruned(self):
        now = time.time()
        run.RUNS.mkdir()
        old = run.RUNS / "20261001T000000-aaaa"
        kept = run.RUNS / "20261003T000000-bbbb"
        for folder, age in ((old, 15 * DAY), (kept, 13 * DAY)):
            (folder / "work").mkdir(parents=True)
            os.utime(folder, (now - age, now - age))
        self.start(now=now)
        self.assertFalse(old.exists())
        self.assertTrue(kept.exists())

    def test_seal_round_trip(self):
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        key, cert = Path(folder.name) / "key.pem", Path(folder.name) / "cert.pem"
        subprocess.run(
            ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes",
             "-keyout", key, "-out", cert, "-subj", "/CN=test", "-days", "1"],
            check=True,
            capture_output=True,
        )
        sealed = run.seal({"a": 1}, base64.b64encode(cert.read_bytes()).decode())
        opened = subprocess.run(
            ["openssl", "smime", "-decrypt", "-binary", "-inform", "DER",
             "-inkey", key, "-recip", cert],
            input=base64.b64decode(sealed),
            check=True,
            capture_output=True,
        )
        self.assertEqual(json.loads(opened.stdout), {"a": 1})
        with self.assertRaises(ValueError):
            run.seal({"a": 1}, "not base64!")

    @unittest.skipIf(os.geteuid() == 0, "the test runs as root")
    def test_cli_refuses_without_root(self):
        done = subprocess.run(
            [sys.executable, "-I", run.__file__, "commands"],
            capture_output=True,
            text=True,
        )
        self.assertEqual(done.returncode, 1)
        self.assertEqual(
            done.stderr, "The command runner needs root. Nothing was run.\n"
        )
        self.assertEqual(done.stdout, "")


if __name__ == "__main__":
    unittest.main()
