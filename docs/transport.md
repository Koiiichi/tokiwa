# Transport

A transport is the process that carries one attached session between tmux on the host and a terminal view in the app: the launcher's `tokiwa attach NAME IDENTITY` in a PTY that the app owns. A transport does not own the session: when it ends, the session and its programs keep running on the host.

[`PtyAdapter`](../app/pty.ts) owns each transport. [`attachRemote`](../app/app.ts) starts it, and [`BackendClient`](../app/backend.ts) builds its command. For the parts around the transport, see [Architecture](architecture.md).

## I/O model

```
╔═ host ═══════════════════════════════════════════════════════════════╗
║  ┌─ program in a tmux pane ───────────────────────────────────────┐  ║
║  │ Claude Code, Codex or a shell                                  │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║        │ output                                     ▲ keys, replies  ║
║        ▼                                            │                ║
║  ┌─ tmux server and client (terminal-session.sh attach) ──────────┐  ║
║  │ draws the client; moves down with a bare LF; passes OSC 52     │  ║
║  │ and passthrough on to the client                               │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║        │                                            ▲                ║
╚════════▼════════════════════════════════════════════▲════════════════╝
         │            AWS Session Manager             │
╔═ Mac ══▼════════════════════════════════════════════▲════════════════╗
║  ┌─ session-manager-plugin, aws ssm start-session, launcher ──────┐  ║
║  │ plugin: stty cbreak; sends the size to the host on a poll      │  ║
║  │ launcher: stty -onlcr; restores the TTY after the session      │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║        │                                            ▲                ║
║        ▼                                            │                ║
║  ┌─ transport PTY (Bun.spawn terminal) ───────────────────────────┐  ║
║  │ stty -opost -onlcr; raw mode                                   │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║        │                                            ▲                ║
║        ▼                                            │                ║
║  ┌─ PtyAdapter ───────────────────────────────────────────────────┐  ║
║  │ output: record → beforeTmux → scan → events.data               │  ║
║  │ input: write · replies: reply, through the startup filter      │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║        │ events.data                                ▲ onData         ║
║        ▼                                            │                ║
║  ┌─ EmbeddedTerminalRenderable ───────────────────────────────────┐  ║
║  │ VT emulator of the view; OpenTUI draws it in Ghostty           │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════╝
```

Output goes down the left side. `PtyAdapter` changes it in one place only: before tmux takes the alternate screen (see [Line feeds](#line-feeds)). `scan` reads the output for requests and passes every byte on.

Input goes up the right side. `onData` gives two sources. `"input"` is a key, a paste, a mouse event or a focus report that the emulator encoded; `PtyAdapter.write` sends it. `"response"` is the emulator's reply to a terminal query; `PtyAdapter.reply` sends it through the [startup reply filter](#startup-reply-filter).

A size change goes up too: `onTerminalResize` calls `PtyAdapter.resize`, which resizes the PTY at once.

## Attach

`attachRemote(name, expected, reconnect, withChild)` attaches one session in a view.

1. A view of the session with an open transport takes the focus. Nothing new starts.
2. `BackendClient.resolve(name, expected)` reads a new snapshot and finds the session by name. With `expected`, the identity must match.
3. The app makes the view: an `EmbeddedTerminalRenderable` of 80 × 24 cells with `maxScrollback: 100000`. A reconnect keeps the view and clears its screen.
4. `BackendClient.attachCommand(ref)` returns `[launcher, "attach", name, identity]`.
5. `new PtyAdapter("remote", command, events, cwd)` starts the transport. The adapter then takes the size of the view.
6. A fresh attach calls `openChildBeside`: see [Child shell beside](#child-shell-beside).

The row shows `attaching` while the app attaches the session. The launcher prints its progress lines into the view, for example `Tokiwa · checking AWS access…`, until tmux draws.

### Session identity

The identity of a session is `#{pid}:#{session_id}:#{session_created}`: the PID of the tmux server, the tmux session id (for example `$4`) and the creation time of the session. A session name can come back after its session ends; the identity cannot. A restart of the tmux server changes every identity.

Each layer checks the identity before it attaches.

| Layer | Check | Failure |
| --- | --- | --- |
| `BackendClient.resolve` | The snapshot lists the name, and its identity equals `expected` | `The session no longer exists. No replacement was created.` or `The session identity changed. Reconnect was refused.` |
| `BackendClient.attachCommand` | The identity matches `^\d+:\$\d+:\d+$` | `The session identity is invalid.` |
| Launcher | The same pattern; it quotes the identity for the remote shell, because the identity holds `$` | `The session identity is invalid. Refresh the session list.` |
| Host helper | `if-shell -F` compares the identity and runs `attach-session` in one tmux command queue | `Session identity changed. No session was attached.`, then the launcher prints `The terminal connection ended with an error. Run tokiwa status.` |

The view itself holds the identity of its session. A later attach to the same view with another identity fails with `The session identity changed. Open a new view.` or `The session identity changed. Selection was refused.`

### Child shell beside

A fresh attach also reopens the newest child of the session (a session made with **Shell here**) in a second view beside it. The child is the session whose `parent` equals the session's tmux session id; the newest has the largest creation time. The child gets its own transport, and the source session keeps the keyboard.

| Condition | Effect |
| --- | --- |
| The window has room for one view only | Nothing opens |
| Four views are open | Nothing opens |
| The session already has a view beside it | Nothing opens |
| Every pane of the child is dead | Nothing opens |
| A reconnect | Nothing opens |

**Shell here** itself runs `tokiwa new NAME --from SOURCE` as a remote transport. The host creates the session and attaches it by name. The app then reads the snapshot every 2 s, up to six times, to learn the new session's identity. Without it, the app closes the new view, and the footer shows `The new shell identity is unverified: NAME. No second shell was created.` The app closes the view of a new shell after any other failure before the shell opens beside its source, too.

## PTY settings

A remote transport and a local shell use the same `PtyAdapter` with different settings.

| Setting | Local shell | Remote transport |
| --- | --- | --- |
| Command | `localShellCommand`: `$SHELL -l`, `/bin/zsh -l`, or `TOKIWA_LOCAL_SHELL` | `/bin/sh -c 'stty -opost -onlcr 2>/dev/null; exec "$@"' tokiwa-transport <launcher> attach NAME IDENTITY` |
| Output processing | The PTY default | `-opost -onlcr`, then the launcher's `stty -onlcr` |
| Raw mode | Off | `setRawMode(true)` before the transport starts |
| Environment | The app's environment without the outer terminal's variables (`TMUX`, `TERM_PROGRAM`, `GHOSTTY_*` and others) | Fixed: `PATH=/usr/bin:/bin:/usr/sbin:/sbin`, `HOME`, `TERM`, `COLORTERM`, `LANG`, `PS1` |
| `TERM`, `COLORTERM` | `xterm-256color`, `truecolor` | `xterm-256color`, `truecolor` |
| `LANG` | `$LANG`, or `en_US.UTF-8` | `$LANG`, or `en_US.UTF-8` |
| First size | 80 × 24, then the size of the view | 80 × 24, then the size of the view |
| Startup reply filter | Off | On |
| Redraw after a size change | Off | On |

The fixed environment makes the launcher and the Session Manager plugin behave the same however the app started. Raw mode lets a reply to an early terminal query pass at once, and keeps the PTY from echoing it back into the emulator.

### Line feeds

tmux sets its own terminal raw on the host. To move down one row in the same column, it sends a bare line feed (LF). The transport must deliver that LF unchanged.

The Session Manager plugin runs `stty cbreak` on its terminal, and on macOS that turns output processing (`opost`) back on. With `onlcr` also on, the PTY turns each LF into CR LF. The cursor then goes to column 0, and the row lands at the left edge instead of its own column. In a full-screen program that scrolls, the first letters of lines stay behind in the left columns. So `onlcr` itself must be off: the adapter turns it off in the PTY, and the launcher turns it off again on its terminal and restores the saved settings after the session.

With `onlcr` off, the plain lines of the launcher and the plugin would step to the right. `beforeTmux` gives each LF that has no CR before it a CR, as a terminal with `onlcr` does. It stops at the first `ESC [ ? 1049 h` (tmux takes the alternate screen) and starts again after `ESC [ ? 1049 l`. Between the two, tmux's bytes pass unchanged.

A local shell keeps the usual output processing, so its LF arrives as CR LF.

### Startup reply filter

When a tmux client starts, it sends queries to its terminal: here, the emulator in the view. tmux waits five seconds for each reply. A reply that arrives later, for example over a slow Session Manager path, goes to the pane as typed input, and the shell shows text such as `[?62;22c`.

A remote transport therefore never sends these replies. `withoutStartupQueryReplies` removes them from each emulator response; every other reply passes.

| Reply | Pattern | Remote transport |
| --- | --- | --- |
| Primary device attributes (DA1) | `ESC [ ? … c` | Removed |
| Secondary device attributes (DA2) | `ESC [ > … c` | Removed |
| XTVERSION | `ESC P > \| … ST` or `… BEL` | Removed |
| DEC mode 2026 report | `ESC [ ? 2026 ; N $ y` | Removed |
| OSC 10 and OSC 11 colours | — | Kept: tmux accepts them at any time |
| Every other reply | — | Kept |

A local shell keeps every reply.

## Redraw after a size change

The emulator reflows at once when the view changes size. The alternate screen loses rows from the top, and the scroll region resets. tmux sends only the cells that changed in its own copy of the screen, so the emulator stays wrong until tmux draws the whole client again. The Session Manager plugin passes the size to the host on a 500 ms poll, so a short size change can reach the emulator and never reach tmux.

`PtyAdapter.resize` therefore asks tmux to redraw after the size settles.

| Item | Value |
| --- | --- |
| Wait after the last size change | `PtyAdapter.redrawDelayMs`, 1000 ms; each new size restarts the wait |
| Request | `Ctrl+B r` (`\x02r`): `refresh-client` in the default tmux key table |
| Sent only when | tmux holds the alternate screen, and the user's last input did not end in `Ctrl+B` |
| Not sent | For a local shell; for output alone; for a size that did not change |
| Hidden view | A size that is not finite or is below 1 × 1 is ignored; the PTY keeps its last usable size |

The prefix rule keeps the redraw from completing a tmux command that the user started. **Redraw terminal** in the search sends the same request under the same conditions (`PtyAdapter.redraw`).

## Reconnect

**Reconnect** (`r`) calls `attachRemote(name, identity, true)` with the identity of the open view.

1. `resolve` checks that the session still has that identity. A changed identity refuses the reconnect.
2. `closeTransport` closes the old PTY. The app waits up to 5 seconds for the old process to exit; otherwise it fails with `The previous transport did not close. No new connection was started.`
3. A new transport starts in the same view, and the view clears its screen.
4. tmux draws the new client in full.

After a detach, or after the session itself ended, the app closes the view and reads the session list again. The footer says what happened, and when it was the active view, the keyboard returns to the list on that row. Any other view stays open.

A transport that ended any other way, such as a dropped connection, keeps its view, so the connection log stays readable, and its row shows `○ disconnected`. After a minute the row shows the session on the host again; the view stays until `d` closes it. Enter on the row attaches the session again with the identity of the last snapshot. The app never reconnects on its own.

## Clipboard writes

A program on the host can write the Mac clipboard with OSC 52. tmux passes the write on to its client (`set-clipboard on`). `scan` finds `ESC ] 52 ; <selection> ; <base64> BEL` (or `ST`), decodes the text and calls `programCopied`. The app writes the text to Ghostty with OSC 52 (`copyToClipboardOSC52`), and Ghostty sets the macOS clipboard.

| Item | Behavior |
| --- | --- |
| Footer | `copied N characters`, or `copy failed · the terminal did not accept it` |
| Empty text | Ignored |
| A request split across reads | `scan` keeps the unfinished part for the next read, up to 1 MiB |
| **Copy selection** | Without a selection on the screen, copies the last program write again |
| Mouse | A program that sets mode 1000, 1002 or 1003 owns a drag; the app starts no selection of its own |

Any program in a session can replace the Mac clipboard this way. The footer shows each write.

## Link requests

The host has no browser. Programs there open a link through [`tokiwa-open`](../host/tokiwa-open), which tmux and the host helper set as `BROWSER` for new shells. The helper accepts only `http://` and `https://` links. It writes `ESC ] 7717 ; open ; <base64 link> BEL` to the terminal of its session, inside a tmux passthrough (`ESC P tmux; …`) when `TMUX` is set. When `/dev/tty` is not available, it writes to the pane's TTY.

`scan` finds the request and calls `programOpened`.

| Check | Rule |
| --- | --- |
| Scheme | `http` or `https` only |
| Length | 4096 characters at most |
| Input rule | The link opens at once only when the view sent input to its program in the last 5 seconds (`shell.lastInput`) |
| Opened | `/usr/bin/open <link>` (or `TOKIWA_OPEN`); the footer says `opened <host/path> in your browser` |
| Not opened | The footer says `<session> asked to open <host/path>` for 15 seconds and offers **open** and **copy** |

The input rule counts every `"input"` event of the view: a key, a paste, a mouse event that the program receives, or a focus report. A click that only moves the keyboard to the view sends nothing to the program, so it does not count. The rule keeps a program that runs alone from opening pages in the signed-in browser of the Mac.

A request reaches the app only through an open transport of its session. A shell that started before `BROWSER` named `tokiwa-open` keeps its old value.

## Connection card

Session Manager carries no ICMP, so the app times TCP connections instead. `reachAws` opens one connection to `ssm.us-east-1.amazonaws.com:443`, the Session Manager endpoint in the launcher's region, and resolves with the connect time.

The card opens under the pointer on the header label, for example `<mac> → EC2 · connected`.

| Row | Content |
| --- | --- |
| `ping` | The last connect time, the average and the jitter: `N ms  avg N ms · jitter N ms`; `lost · avg …` after a lost try |
| `loss` | `N % (L of the last T tries)` |
| `sessions` | `N open here · M on the workstation`: open remote views, and sessions in the last snapshot |

| Item | Value |
| --- | --- |
| Window | The last 20 tries |
| Lost try | A connection error, or no connection after 3 s |
| Average | The mean of the successful tries in the window |
| Jitter | The mean absolute difference between consecutive successful tries |
| Schedule | One try when the app starts, then one every 15 s while the app is open |
| Try on open | When the card opens and the last try is older than 5 s |
| Card update | Every second while the card is open |

The card measures the path to the AWS endpoint. It does not measure an open transport.

## Limits and failures

| Event | Behavior |
| --- | --- |
| Five views | `Tokiwa supports four terminal views.` |
| The view text is wrong after a size change | **Redraw terminal** (`Ctrl+B r`); if the text stays wrong, **Reconnect** |
| The drawing is stale, not the emulator | **Repaint view** draws the view again from the emulator and sends nothing to tmux |
| The source of a wrong screen is unknown | **Save screen** writes the emulator's text, size and cursor and the pane size to `~/.local/state/tokiwa/captures/` (or `TOKIWA_CAPTURE_DIR`); compare it with `tmux capture-pane` on the host |
| A stream to replay | With `TOKIWA_RECORD_DIR` set, each remote transport appends its raw output to `<dir>/<time>-<pid>.bytes` and each size change to `.sizes` as `<byte offset> <cols> <rows>`. The folder has mode 0700, the files 0600. Nothing is recorded without the variable |
| A transport ends | The launcher turns off mouse, focus, paste and keyboard modes in the view and shows the cursor; after a failure it also leaves the alternate screen |

The recorded bytes are the raw PTY output, before `beforeTmux`. They hold the session text.

## Test

From `app/`, run the transport tests:

```sh
./node_modules/bun/bin/bun.exe test pty.test.ts responses.test.ts redraw.test.ts
```

`bunfig.toml` preloads `test-guard.ts`, so no test runs the installed launcher or reaches AWS.
