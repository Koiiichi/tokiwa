# Development

This page tells how to work on the Tokiwa repository: where the code is, how to run the app from a checkout, how to run the tests and how to install a change on the Mac. It does not cover the installation of the host; see [Host](host.md).

## Repository layout

| Folder or file | Contents |
| --- | --- |
| [`app/`](../app/) | The terminal app on the Mac (Bun, OpenTUI Core): `app.ts` (the interface), `backend.ts` (calls to the launcher), `mcp.ts` (the MCP server for local agents), `pty.ts` (the transport process of each terminal view), `sessions.ts`, `health-view.ts`, `shortcuts.ts`, `search.ts` and the other modules, their `*.test.ts` files, `run`, `install.sh` and `test_install.py` |
| [`bin/tokiwa`](../bin/tokiwa) | The launcher on the Mac: every AWS call and host command, and `tokiwa` without a command opens the app |
| [`host/`](../host/) | The host side: `units/`, `start-workbench.sh`, `terminal-session.sh`, `workbench-health.py`, `workbench-files.py`, `tokiwa-open`, the rootless engine files, the host installer, `compose/` and `tests/` |
| [`docs/`](./) | These pages, and `images/` |
| [`DESIGN.md`](../DESIGN.md) | The colours, layout and components of the interface |
| [`PRODUCT.md`](../PRODUCT.md) | The users and the purpose of the product |

## Run the app from the checkout

The app needs macOS, Ghostty, Node and npm. `npm ci` installs Bun and OpenTUI Core at the versions in `app/package-lock.json`; [`app/run`](../app/run) starts `app.ts` with that Bun.

```sh
cd app
npm ci
./run
```

The app from the checkout calls the installed launcher, `~/.local/bin/tokiwa`, for every AWS and tmux operation, as the installed app does. Install the launcher first:

```sh
install -m 0755 bin/tokiwa ~/.local/bin/tokiwa
```

| Option of `./run` | Effect |
| --- | --- |
| `--attach NAME` | Attach the session `NAME` at start. |
| `--layout terminal` | The list fills the width until a session is attached. The default is `--layout workspace`. |
| `--snapshot FILE` | Show one recorded `tokiwa health` response in Health. The sampler does not start. |
| `--deadline MINUTES` | Close the app after 1 to 1440 minutes. |
| `--receipt FILE` | Write the app's event record to `FILE` as JSON after each event. |

[Configuration](configuration.md) lists the environment variables and the Health configuration file.

## Run the tests

Run each suite on its own, because the source folders have independent imports. Run the commands from the root of the repository.

| Suite | Command |
| --- | --- |
| App (`app/*.test.ts`) | `(cd app && ./node_modules/bun/bin/bun.exe test)` |
| One app test file | `(cd app && ./node_modules/bun/bin/bun.exe test child-shell.test.ts)` |
| App installer (`app/test_install.py`) | `python3.12 app/test_install.py -v` |
| Host and launcher (`host/tests`) | `python3.12 -m unittest discover -s host/tests -v` |
| Compose file | `docker compose -f host/compose/compose.json config --quiet` |

The app suite needs `npm ci` in `app/` first. The suites need no Docker daemon, no AWS access and no model requests; the Compose command needs only the Docker CLI.

`test_install.py` runs `install.sh` with a stand-in `npm` and Bun and a temporary `TOKIWA_APP_DIR`. It downloads nothing and does not touch `~/.local`.

The files that end in `-check.ts` or `-native.ts` in `app/` are manual checks in Ghostty, with a local tmux server or the installed launcher. `bun test` does not run them.

## Keep the reference tables true

The tables in [Interface](interface.md), [Configuration](configuration.md) and [Health](health.md) copy facts from the code. [`app/docs.test.ts`](../app/docs.test.ts) compares them with the code and fails, naming the row, when they differ:

| Table | Compared with |
| --- | --- |
| The key tables of each group in `interface.md` | `KEYMAP` in [`shortcuts.ts`](../app/shortcuts.ts): the keys in order and each label |
| Quick keys in `interface.md` | `QUICK_KEYS` in `shortcuts.ts` |
| Environment variables in `configuration.md` | Each `TOKIWA_` variable that `app/`, `app/run`, `app/install.sh` or the launcher reads |
| Command-line options in `configuration.md` | The options that `runOptions` in [`app.ts`](../app/app.ts) parses |
| `health.json` in `health.md` | The keys of `DEFAULT_CONFIG` in [`health-view.ts`](../app/health-view.ts) |

Change the table in the same commit as the code.

## What app/test-guard.ts prevents

[`app/bunfig.toml`](../app/bunfig.toml) preloads [`app/test-guard.ts`](../app/test-guard.ts) before every test file.

| Guard | Effect |
| --- | --- |
| The `call` method of `BackendClient` | A call without a runner fails with `Tests do not run the launcher (ARG). Give BackendClient a runner.` No test runs `~/.local/bin/tokiwa`, which makes AWS calls. |
| `TOKIWA_ORDER_FILE` | Points to `project-order.json` in a new temporary folder, so that no test reads or writes the saved order of the projects. |
| `TOKIWA_OPEN` | `/usr/bin/true`, so that a link that a test opens does not open the browser. |
| `TOKIWA_LOCAL_SHELL` | `/bin/zsh -f`, so that a local shell in a test reads no startup files of the user. |

## How a test drives the app

A test makes a headless renderer with `createTestRenderer` from `@opentui/core/testing`, makes an `App` on that renderer, and gives it a `BackendClient` with a runner. The runner receives the launcher arguments, for example `["--snapshot"]`, and returns the text that the launcher would print. To attach a session, the app runs the transport command from `backend.attachCommand`; a test replaces that command with a local process.

This is the shape of [`app/child-shell.test.ts`](../app/child-shell.test.ts), shortened:

```ts
import { expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";

const snapshot = {
  sessions: [
    { name: "claude-a", project: "studio/example", cwd: "/w/claude-a", clients: 0,
      identity: "1:$1:1", parent: "", activity: [] },
  ],
};
const backend = new BackendClient("/fixture/tokiwa", async () =>
  JSON.stringify(snapshot),
);
backend.attachCommand = () => ["/bin/sleep", "30"];

const t = await createTestRenderer({ width: 140, height: 30 });
const app = new App(t.renderer, { backend, spawn: false });
await app.refreshSessions();
app.focusSessions();
await t.renderOnce();
expect(t.captureCharFrame()).toContain("claude-a");
await t.dispose();
```

`App` is the class in [app.ts](../app/app.ts) that builds the whole interface. The parts that a test uses:

| Part | Use |
| --- | --- |
| `createTestRenderer({ width, height })` | A renderer of that size. `t.resize(w, h)` changes the size. |
| `t.mockInput` | `pressKey("k", { ctrl: true })`, `pressEnter()`, `pressEscape()`, `typeText(text)`, `pasteBracketedText(text)` |
| `t.renderOnce()`, `t.captureCharFrame()` | Draw one frame and read the screen as text. |
| `{ spawn: false }` | The app does not probe the AWS endpoint and does not read the session snapshot on a timer. The test calls `app.refreshSessions()`. |
| `{ backend }`, or `app.backend = …` | The `BackendClient` with a runner. A test can also replace one method, for example `app.backend.resolve`. |
| `backend.attachCommand` | The transport command of an attached session. `["/bin/sleep", "30"]` keeps a transport open; `["/bin/zsh", "-f"]` gives a shell. |
| `t.dispose()` | Close the renderer. Wait for `app.shells[i].child.exited` so that no process stays. |

[`app/landing-fixture.ts`](../app/landing-fixture.ts) and [`app/health-fixture.ts`](../app/health-fixture.ts) hold fixed snapshots and a fixed Health reading. `health-capture.ts` and `review-capture.ts` draw views with the test renderer and write them as text to `~/.local/state/tokiwa/captures/` (or `$TOKIWA_CAPTURE_DIR`):

```sh
(cd app && ./node_modules/bun/bin/bun.exe health-capture.ts)
```

## Install a change on the Mac

`tokiwa` with no command opens the installed app at `~/.local/lib/tokiwa/opentui/run`. [`app/install.sh`](../app/install.sh) installs a committed version of `app/` there. Commit the change first: the script reads the commit, not the working tree.

```sh
bash app/install.sh              # install HEAD
bash app/install.sh REVISION     # install another commit
bash app/install.sh --rollback   # restore the copy that the last install replaced
```

| Step | Behaviour |
| --- | --- |
| Copy | `git archive` of `app/` at the commit into `~/.local/lib/tokiwa/opentui.new`, with a `run` script at its top. A committed `node_modules` is removed. |
| Check | The copy must hold `run`, `package-lock.json` and `app.ts`. |
| Dependencies | `npm ci --omit=dev` in the copy. |
| Start check | The copy's Bun imports `app.ts`, which loads the native OpenTUI library without opening a screen. |
| Record | `INSTALLED` in the copy holds the commit and the install time. |
| Swap | The current copy moves to `opentui.previous`, and the new copy becomes `opentui`. |

When a step fails, the script removes the new copy and leaves the installed copy unchanged. `--rollback` swaps `opentui` and `opentui.previous`, so a second `--rollback` installs the newer copy again. `TOKIWA_APP_DIR` names another install folder.

A change to the launcher needs its own install:

```sh
install -m 0755 bin/tokiwa ~/.local/bin/tokiwa
```

A change to a host file needs the host; see [Host](host.md).

## Related

- [Architecture](architecture.md)
- [Interface](interface.md)
- [Transport](transport.md)
- [Configuration](configuration.md)
- [Host](host.md)
