# TUI Error States Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each backend failure one explanation and one recovery path in the Tokiwa app, with structured launcher error categories and per-source freshness in the data model.

**Architecture:** The launcher's AWS access check classifies AWS CLI output in one Bash function and reports `auth` or `unreachable` on an opt-in stderr line. `BackendClient` turns every launcher failure into a typed `LauncherError`. `classify()` in `app/problem.ts` is the only function that makes a `Failure`. A `SourceStatus` per source (`sessions`, `health`, `spend`) holds success and failure times. `errorState()` derives the band, header and details from those three records. The views read freshness from the data.

**Tech Stack:** Bash, Bun and TypeScript, OpenTUI (`@opentui/core` and its test renderer), `bun test`.

**Spec:** `docs/superpowers/specs/2026-11-15-tui-error-states-design.md`

## Global Constraints

- Launcher exit codes do not change. Every launcher failure still exits 1, and a usage error still exits 2.
- The launcher's human messages do not change, except the new `AWS cannot be reached from this Mac. Check the network, then retry.`
- The category line is `tokiwa-error: <category>`, printed only when `TOKIWA_ERROR_CATEGORY=1`, always as the last line of stderr. The categories are `auth` and `unreachable`.
- `bin/tokiwa` changes stay inside the AWS access-check block, from the `aws_call` definition to the `fi` after the second `sts get-caller-identity` call. Another branch changes the argument parsing.
- `app/` holds no AWS CLI error pattern. AWS CLI text is classified only by `aws_access_category` in `bin/tokiwa`.
- `LauncherError.message` keeps today's format (`Launcher <command> exited <code>: <tail>`), so `app/mcp.ts` output does not change.
- Kinds, in the order in which one explains another: `setup`, `signed-out`, `offline`, `stopped`, `not-ready`, `failed`. Only `failed` is a component failure.
- Live limits: `sessions` 90 s, `health` 65 s, `spend` 30 min (`FRESHNESS_LIMIT_MS`).
- Keys: `l` sign in, `u` refresh and retry (label `Refresh and retry`), `e` details. `r` stays Reconnect. No new key.
- Visual identity: the existing `▲` band, `warning` and `critical` tones, key-first hints joined with ` · `, dim context lines. No new colour, glyph, panel or full-screen view. The navigation row shows no error.
- Public repository: neutral names only (`project-a`, `worker-a`, `mac-a`, `profile-a`, instance `i-0123456789abcdef0`). No company, person, real profile, domain, real session name or real path in code, tests, fixtures, captures, docs or commit messages.
- Each task updates the documentation that it makes false: `docs/interface.md`, `docs/health.md`, `docs/configuration.md`, `docs/development.md`, `DESIGN.md`. `app/docs.test.ts` checks the key table and the `TOKIWA_` variable table.
- Tests: `cd app && ./node_modules/bun/bin/bun.exe test` (Bun is not on PATH). The whole suite passes at the end of each task. The baseline is 278 pass.
- Commits: `git add` of named files, one-line messages, no `Co-Authored-By` line and no "Generated with" line. Do not push.

## Review Focus

1. **A connection failure during a later AWS call.** The access check passes, then the network drops before `describe-instances`. Expected: `offline` with the title `An AWS request failed`, never `stopped` or `not available`. Task 3 test `a later AWS read failure is offline, not a workstation state`.
2. **Only one source fails for its own reason.** Health returns invalid JSON while session reads work. Expected: header `● EC2`, no band, one line at the top of Health, sessions stay live. Task 7 test `a component failure leaves the header connected and shows no band`.
3. **A sign-in in another terminal.** No `l` press. Expected: the next timed read succeeds, the band clears, and the other sources read at once but stay `last known` until each succeeds. Task 8 test `a success from the timer recovers without a sign-in view`.
4. **An older installed launcher without the category line.** Expected: its `AWS authentication failed` sentence still gives `signed-out`, and its hidden network failure stays `signed-out` (the app does not guess). Task 3 test `an older launcher's sign-in sentence still means signed-out`.
5. **An attached view while the snapshot is stale.** The transport is live although the snapshot is old. Expected: that row keeps its transport's activity glyph, and the other rows have an empty glyph cell. Task 5 test `a row with a connected view keeps its own activity while the snapshot is stale`.

---

### Task 1: `LauncherError` and the category line

**Files:**
- Modify: `app/backend.ts:145-182` (`BackendClient.call`)
- Test: `app/backend.test.ts`

**Interfaces:**
- Produces in `app/backend.ts`:
  - `export type LauncherCategory = "auth" | "unreachable";`
  - `export class LauncherError extends Error { readonly command: string; readonly reason: "exit" | "timeout" | "spawn"; readonly code: number | null; readonly stderr: string; readonly category?: LauncherCategory; }`
  - `export function splitCategory(stderr: string): { text: string; category?: LauncherCategory }`
- `call()` sets `TOKIWA_ERROR_CATEGORY: "1"` in the launcher's environment, beside `TOKIWA_DASHBOARD` and `TOKIWA_VIA`.

- [ ] **Step 1: Write the failing tests** in `app/backend.test.ts`. Each one writes a launcher stub script to a temporary folder (`mkdtempSync`) and calls it through `new BackendClient(stubPath)`:
  - `the launcher receives TOKIWA_ERROR_CATEGORY=1`: the stub writes `$TOKIWA_ERROR_CATEGORY` to a file and prints `{}`. Expect the file to hold `1`.
  - `a category line becomes a field and leaves the message`: the stub prints `Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.` and `tokiwa-error: auth` to stderr and exits 1. Expect rejection with a `LauncherError` where `category === "auth"`, `code === 1`, `reason === "exit"`, `command === "health"`, `message === "Launcher health exited 1: Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a."`, and neither `message` nor `stderr` contains `tokiwa-error`.
  - `an unknown category is ignored`: stderr ends with `tokiwa-error: other`. Expect `category === undefined` and the line stays in `stderr`.
  - `a timeout and a missing launcher are typed`: `new BackendClient("/nonexistent/tokiwa").call(["health"])` rejects with `reason === "spawn"` and `code === null`. For the timeout, test `splitCategory` and the `reason: "timeout"` path through a stub that sleeps, with the 90 s limit lowered by a new optional constructor parameter `timeoutMs = 90000`.

- [ ] **Step 2: Run** `cd app && ./node_modules/bun/bin/bun.exe test backend.test.ts`. Expected: FAIL (`LauncherError` is not exported).

- [ ] **Step 3: Implement.** `splitCategory` removes the last non-empty line when it matches `^tokiwa-error: (auth|unreachable)$`. `call()` wraps `Bun.spawn` in `try` and throws `reason: "spawn"` on a throw. The timeout throws `message` `The launcher exceeded 90 seconds.` with `reason: "timeout"`. A non-zero exit throws with the same message text as today, built from the stripped stderr. `app/mcp.ts` does not change.

- [ ] **Step 4: Run** the whole suite. Expected: PASS, including `mcp.test.ts` unchanged.

- [ ] **Step 5: Commit**

```bash
git add app/backend.ts app/backend.test.ts
git commit -m "app: type launcher failures and read their category line"
```

---

### Task 2: The launcher's AWS access category

**Files:**
- Modify: `bin/tokiwa`, the AWS access-check block only (today lines 249-259: `note()`, `aws_call()`, the two `sts get-caller-identity` calls)
- Create: `app/launcher.test.ts`
- Modify: `docs/configuration.md` (environment variable table), `docs/interface.md` (band table row for `AWS cannot be reached from this Mac.`)

**Interfaces:**
- Produces in `bin/tokiwa`: `aws_access_category TEXT` prints `unreachable` or `auth`; `fail_access CATEGORY MESSAGE` prints `Tokiwa: MESSAGE`, then `tokiwa-error: CATEGORY` when `TOKIWA_ERROR_CATEGORY=1`, and exits 1.
- Produces the stderr contract that Task 1 reads.

- [ ] **Step 1: Write the failing tests** in `app/launcher.test.ts`. A helper makes a temporary `HOME`, a host settings file (`instance=i-0123456789abcdef0`, `profile=profile-a`, `region=us-east-1`) passed as `TOKIWA_HOST_CONFIG`, and a folder with a fake `aws` script first on `PATH` (then `/usr/bin:/bin`). The fake `aws` prints `$FAKE_AWS_STDERR` to stderr and exits 255 when its arguments contain `sts`. The helper runs `bash ../bin/tokiwa health` with `TOKIWA_DASHBOARD=1` and returns exit code, stdout and stderr.
  - `a connection failure is unreachable`: for each of `Could not connect to the endpoint URL: "https://sts.us-east-1.amazonaws.com/"`, `Connect timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"`, `Read timeout on endpoint URL: "https://sts.us-east-1.amazonaws.com/"`, `Connection was closed before we received a valid response from endpoint URL`: exit 1, stderr contains `Tokiwa: AWS cannot be reached from this Mac. Check the network, then retry.`, and does not contain `authentication`.
  - `an expired token is auth`: `Error when retrieving token from sso: Token has expired and refresh failed` gives exit 1 and stderr containing `Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.`
  - `any other failure is auth, as before`: `An error occurred (AccessDenied)` gives the same message as above.
  - `the category line appears only on request`: with `TOKIWA_ERROR_CATEGORY=1`, the last stderr line is `tokiwa-error: unreachable` (connection case) or `tokiwa-error: auth` (token case). Without it, no stderr line starts with `tokiwa-error`.
  - `an unreachable result does not start a sign-in in a terminal`: run under `script -q /dev/null bash ../bin/tokiwa health` without `TOKIWA_DASHBOARD`, with a fake `aws` that writes `sso-login` to a marker file when called with `sso`. Expect the unreachable message and no marker file. (`script` with this syntax is the macOS form; the suite runs on the Mac.)

- [ ] **Step 2: Run** `cd app && ./node_modules/bun/bin/bun.exe test launcher.test.ts`. Expected: FAIL (the unreachable message is missing).

- [ ] **Step 3: Implement** inside the access-check block. Capture the stderr of the first `sts` call in a `mktemp` file, read it, and remove the file right away (do not add a `trap`; the capture code later in the file sets its own). On failure, `category=$(aws_access_category "$text")`. `unreachable` calls `fail_access unreachable 'AWS cannot be reached from this Mac. Check the network, then retry.'` before the interactive branch. `auth` keeps today's flow; its `fail` calls become `fail_access auth …` with the same messages, including `The AWS login did not complete. …` and the second `sts` call. `aws_access_category` matches the four connection phrases of Step 1 and prints `auth` for anything else.

- [ ] **Step 4: Document** `TOKIWA_ERROR_CATEGORY` in the `docs/configuration.md` variable table (Read by: Launcher; default: unset; the app and the MCP server set `1`; meaning: one last stderr line `tokiwa-error: auth` or `tokiwa-error: unreachable` after a failed AWS access check; exit codes do not change). In `docs/interface.md`, the band row `AWS cannot be reached from this Mac.` now names the access check as its cause too.

- [ ] **Step 5: Run** the whole suite. Expected: PASS, including `docs.test.ts` (`docs/configuration.md lists each TOKIWA_ variable`).

- [ ] **Step 6: Commit**

```bash
git add bin/tokiwa app/launcher.test.ts docs/configuration.md docs/interface.md
git commit -m "launcher: report the AWS access category on request"
```

---

### Task 3: `classify()` and `Failure`

**Files:**
- Modify: `app/problem.ts` (replace `diagnose` and the AWS patterns)
- Modify: `app/app.ts` (`failures()` 1725-1732, `problem()` 1734-1736, `drawProblem()` 1743-1789, the catch blocks at 1913-1917, 2816-2817, and the `diagnose` calls at 1906 and 2807)
- Test: `app/problem.test.ts` (rewrite), `app/problem-band.test.ts`

**Interfaces:**
- Consumes: `LauncherError`, `LauncherCategory` (Task 1).
- Produces in `app/problem.ts`:
  - `export type Source = "sessions" | "health" | "spend";`
  - `export type ProblemKind = "setup" | "signed-out" | "offline" | "stopped" | "not-ready" | "failed";`
  - `export interface Failure { source: Source; kind: ProblemKind; title: string; summary: string; explanation: string; command: string; code: number | null; category?: LauncherCategory; detail: string; at: number; }`
  - `export function classify(source: Source, error: unknown, at: number): Failure`
  - `export function worst(failures: Failure[]): Failure | undefined`
  - `export const GLOBAL_KINDS: ProblemKind[]` (every kind except `failed`)
  - `export const MAPPED_SENTENCES: string[]` (the stems that Step 1's drift test checks)
- Produces in `app/app.ts`: `readFailed(source: Source, error: unknown): Failure` and `readSucceeded(source: Source): void`, the only writers of `lastFailure: Partial<Record<Source, Failure>>`. `sessionsError` becomes a getter: `lastFailure.sessions?.detail ?? ""`.

- [ ] **Step 1: Write the failing tests** in `app/problem.test.ts`:
  - `a category from the launcher decides the kind, whatever the text says`: a `LauncherError` with `category: "unreachable"` and stderr `Tokiwa: AWS authentication failed. …` gives `offline` and the title `AWS cannot be reached from this Mac`. `category: "auth"` gives `signed-out` and `AWS sign-in expired`.
  - `an older launcher's sign-in sentence still means signed-out`: a plain `Error("Launcher --snapshot exited 1: Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.")` gives `signed-out`.
  - `AWS CLI text without a category is a component failure`: `Launcher health exited 1: Could not connect to the endpoint URL` and `… ENOTFOUND …` give `failed`.
  - `a later AWS read failure is offline, not a workstation state`: `Tokiwa: The host state could not be read.` and `Tokiwa: The host check could not be submitted.` give `offline`, title `An AWS request failed`.
  - `a timeout is offline; a spawn failure and exit 2 are setup`: `reason: "timeout"` gives `offline`; `reason: "spawn"` gives `setup` and `The launcher is not installed`; `code: 2` gives `setup` and `The launcher is older than the app`.
  - `the host, workbench and settings sentences each have a kind`: `The host is stopped. No restart was requested.` gives `stopped` and `The workstation is stopped`; `The workbench check returned Failed. No service was started.` gives `not-ready`; `Set the host in …`, `… has a line that is not KEY=VALUE …`, `…: region= must be an AWS region …`, `The end time in … has passed. No host was started.`, `The AWS account does not match account= in …` give `setup` and `The host settings need a fix`, with the sentence as `explanation`.
  - `titles carry no trailing period, no launcher prefix and no shell noise`: for `Launcher --snapshot exited 255: <getcwd noise line>\nssh: unexpected reply.`, `kind === "failed"`, `summary === "ssh: unexpected reply"`, `title === "Sessions read failed: ssh: unexpected reply"`, and `detail` has no `Launcher` prefix and no `getcwd` line.
  - `worst ranks setup, signed-out, offline, stopped, not-ready, failed`.
  - `each sentence that classify maps exists in bin/tokiwa`: every entry of `MAPPED_SENTENCES` is a substring of `readFileSync("../bin/tokiwa")`.
- In `app/problem-band.test.ts` add `the band title has one period`: a failure `The launcher exceeded 90 seconds.` (timeout) shows `▲ AWS cannot be reached from this Mac.` and the frame has no `..`.

- [ ] **Step 2: Run** `./node_modules/bun/bin/bun.exe test problem.test.ts problem-band.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement** `classify` in this order: `LauncherError.reason` (`spawn`, `timeout`), exit code 2, `category`, then the Tokiwa sentences, then `failed`. Remove `SIGNED_OUT`'s AWS alternatives and `OFFLINE`; keep `SIGN_IN_EXPIRED` from `app/backend.ts` as the sentence for older launchers. A string or a plain `Error` is read as the message text. The `summary` of a `failed` failure is its first meaningful line with the first letter lower-cased in `title` only.

- [ ] **Step 4: Wire** `app/app.ts`: the session read's catch and the spend catch call `readFailed`; their successes call `readSucceeded`. `sampleHealth` passes `async () => { try { return await this.backend.health() } catch (e) { this.readFailed("health", e); throw e } }` to `history.sample`. `failures()` returns the active `Failure[]` of `sessions` and `health` (spend joins the band in Task 7). The band title is `▲ ${failure.title}.`. The two `diagnose(...).kind === "signed-out"` checks read `lastFailure`. The details box lists each distinct `detail` once.

- [ ] **Step 5: Run** the whole suite. Expected: PASS. Update the existing assertions that expected `▲ ssh: unexpected reply` to `▲ Sessions read failed: ssh: unexpected reply`.

- [ ] **Step 6: Commit**

```bash
git add app/problem.ts app/problem.test.ts app/app.ts app/problem-band.test.ts
git commit -m "app: classify launcher failures in one function"
```

---

### Task 4: Action failures leave the navigation row

**Files:**
- Modify: `app/app.ts`: `drawNavStatus` (3262-3265); the error sites 1126, 1400, 1405, 1465, 1613, 2179, 2291, 2495-2500, 2597, 2752, 3989, 4078; the getter and setter at `app/app.ts:312-317`
- Modify: `app/state.ts:72` (`WorkspaceState.error`)
- Test: `app/app.test.ts:425-440`, `app/workspace.test.ts:265-272`, `app/problem-band.test.ts`
- Docs: `docs/interface.md` (lines 34, 160, 298, 322), `DESIGN.md:42`

**Interfaces:**
- Consumes: `classify`, `Failure`, `readFailed` (Task 3); `LauncherError` (Task 1).
- Produces in `app/app.ts`: `actionFailed(action: string, error: unknown): void`. A `LauncherError` or a message that starts with `Launcher ` or `The launcher` is classified; its notice is `${action} failed · ${kind === "failed" ? summary : title}`. Any other error gives its own message without `Error: `. A `LauncherError` with `command === "--snapshot"` also calls `readFailed("sessions", error)`. The notice is failed and lasts 8000 ms.

| Site | Action label |
| --- | --- |
| `attachRemote` catch | `attach ${name}` |
| `shellHere` catch, and its two checks at 1400 and 1405 | `shell here` (the checks keep their text as a notice) |
| `popOut` catch | `open in Ghostty` |
| confirmed operation catch (2495) | by `Operation.operation`: `project` → `move ${name}`, `new-session` → `create ${name}`, `new-project` → `new project`, `rename-project` and `rename-session` → `rename ${name}` |
| `endSession` catch | `end ${name}` |
| `endProject` catch | `end ${project title}` |
| `startSession` catch (2597) | `create ${name}` |
| `reorder` and `dropOn` catches | `move ${title}` |
| clipboard (1126) | none: the existing `copy failed · …` notice stays and the `this.error` line goes |

- [ ] **Step 1: Write the failing tests.** In `app/problem-band.test.ts`, `a failed attach shows a notice, not an error in the navigation row`: open with the expired-sign-in runner, call `app.attachRemote("worker-c")`, render. Expect the navigation line (`frame.split("\n")` row that starts with `  Workspace  Health`) to equal `Workspace  Health` after `trim()`, and the footer line to contain `attach worker-c failed · AWS sign-in expired`, and the frame not to contain `Launcher` or `Error:`. Change `app/app.test.ts:425-440` and `app/workspace.test.ts:265-272` to read `app.footerNotice?.text` instead of `app.error`.

- [ ] **Step 2: Run** the three files. Expected: FAIL.

- [ ] **Step 3: Implement** `actionFailed`, replace each site in the table, remove `WorkspaceState.error` and the `error` accessors, and make `drawNavStatus` draw only the focus strip. The confirm text in the search box (`confirmStatus.text`) uses the same label and title as the notice.

- [ ] **Step 4: Update docs.** `docs/interface.md:34`: the navigation row shows `Workspace`, `Health` and, in focus mode, the strip. Lines 298 and 322: an error no longer takes the place of the strip; it shows as a notice. Line 160: name the `<action> failed · <cause>` notice. `DESIGN.md:42`: remove "An error takes the place of the strip."

- [ ] **Step 5: Run** the whole suite. Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add app/app.ts app/state.ts app/app.test.ts app/workspace.test.ts app/problem-band.test.ts docs/interface.md DESIGN.md
git commit -m "app: show action failures as notices, not in the navigation row"
```

---

### Task 5: Per-source status and freshness in the data

**Files:**
- Modify: `app/state.ts` (add `SourceStatus`)
- Modify: `app/app.ts`: `readFailed`/`readSucceeded` (Task 3) write `sources`; `remoteRows()` (3387-3415); `rowActivity()` (3468-3485); `refreshSessions()` (1880-1937); `sampleHealth()` (2797-2834, keep `this.spend` on failure); the receipt events `remote-sessions-refreshed`, `remote-sessions-error`, `health-sample`
- Modify: `app/app.ts:230-241` (`SessionRow` gets two fields)
- Create: `app/freshness.test.ts`

**Interfaces:**
- Consumes: `Source`, `Failure` (Task 3).
- Produces in `app/state.ts`:
  - `export type Freshness = "live" | "last-known" | "unavailable";`
  - `export const FRESHNESS_LIMIT_MS: Record<Source, number> = { sessions: 90_000, health: 65_000, spend: 1_800_000 };`
  - `export class SourceStatus { okAt: number; failAt: number; failure?: Failure; constructor(limitMs: number); succeed(at: number): void; fail(failure: Failure): void; freshness(now: number): Freshness; }` with the rules of the spec's "Freshness model".
  - `app/state.ts` and `app/problem.ts` import each other's types with `import type` only.
- Produces in `app/app.ts`: `sources: Record<Source, SourceStatus>`; `SessionRow.freshness?: Freshness` and `SessionRow.readAt?: number` on rows built from the snapshot. `lastFailure` from Task 3 becomes a getter over `sources[*].failure`.

- [ ] **Step 1: Write the failing tests** in `app/freshness.test.ts`:
  - `a source is unavailable before its first success, live after it, and last known after a failure or the limit`: `SourceStatus(90_000)`: `freshness(0) === "unavailable"`; after `succeed(1000)`, `freshness(2000) === "live"` and `freshness(92_000) === "last-known"`; after `fail({ at: 3000, … })`, `freshness(3500) === "last-known"`; after `succeed(4000)`, `"live"`.
  - `snapshot rows carry their freshness and read time`: an app with `spawn: false`, `now` under test control and a runner that succeeds twice, then fails with the auth sentence. After the failure, each `sessionRows()` entry with a `ref` has `freshness === "last-known"` and `readAt` equal to the time of the last good read.
  - `a stale snapshot row has no activity, but a bell stays`: after the failure, `rowStatus(row).state` is `unknown` for a row whose screens differed between the two good reads, and `needs-you` for a row with `bell: true`.
  - `a row with a connected view keeps its own activity while the snapshot is stale`: attach one row with `backend.attachCommand = () => ["/bin/sleep", "30"]`, then fail the reads. That row's state stays the transport's state; the others are `unknown`.
  - `the first live read after a stale period shows no output glyph`: after the failure, a good read with changed screens gives `unknown`, not `output`, and schedules the next read 5 s later (`sessionTimer` set with `SESSIONS_SECOND_READ_MS`).
  - `a failed spend read keeps the last reading`: `backend.spend` succeeds, then throws the auth sentence after the spend timer is reset. `app.spend` is still the fixture and `sources.spend.freshness(now) === "last-known"`.
  - `receipt events carry freshness and read time`: with `receipt` set to a temporary file, the `remote-sessions-error` event has `freshness: "last-known"` and `read_at` equal to the last good read time in seconds.

- [ ] **Step 2: Run** `./node_modules/bun/bin/bun.exe test freshness.test.ts`. Expected: FAIL.

- [ ] **Step 3: Implement.** `rowActivity` returns `unknown` for a snapshot row whose `freshness !== "live"`, unless its view is attached and connected. `refreshSessions` clears `previousSessions` when the sessions source was not live before the read, and then uses `SESSIONS_SECOND_READ_MS` for the next timer. The spend catch no longer sets `this.spend = undefined`.

- [ ] **Step 4: Run** the whole suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/state.ts app/app.ts app/freshness.test.ts
git commit -m "app: keep per-source status and freshness in the data"
```

---

### Task 6: Last known and not read in the views

**Files:**
- Modify: `app/app.ts` (`drawProjectTitle`, `drawHealth` 2836-2885: pass the new model fields)
- Modify: `app/health-view.ts` (`HealthViewModel` 271-282, `workstation` 390-478, `spend` 480-600, the titles in `limits` 602, `storage` 647 and `network` 672, `footer` 699-723)
- Modify: `app/health-fixture.ts` (`fixtureModel` defaults: both freshness values `live`)
- Test: `app/health-view.test.ts`, `app/freshness.test.ts`, `app/health-app.test.ts:170-188`
- Docs: `docs/health.md` (state table at lines 58-69 and line 18), `docs/interface.md` (session list section, line 123)

**Interfaces:**
- Consumes: `Freshness`, `sources` (Task 5).
- Produces: `HealthViewModel.healthFreshness: Freshness`, `HealthViewModel.spendFreshness: Freshness`, `HealthViewModel.spendReadAt?: number`, `HealthViewModel.globalFailure: boolean` (true while a global failure is active; then a missing value says `not read`).

- [ ] **Step 1: Write the failing tests** in `app/health-view.test.ts`, with `fixtureModel` overrides:
  - `last-known Health sections say so on their titles`: `healthFreshness: "last-known"` gives the lines `Workbench limits · last known`, `Storage · last known`, `Network · ens5 · last known`, an Uptime value ending in `· at HH:MM` of the sample (or `· at Mon D HH:MM` on another day), and a footer `Sampled … · last known` in the `warning` tone.
  - `last-known spend keeps its values and says so`: `spendFreshness: "last-known"` gives `Spend (estimate · last known)` and an Instance value ending in `· last known`, and the money rows keep their values.
  - `a value that was never read says not read under a global failure`: `spend: undefined`, `globalFailure: true` gives `Spent so far:   not read` and `Instance:       not read`, and no `not available`.
  - `a component spend failure keeps its reason`: `spend: undefined`, `globalFailure: false`, `spendError: "no price for m7i.2xlarge in health.json"` gives `not available (no price for m7i.2xlarge in health.json)`.
- In `app/freshness.test.ts`, `stale project titles say last known`: after the session failure, the captured frame contains `project-a · last known` and, after a good read, does not.
- Change `app/health-app.test.ts:170-188`: the exit-2 spend failure is now `setup`; expect `not read` in Spend and the band title `The launcher is older than the app` (the band joins in Task 7; in this task assert only the Spend rows).

- [ ] **Step 2: Run** the three files. Expected: FAIL.

- [ ] **Step 3: Implement.** The ` · last known` note on a project title is in the `dim` tone and goes only on top-level titles, only while `sources.sessions.freshness(now) !== "live"` and no session read runs. Health values that are last known keep today's dim tone. `missing()` stays for component reasons. `health.md`: replace the `stale` and failed-read rows with `last known` (the sample is older than 65 s or the last read failed) and add `not read`.

- [ ] **Step 4: Run** the whole suite. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add app/app.ts app/health-view.ts app/health-fixture.ts app/health-view.test.ts app/freshness.test.ts app/health-app.test.ts docs/health.md docs/interface.md
git commit -m "app: mark last-known and unread data in the views"
```

---

### Task 7: `ErrorState`, the header and the band

**Files:**
- Modify: `app/problem.ts` (add `ErrorState`, `errorState`)
- Modify: `app/health-view.ts` (`age` 340-344 gains days; add `syncedText`)
- Modify: `app/app.ts`: remove `sessionsError`, `hostOk`, `hostFail`, `lastFailure`, `failures()`, `problem()`; `hostState()` (1972-1978) and `drawHeader()` (2090-2124) read `sources`; `drawProblem()` (1743-1789) draws two rows and the structured details; `signInExpired()` (1721-1723); the band boxes (581-621) gain a second text row; the empty-list text (3591-3614) and `drawEmptyState` (4082-4101); the footer hints (3095-3096); the component line at the top of the list and of Health
- Test: `app/problem.test.ts`, `app/problem-band.test.ts`, `app/sign-in.test.ts`, `app/health-view.test.ts`
- Docs: `docs/interface.md` (screen layout sketch, header status table, Problem band section)

**Interfaces:**
- Consumes: `classify`, `Failure`, `worst`, `GLOBAL_KINDS` (Task 3); `SourceStatus`, `Freshness`, `sources` (Task 5).
- Produces in `app/problem.ts`:
  - `export interface ErrorState { kind: ProblemKind; scope: "global" | "component"; title: string; explanation: string; affected: Source[]; recovery: "sign-in" | "retry" | "none"; lastSuccess?: number; diagnostics: Failure[]; }`
  - `export function errorState(sources: Record<Source, SourceStatus>, now: number): ErrorState | undefined`: the global failure whose `at` is later than every source's `okAt`, ranked by `worst`; else the newest active component failure; else `undefined`.
- Produces in `app/health-view.ts`: `export function syncedText(at: number, now: number): string`.
- Produces in `app/app.ts`: `currentError(): ErrorState | undefined`, which every view reads. `signInExpired()` returns `currentError()?.kind === "signed-out"`.

Band copy, exact (`{when}` is `syncedText(lastSuccess, now)`, or `Nothing was read yet` without a success):

| Kind | First row | Second row |
| --- | --- | --- |
| `signed-out` | `▲ AWS sign-in expired` | `Live status unavailable. Last synced {when}.` |
| `offline` | `▲ <title>` | `Showing the last known state from {when}. Retrying every 30 s.` |
| `stopped` | `▲ The workstation is <state>` | `Start it in AWS, then press u. Last synced {when}.` |
| `not-ready` | `▲ The workbench server is not ready` | `Tokiwa retries every 30 s. Last synced {when}.` |
| `setup` | `▲ <title>`, `critical` tone | the failure's `explanation` |

- [ ] **Step 1: Write the failing tests.**
  - `app/health-view.test.ts`, `syncedText gives the time today, the date on another day, and days from 48 hours`: with a fixed local `now`, 6 minutes earlier gives `HH:MM · 6m ago`; 41 hours earlier gives `Mon D HH:MM · 41h ago`; 50 hours earlier ends in `· 2d ago`.
  - `app/problem.test.ts`, `one success clears a global failure for all sources`: health fails with `signed-out` at 10, sessions succeed at 20 → `errorState` is `undefined` although health's own failure is newer than its own success.
  - `app/problem.test.ts`, `a component failure stays until its own source succeeds`: health `failed` at 10, sessions ok at 20 → `scope === "component"`, `affected` is `["health"]`.
  - `app/problem-band.test.ts`, `a failed read shows a two-row band with the age of the last good read`: after two good reads and a clock jump of 41 h with the auth runner, lines 2 and 3 of the frame are `▲ AWS sign-in expired` (with `l sign in · e details` at the right) and `Live status unavailable. Last synced <date> · 41h ago.`; the frame contains no `Launcher`, no `Error:`, and the launcher sentence does not appear outside the details.
  - `app/problem-band.test.ts`, `the details show one copy of a failure that both reads report`: change the existing test (201-213) to give the health read `Launcher health exited 1: …` and the session read `Launcher --snapshot exited 1: …`, the real pair. Expect one copy of `Tokiwa: AWS authentication failed`, the rows `sessions      --snapshot exit 1 · auth` and `health        health exit 1 · auth` when the runner throws `LauncherError` with `category: "auth"`, and `Recovery      l runs tokiwa login in a local view`.
  - `app/problem-band.test.ts`, `a component failure leaves the header connected and shows no band`: sessions good, health throws `The health response is invalid.` → the header contains `● EC2`, no row starts with `▲` under the header rule, and in Health the first body line is `▲ Health read failed: the health response is invalid` with `u retry · e details`.
  - `app/problem-band.test.ts`, `a stopped workstation is a workstation state, not a link state`: the runner throws `The host is stopped. No restart was requested.` → header `○ EC2 · stopped`, band `▲ The workstation is stopped`.
  - `app/problem-band.test.ts`, `the footer offers u retry for an offline failure`: timeout runner → footer starts with `u retry · `.
  - `app/problem-band.test.ts`, `a setup failure uses the critical tone and offers no key`: spawn failure → band title `▲ The launcher is not installed`, no `l sign in` and no `u retry` in the band keys, only `e details`.

- [ ] **Step 2: Run** the four files. Expected: FAIL.

- [ ] **Step 3: Implement** `errorState`, `syncedText` and the drawing. The header word is chosen in this order: `signed out` or `offline` from an active global failure; `stopped` or `not ready`; `connecting` before any result while a read runs; `reconnecting` when the newest success is older than 90 s; nothing. A component failure never changes it. `bandRows` is 2 for a global failure (1 while signing in), plus the details rows. The details box uses the layout of the spec's mockup 2a. Health's component line sits at the top of the Health body; the list's sits at the top of the list.

- [ ] **Step 4: Update** `docs/interface.md`: the screen sketch shows the two-row band; the header table gains `○ EC2 · stopped` and `○ EC2 · not ready` and says that a component failure does not change the header; the Problem band section gives the table of this task and the details layout.

- [ ] **Step 5: Run** the whole suite. Expected: PASS. Tests that read `app.sessionsError` (`problem-band.test.ts:100`, `187`, `193`; `sign-in.test.ts:71`) read `app.sources.sessions.failure` instead.

- [ ] **Step 6: Commit**

```bash
git add app/problem.ts app/health-view.ts app/app.ts app/problem.test.ts app/problem-band.test.ts app/sign-in.test.ts app/health-view.test.ts docs/interface.md
git commit -m "app: draw one error state from the per-source status"
```

---

### Task 8: Recovery per source

**Files:**
- Modify: `app/app.ts`: `signIn()` (1828-1864), the `refresh` action (823-832), the two one-off recovery blocks (1901-1909, 2803-2808), `sampleHealth()` spend timer (2810-2811)
- Modify: `app/shortcuts.ts:29-34` (label)
- Test: `app/sign-in.test.ts`, `app/problem-band.test.ts`
- Docs: `docs/interface.md` (key table rows `u` and `l`, Problem band paragraph on recovery)

**Interfaces:**
- Consumes: `currentError`, `sources`, `actionFailed` (Tasks 4, 5, 7).
- Produces in `app/app.ts`: `recover(): void`, called after a sign-in view exits 0 and after the first `readSucceeded` while `currentError()?.scope === "global"` was true before that success.

- [ ] **Step 1: Write the failing tests.**
  - `app/sign-in.test.ts`, `after a sign-in, every source is read again and each stays last known until it succeeds`: auth runner; press `l` with `login = "exit 0"`; make `health` hang (a promise that the test resolves later) and `--snapshot` succeed. After the sign-in: the band is gone; `sources.sessions.freshness(now) === "live"`; `sources.health.freshness(now) === "last-known"`; a `spend` call happened within the same Health read (no 15-minute wait). After the test resolves the Health read: Health is `live`.
  - `app/problem-band.test.ts`, `a success from the timer recovers without a sign-in view`: auth runner, then the runner starts to succeed and the test calls `app.sampleHealth()` only. Expect a session read to start at once and no band.
  - `app/problem-band.test.ts`, `after an offline failure, a Health success starts a session read`: timeout runner for both, then success for Health only → a `--snapshot` call follows at once.
  - `app/sign-in.test.ts`, `a recovery clears a notice about the cause`: a failed attach notice from Task 4, then recovery → `app.footerNotice` is undefined.
  - `app/problem-band.test.ts`, `u resets the spend timer when spend is not live`: after a spend failure, press `u` → `backend.spend` is called during the next Health read.

- [ ] **Step 2: Run** both files. Expected: FAIL.

- [ ] **Step 3: Implement** `recover()` with the four steps of the spec's "Recovery" section. It replaces the two one-off blocks. The `refresh` action resets `spendAt` when spend is not live and reads Health when Health is not live. The `refresh` binding label becomes `Refresh and retry`.

- [ ] **Step 4: Update** `docs/interface.md`: the `u` row (`Refresh and retry: read the sessions now; read Health and spend again when they are not live`) and the recovery paragraph of the Problem band section.

- [ ] **Step 5: Run** the whole suite. Expected: PASS, including `docs.test.ts` (`the key tables of docs/interface.md match the key map`).

- [ ] **Step 6: Commit**

```bash
git add app/app.ts app/shortcuts.ts app/sign-in.test.ts app/problem-band.test.ts docs/interface.md
git commit -m "app: recover each source after a sign-in or a good read"
```

---

### Task 9: Renderer verification of the four states

**Files:**
- Create: `app/error-capture.ts`, `app/error-capture.test.ts`
- Create: `docs/superpowers/captures/2026-11-15-tui-error-states/` (the saved frames)
- Modify: `docs/development.md` (the capture scripts paragraph, about line 130)

**Interfaces:**
- Consumes: `App`, `BackendClient`, `LauncherError`, `captureSizes` (`app/health-capture.ts:14-18`).
- Produces: `export type ErrorScene = "auth-expired" | "network-failure" | "component-failure" | "recovery";` and `export async function captureErrorScene(scene: ErrorScene, view: "workspace" | "health", width: number, height: number): Promise<string>`. Run as a script, it writes `<scene>-<view>-<width>x<height>.txt` for every scene, view and size to `$TOKIWA_CAPTURE_DIR/error-states/` (default `~/.local/state/tokiwa/captures/error-states/`).

Each scene uses `new App(renderer, { backend, spawn: false, now, probe: async () => 20, device: "mac-a" })`, two good session reads and one good Health and spend read at `t0`, then a clock jump. Sessions: `worker-a`, `worker-b` (with `bell: true`), `worker-c` in `project-a`; `worker-d` in `project-b`.

| Scene | After the jump | Clock jump |
| --- | --- | --- |
| `auth-expired` | Every call throws `LauncherError` with `category: "auth"` and the auth sentence; one failed attach of `worker-c` | 41 h |
| `network-failure` | Every call throws `LauncherError` with `category: "unreachable"` and the unreachable sentence | 6 min |
| `component-failure` | `health` throws `The health response is invalid.`; sessions and spend succeed | 6 min |
| `recovery` | The `auth-expired` scene, then the runner succeeds for `--snapshot` only and `recover()` runs; Health still hangs | 41 h |

- [ ] **Step 1: Write the failing test** `app/error-capture.test.ts`, `the four error states draw as designed at each capture size`. For each size in `captureSizes`:
  - `auth-expired` / `workspace`: contains `○ EC2 · signed out`, `▲ AWS sign-in expired`, `l sign in · e details`, `Live status unavailable. Last synced`, `· 41h ago`, `project-a · last known`, `◈ worker-b`; the navigation line is `Workspace  Health` after `trim()`; the frame does not contain `Launcher`, `Error:`, `tokiwa-error`, `◆` or `not available`; the sentence `AWS authentication failed` appears 0 times.
  - `auth-expired` / `health`: contains `Workbench limits · last known`, `Spend (estimate · last known)`, `· last known` on the footer line; does not contain `not available`.
  - `network-failure` / `workspace`: contains `○ EC2 · offline`, `▲ AWS cannot be reached from this Mac`, `u retry · e details`, `Retrying every 30 s`, `project-a · last known`; does not contain `signed out` or `sign in`.
  - `component-failure` / `health`: header `● EC2`; no `▲` row above the navigation row; contains `▲ Health read failed: the health response is invalid` and `Workbench limits · last known`. `component-failure` / `workspace`: no `▲` and no `last known`.
  - `recovery` / `workspace`: header `● EC2`; no `▲`; no `last known`; no `◆`. `recovery` / `health`: contains `Workbench limits · last known` and no `▲`.
  - Every frame: no line wider than the capture width, and no `…` in a session name.

- [ ] **Step 2: Run** `./node_modules/bun/bin/bun.exe test error-capture.test.ts`. Expected: FAIL (`error-capture.ts` does not exist).

- [ ] **Step 3: Implement** `captureErrorScene` and the script entry, following `app/review-capture.ts`. The fake runner throws `LauncherError` instances; no scene calls AWS, the launcher or the workstation.

- [ ] **Step 4: Run** the test and the whole suite. Expected: PASS.

- [ ] **Step 5: Save the captures.** Run `cd app && TOKIWA_CAPTURE_DIR="$PWD/../docs/superpowers/captures/2026-11-15-tui-error-states" ./node_modules/bun/bin/bun.exe error-capture.ts`, then move the files from its `error-states/` subfolder up one level. Expected: 24 files (4 scenes × 2 views × 3 sizes). Read each 100×30 frame and compare it with the spec's mockups 2, 3, 4, 5 and 6. List each difference in the task report for the owner; do not edit the captures by hand. Search the files for internal names: `grep -rniE 'profile|@|/Users/|/home/' docs/superpowers/captures/2026-11-15-tui-error-states/` must print only `profile-a` lines.

- [ ] **Step 6: Document** in `docs/development.md` that `error-capture.ts` draws the error states and where its frames go.

- [ ] **Step 7: Commit**

```bash
git add app/error-capture.ts app/error-capture.test.ts docs/development.md docs/superpowers/captures/2026-11-15-tui-error-states
git commit -m "app: capture the error states with the test renderer"
```
