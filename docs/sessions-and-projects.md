# Sessions and projects

Tokiwa organizes the terminals on the workstation in a thin layer over tmux. It never changes a session's directory or moves its processes, so tools that keep their own history by directory, such as Claude Code (`~/.claude/projects/<directory>/`) and Codex, keep working as they do in a plain terminal. Tokiwa does not act on the program that a session runs: the snapshot names the command of each pane, and the app does not use it.

## The model

| Thing | What it is | Stored as | Lifecycle |
| --- | --- | --- | --- |
| Session | A tmux session on the workstation and the programs in it | The tmux session | Created with + or `tokiwa create`; runs until it is ended (`x` or ×, then enter) or a workstation restart ends it |
| Child session | A session opened from another one with **Shell here** (`n`) | `@tokiwa_parent` on the session: the tmux id of its source, for example `$4` | Listed under its source with `└`; a new attach of the source in Tokiwa reopens its newest child beside it when the window has room for two views; ending the source ends it too, unless `s` keeps it |
| Project | A name path, for example `studio/api`, that groups sessions; a project nests by its path | `@tokiwa_project` on each session, and an entry in `projects.json` on the workstation | Saved when a session is put in it; stays without sessions until it is forgotten |

A session without a project label belongs to the project of its directory. A label can also be an absolute directory, for example `/srv/development/state/workspaces/workbench/example`: `tokiwa project NAME DIRECTORY` sets one, and **Shell here** from a source without a label sets the source's directory as the label of the new shell. The list shows such a project by the last two parts of the directory, at the top level, until it is moved. A directory label is not saved in `projects.json`.

`projects.json` is in `~/.tokiwa/` of the workbench user on the workstation (folder mode 700, file mode 600). Each entry holds the default folder of the project, where + starts a new session. The order of the top-level projects is display-only and kept on the Mac in `~/.local/state/tokiwa/project-order.json`.

## What each action does

| Action | In the interface | From the command line | Effect |
| --- | --- | --- | --- |
| New session in a project | + on the project title, or Ctrl+K → New session in project | `tokiwa create NAME --dir DIR --project PROJECT` | Starts a shell in the project's folder; an empty name takes the project's last name |
| New project | **+ new project** at the end of the list, or Ctrl+K → New project | `tokiwa create NAME --folder FOLDER --project PROJECT` | Makes the folder in `workbench/` if it is new and starts a first session there. Sessions can write project files only inside `workbench/` (see [What a session can write](host.md#what-a-session-can-write)), so new folders go there |
| Move a session | Drag its row onto a project title, or `p` | `tokiwa project NAME PROJECT` | Changes the label; a new project name is also saved, with the session's folder |
| Nest a project | Drag its title onto another project title; onto Workspace for the top level | `tokiwa move-project FROM TO` | Rewrites the labels of its sessions and of the projects inside it |
| Reorder projects | Drag a project title onto the blank line between two top-level projects; onto Workspace to put it first | — | Changes only the order in Tokiwa |
| Rename a project | Double-click its title | `tokiwa move-project OLD NEW` | Rewrites the labels; sessions, folders and history stay |
| Rename a session | Double-click its row (a single click attaches it), or Ctrl+K → Rename session | `tokiwa rename NAME NEW IDENTITY` | Renames only the session with that identity; its project, child shells and open view stay |
| End a session | `x`, × on its row, or × on its view's title; the row asks, enter ends, `s` keeps its shells, esc or any other key keeps it | `tokiwa` `--end-confirmed NAME IDENTITY` | Ends the session and the programs in its panes; a process that detached from them keeps running until the service stops. In the app, it also ends the session's child sessions unless `s` keeps them; `--end-confirmed` ends one session |
| End a project | × on the project title, or Ctrl+K → End project, then type its name | `tokiwa forget-project PROJECT` (after its sessions end) | Ends its sessions and forgets the project; its folders and the tools' history stay |
| Prompt name | — | `tokiwa name NAME` | New shells show `NAME:directory$`; `tokiwa` by default |

## What Tokiwa does not do

- It does not move a running process between sessions.
- It does not change a session's working directory when the session moves to another project.
- It does not delete folders or files when a session or a project ends.
