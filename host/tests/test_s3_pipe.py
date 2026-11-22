"""Test the root step of `tokiwa cp` with a stand-in S3 client and stand-in helpers."""

import hashlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

PROGRAM = Path(__file__).resolve().parents[1] / "tokiwa-s3-pipe.py"
spec = importlib.util.spec_from_file_location("tokiwa_s3_pipe", PROGRAM)
program = importlib.util.module_from_spec(spec)
spec.loader.exec_module(program)

GET_KEY = "inputs/transfers/" + "a" * 32
PUT_KEY = "results/transfers/" + "b" * 32
PYTHON = sys.executable


class FakeS3:
    def __init__(self, objects=None, fail_upload=False):
        self.objects = dict(objects or {})
        self.fail_upload = fail_upload
        self.calls = []

    def get_object(self, Bucket, Key):
        self.calls.append(("get", Bucket, Key))
        return {"Body": io.BytesIO(self.objects[Key])}

    def upload_fileobj(self, stream, bucket, key):
        self.calls.append(("put", bucket, key))
        data = b""
        while chunk := stream.read(7):
            data += chunk
        if self.fail_upload:
            raise RuntimeError("network")
        self.objects[key] = data


class S3Pipe(unittest.TestCase):
    def run_main(self, argv, client):
        out, err = io.StringIO(), io.StringIO()
        with mock.patch.multiple(sys, stdout=out, stderr=err):
            status = program.main(argv, client_factory=lambda region: client)
        return status, out.getvalue(), err.getvalue()

    def test_get_streams_the_object_into_the_helper(self):
        client = FakeS3({GET_KEY: b"payload bytes"})
        folder = tempfile.TemporaryDirectory()
        self.addCleanup(folder.cleanup)
        sink = Path(folder.name) / "received"
        helper = [PYTHON, "-c", f"import sys; open({str(sink)!r}, 'wb').write(sys.stdin.buffer.read())"]
        status, _, _ = self.run_main(["get", "us-east-1", "bucket-a", GET_KEY, "--", *helper], client)
        self.assertEqual(status, 0)
        self.assertEqual(sink.read_bytes(), b"payload bytes")
        self.assertEqual(client.calls, [("get", "bucket-a", GET_KEY)])

    def test_get_passes_on_a_refusal_of_the_helper(self):
        client = FakeS3({GET_KEY: b"x" * (4 * 1024 * 1024)})
        helper = [PYTHON, "-c", "import sys; print('refused', file=sys.stderr); sys.exit(1)"]
        status, _, _ = self.run_main(["get", "us-east-1", "bucket-a", GET_KEY, "--", *helper], client)
        self.assertEqual(status, 1)

    def test_put_uploads_the_stream_and_adds_bytes_and_sha256_to_the_report(self):
        client = FakeS3()
        helper = [PYTHON, "-c", "import sys; print('tokiwa-transfer {\"kind\": \"file\", \"name\": \"a\", "
                  "\"files\": 1, \"mode\": 420}', file=sys.stderr, flush=True); sys.stdout.write('stream data')"]
        status, out, _ = self.run_main(["put", "us-east-1", "bucket-a", PUT_KEY, "--", *helper], client)
        self.assertEqual(status, 0)
        self.assertEqual(client.objects[PUT_KEY], b"stream data")
        self.assertEqual(json.loads(out), {"kind": "file", "name": "a", "files": 1, "mode": 420, "bytes": 11,
                                           "sha256": hashlib.sha256(b"stream data").hexdigest()})

    def test_put_passes_on_a_refusal_and_prints_no_report(self):
        helper = [PYTHON, "-c", "import sys; print('The path is outside.', file=sys.stderr); sys.exit(1)"]
        status, out, err = self.run_main(["put", "us-east-1", "bucket-a", PUT_KEY, "--", *helper], FakeS3())
        self.assertEqual((status, out), (1, ""))
        self.assertIn("The path is outside.", err)

    def test_put_reports_a_failed_upload(self):
        helper = [PYTHON, "-c", "import sys; sys.stdout.write('x' * 100)"]
        status, out, err = self.run_main(["put", "us-east-1", "bucket-a", PUT_KEY, "--", *helper],
                                         FakeS3(fail_upload=True))
        self.assertEqual((status, out), (1, ""))
        self.assertIn("The copy to S3 failed.", err)

    def test_refuses_keys_outside_the_transfer_prefixes_and_bad_names(self):
        client = FakeS3()
        cases = [
            ["get", "us-east-1", "bucket-a", PUT_KEY, "--", "true"],
            ["put", "us-east-1", "bucket-a", GET_KEY, "--", "true"],
            ["get", "us-east-1", "bucket-a", "inputs/clipboard/" + "a" * 32, "--", "true"],
            ["get", "us-east-1", "bucket-a", GET_KEY + "/../x", "--", "true"],
            ["get", "us-east-1", "bucket-a", GET_KEY + "\n", "--", "true"],
            ["get", "us-east-1\n", "bucket-a", GET_KEY, "--", "true"],
            ["get", "us-east-1", "Bucket_A", GET_KEY, "--", "true"],
            ["get", "nowhere", "bucket-a", GET_KEY, "--", "true"],
            ["get", "us-east-1", "bucket-a", GET_KEY, "true"],
            ["copy", "us-east-1", "bucket-a", GET_KEY, "--", "true"],
            ["get", "us-east-1", "bucket-a", GET_KEY, "--"],
        ]
        for argv in cases:
            with self.subTest(argv=argv):
                self.assertEqual(self.run_main(argv, client)[0], 2)
        self.assertEqual(client.calls, [])


if __name__ == "__main__":
    unittest.main()
