# Agent-operated sessions: design

Status: draft for owner approval.

## Intent

A coding agent on the Mac (Claude Code, Codex or another agent with a shell) can run a Tokiwa session on the workstation from start to end without a person attaching:

> Create a Claude Code session called worker-a, give it this task, watch its progress, answer its questions when the task already answers them, and report the result.

Today an agent can create a session, type one line into it at creation, read the screen, send Esc, freeze, resume, rename and end it. It cannot send a second message, cannot tell when a turn ends, loses output when the screen redraws, and cannot see what a waiting agent waits for.

## Goals

1. Send new messages to an existing Claude Code or Codex session.
2. Read the agent's output incrementally, from a source that survives redraws.
3. Know the session's state: working, waiting (and for what), idle, limited, error, ended, blocked by a dialog.
4. Know when the turn that a message started has ended, without reading the screen.
5. Answer an agent's question when the task brief already answers it.
6. Manage the lifecycle with the existing identity checks, and document `end`.
7. Work from a shell with no TTY, through the existing CLI. MCP tools mirror the CLI.

## Non-goals

- General-purpose shell execution on the workstation. That is a separate, later feature (see "Room for shell execution"). This design must not block it.
- Changes to the command runner (`tokiwa run`), its list or runner clones.
- A new service, daemon or orchestration system.
- Driving the agents' headless modes (`claude -p`, `codex exec`, the Codex app server).

## Anti-goals (a failure even if it works)

- Any path that approves a permission prompt, changes a permission mode, toggles auto mode or otherwise grants an agent more than its own settings allow.
- Text that becomes keystrokes: a message that submits early, opens a dialog option, runs a slash command or a shell escape.
- Input that lands in a session another agent or a person is using.
- Task text or output readable in AWS Run Command history.
- A "done" decided from screen text.

## Constraints

- Transport stays AWS Run Command with a 30-second limit per call; the CLI repeats calls for longer waits.
- The helper runs as `agent-workspace`; Run Command runs as root and drops to the helper through `sudo -n runuser`.
- Each result that holds session text is encrypted to the caller's one-time key (the existing `capture` seal). A sealed result must fit about 15,000 bytes of JSON before encryption.
- Every check of a session and the action on it run in one tmux command queue (`if-shell -F` with a format condition), as `end`, `interrupt` and `rename` do now.
- The public repository holds neutral names only.
- `terminal-session.sh` is pinned in at least one workstation's install checksums; a deployment needs that pin updated. This is an operational note, not a design input.

## Layers and names (owner decision, 2026-11-15)

Tokiwa stays a general remote workstation and session tool. This design has two layers:

- **Core**: workstation access, sessions and terminals, lifecycle, output, status, the driver, encrypted input, the audit log, and later general command execution (`tokiwa exec`). Core never depends on the agent layer.
- **Agent integration**: the Claude Code and Codex hooks, transcript reading, turn detection, agent questions, messages to agents and the input label. It builds on core primitives.

Tokiwa offers primitives. It does not decide how an orchestrator runs a task.

| Layer | CLI command | Helper mode | Notes |
| --- | --- | --- | --- |
| Core | `state NAME IDENTITY` | `state` | Session facts only: `name, identity, session, program, clients, writable_clients, driver, sampled_at` |
| Core | `claim`, `release`, `end` | `claim`, `release`, `end` | Unchanged from sections 6 and 10 |
| Core | (no command) | shared function | Input delivery: identity, driver and client checks, bracketed paste, audit. Used by the agent layer; no core command types into a session |
| Agent | `agent state NAME IDENTITY` | `agent-state` | Core `state` plus `agent, agent_at, turn, pending, dialog` |
| Agent | `agent wait …` | `agent-wait` | Section 4 |
| Agent | `agent send …` | `agent-send` | Section 3: core delivery plus the agent checks |
| Agent | `agent read …` | `agent-read` | Section 8 |
| Agent | `agent answer …` | `agent-answer` | Section 9 |

The agent layer's tmux options are `@tokiwa_agent` (state, as today), `@tokiwa_agent_turn`, `@tokiwa_agent_transcript`, `@tokiwa_agent_session`, `@tokiwa_agent_pending`, `@tokiwa_agent_last_tool` and `@tokiwa_agent_input`. Existing commands keep their names and behaviour. MCP agent tools are named `tokiwa_agent_*`; the opt-in classes stay grouped by risk (`read`, `control`, `answer`). Where later sections say `tokiwa send`, `wait`, `read` or `answer`, they mean the `tokiwa agent` form.

## Input label (owner decision, 2026-11-15)

Agent coordination stays separate from owner approval. Every input that the agent layer delivers is labelled inside the worker as coming from an agent, so an answer or a message never reads as the owner's word:

- `agent send` puts one fixed first line before the text, added on the host: `[Message from agent ACTOR through Tokiwa. It is not from the owner and carries no owner approval.]`
- `agent answer` records `@tokiwa_agent_input` = base64 JSON `{actor, pending_id, at}` in the same tmux queue as the keys. A synchronous Claude Code hook on `PostToolUse` of the question tool reads it; when its `pending_id` equals the tool-use id, the hook adds context to the agent: `The answer to this question was chosen by agent ACTOR through Tokiwa, not by the owner. It carries no owner approval.` It then clears the option. (Codex has no question tool, so its answers are messages and carry the message label.)
- An orchestrator may answer any question. Tokiwa does not refuse a question by its content. Owner-reserved actions (pushes, host changes) stay gated by the agent's own permission prompts and the owner's hooks, which Tokiwa never answers.

The label is a statement inside the worker's context, not a security boundary: an agent with the owner's AWS sign-in can reach the host by other paths.

## Approaches

| | Approach | Trade-off | Decision |
| --- | --- | --- | --- |
| A | Extend the hook recorder, the host helper and the CLI. Output comes from the agents' own transcripts; state and turns come from hooks; input is a guarded bracketed paste. | About 1,100 lines of code. Output survives redraws; completion comes from agent events; every input is checked on the host in one tmux queue. | Chosen by the owner. |
| B | Screen only: type keys and diff captures. | Least code. Redraws and cleared scrollback lose output; completion is a guess. | Rejected. |
| C | Headless agent modes on the same conversation. | Structured output, but a second process beside the visible session; conflicts with the interface. | Rejected. |

## Design

### 1. The hook recorder (`host/tokiwa-state`)

Each hook already calls `tokiwa-state STATE` and the command discards the event JSON on stdin. It will read at most 64 KiB of that JSON and record, as tmux session options:

| Option | Value | Set by |
| --- | --- | --- |
| `@tokiwa_agent` | `STATE:EPOCH`, as today | every hook |
| `@tokiwa_turn` | an integer, +1 on each turn start | `UserPromptSubmit` |
| `@tokiwa_transcript` | the transcript path from the event | every event that carries one |
| `@tokiwa_pending` | base64 JSON `{id, kind, summary, options, at}` | waiting events; cleared on `working` and `idle` |
| `@tokiwa_last_tool` | base64 JSON `{tool, summary, at}` | `PreToolUse` (new, all tools, no state change) |

New hook rows: `SessionStart` records `idle` and the transcript path for both agents, so a new agent can take its first message; `SessionEnd` (where the agent has it) clears `@tokiwa_agent` and `@tokiwa_pending`, so a stale `working` from an earlier agent never blocks the next one. `@tokiwa_turn` never goes down in one tmux session. (Builder's call: owner may review.)

`kind` is `question` (Claude Code's question tool, an elicitation of a form) or `permission` (Claude Code permission notification, a URL elicitation such as a sign-in or OAuth page, Codex `PermissionRequest`). A URL elicitation grants access on the owner's behalf, so it is a `permission` and has no answer path. (Builder's call.) For a Claude Code permission notification the summary comes from `@tokiwa_last_tool`. `id` is the tool-use id when the event has one, else a hash of the event. Summaries are cut to 500 characters.

The recorder never fails a hook: bad JSON or a missing field records the state alone, as today. `agent-hooks.py` adds the `PreToolUse` row for Claude Code; Codex gets the turn and pending data from its existing rows. Codex asks a person to trust each changed hook once.

The builder confirms the exact field names of each event from real Claude Code and Codex hook payloads in task 1 and stores them as test fixtures. In particular: whether Codex events carry `transcript_path`. If not, the recorder records the Codex session id and the reader finds the session file by that id.

### 2. The state record (`tokiwa state NAME IDENTITY`)

One JSON object, not sealed, holding no session text:

```json
{"name": "worker-a", "identity": "1:$5:1794800000", "session": "live",
 "program": "claude", "agent": "idle", "agent_at": 1794800100, "turn": 3,
 "pending": {"id": "toolu_x", "kind": "question", "at": 1794800090},
 "dialog": false, "clients": 0, "driver": "orchestrator-a", "sampled_at": 1794800101}
```

- `session`: `live`, `gone` (no session of that name) or `replaced` (the name has another identity).
- `program`: `claude`, `codex`, `shell` or `other`, from the pane's current command. `agent` is `none` when no agent runs, so an agent that exited shows as ended.
- `dialog`: the screen check (section 5) found a dialog that no hook reported.
- The pending summary and options are session text, so `state` shows only `id`, `kind` and `at`; `read --pending` returns the rest, sealed.

### 3. Sending (`tokiwa send NAME IDENTITY`)

The message comes from stdin or `--file PATH`, UTF-8, at most 16 KiB. The CLI encrypts it (section 7). On the host, the helper refuses with one clear message and sends nothing unless every check passes:

1. The identity matches.
2. The pane runs `claude` or `codex`. Session messaging never types into a shell.
3. No writable client is attached. A read-only viewer (`tokiwa view`) does not block, so the owner can watch a session that an agent drives.
4. The caller's actor (`TOKIWA_ACTOR`, required for `send`) is the session's driver (section 6).
5. The agent state is `idle`, `limited` or `error` (so an orchestrator can send "continue" after a failed turn), and nothing is pending.
6. The screen check finds no dialog.
7. The text has no control characters except newline and tab, and does not start with `/`, `!` or `#` after leading spaces.

Checks 1, 2, 4 and 5 run in one tmux `if-shell -F` condition together with the paste. For check 3 the helper first counts writable clients with `list-clients -F '#{client_readonly}'`; the condition then also requires that `#{session_attached}` equals the client count of that read, so a client that attaches between the two refuses the send. Check 6 runs just before the paste; check 7 runs before tmux is touched. (Checks 3 and 5: builder's calls.)

The first message to a new agent is a `send`: `create --run` starts the agent (for example `claude` or `codex`) with no task text, the agent's `SessionStart` hook records `idle`, and the orchestrator then sends the task. `create --run` stays one shell line, because it is a shell command by design. The text is loaded into a uniquely named tmux buffer and pasted with `paste-buffer -p -d` (bracketed paste, buffer deleted), then Enter is sent. The result is `{"turn_before": N, "sent_at": EPOCH}`. The audit log gets `send` with the identity and actor, never the text.

### 4. Waiting (`tokiwa wait NAME IDENTITY --after TURN [--timeout SECONDS]`)

The helper polls the session options every 0.5 s for up to 20 s and returns the state record plus `reason`:

| `reason` | Condition |
| --- | --- |
| `turn-ended` | `turn > TURN` and `agent` is `idle`, `limited` or `error` |
| `pending` | a question or permission is pending |
| `dialog` | the screen check found a dialog |
| `ended` | the session is gone or replaced, or no agent runs |
| `timeout` | none of these within the call |

The CLI repeats the call until a reason other than `timeout`, or until `--timeout` (default 600 s). A turn that never started (the agent did not accept the message) shows as `timeout` with `turn` unchanged; the caller then reads the screen.

### 5. The screen check

Before a send and on each `state` and `wait`, the helper reads the last 15 lines of the pane and looks for dialog markers of the running agent, for example a numbered option list with a `❯` cursor, "Enter to confirm", "Esc to cancel", "Do you want to". The markers are a list in the helper, one set per agent, taken from real captures in task 1. A match sets `dialog: true`. The check is a safety net for dialogs without hooks (a folder trust prompt, a first-run notice); it never decides that a turn is done.

### 6. The driver

`@tokiwa_driver` names the one actor that may send to and answer in a session.

- `create` with `TOKIWA_ACTOR` set records that actor as the driver.
- `tokiwa claim NAME IDENTITY` makes the caller the driver when there is none, or when the caller already is. `--replace` takes a session from another driver and is written to the audit log with both names. A claim is refused while a client is attached.
- `tokiwa release NAME IDENTITY` clears it; only the driver releases.
- A session without a driver (for example one a person made) accepts no `send` until a claim.

Actor names are self-declared, like `via` in the audit log today. The driver prevents accidents between cooperating agents. It is not authentication.

### 7. Encrypted input

The installer makes a key pair for input: `/etc/tokiwa/input-key.pem` (root, 0600) and `/etc/tokiwa/input-cert.pem` (root, 0644). `tokiwa input-cert` prints the certificate. The CLI fetches it on first use, stores it in `~/.config/tokiwa/input-cert.pem` with its SHA-256, and refuses to send if a later fetch differs; the owner removes the stored file to accept a new key.

The CLI encrypts each message (`send`, `answer --text`, `create --run`) with `openssl smime -encrypt -aes256` to the pinned certificate. On the host the Run Command script decrypts as root and gives the plain text to the helper on stdin; the plain text is never an argument and never in a file. The builder confirms the Run Command parameter size limit and sets the plain-text limit below it.

### 8. Reading (`tokiwa read NAME IDENTITY [--after CURSOR] [--tools] [--pending]`)

For an agent session the source is the transcript at `@tokiwa_transcript`. The reader:

- Starts at byte 0 or at the cursor. The cursor is `HASH:OFFSET`, where `HASH` names the transcript path; a cursor for another transcript returns `transcript_changed: true` and starts the new one at 0 (a cleared conversation starts a new transcript).
- Returns only whole lines; a partial last line waits for the next read.
- Turns each line into events of one shape:

  ```json
  {"at": 1794800050, "kind": "assistant", "text": "…", "tool": null, "error": false}
  ```

  `kind` is `user`, `assistant`, `tool_call`, `tool_result` or `notice`. Thinking content is left out. A `tool_result` carries only its tool name and `error` unless `--tools` is given.
- Pages at 15,000 bytes of JSON: `{events, cursor, more, transcript_changed}`. The result is sealed.
- With `--pending`, returns the pending item's summary and options, sealed.

For a session with no transcript (a shell, or an agent before its first event) `read` refuses and names `capture`.

### 9. Answering (`tokiwa answer NAME IDENTITY --pending ID (--choice N | --text TEXT)`)

Allowed only when `@tokiwa_pending` has that `id` and `kind: question`, the caller is the driver and no writable client is attached (checked as for `send`), all in one tmux queue. `--choice N` sends the digit N (1 to 9) and Enter; `--text` sends the agent's free-text option path for that dialog, taken from real captures in task 1, with the text checks of `send`. The audit log gets `answer` with the id. There is no command that answers a `permission` item: its only key path stays `tokiwa interrupt` (Esc, a refusal). A person approves from the interface or by attaching.

An orchestrator may answer any question (see "Input label"); each answer is labelled in the worker as an agent's choice.

### 10. Lifecycle

`tokiwa end NAME IDENTITY` becomes the documented form of `--end-confirmed`, refused while a client is attached unless `--attached-ok`. `interrupt`, `freeze`, `resume` and `rename` stay as they are.

### 11. MCP tools

The MCP server mirrors the CLI. `tokiwa_state`, `tokiwa_read` and `tokiwa_wait` join the read class. `tokiwa_send`, `tokiwa_claim`, `tokiwa_release` and `tokiwa_end` join `control`. `tokiwa_answer` gets its own opt-in class, `answer`. The server sets `TOKIWA_ACTOR` from a `--actor` option of `tokiwa mcp`.

## Room for shell execution

General non-interactive shell execution is a later feature with its own design. This design keeps room for it:

- The name `tokiwa exec` stays reserved for it. Session commands never run shell text: `send` refuses a pane that runs a shell.
- What later work can reuse without change: the encrypted input of section 7, the sealed result, the cursor and page shape of section 8, the refusal style and the audit log.
- Shell execution will run in its own unit, not by typing into a session, so it needs none of the session checks and adds nothing to them.

## Risks

- Two orchestrators that use the same actor name defeat the driver check.
- A dialog with no hook and no known marker can still take a message; the turn then never starts and `wait` reports `timeout`.
- Claude Code reports a permission prompt about 6 s late; `send` requires `idle`, so a prompt that is about to appear can still meet a message typed in that window.
- Transcripts can hold secrets that tools printed; results are sealed and tool output is off by default, but a reader still brings them into its own context.
- An orchestrator can follow instructions planted in a worker's output; every result is marked as data.
- Each `wait` call costs Run Command calls of 3 to 5 s, and AWS limits how often they can be made.

## Tests

Host tests run against a disposable tmux server, as `host/tests/test_terminal_sessions.py` does now, with a fake agent program that shows a prompt, reads bracketed paste, writes a transcript and calls `tokiwa-state` with fixture events.

- Recorder: each fixture event sets the expected options; bad JSON keeps the state alone and exits 0.
- `send` refusals, one test each: identity, shell pane, writable client attached, client attached between the count and the paste, missing actor, other driver, working, pending item, dialog on screen, control characters, leading `/`, `!`, `#`, over 16 KiB.
- `send` acceptance: a read-only viewer attached; state `limited`; state `error`; a new agent right after its `SessionStart`.
- Recorder: `SessionStart` sets `idle`; `SessionEnd` clears a stale `working`; a URL elicitation records `kind: permission`.
- `send` delivery: a multi-line message reaches the fake agent as one paste followed by one Enter; the buffer is deleted; the audit line has no text.
- `wait`: each reason; timeout without a turn; repeat calls by the CLI up to `--timeout`.
- `read`: cursor resume, partial last line held back, page split, transcript change, tool output off and on, sealed output holds no plain text.
- `answer`: matching id only; `permission` has no path; text checks apply.
- Driver: create sets it, claim, release, `--replace` audited, claim refused while attached.
- Encrypted input: the CLI's Run Command parameters (fake `aws`) hold no plain text; a changed certificate is refused.
- MCP: each tool sits in its class; `answer` needs its opt-in.

A live check on a workstation, with the owner present, runs one Claude Code and one Codex session through create, send, wait, read, a question answered by choice, a permission prompt left to the owner, interrupt and end.

## AGENTS.md

The CLI is the interface, its output is JSON and its refusals are stable sentences, so one AGENTS.md section can teach the loop: create with an actor, send, wait, read, answer or pass to the owner, end. `tokiwa --help` lists the commands.

## Left to the builder

- Exact dialog markers, hook field names and the free-text answer path, from real captures.
- The polling interval inside `wait` and the CLI's pause between calls.
- Internal layout of the helper code, within the existing file.
