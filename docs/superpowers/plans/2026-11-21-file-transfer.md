# File transfer: implementation plan

Spec: [2026-11-20-file-transfer-design.md](../specs/2026-11-20-file-transfer-design.md). Owner choices: `SESSION:PATH` and `host:/PATH`; 10 GB and 10,000 files per transfer; no encryption on the Mac.

## Parts

1. `host/tokiwa-transfer.py`, run as the session user. Two subcommands:
   - `receive DEST KIND NAME SHA256 SIZE MODE FORCE`: reads the stream on stdin, resolves DEST, checks the allowed folders, the overwrite rule and the free space, writes a temporary name on the target disk, checks the size and the SHA-256, extracts a directory with the `tarfile` `data` filter, and puts the result in place. Prints one JSON object.
   - `send SOURCE`: resolves SOURCE, checks the allowed folders and the limits, and writes the file or a tar stream to stdout. Its last stderr line is a JSON report: kind, name, files, mode.
   - Allowed folders: the workbench folder (`TOKIWA_WORKDIR`) and the session cache root (`TOKIWA_CACHE_ROOT` or `/etc/tokiwa/cache-root`). `SESSION:PATH` is relative to `#{pane_current_path}` of the session.
2. `host/tokiwa-s3-pipe.py`, run as root by Run Command. Two subcommands:
   - `get BUCKET KEY -- HELPER...`: streams the object with `boto3` into the stdin of the helper; prints the helper's output.
   - `put BUCKET KEY -- HELPER...`: streams the helper's stdout to the object, counts the bytes and the SHA-256, and prints the report with them.
   - It refuses a key outside `inputs/transfers/<32 hex>` (get) and `results/transfers/<32 hex>` (put), and a bucket name that is not valid.
3. `host/terminal-session.sh`: modes `transfer-in` and `transfer-out` that run `tokiwa-transfer.py` and write the audit line after a success.
4. `host/install.sh`: place both scripts in `/opt/agent-platform/rootless/`.
5. `bin/tokiwa`: mode `cp`, with `--force` and `--json`. Upload: pack, upload with `aws s3 cp` to `inputs/transfers/<id>`, one Run Command call with a timeout from the size, delete the object version on exit. Download: one Run Command call, check the Mac's free space, download, check, put in place, delete the object version on exit. `executionTimeout` and the wait become parameters of `submit`.
6. Docs: `docs/agents.md` (command reference and limits), `docs/configuration.md` (`paste_bucket` serves image paste and file transfer), `docs/host.md` (installed files), README (the command), launcher help.
7. Setup repository: the two lifecycle rules in `render.py` and their test. Deploying the stack is a separate step for the owner.

## Tests

- `host/tests/test_transfer.py`: receive and send of a file and a directory; refusals (existing target, directory with `--force`, outside the allowed folders, a link that leaves them, tar members with `..`, an absolute name, a device, a link outside, over the limits, low free space, wrong SHA-256 or size); no file left after a failure; `SESSION:PATH` against a test tmux server.
- `host/tests/test_s3_pipe.py`: get and put with a stand-in S3 client; key and bucket refusals; a failing helper.
- `host/tests/test_terminal_cli.py`: `tokiwa cp` upload and download with the stand-in AWS CLI: the S3 calls, the Run Command line, the result, the delete on success and on failure, usage errors, the local overwrite rule.

## Order

Host user side, root pipe, host modes and install, launcher, docs, setup repository. Full suites after each part: `python3 -m unittest discover -s host/tests`, `cd app && bun test`.

## Not in this plan

Deploying the host, applying the bucket rules, merging. Each needs the owner's word.
