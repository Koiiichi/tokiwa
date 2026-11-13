# Run Allowlist Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A local agent with `tokiwa mcp --allow commands` runs an entry of the owner's root-owned command list on the host and reads its exit status and paged, encrypted output.

**Architecture:** A root Python runner on the host (`host/tokiwa-run.py`) reads `/etc/tokiwa/commands.json`, checks a call, and starts the command as `agent-workspace` in a one-off systemd unit whose `ExecStopPost=+` hook records the end. The launcher (`bin/tokiwa`) adds `commands`, `run` and `run-status`, sent over Run Command as root, with the capture's one-time key for the results. The MCP server adds a `commands` class and a `pairs` argument type.

**Tech Stack:** Bash (launcher, installer), Python 3.12 standard library (runner, host tests with `unittest`), TypeScript on Bun (MCP server, `bun test`), systemd `systemd-run`, `openssl smime`.

**Spec:** `docs/superpowers/specs/2026-11-12-run-allowlist-design.md`

## Global Constraints

- Never run free shell text. Arguments pass as a list; no value is split or given to a shell.
- Commands run as `agent-workspace`. The runner itself runs as root (Run Command), never inside a session.
- List: `/etc/tokiwa/commands.json`, `root:root 0644`. The installer creates `{"entries": {}}` only when no file exists.
- Log: `/var/log/tokiwa/run.jsonl`, `root:root 0644`, written only by the runner. It never holds output or a secret value.
- Run folders: `/srv/development/cache/tokiwa-runs/<id>/`. Delete folders older than 14 days at the start of each `start`.
- Run id: `^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$`, for example `20261112T183000-7f3a`. Unit: `tokiwa-run-<id>.service`.
- At most 4 active runs. Page size 15,000 bytes of output per result.
- States: `done`, `running`, `failed`, `timed-out`.
- `run` and `run-status` results are `openssl smime -encrypt -aes256 -binary -outform DER`, base64, to the caller's one-time certificate, as `capture` does. `commands` is plain.
- Every refusal message ends with `Nothing was run.`
- `home: none` hides `/srv/development/private`. Every mode hides `/srv/development/private/homes/workbench/.tokiwa`. Named secrets reach the unit only through a root-only `EnvironmentFile`, never `--setenv`.
- `PATH=/usr/local/bin:/usr/bin:/bin`; no caller variable passes to the unit.
- No internal project name, person or path outside this repository's own host paths in code, tests, fixtures or commit messages. Use neutral names (`repo-a`, `review-pr`).
- Commit subjects use the repository's `<area>: <sentence>` form (`host:`, `app:`, `docs:`). No co-author trailer.

## Review Focus

1. A `path_below` value that escapes its root through `..` or a symlink must be refused after resolution (Task 1 test `test_path_below_refuses_escape`).
2. A value that starts with `-` must be refused unless the entry's pattern allows it, so a value never becomes an option of the program (Task 1 test `test_leading_dash_is_refused_by_anchored_patterns`).
3. A run whose unit vanished without an end record (host reboot) must report `failed` with `exit: null`, not `running` forever (Task 2 test `test_status_of_a_lost_run_is_failed`).
4. A page boundary inside a multibyte character must not break decoding, and offsets stay in bytes (Task 2 test `test_page_splits_inside_a_character`).
5. A run id from the caller that is not an id (`../x`) must be refused before any path is built (Task 2 test `test_status_refuses_a_bad_id`).

---

### Task 1: The list and the argument checks

**Files:**
- Create: `host/tokiwa-run.py`
- Create: `host/commands.json` (the empty list the installer copies: `{"entries": {}}`)
- Test: `host/tests/test_run_commands.py`

**Interfaces:**
- Produces, in `host/tokiwa-run.py` (tests load it with `importlib.util.spec_from_file_location('tokiwa_run', ...)`):
  - Constants `LIST`, `RUNS`, `LOG`, `HOME`, `SECRETS` (`HOME / '.tokiwa/secrets.env'`), `PAGE_BYTES = 15000`, `MAX_RUNNING = 4`, `KEEP_SECONDS = 14 * 86400`, `WAIT_SECONDS = 8`, `ID_PATTERN`, `NAME_PATTERN = r'^[a-z][a-z0-9_-]{0,47}$'` (entry and argument names). Tests patch these module attributes; the runner reads no environment override.
  - `class Refused(Exception)`; `str(error)` always ends with `Nothing was run.`
  - `load_list(path: Path = LIST) -> dict[str, dict]`: parses and validates every entry; raises `Refused('The command list is invalid: <reason>. Nothing was run.')`.
  - `public_view(entries: dict[str, dict]) -> list[dict]`: `[{name, description, args: {arg: {"pattern": str} | {"choice": [public names]} | {"path_below": root}}}]`, sorted by name.
  - `check_call(entry: dict, values: dict[str, str]) -> dict[str, str]`: the filled values, keyed by `as` or the argument name.
  - `fill_argv(argv: list[str], filled: dict[str, str]) -> list[str]`.

Entry rules for `load_list`: keys `description` (str), `argv` (non-empty list of str), `args` (dict), `cwd` (`fresh` | `worktree`), `home` (`none` | `workbench`, default `none`), `secrets` (list of `^[A-Z_][A-Z0-9_]{0,63}$`, default `[]`), `timeout_seconds` (int 1..86400), `output_bytes` (int 1..10,000,000). Each arg has exactly one of `pattern` (compiles, starts with `^`, ends with `$`), `choice` (non-empty dict of name to str), `path_below` (absolute str); optional `as` (`NAME_PATTERN`). Every `{name}` in `argv` must name a filled key. `cwd: worktree` requires a `choice` arg filled as `clone` and an arg named `commit`. Any other key refuses the list.

- [ ] **Step 1: Write the failing tests** in `host/tests/test_run_commands.py`, class `ListAndArguments`:
  - `test_valid_list_loads` writes the spec's `review-pr` example and asserts `load_list(...)['review-pr']['home'] == 'workbench'`.
  - `test_invalid_lists_are_refused` uses subtests for an unknown key, an unanchored pattern (`'[0-9]+'`), a placeholder with no arg (`'{missing}'`), `cwd: worktree` without `clone`, and a file that is not JSON. Each raises `Refused` whose message ends with `Nothing was run.`
  - `test_check_call_fills_and_renames` asserts `check_call(entry, {'repo': 'repo-a', 'pr': '42', 'commit': '1a2b3c4'}) == {'clone': '/w/repo-a', 'pr': '42', 'commit': '1a2b3c4'}`.
  - `test_missing_extra_and_bad_values_are_refused` uses subtests: no `pr`; an extra `x`; `pr='0'`; `commit='XYZ'`; `repo='repo-b'`.
  - `test_leading_dash_is_refused_by_anchored_patterns`: `commit='--upload-pack=x'` is refused.
  - `test_path_below_refuses_escape`: in a temp root, `sub/../../etc` and a symlink pointing outside are refused, and `sub/file` inside is accepted and returned resolved. A missing path is refused.
  - `test_fill_argv_keeps_each_value_whole`: `fill_argv(['{clone}/scripts/review.sh', '--pr', '{pr}'], {...,'pr': '4 2'})` returns `['/w/repo-a/scripts/review.sh', '--pr', '4 2']`.
  - `test_public_view_hides_choice_values`: the view of `repo` is `{'choice': ['repo-a']}`, and no `/w/` string appears in `json.dumps(view)`.

- [ ] **Step 2: Run the tests to make sure they fail**

Run: `python3.12 -m unittest host/tests/test_run_commands.py -v` (from the repository root, or `discover -s host/tests -p test_run_commands.py`)
Expected: FAIL, because `host/tokiwa-run.py` does not exist.

- [ ] **Step 3: Implement the functions above** in `host/tokiwa-run.py`. `path_below` resolves with `Path(value).resolve(strict=True)` and checks `is_relative_to(root.resolve())`. Patterns match with `re.fullmatch`.

- [ ] **Step 4: Run the tests to make sure they pass**

Run: the same command. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/tokiwa-run.py host/commands.json host/tests/test_run_commands.py
git commit -m "host: check a call against the owner's command list"
```

### Task 2: Runs: start, status, finish, log and paging

**Files:**
- Modify: `host/tokiwa-run.py`
- Test: `host/tests/test_run_commands.py` (class `Runs`)

**Interfaces:**
- Consumes: Task 1's `load_list`, `check_call`, `fill_argv`, `Refused`, the constants.
- Produces:
  - `new_id(now: float) -> str` (UTC `%Y%m%dT%H%M%S` plus 4 hex from `secrets.token_hex(2)`).
  - `unit_command(run_id: str, entry: dict, argv: list[str], workdir: Path, env_file: Path | None) -> list[str]`: the `systemd-run` argv.
  - `start(name: str, values: dict[str, str], via: str, actor: str, now: float | None = None) -> dict`.
  - `status(run_id: str, offset: int) -> dict`.
  - `finish(run_id: str, service_result: str, exit_status: str) -> None`.
  - `page(path: Path, offset: int, limit: int) -> tuple[str, int | None, int]`: text, `next_offset` or `None`, file size.
  - `seal(result: dict, certificate_b64: str) -> str`.
  - Result dict for `start` and `status`: `{id, entry, state, exit, offset, next_offset, size, truncated, text}`.
  - Tests replace the module's `command(argv: list[str]) -> subprocess.CompletedProcess` helper, which is the runner's only path to `systemd-run`, `systemctl`, `runuser` and `git`, and record each call.

`unit_command` must contain, in this order after `systemd-run`: `--unit=tokiwa-run-<id>`, `--uid=agent-workspace`, `--gid=agent-workspace`, `--slice=agent-sessions.slice`, `--working-directory=<workdir>`, `--collect`, `--no-block`, then `--property=` items: `RuntimeMaxSec=<timeout_seconds>`, `StandardOutput=file:<run>/output`, `StandardError=inherit`, `NoNewPrivileges=yes`, `ProtectSystem=strict`, `PrivateTmp=yes`, `ReadWritePaths=<run>` (plus `<HOME>` for `home: workbench`), `InaccessiblePaths=/srv/development/private` (for `none`) or `InaccessiblePaths=<HOME>/.tokiwa` and `InaccessiblePaths=/srv/development/private/peermesh` (for `workbench`), `EnvironmentFile=<RUNS>/<id>.env` when secrets are named, `ExecStopPost=+/usr/bin/python3 -I <runner> finish <id>`. Environment: `--setenv=PATH=/usr/local/bin:/usr/bin:/bin`, `--setenv=HOME=<run>` (none) or `HOME=<HOME>`, `CLAUDE_CONFIG_DIR=<HOME>/.claude`, `CODEX_HOME=<HOME>/.codex` (workbench). Then `--`, then the filled argv.

`start` order: `load_list` → `check_call` → refuse if `len(active runs) >= MAX_RUNNING` (`systemctl list-units 'tokiwa-run-*' --state=active --no-legend --plain`) → prune `RUNS` entries older than `KEEP_SECONDS` → make `<run>` (`agent-workspace`, 0700) → `cwd`: `<run>/work` empty, or `runuser -u agent-workspace -- git -C <clone> cat-file -e <commit>^{commit}` (refuse `The commit <c> is not in the clone. Nothing was run.`) then `runuser -u agent-workspace -- git -C <clone> worktree add --detach <run>/work <commit>` → write `<RUNS>/<id>.env` (root 0600) with only the named secrets, parsed from `SECRETS` with `shlex`; a named secret that is missing refuses the call → write `<run>/call.json` (entry name, `output_bytes`, clone path for worktree) → log line → `systemd-run` → poll `<run>/end.json` up to `WAIT_SECONDS` → return `status(id, 0)`. Each refusal writes a log line with `refused` and the reason, then raises.

`status`: refuse an id that fails `ID_PATTERN` (`Use a run id from tokiwa run. Nothing was run.`) or has no folder. State: `end.json` state if present; else `running` when `systemctl is-active tokiwa-run-<id>` prints `active` or `activating`; else `failed` with `exit: null`. Text from `page(<run>/output, offset, PAGE_BYTES)`, capped at `output_bytes`; `truncated` is true when the file is larger than `output_bytes`.

`finish`: map `service_result` `success` → `done`, `timeout` → `timed-out`, other → `failed`; `exit` is `int(exit_status)` or `None`; write `end.json`; append the end log line `{at, id, state, exit}`; remove the env file; for a worktree run `runuser -u agent-workspace -- git -C <clone> worktree remove --force <run>/work`; truncate `output` to `output_bytes`. The CLI reads `SERVICE_RESULT` and `EXIT_STATUS` from the environment that systemd gives `ExecStopPost`.

`page` decodes the byte slice with `errors='replace'`. `seal` is the capture's `openssl smime` call (copy the 12 lines from `host/terminal-session.sh` around line 285 into a function).

CLI (`if __name__ == '__main__'`): `commands` prints `json.dumps(public_view(load_list()))`; `start PAYLOAD CERT` (PAYLOAD is base64 JSON `{"entry": str, "args": {str: str}}`, `via` and `actor` from `TOKIWA_VIA`/`TOKIWA_ACTOR` with the launcher's patterns) prints `seal(start(...), CERT)`; `status ID OFFSET CERT` prints `seal(status(...), CERT)`; `finish ID`. A `Refused` prints its message to stderr and exits 1. Refuse unless `os.geteuid() == 0`: `The command runner needs root. Nothing was run.`

- [ ] **Step 1: Write the failing tests**, class `Runs`, with `RUNS`, `LOG`, `LIST`, `HOME` patched to a temp folder and `command` replaced:
  - `test_unit_command_for_a_fresh_run_hides_the_private_volume`: asserts `'--property=InaccessiblePaths=/srv/development/private'` in the argv, `--setenv=HOME=<run>`, no `CLAUDE_CONFIG_DIR`, and the argv after `--` equals the filled argv.
  - `test_unit_command_for_a_workbench_run_keeps_secrets_hidden`: asserts the `.tokiwa` and peermesh `InaccessiblePaths`, the model variables, and no `--setenv` holding a secret name.
  - `test_named_secrets_go_to_a_root_only_file`: a `SECRETS` file with `export API_KEY='v a l'` and `export OTHER='x'`; the env file holds `API_KEY=v a l` only, mode 0600; the value appears in no log line and no `command` argv.
  - `test_start_logs_and_starts_the_unit`: one log line with `entry`, `args`, `via`, `state: "running"`; one `systemd-run` call.
  - `test_refusals_are_logged`: an unknown entry raises `Refused` and logs `refused`; nothing calls `systemd-run`.
  - `test_fifth_run_is_refused`: `systemctl list-units` stand-in prints 4 units; `start` raises `Refused` naming the limit.
  - `test_unknown_commit_is_refused` and `test_worktree_is_made_and_removed`: the `cat-file` stand-in fails or succeeds; `finish` calls `worktree remove`.
  - `test_finish_records_the_end`: `finish(id, 'timeout', '')` writes `end.json` `{"state": "timed-out", "exit": null}` and a second log line; `status` then reports `timed-out`.
  - `test_status_of_a_lost_run_is_failed`: no `end.json`, `systemctl is-active` prints `inactive` → `state: "failed"`, `exit: None`.
  - `test_paging_and_truncation`: a 40,000-byte output with `output_bytes` 30,000; offsets 0, 15,000 return `next_offset` 15,000 and `None`, and `truncated` is true.
  - `test_page_splits_inside_a_character`: a page boundary inside `é` decodes without an error and the next offset is the byte offset.
  - `test_status_refuses_a_bad_id`: `status('../x', 0)` raises `Refused`.
  - `test_old_runs_are_pruned`: a folder with an mtime 15 days old is gone after `start`; a 13-day-old one stays.
  - `test_seal_round_trip`: with a certificate from `openssl req -x509` in the test, `openssl smime -decrypt` of `seal({'a': 1}, cert)` gives `{"a": 1}`.
  - `test_cli_refuses_without_root` (skip when the test runs as root).

- [ ] **Step 2: Run the tests to make sure they fail.** Run the Task 1 command. Expected: the `Runs` tests FAIL with missing functions.

- [ ] **Step 3: Implement** `new_id`, `unit_command`, `start`, `status`, `finish`, `page`, `seal`, `command` and the CLI as above.

- [ ] **Step 4: Run all host tests.** Run: `python3.12 -m unittest discover -s host/tests -v`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add host/tokiwa-run.py host/tests/test_run_commands.py
git commit -m "host: run a listed command in its own unit and record its end"
```

### Task 3: Launcher commands

**Files:**
- Modify: `bin/tokiwa` (usage, the argument `case`, the Run Command block around lines 240-320)
- Test: `host/tests/test_terminal_cli.py`

**Interfaces:**
- Consumes: Task 2's CLI: `python3 -I /opt/agent-platform/rootless/tokiwa-run.py commands | start PAYLOAD CERT | status ID OFFSET CERT`.
- Produces: launcher commands `tokiwa commands`, `tokiwa run ENTRY [NAME=VALUE]...`, `tokiwa run-status ID [OFFSET]`, used by Task 4's tools.

Argument checks in the launcher: `ENTRY` and each `NAME` match `^[a-z][a-z0-9_-]{0,47}$`; each `VALUE` is 1 to 1,000 characters with no control characters; at most 16 pairs; `ID` matches the run id pattern; `OFFSET` is a non-negative integer, default 0. Failures use `fail 'Use run ENTRY NAME=VALUE…, with names from tokiwa commands.'` and `fail 'Use run-status ID [OFFSET], with the id from tokiwa run.'`.

Remote command, run as root by Run Command (not through `$helper`): `env TOKIWA_VIA=$via TOKIWA_ACTOR=$actor python3 -I /opt/agent-platform/rootless/tokiwa-run.py <sub> …`. The `start` payload is base64 JSON `{"entry", "args"}`, as `create` encodes its payload today.

- [ ] **Step 1: Write the failing tests** in `test_terminal_cli.py`, after extending the stand-in `aws` to answer a call that holds `tokiwa-run.py start` or `tokiwa-run.py status` by encrypting `{"id": "20261112T183000-7f3a", "state": "done", "exit": 0, "text": "ok"}` to the last field, as it does for `capture`:
  - `test_run_sends_the_entry_and_pairs_encoded`: `run review-pr pr=42 commit=1a2b3c4` → the decoded payload is `{"entry": "review-pr", "args": {"pr": "42", "commit": "1a2b3c4"}}`, and the call does not go through `runuser`.
  - `test_run_decrypts_the_result`: stdout parses to the JSON above.
  - `test_run_refuses_bad_arguments`: subtests for `run Bad`, `run review-pr pr`, `run review-pr pr=$'a\tb'`, 17 pairs. Each exits non-zero with no `calls` file.
  - `test_run_status_checks_the_id`: `run-status ../x` fails without calls; `run-status 20261112T183000-7f3a 15000` sends `status 20261112T183000-7f3a 15000 <cert>`.
  - `test_commands_is_plain`: `commands` sends no certificate.

- [ ] **Step 2: Run them to make sure they fail.** Run: `python3.12 -m unittest discover -s host/tests -p 'test_terminal_cli.py' -v`. Expected: FAIL.

- [ ] **Step 3: Implement.** Move the capture's key, request and decrypt lines into two functions, `sealed_key` (makes `$work`, the key and the certificate, and prints the base64 certificate) and `open_sealed ID` (reads, decodes and decrypts to stdout). Use them for `capture`, `run` and `run-status`. Add the three commands to `usage`, with one line each.

- [ ] **Step 4: Run all host tests.** Run: `python3.12 -m unittest discover -s host/tests -v`. Expected: PASS, including the existing capture tests.

- [ ] **Step 5: Commit**

```bash
git add bin/tokiwa host/tests/test_terminal_cli.py
git commit -m "app: add the commands, run and run-status launcher commands"
```

### Task 4: MCP class, tools and contract

**Files:**
- Modify: `app/capabilities.json`, `app/mcp.ts`, `bin/tokiwa` (the `mcp)` case)
- Test: `app/mcp.test.ts`, `host/tests/test_capabilities.py`

**Interfaces:**
- Consumes: Task 3's launcher commands.
- Produces:
  - `classes.commands`: `"Runs an entry of the owner's command list on the host. The MCP server offers its tool only with --allow commands."`
  - Patterns `run_id`: `^[0-9]{8}T[0-9]{6}-[0-9a-f]{4}$`, and `entry`: `^[a-z][a-z0-9_-]{0,47}$` (the runner's `NAME_PATTERN`).
  - Argument type `{ "type": "pairs" }` in `mcp.ts`: `z.record(z.string().regex(/^[a-z][a-z0-9_-]{0,47}$/), z.string().min(1).max(1000))`, with at most 16 keys. An `argv` part `{name...}` expands to one `KEY=VALUE` item per pair, in key order.
  - Capabilities: `commands` (class `read`, tool `tokiwa_commands`, `argv ["commands"]`); `run` (class `commands`, tool `tokiwa_run`, `argv ["run", "{entry}", "{args...}"]`, args `entry` pattern `entry`, `args` type `pairs`, `untrusted_output: true`, example `["run", "review-pr", "pr=42"]`); `run-status` (class `read`, tool `tokiwa_run_status`, `argv ["run-status", "{id}", "{offset}"]`, args `id` pattern `run_id`, `offset` integer 0 to 1,000,000,000 default 0, `untrusted_output: true`, example `["run-status", "20261112T183000-7f3a", "0"]`).
  - `OPT_IN = ["control", "run", "commands"]`. `parseAllow` error: `Use tokiwa mcp, or tokiwa mcp --allow with control, run or commands, joined by commas.` The launcher's `mcp)` check accepts one to three distinct classes from `control|run|commands`, with the same message.

- [ ] **Step 1: Write the failing tests.**
  - `mcp.test.ts`: `test("--allow commands offers tokiwa_run and not tokiwa_launch")` lists the tools and asserts `tokiwa_run` present and `tokiwa_launch` absent; `test("--allow run alone does not offer tokiwa_run")`; `test("tokiwa_run expands its pairs and marks the output as data")` calls `tokiwa_run` with `{entry: "review-pr", args: {pr: "42", commit: "1a2b3c4"}}` and asserts the backend got `["run", "review-pr", "commit=1a2b3c4", "pr=42"]` and the text starts with `SCREEN_NOTICE`; `test("a pair with a bad name is refused before the launcher")` asserts no backend call; `parseAllow(["--allow", "commands,control"])` returns both, and `parseAllow(["--allow", "shell"])` throws.
  - `test_capabilities.py`: in `test_each_tool_fills_in_to_its_example`, a `{name...}` part matches the remaining example items, each of the form `NAME=VALUE`, and its arg has type `pairs`. Add `test_commands_class_is_separate_from_run`, which asserts that no `commands`-class tool has `class: run` and that `tokiwa_launch` keeps class `run`.

- [ ] **Step 2: Run them to make sure they fail.** Run: `cd app && bun test mcp.test.ts` and `python3.12 -m unittest discover -s host/tests -p 'test_capabilities.py' -v`. Expected: FAIL.

- [ ] **Step 3: Implement** the table entries, the `pairs` type and expansion in `mcp.ts`, `OPT_IN`, `parseAllow`, and the launcher's `mcp)` check.

- [ ] **Step 4: Run all tests.** Run: `cd app && bun test`, then `python3.12 -m unittest discover -s host/tests -v`. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/capabilities.json app/mcp.ts app/mcp.test.ts bin/tokiwa host/tests/test_capabilities.py
git commit -m "app: offer the command list to local agents through a new commands class"
```

### Task 5: Installer and documentation

**Files:**
- Modify: `host/install.sh` (the copy loops around lines 106-107, plus a create-only step and two folders)
- Modify: `docs/agents.md`, `docs/host.md`, `docs/architecture.md`, `docs/development.md` only if its test table needs the new test file
- Test: `host/tests/test_install_host.py`

**Interfaces:**
- Consumes: `host/tokiwa-run.py`, `host/commands.json`.
- Produces: installed `/opt/agent-platform/rootless/tokiwa-run.py` (0644), `/etc/tokiwa/commands.json` (0644, only when absent), `/var/log/tokiwa` (root 0755), `/srv/development/cache/tokiwa-runs` (root 0755).

- [ ] **Step 1: Write the failing tests** in `test_install_host.py`, in the style of its existing dry-run and stand-in tests:
  - `test_runner_and_empty_list_are_installed`: a dry run prints the install of `tokiwa-run.py` to the rootless folder and of `commands.json` to `/etc/tokiwa/commands.json`, and makes both folders.
  - `test_an_existing_list_is_never_replaced`: with a list file present at the stand-in path, the run prints no install of `commands.json`.

- [ ] **Step 2: Run them to make sure they fail.** Run: `python3.12 -m unittest discover -s host/tests -p 'test_install_host.py' -v`. Expected: FAIL.

- [ ] **Step 3: Implement.** Add `tokiwa-run.py` to the 0644 loop. Add `place_once MODE SOURCE TARGET`, which runs `install -D` only when the target does not exist. Make the two folders with `run install -d -m 0755`.

- [ ] **Step 4: Write the documentation.**
  - `docs/agents.md`: a `commands` row in the class table; a "With `--allow commands`" tools table (`tokiwa_run`) and `tokiwa_commands` and `tokiwa_run_status` in the read table; a "Run a listed command" section with the result fields and paging; in Limits, the parameters (entry and values) that Run Command history keeps; in Trust, that `--allow commands` alone gives no free command line.
  - `docs/host.md`: the three files and two folders in the install tables; a "The command list" section (format, argument kinds, `cwd`, `home`, `secrets`, editing from `tokiwa admin`, an example entry with neutral names); a "Run log" section after "Audit log".
  - `docs/architecture.md`: add `commands`, `run`, `run-status` to the Run Command row of the paths table, and one sentence that they run the root runner, not the helper.

- [ ] **Step 5: Run every test.** Run: `python3.12 -m unittest discover -s host/tests -v` and `cd app && bun test`. Expected: PASS.

- [ ] **Step 6: Search for internal names.** Run: `git diff origin/main --stat` and search the diff for any project name, person or path that is not one of this repository's own host paths. Expected: none.

- [ ] **Step 7: Commit**

```bash
git add host/install.sh host/tests/test_install_host.py docs/agents.md docs/host.md docs/architecture.md
git commit -m "host: install the command runner and document the command list"
```

## After the plan (owner steps, not code)

- Push the branch only with the owner's approval, after the internal-name search.
- The host install (`host/install.sh` as root) is a host change that needs the owner's approval. It does not change `start-workbench.sh`, so the private guard pin stays valid. Run the setup repository's tests afterwards anyway.
- The owner writes the first entries in `/etc/tokiwa/commands.json` from `tokiwa admin`, then reconnects a local agent with `tokiwa mcp --allow commands`.
