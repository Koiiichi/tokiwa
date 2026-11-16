"""Decrypt message text that the launcher encrypted to the host input key.

Run as root, never as the session user. The launcher encrypts the text to the certificate of
/etc/tokiwa/input-key.pem. This program prints the plain text on stdout and nothing else, so that
the caller can pipe it to a helper that reads it from stdin. The text never reaches an argument, a
file, a log line or the output that Run Command keeps in the account.

    python3 -I tokiwa-input.py SEALED_B64

SEALED_B64 is the base64 of the DER message that `openssl smime -encrypt` made.
"""

import base64
import os
import subprocess
import sys

KEY = os.environ.get("TOKIWA_INPUT_KEY", "/etc/tokiwa/input-key.pem")
# The longest message text in bytes. A sealed message of this size is about 24 KB in base64,
# inside the 64 KB that Run Command allows for a command (docs/host.md, "Encrypted input").
MAX_MESSAGE_BYTES = 16384
# The envelope adds a certificate-sized header and the base64 text adds a third.
MAX_SEALED_BYTES = MAX_MESSAGE_BYTES + 4096
REFUSAL = "The message could not be decrypted with the host input key. Nothing was sent."
TOO_LONG = f"The message is longer than {MAX_MESSAGE_BYTES} bytes. Nothing was sent."


def decrypt(sealed_b64):
    """Return the plain text bytes, or raise ValueError with a sentence for the caller."""
    try:
        sealed = base64.b64decode(sealed_b64, validate=True)
    except ValueError:
        raise ValueError(REFUSAL)
    if not sealed or len(sealed) > MAX_SEALED_BYTES:
        raise ValueError(REFUSAL)
    try:
        # Both streams are captured, so that no text reaches this program's own stderr.
        opened = subprocess.run(
            ["openssl", "smime", "-decrypt", "-binary", "-inform", "DER", "-inkey", KEY],
            input=sealed,
            capture_output=True,
            timeout=10,
        )
    except (OSError, subprocess.TimeoutExpired):
        raise ValueError(REFUSAL)
    if opened.returncode:
        raise ValueError(REFUSAL)
    if len(opened.stdout) > MAX_MESSAGE_BYTES:
        raise ValueError(TOO_LONG)
    return opened.stdout


def main(argv):
    if len(argv) != 2:
        print(REFUSAL, file=sys.stderr)
        return 1
    try:
        text = decrypt(argv[1])
    except ValueError as refusal:
        print(refusal, file=sys.stderr)
        return 1
    sys.stdout.buffer.write(text)
    sys.stdout.buffer.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
