"""Test the session-user side of `tokiwa cp`: receive and send, and every refusal."""

import hashlib
import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import unittest
from pathlib import Path
from unittest import mock

PROGRAM = Path(__file__).resolve().parents[1] / "tokiwa-transfer.py"
spec = importlib.util.spec_from_file_location("tokiwa_transfer", PROGRAM)
program = importlib.util.module_from_spec(spec)
spec.loader.exec_module(program)


def tar_bytes(entries):
    """Return a tar stream of (TarInfo, bytes or None) pairs."""
    buffer = io.BytesIO()
    with tarfile.open(fileobj=buffer, mode="w", format=tarfile.PAX_FORMAT) as archive:
        for info, data in entries:
            archive.addfile(info, io.BytesIO(data) if data is not None else None)
    return buffer.getvalue()


def entry(name, kind=tarfile.REGTYPE, data=b"", linkname="", mode=0o644):
    info = tarfile.TarInfo(name)
    info.type, info.mode, info.linkname = kind, mode, linkname
    if kind == tarfile.REGTYPE:
        info.size = len(data)
    return info, data if kind == tarfile.REGTYPE else None


class Transfer(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="tokiwa-transfer-")
        # macOS keeps temporary folders behind a link (/var is /private/var); results name real paths.
        base = Path(os.path.realpath(self.temp.name))
        self.work = base / "work"
        self.cache = base / "cache"
        self.outside = base / "outside"
        for folder in (self.work, self.cache, self.outside):
            folder.mkdir()
        self.patches = [
            mock.patch.object(program, "WORKDIR", self.work),
            mock.patch.dict(os.environ, {"TOKIWA_CACHE_ROOT": str(self.cache)}),
            # The disk of the test machine can be fuller than the host's limit; one test sets it.
            mock.patch.object(program, "MIN_FREE_SHARE", 0.0),
        ]
        for patch in self.patches:
            patch.start()

    def tearDown(self):
        for patch in self.patches:
            patch.stop()
        self.temp.cleanup()

    def receive(self, dest, data, kind="file", name="a.txt", sha=None, size=None, mode=0o644, force=False):
        return program.receive(str(dest), kind, name, sha or hashlib.sha256(data).hexdigest(),
                               len(data) if size is None else size, mode, force, io.BytesIO(data))

    def refused(self, sentence, call, *args, **kwargs):
        with self.assertRaises(ValueError) as caught:
            call(*args, **kwargs)
        self.assertIn(sentence, str(caught.exception))

    def leftovers(self, folder):
        return [p.name for p in folder.iterdir() if p.name.startswith(".tokiwa-cp-")]


class Receive(Transfer):
    def test_places_a_checked_file_with_its_mode(self):
        result = self.receive(self.work / "a.txt", b"hello", mode=0o755)
        target = self.work / "a.txt"
        self.assertEqual(target.read_bytes(), b"hello")
        self.assertEqual(target.stat().st_mode & 0o777, 0o755)
        self.assertEqual(result, {"path": str(target), "kind": "file", "files": 1, "bytes": 5,
                                  "sha256": hashlib.sha256(b"hello").hexdigest()})
        self.assertEqual(self.leftovers(self.work), [])

    def test_a_folder_destination_gets_the_source_under_its_own_name(self):
        result = self.receive(self.cache, b"x", name="report.pdf")
        self.assertEqual(result["path"], str(self.cache / "report.pdf"))
        self.assertEqual((self.cache / "report.pdf").read_bytes(), b"x")

    def test_refuses_an_existing_file_without_force_and_replaces_it_with_force(self):
        target = self.work / "a.txt"
        target.write_bytes(b"old")
        self.refused("exists. Use --force to replace it.", self.receive, target, b"new")
        self.assertEqual(target.read_bytes(), b"old")
        self.receive(target, b"new", force=True)
        self.assertEqual(target.read_bytes(), b"new")
        self.assertEqual(self.leftovers(self.work), [])

    def test_never_replaces_a_directory(self):
        (self.work / "d").mkdir()
        data = tar_bytes([entry("d", tarfile.DIRTYPE)])
        self.refused("A directory is never replaced.", self.receive, self.work, data, kind="dir", name="d", force=True)
        # An existing folder as the destination gets the directory inside it, as cp does.
        self.receive(self.work / "d", data, kind="dir", name="d")
        self.assertTrue((self.work / "d/d").is_dir())
        # A file over an existing folder of the same name is refused too.
        self.refused("A directory is never replaced.", self.receive, self.work, b"x", name="d", force=True)

    def test_refuses_a_wrong_sha256_or_size_and_leaves_no_file(self):
        self.refused("does not match the source", self.receive, self.work / "a.txt", b"hello", sha="0" * 64)
        self.refused("does not match the source", self.receive, self.work / "a.txt", b"hello", size=6)
        self.refused("does not match the source", self.receive, self.work / "a.txt", b"hello", size=4)
        self.assertEqual(list(self.work.iterdir()), [])

    def test_refuses_paths_outside_the_allowed_folders(self):
        sentence = "outside the workbench folder and the session cache"
        self.refused(sentence, self.receive, self.outside / "a.txt", b"x")
        # A link inside an allowed folder that leaves it is refused after it is followed.
        (self.work / "escape").symlink_to(self.outside)
        self.refused(sentence, self.receive, self.work / "escape" / "a.txt", b"x")
        self.refused(sentence, self.receive, self.work / "escape", b"x")
        self.assertEqual(list(self.outside.iterdir()), [])

    def test_refuses_a_destination_whose_folder_does_not_exist(self):
        self.refused("does not exist", self.receive, self.work / "missing" / "a.txt", b"x")

    def test_refuses_a_link_to_nothing_and_a_link_target_with_force(self):
        (self.work / "dangling").symlink_to(self.work / "nowhere")
        self.refused("is a link", self.receive, self.work / "dangling", b"x")
        (self.work / "real.txt").write_bytes(b"old")
        (self.work / "alias.txt").symlink_to(self.work / "real.txt")
        (self.outside / "creds").write_bytes(b"secret")
        (self.work / "out.txt").symlink_to(self.outside / "creds")
        # A link as the destination is refused, also when it points inside: name the real file instead.
        for link in ("alias.txt", "out.txt"):
            self.refused("is a link", self.receive, self.work / link, b"new", force=True)
        self.assertEqual((self.work / "real.txt").read_bytes(), b"old")
        self.assertEqual((self.outside / "creds").read_bytes(), b"secret")

    def test_refuses_low_free_space(self):
        with mock.patch.object(program, "MIN_FREE_SHARE", 1.0):
            self.refused("free space", self.receive, self.work / "a.txt", b"x")
        self.assertEqual(list(self.work.iterdir()), [])

    def test_refuses_sizes_over_the_limit_and_bad_names(self):
        self.refused("at most 10 GB", self.receive, self.work / "a.txt", b"x", size=program.STREAM_LIMIT + 1)
        for name in ("", "a/b", ".", ".."):
            self.refused("not a valid file name", self.receive, self.work, b"x", name=name)

    def test_unpacks_a_directory_with_its_links_and_modes(self):
        data = tar_bytes([
            entry("d", tarfile.DIRTYPE, mode=0o755),
            entry("d/run.sh", data=b"#!/bin/sh\n", mode=0o755),
            entry("d/sub", tarfile.DIRTYPE, mode=0o755),
            entry("d/sub/notes.md", data=b"notes"),
            entry("d/link", tarfile.SYMTYPE, linkname="sub/notes.md"),
        ])
        result = self.receive(self.cache, data, kind="dir", name="d")
        top = self.cache / "d"
        self.assertEqual(result["files"], 5)
        self.assertEqual((top / "sub/notes.md").read_bytes(), b"notes")
        self.assertEqual((top / "run.sh").stat().st_mode & 0o777, 0o755)
        self.assertEqual(os.readlink(top / "link"), "sub/notes.md")
        self.assertEqual(self.leftovers(self.cache), [])

    def test_refuses_unsafe_tar_entries_and_leaves_nothing(self):
        cases = {
            "parent": [entry("d", tarfile.DIRTYPE), entry("d/../x", data=b"x")],
            "absolute": [entry("/tmp/x", data=b"x")],
            "outside name": [entry("d", tarfile.DIRTYPE), entry("other/x", data=b"x")],
            "link out": [entry("d", tarfile.DIRTYPE), entry("d/out", tarfile.SYMTYPE, linkname="../../outside")],
            "device": [entry("d", tarfile.DIRTYPE), entry("d/dev", tarfile.CHRTYPE)],
        }
        for label, entries in cases.items():
            with self.subTest(label):
                self.assertRaises(ValueError, self.receive, self.cache, tar_bytes(entries), kind="dir", name="d")
                self.assertEqual(list(self.cache.iterdir()), [])

    def test_refuses_links_that_leave_the_copied_tree(self):
        # These stay inside the staging folder, so the tarfile data filter alone lets them through.
        cases = {
            "sibling": [entry("d", tarfile.DIRTYPE), entry("d/esc", tarfile.SYMTYPE, linkname="../x")],
            "deep": [entry("d", tarfile.DIRTYPE), entry("d/sub", tarfile.DIRTYPE),
                     entry("d/sub/esc", tarfile.SYMTYPE, linkname="../../x")],
            "absolute": [entry("d", tarfile.DIRTYPE), entry("d/abs", tarfile.SYMTYPE, linkname="/etc/passwd")],
            "hard link": [entry("d", tarfile.DIRTYPE), entry("d/h", tarfile.LNKTYPE, linkname="other/x")],
        }
        for label, entries in cases.items():
            with self.subTest(label):
                self.refused("outside d", self.receive, self.cache, tar_bytes(entries), kind="dir", name="d")
                self.assertEqual(list(self.cache.iterdir()), [])

    def test_a_trailing_slash_needs_an_existing_folder(self):
        self.refused("does not exist", self.receive, f"{self.work}/docs/", b"x", name="r.pdf")
        self.assertEqual(list(self.work.iterdir()), [])

    def test_strips_setuid_bits(self):
        data = tar_bytes([entry("d", tarfile.DIRTYPE), entry("d/tool", data=b"x", mode=0o4755)])
        self.receive(self.cache, data, kind="dir", name="d")
        self.assertEqual((self.cache / "d/tool").stat().st_mode & 0o7000, 0)

    def test_refuses_a_directory_over_the_entry_limit(self):
        data = tar_bytes([entry("d", tarfile.DIRTYPE)] + [entry(f"d/{i}", data=b"") for i in range(3)])
        with mock.patch.object(program, "MAX_FILES", 3):
            self.refused("more than 3 entries", self.receive, self.cache, data, kind="dir", name="d")
        self.assertEqual(list(self.cache.iterdir()), [])


class Send(Transfer):
    def send(self, source):
        out, reports = io.BytesIO(), []
        program.send(str(source), out, reports.append)
        return out.getvalue(), reports

    def test_sends_a_file_with_its_report(self):
        path = self.work / "out.json"
        path.write_bytes(b"{}")
        path.chmod(0o640)
        data, reports = self.send(path)
        self.assertEqual(data, b"{}")
        self.assertEqual(reports, [{"kind": "file", "name": "out.json", "files": 1, "mode": 0o640}])

    def test_sends_a_directory_that_receive_can_unpack(self):
        top = self.work / "results"
        (top / "sub").mkdir(parents=True)
        (top / "sub/a.txt").write_bytes(b"a")
        (top / "link").symlink_to("sub/a.txt")
        data, reports = self.send(top)
        self.assertEqual(reports, [{"kind": "dir", "name": "results", "files": 4, "mode": top.stat().st_mode & 0o777}])
        with tarfile.open(fileobj=io.BytesIO(data)) as archive:
            self.assertTrue(all(m.uid == 0 and m.uname == "" for m in archive.getmembers()))
        self.receive(self.cache, data, kind="dir", name="results")
        self.assertEqual((self.cache / "results/sub/a.txt").read_bytes(), b"a")

    def test_refuses_missing_outside_and_special_sources(self):
        self.refused("does not exist", self.send, self.work / "missing")
        (self.outside / "secret").write_bytes(b"s")
        self.refused("outside the workbench folder", self.send, self.outside / "secret")
        (self.work / "alias").symlink_to(self.outside / "secret")
        self.refused("outside the workbench folder", self.send, self.work / "alias")
        top = self.work / "pipes"
        top.mkdir()
        os.mkfifo(top / "fifo")
        self.refused("is not a file, a folder or a link", self.send, top)

    def test_stops_a_file_that_grows_past_the_limit_while_it_is_read(self):
        path = self.work / "growing.log"
        path.write_bytes(b"x" * 100)
        # The size check passes; the stream limit, smaller here, stops the read.
        with mock.patch.object(program, "STREAM_LIMIT", 50):
            self.refused("at most", self.send, path)

    def test_refuses_a_directory_over_the_limits(self):
        top = self.work / "many"
        top.mkdir()
        for i in range(3):
            (top / str(i)).write_bytes(b"12345")
        with mock.patch.object(program, "MAX_FILES", 2):
            self.refused("more than 2 entries", self.send, top)
        with mock.patch.object(program, "MAX_BYTES", 10):
            self.refused("at most", self.send, top)


class CommandLine(Transfer):
    def run_main(self, args, stdin=b""):
        """Run main() as the command line does; return (status, stdout bytes, stderr text)."""
        out, err = io.BytesIO(), io.StringIO()
        streams = mock.patch.multiple(sys, stdin=io.TextIOWrapper(io.BytesIO(stdin)),
                                      stdout=io.TextIOWrapper(out, write_through=True), stderr=err)
        with streams:
            status = program.main(args)
            sys.stdout.flush()
        return status, out.getvalue(), err.getvalue()

    def test_receive_prints_json_and_send_reports_on_stderr(self):
        data = b"hello"
        status, out, err = self.run_main(["receive", str(self.work / "a.txt"), "file", "a.txt",
                                          hashlib.sha256(data).hexdigest(), "5", "644", "0"], data)
        self.assertEqual(status, 0, err)
        self.assertEqual(json.loads(out)["path"], str(self.work / "a.txt"))
        status, out, err = self.run_main(["send", str(self.work / "a.txt")])
        self.assertEqual((status, out), (0, data))
        last = err.strip().splitlines()[-1]
        self.assertTrue(last.startswith(program.REPORT_PREFIX))
        self.assertEqual(json.loads(last[len(program.REPORT_PREFIX):])["kind"], "file")

    def test_a_refusal_is_one_sentence_and_status_1(self):
        status, out, err = self.run_main(["receive", str(self.outside / "a"), "file", "a", "0" * 64, "1", "644", "0"], b"x")
        self.assertEqual((status, out), (1, b""))
        self.assertIn("outside the workbench folder", err)
        for args in (["receive", "x"], ["send"], ["receive", "/a", "file", "a", "0" * 64, "1", "999", "0"]):
            self.assertEqual(self.run_main(args)[0], 1)

    def test_the_program_runs_as_a_script(self):
        result = subprocess.run(["python3", "-I", str(PROGRAM), "send"], capture_output=True, text=True, timeout=30)
        self.assertEqual(result.returncode, 1)
        self.assertIn("Use receive DEST", result.stderr)


class SessionPath(Transfer):
    """`SESSION:PATH` is relative to the folder of the session's active pane."""

    def setUp(self):
        super().setUp()
        self.tmux = shutil.which("tmux")
        if not self.tmux:
            self.skipTest("tmux is not installed")
        self.socket = str(Path(self.temp.name) / "tmux.sock")
        project = self.work / "proj"
        project.mkdir()
        subprocess.run([self.tmux, "-S", self.socket, "-f", "/dev/null", "new-session", "-d", "-s", "lead",
                        "-c", str(project)], check=True)
        self.addCleanup(subprocess.run, [self.tmux, "-N", "-S", self.socket, "kill-server"], capture_output=True)
        patch = mock.patch.object(program, "SOCKET", self.socket)
        patch.start()
        self.addCleanup(patch.stop)
        for _ in range(100):
            if program.session_folder("lead").name == "proj":
                break
            time.sleep(.02)

    def test_resolves_a_relative_path_in_the_session_folder(self):
        result = self.receive("lead:a.txt", b"x")
        self.assertEqual(Path(result["path"]).resolve(), (self.work / "proj/a.txt").resolve())
        self.assertEqual(self.receive("lead:", b"y", name="b.txt")["path"],
                         str(Path(os.path.realpath(self.work / "proj")) / "b.txt"))

    def test_refuses_an_unknown_session_and_a_bad_spec(self):
        self.refused("No session named ghost.", self.receive, "ghost:a.txt", b"x")
        self.refused("Use an absolute path or SESSION:PATH.", self.receive, "relative/a.txt", b"x")
        self.refused("Use an absolute path or SESSION:PATH.", self.receive, "bad name:a", b"x")


if __name__ == "__main__":
    unittest.main()
