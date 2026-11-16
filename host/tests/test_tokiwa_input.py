"""Test the root decryption of message text."""

import base64
import os
import subprocess
import tempfile
import unittest
from pathlib import Path

PROGRAM = Path(__file__).resolve().parents[1] / "tokiwa-input.py"
REFUSAL = "The message could not be decrypted with the host input key. Nothing was sent."


def make_pair(folder, name):
    """Make a key and a certificate, as the installer does, and return both paths."""
    key, cert = Path(folder) / f"{name}-key.pem", Path(folder) / f"{name}-cert.pem"
    subprocess.run(
        ["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-keyout", key, "-out", cert,
         "-subj", "/CN=tokiwa-input", "-days", "1"],
        check=True, capture_output=True,
    )
    return key, cert


def seal(cert, text):
    sealed = subprocess.run(
        ["openssl", "smime", "-encrypt", "-aes256", "-binary", "-outform", "DER", cert],
        input=text, check=True, capture_output=True,
    )
    return base64.b64encode(sealed.stdout).decode()


class DecryptInput(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.key, self.cert = make_pair(self.temp.name, "host")

    def tearDown(self):
        self.temp.cleanup()

    def run_program(self, sealed, key=None):
        env = dict(os.environ, TOKIWA_INPUT_KEY=str(key or self.key))
        return subprocess.run(["python3", "-I", str(PROGRAM), sealed], env=env, capture_output=True)

    def test_round_trip(self):
        text = "Run the tests.\nThen stop — é\t".encode()
        result = self.run_program(seal(self.cert, text))
        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertEqual(result.stdout, text)
        self.assertEqual(result.stderr, b"")

    def test_wrong_key_is_refused_with_the_sentence(self):
        other_key, _ = make_pair(self.temp.name, "other")
        result = self.run_program(seal(self.cert, b"hello"), key=other_key)
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stderr.decode().strip(), REFUSAL)
        self.assertEqual(result.stdout, b"")

    def test_missing_key_is_refused_with_the_sentence(self):
        result = self.run_program(seal(self.cert, b"hello"), key=Path(self.temp.name) / "none.pem")
        self.assertEqual((result.returncode, result.stderr.decode().strip()), (1, REFUSAL))

    def test_bad_base64_is_refused(self):
        for bad in ["not base64!", "", "bm90IGNpcGhlcg=="]:
            result = self.run_program(bad)
            self.assertEqual((result.returncode, result.stderr.decode().strip(), result.stdout), (1, REFUSAL, b""), bad)

    def test_text_over_the_limit_is_refused(self):
        limit = 16384
        self.assertEqual(self.run_program(seal(self.cert, b"x" * limit)).stdout, b"x" * limit)
        result = self.run_program(seal(self.cert, b"x" * (limit + 1)))
        self.assertEqual(result.returncode, 1)
        self.assertEqual(result.stdout, b"")
        self.assertIn(f"longer than {limit} bytes. Nothing was sent.", result.stderr.decode())

    def test_plain_text_never_in_stderr(self):
        secret = b"private-words-123"
        other_key, _ = make_pair(self.temp.name, "other")
        for sealed, key in [(seal(self.cert, secret), other_key), (seal(self.cert, secret + b"x" * 16400), self.key),
                            (seal(self.cert, secret)[:-8], self.key)]:
            result = self.run_program(sealed, key=key)
            self.assertNotIn(secret, result.stderr)
            self.assertNotIn(secret, result.stdout if result.returncode else b"")


if __name__ == "__main__":
    unittest.main()
