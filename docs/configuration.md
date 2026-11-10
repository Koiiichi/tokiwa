# Configuration

This page lists every setting of the Tokiwa app and the Mac launcher: environment variables, command-line options, files and the launcher lines that name the host.
The app has no settings screen. A setting changes only through the items on this page.

## Environment variables

| Variable | Read by | Default | Meaning |
| --- | --- | --- | --- |
| `TOKIWA_REDUCED_MOTION` | App | Unset | `1` stops the throb of the output glyph `◆`, the cycle of the header diamond and the pulse of a starting shell or session. |
| `TOKIWA_LOCAL_SHELL` | App ([`pty.ts`](../app/pty.ts)) | Unset: `$SHELL -l`, or `/bin/zsh -l` | The command of a local shell, split at spaces, for example `/bin/zsh -f`. |
| `TOKIWA_CAPTURE_DIR` | App, capture scripts | `~/.local/state/tokiwa/captures` | The folder for **Save screen**. The capture scripts in `app/` write to subfolders of it. |
| `TOKIWA_RECORD_DIR` | App ([`pty.ts`](../app/pty.ts)) | Unset: nothing is recorded | A folder for the raw output and the size changes of each remote transport. See [Files](#files). |
| `TOKIWA_ORDER_FILE` | App | `~/.local/state/tokiwa/project-order.json` | The file that keeps the order of the top-level projects. |
| `TOKIWA_OPEN` | App | `/usr/bin/open` | The command that opens a link in the Mac's browser. It receives the link as its one argument. |
| `TOKIWA_APP_DIR` | [`install.sh`](../app/install.sh) | `~/.local/lib/tokiwa/opentui` | The install folder. The launcher opens only the default folder. |
| `TOKIWA_HOST_CONFIG` | Launcher, app | `~/.config/tokiwa/host.env` | The file of the [host settings](#host-settings). |
| `TOKIWA_DASHBOARD` | Launcher | `0` | `1` turns off the progress lines of the launcher, and the launcher does not start `aws sso login`. The app sets `1` on each launcher call. |
| `TOKIWA_VIA` | Launcher, app, MCP server | `cli`; the app sets `app`, the MCP server `mcp` | The interface that the [audit log](host.md#audit-log) of the host names for each control action. Another value counts as `cli`. |
| `HOME` | App, launcher | — | The base of the launcher path, `health.json`, the state files and the start directory of a local shell. |
| `SHELL` | App | — | The login shell of a local shell. |
| `LANG` | App | `en_US.UTF-8` when unset | The locale of each transport. |

A local shell inherits the app's environment without the variables of the terminal around the app, for example `TERM_PROGRAM`, `TMUX` and `GHOSTTY_*`. A remote transport gets a fixed environment: `PATH`, `HOME`, `TERM`, `COLORTERM`, `LANG` and `PS1`. See [Transport](transport.md).

## Command-line options

These options are for `app/run`. `runOptions` in [`app.ts`](../app/app.ts) parses them. The `tokiwa` launcher starts the installed app without options.

| Option | Default | Meaning |
| --- | --- | --- |
| `--attach NAME` | None | Attach the session NAME at start. Its terminal takes the keyboard when it is ready. NAME has 1 to 48 letters, digits, hyphens or underscores and starts with a letter or digit. |
| `--layout workspace` | `workspace` | Show the session list beside the terminal at 100 columns and wider. |
| `--layout terminal` | — | Give the terminal the full width at every size. The list and the terminal take the width in turn. |
| `--snapshot FILE` | None | Show one recorded Health reading from FILE and do not sample. See [Health](health.md#recorded-reading). |
| `--deadline MINUTES` | None | Close the app after 1 to 1440 minutes. |
| `--receipt FILE` | None | Write the last 2000 events of the app to FILE as a JSON array, again after each event. |

`--attach`, `--layout`, `--snapshot` or `--deadline` without a valid value stops the app at start with an error. The app ignores other arguments. `app/run` changes to its own folder before it starts the app, so give FILE as an absolute path.

## Files

| File | Where | Default | Meaning |
| --- | --- | --- | --- |
| [`projects.json`](../app/projects.json) | The app folder; in the installed copy, `~/.local/lib/tokiwa/opentui/app/projects.json` | `{ "name": "local", "shells": ["build", "inspect"] }` | The local shell group. `name` is the group title: 1 to 30 letters, digits, spaces or hyphens. `shells` names at most three shells that `g` starts: 1 to 24 letters, digits or hyphens each. A file outside these rules stops the app at start. |
| `health.json` | `~/.config/tokiwa/health.json` | Missing: built-in defaults | The budget, the authorization end and the prices of the spend estimate. The app reads it once at start. See [Health](health.md#healthjson). |
| Project order file | `~/.local/state/tokiwa/project-order.json`, or `$TOKIWA_ORDER_FILE` | Missing: projects sort by name | `{ "order": [...] }`: the top-level projects in the order that you set by drag. The app reads it at start and writes it after each reorder. |
| Captures folder | `~/.local/state/tokiwa/captures/`, or `$TOKIWA_CAPTURE_DIR` | Made on first use | **Save screen** writes `<time>-<view>.txt` here. |
| Record folder | `$TOKIWA_RECORD_DIR` | None | Each remote transport appends its raw output to `<time>-<pid>.bytes` and each size change to `<time>-<pid>.sizes`, as `<byte offset> <cols> <rows>`. |
| Receipt | The FILE of `--receipt` | None | The event log of the app. |
| Launcher | `~/.local/bin/tokiwa` | — | The app makes every AWS call and every tmux operation through this file. Install it from [`bin/tokiwa`](../bin/tokiwa). |
| Installed app | `~/.local/lib/tokiwa/opentui/` | — | `tokiwa` opens `run` in this folder. `app/install.sh` writes it, and `app/install.sh --rollback` restores the copy that the last install replaced. |
| Session Manager plugin | `~/.local/lib/cloud-access/session-manager-plugin` | — | The launcher needs it to attach a session. |

The app makes the state folders with mode 700 and writes the order file, the captures and the recordings with mode 600. Captures and recordings hold session text.

The saved projects of the host are a different `projects.json`, in `~/.tokiwa/` of the workbench user on the host. See [Sessions and projects](sessions-and-projects.md).

## Host settings

The launcher and the app read the host from `~/.config/tokiwa/host.env`, or from the file that `TOKIWA_HOST_CONFIG` names. Each line is `KEY=VALUE` or a `#` comment. The launcher reads the file and never runs it; any other line stops it.

```sh
# ~/.config/tokiwa/host.env
instance=i-0123456789abcdef0
profile=work
region=us-east-1
account=123456789012
end=2026-12-31T23:59:00-08:00
```

| Key | Required | Value | Effect |
| --- | --- | --- | --- |
| `instance` | Yes | An EC2 instance ID | The target of each Run Command, each attach and the spend inventory. |
| `profile` | Yes | An AWS CLI profile | The profile of each AWS call and of `aws sso login`. |
| `region` | Yes | An AWS region | The region of each AWS call, the `region` field of the `spend` output, and the Session Manager endpoint that the connection card times. |
| `account` | No | A 12-digit AWS account ID | The launcher stops when the profile signs in to another account. |
| `end` | No | A time with an offset | From this time the launcher starts no connection: `The end time in … has passed. No host was started.` `--help` still works. |

A missing file, a missing required key or a value in the wrong form stops the launcher before any AWS call, with a message that names the key. The app reads only `region`; without the file it times the us-east-1 endpoint.

`end` and `authorization_end` in `health.json` are separate settings. The launcher refuses to connect after `end`. The Health view counts days to `authorization_end`.

The launcher sets its own `PATH`, with `~/.local/lib/cloud-access` first, and sets `AWS_PAGER` to an empty value. `tokiwa --help` lists its commands. See [Host](host.md) and [Transport](transport.md).

## Related

- [Interface](interface.md)
- [Health](health.md)
- [Development](development.md)
- [Sessions and projects](sessions-and-projects.md)
