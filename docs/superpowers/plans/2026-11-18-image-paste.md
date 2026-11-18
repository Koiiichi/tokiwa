# Image Paste Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Cmd+V with an image on the Mac clipboard, in a remote session view of the Tokiwa app, attaches the image in the remote Claude Code.

**Architecture:** The app reads the clipboard image to a PNG file and calls an internal launcher command. The launcher uploads the file to S3, seals a 5-minute presigned GET URL to the host input key, and runs a new helper mode that downloads, checks and places the file in the session's `tmp/`. The launcher always deletes the S3 object. The app pastes the printed path as one bracketed paste only after success.

**Tech Stack:** Bash (launcher `bin/tokiwa`, helper `host/terminal-session.sh`), Python `unittest` tests in `host/tests/`, Bun + OpenTUI (app, `bun test`), AWS CLI (S3, SSM).

**Spec:** `docs/superpowers/specs/2026-11-18-image-paste-design.md`

## Global Constraints

- The repository is public: no bucket name, account id, internal project name or internal path in code, tests, docs or commit messages. Tests use neutral names, for example `worker-a` and `example-bucket`.
- Image size limit: 10 MB = 10485760 bytes, checked in the app, the launcher and the helper.
- S3 key: `inputs/clipboard/<32 lowercase hex>.png`. Presigned URL lifetime: 300 seconds.
- Host file: `<cache root>/<session name>/tmp/paste-<UTC yyyymmddThhmmssZ>-<8 lowercase hex>.png`, mode 0600, owner the session user. The cache root comes from `TOKIWA_CACHE_ROOT`, else `/etc/tokiwa/cache-root`, as `start_shell` reads it.
- Error text is ASD-STE100: one sentence each, active voice. Exact sentences are given in the tasks.
- No public command: `paste-image` is not in `usage`, not in `app/capabilities.json`, and has no MCP tool.
- Text paste is not touched by any code change.
- No `Co-Authored-By` trailer in commits.

## Review Focus

1. A second Cmd+V while a paste is in flight: the app runs one paste at a time and says `An image paste is already in progress.` (Task 3 test).
2. The view closes, or the person focuses another view, before the launcher replies: the app writes only to the view where Cmd+V was pressed, and only while that view exists (Task 3 test).
3. The session ends or its identity changes between Cmd+V and the download: the helper refuses and leaves no file (Task 1 test).
4. The AWS sign-in expires during the paste: the launcher still tries `s3 rm`, prints the failure, and the app pastes nothing (Task 2 test).
5. The clipboard holds an image that is not PNG (TIFF from some apps): the app converts it with `sips`, or says `The clipboard image could not be read.` (Task 3 test).

---

### Task 1: Helper mode `paste-image`

**Files:**
- Modify: `host/terminal-session.sh` (new mode in the main `case`, next to `agent-relaunch`)
- Test: `host/tests/test_terminal_sessions.py` (new class `PasteImage`)
- Modify: `docs/host.md` (one entry for the mode)

**Interfaces:**
- Produces: `terminal-session.sh paste-image NAME IDENTITY SHA256 SIZE`, URL on stdin (one line). Success: exit 0, stdout one line `{"path": "<absolute path>"}`. Failure: exit 1, one sentence on stderr, no file left.

- [ ] **Step 1: Write the failing tests** in class `PasteImage` (use the existing tmux test server helpers; put a stand-in `curl` first on PATH that copies `$FAKE_IMAGE` to the `-o` path and exits with `${FAKE_CURL_EXIT:-0}`):
  - `test_places_a_checked_image_in_the_session_tmp_folder`: path matches `^<root>/lead/tmp/paste-\d{8}T\d{6}Z-[0-9a-f]{8}\.png$`; file bytes equal the fixture; mode `0o600`.
  - `test_makes_the_tmp_folder_of_a_session_that_has_none`: no `<root>/lead` before; after, `<root>/lead/tmp` exists, mode `0o700`.
  - `test_refuses_a_wrong_sha256_and_leaves_no_file`: stderr has `The image on the host does not match the image on the Mac. Nothing was pasted.`; `tmp/` has no `paste-*`.
  - `test_refuses_a_wrong_size_and_leaves_no_file`: same sentence; no file.
  - `test_refuses_a_failed_download_and_leaves_no_file` (`FAKE_CURL_EXIT=22`): stderr has `The image could not be downloaded to the host. Nothing was pasted.`
  - `test_refuses_another_identity`: `Session identity changed. Nothing was pasted.`; curl not called.
  - `test_refuses_a_size_over_the_limit` (SIZE `10485761`) and a malformed SHA256: `Use paste-image NAME IDENTITY SHA256 SIZE.`; curl not called.
  - `test_refuses_a_url_that_is_not_https`: stdin `http://example.com/a.png` → `The image URL is not valid. Nothing was pasted.`
  - `test_refuses_a_tmp_folder_that_is_a_link`: `<root>/lead/tmp` a symlink → `The session cache folder is not usable. Nothing was pasted.`

- [ ] **Step 2: Run them to verify they fail**
  Run: `TMPDIR=$(mktemp -d /tmp/pi.XXXX) python3 -m unittest host.tests.test_terminal_sessions.PasteImage`
  Expected: FAIL (unknown mode).

- [ ] **Step 3: Implement the mode.** Check arguments (`SHA256` `^[0-9a-f]{64}$`, `SIZE` integer 1..10485760); read one stdin line and require `^https://[^[:space:]]+$`; check the session identity as `interrupt` does; resolve the cache root; `umask 077; mkdir -p "$root/$name/tmp"`, refuse when `$root/$name` or `tmp` is a link or not writable; download with `curl --fail --silent --proto =https --max-time 20 --max-filesize SIZE -o <part file>` to `.paste-<random>.part` in `tmp/`; check the byte count and `sha256sum`; `chmod 600`; rename to the final name; print the JSON. A `trap` removes the part file on every exit path.

- [ ] **Step 4: Run the tests to verify they pass** (same command). Expected: PASS. Then the full host suite: `TMPDIR=$(mktemp -d /tmp/pi.XXXX) python3 -m unittest discover -s host/tests`. Expected: OK.

- [ ] **Step 5: Add the `docs/host.md` entry** (the mode, its arguments, stdin, output, the folder and the refusals), then commit:
```bash
git add host/terminal-session.sh host/tests/test_terminal_sessions.py docs/host.md
git commit -m "host: paste-image mode: download a checked image into the session's tmp folder"
```

### Task 2: Launcher command `paste-image`

**Files:**
- Modify: `bin/tokiwa` (host settings parser: key `paste_bucket`; argument parsing; the remote line through `seal_input` and `tokiwa-input.py`, as `agent-send` does)
- Test: `host/tests/test_terminal_cli.py` (extend the `aws` stub for `s3 cp`, `s3 presign`, `s3 rm`; new tests)
- Modify: `docs/configuration.md` (the `paste_bucket=` key in [Host settings])

**Interfaces:**
- Consumes: Task 1's helper mode and output.
- Produces: `tokiwa paste-image NAME IDENTITY FILE`. Success: exit 0, stdout exactly the helper's JSON line. Failure: exit 1, one `Tokiwa: ...` sentence on stderr.

- [ ] **Step 1: Write the failing tests:**
  - `test_paste_image_uploads_seals_and_deletes`: calls contain `s3api put-object --bucket example-bucket --key inputs/clipboard/<32 hex>.png --body FILE`, `s3 presign ... --expires-in 300`, a `send-command` whose commands hold `tokiwa-input.py` and `terminal-session.sh paste-image lead '1:$2:3' <sha256> <size>` and no `https://`, then `s3api delete-object` of the same key and the version id; stdout is the stub's `{"path": ...}`.
  - `test_paste_image_deletes_the_object_when_the_host_fails` (stub: invocation `Failed`): `s3 rm` is called; exit 1.
  - `test_paste_image_deletes_the_object_when_the_sign_in_expires` (stub: `send-command` exits 255): `s3 rm` is attempted; exit 1.
  - `test_paste_image_without_a_bucket`: no `paste_bucket=` → `Image paste is not set up. Set paste_bucket= in ~/.config/tokiwa/host.env.`; no `s3` call.
  - `test_paste_image_refuses_a_file_that_is_not_png` and `..._over_the_limit` (10485761 bytes): `The file is not a PNG image of at most 10 MB.`; no `s3` call.
  - `test_paste_image_is_not_in_the_help`: `tokiwa --help` output has no `paste-image`.
  - `test_host_settings_accept_paste_bucket`: a valid bucket name (`^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$`) is accepted; an invalid one fails with `<config>: paste_bucket= must be an S3 bucket name.`

- [ ] **Step 2: Run them to verify they fail:** `python3 -m unittest host.tests.test_terminal_cli`. Expected: FAIL.

- [ ] **Step 3: Implement.** Accept `paste_bucket` in the settings loop; parse `paste-image` with the same NAME and IDENTITY checks as `agent-relaunch`; check the file (regular, ≤ 10485760 bytes, first 8 bytes `89 50 4E 47 0D 0A 1A 0A`); compute size and sha256; `trap` an `aws_call s3 rm` of the key on exit once the upload started; upload with `aws_call s3 cp`; `aws_call s3 presign --expires-in 300`; write the URL to a private input file and use `seal_input`; build the remote line as the `agent-send` branch does; `submit`; on `Success` print the invocation's stdout, else print the helper's stderr and fail with `The image was not pasted.`

- [ ] **Step 4: Run the tests to verify they pass** (same command, then the full host suite). Expected: OK.

- [ ] **Step 5: Document `paste_bucket=` in `docs/configuration.md`, then commit:**
```bash
git add bin/tokiwa host/tests/test_terminal_cli.py docs/configuration.md
git commit -m "launcher: internal paste-image command: upload, sealed presigned URL, host check, delete"
```

### Task 3: App: Cmd+V with an image

**Files:**
- Create: `app/clipboard-image.ts`
- Test: `app/clipboard-image.test.ts`, `app/image-paste.test.ts`
- Modify: `app/backend.ts` (method), `app/app.ts` (key handler next to the Cmd+C branch)
- Modify: `docs/interface.md` (Cmd+V row in the keys table; the Ghostty line beside `performable:super+c=copy_to_clipboard`)

**Interfaces:**
- Consumes: Task 2's `tokiwa paste-image NAME IDENTITY FILE` and its JSON line.
- Produces:
  - `readClipboardImage(dir: string, run?: (cmd: string[]) => Promise<{ code: number; stdout: string }>): Promise<string | undefined>` — writes `dir/clipboard-<random>.png`, returns its path, or `undefined` when the clipboard has no image; throws `Error("The clipboard image could not be read.")` on a failed conversion.
  - `BackendClient.pasteImage(ref: SessionRef, file: string): Promise<string>` — returns the host path.
  - `App.pasteImage(): Promise<void>` — the Cmd+V action.

- [ ] **Step 1: Write the failing tests.**
  `clipboard-image.test.ts` (fake `run`):
  - PNG on the clipboard (`osascript` writes `«class PNGf»` data) → returns a path ending `.png`.
  - Only TIFF → runs `sips -s format png` → returns a `.png` path.
  - No image (`osascript` exit 1 for both classes) → `undefined`.
  - `sips` fails → throws `The clipboard image could not be read.`
  `image-paste.test.ts` (test renderer, fake backend runner, fake reader passed as the new `App` option `readImage?: typeof readClipboardImage`):
  - In a focused remote view, Cmd+V → launcher args `["paste-image", name, identity, file]`; the view's adapter receives exactly `"\x1b[200~/host/path.png\x1b[201~"`; the temporary file no longer exists.
  - Launcher failure → the adapter receives nothing; the footer shows `Image paste failed: <first line>. Nothing was pasted.`; the temporary file no longer exists.
  - A local view focused → no launcher call, nothing written.
  - No image on the clipboard → no launcher call, nothing written, no notice.
  - Image over 10485760 bytes → no launcher call; footer `The image is larger than 10 MB. Nothing was pasted.`
  - Second Cmd+V before the first reply → one launcher call; footer `An image paste is already in progress.`
  - The view closes before the reply → nothing written, no error thrown.
  - A footer notice `Pasting image…` shows while the call runs.

- [ ] **Step 2: Run them to verify they fail:** `cd app && ./node_modules/bun/bin/bun.exe test clipboard-image.test.ts image-paste.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `readClipboardImage` uses `osascript -e 'set f to open for access POSIX file "<path>" with write permission' -e 'write (the clipboard as «class PNGf») to f' -e 'close access f'`, then the `«class TIFF»` variant plus `sips -s format png <tiff> --out <png>`; it removes its intermediate files. `pasteImage` in the app captures the focused shell at key time, returns at once unless that shell has `remote`, holds a single in-flight flag, and removes the Mac file in `finally`. Add the Cmd+V branch (`key.super && key.name === "v"`) before keys reach the terminal, calling `stop()` and `void this.pasteImage()`.

- [ ] **Step 4: Run the tests, the full app suite and the type check:** `./node_modules/bun/bin/bun.exe test` and `./node_modules/.bin/tsc --noEmit -p .`. Expected: all pass, no type errors.

- [ ] **Step 5: Update `docs/interface.md`, then commit:**
```bash
git add app/clipboard-image.ts app/clipboard-image.test.ts app/image-paste.test.ts app/backend.ts app/app.ts docs/interface.md
git commit -m "app: Cmd+V with an image pastes it into a remote session through the host"
```

### Task 4: S3 safety-net lifecycle rule (private setup repository)

**Files (the private setup repository, new branch from `main`):**
- Modify: the template of the setup repository that renders the bucket's lifecycle rules
- Test: the deployment tests of the setup repository

- [ ] **Step 1: Write the failing test** `test_clipboard_inputs_expire_after_one_day`: the rendered bucket has one rule with `Id` `ClipboardInputRetention`, `Prefix` `inputs/clipboard/`, `ExpirationInDays` 1, `NoncurrentVersionExpiration` 1 day, `AbortIncompleteMultipartUpload` 1 day; the two existing rules are unchanged.
- [ ] **Step 2: Run it to verify it fails:** the deployment tests of the setup repository. Expected: FAIL.
- [ ] **Step 3: Add the rule to the template renderer.**
- [ ] **Step 4: Run the deployment tests.** Expected: OK.
- [ ] **Step 5: Commit:** `git commit -m "Expire clipboard images in the artifacts bucket after one day"`.

### Task 5: Operations (each step waits for the owner)

- [ ] **1. Live lifecycle rule:** read the bucket's lifecycle configuration, add `ClipboardInputRetention` in the `Filter.Prefix` form, keep only `Rules`, write, read back, compare with `jq -S .Rules`. On a difference, restore the earlier configuration.
- [ ] **2. Deploy the helper:** deploy the helper to the host with mode 0755; the guard passes after.
- [ ] **3. Mac setup:** add `paste_bucket=<artifacts bucket>` to `~/.config/tokiwa/host.env`; add `keybind = performable:super+v=paste_from_clipboard` to the Ghostty config; reload Ghostty.
- [ ] **4. Install the app:** `bash app/install.sh`.
- [ ] **5. Live check in a real remote Claude Code session** (a scratch session): Cmd+V with a screenshot shows `[Image #1]`; one turn describes the image correctly; Cmd+V with text pastes the text; `aws s3 ls s3://<bucket>/inputs/clipboard/` is empty; the file is in the session's `tmp/`. A failure case: with `paste_bucket=` removed, Cmd+V says `Image paste is not set up...` and pastes nothing. End the scratch session.
