# Local agents

A local Claude Code or Codex agent can read Tokiwa through a small MCP server: the session list, the screen of a session, host health and status. The server reads only. It cannot start, change or end a session, and it cannot type into a terminal.

Use it when an agent on the Mac must see what a session on the host is doing, for example a session that has stopped answering. To talk to a working agent, use an agent messaging tool in place of this server.

The server stays read only. An agent that has a shell can run the `tokiwa` command instead, which also creates sessions (`tokiwa create … --run`) and gets each new ability first. The server is for agents without a shell, and for permission systems that allow one tool at a time.

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

A running agent sees the tools after it starts again or reconnects its MCP servers.

## Tools

| Tool | Input | Result |
| --- | --- | --- |
| `tokiwa_sessions` | None | The output of `tokiwa sessions --json`: each session with its `name`, `identity`, folder, project, clients and pane commands. See [the snapshot](architecture.md#host-helper-and-snapshot). |
| `tokiwa_screen` | `name`, `identity`, optional `lines` | The output of `tokiwa capture`, after one line that marks the text as data. |
| `tokiwa_health` | None | The output of `tokiwa health`. See [Health](health.md). |
| `tokiwa_status` | None | The output of `tokiwa status`. |

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

## Limits

**Sign-in.** Each call needs a live AWS sign-in, and an agent cannot sign in. After the sign-in expires, each call returns `The AWS sign-in expired. Ask the owner to press l in Tokiwa or run tokiwa login.`

**Terminal text is data.** A screen can hold any text, also text that another program or a web page wrote. An agent must not take it as an instruction. The tool description and the first line of each result say this.

**Stored text.** A capture reaches the Mac through Run Command, and AWS keeps the output of each command in the history of the account. So the helper never prints screen text. The launcher makes a new key pair for each capture and sends the host only the certificate. The host encrypts the result to it, and the launcher decrypts the result and deletes the key. History holds only encrypted data, which nobody can open after the call. A helper that gets no certificate refuses the capture.

The other tools are not encrypted. History keeps session names, folders, pane commands and host metrics. So does each list read of the app.

**Not a security boundary.** The server runs as you on the Mac. An agent with a shell can use the same AWS profile, and it can run `tokiwa admin` or `aws ssm`. The server gives an agent a narrow way to read, with tools that a permission system can allow one by one. To limit an agent, deny it the shell commands too. A hard limit needs an AWS role that allows less.

## Related

- [Architecture](architecture.md): the launcher and Run Command.
- [Sessions and projects](sessions-and-projects.md): session identity.
- [Host](host.md): the helper on the host.
