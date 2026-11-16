# TUI error states: design

Status: approved by the owner on 2026-11-15, with the eight answers in "Decisions".

## Intent

One underlying failure gets one visible explanation and one clear recovery path. Today an expired AWS sign-in shows in the problem band, twice in the details box, in the navigation row after a failed attach, and in four Health rows. A launcher prefix (`Launcher --snapshot exited 1:`) reaches the screen. A failed AWS request makes the workstation look `not available`. Session rows from a 41-hour-old snapshot look current, and the output glyph `◆` keeps pulsing on them.

The app already has one problem band (`app/problem.ts`, `drawProblem` in `app/app.ts`). This design makes every surface go through one error model and adds per-source freshness to the data model.

## Requirements

1. Connectivity, workstation health and data freshness are three separate states. A failed AWS request never implies that the EC2 workstation is unhealthy.
2. Recovery is tracked per data source. One good request shows that a global connectivity problem is gone. Sessions, Health and Spend each stay `last known` until that source refreshes with success.
3. The launcher boundary gives stable, structured error categories where practical. Existing CLI users and exit codes do not change. The app does not parse AWS CLI error text. The one place that classifies AWS CLI output is one function in the launcher, with tests. The app reads only the category.
4. Freshness is part of the data model, not only of the drawing. A stale session state does not look current to a person or to a program that reads Tokiwa data.
5. The visual identity and the navigation layout stay. No full-screen error view. No new colours, glyphs or panels.
6. Before shipping, the authentication-expiry, network-failure, component-failure and recovery states are drawn with the real renderer and the captures are saved.

## Decisions

| # | Question | Decision |
| --- | --- | --- |
| 1 | Retry key | `u`. The owner's `r` stays Reconnect. The `u` label becomes `Refresh and retry`. |
| 2 | Launcher exit codes | Exit codes do not change. The category travels as one opt-in stderr line (see "Launcher boundary"). |
| 3 | Last-known marker | ` · last known` after each top-level project title. |
| 4 | Critical failures | The band, in the `critical` tone, with the fix in the details. No dedicated view. |
| 5 | Band height | Two rows for a global failure. One row while a sign-in runs. |
| 6 | Raw text in details | One copy of the launcher's own message, without the `Launcher … exited N:` prefix. |
| 7 | Spend after a failure | Health keeps the last spend reading and marks it `last known`. |
| 8 | Header word | `signed out` stays. |

## Three states

| State | Values | Source of truth | Shown in |
| --- | --- | --- | --- |
| Connectivity: the link from this Mac to AWS | `connecting`, `connected`, `reconnecting`, `signed out`, `offline` | The newest launcher result of any source that is not a component failure | Header status word |
| Workstation | `running`, `stopped`, `not ready`, `unknown` | Facts that the launcher read with success: the instance state from `spend`, the host-state check, the workbench check | Header word when not running; Health `Instance:` row; the band |
| Freshness, per source | `live`, `last-known`, `unavailable` | `SourceStatus` of `sessions`, `health`, `spend` | Project titles, Health section titles, the Health footer line, the band's second row |

A connectivity failure leaves the workstation state `unknown`. It never turns into `stopped` or `not available`. The header shows the first of these that applies: `signed out` or `offline` (connectivity), then `stopped` or `not ready` (workstation), then `connecting`, `reconnecting` or nothing (connected).

## Launcher boundary

### Categories

| Category | Meaning | Human message (unchanged or new) |
| --- | --- | --- |
| `auth` | The AWS access check failed, and the failure is not a connection failure | `AWS authentication failed. Run aws sso login --profile <profile>.` (unchanged), or `The AWS login did not complete. …` (unchanged) |
| `unreachable` | The AWS access check could not connect to AWS: connection, DNS or timeout | `AWS cannot be reached from this Mac. Check the network, then retry.` (new) |

`auth` stays the default for an access-check failure that is not a connection failure. That keeps today's behaviour for every case except the network case.

In an interactive terminal, an `unreachable` result no longer starts `aws sso login`, because a sign-in cannot work without a network. It fails at once with the new message.

### How the launcher reports a category

The mechanism is **one opt-in stderr line**. When the caller sets `TOKIWA_ERROR_CATEGORY=1`, a failure with a category prints one more line after the human message:

```text
Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.
tokiwa-error: auth
```

The format is `^tokiwa-error: [a-z-]+$`. It is always the last line of stderr. The exit code stays 1.

Why this mechanism:

- Exit codes and the human message do not change, so CLI users and scripts see the same output. Without the variable, nothing changes at all.
- A dedicated variable keeps one meaning per variable. `TOKIWA_DASHBOARD=1` already means "no progress lines and no sign-in prompt". The MCP server and other programs can opt in to the category line without that.
- One line at a fixed position is easy to strip. `BackendClient` removes it before it builds the error message, so the MCP server's text does not change.
- An unknown value is ignored. That keeps it forward compatible.

### The one classifier of AWS CLI output

A Bash function in the AWS access-check block of `bin/tokiwa`, `aws_access_category`, reads the stderr of `aws sts get-caller-identity` and prints `unreachable` or `auth`. `unreachable` needs positive evidence: one of the AWS CLI's connection errors (`Could not connect to the endpoint URL`, `Connect timeout on endpoint URL`, `Read timeout on endpoint URL`, `Connection was closed before we received a valid response`). Everything else is `auth`. A test runs the launcher with a fake `aws` program on `PATH` for each case.

The change stays inside the access-check block (the `sts get-caller-identity` lines), because another branch changes the argument parsing of `bin/tokiwa`.

### Failures without a category

Other launcher failures keep their exit code and their own stable `Tokiwa:` sentence. The app maps a short list of these sentences in `classify()` (see below). They are Tokiwa's own text, not AWS text. A test checks that each sentence the app maps still exists in `bin/tokiwa`, so a reworded sentence fails the test. Giving these failures a category line is a later step, after the other `bin/tokiwa` branch has merged.

An older launcher prints no category line. Its `AWS authentication failed` sentence is mapped as above, so the app still works with it.

## Error model (app)

### `LauncherError` (`app/backend.ts`)

`BackendClient.call` sets `TOKIWA_ERROR_CATEGORY=1` and throws `LauncherError`, a subclass of `Error`, for every launcher failure:

| Field | Value |
| --- | --- |
| `command` | `args[0]`, for example `--snapshot` |
| `reason` | `exit`, `timeout` or `spawn` |
| `code` | The exit code, or `null` for `timeout` and `spawn` |
| `stderr` | The stderr text without the category line |
| `category` | `auth`, `unreachable`, or `undefined` |
| `message` | Unchanged: `Launcher <command> exited <code>: <tail>`, `The launcher exceeded 90 seconds.`, or the spawn error |

### `Failure` and `classify()` (`app/problem.ts`)

`classify(source, error, at)` is the only function that turns an error into a `Failure`. Every catch block that handles a launcher error calls it.

```ts
type Source = "sessions" | "health" | "spend";
type ProblemKind = "setup" | "signed-out" | "offline" | "stopped" | "not-ready" | "failed";
interface Failure {
  source: Source; kind: ProblemKind; title: string; summary: string; explanation: string;
  command: string; code: number | null; category?: LauncherCategory; detail: string; at: number;
}
```

| Kind | From | Scope | Title | Recovery |
| --- | --- | --- | --- | --- |
| `setup` | `reason: "spawn"`; exit code 2; host settings, end time and account sentences | global, `critical` tone | `The launcher is not installed`, `The launcher is older than the app`, `The host settings need a fix` | none; the details give the fix |
| `signed-out` | `category: "auth"`; else the sentences `AWS authentication failed`, `AWS login did not complete` | global | `AWS sign-in expired` | `l` |
| `offline` | `category: "unreachable"`; `reason: "timeout"`; else the sentences `AWS cannot be reached`, `could not be read`, `could not be submitted` | global | `AWS cannot be reached from this Mac`, or `An AWS request failed` for the sentence cases | `u` |
| `stopped` | `The host is <state>. No restart was requested.` | global | `The workstation is <state>` | `u` |
| `not-ready` | `The workbench check returned …` | global | `The workbench server is not ready` | `u` |
| `failed` | anything else | component | `Sessions read failed: …`, `Health read failed: …`, `Spend read failed: …` | `u` |

The order in which one kind explains another: `setup`, `signed-out`, `offline`, `stopped`, `not-ready`, `failed`. Titles carry no trailing period. `detail` is the launcher's own text, without the `Launcher … exited N:` prefix and without shell noise about a removed folder.

The app keeps no AWS CLI pattern. The patterns `Token has expired`, `The SSO session … has expired`, `Could not connect to the endpoint URL`, `ENOTFOUND`, `getaddrinfo`, `Name or service not known` and `Network is unreachable` leave `app/problem.ts`.

### `ErrorState` (`app/problem.ts`)

`errorState(statuses, now)` reads the three `SourceStatus` records and returns the state that the band, the header, the views and the details read, or `undefined`:

```ts
interface ErrorState {
  kind: ProblemKind; scope: "global" | "component"; title: string; explanation: string;
  affected: Source[]; recovery: "sign-in" | "retry" | "none";
  lastSuccess?: number; diagnostics: Failure[];
}
```

A global failure is active while its time is later than the newest success of **any** source. A component failure is active while its time is later than the newest success of **its own** source.

## Freshness model

`SourceStatus` (`app/state.ts`), one for each source: `okAt`, `failAt`, `failure`, and `freshness(now)`.

| Freshness | Rule |
| --- | --- |
| `live` | `okAt > 0`, `okAt >= failAt`, and `now - okAt <= limit` |
| `last-known` | `okAt > 0`, and not live |
| `unavailable` | `okAt == 0` |

| Source | Read interval | Live limit | Shown as |
| --- | --- | --- | --- |
| `sessions` | 5 s after the first read, then 30 s while Workspace is in view | 90 s | ` · last known` on top-level project titles |
| `health` | 30 s | 65 s | ` · last known` on Workbench limits, Storage and Network; Uptime `· at <time>`; footer `Sampled … · last known` |
| `spend` | 15 min | 30 min | `Spend (estimate · last known)`; Instance value ends in `· last known` |

While a session read runs after a return to Workspace, the list stays as it was. A recorded Health snapshot (`--snapshot FILE`) keeps its own `recorded` state.

Freshness is part of the data:

- Each `SessionRow` that comes from a snapshot carries `freshness` and `readAt`.
- `HealthViewModel` carries `healthFreshness`, `spendFreshness` and `spendReadAt`.
- The receipt events `remote-sessions-refreshed`, `remote-sessions-error` and `health-sample` carry `freshness` and `read_at` for their source.
- A snapshot row that is not live has the activity `unknown`. Its glyph cell is empty, as for any row without an observation. Only `◈` (needs you) stays, because an unseen bell is a fact of the snapshot. A row with an attached, connected view keeps the activity of its own transport.
- After a period without a live session read, the app drops the previous snapshot, so `◆` and `◇` return only after two live reads. The second read follows 5 s after the first.

## Display rules

1. A global failure shows in the band only. The band's first row is `▲ <title>` with its keys at the right. The second row is a dim line: the explanation and the age of the newest good read among the affected sources.
2. Ages: `HH:MM · Nm ago` today, `Mon D HH:MM · Nh ago` on another day, `Nd ago` from 48 hours.
3. A component failure shows as one amber line at the top of the affected view (`Workspace` for sessions, `Health` for Health), with `u retry · e details`. A spend failure stays in its Spend rows as `not available (<reason>)`.
4. A row that has no data under a global failure says `not read`, dim, with no reason.
5. `e` opens one details box under the band: `Last synced`, `Affected`, `Recovery`, one diagnostics row per failed source (`<source>  <command> exit <code> · <category or kind> · <time>`), then one copy of the launcher's own text.
6. The navigation row shows `Workspace`, `Health` and, in focus mode, the strip. It never shows an error.
7. A failed action shows a bottom-bar notice for 8 s: `<action> failed · <title>`, for example `attach worker-c failed · AWS sign-in expired`. The confirm text in the search box shows the same title. A failed `--snapshot` call inside an action counts as a failure of the `sessions` source.
8. The footer offers `l sign in` for `signed-out`, as now, and `u retry` for the other global kinds that can be retried.
9. The error log keeps each raw failure, as now.

## Recovery

| Action | Key | Offered when | Does |
| --- | --- | --- | --- |
| Sign in | `l` | `signed-out` | Runs `tokiwa login` in a local view, as now. On exit 0, `recover()`. |
| Refresh and retry | `u` | always | Reads the sessions now; reads Health now when it is not live; resets the spend timer when spend is not live. |
| Details | `e` | any active failure | Opens or closes the details box. |
| Refresh after recovery | none | automatic | `recover()` |

`l`, `e` and `u` have no other binding in `app/shortcuts.ts`. `r` is Reconnect. Unbound single letters remain for later use: `a f i j k m s v y`.

`recover()` runs after a sign-in exits 0, and on the first success of any source while a global failure is active. It does four things:

1. It reads each source that is not live: sessions at once, then 5 s later; Health at once; spend in that Health read (it resets the spend timer).
2. It clears a bottom-bar notice that names the cleared cause.
3. It closes the details box.
4. It leaves each source `last known` until that source's own read succeeds.

The band goes away as soon as one source succeeds. Each `last known` mark goes away when its own source turns live. Reads continue every 30 s while a failure lasts, so a sign-in in another terminal is found within 30 s.

## Mockups

These are 80-column frames drawn with the app's current characters and spacing. Amber: the `▲` line, the header word, and `last known` on the Health footer line. Dim: the band's second row, ` · last known` on titles, and values that are last known.

### 1. Healthy (Workspace, 80 columns; unchanged)

```text
  ◇ tokiwa  /  Workspace                                                 ● EC2
  ────────────────────────────────────────────────────────────────────────────
  Workspace  Health

  project-a
  › ◇ worker-a  idle
    ◈ worker-b  needs you
    ◇ worker-c  idle

  project-b
    ◆ worker-d  working

  + new project

  ────────────────────────────────────────────────────────────────────────────
  ↑↓ select · enter attach · ? shortcuts
```

### 2. Authentication required (Workspace)

```text
  ◇ tokiwa  /  Workspace                                    ○ EC2 · signed out
  ────────────────────────────────────────────────────────────────────────────
  ▲ AWS sign-in expired                                  l sign in · e details
    Live status unavailable. Last synced Nov 13 21:20 · 41h ago.
  Workspace  Health

  project-a · last known
  ›   worker-a  idle
    ◈ worker-b  needs you
      worker-c  idle

  project-b · last known
      worker-d  working

  + new project

  ────────────────────────────────────────────────────────────────────────────
  l sign in · ↑↓ select · enter attach · ? shortcuts
```

### 2a. Authentication required, details open (`e`)

```text
  ◇ tokiwa  /  Workspace                                    ○ EC2 · signed out
  ────────────────────────────────────────────────────────────────────────────
  ▲ AWS sign-in expired                            l sign in · e hides details
    Live status unavailable. Last synced Nov 13 21:20 · 41h ago.
  ┌──────────────────────────────────────────────────────────────────────────┐
  │ Last synced   Nov 13 21:20 · 41h ago                                     │
  │ Affected      Workspace, Health, Spend                                   │
  │ Recovery      l runs tokiwa login in a local view                        │
  │                                                                          │
  │ sessions      --snapshot exit 1 · auth · 14:20                           │
  │ health        health exit 1 · auth · 14:20                               │
  │ spend         spend exit 1 · auth · 14:05                                │
  │                                                                          │
  │ Tokiwa: AWS authentication failed. Run aws sso login --profile           │
  │ profile-a.                                                               │
  └──────────────────────────────────────────────────────────────────────────┘
  Workspace  Health

  project-a · last known
  ›   worker-a  idle
    ...
```

### 2b. Sign-in in progress (the existing band text)

```text
  ◇ tokiwa  /  Workspace                                    ○ EC2 · signed out
  ────────────────────────────────────────────────────────────────────────────
  ▲ Signing in… finish in the browser          l shows the sign-in · e details
    Live status unavailable. Last synced Nov 13 21:20 · 41h ago.
  Workspace  Health
    ...
```

### 3. Temporarily unreachable (Workspace)

```text
  ◇ tokiwa  /  Workspace                                       ○ EC2 · offline
  ────────────────────────────────────────────────────────────────────────────
  ▲ AWS cannot be reached from this Mac                    u retry · e details
    Showing the last known state from 14:02 · 6m ago. Retrying every 30 s.
  Workspace  Health

  project-a · last known
  ›   worker-a  idle
    ◈ worker-b  needs you
      worker-c  idle

  project-b · last known
      worker-d  working

  + new project

  ────────────────────────────────────────────────────────────────────────────
  u retry · ↑↓ select · enter attach · ? shortcuts
```

### 4. One component failure (Health read fails, session reads work)

```text
  ◇ tokiwa  /  Health                                                    ● EC2
  ────────────────────────────────────────────────────────────────────────────
  Workspace  Health

  ▲ Health read failed: the reading is invalid             u retry · e details

  Workstation · from mac-a
    Instance:       i-0123456789abcdef0 · m7i.2xlarge · us-east-1
    Uptime:         3d 4h 12m · at 14:02
  Spend (estimate)
    Spent so far:   $41.20 of $300 budget
  Workbench limits · last known
    CPU             ━━━━━━━━━╸────────────────────────────  25% of 6 cores
    Memory          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸──────  20.0 of 24.0 GiB
  Storage · last known
    State disk      ━━━━━━━━━━╸───────────────────────────  142.3 of 500.0 GiB
    ...
  Sampled 14:02:31 · 6m ago · last known
  ────────────────────────────────────────────────────────────────────────────
  u retry · w sessions · ? shortcuts
```

### 5. Last known data (Health during the expired sign-in)

```text
  ◇ tokiwa  /  Health                                       ○ EC2 · signed out
  ────────────────────────────────────────────────────────────────────────────
  ▲ AWS sign-in expired                                  l sign in · e details
    Live status unavailable. Last synced Nov 13 21:20 · 41h ago.
  Workspace  Health

  Workstation · from mac-a
    Instance:       i-0123456789abcdef0 · m7i.2xlarge · last known
    Uptime:         3d 4h 12m · at Nov 13 21:20
  Spend (estimate · last known)
    Spent so far:   $41.20 of $300 budget
    Forecast:       $212.00 · 71% of budget
  Workbench limits · last known
    CPU             ━━━━━━━━━╸────────────────────────────  25% of 6 cores
    Memory          ━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━╸──────  20.0 of 24.0 GiB
    Tasks           ━━────────────────────────────────────  212 of 4096
  Storage · last known
    State disk      ━━━━━━━━━━╸───────────────────────────  142.3 of 500.0 GiB
    ...
  Sampled Nov 13 21:20:34 · 41h ago · last known
  ────────────────────────────────────────────────────────────────────────────
  l sign in · w sessions · ? shortcuts
```

### 5a. Unavailable: no reading since the app started

```text
  Spend (estimate)
    Spent so far:   not read
    Forecast:       not read
  Workbench limits
    CPU             not read
    ...
  Waiting for the first health reading
```

### 6. Recovery: the sign-in worked and one session read is live; the output glyphs return with the second read 5 s later

```text
  ◇ tokiwa  /  Workspace                                                 ● EC2
  ────────────────────────────────────────────────────────────────────────────
  Workspace  Health

  project-a
  ›   worker-a  idle
    ◈ worker-b  needs you
      worker-c  idle

  project-b
      worker-d  working

  + new project

  ────────────────────────────────────────────────────────────────────────────
  ↑↓ select · enter attach · ? shortcuts
```

### 6a. The same moment in Health: sessions are live, Health and Spend are still last known

```text
  ◇ tokiwa  /  Health                                                    ● EC2
  ────────────────────────────────────────────────────────────────────────────
  Workspace  Health

  Workstation · from mac-a
    Instance:       i-0123456789abcdef0 · m7i.2xlarge · last known
  Spend (estimate · last known)
  Workbench limits · last known
    CPU             ━━━━━━━━━╸────────────────────────────  25% of 6 cores
    ...
  Sampled Nov 13 21:20:34 · 41h ago · last known
  ────────────────────────────────────────────────────────────────────────────
  w sessions · ? shortcuts
```

## Verification

The tests for each part are in the plan. Before shipping, a capture script (`app/error-capture.ts`) draws the four states (authentication expiry, network failure, component failure, recovery) with OpenTUI's test renderer and a fake launcher, at the three capture sizes (156×40, 100×30, 62×24). The text frames go to `docs/superpowers/captures/2026-11-15-tui-error-states/` for review. A test asserts the key lines of each frame.

## Out of scope

- Category lines for launcher failures outside the AWS access check.
- A change to the host helper or to the MCP server's output.
- A new view, colour or glyph.
