# app

The Tokiwa app: the terminal interface that `tokiwa` opens on the Mac. It is written in TypeScript for Bun and draws with OpenTUI.

| File | Contents |
| --- | --- |
| `app.ts` | The `App` class: views, the session list, terminal views, search, Health and the footer. `run` starts it. |
| `backend.ts` | `BackendClient`, which runs every host operation through the `tokiwa` launcher. |
| `pty.ts` | `PtyAdapter`: the local or remote transport of one terminal view. |
| `sessions.ts`, `search.ts`, `footer.ts`, `shortcuts.ts` | The session tree and glyphs, the search, the footer and the key map. |
| `health-view.ts`, `state.ts` | Health: its layout, `health.json` and the reading history. |
| `install.sh` | Installs a committed copy of this folder to `~/.local/lib/tokiwa/opentui`. |
| `*.test.ts`, `test_install.py` | The tests; `test-guard.ts` keeps them away from the launcher. |

[Development](../docs/development.md) explains how to run the app from a checkout and how to test it. [Interface](../docs/interface.md) describes what it shows.
