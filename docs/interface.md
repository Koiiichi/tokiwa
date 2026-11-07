# Interface

The Tokiwa app is a terminal program on the Mac that lists the sessions on the host, attaches them in embedded terminal views and shows the health of the host.
It does not run models or read what a program in a session wants. A status glyph reports what the app observes: output, a quiet screen, a bell, an ended transport or ended processes.

For colours, spacing and the drawing of each part, see [DESIGN.md](../DESIGN.md). For projects and the actions on them, see [Sessions and projects](sessions-and-projects.md).

## Screen layout

The screen has a header, a navigation row, a body and a footer. At 100 columns and wider, the Workspace body holds the session list and up to two terminal views side by side.

```
┌────────────────────────────────────────────────────────────────┐
│ ◇ tokiwa  /  Workspace                 <mac> → EC2 · connected │ header
├────────────────────────────────────────────────────────────────┤
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
| Navigation | `Workspace` and `Health`. An error shows after them in amber. In focus mode, the strip of the other sessions shows here. |
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

The status at the right names this Mac and the link to the host, for example `<mac> → EC2 · connected`. When the header is narrow, only `EC2 · connected` shows. The state comes from the last session read and the last Health read.

| State | Meaning |
| --- | --- |
| `connecting` | No read has ended yet, and a read runs. Before the first read starts, the status names only the link. |
| `connected` | The last read succeeded less than 90 seconds ago. |
| `reconnecting` | The last successful read is more than 90 seconds old. Amber. |
| `offline` | The last read failed. Amber. |

With the pointer over the status, a card shows the connection:

| Row | Content |
| --- | --- |
| `ping` | The time of the last TCP connection to the Session Manager endpoint on port 443, the average and the jitter over the last 20 tries. |
| `loss` | The share of the last 20 tries that failed or took more than 3 seconds. |
| `sessions` | The remote views open in this app, and the sessions on the host. |

Session Manager carries no ICMP, so a try is a TCP connection. The app makes a try at start, then one every 15 seconds while it runs. When the card opens and the last try is more than 5 seconds old, the app makes a new try.

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
| `…` at the end of a name | The name is longer than its column. Names give way first. |

When the list is empty, it says why:

| Text | Meaning |
| --- | --- |
| `Reading sessions…` | The first read has not ended. |
| `No sessions on EC2` | The read succeeded and the host has no sessions. |
| `Sessions not available` | The read failed. The reason follows, and `u reads them again`. |
| `Last read failed` | Above a list: the last read failed, and the list shows the earlier read. |

## Status glyphs

Each session row starts with one glyph. The footer explains the glyph of the row under the pointer, and the Status group of the shortcuts sheet lists them.

| Glyph | Colour | Meaning |
| --- | --- | --- |
| `◆` | Mint, throbs | Output. An attached view printed in the last 2 seconds, or a pane screen changed between the last two snapshots of the session. |
| `◇` | Dim | Quiet. No pane screen changed since the last read. |
| `◈` | Amber | Needs you. A window of the session rang the bell while no client viewed it. |
| `○` | Amber | Disconnected. The connection of this app's view dropped. After a minute the row shows the session on the host again. Enter attaches it again. |
| `·` | Dim | Exited. Every pane of the session ended, or a local shell ended. |
| (empty) | — | No reading yet, or the snapshot did not include the pane activity. |
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

With the pointer over a session row, the footer explains the state of that row, for example `◈ needs you · codex rang the bell while no client viewed it`, and adds the clients attached elsewhere. It uses a short form when it is narrow.

The footer also shows short notices: the result of a copy, a saved screen, an ended session or an error. A program on the host can ask to open an http or https link in the Mac's browser. When you typed or clicked in its view in the last 5 seconds, the link opens at once. Otherwise the footer names the session and the link for 15 seconds and offers `open` and `copy`.

## Keyboard

A focused terminal receives every key except Ctrl+K, Ctrl+Shift+C and Cmd+C. Outside a terminal, each action has one key. Ctrl+K opens the search from every view, also inside a terminal.

The Session keys act on the selected row while the list has the keyboard, and on the active view otherwise. An action that does not apply does nothing, for example Reconnect without an attached session. The key map is in [`shortcuts.ts`](../app/shortcuts.ts).

### Workspace

| Key | Action |
| --- | --- |
| `w` | **Sessions**: show the Workspace with the keyboard in the session list. |
| `h` | **Health**: show the Health view. |
| `z` | **Focus**: hide the session list beside the terminal, or show it again. |
| `u` | **Refresh sessions**: read the session snapshot again. |
| `l` | **Sign in to AWS**: when the sign-in has expired, run `tokiwa login` in a local view. Your browser opens for the approval. After a success the view closes and the sessions are read again; after a failure the view stays open with the message. At other times the key does nothing. |
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

While the terminal is in view, the navigation row shows the sessions that no view shows, for example `◆ build · ◈ codex · 4 quiet`. Sessions with output and sessions that need you show by name. The rest are counted by state. When the line is too long, the counts join as `N more`, and then the output names join them. The names of sessions that need you stay. An error takes the place of the strip.

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

While a remote shell starts, a `new shell` pane holds its place and says `opening a shell in <directory> · <seconds>s`. In a single view, the title of the source says `· opening a shell`. When the app cannot find the new session in the snapshots, the navigation row shows an error. With four views open, the navigation row asks you to close a view first.

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
| **Copy selection** in the search | Copy the selection that existed when the search opened. |

The app copies through OSC 52. When the terminal refuses, the footer says `copy failed · the terminal did not accept it`. With nothing selected, it says `nothing selected · drag over text, then copy`.

Cmd+C reaches the app only when Ghostty passes it on. Add this line to the Ghostty configuration, so that Ghostty keeps Cmd+C only while it has its own selection:

```
keybind = performable:super+c=copy_to_clipboard
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
- [DESIGN.md](../DESIGN.md)
