import { test, expect } from "bun:test";
import { rmSync } from "node:fs";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";
import { landingSessions } from "./landing-fixture";

const tmuxPath = Bun.which("tmux");
const socket = `tokiwa-redraw-test-${process.pid}`;
const tmux = (...args: string[]) =>
  Bun.spawnSync([tmuxPath!, "-L", socket, "-f", "/dev/null", ...args])
    .stdout.toString();

// Numbered rows over a footer. It draws again only when its own terminal size changes.
const program = `
import shutil, signal, sys
def draw(*_):
    cols, rows = shutil.get_terminal_size()
    out = "\\x1b[H\\x1b[2J" + "".join(f"\\x1b[{i + 1};1H  row {i}" for i in range(rows - 1))
    sys.stdout.write(out + f"\\x1b[{rows};1H[footer]")
    sys.stdout.flush()
signal.signal(signal.SIGWINCH, draw)
draw()
while True:
    signal.pause()
`;

// A stand-in for the Session Manager transport. It copies bytes both ways and passes a new
// window size to the remote side only when the size stays the same for one second, so a short
// size change never reaches tmux. The real plugin polls the size every 500 ms.
const transport = `
import fcntl, os, pty, select, struct, sys, termios, time, tty
def size(fd):
    return fcntl.ioctl(fd, termios.TIOCGWINSZ, b"\\0" * 8)
pid, master = pty.fork()
if pid == 0:
    os.execvp(sys.argv[1], sys.argv[1:])
tty.setraw(0)
sent, seen, since = None, size(0), time.monotonic()
while True:
    now = size(0)
    if now != seen:
        seen, since = now, time.monotonic()
    if seen != sent and time.monotonic() - since >= 1:
        fcntl.ioctl(master, termios.TIOCSWINSZ, seen)
        sent = seen
    ready, _, _ = select.select([0, master], [], [], 0.05)
    try:
        if master in ready:
            data = os.read(master, 4096)
            if not data:
                break
            os.write(1, data)
        if 0 in ready:
            os.write(master, os.read(0, 4096))
    except OSError:
        break
`;

/** The pane rows of the emulator and of tmux, without the tmux status line. */
function screens(terminal: { screen(): { lines: string[]; rows: number } }) {
  const { lines, rows } = terminal.screen();
  const emulator = Array.from({ length: rows - 1 }, (_, i) => lines[i] ?? "");
  const remote = tmux("capture-pane", "-p", "-t", "fixture")
    .split("\n")
    .slice(0, rows - 1)
    .map((line) => line.trimEnd());
  return { emulator, remote };
}

/**
 * Attach the fixture tmux session through the stand-in transport, wait until tmux has drawn
 * it, run `check`, and end the tmux server.
 */
async function withRemote(
  check: (context: {
    t: Awaited<ReturnType<typeof createTestRenderer>>;
    app: App;
    terminal: App["shells"][number]["terminal"];
    settle: (ms: number) => Promise<void>;
  }) => Promise<void>,
) {
  tmux("new-session", "-d", "-s", "fixture", "-x", "80", "-y", "24", `python3 -c '${program}'`);
  const t = await createTestRenderer({ width: 120, height: 30 });
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify({ sessions: landingSessions }),
  );
  backend.attachCommand = () => [
    "/usr/bin/python3",
    "-c",
    transport,
    tmuxPath!,
    "-L",
    socket,
    "attach",
    "-t",
    "fixture",
  ];
  const app = new App(t.renderer, { backend });
  const settle = async (ms: number) => {
    for (const end = Date.now() + ms; Date.now() < end; ) {
      await Bun.sleep(25);
      await t.renderOnce();
    }
  };
  try {
    await settle(100);
    const api = landingSessions.find((s) => s.name === "web-lead")!;
    await app.attachRemote(api.name, api.identity);
    const terminal = app.shells[0].terminal;
    // tmux redraws once when its terminal queries time out after five seconds.
    await settle(6000);
    const { emulator, remote } = screens(terminal);
    expect(remote[0]).toBe("  row 0");
    expect(emulator).toEqual(remote);
    await check({ t, app, terminal, settle });
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    const socketPath = tmux("display-message", "-p", "#{socket_path}").trim();
    tmux("kill-server");
    if (socketPath) rmSync(socketPath, { force: true });
    await t.dispose();
    await Promise.all(children);
  }
}

test.skipIf(!tmuxPath)(
  "a remote terminal matches tmux again after a size change that the transport did not pass on",
  () =>
    withRemote(async ({ t, terminal, settle }) => {
      // The window loses a row and gets it back before the transport passes the size on.
      t.resize(120, 29);
      await t.renderOnce();
      t.resize(120, 30);
      await t.renderOnce();
      await settle(2500);
      const { emulator, remote } = screens(terminal);
      expect(emulator).toEqual(remote);
    }),
  20000,
);

test.skipIf(!tmuxPath)(
  "focus mode resizes a remote terminal both ways and tmux matches it each time",
  () =>
    withRemote(async ({ app, terminal, settle }) => {
      const remoteWidth = () =>
        Number(tmux("display-message", "-p", "-t", "fixture", "#{window_width}").trim());
      const split = terminal.screen().columns;
      expect(remoteWidth()).toBe(split);
      app.toggleFocus();
      await settle(2500);
      const full = terminal.screen().columns;
      expect(full).toBeGreaterThan(split + 30);
      expect(remoteWidth()).toBe(full);
      let { emulator, remote } = screens(terminal);
      expect(emulator).toEqual(remote);
      app.toggleFocus();
      await settle(2500);
      expect(terminal.screen().columns).toBe(split);
      expect(remoteWidth()).toBe(split);
      ({ emulator, remote } = screens(terminal));
      expect(emulator).toEqual(remote);
    }),
  25000,
);
