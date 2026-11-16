# Agent-Operated Sessions Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an agent on the Mac drive a Claude Code or Codex session on the workstation through the `tokiwa` CLI: state, send, wait, read, answer, claim/release and end, with no TTY and no path that approves a permission prompt.

**Architecture:** The hook recorder (`host/tokiwa-state`) records turn, transcript, pending item and last tool as tmux session options. The host helper (`host/terminal-session.sh`) gets new modes; every check of a session and its action run in one tmux `if-shell -F` queue. The launcher (`bin/tokiwa`) gets the commands, encrypts message text to a host key, and seals results that hold session text. The MCP server mirrors the commands from `app/capabilities.json`.

**Tech Stack:** Bash, Python 3 (standard library only), tmux 3.4+, OpenSSL (`smime`), Bun/TypeScript for the MCP server, `unittest` and `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-15-agent-session-control-design.md`

## Global Constraints

- Session name pattern `^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$`; identity pattern `^[0-9]+:\$[0-9]+:[0-9]+$`; identity value `#{pid}:#{session_id}:#{session_created}`.
- Actor pattern `^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$`, from `TOKIWA_ACTOR`. `send`, `answer`, `claim` and `release` refuse without a valid actor.
- Every check of a session and the action on it run in one `tm if-shell -F -t "=$name:" CONDITION ACTION "display-message -p 'REFUSAL'"` call, as `end` does now (`host/terminal-session.sh:410-418`). A refusal prints one sentence that ends with `Nothing was sent.`, `Nothing was read.` or `Nothing was changed.` and exits 1.
- Message text: UTF-8, at most `MAX_MESSAGE_BYTES = 16384` bytes (lower it in Task 4 if the Run Command limit requires), no control character except `\n` and `\t`, and, after leading spaces, no first character in `/`, `!`, `#`.
- Sealed results use the existing capture seal (`openssl smime -encrypt -aes256 -binary -outform DER` to the caller's one-time certificate) and fit `LIMIT_BYTES = 15000` bytes of JSON before sealing.
- Message text reaches the host only encrypted to `/etc/tokiwa/input-cert.pem`, is decrypted by root, and reaches the helper only on stdin. It is never an argument, a file, a log line or Run Command output.
- No code path sends a key to a `permission` item other than `tokiwa interrupt` (Esc). No code sends Shift+Tab or changes a permission mode.
- `send` works only when the pane's current command is `claude` or `codex`. Session commands never run shell text. The name `exec` stays unused.
- Each task that adds a launcher command adds its `--help` line and its row in `app/capabilities.json` in the same task (`test_capabilities.py` compares them). MCP `tool` entries come in Task 8.
- New audit actions: `send`, `answer`, `claim`, `release`. Audit lines never hold message text.
- Public repository: neutral names only (`worker-a`, `orchestrator-a`, `project-a`). No company, person, profile, domain or path from a real machine in code, tests, fixtures, docs or commit messages. Fixtures are synthetic: copy the shape of real transcripts and hook events, never their content.
- Commits: explicit `git add` of named files, one-line messages, no `Co-Authored-By` and no "Generated with" line.
- Tests: `python3.12 -m unittest discover -s host/tests` and `cd app && ./node_modules/bun/bin/bun.exe test` (Bun is not on PATH). Both pass at the end of each task.

## Review Focus

1. **Two sends in quick succession** by the same driver: the hook marks `working` only later. Expected: the second is refused. `send` sets `@tokiwa_agent` to `working:EPOCH` in the same tmux queue as the paste (Task 5 test `test_second_send_before_the_hook_is_refused`).
2. **Non-ASCII and long multi-line text**: it must arrive as one bracketed paste, byte for byte (Task 5 test `test_unicode_multiline_message_arrives_as_one_paste`).
3. **Transcript cleared or truncated** (offset beyond the file size, or a new path): expected `transcript_changed: true` and a read from 0 (Task 6 tests `test_cursor_past_the_end_restarts` and `test_new_transcript_path_restarts`).
4. **The agent exits to the shell between two calls**: `send` refuses as a shell pane and `wait` returns `ended` (Task 2 test `test_wait_reports_ended_when_the_agent_exits`, Task 5 test `test_send_refuses_a_shell_pane`).
5. **Rename while driven**: the identity stays, the name changes. Calls with the old name fail with `gone`; calls with the new name and the same identity work (Task 2 test `test_state_after_rename`).

---

### Task 1: The hook recorder

**Files:**
- Modify: `host/tokiwa-state` (rewrite as a Python 3 script, same path and command name)
- Modify: `host/agent-hooks.py:10-36` (hook tables)
- Create: `host/tests/test_tokiwa_state.py`
- Create: `host/tests/fixtures/hooks/` (synthetic event JSON, one file per event)
- Modify: `host/tests/test_agent_hooks.py`
- Modify: `docs/host.md` (section "Agent state")

**Interfaces:**
- Produces: command `tokiwa-state STATE [--turn] [--kind question|permission]`, STATE in `working|waiting|idle|limited|error|ended|note`. Always exits 0.
- Produces tmux session options: `@tokiwa_agent` = `STATE:EPOCH` (unset by `ended`; unchanged by `note`), `@tokiwa_turn` = integer, `@tokiwa_transcript` = path, `@tokiwa_agent_session` = the agent's session id, `@tokiwa_pending` = base64 of JSON `{"id","kind","summary","options","at"}` (unset by `working`, `idle`, `ended`), `@tokiwa_last_tool` = base64 of JSON `{"tool","summary","at"}`.

- [ ] **Step 1: Find the event shapes.** Read the official hook documentation of Claude Code and of Codex. Record, for each event in the tables below, the field names of the session id, the transcript path, the tool-use id, the tool name and input, the question text and options of Claude Code's question tool, the notification message, the elicitation mode or URL, and the Codex permission request. Write one synthetic fixture per event into `host/tests/fixtures/hooks/` with those field names and neutral values. If Codex has no `SessionStart`, `SessionEnd` or `PreToolUse` event, leave that row out and say so in the report.

- [ ] **Step 2: Write the failing tests** in `host/tests/test_tokiwa_state.py`, against a disposable tmux server (copy the `Server` class pattern of `test_terminal_sessions.py`), running `host/tokiwa-state` with `TMUX` and `TMUX_PANE` set to a pane of a test session and a fixture on stdin:
  - `test_turn_increments_on_turn_start`: two runs of `working --turn` → `@tokiwa_turn` is `2`.
  - `test_working_without_turn_keeps_the_turn`: `working` → turn unchanged.
  - `test_transcript_and_session_id_are_recorded`: any fixture → `@tokiwa_transcript` and `@tokiwa_agent_session` equal the fixture values.
  - `test_question_tool_records_a_question`: question fixture with `waiting --kind question` → pending `kind == 'question'`, `id` equals the tool-use id, `options` lists the option labels, `summary` holds the question text cut to 500 characters.
  - `test_permission_notification_uses_the_last_tool`: `note` with a Bash PreToolUse fixture, then `waiting --kind permission` with a notification fixture → pending `summary` names the tool and its command.
  - `test_url_elicitation_is_a_permission`: elicitation fixture with a URL and `waiting --kind question` → pending `kind == 'permission'`.
  - `test_working_and_idle_clear_the_pending_item`.
  - `test_session_start_records_idle`: `idle` → `@tokiwa_agent` starts with `idle:`.
  - `test_ended_clears_agent_and_pending`.
  - `test_note_changes_no_state`.
  - `test_bad_json_records_the_state_and_exits_0`; `test_unknown_state_exits_0_and_changes_nothing`; `test_outside_tmux_exits_0`; `test_more_than_64_kib_of_input_is_read_and_ignored` (the process does not block and exits 0).
  - Keep the existing behaviour: a repeated state keeps its first time.

- [ ] **Step 3: Run** `python3.12 -m unittest host.tests.test_tokiwa_state -v` (from the repo root, or `discover -s host/tests -p test_tokiwa_state.py`). Expected: FAIL.

- [ ] **Step 4: Implement `host/tokiwa-state`** as `#!/usr/bin/python3 -I`. It reads at most 65,536 bytes of stdin, then drains the rest; parses JSON when it can; calls `tmux -N` against `TMUX_PANE` with a 2-second timeout; and catches every exception, so it exits 0 in every case. `--kind question` becomes `permission` when the payload marks a URL elicitation. A pending `id` is the tool-use id, else the first 16 hex characters of the SHA-256 of the raw input.

- [ ] **Step 5: Update the hook tables** in `host/agent-hooks.py`:

  | Agent | Event (matcher) | Command arguments |
  | --- | --- | --- |
  | Claude Code | `UserPromptSubmit` | `working --turn` |
  | Claude Code | `PreToolUse` (none) | `note` |
  | Claude Code | `PreToolUse` (`AskUserQuestion`) | `waiting --kind question` |
  | Claude Code | `Notification` (`permission_prompt\|elicitation_url_dialog`) | `waiting --kind permission` |
  | Claude Code | `Notification` (`elicitation_dialog`) | `waiting --kind question` |
  | Claude Code | `Elicitation` | `waiting --kind question` |
  | Claude Code | `SessionStart` | `idle` |
  | Claude Code | `SessionEnd` | `ended` |
  | Codex | `UserPromptSubmit` | `working --turn` |
  | Codex | `PermissionRequest` | `waiting --kind permission` |
  | Codex | `SessionStart`, `SessionEnd`, `PreToolUse` | `idle`, `ended`, `note` (only the events Codex has) |

  All other rows stay. Update `test_agent_hooks.py` for the new rows; the existing tests for order, trust and removal still pass.

- [ ] **Step 6: Run** the host suite. Expected: PASS.

- [ ] **Step 7: Update `docs/host.md` "Agent state"** with the new table and options, then commit: `git add host/tokiwa-state host/agent-hooks.py host/tests/test_tokiwa_state.py host/tests/fixtures/hooks host/tests/test_agent_hooks.py docs/host.md` and `git commit -m "Record turns, transcripts and pending items from agent hooks"`.

---

### Task 2: State, wait and the screen check

**Files:**
- Modify: `host/terminal-session.sh` (argument checks at lines 45-56 and 119-121; new modes `state`, `wait`)
- Modify: `bin/tokiwa` (commands `state`, `wait`, `end`; remote call list at line 276)
- Modify: `app/capabilities.json`, `host/tests/test_terminal_sessions.py`, `host/tests/test_terminal_cli.py`, `docs/agents.md`, `docs/host.md`

**Interfaces:**
- Consumes: Task 1 options.
- Produces helper modes: `state NAME IDENTITY` and `wait NAME IDENTITY AFTER_TURN`. Both print one JSON object (not sealed) with the keys `name, identity, session, program, agent, agent_at, turn, pending, dialog, clients, writable_clients, driver, sampled_at`; `pending` is `null` or `{"id","kind","at"}`; `wait` adds `reason` in `turn-ended|pending|dialog|ended|timeout`.
- Produces helper function `screen_dialog(pane_id, program) -> bool` (Python, inside the helper), used again in Task 5.
- Produces launcher commands: `state NAME IDENTITY`, `wait NAME IDENTITY --after TURN [--timeout SECONDS]` (default 600, 1 to 3600), `end NAME IDENTITY [--attached-ok]`.

- [ ] **Step 1: Write the failing helper tests** in `test_terminal_sessions.py`. Make a fake agent: a session whose pane runs a copy of `/bin/cat` named `claude` (copied into the temp dir and put first on the session's `PATH`), and set options with `tm set-option`.
  - `test_state_of_an_idle_agent`: `@tokiwa_agent=idle:100`, `@tokiwa_turn=3` → `session=live`, `program=claude`, `agent=idle`, `turn=3`, `pending=None`, `dialog=False`.
  - `test_state_of_a_shell`: `program=shell`, `agent=none`.
  - `test_state_of_a_missing_session_is_gone` and `test_state_of_a_replaced_session` (same name, new identity → `replaced`).
  - `test_state_after_rename`: rename keeps the identity; the old name gives `gone`, the new name gives `live`.
  - `test_state_shows_the_pending_id_but_not_its_text`.
  - `test_state_reports_a_dialog`: the fake agent prints `Enter to confirm · Esc to cancel` → `dialog=True`.
  - `test_writable_and_read_only_clients_are_counted` (attach one client with `attach -r` in a pty as the existing view test does).
  - `test_wait_returns_turn_ended`: `AFTER_TURN=3`, then set turn 4 and `idle` from a thread after 0.5 s → `reason=turn-ended`.
  - `test_wait_returns_pending`, `test_wait_returns_dialog`, `test_wait_reports_ended_when_the_agent_exits`, `test_wait_times_out` (with `TOKIWA_WAIT_SECONDS=1`).
  - `test_wait_on_limited_and_error_is_turn_ended`.

- [ ] **Step 2: Run** `python3.12 -m unittest discover -s host/tests -p test_terminal_sessions.py`. Expected: FAIL.

- [ ] **Step 3: Implement** the modes in the helper. `program` is `claude` or `codex` when the active pane's current command is one of them, `shell` for `bash|sh|zsh|fish`, else `other`. `agent` is `none` unless the program is an agent. `wait` polls every 0.5 s up to `TOKIWA_WAIT_SECONDS` (default 20). The screen check reads the last 15 lines of the active pane with `capture-pane -p -J` and matches `DIALOG_MARKERS`, a dict from program to a list of regular expressions. Start with: `Enter to confirm`, `Esc to cancel`, `^\s*❯\s*\d+\.\s`, `Do you want to` for `claude`; `Press enter to confirm`, `^\s*›\s*\d+\.\s`, `Allow command\?` for `codex`. Task 9 checks them against live screens.

- [ ] **Step 4: Write the failing launcher tests** in `test_terminal_cli.py`, with the fake `aws`:
  - `test_state_calls_the_helper_state_mode`; `test_state_refuses_a_bad_identity`.
  - `test_wait_repeats_until_a_reason` (the fake returns `timeout` twice, then `turn-ended`; the launcher prints the last object and exits 0).
  - `test_wait_stops_at_its_timeout` (exits 3 with the last object, `--timeout 1`).
  - `test_end_is_the_documented_form_of_end_confirmed`; `test_end_refuses_an_attached_session_without_attached_ok` (the fake state reports `writable_clients: 1`).

- [ ] **Step 5: Implement** the launcher commands. `end` first runs `state` and refuses with `A client is attached. Nothing was changed. Use --attached-ok to end it anyway.` when `writable_clients > 0` and no `--attached-ok`. `--end-confirmed` keeps working, without that check. Add the `--help` lines and capability rows for `state`, `wait` and `end` (class `read`, `read` and `control`; no `tool` yet).

- [ ] **Step 6: Run** both suites. Expected: PASS.

- [ ] **Step 7: Document** `state`, `wait` and `end` in `docs/agents.md` and the helper modes in `docs/host.md`. Commit with `git commit -m "Add session state, wait and a documented end"`.

---

### Task 3: The driver

**Files:**
- Modify: `host/terminal-session.sh` (modes `claim`, `release`; `create` records the driver)
- Modify: `bin/tokiwa`, `app/capabilities.json`, `host/tests/test_terminal_sessions.py`, `host/tests/test_terminal_cli.py`, `docs/agents.md`

**Interfaces:**
- Produces option `@tokiwa_driver` = actor. Helper modes `claim NAME IDENTITY [replace]` and `release NAME IDENTITY`. Launcher commands `claim NAME IDENTITY [--replace]` and `release NAME IDENTITY`.
- Produces helper function `writable_clients(name) -> int` (count of clients of the session with `#{client_readonly} == 0`), used in Tasks 5 and 7.

- [ ] **Step 1: Write the failing tests:**
  - `test_create_with_an_actor_records_the_driver`; `test_create_without_an_actor_records_none`.
  - `test_claim_without_a_driver`; `test_claim_by_the_driver_again_succeeds`; `test_claim_of_another_drivers_session_is_refused`; `test_claim_replace_takes_it_and_audits_both_names`; `test_claim_is_refused_while_a_writable_client_is_attached`; `test_claim_with_a_read_only_viewer_succeeds`; `test_claim_refuses_a_replaced_identity`; `test_claim_without_an_actor_is_refused`.
  - `test_release_by_the_driver`; `test_release_by_another_actor_is_refused`.
  - Launcher: `test_claim_passes_the_actor_to_the_helper` (the helper command line holds `TOKIWA_ACTOR=`), `test_claim_without_tokiwa_actor_is_refused_on_the_mac`.

- [ ] **Step 2: Run** them. Expected: FAIL.

- [ ] **Step 3: Implement.** The claim condition is one format: identity matches, `#{session_attached}` equals the client count that `writable_clients` saw plus the read-only count (so a client that attaches in between refuses the claim), and `@tokiwa_driver` is empty or the caller (or `replace`). The audit line of `claim --replace` has `replaced` with the earlier driver.

- [ ] **Step 4: Run** both suites. Expected: PASS. Add help lines and capability rows (class `control`). Commit with `git commit -m "Add a driver to each session"`.

---

### Task 4: Encrypted input

**Files:**
- Create: `host/tokiwa-input.py` (installed root 0644 at `/opt/agent-platform/rootless/tokiwa-input.py`)
- Modify: `host/install.sh` (key pair; place `tokiwa-input.py`)
- Modify: `bin/tokiwa` (certificate pin; `seal_input`; `create --run` uses it)
- Modify: `host/terminal-session.sh` (`create` reads the run line from stdin when the request says `run_stdin`)
- Create: `host/tests/test_tokiwa_input.py`
- Modify: `host/tests/test_install_host.py`, `host/tests/test_terminal_cli.py`, `host/tests/test_terminal_sessions.py`, `docs/host.md`, `docs/configuration.md`

**Interfaces:**
- Produces `python3 -I tokiwa-input.py SEALED_B64` → the plain text on stdout, exit 0; exit 1 with `The message could not be decrypted with the host input key. Nothing was sent.` Key path `/etc/tokiwa/input-key.pem`, overridable by `TOKIWA_INPUT_KEY` for tests. It refuses plain text over `MAX_MESSAGE_BYTES`.
- Produces launcher function `seal_input TEXT_FILE` → base64 DER on stdout, and the remote pattern `set -o pipefail; python3 -I /opt/agent-platform/rootless/tokiwa-input.py SEALED | $helper MODE ARGS…`, used by Tasks 5 and 7.
- Produces a hidden launcher command `input-cert` (prints the host certificate; capability row with `"hidden": true`).
- Produces the pin `~/.config/tokiwa/input-cert.pem`, written on first use. A decrypt refusal from the host makes the launcher print `The host input key changed or is missing. Check the host, then delete ~/.config/tokiwa/input-cert.pem to pin the new key.`

- [ ] **Step 1: Find the limit.** Read the AWS documentation for the size limit of `send-command` parameters for `AWS-RunShellScript`. Set `MAX_MESSAGE_BYTES` so that the sealed, base64 message plus the rest of the command stays under it with 20% margin; keep 16384 if it fits. Record the source URL in the report.

- [ ] **Step 2: Write the failing tests:**
  - `test_tokiwa_input.py`: `test_round_trip` (encrypt with a test certificate, decrypt with `TOKIWA_INPUT_KEY`); `test_wrong_key_is_refused_with_the_sentence`; `test_bad_base64_is_refused`; `test_text_over_the_limit_is_refused`; `test_plain_text_never_in_stderr`.
  - `test_install_host.py`: `test_installer_makes_the_input_key_once` (dry run prints the `openssl req` step with `-days 3650` and modes 0600 for the key and 0644 for the certificate; a second run with both files present prints no key step); `test_installer_places_tokiwa_input`.
  - `test_terminal_cli.py`: `test_first_use_pins_the_host_certificate`; `test_create_run_text_is_not_in_the_run_command_parameters` (the fake `aws` records the parameters; the run text, and its base64, do not appear); `test_decrypt_refusal_prints_the_pin_advice`.
  - `test_terminal_sessions.py`: `test_create_reads_the_run_line_from_stdin`.

- [ ] **Step 3: Run** them. Expected: FAIL.

- [ ] **Step 4: Implement.** The installer step: if `/etc/tokiwa/input-key.pem` is absent, `openssl req -x509 -newkey rsa:3072 -nodes -keyout /etc/tokiwa/input-key.pem -out /etc/tokiwa/input-cert.pem -subj /CN=tokiwa-input -days 3650`, then `chmod 0600` the key and `0644` the certificate. `create --run` sends `{"run_stdin": true}` in its request and the sealed line through the remote pattern; the helper applies the existing one-line checks to the line it reads.

- [ ] **Step 5: Run** both suites. Expected: PASS. Document the key in `docs/host.md` (files table) and the pin in `docs/configuration.md`. Commit with `git commit -m "Encrypt message text to a host key"`.

---

### Task 5: Send

**Files:**
- Modify: `host/terminal-session.sh` (mode `send`), `bin/tokiwa` (command `send`), `app/capabilities.json`, `host/tests/test_terminal_sessions.py`, `host/tests/test_terminal_cli.py`, `docs/agents.md`

**Interfaces:**
- Consumes: `screen_dialog` (Task 2), `writable_clients` (Task 3), the remote pattern (Task 4).
- Produces helper mode `send NAME IDENTITY` (text on stdin) → `{"turn_before": N, "sent_at": EPOCH}`. Launcher command `send NAME IDENTITY (--text TEXT | --file PATH | -)`.

- [ ] **Step 1: Write the failing helper tests.** The fake agent for these tests is a small Python program named `claude` that turns on bracketed paste (`\e[?2004h`), reads raw input, and appends each paste (the bytes between `\e[200~` and `\e[201~`) and each Enter to a log file.
  - Refusals, each asserting exit 1, the sentence, and an empty agent log: `test_send_refuses_a_replaced_identity`, `test_send_refuses_a_shell_pane`, `test_send_refuses_a_writable_client`, `test_send_refuses_a_client_that_attaches_between_count_and_paste` (wrap `tmux` so that it attaches a client right after the count), `test_send_refuses_without_an_actor`, `test_send_refuses_another_driver`, `test_send_refuses_while_working`, `test_send_refuses_with_a_pending_item`, `test_send_refuses_a_dialog_on_screen`, `test_send_refuses_control_characters`, `test_send_refuses_a_leading_slash_bang_or_hash` (with leading spaces too), `test_send_refuses_text_over_the_limit`, `test_send_refuses_empty_text`.
  - Acceptance: `test_send_to_an_idle_agent` (log: one paste equal to the text, then one Enter; reply `turn_before` equals `@tokiwa_turn`); `test_send_with_a_read_only_viewer`; `test_send_when_limited`; `test_send_when_error`; `test_unicode_multiline_message_arrives_as_one_paste`; `test_the_paste_buffer_is_deleted` (`list-buffers` is empty afterwards); `test_send_sets_working_in_the_same_queue`; `test_second_send_before_the_hook_is_refused`; `test_send_writes_an_audit_line_without_the_text`.

- [ ] **Step 2: Run** them. Expected: FAIL.

- [ ] **Step 3: Implement.** Order: text checks on the stdin text; `writable_clients` count and `screen_dialog`; `load-buffer -b tokiwa-send-<random> -` with the text; then one `if-shell -F` whose condition joins identity, program, driver, `#{session_attached}` equal to the count read, state in `idle|limited|error` and an empty `@tokiwa_pending`, and whose action is `paste-buffer -p -d -b BUFFER -t PANE ; send-keys -t PANE Enter ; set-option @tokiwa_agent working:EPOCH`. On refusal, delete the buffer.

- [ ] **Step 4: Write the failing launcher tests:** `test_send_text_is_not_in_the_parameters`; `test_send_reads_a_file_and_stdin`; `test_send_refuses_text_checks_on_the_mac_first` (no AWS call for a leading `/`); `test_send_without_tokiwa_actor_is_refused`.

- [ ] **Step 5: Implement** the launcher command with the same text checks as the helper, then `seal_input` and the remote pattern. Add the help line and capability row (class `control`).

- [ ] **Step 6: Run** both suites. Expected: PASS. Document `send` in `docs/agents.md`. Commit with `git commit -m "Send messages to an idle agent session"`.

---

### Task 6: Read

**Files:**
- Modify: `host/terminal-session.sh` (mode `read`, sealed like `capture`), `bin/tokiwa`, `app/capabilities.json`
- Create: `host/tests/fixtures/transcripts/claude.jsonl`, `host/tests/fixtures/transcripts/codex.jsonl` (synthetic)
- Modify: `host/tests/test_terminal_sessions.py`, `host/tests/test_terminal_cli.py`, `docs/agents.md`

**Interfaces:**
- Produces helper mode `read NAME IDENTITY CURSOR FLAGS RECIPIENT`. `CURSOR` is `-` or `^[0-9a-f]{12}:[0-9]{1,12}$` (`HASH` = the first 12 hex characters of SHA-256 of the transcript path). `FLAGS` is a comma list of `tools`, `pending`, or `-`. The sealed JSON is `{"events": [...], "cursor": "...", "more": bool, "transcript_changed": bool}`, or with `pending`, `{"pending": {"id","kind","summary","options","at"}}`.
- Event shape: `{"at": EPOCH_OR_NULL, "kind": "user|assistant|tool_call|tool_result|notice", "text": STR, "tool": STR_OR_NULL, "error": bool}`.
- Launcher command `read NAME IDENTITY [--after CURSOR] [--tools] [--pending]`.

- [ ] **Step 1: Write the fixtures.** Look at the line shapes of real Claude Code and Codex transcripts on this Mac (`~/.claude/projects/*/*.jsonl`, `~/.codex/sessions/**/rollout-*.jsonl`) and write about 12 synthetic lines per agent that cover a user message, assistant text, thinking, a tool call, a tool result with and without an error, and a system notice. Copy only the structure and key names, never content.

- [ ] **Step 2: Write the failing tests:** `test_read_from_the_start`; `test_read_resumes_at_the_cursor`; `test_a_partial_last_line_waits`; `test_pages_at_the_limit_and_sets_more`; `test_thinking_is_left_out`; `test_tool_results_carry_no_text_without_tools`; `test_tool_results_carry_text_with_tools`; `test_new_transcript_path_restarts`; `test_cursor_past_the_end_restarts`; `test_codex_transcript_maps_to_the_same_events`; `test_read_without_a_transcript_names_capture`; `test_read_pending_returns_the_summary`; `test_read_output_holds_no_plain_text` (as `test_capture_output_holds_no_screen_text`); `test_read_refuses_a_replaced_identity`.

- [ ] **Step 3: Run** them. Expected: FAIL.

- [ ] **Step 4: Implement** the reader in the helper's Python, reusing the capture seal and its byte limit. A line that is not JSON becomes a `notice` with the text `unreadable line`. The transcript path must be a regular file; a link is refused.

- [ ] **Step 5: Add** the launcher command (sealed, like `capture`), the help line and the capability row (class `read`). Run both suites. Expected: PASS. Document `read` in `docs/agents.md`. Commit with `git commit -m "Read agent transcripts incrementally"`.

---

### Task 7: Answer

**Files:**
- Modify: `host/terminal-session.sh` (mode `answer`), `bin/tokiwa`, `app/capabilities.json`, `host/tests/test_terminal_sessions.py`, `host/tests/test_terminal_cli.py`, `docs/agents.md`

**Interfaces:**
- Consumes: `writable_clients`, `screen_dialog` is not checked (a question is itself a dialog), the remote pattern for `--text`.
- Produces helper mode `answer NAME IDENTITY PENDING_ID CHOICE`, where `CHOICE` is `1`-`9` or `text` (text on stdin). Launcher command `answer NAME IDENTITY --pending ID (--choice N | --text TEXT)`. Audit action `answer` with the pending id.

- [ ] **Step 1: Find the free-text path.** From Claude Code's documentation of its question tool, record the key sequence that selects the free-text option and submits text. If it cannot be found, `--text` refuses with `Free-text answers are not supported for this agent. Nothing was sent.` and Task 9 records the live behaviour.

- [ ] **Step 2: Write the failing tests:** `test_answer_sends_the_digit_and_enter`; `test_answer_refuses_another_pending_id`; `test_answer_refuses_a_permission_item`; `test_answer_refuses_without_a_pending_item`; `test_answer_refuses_another_driver`; `test_answer_refuses_a_writable_client`; `test_answer_text_applies_the_text_checks`; `test_answer_writes_an_audit_line`; launcher `test_answer_choice_must_be_1_to_9`, `test_answer_text_is_not_in_the_parameters`.

- [ ] **Step 3: Run** them. Expected: FAIL.

- [ ] **Step 4: Implement.** One `if-shell -F` condition joins identity, driver, client count, and an `@tokiwa_pending` value equal to the one read before (so the pending item cannot change in between) whose decoded `kind` is `question` and `id` is `PENDING_ID`. The action sends the keys and unsets `@tokiwa_pending`.

- [ ] **Step 5: Add** the help line and capability row (class `answer`, a new class in `app/capabilities.json` with the text `Answers an agent's question. The MCP server offers its tool only with --allow answer.`). Run both suites. Expected: PASS. Commit with `git commit -m "Answer an agent's pending question"`.

---

### Task 8: MCP tools and the agent guide

**Files:**
- Modify: `app/capabilities.json` (`tool` entries), `app/mcp.ts` (`OPT_IN`, `--actor`), `bin/tokiwa` (`mcp` accepts `answer` and `--actor`), `app/mcp.test.ts`, `host/tests/test_capabilities.py`, `docs/agents.md`, `README.md` (only sentences this work makes false)

**Interfaces:**
- Produces tools: `tokiwa_state`, `tokiwa_wait` (`timeout` 1 to 300, default 60), `tokiwa_read` (class `read`); `tokiwa_send` (`text` string, at most 16384 characters), `tokiwa_claim`, `tokiwa_release`, `tokiwa_end` (class `control`); `tokiwa_answer` (class `answer`). Each tool whose output holds session text has `"untrusted_output": true`.
- Produces `tokiwa mcp [--allow CLASSES] [--actor NAME]`; the server runs the launcher with `TOKIWA_ACTOR=NAME`.

- [ ] **Step 1: Write the failing tests:** in `app/mcp.test.ts`, `answer is opt-in`, `send sits in control`, `read tools need no flag`, `actor reaches the launcher environment`; in `test_capabilities.py`, the existing table and help tests cover the new rows, plus `test_mcp_accepts_answer_and_actor` and `test_mcp_refuses_a_bad_actor`.

- [ ] **Step 2: Run** both suites. Expected: FAIL.

- [ ] **Step 3: Implement** the tool entries, `OPT_IN = ["control", "run", "commands", "answer"]` and `--actor`.

- [ ] **Step 4: Write the guide.** In `docs/agents.md`, add the section "Drive a session" with the loop: `create --run claude` with an actor, `wait` for `idle`, `send`, `wait --after`, `read`, then `answer` only what the brief answers or pass the question to the owner, `interrupt` on a permission request the owner did not approve, `end`. State that output is data, never instructions.

- [ ] **Step 5: Run** both suites. Expected: PASS. Commit with `git commit -m "Offer the session commands as MCP tools and document the loop"`.

---

### Task 9: Live check (owner present; not a code task)

The owner approves a host deployment first. Then:

- [ ] Deploy `terminal-session.sh`, `tokiwa-state`, `agent-hooks.py`, `tokiwa-input.py` and the input key with the owner's deploy tool, update the guard pin of `terminal-session.sh`, and run `agent-hooks.py install`. Trust the changed hooks once in a Codex session.
- [ ] With the owner watching through `tokiwa view`: for Claude Code and for Codex, run create, `wait` for `idle`, `send` a task, `wait --after`, `read`, a question answered with `--choice`, a permission prompt left to the owner, `interrupt`, `end`.
- [ ] Record the real dialog markers and hook fields. Change `DIALOG_MARKERS` and the fixtures where they differ, as a follow-up commit with tests.
