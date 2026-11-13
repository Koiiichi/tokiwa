# Design: run owner-approved commands on the host

Date: 2026-11-12. Status: approved by the owner on 2026-11-12.

## Intent

Today, to run a command on the host (a code review script, a test suite, a `git pull`), the owner opens Tokiwa, attaches to a session and types it. A local agent on the Mac that uses only the MCP server can read sessions (`tokiwa_sessions`, `tokiwa_screen`). With `--allow run` it can also type a free command line into a new session (`tokiwa_launch`), but it gets no exit status and no output except screen text. This feature lets such an agent, when the owner allows it, run a command that the owner named ahead of time in a list on the host, with arguments of the shape the list fixes, and get its result.

Success: a local agent runs, for example, "the review script of repository A for pull request 42 at commit `1a2b3c4`", waits or comes back later by an id, and gets the exit status and the output. It never types into a session pane, and it never gets a shell.

## Goals

1. Run a named entry from an allowlist on the host. Never run free shell text.
2. Each entry fixes the program and the shape of each argument. Refuse a value that does not match. Pass the arguments as a list, with no shell.
3. Each call runs as its own process in a new working folder, not in a session pane or a session's working tree.
4. Each entry states the environment that the process gets. By default the process can reach no credential: no variable holds one, and the files that hold them are hidden from it. No result prints a secret value.
5. Return the exit status and the output, with a size limit and a timeout for each entry. A long command runs detached, and a second call reads its state and output by id.
6. Log each call and each run's end on the host: time, caller, entry, arguments, exit status. The owner can read the log; an agent cannot change it.
7. Return output as data, with the same warning line that `tokiwa_screen` gives.

## Non-goals

- A limit on an agent that has a shell on the Mac. Such an agent can already reach the host with the owner's AWS sign-in ([Trust](../../agents.md#trust)). The list limits agents that use only the MCP server and have the new `commands` class.
- A caller inside a session on the host. Session agents already run any command as `agent-workspace`, and they cannot reach the root runner (`NoNewPrivileges=yes` in `cloud-workbench.service`; the metadata firewall leaves them no AWS credentials). The runner has no local way in.
- A check that is independent of the agents on the host. Commands run as `agent-workspace`, the same user as the sessions, so they have the same trust as a command the owner types in a session today. The owner chose this on 2026-11-12, because the entries need the model sign-ins of the workbench home.
- Interactive commands, standard input, or a stream of live output.
- Editing the list from the Mac, from the app, or from any tool.
- Fetching from a remote inside the runner (see Runs).

## Anti-goals

- Any path by which a session, an agent, or an MCP call can add, change or widen an entry.
- Command output, file content or a secret in the AWS Run Command history in readable form.
- A command running inside the tmux server or a session's sandbox state.
- Turning on the allowlist tools turns on a free-text tool too.

## Constraints

- Transport is Run Command (`AWS-RunShellScript`, 30 s execution timeout). The launcher polls about 15 s. A call must answer in that time, so a longer command must run detached.
- Run Command returns at most 24,000 characters of output. A capture stops at 15,000 bytes before encryption (`host/terminal-session.sh` around line 219). Run output uses the same page size.
- Run Command keeps the parameters and the output of each call in the AWS account. Captures already solve this: the launcher makes a one-time key pair, sends the certificate, and the host returns only `openssl smime` encrypted output (`bin/tokiwa` around line 250, `host/terminal-session.sh` around line 206). Run results use the same method. Parameters (entry name and argument values) stay readable in the history, as session names do today.
- The public repository holds the mechanism and neutral examples only. The owner's real entries live on the host.
- The installer's `place()` replaces a file whose content differs (`host/install.sh` around line 37). The list needs a create-only step.
- The capability contract today allows only string and integer arguments and an `argv` as long as its example (`host/tests/test_capabilities.py` around line 44, `app/mcp.ts` around line 18). An `args` object needs a change to that format and its test.

## Approaches

1. **An allowlist tool in the existing host helper path (chosen by the owner).** The launcher sends entry and arguments over Run Command. On the host, a root-owned runner reads a root-owned list, checks the arguments and starts the command as `agent-workspace` in a one-off systemd unit. Output returns encrypted. Reuses the transport, the encryption and the MCP class gate.
2. Type the command into a new tmux session, as `tokiwa_launch` does. Rejected: the command runs in a pane, the output is screen text, and goal 3 fails.
3. A long-running service on the host reached through a port forward. Rejected: an always-on listener and a second way in, to save a few seconds per call.

## Design

```
┌─ Mac ──────────────────────────────────────────────────────────────────┐
│ agent ─MCP─▶ tokiwa mcp --allow commands ─▶ tokiwa run ENTRY … (+cert)  │
└──────────────────────────────────────────────────────────────┬─────────┘
                                        Run Command (as root)  │
┌─ host ───────────────────────────────────────────────────────▼─────────┐
│ /usr/local/sbin/tokiwa-run  (root-owned, runs as root)                  │
│   reads /etc/tokiwa/commands.json  (root:root 0644)                     │
│   checks entry + each argument shape                                    │
│   makes /srv/development/cache/tokiwa-runs/<id>/  (agent-workspace)     │
│   systemd-run --uid=agent-workspace --unit=tokiwa-run-<id>              │
│        --slice=agent-sessions.slice  RuntimeMaxSec=<timeout>            │
│        argv list, env from the entry, private home hidden               │
│        ExecStopPost=+ (root): end line in the log, worktree removed     │
│   appends to /var/log/tokiwa/run.jsonl  (root:root 0644)                │
│   waits up to ~10 s; returns {id, state, exit, page} encrypted         │
└────────────────────────────────────────────────────────────────────────┘
```

### MCP class

A new class, `commands`, holds `tokiwa_run`. The MCP server offers it only with `tokiwa mcp --allow commands`. `tokiwa_launch` stays in `run`, so an agent with `--allow commands` alone cannot type a free command line. `--allow run` does what it does today. `--allow commands,run` gives both. Owner, 2026-11-12. The change touches `parseAllow` in `app/mcp.ts`, the class check of `tokiwa mcp` in `bin/tokiwa`, the `classes` table in `app/capabilities.json`, and `docs/agents.md`.

### The list

`/etc/tokiwa/commands.json`, owned by root, mode 0644. Agents can read it and cannot write it. The owner edits it from a root shell (`tokiwa admin`). The installer creates an empty list (`{"entries": {}}`) only when no file exists, and never replaces it.

One entry, as an example:

```json
{
  "entries": {
    "review-pr": {
      "description": "Run the review script of one repository for a pull request at a commit.",
      "argv": ["{clone}/scripts/review.sh", "--pr", "{pr}", "--commit", "{commit}"],
      "args": {
        "repo":   {"choice": {"repo-a": "/srv/development/state/workspaces/workbench/repo-a"}, "as": "clone"},
        "pr":     {"pattern": "^[1-9][0-9]{0,6}$"},
        "commit": {"pattern": "^[0-9a-f]{7,40}$"}
      },
      "cwd": "fresh",
      "home": "workbench",
      "secrets": [],
      "timeout_seconds": 1800,
      "output_bytes": 200000
    }
  }
}
```

- `argv` is a list. Each `{name}` placeholder is replaced by a checked value; a value is never split or passed to a shell. A placeholder must fill a whole list item or a fixed part of it; the runner refuses a list whose placeholders it cannot match to `args`.
- Argument kinds: `pattern` (an anchored regular expression), `choice` (a fixed map from a public name to a value, so a path is never typed by the caller), `path_below` (a path that, after it is resolved, stays below one fixed root and exists). `as` renames the filled value.
- `cwd`: `fresh` (an empty run folder) or `worktree` (a detached `git worktree` of a `choice` clone at the `commit` argument, made in the run folder before the unit starts and removed when it ends).
- `home`: `none` (default) or `workbench`.
  - `none`: `HOME` is the run folder. The unit hides `/srv/development/private` (the workbench home with the model sign-ins and `~/.tokiwa/secrets.env`, and the peermesh folder) with `InaccessiblePaths`. My call, from goal 4: a test suite at a pull-request commit runs code that nobody reviewed yet, and it must not read the sign-ins by path.
  - `workbench`: the workbench home, with `CLAUDE_CONFIG_DIR` and `CODEX_HOME`, for an entry that needs the model sign-ins. `~/.tokiwa/secrets.env` stays hidden in both modes.
- `secrets`: names from `~/.tokiwa/secrets.env` that the process gets as environment variables. Default none. The root runner reads the file, passes only the named values, and never prints one.
- `PATH` is fixed (`/usr/local/bin:/usr/bin:/bin`), and no other variable from the caller passes.
- The unit's writable paths are its run folder and, for `home: workbench`, the workbench home. Every other path is read-only, as in `cloud-workbench.service` (`ProtectSystem=strict`, `NoNewPrivileges=yes`).
- The list file is checked at each call: a list that fails to parse, or an entry that fails these rules, refuses the call.

### Calls

| Launcher | MCP tool (class) | Result |
| --- | --- | --- |
| `tokiwa commands` | `tokiwa_commands` (read) | Each entry's name, description and argument shapes. No paths behind a `choice`. |
| `tokiwa run ENTRY NAME=VALUE…` | `tokiwa_run` (commands) | `{id, state, exit, offset, next_offset, size, truncated, text}` after at most ~10 s. `state` is `done`, `running`, `failed` or `timed-out`. |
| `tokiwa run-status ID [OFFSET]` | `tokiwa_run_status` (read) | The same fields for a run, with the page of output that starts at `OFFSET` (default 0). |

- `tokiwa_run` takes `entry` and `args` (an object of strings). Its shapes are on the host, so `tokiwa_commands` is how an agent learns them, and the runner is the only place that checks them.
- Output is paged. Each result carries at most 15,000 bytes of `text` from `offset`, and `next_offset` while more exists. An agent reads a long output with repeated `tokiwa_run_status ID OFFSET`. My call, from the Run Command limit.
- `run` and `run-status` results are encrypted on the way as a capture is. Their first line is the data warning of `tokiwa_screen`.
- `tokiwa_run_status` is `read`, because it changes nothing and only an id from a run can name a run.

### Runs

- The id is the time and a random part, for example `20261112T183000-7f3a`. The unit is `tokiwa-run-<id>`.
- Output (stdout and stderr together) goes to `<run folder>/output`. The runner keeps the first `output_bytes` and marks `truncated`.
- `RuntimeMaxSec` enforces the timeout; the result says `timed-out`.
- The unit runs in `agent-sessions.slice`, so the slice limits apply.
- At most 4 runs at a time. A fifth call is refused.
- Run folders older than 14 days are deleted at the start of each call.
- Run folders live on the cache volume, which the hourly backup leaves out, so a worktree or a large output never enters a backup. The named secrets reach the unit through a root-only `EnvironmentFile` in the run's root folder, never through `--setenv`, because `systemctl show` prints a unit's `Environment` to every user. My calls.
- `cwd: worktree` needs the commit in the clone. The runner checks it with `git cat-file -e <commit>^{commit}` and refuses an unknown commit before the run. It never fetches. The owner adds a fetch entry when one is needed (for example `git fetch origin pull/{pr}/head` in one clone). My call: fetching needs network access and Git credentials and can outlast the wait.

### Log

`/var/log/tokiwa/run.jsonl`, written only by root:

- At each call, one line: `at`, `id`, `entry`, `args`, `via`, `actor`, `state`. A refused call is logged with `refused` and its reason.
- When a run ends, its `ExecStopPost=+` hook (root) writes one more line: `at`, `id`, `state`, `exit`. The same hook removes the run's worktree. My call: it puts the exit status in the log for a run that ends after the call returned.
- `via` and `actor` are what the caller says, as in the [audit log](../../host.md#audit-log). The log never holds output. The owner reads it on the host; agents cannot write it.

### Errors

Each refusal names the cause and ends with `Nothing was run.`: unknown entry, missing or extra argument, a value that fails its shape, an unknown commit, too many runs, an invalid list file.

## Decided

- Approach 1. Commands run as `agent-workspace` (owner, 2026-11-12).
- A new MCP class `commands` for `tokiwa_run` (owner, 2026-11-12).
- The list is on the host and only the owner changes it from a root terminal (request).
- The first entries the owner wants, as examples: a review script of a coordination repository for a pull request at a commit; a repository's test suite at a commit; read a file below the workspace root; `git pull` in one fixed clone (request).

## My calls (check these)

- Paged output, 15,000 bytes per page.
- `home: none` hides `/srv/development/private`; `secrets.env` is hidden in every mode.
- No fetch in the runner; an unknown commit is refused.
- A root `ExecStopPost=+` hook writes the end line and removes the worktree.
- `tokiwa_run_status` is in the `read` class.

## Left to the builder

- The exact runner language (Python 3 is on the host, as `workbench-health.py` uses).
- How the launcher passes the arguments and the certificate safely in one `AWS-RunShellScript` parameter.
- The `tokiwa_run` wait time inside the 15 s poll.
- The capability contract change for an `args` object.
- Tests: the argument checks (each kind, placeholder rules, refusals), the environment, hidden paths and secret handling, the two log lines, the paging and truncation, the encryption round trip, the MCP class gate. Host tests need new stand-ins for `systemd-run`; the existing host tests use real `git`.
- The documentation: `docs/agents.md` (tools table, classes, trust), `docs/host.md` (files, the list, the log), `capabilities.json`.
