/** Own a local transport process. Remote session lifetime belongs to Tokiwa. */
import { accessSync, appendFileSync, constants, mkdirSync } from "node:fs";
import { join } from "node:path";
export type TransportKind = "local" | "remote";
type Environment = Record<string, string | undefined>;
/**
 * The command of a local shell: the user's login shell as a login shell, so that it reads the
 * user's own startup files (for zsh, .zprofile and .zshrc) and has the user's PATH. A missing or
 * unusable SHELL falls back to zsh. TOKIWA_LOCAL_SHELL, split at spaces, replaces the command;
 * the tests use it to start a shell that reads no startup file.
 */
export function localShellCommand(env: Environment): string[] {
  const chosen = env.TOKIWA_LOCAL_SHELL?.trim();
  if (chosen) return chosen.split(/ +/);
  const shell = env.SHELL ?? "";
  try {
    if (shell.startsWith("/")) {
      accessSync(shell, constants.X_OK);
      return [shell, "-l"];
    }
  } catch {}
  return ["/bin/zsh", "-l"];
}
/**
 * The variables that name the terminal around Tokiwa. A program in a local shell that saw them
 * would talk to that terminal, for example Ghostty or tmux, while its output goes to Tokiwa.
 */
const OUTER_TERMINAL =
  /^(TMUX|TMUX_PANE|TERM_PROGRAM|TERM_PROGRAM_VERSION|TERM_SESSION_ID|LC_TERMINAL|LC_TERMINAL_VERSION|VTE_VERSION|STY|WINDOW|(GHOSTTY|ITERM|KITTY|WEZTERM|ALACRITTY)_.*)$/;
const TERMINAL = { TERM: "xterm-256color", COLORTERM: "truecolor" };
/**
 * The environment of a transport. A local shell inherits Tokiwa's environment without the outer
 * terminal's variables. A remote transport gets a fixed environment, so the launcher and the
 * Session Manager plugin behave the same however Tokiwa was started.
 */
function transportEnvironment(kind: TransportKind, env: Environment): Environment {
  if (kind === "local") {
    const inherited = Object.fromEntries(
      Object.entries(env).filter(([key]) => !OUTER_TERMINAL.test(key)),
    );
    return { ...inherited, ...TERMINAL, LANG: env.LANG || "en_US.UTF-8" };
  }
  return {
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    HOME: env.HOME,
    ...TERMINAL,
    LANG: env.LANG || "en_US.UTF-8",
    PS1: "tokiwa %# ",
  };
}
export interface PtyEvents {
  data(bytes: Uint8Array): void;
  exit(code: number): void;
  /** The program wrote text to the clipboard with OSC 52, for example after its own selection. */
  clipboard?(text: string): void;
  /** A program asked to open a link in a browser: `tokiwa-open` on the workstation sent it. */
  open?(url: string): void;
}
/**
 * A request from a program: an OSC 52 clipboard write (selection, base64 text) or a
 * `tokiwa-open` link (OSC 7717 `open`, base64 link), then BEL or ST.
 */
const PROGRAM_REQUEST =
  /\x1b\](?:52;[^;\x07\x1b]*|(7717;open));([A-Za-z0-9+/=]*)(?:\x07|\x1b\\)/g;
/** The largest unfinished request that waits for the rest of its bytes. */
const CLIPBOARD_CARRY_MAX = 1 << 20;
// Replies to the tmux client startup queries: primary DA, secondary DA, XTVERSION and
// DEC mode 2026. tmux stops waiting for each of these after five seconds. It then passes
// a late reply to the pane as typed input. tmux accepts OSC 10 and OSC 11 replies at any time.
const STARTUP_QUERY_REPLY =
  /\x1b\[[?>][0-9;]*c|\x1bP>\|[^\x1b\x07]*(?:\x1b\\|\x07)|\x1b\[\?2026;[0-9]*\$y/g;

/** Remove replies that tmux turns into pane input when they arrive late. Keep every other reply. */
export function withoutStartupQueryReplies(data: Uint8Array): Uint8Array {
  const text = Buffer.from(data).toString("latin1");
  const kept = text.replace(STARTUP_QUERY_REPLY, "");
  return kept === text ? data : Buffer.from(kept, "latin1");
}

// Ctrl+B r: refresh-client in the default tmux key table, the same prefix as detach.
const TMUX_REDRAW = "\x02r";

export class PtyAdapter {
  /**
   * The wait after the last size change before a remote transport asks tmux to redraw. The
   * Session Manager plugin passes the local size to the host on a 500 ms poll, so a shorter
   * change can reach the emulator and never reach tmux.
   */
  static redrawDelayMs = 1000;
  readonly child: ReturnType<typeof Bun.spawn>;
  closed = false;
  /** True while tmux holds the alternate screen of this transport. */
  private tmuxDrawing = false;
  private size = "";
  private redrawTimer?: ReturnType<typeof setTimeout>;
  /**
   * True while the program reports mouse presses (mode 1000, 1002 or 1003): it owns a drag and
   * its own selection, so the app starts none.
   */
  mouseTracking = false;
  /** The start of a clipboard write whose end has not arrived yet. */
  private clipboardCarry = "";
  /** The user's last keystroke was Ctrl+B: tmux waits for its command key. */
  private prefixPending = false;
  /**
   * With TOKIWA_RECORD_DIR set, a remote transport appends its raw output to `<stem>.bytes` and
   * each size change to `<stem>.sizes` as `<byte offset> <cols> <rows>`, so that a garbled
   * screen can be replayed into an emulator and compared. The files hold the session text: the
   * folder is private to the user, and nothing is recorded without the variable.
   */
  private record?: { stem: string; offset: number };
  constructor(
    readonly kind: TransportKind,
    command: string[],
    events: PtyEvents,
    cwd: string,
  ) {
    // A remote transport passes tmux's output through unchanged: turn off the line feed
    // translation on its PTY before the transport starts. tmux sets its own terminal raw on the
    // host and sends a bare line feed to move down one row in the same column. With onlcr on, the
    // PTY turns it into CR LF, the cursor also goes to column 0, and the row lands two or more
    // columns to the left. The Session Manager plugin runs `stty cbreak`, which on macOS turns
    // opost back on, so onlcr itself must be off. A local shell keeps the usual output processing.
    if (kind === "remote")
      command = [
        "/bin/sh",
        "-c",
        'stty -opost -onlcr 2>/dev/null; exec "$@"',
        "tokiwa-transport",
        ...command,
      ];
    this.child = Bun.spawn(command, {
      cwd,
      env: transportEnvironment(kind, process.env),
      terminal: {
        cols: 80,
        rows: 24,
        data: (_, raw) => {
          let bytes: Uint8Array = raw;
          if (this.record) {
            appendFileSync(`${this.record.stem}.bytes`, bytes, { mode: 0o600 });
            this.record.offset += bytes.byteLength;
          }
          if (kind === "remote") bytes = this.beforeTmux(bytes);
          this.scan(bytes, events);
          events.data(bytes);
        },
      },
    });
    // Transport startup can emit terminal queries before it sets its own TTY mode.
    // Forward their replies immediately and do not echo them into the emulator.
    if (kind === "remote") this.child.terminal?.setRawMode(true);
    const folder = process.env.TOKIWA_RECORD_DIR;
    if (kind === "remote" && folder) {
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const stamp = new Date().toISOString().replace(/[:.]/g, "-");
      this.record = {
        stem: join(folder, `${stamp}-${this.child.pid}`),
        offset: 0,
      };
    }
    this.child.exited.then((code) => events.exit(code));
  }
  /**
   * Give the plain line feeds of the launcher and the plugin a carriage return, as a terminal with
   * onlcr does, until tmux takes the alternate screen; then pass tmux's bytes unchanged. The
   * transport's PTY has onlcr off for tmux, so its startup lines would otherwise step to the right.
   */
  private beforeTmux(bytes: Uint8Array): Uint8Array {
    if (this.tmuxDrawing) {
      this.observe(bytes);
      return bytes;
    }
    const text = Buffer.from(bytes).toString("latin1");
    const enter = text.indexOf("\x1b[?1049h");
    const head = enter < 0 ? text : text.slice(0, enter);
    const fixed =
      head.replace(/(?<!\r)\n/g, "\r\n") + (enter < 0 ? "" : text.slice(enter));
    this.observe(bytes);
    return fixed === text ? bytes : Buffer.from(fixed, "latin1");
  }
  /** Follow the program's mouse mode, and pass its clipboard writes and links to `events`. */
  private scan(bytes: Uint8Array, events: PtyEvents) {
    const chunk = Buffer.from(bytes).toString("latin1");
    for (const m of chunk.matchAll(/\x1b\[\?([0-9;]+)([hl])/g))
      if (m[1].split(";").some((mode) => /^100[023]$/.test(mode)))
        this.mouseTracking = m[2] === "h";
    if (!events.clipboard && !events.open) return;
    const text = this.clipboardCarry + chunk;
    let end = 0;
    for (const m of text.matchAll(PROGRAM_REQUEST)) {
      end = m.index + m[0].length;
      if (!m[2]) continue;
      const value = Buffer.from(m[2], "base64").toString("utf8");
      if (m[1]) events.open?.(value);
      else events.clipboard?.(value);
    }
    // Keep an unfinished request for the next read, within a bound.
    const open = Math.max(
      text.lastIndexOf("\x1b]52;"),
      text.lastIndexOf("\x1b]7717;"),
    );
    this.clipboardCarry =
      open >= end && text.length - open <= CLIPBOARD_CARRY_MAX
        ? text.slice(open)
        : "";
  }
  /** Follow whether tmux has entered or left the alternate screen. */
  private observe(bytes: Uint8Array) {
    const text = Buffer.from(bytes).toString("latin1");
    const enter = text.lastIndexOf("\x1b[?1049h");
    const leave = text.lastIndexOf("\x1b[?1049l");
    if (enter > leave) this.tmuxDrawing = true;
    else if (leave > enter) this.tmuxDrawing = false;
  }
  /** Send the user's input. */
  write(data: string | Uint8Array) {
    if (this.closed) return;
    const bytes = typeof data === "string" ? Buffer.from(data) : data;
    if (bytes.byteLength > 0)
      this.prefixPending = bytes[bytes.byteLength - 1] === 0x02;
    this.send(data);
  }
  private send(data: string | Uint8Array) {
    if (!this.closed) this.child.terminal?.write(data);
  }
  /** Forward an emulator reply. A remote transport never sends startup query replies. */
  reply(data: Uint8Array) {
    const kept =
      this.kind === "remote" ? withoutStartupQueryReplies(data) : data;
    if (kept.byteLength > 0) this.send(kept);
  }
  /**
   * Redraw on request (the footer's refresh): the same Ctrl+B r, only while tmux draws and never on
   * top of a Ctrl+B that the user typed. Returns whether it sent the redraw.
   */
  redraw(): boolean {
    if (
      this.kind !== "remote" ||
      this.closed ||
      !this.tmuxDrawing ||
      this.prefixPending
    )
      return false;
    this.refresh();
    return true;
  }
  /** Ask tmux to draw the whole client again. */
  private refresh() {
    this.send(TMUX_REDRAW);
  }
  resize(cols: number, rows: number) {
    // Hidden views have no layout size. Keep the last usable remote geometry.
    if (this.closed || !Number.isFinite(cols) || !Number.isFinite(rows)) return;
    cols = Math.floor(cols);
    rows = Math.floor(rows);
    if (cols < 1 || rows < 1) return;
    this.child.terminal?.resize(cols, rows);
    const size = `${cols}x${rows}`;
    if (size === this.size) return;
    this.size = size;
    if (this.record)
      appendFileSync(
        `${this.record.stem}.sizes`,
        `${this.record.offset} ${cols} ${rows}\n`,
        { mode: 0o600 },
      );
    // A resize reflows the emulator at once: the alternate screen loses rows from the top and
    // the scroll region resets. tmux sends only the cells that changed in its own grid, so the
    // emulator stays wrong until tmux draws the whole client again. Ask for that redraw after
    // the size settles, also when the transport never passes a short size change to tmux.
    if (this.kind !== "remote") return;
    clearTimeout(this.redrawTimer);
    this.redrawTimer = setTimeout(() => {
      if (this.tmuxDrawing && !this.prefixPending) this.refresh();
    }, PtyAdapter.redrawDelayMs);
  }
  detach() {
    if (this.kind !== "remote") throw new Error("This terminal is local.");
    this.send("\x02d");
  }
  closeTransport() {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.redrawTimer);
    this.child.terminal?.close();
  }
}
