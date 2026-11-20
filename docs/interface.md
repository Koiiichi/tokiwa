# Interface

The Tokiwa app is a terminal program on the Mac that lists the sessions on the host, attaches them in embedded terminal views and shows the health of the host.
It does not run models or read what a program in a session wants. A status glyph reports what the app observes: output, a quiet screen, a bell, an ended transport or ended processes.

For projects and the actions on them, see [Sessions and projects](sessions-and-projects.md).

## Screen layout

The screen has a header, a problem band of two rows while the link fails, a navigation row, a body and a footer. At 100 columns and wider, the Workspace body holds the session list and up to two terminal views side by side.

```
┌────────────────────────────────────────────────────────────────┐
│ ◇ tokiwa  /  Workspace                      ○ EC2 · signed out │ header
├────────────────────────────────────────────────────────────────┤
│ ▲ AWS sign-in expired                    l sign in · e details │ problem band
│   Live status unavailable. Last synced 13:08 · 6m ago.         │
│ Workspace  Health                                              │ navigation
├───────────────────────┬──────────────────┬─────────────────────┤
│ api                   │ claude-main  api │ shell-1a2b3c4d  api │
│ ▎ ◆ claude-main       │                  │                     │
│   └ ◇ shell-1a2b3c4d  │ terminal         │ terminal            │ body
│                       │                  │                     │
│ web                   │                  │                     │
│ › ◈ codex  needs you  │                  │                     │
├───────────────────────┴──────────────────┴─────────────────────┤
│ one line of controls for the context                           │ footer
└────────────────────────────────────────────────────────────────┘
```

| Part | Content |
| --- | --- |
| Header | The breadcrumb `◇ tokiwa  /  Workspace` or `◇ tokiwa  /  Health`, and the state of the link to the host at the right. |
| Problem band | Only while a failure of the whole link is active: two rows with the cause, the age of the last good read and the key that acts on it. See [Problem band](#problem-band). |
| Navigation | `Workspace` and `Health`. In focus mode, the strip of the other sessions shows after them. The row shows no error. |
| Body | The Workspace or the Health view. The shortcuts sheet and the search take its place while they are open. |
| Footer | One line of controls for the current context. |

## Views

| View | Content |
| --- | --- |
| Workspace | The session list and the terminal views. The app opens on this view with the keyboard in the session list, unless `--attach` names a session. |
| Health | The instance, the spend estimate, the workbench limits, storage and network. See [Health](health.md). |

Each terminal view keeps its PTY and its screen while another view or the Health view shows. The app keeps at most four terminal views, including views whose process ended. Only **Close pane** (`c`) removes a view.

Until a session is attached, the right side shows `No session attached`, a line on how to attach one, and `t opens a local shell · ? shortcuts`. No shell starts by itself.

### Header

The breadcrumb names the view. Until the first session read of the host ends, its diamond cycles through `◇ ◈ ◆ ◈`. With `TOKIWA_REDUCED_MOTION=1` it stays still.

The status at the right shows the link to the host as a dot, for example `● EC2`. A state other than `connected` follows the dot as a word. The word shows the link first (`signed out`, `offline`), then the workstation (`stopped`, `not ready`). A read that failed for its own reason, for example an invalid Health response, never changes the word. Health names this Mac in its Workstation section.

| Status | Meaning |
| --- | --- |
| `◌ EC2 · connecting` | No read has ended yet, and a read runs. Before the first read starts, the status is `◌ EC2`. |
| `● EC2` | A session read or a Health read succeeded less than 90 seconds ago. |
| `◐ EC2 · reconnecting` | The newest successful read is more than 90 seconds old. Amber. |
| `○ EC2 · signed out` | A failure of the whole link is active, and the AWS sign-in expired. Amber. |
| `○ EC2 · offline` | A failure of the whole link is active, and AWS did not answer: the network failed, a read timed out, or a request failed after the sign-in check. Amber. |
| `○ EC2 · stopped` | The launcher found the workstation in a state other than running. Amber. |
| `○ EC2 · not ready` | The workstation runs, and its workbench check returned Failed. Amber. |

A failure of the whole link is active while it is later than the newest good read of any source: one good read clears it. The exception is a stopped or not-ready workstation, which only a good session read or Health read clears, because a spend read works on a stopped host. A failure of one source stays with that source until that source reads well.

A click on the status opens a card about the connection. A second click on the status, a click elsewhere or `esc` closes it. Its first line names this Mac and the link, for example `<mac> → EC2 · connected`.

| Row | Content |
| --- | --- |
| `ping` | The time of the last TCP connection to the Session Manager endpoint on port 443, the average and the jitter over the last 20 tries. |
| `loss` | The share of the last 20 tries that failed or took more than 3 seconds. |
| `sessions` | The remote views open in this app, and the sessions on the host. |

Session Manager carries no ICMP, so a try is a TCP connection. The app makes a try at start, then one every 15 seconds while it runs. When the card opens and the last try is more than 5 seconds old, the app makes a new try.

### Problem band

While a failure of the whole link is active, one band of two rows under the header names the problem. The band shows on every view. The first row is the title with its keys at the right. The second row is dim: what the failure means and the age of the last good read, for example `Nov 13 21:20 · 41h ago`. A time on another day carries its date, and an age from 48 hours counts days. When several failures are active, the band names the cause that explains the others: a setup problem first, then an expired sign-in, then a network failure, then a stopped workstation, then a workbench that is not ready.

| First row | Second row | Cause | Key |
| --- | --- | --- | --- |
| `▲ AWS sign-in expired` | `Live status unavailable. Last synced {when}.` | The launcher reported that the AWS sign-in expired or did not complete. | `l` signs in. While the sign-in runs, the band is one row: `Signing in… finish in the browser`. After the sign-in, the band says `▲ Refreshing…` with `Signed in. Reading the workstation again.` until a fresh read succeeds; if that read fails, the band names the failure again with `The refresh after sign-in failed.`, and the last known state stays. |
| `▲ AWS cannot be reached from this Mac`, `▲ An AWS request failed`, `▲ An AWS request did not finish` | `Showing the last known state from {when}. Retrying every 30 s.` | The launcher reported a network failure in its AWS access check, a read took longer than 90 seconds, a request failed after the access check passed, or the workbench check ended with a status other than Failed. The workstation state is unknown. | `u` retries. |
| `▲ The workstation is stopped` | `Start it in AWS, then press u. Last synced {when}.` | The launcher found the host in another state than running, for example `stopped`. | `u` retries. |
| `▲ The workbench server is not ready` | `Tokiwa retries every 30 s. Last synced {when}.` | The workbench check on the host returned Failed. | `u` retries. |
| `▲ The launcher is not installed`, `▲ The launcher is older than the app`, `▲ The host settings need a fix` (critical tone) | The explanation of the failure, with the fix. | The launcher is missing or too old for the app, or the host settings file is wrong. | Only `e`. |

`{when}` is the time of the newest good read of any source with its age. When no read has worked yet, the second row says `Nothing was read yet.` in its place.

A read that failed for its own reason has no band. One amber line sits at the top of the view of that source: `▲ Sessions read failed: <first line>` at the top of the session list, and `▲ Health read failed: <first line>` at the top of Health, each with `u retry · e details` at the right. The first line is the first line of output, without the launcher prefix and without shell warnings about a removed folder. While the band shows, these lines do not show. A failed Spend read stays in the Spend rows.

Each key hint at the right of the band is also a button. A click on `l sign in` signs in, and a click on `u retry` reads again, also while a terminal view has the keyboard. A click on `e details` opens or closes the details box.

`e`, or a click elsewhere on the band, opens one details box under it; `e` closes it. For a failure of one source, the box opens under the header with no band row. The box holds, in this order:

```
┌──────────────────────────────────────────────────────────────────────────┐
│ Last synced   Nov 13 21:20 · 41h ago                                     │
│ Affected      Workspace, Health, Spend                                   │
│ Profile       profile-a                                                  │
│ Recovery      l signs in, or run aws sso login --profile profile-a       │
│                                                                          │
│ sessions      --snapshot exit 1 · auth · 14:20                           │
│ health        health exit 1 · auth · 14:20                               │
│                                                                          │
│ Tokiwa: AWS authentication failed. Run aws sso login --profile           │
│ profile-a.                                                               │
└──────────────────────────────────────────────────────────────────────────┘
```

The facts come first. For an expired sign-in, `Profile` names the `profile=` of the host settings file, and `Recovery` gives the command that signs in without the app; without a profile, `Recovery` says `l signs in in a local view`. Then one row per failed source gives its launcher command, exit code, the category or kind, and the time. Then one copy of the launcher's own text, the last six lines, without the `Launcher … exited N:` prefix. Recovery is tracked for each source. After a sign-in succeeds, or when a read of any source succeeds while a failure of the whole link is active, the app reads each source that is not live at once: the sessions, Health, and spend in that Health read. The band clears when one source succeeds. Each source stays `last known` until its own read succeeds. The details box closes, and a bottom-bar notice about the cleared failure ends. A failure notice also ends when the same action succeeds on a retry. The app also writes each new failure, to the error log with its source, kind, command, exit code and raw message. See [Files](configuration.md#files).

## Session list

The session list is a tree of projects. The app reads the session snapshot through the launcher when the Workspace opens, again after 5 seconds, and then every 30 seconds while the Workspace is in view. Reads pause while Health is in view. One read runs at a time. `u` reads the snapshot at once.

| Entry | Form |
| --- | --- |
| Project title | Bold. A nested project indents two cells for each level of its name path. A directory label shows its last two path parts. |
| Session row | A two-cell bar column, the indent, the status glyph, the name, the count of other clients, then a dim word for a state that needs an action. |
| Child session | A session opened with **Shell here**. It follows its source with `└` and indents two more cells. |
| Local shells | At the end, under the `name` of [`projects.json`](../app/projects.json). |
| `+ new project` | After the last project. A click asks for the name of a new project. |

Top-level projects follow the order that you set by drag, then sort by name. A blank line separates top-level projects. Inside a project, sessions sort by name, and subprojects follow the sessions.

| Mark | Meaning |
| --- | --- |
| `▎` in the bar column, accent name | The session in the pane. The bar dims while its terminal has the keyboard. |
| `›` and the selection band | The selected row, while the list has the keyboard. |
| `¹` to `⁹`, then `⁹⁺` | The clients attached elsewhere. The count leaves out this app's own client while its transport is open. |
| `attaching` | The app attaches the session now. |
| `◈ starting`, the glyph throbs | The workstation creates the session now. The row holds its place in the project. |
| `shell` | A shell is the foreground program of every pane: no other program, for example no agent, runs in the session. |
| `working`, `idle` | The state that the agent in the session last reported: a turn runs, or the turn ended. See [Agent state](host.md#agent-state). |
| `◈ waiting` | The agent waits on a question or an approval: the row needs you until the agent moves on. |
| `limited`, `error` (amber) | The agent stopped on a rate or usage limit, or on another error. |
| `frozen` | `tokiwa freeze` holds the session's processes. It takes the place of the agent's state, which is then out of date. |
| `…` at the end of a name | The name is longer than its column. Names give way first. |

When the list is empty, it says why:

| Text | Meaning |
| --- | --- |
| `Reading sessions…` | The first read has not ended. |
| `No sessions on EC2` | The read succeeded and the host has no sessions. |
| `No sessions read` | The read failed. The problem band, or the line at the top of the list, names the cause. The list adds `l signs in` after an expired sign-in, or `u reads them again` after another failure of the whole link. It adds no key when its own line says `u retry`, or when the failure is a setup failure. |

When a read fails and the list holds an earlier read, the list keeps it. The problem band, or the line at the top of the list, names the failure. While the list shows an old read, each top-level project title whose rows come from that read ends with `· last known` in the dim tone. A read in progress hides the mark only when the data is old by age; after a failed read the mark stays until a read succeeds. The local group never does.

## Status glyphs

Each session row starts with one glyph. The footer explains the glyph of the row under the pointer, and the Status group of the shortcuts sheet lists them.

| Glyph | Colour | Meaning |
| --- | --- | --- |
| `◆` | Mint, throbs | Output. An attached view printed in the last 2 seconds, or a pane screen changed between the last two live snapshots of the session. |
| `◇` | Dim | Quiet. No pane screen changed since the last read. |
| `◈` | Amber; dim on a row of a stale snapshot with no connected view | Needs you. A program in the session ran `tokiwa-attention`, or a window rang the bell while no client viewed it. Bringing the session forward clears it; an attach anywhere clears the mark of `tokiwa-attention`, and `tokiwa-attention --clear` clears it from inside. |
| `○` | Amber | Disconnected. The connection of this app's view dropped. After a minute the row shows the session on the host again. Enter attaches it again. |
| `·` | Dim | Exited. Every pane of the session ended, or a local shell ended. |
| (empty) | — | No reading yet, the snapshot did not include the pane activity, or the snapshot is not live (a read failed or is older than 90 s). A row with an attached, connected view keeps its own glyph, and `◈` stays. After a stale period, `◆` and `◇` return only after two live reads, 5 s apart. |
| `¹` | Dim | After the name: the number of clients attached elsewhere. |

`exited` takes precedence over `needs you`, and `needs you` over the other states. The output glyph throbs in four frames of 320 ms. With `TOKIWA_REDUCED_MOTION=1` it stays still in mint.

`needs you` reports the tmux bell flag of the session; see [Host](host.md). When you attach the session in this app, the list hides its bell until a snapshot reports the session without a bell.

## Footer

The footer is one line of controls for the current context. A control highlights under the pointer and runs on a click. A dim hint, for example `↑↓ select`, does nothing. A click on a control keeps the keyboard and the text selection where they are.

| Context | Footer |
| --- | --- |
| A terminal has the keyboard | `detach ctrl+k d · focus ctrl+k z · sessions ctrl+k w · shortcuts ctrl+k ?` (`detach` only for a remote session) |
| The list has the keyboard | `↑↓ select · enter attach · esc terminal · z focus · ? shortcuts` (`esc terminal` and `z focus` only with a view open) |
| The list is empty | `u refresh · t local shell · ? shortcuts` |
| Health | `↑↓ scroll · w sessions · ? shortcuts` (`↑↓ scroll` only when the view does not fit) |
| Search | `↑↓ select · enter open · esc close`; for a prompt, `enter confirm · esc cancel` |
| Shortcuts sheet | `↑↓ scroll · esc close` (`↑↓ scroll` only when the sheet does not fit) |

Inside a terminal a control is its label then its chord. Elsewhere it is its key then its label. When the line is too long, the hints that are not controls go first, then the key labels, then the least important controls. One control always stays.

With the pointer over a session row, the footer explains the state of that row, for example `◈ needs you · codex asked for a person, or rang the bell while no client viewed it`, and adds the clients attached elsewhere. The glyph is dim, not amber, for a stale `needs you` row with no connected view. It uses a short form when it is narrow.

The footer also shows short notices: the result of a copy, a saved screen or an ended session. A failed action shows as `<action> failed · <cause>`, for example `attach worker-a failed · AWS sign-in expired`, for 8 seconds. A program on the host can ask to open an http or https link in the Mac's browser. When you typed or clicked in its view in the last 5 seconds, the link opens at once. Otherwise the footer names the session and the link for 15 seconds and offers `open` and `copy`.

## Keyboard

A focused terminal receives every key except Ctrl+K, Ctrl+Shift+C, Cmd+C and Cmd+V. Outside a terminal, each action has one key. Ctrl+K opens the search from every view, also inside a terminal.

The Session keys act on the selected row while the list has the keyboard, and on the active view otherwise. An action that does not apply does nothing, for example Reconnect without an attached session. The key map is in [`shortcuts.ts`](../app/shortcuts.ts).

### Workspace

| Key | Action |
| --- | --- |
| `w` | **Sessions**: show the Workspace with the keyboard in the session list. From Health, `w` returns to the terminal that had the keyboard when Health opened, if that view still runs; a second `w` then reaches the list. |
| `h` | **Health**: show the Health view. |
| `z` | **Focus**: hide the session list beside the terminal, or show it again. |
| `u` | **Refresh and retry**: read the sessions now; read Health and spend again when they are not live. |
| `l` | **Sign in to AWS**: when the sign-in has expired, run `tokiwa login` in a local view. Your browser, or the program in [`TOKIWA_SIGN_IN_BROWSER`](configuration.md#environment-variables) when it is set, opens for the approval. After a success the view closes, and the sessions and Health are read again; after a failure the view stays open with the message. At other times the key does nothing. |
| `e` | **Error details**: open or close the details box of the active failure under the header. With no failure, the key does nothing. |
| `t` | **New local shell**: start a local login shell in the home directory. |
| `g` | **Local shell group**: start the shells that `projects.json` names. |
| `b` | **Background sessions**: open or close the background list. In the list, `enter` opens the selected session view only and `x` ends it, after a question. With no background session, the key does nothing. |
| `?` | **Keyboard shortcuts**: open the shortcuts sheet. |
| `q` | **Quit**: close the app. Remote sessions keep running on the host. Local shells end, so when a program runs in one, the app asks first. |

### Session

| Key | Action |
| --- | --- |
| `↑` `↓` | **Select session**. The selection wraps at the ends of the list. |
| `enter` | **Attach** the selected session, or bring its open view forward. |
| `esc` | **Back to terminal**: give the keyboard back to the active view. |
| `r` | **Reconnect**: close the transport, check the session identity and start a new transport. |
| `d` | **Detach** the remote session. The view closes, and the keyboard goes to the list on its row. On the view of a dropped connection, `d` closes the view. |
| `p` | **Move to project**: the search asks for a name path such as `team/api`. |
| `x` | **End session**: the row asks first. See [Ending a session](#ending-a-session). On a local shell, `x` closes it, and asks first only when a program runs in it. |

### Terminal

| Key | Action |
| --- | --- |
| `ctrl+k` | **Search** sessions and actions. Press it again to close the search. |
| `ctrl+shift+c` | **Copy selection**. |
| `ctrl+b r` | **Redraw terminal**: the tmux key for `refresh-client`. It reaches tmux from inside a terminal. |
| `ctrl+k d` | **Detach**: a quick key of the search. |
| `ctrl+k z` | **Focus**: a quick key of the search. |
| `ctrl+k w` | **Sessions**: a quick key of the search. |
| `ctrl+k ?` | **Shortcuts**: a quick key of the search. |
| `n` | **Shell here**: open a second shell beside the active view, in the folder of the session. |
| `]` | **Other pane**: move the keyboard to the other of two views. |
| `c` | **Close pane**: close the second view. Its remote shell keeps running. |
| `o` | **Open in Ghostty**: open a new shell of the active session in a Ghostty window (macOS). |

### Health

| Key | Action |
| --- | --- |
| `↑` `↓` | **Scroll** one line, when the view does not fit. |
| `pgup` `pgdn` | **Scroll a page** of 10 rows. |

### Other keys

| Key | Where | Action |
| --- | --- | --- |
| `cmd+c` | Everywhere, when Ghostty passes it on | Copy selection. |
| `ctrl+c` | Search, shortcuts sheet, session list | Close the search or the sheet; in the list, back to terminal. |
| `esc`, `?` | Shortcuts sheet | Close the sheet. |
| `↑` `↓`, `pgup` `pgdn` | Shortcuts sheet | Scroll the sheet. |
| `enter`, `s`, `esc` | A row asks to end a session | End it, keep its shells, or keep it. |

## Shortcuts sheet

`?` opens the sheet in place of the body. It lists every binding of the key map in four columns of groups when they fit, else two, else one, with a Status group for the glyphs. A row whose action applies now is a control: it highlights under the pointer, and a click closes the sheet and runs the action. A quick-key row runs the action of its plain key.

## Mouse

| Target | Pointer action | Result |
| --- | --- | --- |
| `Workspace` or `Health` in the navigation row | Click | Show that view and close the sheet. `Workspace` gives the keyboard to the list. |
| Header status | Pointer over | Show the connection card. |
| `l sign in` or `u retry` in the problem band | Click | Sign in, or read again. It works also while a terminal view has the keyboard. |
| Problem band elsewhere | Click | Open or close the details box. |
| Session row | Click | Attach the session on release, or bring its view forward. |
| Session row of a remote session | Second press within 400 ms | Ask for a new name for the session. |
| Session row | Pointer over | Show the hover band and `×` at the end; the footer explains the state. |
| `×` on a session row | Click | Ask to end the session. |
| Session row | Drag onto a project title | Move the session to that project. |
| Project title | Pointer over | Show `+` (new session in the project) and `×` (end the project). |
| Project title | Double click | Ask for a new name for the project. |
| Project title | Drag onto another title, onto `Workspace`, or onto the blank line between top-level projects | Nest the project, make it top-level and first, or reorder it. |
| Sidebar outside a row | Click | Give the keyboard to the list, on the row of the view in the pane. |
| Terminal view or its title | Click | Give the keyboard to that terminal. |
| `×` at the end of a view title | Click | Ask to end the remote session of the view. It shows while the pointer is over the view. |
| Footer control | Click | Run the control. |
| Shortcuts sheet row | Click | Close the sheet and run the action, when it applies now. |
| Search result | Click | Run the result. |

When a terminal does not have the keyboard, the first click on it only moves the keyboard. The program in the terminal does not receive that click, so it cannot select a menu option by accident. The next click goes to the program.

Project drags and their effects are in [Sessions and projects](sessions-and-projects.md). No text selection starts in the session list, the footer or a title, so a drag from a session name moves the session.

## Search

Ctrl+K opens the search in a 56-cell panel. Below 70 columns it fills the width. The input starts after `›`.

An empty input lists common actions under the titles Session, Go to, Terminal and Tokiwa, at most three each, and only those that apply now. Typed text lists every session and every action that matches. Sessions come first, with the project at the right. An action with a key shows the key at the right. Within each category, a label that starts with the text comes first, then a label with a word that starts with it, then a label that contains it. The category titles show only when more than one category matches.

`↑` `↓` move over the results, `enter` runs the selected result, a click runs a result, and `esc` closes the search.

### Quick keys

On an empty input, the first keystroke runs a quick key at once. Any other first keystroke starts a search, and from then on every key is search text. Until the first keystroke, the right column shows only the quick keys that apply now, in mint.

| Key | Action | Applies when |
| --- | --- | --- |
| `d` | Detach | A remote session with an open transport is in the pane. |
| `z` | Focus | A view is open. |
| `w` | Sessions | Always. |
| `?` | Shortcuts | Always. |

Ctrl, Alt, Meta and Shift never run a quick key. `?` is the one exception for Shift.

### Search-only actions

These actions have no key.

| Action | Category | Effect |
| --- | --- | --- |
| Repaint view | Terminal | See [Save screen and Repaint view](#save-screen-and-repaint-view). |
| Save screen | Terminal | See [Save screen and Repaint view](#save-screen-and-repaint-view). |
| New project | Session | Ask for a project name, then make its folder and a first session. |
| New session in project | Session | Ask for a session name in the project of the selected row. |
| Rename session | Session | Ask for a new name. |
| End project | Session | Name its sessions and ask, then end them and forget the project. |

The search box also holds the prompts of these actions and of **Move to project**. Enter confirms and esc cancels. A failure shows under the input.

## Focus mode

`z`, or **Focus** in the search, hides the session list beside the terminal, so the terminal takes the full width. Do the same again to show the list. In focus mode the list and the terminal take the full width in turn: `w` shows the list, and `enter` or `esc` returns to the terminal.

While the terminal is in view, the navigation row shows the sessions that no view shows and that need you, for example `◈ codex waiting · 3 working`. A session needs you when it rang the bell, asked for a person, or its agent reported `waiting`, `limited` or `error`; it shows by name, with the agent's word; its glyph is dim when the snapshot is stale and no view is connected. The agents that report `working` are one count. Other sessions are left out. When the line is too long, the count goes first, then the names after the first join as `N more`. An error of an action does not take its place; it shows as a notice in the footer.

## Layouts by terminal size

| Condition | Layout |
| --- | --- |
| 100 columns or wider, `--layout workspace`, focus mode off | The list stands beside the views. It is 28 % of the width, from 36 to 44 cells. |
| Narrower than 100 columns, `--layout terminal`, or focus mode | The list and the active view take the full width in turn. The list shows while it has the keyboard. |
| Two views, 110 columns or wider | The views stand side by side. |
| Two views, 76 to 109 columns and 28 rows or more | The views stack. A rule parts them. |
| Two views, smaller | Only the active view shows. `]` switches to the other. |
| Narrower than 70 columns | The side padding is one cell, and the search fills the width. |

[`paneLayout`](../app/workspace.ts) chooses the layout of two views from the size of the whole terminal. A resize reaches the PTY of each view. For a remote view, the app asks tmux to redraw one second after the size settles; see [Transport](transport.md).

## Shell here and the child shell

`n` opens a second shell beside the active view, or under it when the views stack. When the active view already has a second view, `n` moves the keyboard to it.

| Source | New shell |
| --- | --- |
| Remote session | The host creates a new tmux session in the current directory of the source, named `shell-` and eight characters, through `tokiwa new NAME --from SOURCE`. The app checks its identity in the next snapshots before the view takes the keyboard. |
| Local shell | A new local shell starts in the directory where the source shell started. |

While a remote shell starts, a `new shell` pane holds its place and says `opening a shell in <directory> · <seconds>s`. In a single view, the title of the source says `· opening a shell`. When the app cannot find the new session in the snapshots, the footer shows a notice. With four views open, the footer asks you to close a view first.

The new session lists under its source with `└`. When you attach a session that has child shells, its newest child shell reconnects beside it on a second connection, and the session keeps the keyboard. This does not happen when the layout shows a single view, when four views are open, when the session already has a second view, or when every pane of the child ended. The other children stay in the list.

`c` closes the second view. Its remote shell keeps running on the host.

## Local shells

A local shell runs on the Mac. `t` starts one named `shell-N` in the home directory.

| Property | Value |
| --- | --- |
| Command | `$SHELL -l`, or `/bin/zsh -l` when `SHELL` is unset or not executable. `TOKIWA_LOCAL_SHELL` replaces it. |
| Environment | The app's environment without the variables of the terminal around the app, such as `TERM_PROGRAM`, `TMUX` and `GHOSTTY_*`. `TERM=xterm-256color` and `COLORTERM=truecolor`. |
| Group | `g` starts each shell that [`projects.json`](../app/projects.json) names, at most three, under the group title. |
| End | A local shell that exits shows `·` in its row. Every local shell ends when you quit the app. |

See [Configuration](configuration.md) for the variables and the file.

## Ending a session

`x`, `×` on a session row, or `×` on the title of a remote view asks in the row and in the title of the view:

| Session | Question |
| --- | --- |
| Without child shells | `end NAME?  enter ends · esc keeps` |
| With child shells | `end NAME and N shells?  enter ends all · s keeps the shells · esc keeps` |

Each answer is also a control. Any other key withdraws the question and goes on to where you typed it, for example the terminal. A click on a terminal or in the list also withdraws it. While the session ends, the row says `ending NAME…`, and a second enter does nothing. The footer then says `ended NAME`, with the number of shells that ended.

The app ends a session through the launcher with its identity, so an old row cannot end a new session of the same name. The child shells are the sessions opened from it with **Shell here**. The effects on the host are in [Sessions and projects](sessions-and-projects.md).

## Copy and selection

| Action | Result |
| --- | --- |
| Drag in a terminal whose program does not report the mouse | The app selects the text. When the drag ends, the app copies it and the footer says `copied N characters`. |
| Drag in a program that reports the mouse, for example Claude Code, Codex or tmux with mouse mode on | The program receives the drag and draws its own selection. The app starts none. |
| A program writes the clipboard with OSC 52 | The app copies the text on the Mac and the footer says so. |
| Shift+drag | Ghostty's own selection, in any program. |
| `ctrl+shift+c` or `cmd+c` | Copy the current selection, or the last finished selection. |
| `cmd+v` | Paste an image from the Mac's clipboard into the focused remote view. The app sends the image to the host and types its path there as a bracketed paste. An image over 10 MB is refused. Text paste is not changed. |
| **Copy selection** in the search | Copy the selection that existed when the search opened. |

The app copies through OSC 52. When the terminal refuses, the footer says `copy failed · the terminal did not accept it`. With nothing selected, it says `nothing selected · drag over text, then copy`.

Cmd+C reaches the app only when Ghostty passes it on. Add this line to the Ghostty configuration, so that Ghostty keeps Cmd+C only while it has its own selection:

```
keybind = performable:super+c=copy_to_clipboard
```

Cmd+V reaches the app only when the clipboard holds no text. Add this line, so that Ghostty keeps Cmd+V for text:

```
keybind = performable:super+v=paste_from_clipboard
```

## Save screen and Repaint view

These search-only actions find which layer garbles a screen.

| Action | Effect |
| --- | --- |
| **Repaint view** | Draw every cell of the active view again from the emulator's copy of the screen. It sends nothing to tmux. The footer says `repainted from the view's own copy · tmux sent nothing`. |
| **Save screen** | Write the emulator's text of the active view to `~/.local/state/tokiwa/captures/<time>-<view>.txt`, or to `$TOKIWA_CAPTURE_DIR`. The file starts with the view name, the time, the emulator size, the cursor and the pane size. |
| **Redraw terminal** (`ctrl+b r`) | Ask tmux to draw the whole client again. In the search, it applies to a remote view with an open transport. |

When the text is right after **Repaint view**, the emulator held the right text and only the drawing was stale. Compare a saved screen with the screen and with `tmux capture-pane` on the host. The captures folder has mode 700 and each file mode 600, because the files hold session text.

## Related

- [Health](health.md)
- [Configuration](configuration.md)
- [Sessions and projects](sessions-and-projects.md)
- [Architecture](architecture.md)
- [Transport](transport.md)
- [Host](host.md)
