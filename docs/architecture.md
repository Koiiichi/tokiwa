# Architecture

Tokiwa is a set of programs that keep terminal sessions in tmux on a cloud Linux host and show them in a terminal app on a Mac. Tokiwa does not start, stop or change the host instance, and the Mac holds no session state: the sessions live in tmux on the host.

This page names each part, what it owns and how data moves between the parts. For the byte stream of an attached session, see [Transport](transport.md). For the session model, see [Sessions and projects](sessions-and-projects.md).

## Parts

| Part | File | Runs on | Owns | Does not own |
| --- | --- | --- | --- | --- |
| Host service | [`cloud-workbench.service`](../host/units/cloud-workbench.service) | Host, as `agent-workspace` | The tmux server process, its sandbox and its limits | The sessions inside tmux; a restart of tmux after it exits (`Restart=no`) |
| tmux server | [`start-workbench.sh`](../host/start-workbench.sh) configures it | Host, in the service | Sessions, windows, panes and their processes; the options `@tokiwa_project`, `@tokiwa_parent` and `@tokiwa_name`; bell flags | Saved projects; anything on the Mac |
| Host helper | [`terminal-session.sh`](../host/terminal-session.sh) | Host, as `agent-workspace`, once per launcher command | Checks of names and session identities; the snapshot; `projects.json` | The tmux server: it never starts one (`tmux -N`); AWS |
| Link helper | [`tokiwa-open`](../host/tokiwa-open) | Host, in a session, as `$BROWSER` | One link request to the terminal of its session | Opening the link: the app decides |
| Session Manager | AWS Systems Manager | AWS | The only path between the Mac and the host | Session state |
| Launcher | [`bin/tokiwa`](../bin/tokiwa) | Mac | AWS sign-in and identity, the host state check, the AWS CLI calls, the TTY settings of an interactive session | Sessions; the interface |
| App | [`app/`](../app/) (Bun, OpenTUI Core) | Mac, in Ghostty | Views, terminal emulators, transports, local shells, the Mac clipboard writes, link opening | AWS and tmux: [`backend.ts`](../app/backend.ts) delegates every operation to the launcher |

## Data flow

```
╔═ Mac ════════════════════════════════════════════════════════════════╗
║  ┌─ Ghostty ──────────────────────────────────────────────────────┐  ║
║  │ draws the app; writes the macOS clipboard on OSC 52            │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║                              ▲ screen                                ║
║  ┌─ app/ ─────────────────────────────────────────────────────────┐  ║
║  │ BackendClient                     PtyAdapter, one per view     │  ║
║  │ reads and changes                 a byte stream                │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║      │ tokiwa --snapshot, health,       │ attach NAME IDENTITY       ║
║      ▼ project, create, rename, …       ▼                            ║
║  ┌─ launcher: tokiwa ─────────────────────────────────────────────┐  ║
║  │ AWS identity, host state, aws ssm, local TTY settings          │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║      │ Run Command                      │ interactive session        ║
╚══════▼══════════════════════════════════▼════════════════════════════╝
       │ AWS-RunShellScript               │ AWS-StartInteractiveCommand
  ┌─ AWS Session Manager ──────────────────────────────────────────┐
  └────────────────────────────────────────────────────────────────┘
       │ JSON or text on stdout           │ bytes both ways
╔══════▼══════════════════════════════════▼═ host ═════════════════════╗
║  ┌─ host helper: terminal-session.sh ─────────────────────────────┐  ║
║  │ snapshot, create, rename, end      attach: a tmux client       │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
║      │ tmux -N -S /run/cloud-workbench/tmux.sock                     ║
║      ▼                                                               ║
║  ┌─ cloud-workbench.service ──────────────────────────────────────┐  ║
║  │ tmux server: sessions with Claude Code, Codex and shells       │  ║
║  └────────────────────────────────────────────────────────────────┘  ║
╚══════════════════════════════════════════════════════════════════════╝
```

Two kinds of traffic cross Session Manager. Reads and changes are short Run Command calls: the launcher sends the command, waits for its result and prints the helper's output. An attached session is an interactive session: one stream of bytes for as long as the view stays attached. Each open view in the app has its own interactive session.

## Session Manager paths

The launcher picks the path from its command. `tokiwa --help` lists the commands.

| Path | AWS calls | Document | Launcher commands | Result |
| --- | --- | --- | --- | --- |
| Run Command | `ssm send-command`, then `ssm get-command-invocation` | `AWS-RunShellScript`, `executionTimeout` 30 s | `status`, `sessions`, `sessions --json`, `--snapshot`, `capture`, `health`, `project`, `create`, `move-project`, `forget-project`, `name`, `rename`, `--end-confirmed` | The helper's stdout, after the status leaves `Pending` |
| Interactive session | `ssm start-session` | `AWS-StartInteractiveCommand` | `attach`, `new`, `shell`, `admin` | A byte stream through the Session Manager plugin |
| EC2 API | `ec2 describe-instances`, `describe-volumes`, `describe-addresses` | — | `spend`, and the host state check before every host command | JSON for the spend estimate; the instance state |

The launcher polls `get-command-invocation` up to 15 times, one second apart. A status other than `Success` fails the call with `The workbench check returned <status>. No service was started.`

On the host, each command runs as `sudo -n runuser -u agent-workspace -- env TOKIWA_QUIET=1 /opt/agent-platform/rootless/terminal-session.sh <mode> …`. Except for `health`, the command first checks `systemctl is-active` for `cloud-workbench.service`; Run Command calls also check `user@2200.service`.

## Host service

`cloud-workbench.service` runs `tmux -D -S /run/cloud-workbench/tmux.sock -f /dev/null` in the foreground as `agent-workspace`, without a tmux configuration file. `ExecStartPost` runs `start-workbench.sh`. The unit sets the sandbox and the environment that every session inherits.

| Setting | Value |
| --- | --- |
| Socket | `/run/cloud-workbench/tmux.sock`, in a runtime folder of mode 0700 |
| Working directory | `/srv/development/state/workspaces/workbench` |
| Writable paths | The workbench folder, the workbench home, the peermesh folder |
| Limits | `MemoryMax=8G`, `MemorySwapMax=0`, `CPUQuota=300%`, `TasksMax=512` |
| Restart | `Restart=no`; `KillMode=control-group`, so a stop ends every session |
| Environment | `HOME`, `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `DOCKER_HOST`, `PATH` and others; see the unit file |

[Host](host.md) describes the sandbox, the install paths and recovery.

## tmux server

`start-workbench.sh` waits about 10 seconds at most for the socket, then sets the server options and starts the first session.

| Option or action | Effect |
| --- | --- |
| `mouse on` | Programs that report the mouse get the wheel and drags; other panes get tmux scrolling |
| `set-clipboard on`, `allow-passthrough on` | A program's OSC 52 write and a `tokiwa-open` request reach the attached client |
| Global `BROWSER=/opt/agent-platform/rootless/tokiwa-open` | Programs open links through the link helper |
| Session `workbench` | A plain `bash --noprofile --norc` in the workbench folder, with the prompt `<name>:\W$ ` |

The prompt name is the server option `@tokiwa_name` (`tokiwa` by default; `tokiwa name NAME` sets it).

## Host helper and snapshot

The helper validates each argument, runs tmux commands on the socket and exits. It uses `tmux -N`, so a call never starts a server. When the server is down, every call fails with `The workbench service is unavailable. No service was started. Run tokiwa status.`

`attach` with an identity, `rename` and `end` take the session identity, `#{pid}:#{session_id}:#{session_created}`. The helper compares it and acts in one tmux command queue (`if-shell -F`), so a session that took the same name is never attached, renamed or ended. [Transport](transport.md#session-identity) describes the attach check.

`--snapshot` and `sessions --json` print one JSON object. The app reads it through `BackendClient.sessions` in [`backend.ts`](../app/backend.ts).

| Field | Content |
| --- | --- |
| `sessions[].name`, `identity` | The tmux session name and its identity |
| `sessions[].clients`, `windows` | `#{session_attached}` and `#{session_windows}` |
| `sessions[].cwd` | `#{pane_current_path}` of the current pane |
| `sessions[].project` | `@tokiwa_project`, or `cwd` when the session has no label |
| `sessions[].parent` | `@tokiwa_parent`: the tmux session id of the source of a **Shell here** session |
| `sessions[].bell` | True when a window has `#{window_bell_flag}` set |
| `sessions[].activity[]` | Per pane: `pane`, `dead`, `command` (80 characters at most) and `screen`, a SHA-256 of `capture-pane -p -S -20` |
| `sessions[].activity_partial` | True when the helper left out panes or activity |
| `projects` | The saved projects from `projects.json` |

The snapshot never holds screen text, only its hash. The app compares hashes between two reads to show output or quiet; see [Status glyphs](interface.md#status-glyphs).

| Limit | Value | Behavior past the limit |
| --- | --- | --- |
| Sessions | 100 | The helper fails; `BackendClient` also rejects more than 100 rows |
| Panes with activity, per session | 16 | `activity_partial` is true |
| JSON size | 22000 characters | The helper empties `activity` from the last sessions first; if no activity is left, it fails |

`projects.json` lives in `/srv/development/private/homes/workbench/.tokiwa` (folder mode 0700, file mode 0600). The helper writes it under a lock (`projects.lock`) and replaces it in one rename.

## Launcher

The launcher is one Bash script, installed on the Mac at `~/.local/bin/tokiwa`. It reads the instance, the AWS profile, the region, and optionally the account and an end time from the [host settings](configuration.md#host-settings). Before any host command, it:

1. Calls `sts get-caller-identity`. In an interactive terminal outside the app, an expired sign-in starts `aws sso login`; otherwise the call fails with the command to run.
2. Compares the account with `account=`, when it is set.
3. Reads the instance state. A host that is not `running` stops the command with `The host is <state>. No restart was requested.`

The launcher also refuses every command except `--help` from the time in `end=`, when it is set. `tokiwa` without a command runs the installed app at `~/.local/lib/tokiwa/opentui/run`, in an interactive terminal only.

`BackendClient` sets `TOKIWA_DASHBOARD=1` for every launcher call. With it, the launcher prints no progress lines and never starts a sign-in. An attach from the app does not set it, so the progress lines (`Tokiwa · checking AWS access…`) show in the view before tmux draws.

## App

The app runs as `bun app.ts` from [`app/run`](../app/run). It holds two kinds of connection to the launcher.

| Class | File | Use | Limits |
| --- | --- | --- | --- |
| `BackendClient` | [`backend.ts`](../app/backend.ts) | Runs the launcher once per read or change and parses its stdout | 90 s per call; 100000 characters of output |
| `PtyAdapter` | [`pty.ts`](../app/pty.ts) | Runs `tokiwa attach NAME IDENTITY` in a PTY for each remote view; runs local shells | Four views in all |

The app reads in the background on fixed timers. Each kind of read has at most one call in flight.

| Read | Schedule | Function in [`app.ts`](../app/app.ts) |
| --- | --- | --- |
| Session snapshot | At start, 5 s after the first read, then 30 s after each read while the workspace is in view | `refreshSessions` |
| Health | At start, then 30 s after each completed read | `sampleHealth`; see [Health](health.md) |
| Spend | After a Health read, when the last spend read is 15 minutes old | `sampleHealth` |
| Connection try | A TCP connect, not a launcher call; see [Transport](transport.md#connection-card) | `probe` |

The header shows the state of the host from the snapshot and Health reads: `connecting` before the first result, `connected`, `reconnecting` when the last good read is older than 90 s, and `offline` when the last read failed.

The app keeps a small amount of state on the Mac.

| File | Content |
| --- | --- |
| `~/.local/state/tokiwa/project-order.json` (`TOKIWA_ORDER_FILE`) | The display order of top-level projects |
| `~/.local/state/tokiwa/captures/` (`TOKIWA_CAPTURE_DIR`) | Screens saved with **Save screen** |
| `$TOKIWA_RECORD_DIR` | Raw transport output, only when the variable is set; see [Transport](transport.md#limits-and-failures) |

[Configuration](configuration.md) lists every variable. [Development](development.md) describes the install and the tests.

## Limits and failures

| Event | Effect |
| --- | --- |
| A detach | The session keeps running on the host. The app closes the view |
| A connection drops | The session keeps running on the host. The view stays, and its row shows `○ disconnected` for a minute; Enter or `r` attaches it again, and `d` closes the view |
| The app quits | Remote sessions keep running; local shells end. The app asks first when a program runs in a local shell |
| The service stops | Every session ends (`KillMode=control-group`). Nothing restarts the service |
| The tmux server is down | Every helper call fails; no call starts a new server |
| The AWS sign-in expired | App reads fail with `AWS authentication failed.` The session list offers `l`, which runs `tokiwa login` in a local view. Attached sessions keep running on the host |
| The host is stopped | Every host command fails; the launcher never starts the host |
| A Run Command call takes longer than 15 polls | The call fails with the last status, for example `Pending` |
