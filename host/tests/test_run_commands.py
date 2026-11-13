"""Test the command list and the argument checks of the root runner."""

import base64
import contextlib
import fcntl
import importlib.util
import io
import json
import os
import shutil
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
REAL_COMMAND = run.command
REAL_SEAL = run.seal

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

    def test_reserved_secret_names_are_refused(self):
        for name in (
            "LD_PRELOAD", "MALLOC_CHECK_", "PYTHONPATH", "SYSTEMD_LOG_LEVEL", "TOKIWA_VIA",
            "TMUX", "TMUX_TMPDIR", "LISTEN_FDS", "GCONV_PATH", "LOCPATH", "PATH", "HOME",
            "SHELL", "USER", "LOGNAME", "PWD", "BROWSER", "PS1", "CLAUDE_CONFIG_DIR",
            "CODEX_HOME", "SERVICE_RESULT", "EXIT_CODE", "EXIT_STATUS",
            "CREDENTIALS_DIRECTORY", "NOTIFY_SOCKET", "OPENSSL_CONF", "OPENSSL_MODULES",
            "NLSPATH", "GLIBC_TUNABLES", "TZ", "TZDIR", "HOSTALIASES",
        ):
            with self.subTest(name):
                path = self.write_list(json.dumps({"entries": {"a": entry(secrets=[name])}}))
                with self.assertRaises(run.Refused) as caught:
                    run.load_list(path)
                self.assertIn("reserved", str(caught.exception))
        path = self.write_list(json.dumps({"entries": {"a": entry(secrets=["API_KEY"])}}))
        self.assertEqual(run.load_list(path)["a"]["secrets"], ["API_KEY"])

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
        outside = "The path of path is not below its root. Nothing was run."
        cases = {
            "sub/../../outside": outside,
            "link": outside,
            # A path outside the root that does not exist gets the same answer, so that a
            # caller cannot learn which host paths exist.
            "../missing-outside": outside,
            "link/missing": outside,
            "sub/missing": "The path of path does not exist. Nothing was run.",
        }
        for value, message in cases.items():
            with self.subTest(value):
                with self.assertRaises(run.Refused) as caught:
                    run.check_call(spec_, {"path": value})
                self.assertEqual(str(caught.exception), message)
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

    def writable_entry(self, writable, **changes):
        return entry(
            argv=["/usr/bin/git", "-C", "{clone}", "pull"],
            args={
                "repo": {"choice": {"repo-a": "/ws/a/repo-a"}, "as": "clone"},
                "pr": {"pattern": "^[1-9][0-9]{0,6}$"},
                "path": {"path_below": "/ws/a"},
            },
            writable=writable,
            **changes,
        )

    def load_writable(self, writable, **changes):
        text = json.dumps({"entries": {"a": self.writable_entry(writable, **changes)}})
        with mock.patch.object(run, "WORKSPACES", Path("/ws")):
            return run.load_list(self.write_list(text))["a"]

    def test_a_valid_writable_list_loads(self):
        self.assertEqual(self.load_writable([])["writable"], [])
        loaded = self.load_writable(["/ws/shared/repo-b", "{clone}"])
        self.assertEqual(loaded["writable"], ["/ws/shared/repo-b", "{clone}"])

    def test_an_entry_without_writable_loads(self):
        path = self.write_list(json.dumps({"entries": {"a": REVIEW_PR}}))
        self.assertNotIn("writable", run.load_list(path)["a"])

    def test_invalid_writable_lists_are_refused(self):
        cases = {
            "not a list": "/ws/a",
            "item not a string": [5],
            "relative path": ["ws/a"],
            "dot dot": ["/ws/a/../b"],
            "not normal": ["/ws//a"],
            "trailing slash": ["/ws/a/"],
            "space": ["/ws/my repo"],
            "tab": ["/ws/my\trepo"],
            "dollar": ["/ws/$HOME"],
            "percent": ["/ws/%h"],
            "workspaces itself": ["/ws"],
            "outside": ["/etc"],
            "beside": ["/ws-other/a"],
            "pattern argument": ["{pr}"],
            "path_below argument": ["{path}"],
            "no argument": ["{missing}"],
            "partial placeholder": ["/ws/{clone}"],
            "argument name instead of as": ["{repo}"],
        }
        for label, writable in cases.items():
            with self.subTest(label):
                with self.assertRaises(run.Refused) as caught:
                    self.load_writable(writable)
                text = str(caught.exception)
                self.assertTrue(text.startswith("The command list is invalid: entry a: "))
                self.assertTrue(text.endswith("Nothing was run."))

    def test_a_choice_value_that_a_placeholder_names_is_checked(self):
        for label, value in {
            "outside": "/etc/repo-a",
            "workspaces itself": "/ws",
            "space": "/ws/my repo",
            "relative": "repo-a",
        }.items():
            with self.subTest(label):
                spec_ = self.writable_entry(["{clone}"])
                spec_["args"]["repo"]["choice"]["repo-a"] = value
                path = self.write_list(json.dumps({"entries": {"a": spec_}}))
                with mock.patch.object(run, "WORKSPACES", Path("/ws")):
                    with self.assertRaises(run.Refused) as caught:
                        run.load_list(path)
                self.assertIn("writable", str(caught.exception))


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
# The limits of cloud-workbench.service that every run unit and every git unit gets.
SANDBOX = [
    "NoNewPrivileges=yes",
    "ProtectSystem=strict",
    "ProtectHome=yes",
    "PrivateDevices=yes",
    "ProtectKernelTunables=yes",
    "ProtectKernelModules=yes",
    "ProtectControlGroups=yes",
    "RestrictSUIDSGID=yes",
    "CapabilityBoundingSet=",
    "UMask=0077",
    "TasksMax=512",
    "MemoryMax=8G",
    "MemorySwapMax=0",
    "InaccessiblePaths=-/run/docker.sock -/var/run/docker.sock -/var/lib/agent-platform",
]


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
            "WORKSPACES": self.base / "ws",
            "SECRETS": home / ".tokiwa/secrets.env",
            "WAIT_SECONDS": 0,
            "command": self.fake_command,
            "chown": lambda path, user: self.owners.append((Path(path), user)),
            "uid_of": lambda user: os.getuid(),
        }.items():
            patcher = mock.patch.object(run, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        (self.base / "ws/repo-a").mkdir(parents=True)
        (self.base / "ws/repo-b").mkdir()
        self.calls = []
        self.owners = []
        self.units = ""
        self.active = "active"
        self.shown = "success\n0\n"
        self.commit_known = True
        self.start_code = 0
        self.timeouts = []
        self.step_seconds = {}
        self.lock_free_during_start = None
        self.write_list(
            {
                "echo-pr": ECHO_PR,
                "review-pr": REVIEW_PR,
                "test-at": TEST_AT,
                "echo-secret": {**ECHO_PR, "secrets": ["API_KEY"]},
                "pull-repo": self.pull_entry(),
            }
        )

    def pull_entry(self, writable=("{clone}", "FIXED")):
        ws = self.base / "ws"
        return {
            "description": "Pull one clone.",
            "argv": ["/usr/bin/git", "-C", "{clone}", "pull", "--ff-only"],
            "args": {"repo": {"choice": {"repo-a": str(ws / "repo-a")}, "as": "clone"}},
            "cwd": "fresh",
            "home": "workbench",
            "writable": [str(ws / "repo-b") if w == "FIXED" else w for w in writable],
            "timeout_seconds": 300,
            "output_bytes": 100000,
        }

    def fake_command(self, argv, timeout=20):
        self.calls.append(list(argv))
        self.timeouts.append(timeout)
        for word, seconds in self.step_seconds.items():
            if word in argv:
                self.elapsed += seconds
        code, stdout = 0, ""
        if argv[:2] == ["systemctl", "list-units"]:
            stdout = self.units
        elif argv[:2] == ["systemctl", "show"]:
            stdout = self.shown
        elif argv[:2] == ["systemctl", "is-active"]:
            if self.active is None:
                return subprocess.CompletedProcess(argv, run.TIMED_OUT, "", "")
            stdout = self.active + "\n"
            code = 0 if self.active == "active" else 3
        elif "cat-file" in argv:
            code = 0 if self.commit_known else 1
        elif argv[0] == "systemd-run" and argv[1].startswith("--unit="):
            code = self.start_code
            with open(run.RUNS / ".lock", "a") as lock:
                try:
                    fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
                    self.lock_free_during_start = True
                except BlockingIOError:
                    self.lock_free_during_start = False
        return subprocess.CompletedProcess(argv, code, stdout, "")

    def write_list(self, entries):
        run.LIST.write_text(json.dumps({"entries": entries}))

    def log_lines(self):
        return [json.loads(line) for line in run.LOG.read_text().splitlines()]

    def calls_to(self, program):
        return [argv for argv in self.calls if argv[0] == program]

    def run_units(self):
        """The systemd-run calls that start a run, without the git calls."""
        return [argv for argv in self.calls_to("systemd-run") if argv[1].startswith("--unit=")]

    def git(self, seconds, *argv, clone="/w/repo-a", work=None):
        """The systemd-run call that runs one git command in the run's sandbox."""
        return [
            "systemd-run", "--wait", "--pipe", "--collect", "--quiet", "--uid=agent-workspace",
            "--gid=agent-workspace", "--slice=agent-sessions.slice",
            *(f"--property={item}" for item in SANDBOX),
            f"--property=ReadWritePaths={clone}/.git {work}",
            f"--property=RuntimeMaxSec={seconds}",
            "--", "git", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
            "-C", clone, *argv,
        ]

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
                "--property=RuntimeMaxSec=60",
            ],
        )
        self.assertNotIn("--no-block", unit)
        self.assertIn("--property=InaccessiblePaths=/srv/development/private", unit)
        self.assertIn(f"--property=ReadWritePaths={folder}/work", unit)
        self.assertNotIn(f"--property=ReadWritePaths={folder}", unit)
        self.assertIn(f"--property=StandardOutput=file:{folder}/output", unit)
        self.assertIn("--setenv=PATH=/usr/local/bin:/usr/bin:/bin", unit)
        self.assertIn(f"--setenv=HOME={folder}/work", unit)
        self.assertFalse([item for item in unit if "CLAUDE_CONFIG_DIR" in item])
        self.assertFalse([item for item in unit if "EnvironmentFile" in item])
        runner = Path(run.__file__).resolve()
        self.assertIn(
            f"--property=ExecStopPost=+/usr/bin/env -i /usr/bin/python3 -I {runner} finish "
            "20261112T183000-7f3a",
            unit,
        )
        self.assertEqual(unit[unit.index("--") + 1 :], argv)

    def test_a_run_unit_gets_each_writable_folder_after_the_other_paths(self):
        ws = self.base / "ws"
        result = self.start("pull-repo", {"repo": "repo-a"})
        (unit,) = self.run_units()
        folder = run.RUNS / result["id"]
        paths = [item for item in unit if item.startswith("--property=ReadWritePaths=")]
        self.assertEqual(
            paths,
            [
                f"--property=ReadWritePaths={folder}/work",
                f"--property=ReadWritePaths={run.HOME}",
                f"--property=ReadWritePaths={ws / 'repo-a'}",
                f"--property=ReadWritePaths={ws / 'repo-b'}",
            ],
        )

    def test_an_entry_without_writable_adds_no_path(self):
        self.start()
        (unit,) = self.run_units()
        self.assertEqual(
            [item for item in unit if "ReadWritePaths" in item],
            [f"--property=ReadWritePaths={run.RUNS / self.run_ids()[0]}/work"],
        )

    def test_a_symlinked_writable_folder_gives_its_resolved_path(self):
        ws = self.base / "ws"
        (ws / "link").symlink_to(ws / "repo-a")
        self.write_list({"pull-repo": self.pull_entry(["{clone}", "LINK"])})
        spec_ = json.loads(run.LIST.read_text())
        spec_["entries"]["pull-repo"]["writable"][1] = str(ws / "link")
        run.LIST.write_text(json.dumps(spec_))
        self.start("pull-repo", {"repo": "repo-a"})
        (unit,) = self.run_units()
        self.assertIn(f"--property=ReadWritePaths={ws / 'repo-a'}", unit)
        self.assertNotIn(f"--property=ReadWritePaths={ws / 'link'}", unit)

    def test_the_git_units_get_no_writable_folder(self):
        self.write_list({"pull-repo": {**self.pull_entry(), "cwd": "worktree"}})
        spec_ = json.loads(run.LIST.read_text())
        entry_ = spec_["entries"]["pull-repo"]
        entry_["args"]["commit"] = {"pattern": "^[0-9a-f]{7,40}$"}
        run.LIST.write_text(json.dumps(spec_))
        self.use_fake_clock()
        self.start("pull-repo", {"repo": "repo-a", "commit": "1a2b3c4"})
        gits = [a for a in self.calls_to("systemd-run") if "--wait" in a]
        self.assertTrue(gits)
        for argv in gits:
            self.assertEqual(
                [item for item in argv if "ReadWritePaths" in item],
                [item for item in argv if item.startswith("--property=ReadWritePaths=")
                 and "/.git " in item],
            )
            self.assertNotIn(str(self.base / "ws/repo-b"), " ".join(argv))

    def test_a_writable_folder_that_escapes_the_workspace_is_refused(self):
        ws = self.base / "ws"
        outside = self.base / "outside"
        outside.mkdir()
        def link_out():
            (ws / "repo-a").symlink_to(outside)

        def write_file():
            (ws / "repo-a").write_text("x")

        cases = {"link out": link_out, "missing": lambda: None, "a file": write_file}
        for label, break_it in cases.items():
            with self.subTest(label):
                shutil.rmtree(ws / "repo-a", ignore_errors=True)
                (ws / "repo-a").unlink(missing_ok=True)
                break_it()
                self.calls.clear()
                with self.assertRaises(run.Refused) as caught:
                    self.start("pull-repo", {"repo": "repo-a"})
                self.assertEqual(
                    str(caught.exception),
                    "The writable folder of pull-repo is not below the workspace folder. "
                    "Nothing was run.",
                )
                self.assertEqual(self.run_units(), [])
                self.assertEqual(self.run_ids(), [])
                self.assertIn("refused", self.log_lines()[-1])

    def test_every_run_unit_has_the_limits_of_the_session_unit(self):
        folder = run.RUNS / "20261112T183000-7f3a"
        for spec_ in (ECHO_PR, REVIEW_PR):
            with self.subTest(home=spec_.get("home", "none")):
                unit = run.unit_command(
                    "20261112T183000-7f3a", spec_, ["x"], folder / "work", None
                )
                options = unit[: unit.index("--")]
                for item in SANDBOX:
                    self.assertIn(f"--property={item}", options)

    def test_unit_command_keeps_each_dollar_literal(self):
        unit = run.unit_command(
            "20261112T183000-7f3a", ECHO_PR, ["/bin/echo", "${API_KEY} $HOME"],
            run.RUNS / "20261112T183000-7f3a/work", None,
        )
        self.assertEqual(unit[unit.index("--") + 1 :], ["/bin/echo", "$${API_KEY} $$HOME"])

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
        self.assertIn(f"--property=ReadWritePaths={folder}/work", options)
        self.assertNotIn(f"--property=ReadWritePaths={folder}", options)
        self.assertNotIn("--no-block", options)
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
        self.assertEqual(env_file.read_text(), 'API_KEY="v a l"\n')
        self.assertEqual(env_file.stat().st_mode & 0o777, 0o600)
        self.assertNotIn("v a l", run.LOG.read_text())
        self.assertFalse([argv for argv in self.calls if "v a l" in " ".join(argv)])
        (unit,) = self.calls_to("systemd-run")
        self.assertIn(f"--property=EnvironmentFile={env_file}", unit)

    def test_a_secret_with_quotes_is_quoted_for_the_environment_file(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export API_KEY='say \"hi\" $x \\ y'\n")
        result = self.start("echo-secret")
        env_file = run.RUNS / f"{result['id']}.env"
        self.assertEqual(env_file.read_text(), 'API_KEY="say \\"hi\\" $x \\\\ y"\n')

    def test_a_secret_with_a_newline_or_nul_is_refused(self):
        run.SECRETS.parent.mkdir(parents=True)
        for value in ("line-one\nline-two", "part-one\0part-two"):
            with self.subTest(repr(value)):
                run.SECRETS.write_text(f"export API_KEY='{value}'\n")
                with self.assertRaises(run.Refused) as caught:
                    self.start("echo-secret")
                self.assertEqual(
                    str(caught.exception),
                    "The secret API_KEY cannot be passed. Nothing was run.",
                )
                self.assertNotIn("part-one", run.LOG.read_text())
                self.assertNotIn("line-one", run.LOG.read_text())
                self.assertFalse(self.calls_to("systemd-run"))
                self.assertEqual(list(run.RUNS.glob("*.env")), [])
                self.assertEqual(self.run_ids(), [])

    def test_a_secrets_file_that_is_not_plain_is_refused(self):
        tokiwa = run.SECRETS.parent
        elsewhere = self.base / "elsewhere"

        def planted_file_link(stack):
            tokiwa.mkdir(parents=True)
            (elsewhere / "secrets.env").write_text("export API_KEY='x'\n")
            run.SECRETS.symlink_to(elsewhere / "secrets.env")

        def planted_folder_link(stack):
            (elsewhere / "secrets.env").write_text("export API_KEY='x'\n")
            run.HOME.mkdir(parents=True, exist_ok=True)
            tokiwa.symlink_to(elsewhere)

        def fifo(stack):
            tokiwa.mkdir(parents=True)
            os.mkfifo(run.SECRETS)

        def other_owner(stack):
            tokiwa.mkdir(parents=True)
            run.SECRETS.write_text("export API_KEY='x'\n")
            stack.enter_context(
                mock.patch.object(run, "uid_of", lambda user: os.getuid() + 1)
            )

        def too_large(stack):
            tokiwa.mkdir(parents=True)
            run.SECRETS.write_text("export API_KEY='x'\n" + "#" * (1 << 20))

        for plant in (planted_file_link, planted_folder_link, fifo, other_owner, too_large):
            with self.subTest(plant.__name__), contextlib.ExitStack() as stack:
                elsewhere.mkdir()
                plant(stack)
                with self.assertRaises(run.Refused) as caught:
                    self.start("echo-secret")
                self.assertEqual(
                    str(caught.exception),
                    "The secrets file could not be read. Nothing was run.",
                )
                self.assertFalse(self.calls_to("systemd-run"))
                self.assertEqual(list(run.RUNS.glob("*.env")), [])
                if tokiwa.is_symlink():
                    tokiwa.unlink()
                else:
                    shutil.rmtree(tokiwa)
                shutil.rmtree(elsewhere)

    def test_a_missing_secret_is_refused(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export OTHER='x'\n")
        with self.assertRaises(run.Refused) as caught:
            self.start("echo-secret")
        self.assertIn("API_KEY", str(caught.exception))
        self.assertFalse(self.calls_to("systemd-run"))
        self.assertEqual(list(run.RUNS.glob("*.env")), [])
        self.assertEqual(self.run_ids(), [])

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
        self.assertEqual(folder.stat().st_mode & 0o777, 0o755)
        self.assertEqual((folder / "work").stat().st_mode & 0o777, 0o700)
        self.assertEqual(self.owners, [(folder / "work", "agent-workspace")])
        self.assertIs(self.lock_free_during_start, False)
        self.assertIn(
            [
                "systemctl", "list-units", "tokiwa-run-*", "--no-legend", "--plain",
                "--state=activating,active,deactivating",
            ],
            self.calls,
        )

    def test_a_unit_that_could_not_start_is_failed(self):
        self.start_code = 1
        self.active = "inactive"
        result = self.start()
        self.assertEqual((result["state"], result["exit"]), ("failed", None))
        self.assertEqual(
            [line.get("state") for line in self.log_lines()], ["running", "failed"]
        )

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
        self.use_fake_clock()
        self.commit_known = False
        with self.assertRaises(run.Refused) as caught:
            self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        self.assertEqual(
            str(caught.exception),
            "The commit 1a2b3c4 is not in the clone. Nothing was run.",
        )
        work = self.base / "runs" / self.refused_id() / "work"
        self.assertIn(self.git(12, "cat-file", "-e", "1a2b3c4^{commit}", work=work), self.calls)
        self.assertFalse([argv for argv in self.calls if "worktree" in argv])
        self.assertFalse(self.run_units())
        self.assertEqual(self.run_ids(), [])

    def refused_id(self):
        """The id of the run folder that a refused worktree call made and removed."""
        (git,) = [argv for argv in self.calls if "cat-file" in argv]
        (paths,) = [item for item in git if item.startswith("--property=ReadWritePaths=")]
        return Path(paths.split()[-1]).parent.name

    def test_worktree_is_made_and_removed(self):
        self.use_fake_clock()
        result = self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        work = run.RUNS / result["id"] / "work"
        self.assertIn(
            self.git(12, "worktree", "add", "--detach", str(work), "1a2b3c4", work=work),
            self.calls,
        )
        (unit,) = self.run_units()
        self.assertIn(f"--working-directory={work}", unit)
        self.assertEqual(self.owners, [(work, "agent-workspace")])
        run.finish(result["id"], "success", "0")
        self.assertEqual(
            self.calls[-1],
            self.git(20, "worktree", "remove", "--force", str(work), work=work),
        )

    def test_finish_records_the_end(self):
        result = self.start()
        run.finish(result["id"], "timeout", "")
        end = json.loads((run.RUNS / result["id"] / "end.json").read_text())
        self.assertEqual(end, {"state": "timed-out", "exit": None, "truncated": False})
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
        # After a signal, ExecMainStatus is the signal number and not an exit status.
        run.finish(result["id"], "signal", "9")
        self.assertEqual(
            (run.status(result["id"], 0)["state"], run.status(result["id"], 0)["exit"]),
            ("failed", None),
        )

    def test_unit_end_reads_the_result_from_systemd(self):
        cases = {
            "success\n0\n": ("success", "0"),
            "exit-code\n3\n": ("exit-code", "3"),
            "3\nexit-code\n": ("exit-code", "3"),
            "": ("", ""),
            "success\n": ("", ""),
        }
        for shown, expected in cases.items():
            with self.subTest(shown=shown):
                self.shown = shown
                self.assertEqual(run.unit_end("20261112T183000-7f3a"), expected)
        self.assertEqual(
            self.calls[-1],
            [
                "systemctl", "show", "-p", "Result", "-p", "ExecMainStatus", "--value",
                "tokiwa-run-20261112T183000-7f3a.service",
            ],
        )
        self.assertEqual(self.timeouts[-1], 5)

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

    def test_a_lost_run_removes_its_secrets_file(self):
        run.SECRETS.parent.mkdir(parents=True)
        run.SECRETS.write_text("export API_KEY='v a l'\n")
        self.active = "inactive"
        result = self.start("echo-secret", now=time.time() - 60)
        self.assertEqual(result["state"], "failed")
        self.assertFalse((run.RUNS / f"{result['id']}.env").exists())

    def test_a_state_that_systemd_does_not_give_is_refused(self):
        result = self.start()
        for active in (None, ""):
            with self.subTest(active=active):
                self.active = active
                with self.assertRaises(run.Refused) as caught:
                    run.status(result["id"], 0)
                self.assertEqual(
                    str(caught.exception),
                    f"The state of run {result['id']} could not be read. Nothing was run.",
                )
        self.assertFalse((run.RUNS / result["id"] / "end.json").exists())

    def test_a_start_whose_state_systemd_does_not_give_is_running(self):
        self.active = None
        result = self.start()
        self.assertEqual((result["state"], result["exit"]), ("running", None))

    def test_a_unit_whose_finish_hook_runs_is_still_running(self):
        result = self.start()
        self.active = "deactivating"
        status = run.status(result["id"], 0)
        self.assertEqual((status["state"], status["exit"]), ("running", None))

    def test_a_unit_that_systemd_has_not_loaded_yet_is_running(self):
        self.active = "inactive"
        result = self.start()
        self.assertEqual((result["state"], result["exit"]), ("running", None))

    def test_paging_and_truncation(self):
        result = self.start()
        output = run.RUNS / result["id"] / "output"
        output.write_bytes(b"a" * 40000)
        # Two bytes of each page go to the quotes of its JSON form.
        first = run.status(result["id"], 0)
        self.assertEqual(
            (first["offset"], first["next_offset"], first["size"], first["truncated"]),
            (0, 14998, 40000, True),
        )
        self.assertEqual(len(first["text"]), 14998)
        second = run.status(result["id"], 14998)
        self.assertEqual(second["next_offset"], 29996)
        last = run.status(result["id"], 29996)
        self.assertEqual((last["next_offset"], last["text"]), (None, "aaaa"))
        past = run.status(result["id"], 30000)
        self.assertEqual((past["next_offset"], past["text"]), (None, ""))
        run.finish(result["id"], "success", "0")
        self.assertEqual(output.stat().st_size, 30000)
        after = run.status(result["id"], 0)
        self.assertEqual((after["truncated"], after["size"]), (True, 30000))

    def test_page_splits_inside_a_character(self):
        path = self.base / "output"
        path.write_bytes("a\U0001f600".encode())
        # The whole four-byte character needs 7 bytes of JSON; one U+FFFD needs 6.
        self.assertEqual(run.page(path, 0, 6), ("a\ufffd", 4, 5))
        self.assertEqual(run.page(path, 4, 6), ("\ufffd", None, 5))
        path.write_bytes("aé".encode())
        self.assertEqual(run.page(path, 0, 5), ("aé", None, 3))
        self.assertEqual(run.page(self.base / "missing", 0, 6), ("", None, 0))

    def test_pages_of_bad_bytes_fit_and_cover_the_file(self):
        path = self.base / "output"
        path.write_bytes(b"\xff" * 40000)
        offset, covered = 0, 0
        while offset is not None:
            text, next_offset, size = run.page(path, offset, run.PAGE_BYTES)
            self.assertLessEqual(
                len(json.dumps(text, ensure_ascii=False).encode()), run.PAGE_BYTES
            )
            consumed = (size if next_offset is None else next_offset) - offset
            self.assertGreater(consumed, 0)
            self.assertEqual(len(text), consumed)
            covered += consumed
            offset = next_offset
        self.assertEqual(covered, 40000)

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

    def use_fake_clock(self):
        self.elapsed = 0.0
        self.enterContext(mock.patch.object(run, "clock", lambda: 1000.0 + self.elapsed))

    def test_each_command_of_start_gets_the_time_left(self):
        self.use_fake_clock()
        self.step_seconds = {"cat-file": 5}
        self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        steps = {}
        for argv, timeout in zip(self.calls, self.timeouts):
            word = next(w for w in ("list-units", "cat-file", "add", "systemd-run",
                                    "is-active") if w in argv)
            steps[word] = timeout
        self.assertEqual(
            steps,
            {"list-units": 12, "cat-file": 12, "add": 7, "systemd-run": 7, "is-active": 20},
        )
        limits = [
            item for argv in self.calls for item in argv if item.startswith("--property=Runtime")
        ]
        self.assertEqual(
            limits,
            ["--property=RuntimeMaxSec=12", "--property=RuntimeMaxSec=7",
             "--property=RuntimeMaxSec=600"],
        )

    def test_a_start_that_runs_out_of_time_is_refused_and_cleaned(self):
        self.use_fake_clock()
        self.step_seconds = {"add": 13}
        with self.assertRaises(run.Refused) as caught:
            self.start("test-at", {"repo": "repo-a", "commit": "1a2b3c4"})
        self.assertEqual(str(caught.exception), "The call ran out of time. Nothing was run.")
        self.assertFalse(self.run_units())
        self.assertIn("remove", self.calls[-1])
        self.assertEqual(self.run_ids(), [])
        self.assertIn("refused", self.log_lines()[-1])

    def test_a_busy_runner_refuses_the_call(self):
        self.enterContext(mock.patch.object(run, "START_SECONDS", 0.2))
        run.RUNS.mkdir()
        with open(run.RUNS / ".lock", "a") as lock:
            fcntl.flock(lock, fcntl.LOCK_EX)
            with self.assertRaises(run.Refused) as caught:
                self.start()
        self.assertEqual(
            str(caught.exception), "The command runner is busy. Nothing was run."
        )
        self.assertEqual(self.calls, [])
        self.assertIn("refused", self.log_lines()[-1])
        self.assertEqual(self.run_ids(), [])

    def test_a_command_that_outlasts_its_time_is_killed_with_its_group(self):
        began = time.monotonic()
        done = REAL_COMMAND(["/bin/sh", "-c", "sleep 30 & sleep 30"], 0.3)
        self.assertEqual(done.returncode, run.TIMED_OUT)
        self.assertLess(time.monotonic() - began, 5)

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



class Cli(unittest.TestCase):
    def setUp(self):
        self.calls = []
        self.started = []
        for target, name, value in (
            (run.os, "geteuid", lambda: 0),
            (run, "command", lambda argv, timeout=20: self.calls.append(argv)),
            (run, "start", lambda *call: self.started.append(call) or {"id": "x"}),
            (run, "seal", lambda result, certificate: "sealed"),
        ):
            patcher = mock.patch.object(target, name, value)
            patcher.start()
            self.addCleanup(patcher.stop)
        environment = mock.patch.dict(os.environ)
        environment.start()
        self.addCleanup(environment.stop)
        for name in ("TOKIWA_VIA", "TOKIWA_ACTOR", "SERVICE_RESULT", "EXIT_STATUS"):
            os.environ.pop(name, None)

    def main(self, *argv):
        printed = io.StringIO()
        with contextlib.redirect_stdout(printed):
            run.main(list(argv))
        return printed.getvalue()

    def payload(self, value):
        return base64.b64encode(json.dumps(value).encode()).decode()

    def test_finish_reads_the_result_from_systemd_and_not_the_environment(self):
        finished = []
        for name, value in (
            ("finish", lambda *call: finished.append(call)),
            ("unit_end", lambda run_id: ("exit-code", "3")),
            ("run_folder", lambda run_id: (None, {})),
        ):
            self.enterContext(mock.patch.object(run, name, value))
        os.environ.update(SERVICE_RESULT="success", EXIT_STATUS="0")
        self.main("finish", "20261112T183000-7f3a")
        self.assertEqual(finished, [("20261112T183000-7f3a", "exit-code", "3")])

    def test_finish_checks_the_id_before_it_asks_systemd(self):
        with self.assertRaises(run.Refused):
            self.main("finish", "../x")
        self.assertEqual(self.calls, [])

    def test_start_reads_the_payload_and_prints_the_sealed_result(self):
        os.environ.update(TOKIWA_VIA="mcp", TOKIWA_ACTOR="orchestrator-a")
        printed = self.main(
            "start", self.payload({"entry": "echo-pr", "args": {"pr": "42"}}), "cert"
        )
        self.assertEqual(printed, "sealed\n")
        self.assertEqual(self.started, [("echo-pr", {"pr": "42"}, "mcp", "orchestrator-a")])

    def test_via_and_actor_fall_back_as_the_launcher_does(self):
        cases = {
            ("app", "orchestrator-a"): ("app", "orchestrator-a"),
            ("shell", "bad;rm"): ("cli", ""),
            (None, None): ("cli", ""),
        }
        for (via, actor), expected in cases.items():
            with self.subTest(via=via, actor=actor):
                self.started.clear()
                for name, value in (("TOKIWA_VIA", via), ("TOKIWA_ACTOR", actor)):
                    os.environ.pop(name, None)
                    if value is not None:
                        os.environ[name] = value
                self.main("start", self.payload({"entry": "echo-pr", "args": {}}), "cert")
                self.assertEqual(self.started[0][2:], expected)

    def test_start_refuses_a_bad_payload_or_certificate_before_any_command(self):
        self.enterContext(mock.patch.object(run, "seal", REAL_SEAL))
        good = self.payload({"entry": "echo-pr", "args": {"pr": "42"}})
        cases = {
            "bad certificate": (good, "not base64!"),
            "not base64": ("%%%", "cert"),
            "args not strings": (self.payload({"entry": "a", "args": {"pr": 42}}), "cert"),
            "extra key": (self.payload({"entry": "a", "args": {}, "x": 1}), "cert"),
        }
        for label, (payload, certificate) in cases.items():
            with self.subTest(label):
                with self.assertRaises(run.Refused) as caught:
                    self.main("start", payload, certificate)
                self.assertTrue(str(caught.exception).endswith("Nothing was run."))
        self.assertEqual((self.calls, self.started), ([], []))

    def test_status_parses_the_offset(self):
        statuses = []
        self.enterContext(
            mock.patch.object(run, "status", lambda *call: statuses.append(call) or {})
        )
        self.assertEqual(self.main("status", "20261112T183000-7f3a", "15000", "c"), "sealed\n")
        self.assertEqual(statuses, [("20261112T183000-7f3a", 15000)])
        for offset in ("-1", "x", "1.5", ""):
            with self.subTest(offset):
                with self.assertRaises(run.Refused) as caught:
                    self.main("status", "20261112T183000-7f3a", offset, "c")
                self.assertEqual(
                    str(caught.exception), "Use an offset from an earlier result. Nothing was run."
                )
        self.assertEqual(len(statuses), 1)


if __name__ == "__main__":
    unittest.main()
