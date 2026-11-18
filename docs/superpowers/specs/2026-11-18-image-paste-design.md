# Image paste into a remote session

## Intent

A person who views a remote session in the Tokiwa app presses Cmd+V with an image on the Mac clipboard. The agent in that session, for example Claude Code, gets the image, as it does when it runs on the Mac. Today nothing happens: Cmd+V reaches the remote program, which looks for a Linux clipboard that the workstation does not have.

## Goals

- Cmd+V with an image on the clipboard, in a remote session view, attaches the image in Claude Code.
- Text paste does not change.
- The path is pasted only after the image on the host is checked.
- A failure pastes nothing and says why in one line.
- No copy of the image stays behind: not on the Mac, not in S3; on the host it stays only in the session's temporary folder.

## Non-goals

- Sending an image from an agent, from the CLI or from the MCP server to a session. No public command or tool sends an image.
- Ctrl+V, drag and drop, or files that are not images.
- Image paste in a local terminal view.

## Anti-goals

- A change to text paste, even in an edge case.
- An image that stays in S3 because a step failed.
- A new AWS permission for the host, or AWS access inside the workbench.

## Facts this design rests on

- Claude Code attaches an image when the pasted text is the absolute path of an image file: it shows `[Image #1]` (checked with Claude Code 2.1.327).
- The app's terminal view of a remote session is a tmux client over an SSM session. A bracketed paste into it reaches the program in the pane.
- Ghostty sends Cmd+V to the app only when the Ghostty binding is `performable`: `keybind = performable:super+v=paste_from_clipboard` pastes text when the clipboard holds text, and passes Cmd+V on otherwise. The app already uses this pattern for Cmd+C.
- The launcher reaches the host through SSM Run Command, where the helper runs as the session user, outside the workbench.
- The bucket had no expiry rule for `inputs/`.

## Approaches

1. **Paste a checked file path (chosen).** The app uploads the image to S3. The host helper downloads it with a short presigned URL into the session's cache folder and checks it. The app then pastes the path.
2. **A stand-in `xclip` in the workbench.** Claude Code calls `xclip` on Ctrl+V; a stand-in would serve the uploaded image. It adds a program to every session's PATH and shared state between the app and the host, for the same result as approach 1. Rejected.
3. **Bytes through the SSM channel.** No S3. Much slower for a screenshot (Run Command takes 64 KB per command). The owner chose S3.

The host helper fetches with a presigned URL, not with the AWS CLI as root: the Tokiwa helper runs as the session user, and a root path would cross a boundary that Tokiwa keeps. The presigned URL needs no AWS access on the host and no permission change.

## Design

### Flow

1. Ghostty pastes text as today. With no text on the clipboard, Cmd+V reaches the app.
2. The app acts only when the focused view is a remote session view. It writes the clipboard image as PNG to a temporary file on the Mac. With no image on the clipboard, it does nothing.
3. The app shows `Pasting image…` in the footer and calls the launcher with an internal command: the session name, its identity and the file.
4. The launcher:
   1. uploads the file to `s3://BUCKET/inputs/clipboard/<random>.png`;
   2. makes a presigned GET URL that expires after 5 minutes;
   3. seals the URL to the pinned host input certificate, as `agent send` seals its text, and runs the helper mode `paste-image NAME IDENTITY SHA256 SIZE` on the host, which reads the URL on stdin from `tokiwa-input.py`. The URL is never plain in the Run Command history;
   4. deletes the S3 object, on success and on failure;
   5. prints the host path, or fails with one line.
5. The helper checks the session identity, downloads with `curl` into `/srv/development/cache/sessions/<session>/tmp/paste-<time>-<random>.png` (mode 0600, the session user), checks the size and the sha256, and prints the path. On any failure it removes the partial file.
6. The app pastes the path as one bracketed paste into the view, and removes the Mac file. On failure it pastes nothing, removes the Mac file and shows `Image paste failed: <reason>. Nothing was pasted.`

### Choices

- **Where the file goes.** The session's cache folder, created by the helper when it does not exist. A session that started before the session cache had its variables still gets the file there, because the folder is on the session cache root, which the workbench can write. The 7-day cleanup of `tmp/` removes it.
- **Bucket.** A key `paste_bucket=` in the host settings file (`~/.config/tokiwa/host.env`). Without it, Cmd+V with an image says `Image paste is not set up.`
- **Safety net in S3.** A lifecycle rule on the bucket expires `inputs/clipboard/` after 1 day, with noncurrent versions after 1 day and incomplete uploads after 1 day. It removes an image that a crash or an expired sign-in left behind. The rule is an owner-approved change to the live bucket, also written into the setup template.
- **Size.** The app refuses an image over 10 MB with one line.
- **Program in the pane.** The app pastes the path whatever program runs in the pane. In a shell, the path is useful by itself.
- **Command name.** The launcher command is internal: the app calls it, `--help` does not list it, and the MCP server has no tool for it.
- **Signed out.** The launcher fails with the usual sign-in error; the app shows it and pastes nothing.

### Setup on the Mac

- The Ghostty line `keybind = performable:super+v=paste_from_clipboard`, documented beside the Cmd+C line.
- `paste_bucket=` in the host settings file.

## Verification

- Unit tests: the app pastes only after a successful launcher reply; a failure pastes nothing and removes the temporary file; text paste is not touched; the helper refuses a wrong size or sha256 and leaves no partial file; the launcher deletes the S3 object on success and on failure.
- Live: in a real remote Claude Code session, Cmd+V with a screenshot shows `[Image #1]`, and Claude Code describes the image. Then: text paste still works; no object remains under `inputs/clipboard/`; the file is in the session's `tmp/`.

## Left to the builder

- How the app reads the clipboard image as PNG (for example `osascript` with `«class PNGf»`, with a TIFF fallback through `sips`).
- The internal command's name and argument format.
- The timeouts of the upload, the Run Command call and the download.
