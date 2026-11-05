"""Exercise workspace preview boundaries with disposable files."""

import importlib.util
import os
import tempfile
import unittest
from pathlib import Path

spec = importlib.util.spec_from_file_location(
    "files", Path(__file__).resolve().parents[1] / "workbench-files.py"
)
files = importlib.util.module_from_spec(spec)
spec.loader.exec_module(files)


class FilesTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)

    def tearDown(self):
        self.temp.cleanup()

    def test_listing_and_bounded_preview(self):
        (self.root / "hello.txt").write_text("hello" * 1000)
        self.assertEqual(
            files.inspect_path(self.root)["entries"][0]["name"], "hello.txt"
        )
        result = files.inspect_path(self.root, "hello.txt")
        self.assertEqual(len(result["text"]), 3000)
        self.assertTrue(result["truncated"])

    def test_path_escape_and_symlinks_fail(self):
        (self.root / "link").symlink_to("/etc/passwd")
        for name in ["../secret", "/etc/passwd", "link"]:
            with self.assertRaises((OSError, ValueError)):
                files.inspect_path(self.root, name)

    def test_secret_names_fail(self):
        for name in [
            ".env",
            ".env.local",
            ".npmrc",
            ".netrc",
            ".git-credentials",
            "id_rsa",
            "auth.json",
            "example.pem",
        ]:
            (self.root / name).write_text("synthetic-secret")
            with self.assertRaises(ValueError):
                files.inspect_path(self.root, name)

    def test_special_and_binary_files_fail_without_blocking(self):
        os.mkfifo(self.root / "pipe")
        (self.root / "binary").write_bytes(b"a\x00b")
        for name in ["pipe", "binary"]:
            with self.assertRaises(ValueError):
                files.inspect_path(self.root, name)

    def test_paging_has_no_duplicates(self):
        for i in range(45):
            (self.root / f"file-{i}").touch()
        first = files.inspect_path(self.root)
        second = files.inspect_path(self.root, offset=40)
        self.assertTrue(first["more"])
        self.assertFalse(second["more"])
        self.assertEqual(
            len({r["name"] for r in first["entries"] + second["entries"]}), 45
        )

    def test_invalid_offset_fails(self):
        for value in [-1, True, 100001, "0"]:
            with self.assertRaises(ValueError):
                files.inspect_path(self.root, offset=value)


if __name__ == "__main__":
    unittest.main()
