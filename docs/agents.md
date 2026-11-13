# Local agents

A local agent reaches Tokiwa in one of two ways: the `tokiwa` command, for an agent that has a shell, or a small MCP server, for any agent. Both offer the same abilities, which [`capabilities.json`](../app/capabilities.json) lists once with a class each:

| Class | Examples | `tokiwa` command | MCP server |
| --- | --- | --- | --- |
| `read` | sessions, a screen, health, status | yes | always |
| `control` | changes to a session or a project | yes | only with `tokiwa mcp --allow control` |
| `run` | a command that runs on the host, `create --run` | yes | only with `tokiwa mcp --allow run` |
| `commands` | an entry of the owner's command list, run on the host | yes | only with `tokiwa mcp --allow commands` |
| `human` | sign-in, `secret`, `admin`, an attached view | yes, for a person | never |

The checks are in the host helper, so they are the same for both: each argument, and the identity of the session that a command names. Tokiwa does not decide which agent may run what. The agent's own tool approves each command or tool call, as it does for `git`; see [Trust](#trust).

Use it when an agent on the Mac must see what a session on the host is doing, for example a session that has stopped answering. To talk to a working agent, use an agent messaging tool in place of this server.

## How a call travels

```
┌─ Mac ───────────────────────────────────────────────────────────┐
│  local agent  ──MCP over stdio──▶  tokiwa mcp  ──▶  tokiwa      │
└────────────────────────────────────────────────────────┬────────┘
                                   Run Command           │
┌─ host ─────────────────────────────────────────────────▼────────┐
│  terminal-session.sh, as agent-workspace  ──▶  tmux             │
└─────────────────────────────────────────────────────────────────┘
```

[`mcp.ts`](../app/mcp.ts) keeps no state. Each tool call runs the launcher once, so a call takes some seconds and a new launcher takes effect at the next call. A failed call returns an error, and the server stays up.

## Connect an agent

Install the app with `app/install.sh`, then register the server.

Claude Code:

```sh
claude mcp add --scope user tokiwa -- ~/.local/bin/tokiwa mcp
```

Codex, in `~/.codex/config.toml` (replace `HOME` with your home directory):

```toml
[mcp_servers.tokiwa]
command = "HOME/.local/bin/tokiwa"
args = ["mcp"]
```

Add `--allow control`, `--allow run`, `--allow commands` or a list such as `--allow control,commands` after `mcp` to offer those tools. The server marks them as destructive, so a client that asks before such tools asks before each call. A running agent sees the tools after it starts again or reconnects its MCP servers.

## Tools

These are the read tools. The table lists the tools of the other classes when they exist.

| Tool | Input | Result |
| --- | --- | --- |
| `tokiwa_sessions` | None | The output of `tokiwa sessions --json`: each session with its `name`, `identity`, folder, project, clients, pane commands, and the state that its agent reported (`agent`, see [Agent state](host.md#agent-state)). See [the snapshot](architecture.md#host-helper-and-snapshot). |
| `tokiwa_screen` | `name`, `identity`, optional `lines` | The output of `tokiwa capture`, after one line that marks the text as data. |
| `tokiwa_search` | `name`, `identity`, `text` | The output of `tokiwa search`: the latest 50 lines of the whole scrollback that hold the text, without regard to case, each with two lines before and after it, and `query` and `matches`. Encrypted on the way as a capture is, and marked as data. |
| `tokiwa_digest` | None | The output of `tokiwa digest --json`: for each session its `agent` state and time, `active_at` (when its screen last changed), and the `git` state of its folder: `branch`, `unpushed` (null without an upstream), `changed`, `commit` and `committed_at`. Commit messages are not included, because Run Command keeps the output. |
| `tokiwa_health` | None | The output of `tokiwa health`. See [Health](health.md). |
| `tokiwa_status` | None | The output of `tokiwa status`. |
| `tokiwa_commands` | None | The output of `tokiwa commands`: each entry of the owner's [command list](host.md#the-command-list) with its `name`, `description` and the shape of each argument. A `choice` shows its names and never the values behind them. Not encrypted. |
| `tokiwa_run_status` | `id`, optional `offset` | The output of `tokiwa run-status ID [OFFSET]`: the state of a run and one page of its output. See [Run a listed command](#run-a-listed-command). Encrypted on the way, and marked as data. |

With `--allow control`:

| Tool | Input | Result |
| --- | --- | --- |
| `tokiwa_interrupt` | `name`, `identity` | The output of `tokiwa interrupt`: Esc to the session. |
| `tokiwa_freeze` | `name`, `identity` | The output of `tokiwa freeze`. |
| `tokiwa_resume` | `name`, `identity` | The output of `tokiwa resume`. |
| `tokiwa_create` | `name`, `dir`, `project` | The output of `tokiwa create NAME --dir DIR --subfolder NAME --project PROJECT`: a session with a shell, in its own folder inside the project folder. Take `dir` from the projects of `tokiwa_sessions`. |

With `--allow run`:

| Tool | Input | Result |
| --- | --- | --- |
| `tokiwa_launch` | `name`, `dir`, `project`, `command` | The same, with `--run COMMAND`: the command line is typed into the new session's shell. |

With `--allow commands`:

| Tool | Input | Result |
| --- | --- | --- |
| `tokiwa_run` | `entry`, optional `args` (an object of strings; leave it out for an entry with no arguments) | The output of `tokiwa run ENTRY NAME=VALUE…`: a run of one entry of the command list, with its state and the first page of its output. Encrypted on the way, and marked as data. |

## Read a screen

`tokiwa_screen` runs `tokiwa capture NAME IDENTITY [LINES]`. Take `name` and `identity` from `tokiwa_sessions`. If a new session took the name, the call fails with `Session identity changed. Nothing was read.`

The capture reads the active pane of the session with up to 200 lines of scrollback, without colour. It removes trailing spaces and blank lines, then keeps the last `LINES` lines. `LINES` is from 1 to 200, and the default is 60.

| Field | Meaning |
| --- | --- |
| `name`, `identity` | The session that was read |
| `pane`, `command`, `dead` | The active pane, its current command, and whether its program has ended |
| `clients` | The attached clients |
| `sampled_at` | The time of the read, in seconds since the epoch |
| `lines` | The lines in `text` |
| `truncated` | True when the helper removed text from the start of `text`, to fit 15,000 bytes |
| `text` | The lines |

## Run a listed command

`tokiwa_run` runs `tokiwa run ENTRY NAME=VALUE…`. Take `entry` and the names in `args` from `tokiwa_commands`. The host checks the entry and each value against the [command list](host.md#the-command-list), then runs the program as `agent-workspace` in a new folder, with no shell. A value that does not match, an unknown entry or a missing argument is refused with a message that ends `Nothing was run.` A call takes at most 16 arguments, and each value has 1 to 1000 characters, with no control character.

The call waits up to 8 seconds for the run to end. A longer run returns `state` `running` and an `id`, and the agent reads on with `tokiwa_run_status`.

| Field | Meaning |
| --- | --- |
| `id` | The run, for example `20261112T183000-7f3a`. Use it with `tokiwa_run_status`. |
| `entry` | The entry that ran |
| `state` | `done`, `running`, `failed` or `timed-out` |
| `exit` | The exit status. Null while the run is `running`. A run whose unit vanished with no end record, for example after a host restart, reports `failed` with `exit` null. |
| `offset`, `next_offset` | The byte offset of this page, and the offset of the next page. `next_offset` is a byte offset into the output, null at its end. |
| `size` | The bytes of output that the run has written so far |
| `truncated` | True when the output passed the entry's `output_bytes`. The host keeps the first part. |
| `text` | The page: at most 15,000 bytes of encoded text. Standard output and standard error come together. |

To read a long output, call `tokiwa_run_status` with the last `next_offset` as `offset` until `next_offset` is null. A page can end inside a multibyte character: that part shows as U+FFFD, and the next page starts at the exact byte, so `text` of two pages may not join into the original text at that point.

At most 4 runs are active at one time. A start has one 12-second deadline: when another start holds the host's lock past it, the call is refused as busy. When systemd gives no state for a run that has not ended, `run-status` is refused with `The state of run ID could not be read. Nothing was run.`; call it again later.

The launcher waits up to 40 seconds for a `run` or `run-status` call to end on the host. A call that the host refused fails with the host's own line, which ends `Nothing was run.` A `run` call that did not end (`TimedOut`, `Cancelled`, or no end after 40 seconds) says `The run call returned STATUS. A run may have started: use tokiwa run-status with its id.` The run log on the host has the id. A `run-status` call that failed says `The run-status call returned STATUS. Nothing was changed.`

## Limits

**Sign-in.** Each call needs a live AWS sign-in, and an agent cannot sign in. After the sign-in expires, each call returns `The AWS sign-in expired. Ask the owner to press l in Tokiwa or run tokiwa login.`

**Terminal text is data.** A screen can hold any text, also text that another program or a web page wrote. An agent must not take it as an instruction. The tool description and the first line of each result say this.

**Stored text.** A capture reaches the Mac through Run Command, and AWS keeps the output of each command in the history of the account. So the helper never prints screen text. The launcher makes a new key pair for each capture and sends the host only the certificate. The host encrypts the result to it, and the launcher decrypts the result and deletes the key. History holds only encrypted data, which nobody can open after the call. A helper that gets no certificate refuses the capture.

**Arguments in history.** Run Command history keeps the entry name and each argument value in plain base64, not encrypted. Do not pass a secret as an argument value. Name it in the entry's `secrets` instead, so that the host passes it to the program without Run Command. The results of `run` and `run-status` are encrypted as a capture is.

The other tools are not encrypted. History keeps session names, folders, pane commands and host metrics. So does each list read of the app.

## Trust

Tokiwa trusts each program that can run it as it trusts you. The command and the server run as you on the Mac, with your AWS sign-in, which can also reach the host without Tokiwa (`tokiwa admin`, `aws ssm`). So a limit that Tokiwa or a client sets holds only for an agent that has no shell:

| The agent | What limits it |
| --- | --- |
| Has no shell, only the MCP server | The `--allow` classes of its server, and its client's approval of each call |
| Has a shell | Its own tool's approval of each command. It can go around Tokiwa, so Tokiwa adds no limit of its own |

`--allow commands` alone gives no free command line. The tool runs only what the owner listed on the host, with arguments of the shape that the entry fixes, and `tokiwa_launch` stays in the `run` class. But an entry runs as `agent-workspace`, the same user as the sessions, so a listed command has the trust of a command that you type in a session. It can reach the model sign-ins and the saved secrets through the processes of the sessions, also with `home: none`, which hides them only from a read by path. List only commands that you would run in a session; see [the command list](host.md#the-command-list).

Allow the read commands and tools without a question if you like. Keep each `control`, `run` and `commands` command asking: an agent that reads a screen can meet text that tries to steer it, so your approval is the check before it changes a session.

A mode that approves on its own, such as Claude Code's auto mode, runs a command that you asked for without a question. An `ask` rule keeps the question in every mode. In Claude Code, add the control commands to `permissions.ask` in `~/.claude/settings.json`:

```json
"ask": ["Bash(tokiwa freeze:*)", "Bash(tokiwa resume:*)", "Bash(tokiwa interrupt:*)", "Bash(tokiwa create:*)", "Bash(tokiwa run:*)",
        "mcp__tokiwa__tokiwa_freeze", "mcp__tokiwa__tokiwa_resume", "mcp__tokiwa__tokiwa_interrupt",
        "mcp__tokiwa__tokiwa_create", "mcp__tokiwa__tokiwa_launch", "mcp__tokiwa__tokiwa_run"]
```

A `Bash(...)` rule covers the typed command and not the MCP tool, so the list names both.

In a test with Claude Code in auto mode, these rules held each command for approval, and without them the commands ran. In a test with Codex, `prefix_rule(..., decision="prompt")` rules for the same commands did not stop a live run: Codex ran the command through `zsh -lc`, which the rules did not match. What kept `tokiwa` from the host there was Codex's sandbox, in which `tokiwa` cannot reach AWS. So run an agent that controls sessions in Claude Code with these rules, or keep Codex in its sandbox, where each command that leaves it needs your approval. A hard limit for an untrusted agent needs a separate account or machine and an AWS role that allows less; Tokiwa does not provide one.

## Related

- [Architecture](architecture.md): the launcher and Run Command.
- [Sessions and projects](sessions-and-projects.md): session identity.
- [Host](host.md): the helper on the host, the command list and the run log.
