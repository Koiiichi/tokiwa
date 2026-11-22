"""Move the bytes of one `tokiwa cp` transfer between S3 and the session user's helper.

Run as root by Run Command, never as the session user. Root holds the host role, which reads
`inputs/*` and writes `results/*` of the artifacts bucket; the helper runs as the session user and
does every path check and every file read and write. Root opens no path that the caller chose.

    python3 -I tokiwa-s3-pipe.py get REGION BUCKET KEY -- HELPER...
    python3 -I tokiwa-s3-pipe.py put REGION BUCKET KEY -- HELPER...

`get` streams the object `inputs/transfers/<32 hex>` into the stdin of HELPER and passes on its
output and its exit status. `put` streams the stdout of HELPER into the object
`results/transfers/<32 hex>`, and prints the helper's report with the bytes and the SHA-256 of
the stream added. The launcher deletes the object after the transfer in both directions: the host
role cannot delete.
"""

import hashlib
import json
import re
import subprocess
import sys
import threading

REGION = re.compile(r"[a-z]{2}(-[a-z]+)+-[0-9]")
BUCKET = re.compile(r"[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]")
KEYS = {"get": re.compile(r"inputs/transfers/[0-9a-f]{32}"), "put": re.compile(r"results/transfers/[0-9a-f]{32}")}
REPORT_PREFIX = "tokiwa-transfer "
CHUNK = 1024 * 1024
USAGE = "Use get|put REGION BUCKET KEY -- HELPER..."


def s3_client(region):
    import boto3

    return boto3.client("s3", region_name=region)


class CountingReader:
    """A file-like reader that counts and hashes what passes through it."""

    def __init__(self, stream):
        self.stream = stream
        self.size = 0
        self.digest = hashlib.sha256()

    def read(self, size=-1):
        chunk = self.stream.read(size)
        self.size += len(chunk)
        self.digest.update(chunk)
        return chunk


def get(client, bucket, key, helper):
    body = client.get_object(Bucket=bucket, Key=key)["Body"]
    process = subprocess.Popen(helper, stdin=subprocess.PIPE)
    try:
        while chunk := body.read(CHUNK):
            process.stdin.write(chunk)
        process.stdin.close()
    except BrokenPipeError:
        # The helper refused and stopped reading; its own sentence explains why.
        pass
    return process.wait()


def put(client, bucket, key, helper):
    process = subprocess.Popen(helper, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
    errors = []
    # stderr is read while stdout streams, so that a full stderr pipe cannot stop the helper.
    reader = threading.Thread(target=lambda: errors.append(process.stderr.read().decode(errors="replace")))
    reader.start()
    counted = CountingReader(process.stdout)
    try:
        client.upload_fileobj(counted, bucket, key)
    except Exception:
        process.kill()
        process.wait()
        reader.join()
        print("The copy to S3 failed. Nothing was copied.", file=sys.stderr)
        return 1
    status = process.wait()
    reader.join()
    lines = errors[0].splitlines() if errors else []
    reports = [line for line in lines if line.startswith(REPORT_PREFIX)]
    other = [line for line in lines if not line.startswith(REPORT_PREFIX)]
    if status or not reports:
        print("\n".join(other) or "The helper stopped without a report. Nothing was copied.", file=sys.stderr)
        return status or 1
    report = json.loads(reports[-1][len(REPORT_PREFIX):])
    report.update(bytes=counted.size, sha256=counted.digest.hexdigest())
    print(json.dumps(report))
    return 0


def main(argv, client_factory=s3_client):
    if len(argv) < 6 or argv[4] != "--" or argv[0] not in KEYS:
        print(USAGE, file=sys.stderr)
        return 2
    mode, region, bucket, key, helper = argv[0], argv[1], argv[2], argv[3], argv[5:]
    if not REGION.fullmatch(region) or not BUCKET.fullmatch(bucket):
        print("The region or the bucket name is not valid. Nothing was copied.", file=sys.stderr)
        return 2
    if not KEYS[mode].fullmatch(key):
        print("The key is not a transfer key. Nothing was copied.", file=sys.stderr)
        return 2
    client = client_factory(region)
    return (get if mode == "get" else put)(client, bucket, key, helper)


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
