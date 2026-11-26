import {
  RGBA,
  BoxRenderable,
  ScrollBoxRenderable,
  TextRenderable,
  InputRenderable,
  InputRenderableEvents,
  EmbeddedTerminalRenderable,
  createCliRenderer,
  TextAttributes,
  StyledText,
  type CliRenderer,
  type KeyEvent,
  type MouseEvent,
  type Renderable,
} from "@opentui/core";
import { dirname, join } from "node:path";
import {
  appendFileSync,
  writeFileSync,
  readFileSync,
  mkdirSync,
  renameSync,
  statSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { createConnection } from "node:net";
import groups from "./projects.json";
import { openGhosttyWindow } from "./ghostty";
import { steadyCursor } from "./cursor";
import { readClipboardImage } from "./clipboard-image";
import { foregroundProgram, localShellCommand, PtyAdapter } from "./pty";
import { themeRemoteStatus } from "./status-theme";
import {
  LauncherError,
  BackendClient,
  isBackground,
  SIGN_IN_EXPIRED,
  projectName,
  sessionName,
  type SessionRef,
} from "./backend";
import {
  activity,
  FRESHNESS_LIMIT_MS,
  HealthHistory,
  SourceStatus,
  WorkspaceState,
  type Freshness,
} from "./state";
import {
  classify,
  errorState,
  GLOBAL_KINDS,
  type ErrorState,
  type Failure,
  type Source,
} from "./problem";
import {
  healthLines,
  loadHealthConfig,
  syncedText,
  timeOfDay,
  type HealthConfig,
  type SpendReading,
  type Tone,
} from "./health-view";
import { paneLayout, throbColor } from "./workspace";
import {
  dimNeedsYou,
  focusStrip,
  projectTree,
  type TreeEntry,
  type TreeProject,
  spanCells,
  stateGuides,
  projectTitle,
  rowState,
  runsOnlyShell,
  sessionRowText,
  snapshotActivity,
  superscript,
  STATUS_GLYPH,
  STATUS_TONE,
  STATUS_WORD,
  type RowState,
} from "./sessions";
import {
  KEYMAP,
  QUICK_KEYS,
  directKey,
  quickKey,
  shortcutLines,
  bindingAt,
  type Binding,
  type QuickKey,
} from "./shortcuts";
import {
  ACTION_CATEGORY,
  searchRows,
  type SearchItem,
  type SearchRow,
} from "./search";
import {
  fitFooter,
  noticeForms,
  hint,
  hintText,
  SEPARATOR,
  type Hint,
  type HintOrder,
} from "./footer";
import { wrap as wrapText, type Span } from "./health-view";

export const theme = {
  bg: RGBA.defaultBackground(),
  surface: "#0a0a0a",
  selected: "#16312a",
  // The pointer highlight: the selection band at about 60 % weight on the dark ground.
  hover: "#0e1f1a",
  fg: "#e3e4e8",
  muted: "#a4a7b1",
  line: "#292929",
  // A bar track: a thin line that stays visible on the dark ground but recedes behind the fill.
  track: "#454850",
  // The edge of the view with the keyboard once its glow settles: the accent at low weight.
  edge: "#3d6e60",
  cpu: "#74c9ad",
  ram: "#9991f3",
  warning: "#d6ad6e",
  critical: "#f2aa9a",
};
const tones: Record<Tone, string> = {
  title: theme.fg,
  label: theme.muted,
  value: theme.fg,
  dim: theme.muted,
  accent: theme.cpu,
  memory: theme.ram,
  warning: theme.warning,
  critical: theme.critical,
  track: theme.track,
};
const healthConfigPath = join(
  process.env.HOME ?? "",
  ".config/tokiwa/health.json",
);
// The launcher makes four AWS reads for the inventory; it changes only on a resize or a stop.
const SPEND_REFRESH_MS = 15 * 60 * 1000;
// A local shell is the user's login shell and starts in the home directory.
const localShell = localShellCommand(process.env);
/** How long a row says `disconnected` before it shows its session on the host again. */
const DISCONNECT_NOTICE_MS = 60000;
/** The last line of an attach that a detach ended, or that ended with the session. */
const TRANSPORT_END =
  /\[(detached \(from session [^\]]*\)|exited)\]\s*(Exiting session[^\n]*\s*)?$/;
/** The way a transport ended on purpose, from the end of its output. */
export function transportEnd(output: string) {
  const match = TRANSPORT_END.exec(
    output.replace(/\x1b[=>]|\x1b[()][0-9A-Z]/g, ""),
  );
  if (!match) return undefined;
  return match[1] === "exited" ? "ended" : "detached";
}
const localDirectory = homedir();
if (
  !/^[a-zA-Z0-9 -]{1,30}$/.test(groups.name) ||
  groups.shells.length > 3 ||
  !groups.shells.every((name) => /^[a-zA-Z0-9-]{1,24}$/.test(name))
)
  throw new Error(
    "Use at most three shell names with letters, numbers or hyphens.",
  );
/** An action that a key, the shortcuts sheet and the search reach. `id` names its binding. */
type Action = {
  id: string;
  label: string;
  run: () => void;
  available?: () => boolean;
};
/** One row of the session list: a remote session from the snapshot, an attached view, or both. */
/**
 * An operation that asks for a name in the search box. end and end-project ask for the exact
 * name; project asks for the project to move a session to; new-session and new-project ask for
 * the name of what they create.
 */
export type Operation =
  | { operation: "project"; ref: SessionRef }
  | { operation: "new-session"; path: string; dir: string }
  | { operation: "new-project" }
  | { operation: "rename-project"; path: string }
  | { operation: "rename-session"; ref: SessionRef };
/** The left edge of a view; `vertical` is set per view, see `layoutPanes`. */
const PANE_EDGE = {
  topLeft: "─",
  topRight: "─",
  bottomLeft: " ",
  bottomRight: " ",
  horizontal: "─",
  vertical: " ",
  topT: "─",
  bottomT: " ",
  leftT: " ",
  rightT: " ",
  cross: " ",
};
/** Open a link in the Mac's default browser. `TOKIWA_OPEN` names another command, for tests. */
function openInBrowser(url: string) {
  Bun.spawn([process.env.TOKIWA_OPEN ?? "/usr/bin/open", url], {
    stdio: ["ignore", "ignore", "ignore"],
  });
}
/**
 * The Session Manager endpoint of the region in the launcher's host settings: `region=` in
 * `TOKIWA_HOST_CONFIG`, by default `~/.config/tokiwa/host.env`. A missing file or region gives
 * us-east-1.
 */
export function awsEndpoint(
  file = process.env.TOKIWA_HOST_CONFIG ??
    join(homedir(), ".config", "tokiwa", "host.env"),
) {
  let region = "us-east-1";
  try {
    const found = readFileSync(file, "utf8").match(
      /^region=([a-z]{2}(?:-[a-z]+)+-[0-9])$/m,
    );
    if (found) region = found[1];
  } catch {
    // No host settings: keep the default region.
  }
  return { host: `ssm.${region}.amazonaws.com`, port: 443 };
}
const AWS_ENDPOINT = awsEndpoint();
/** The AWS profile of the launcher's host settings (`profile=`), or "" when the file or the line is missing. */
export function awsProfile(
  file = process.env.TOKIWA_HOST_CONFIG ??
    join(homedir(), ".config", "tokiwa", "host.env"),
) {
  try {
    // The launcher keeps the last profile= line, so the app names the same one.
    const found = [...readFileSync(file, "utf8").matchAll(/^profile=([A-Za-z0-9._:+-]+)$/gm)];
    return found.at(-1)?.[1] ?? "";
  } catch {
    return "";
  }
}
/** Time one TCP connection to the AWS endpoint, in ms; reject on failure or after 3 s. */
export function reachAws(): Promise<number> {
  return new Promise((resolve, reject) => {
    const start = performance.now();
    const socket = createConnection(AWS_ENDPOINT);
    socket.setTimeout(3000);
    socket.once("connect", () => {
      resolve(performance.now() - start);
      socket.destroy();
    });
    socket.once("timeout", () => {
      socket.destroy();
      reject(new Error("timeout"));
    });
    socket.once("error", reject);
  });
}
export type SessionRow = {
  name: string;
  project: string;
  title: string;
  /** The tmux session id, such as `$4`, and the id of the session it was opened from. */
  id?: string;
  parent?: string;
  ref?: SessionRef;
  shell?: Shell;
  /** True while the workstation creates the session: the row holds its place. */
  starting?: boolean;
  /** How current the snapshot behind this row is, and when it was read (ms). Snapshot rows only. */
  freshness?: Freshness;
  readAt?: number;
};
// The session list reads the snapshot again after this time while the workspace is in view.
const SESSIONS_REFRESH_MS = 30 * 1000;
// A second read soon after the first shows which sessions have output.
const SESSIONS_SECOND_READ_MS = 5 * 1000;
// The host state turns stale when no read has succeeded for this time.
const HOST_STALE_MS = 90 * 1000;
const binding = (id: string) => KEYMAP.find((b) => b.id === id) as Binding;
const MAX_PASTE_IMAGE_BYTES = 10485760;
/** The "Pasting image…" notice lasts as long as the launcher timeout (90 seconds). */
const PASTE_NOTICE_MS = 90000;
export type Shell = {
  terminal: EmbeddedTerminalRenderable;
  child: ReturnType<typeof Bun.spawn>;
  adapter: PtyAdapter;
  remote?: SessionRef;
  remoteName?: string;
  cwd: string;
  pane: BoxRenderable;
  title: TextRenderable;
  /** Covers the terminal while it lacks the keyboard: the first click only focuses it. */
  shield: BoxRenderable;
  name: string;
  lastOutput: number;
  /** When the owner last typed or clicked in this view: a link it asks for soon after opens. */
  lastInput?: number;
  startupOutput?: string;
  exited: boolean;
  /** When the transport ended. */
  endedAt?: number;
  /** True after this app asked tmux to detach the view. */
  detaching?: boolean;
};

export class App {
  backend: BackendClient;
  history = new HealthHistory();
  sampleTimer?: ReturnType<typeof setTimeout>;
  sampling = false;
  spend?: SpendReading;
  spendError = "";
  spendAt = 0;
  healthConfig: HealthConfig;
  healthConfigError = "";
  healthScroll: ScrollBoxRenderable;
  healthText: TextRenderable;
  healthTimer: ReturnType<typeof setInterval>;
  healthOverflow = false;
  now: () => number;
  state = new WorkspaceState();
  remoteSessions: SessionRef[] = [];
  /** The snapshot before `remoteSessions`, by name. Activity compares pane screens with it. */
  previousSessions = new Map<string, SessionRef>();
  sessionsRead = false;
  sessionsLoading = false;
  /** The top-level projects whose listed rows come from the session snapshot. */
  snapshotProjects = new Set<string>();
  /** The status of each data source; `readFailed` and `readSucceeded` are the only writers. */
  sources: Record<Source, SourceStatus> = {
    sessions: new SourceStatus(FRESHNESS_LIMIT_MS.sessions),
    health: new SourceStatus(FRESHNESS_LIMIT_MS.health),
    spend: new SourceStatus(FRESHNESS_LIMIT_MS.spend),
  };
  sessionTimer?: ReturnType<typeof setTimeout>;
  /** The band under the header that names the current problem, and its raw output. */
  band!: BoxRenderable;
  bandRow!: BoxRenderable;
  bandTitle!: TextRenderable;
  bandKeys!: TextRenderable;
  bandSub!: TextRenderable;
  bandDetail!: BoxRenderable;
  bandDetailText!: TextRenderable;
  detailsOpen = false;
  /** The raw failures already written to the error log, by source. */
  logged: Record<string, string> = {};
  remotePending = new Set<string>();
  /** The operation that the search box asks a name for, see `Operation`. */
  confirm?: Operation;
  /** The state of a confirmed operation that runs: progress, then a failure if it fails. */
  confirmStatus?: { text: string; failed: boolean };
  root: BoxRenderable;
  body: BoxRenderable;
  health: BoxRenderable;
  shellPane: BoxRenderable;
  emptyBox: BoxRenderable;
  emptyState: TextRenderable;
  /** The navigation row after Workspace and Health: an error, or the focus strip. */
  navStatus: TextRenderable;
  location: TextRenderable;
  source: TextRenderable;
  footer: BoxRenderable;
  /** The footer controls on screen and the signature of the last footer drawing. */
  footerShown: Hint[] = [];
  footerSignature = "";
  /**
   * The control under the pointer, by key: `row:NAME` for a session row, `footer:ID` for a footer
   * control and `search:N` for a search result. Empty for none.
   */
  hover = "";
  hoverTargets = new Map<
    string,
    { node: Renderable; paint: (on: boolean) => void }
  >();
  hoverKeys = new WeakMap<object, string>();
  /** True from the opening of the search until its first keystroke: a quick key runs at once. */
  quickArmed = false;
  /** The rows of the search results: category titles and items. */
  searchList: SearchRow[] = [];
  sheet: ScrollBoxRenderable;
  sheetText: TextRenderable;
  sheetOpen = false;
  sheetOverflow = false;
  sheetLines = 0;
  /** The lines of the open sheet, for the pointer. */
  sheetRows: Span[][] = [];
  /** The action of the sheet row under the pointer, which has the hover band. */
  sheetHover = "";
  /** A new shell that is starting: its source view, its directory and when it started. */
  pendingShell?: { source: Shell; where: string; since: number };
  pendingPane?: BoxRenderable;
  pendingText?: TextRenderable;
  /** The view that runs the AWS sign-in. A failed sign-in stays open, so its message can be read. */
  signInShell?: Shell;
  /** After a sign-in: `refreshing` until a fresh read succeeds, `failed` when the first read after it fails. */
  afterSignIn?: "refreshing" | "failed";
  /** When the last successful sign-in ended; only a read that starts later can fail the refresh. */
  signInDoneAt = 0;
  /** The recovery that the band's first key hint offers, and the width of that hint in cells. */
  bandAction?: "sign-in" | "retry";
  bandActionWidth = 0;
  /** The search panel. The confirmation of End session and Project directory also uses it. */
  palette?: BoxRenderable;
  search?: InputRenderable;
  choices?: ScrollBoxRenderable;
  actions: Action[] = [];
  filtered: SearchItem[] = [];
  clipboardSelection = "";
  /** The text of the last finished selection: a click on Copy clears the live selection first. */
  lastSelection = "";
  /** A short footer message, for example after a copy, and when it ends. */
  footerNotice?: {
    text: string;
    failed: boolean;
    until: number;
    actions?: { label: string; run: () => void }[];
    /** The action that failed, so that a later success of it clears the notice. */
    action?: string;
    /** True when the notice names a failure of the whole link, which a recovery clears. */
    cause?: boolean;
  };
  get selection() {
    return this.state.selection;
  }
  set selection(value: number) {
    this.state.selection = value;
  }
  get view() {
    return this.state.view;
  }
  set view(value: "health" | "shell") {
    this.state.view = value;
  }
  workspace!: BoxRenderable;
  sessionList!: BoxRenderable;
  sessionScroll!: ScrollBoxRenderable;
  /** The name of this Mac in the header. */
  device = "";
  /** The last tries to reach the AWS endpoint: the time of each, or null for a lost one. */
  pings: { at: number; ms: number | null }[] = [];
  probeTimer?: ReturnType<typeof setInterval>;
  /** The card under the header status that describes the link; shown under the pointer. */
  connectionCard?: BoxRenderable;
  connectionText?: TextRenderable;
  startupTimer?: ReturnType<typeof setInterval>;
  /** The × of each session row, shown while the pointer is over the row. */
  rowClose = new Map<string, TextRenderable>();
  /** A session that asks "end it?" in its row and in its view's title, with the shells opened from it. */
  ending?: { ref: SessionRef; children: SessionRef[]; busy?: string };
  /** True while the search panel lists the background sessions in place of the search. */
  picker = false;
  /** A title line above the input of the search panel, for an operation that needs one. */
  paletteTitle?: string;
  /** True while a new session gets its own folder inside the project folder; tab changes it. */
  ownFolder = true;
  /** The sessions that the workstation creates now, by name, with their project. */
  starting = new Map<string, string>();
  /** Sessions that this app created, and when: a read that began earlier cannot list them. */
  created = new Map<string, { ref: SessionRef; at: number }>();
  /** The key presses so far: a new session opens in the pane only when none came meanwhile. */
  inputs = 0;
  /** A project that waits for the answer to "end it?". */
  endingProject?: { path: string; refs: SessionRef[]; busy?: string };
  /** A question about a local shell with a running program: close that shell, or quit the app. */
  closing?: { shell: Shell; program: string; quit: boolean };
  /** The order of the top-level projects, saved in `orderFile`. */
  projectOrder: string[] = [];
  orderFile?: string;
  /** A project title being dragged, so that a gap between projects can show where it lands. */
  dragging?: string;
  /** The last press on a session row, to tell a double click. */
  lastRowPress = { name: "", at: 0 };
  /** The last press on a project title, to tell a double click. */
  lastTitlePress = { path: "", at: 0 };
  /** The view whose left edge is lit, and until when it glows brighter after taking focus. */
  edgeFocus?: string;
  edgeGlowUntil = 0;
  /** What a drag in the session list carries: a session to move, or a project to nest. */
  dragItems = new WeakMap<
    object,
    | { kind: "session"; ref: SessionRef }
    | { kind: "project"; path: string; title: string }
  >();
  /** True after a drop in the session list, until the next press, so the release opens nothing. */
  dropped = false;
  listSignature = "";
  /** True while the keyboard is in the session list and not in a terminal. */
  listFocused = false;
  listSelection = 0;
  /** The status glyphs of the list. The output glyphs throb without a redraw of the list. */
  listGlyphs: { text: TextRenderable; state: RowState }[] = [];
  /** Focus mode hides the session list, so the terminal takes the full width. */
  focusMode = false;
  /**
   * Sessions whose bell the owner saw by attaching them, by name, with the identity. The list
   * hides that bell until a snapshot reports the session without a bell.
   */
  acknowledged = new Map<string, string>();
  /** The request time of tokiwa-attention that the owner saw by bringing the session forward. */
  attentionSeen = new Map<string, number>();
  shells: Shell[] = [];
  get active() {
    return this.state.active;
  }
  set active(value: number) {
    this.state.active = value;
  }
  events: object[] = [];
  disposed = false;
  timer: ReturnType<typeof setInterval>;
  pair?: [Shell, Shell];
  auxiliaryPending = false;
  animate = process.env.TOKIWA_REDUCED_MOTION !== "1";
  constructor(
    public renderer: CliRenderer,
    public options: {
      spawn?: boolean;
      receipt?: string;
      remote?: string;
      layout?: "workspace" | "terminal";
      healthConfig?: string;
      snapshot?: string;
      now?: () => number;
      backend?: BackendClient;
      /** Open a link in the Mac's browser; `open` by default. */
      openLink?: (url: string) => void;
      /** Time one try to reach the AWS endpoint, in ms; a rejection is a lost try. */
      probe?: () => Promise<number>;
      /** The name of this Mac in the header; the host name without `.local` by default. */
      device?: string;
      /** Where the order of the top-level projects is kept; none (memory only) without spawn. */
      orderFile?: string;
      /** Read an image from the clipboard into a file in `dir`; the Mac's clipboard by default. */
      readImage?: typeof readClipboardImage;
    } = {},
  ) {
    this.now = options.now ?? Date.now;
    this.orderFile =
      options.orderFile ??
      process.env.TOKIWA_ORDER_FILE ??
      join(homedir(), ".local", "state", "tokiwa", "project-order.json");
    try {
      const saved =
        this.orderFile && JSON.parse(readFileSync(this.orderFile, "utf8"));
      if (Array.isArray(saved?.order))
        this.projectOrder = saved.order.filter(
          (p: unknown) => typeof p === "string",
        );
    } catch {
      // No saved order yet, or an unreadable one: projects sort by name.
    }
    this.device = (options.device ?? hostname().replace(/\.local$/, ""))
      .toLowerCase()
      .slice(0, 24);
    this.backend = options.backend ?? new BackendClient();
    const config = loadHealthConfig(options.healthConfig ?? healthConfigPath);
    this.healthConfig = config.config;
    this.healthConfigError = config.error ?? "";
    renderer.setBackgroundColor(theme.bg);
    steadyCursor(renderer);
    this.root = this.box(renderer.root, "app", {
      width: "100%",
      height: "100%",
      flexDirection: "column",
      paddingLeft: 2,
      paddingRight: 2,
      backgroundColor: theme.bg,
      // Every pointer move to a new renderable reaches the root: the highlight follows it.
      onMouseOver: (event: MouseEvent) =>
        this.setHover(this.hoverKeyOf(event.target)),
      onMouseOut: (event: MouseEvent) => {
        if (this.hoverKeyOf(event.target) === this.hover) this.setHover("");
      },
      // A click outside the status and its card closes the card.
      onMouseDown: (event: MouseEvent) => {
        if (!this.connectionCard?.visible) return;
        for (let node: any = event.target; node; node = node.parent)
          if (node === this.source || node === this.connectionCard) return;
        this.connectionCard.visible = false;
      },
    });
    const head = this.box(this.root, "header", {
      height: 2,
      flexDirection: "row",
      alignItems: "center",
      border: ["bottom"],
      borderColor: theme.line,
    });
    this.location = this.text(head, "location", "◇ tokiwa  /  Workspace", {
      attributes: TextAttributes.BOLD,
      flexGrow: 1,
      minWidth: 18,
      wrapMode: "none",
      truncate: true,
    });
    this.source = this.text(head, "source", "", {
      fg: theme.muted,
      selectable: false,
      // A click opens the card about the link to the workstation; a second click closes it.
      onMouseDown: () => this.toggleConnection(),
      // The status keeps its whole label; the breadcrumb beside it gives way first.
      flexShrink: 0,
      wrapMode: "none",
      truncate: true,
    });
    // A click on the status opens a card about the link to the workstation.
    this.connectionCard = this.box(this.root, "connection-card", {
      position: "absolute",
      top: 2,
      right: 2,
      zIndex: 30,
      visible: false,
      border: true,
      borderColor: theme.line,
      backgroundColor: theme.surface,
      paddingLeft: 1,
      paddingRight: 1,
    });
    this.connectionText = this.text(
      this.connectionCard,
      "connection-text",
      "",
      {
        wrapMode: "none",
        selectable: false,
      },
    );
    // One band names the current problem; e or a click opens its raw output below it.
    this.band = this.box(this.root, "problem", {
      flexDirection: "column",
      flexShrink: 0,
      visible: false,
    });
    const bandRow = (this.bandRow = this.box(this.band, "problem-row", {
      height: 1,
      flexDirection: "row",
      onMouseDown: () => this.toggleDetails(),
    }));
    this.bandTitle = this.text(bandRow, "problem-title", "", {
      fg: theme.warning,
      flexGrow: 1,
      minWidth: 10,
      wrapMode: "none",
      truncate: true,
      selectable: false,
    });
    // Each key hint is also a button: a click runs its action, also while a terminal view has the focus.
    this.bandKeys = this.text(bandRow, "problem-keys", "", {
      fg: theme.muted,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation();
        this.clickBandKey(event.x - this.bandKeys.x);
      },
    });
    // The second row: what the failure means, and how old the last good read is.
    this.bandSub = this.text(this.band, "problem-sub", "", {
      fg: theme.muted,
      height: 1,
      wrapMode: "none",
      truncate: true,
      selectable: false,
      onMouseDown: () => this.toggleDetails(),
    });
    this.bandDetail = this.box(this.band, "problem-detail", {
      flexDirection: "column",
      border: true,
      borderColor: theme.line,
      paddingLeft: 1,
      paddingRight: 1,
      visible: false,
    });
    this.bandDetailText = this.text(
      this.bandDetail,
      "problem-detail-text",
      "",
      {
        fg: theme.muted,
        wrapMode: "none",
      },
    );
    const nav = this.box(this.root, "navigation", {
      height: 1,
      flexDirection: "row",
      gap: 2,
    });
    this.text(nav, "shell-nav", "Workspace", {
      width: 9,
      flexShrink: 0,
      wrapMode: "none",
      // A click on a control selects no text.
      selectable: false,
      // A navigation item leaves the shortcuts sheet for the view that it names. From Health,
      // Workspace returns to the terminal that had the keyboard, as `w` does.
      onMouseDown: () => {
        this.closeSheet();
        this.leaveHealth();
      },
      // A project dropped on Workspace becomes a top-level project.
      onMouseDrop: (event: MouseEvent) => void this.dropOn("", event),
    });
    this.text(nav, "health-nav", "Health", {
      fg: theme.cpu,
      width: 6,
      flexShrink: 0,
      wrapMode: "none",
      selectable: false,
      onMouseDown: () => {
        this.closeSheet();
        this.show("health");
      },
    });
    this.navStatus = this.text(nav, "nav-status", "", {
      fg: theme.muted,
      flexGrow: 1,
      wrapMode: "none",
      truncate: true,
    });
    this.body = this.box(this.root, "body", {
      flexGrow: 1,
      width: "100%",
      maxWidth: 116,
      alignSelf: "center",
      minHeight: 0,
      flexDirection: "column",
      paddingTop: 0,
    });
    this.health = this.box(this.body, "health", {
      width: "100%",
      maxWidth: 116,
      alignSelf: "center",
      flexGrow: 1,
      flexDirection: "column",
    });
    this.healthScroll = new ScrollBoxRenderable(renderer, {
      id: "health-scroll",
      width: "100%",
      flexGrow: 1,
      paddingTop: 1,
      verticalScrollbarOptions: { visible: false },
    });
    this.health.add(this.healthScroll);
    this.healthText = this.text(this.healthScroll, "health-text", "", {
      wrapMode: "none",
    });
    // `--snapshot FILE` shows a recorded reading instead of sampling the host.
    if (options.snapshot)
      this.history.load(JSON.parse(readFileSync(options.snapshot, "utf8")));
    this.workspace = this.box(this.body, "workspace", {
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      flexDirection: "row",
      visible: false,
    });
    this.sessionList = this.box(this.workspace, "session-list", {
      width: 32,
      flexShrink: 0,
      flexDirection: "column",
      border: ["right"],
      borderColor: theme.line,
      paddingRight: 1,
      paddingTop: 1,
      // A click in the sidebar outside a session row gives the keyboard to the list. The
      // terminal keeps running. A row stops the click, so it attaches its session instead.
      onMouseDown: () => this.focusSessions(),
    });
    this.sessionScroll = new ScrollBoxRenderable(renderer, {
      id: "session-scroll",
      width: "100%",
      flexGrow: 1,
      minHeight: 1,
      verticalScrollbarOptions: { visible: false },
    });
    this.sessionList.add(this.sessionScroll);
    this.shellPane = this.box(this.workspace, "shell-pane", {
      minWidth: 1,
      minHeight: 1,
      flexGrow: 1,
      flexDirection: "column",
      visible: true,
    });
    this.emptyBox = this.box(this.shellPane, "empty-box", {
      paddingLeft: 2,
      paddingTop: 1,
      flexDirection: "column",
    });
    this.emptyState = this.text(this.emptyBox, "empty-state", "", {
      wrapMode: "word",
    });
    // The shortcuts sheet takes the place of the body while it is open.
    this.sheet = new ScrollBoxRenderable(renderer, {
      id: "sheet",
      width: "100%",
      flexGrow: 1,
      minHeight: 0,
      paddingTop: 1,
      visible: false,
      verticalScrollbarOptions: { visible: false },
    });
    this.root.add(this.sheet);
    this.sheetText = this.text(this.sheet, "sheet-text", "", {
      wrapMode: "none",
      // A row whose action applies now is a control, as in the footer: it highlights under the
      // pointer and a click closes the sheet and runs the action.
      selectable: false,
      onMouseMove: (event: MouseEvent) => {
        const hover = this.sheetActionAt(event.x, event.y);
        if (hover === this.sheetHover) return;
        this.sheetHover = hover;
        this.paintSheet();
      },
      onMouseOut: () => {
        if (!this.sheetHover) return;
        this.sheetHover = "";
        this.paintSheet();
      },
      onMouseDown: (event: MouseEvent) => {
        const action = this.sheetActionAt(event.x, event.y);
        if (!action) return;
        event.stopPropagation();
        event.preventDefault?.();
        this.sheetHover = "";
        this.closeSheet();
        this.runAction(action);
      },
    });
    this.footer = this.box(this.root, "footer", {
      height: 2,
      flexShrink: 0,
      border: ["top"],
      borderColor: theme.line,
      flexDirection: "row",
    });
    this.actions = this.createActions();
    renderer.keyInput.on("keypress", this.key);
    renderer.on("resize", this.resize);
    renderer.on(
      "selection",
      (selection: { getSelectedText?: () => string } | null) => {
        const text = selection?.getSelectedText?.() ?? "";
        if (!text) return;
        // A finished selection copies at once, as in most terminals. The renderer refuses a
        // clipboard write while it handles the mouse event, so the copy runs after it.
        this.lastSelection = text;
        setTimeout(() => {
          if (!this.disposed) this.copy(text, true);
        }, 0);
      },
    );
    renderer.on("destroy", () => this.cleanup());
    this.timer = setInterval(() => {
      this.updateActivity();
    }, 320);
    // The footer states the age of the sample in seconds.
    this.healthTimer = setInterval(() => {
      if (this.connectionCard?.visible) this.drawConnection();
      if (this.view === "health") this.drawHealth();
    }, 1000);
    if (options.spawn !== false) {
      // The connection card's ping and loss: one try now, then every 15 s.
      void this.probe();
      this.probeTimer = setInterval(() => void this.probe(), 15_000);
      // The workspace opens on the session list, which the session snapshot fills. With
      // --attach, the attached terminal takes the keyboard when it is ready.
      this.listFocused = !options.remote;
      this.show("shell");
      if (options.remote) void this.attachRemote(options.remote);
    }
    this.resize();
    this.record("mounted", {});
    renderer.on("capabilities", () =>
      this.record("capabilities", { capabilities: renderer.capabilities }),
    );
  }
  /** Give each binding of the key map its action. The sheet and the search list these actions. */
  createActions(): Action[] {
    const active = () => this.shells[this.active];
    const runs: Record<string, Omit<Action, "id" | "label">> = {
      sessions: { run: () => this.leaveHealth() },
      health: { run: () => this.show("health") },
      focus: { run: () => this.toggleFocus() },
      refresh: {
        run: () => {
          // A retry reads Health again when it is not live, and spend in that read when spend is not.
          const now = this.now();
          if (this.sources.spend.freshness(now) !== "live") this.spendAt = 0;
          if (
            (this.sources.health.freshness(now) !== "live" ||
              this.history.gap) &&
            !this.history.stopped &&
            !this.sampling
          ) {
            clearTimeout(this.sampleTimer);
            void this.sampleHealth();
          }
          void this.refreshSessions();
        },
      },
      background: {
        available: () => this.remoteSessions.some(isBackground),
        run: () => this.openBackground(),
      },
      "sign-in": {
        available: () => this.signInExpired(),
        run: () => this.signIn(),
      },
      details: {
        available: () => !!this.currentError(),
        run: () => this.toggleDetails(),
      },
      "local-shell": {
        run: () => {
          const shell = this.startShell(undefined, false, localDirectory);
          if (shell) this.active = this.shells.indexOf(shell);
          this.listFocused = false;
          this.show("shell");
        },
      },
      "local-group": {
        run: () => {
          for (const name of groups.shells)
            this.startShell(name, false, localDirectory);
          this.listFocused = false;
          this.show("shell");
        },
      },
      shortcuts: { run: () => this.openSheet() },
      quit: { run: () => this.askQuit() },
      reconnect: {
        available: () => Boolean(this.targetShell()?.remote),
        run: () => {
          const s = this.targetShell();
          if (s?.remote)
            void this.attachRemote(s.name, s.remote.identity, true);
        },
      },
      detach: {
        available: () => Boolean(this.targetShell()?.remote),
        run: () => {
          const s = this.targetShell();
          if (s?.exited) this.closeEndedView(s);
          else if (s?.remote) this.detach(s);
        },
      },
      redraw: {
        available: () => {
          const s = this.shells[this.active];
          return Boolean(s?.remote && !s.exited);
        },
        run: () => void this.shells[this.active]?.adapter.redraw(),
      },
      project: {
        available: () => Boolean(this.targetRef()),
        run: () => {
          const ref = this.targetRef();
          if (ref) this.confirmOperation(ref, "project");
        },
      },
      end: {
        available: () => {
          const shell = this.targetShell();
          return Boolean(this.targetRef() || (shell && this.isLocal(shell)));
        },
        run: () => {
          const ref = this.targetRef();
          const shell = this.targetShell();
          if (ref) this.askEnd(ref);
          else if (shell) this.askClose(shell);
        },
      },
      copy: {
        available: () => Boolean(this.clipboardSelection),
        run: () => {
          const text = this.clipboardSelection;
          this.clipboardSelection = "";
          if (text) this.copy(text);
        },
      },
      "shell-here": {
        available: () => !!active() && !this.auxiliaryPending,
        run: () => void this.shellHere(),
      },
      "other-pane": {
        available: () => !!this.pair,
        run: () => this.focusOther(),
      },
      "close-pane": {
        available: () => !!this.pair,
        run: () => this.closeAuxiliary(),
      },
      ghostty: {
        available: () =>
          process.platform === "darwin" &&
          !!active()?.remote &&
          !this.auxiliaryPending,
        run: () => void this.popOut(),
      },
    };
    // Two search-only actions find where a garbled screen comes from. Repaint draws the view
    // again from the emulator's own copy of the screen and asks tmux for nothing: if the text
    // is right afterwards, the emulator had it right and only the drawing was stale.
    const diagnostics: Action[] = [
      {
        id: "repaint",
        label: "Repaint view",
        available: () => !!active(),
        run: () => {
          active()?.terminal.invalidate();
          // Draw every cell again: a cell that drifted in Ghostty is not one that changed here.
          (this.renderer as any).forceFullRepaintRequested = true;
          this.renderer.requestRender();
          this.notify("repainted from the view's own copy · tmux sent nothing");
        },
      },
      {
        id: "save-screen",
        label: "Save screen",
        available: () => !!active(),
        run: () => this.saveScreen(),
      },
    ];
    return [
      ...Object.entries(runs).map(([id, action]) => ({
        id,
        label: binding(id).label,
        ...action,
      })),
      ...diagnostics,
      ...this.projectActions(),
    ];
  }
  /** Search-only actions for projects; the session list offers the same with + and × on titles. */
  projectActions(): Action[] {
    const selected = () => this.sessionRows()[this.listSelection]?.ref;
    return [
      {
        id: "new-project",
        label: "New project",
        available: () =>
          this.options.spawn !== false || !!this.remoteSessions.length,
        run: () => this.askOperation({ operation: "new-project" }),
      },
      {
        id: "new-session",
        label: "New session in project",
        available: () => !!selected(),
        run: () => {
          const path = selected()!.project;
          this.askOperation({
            operation: "new-session",
            path,
            dir: this.projectDir(path),
          });
        },
      },
      {
        id: "rename-session",
        label: "Rename session",
        available: () => !!this.targetRef(),
        run: () =>
          this.askOperation({
            operation: "rename-session",
            ref: this.targetRef()!,
          }),
      },
      {
        id: "end-project",
        label: "End project",
        available: () => !!selected(),
        run: () => this.askEndProject(selected()!.project),
      },
    ];
  }
  /**
   * Save the text that the emulator holds for the active view, with its size and the size of
   * the pane, to a private folder. Compare it with the screen and with `tmux capture-pane` on
   * the host to find which layer garbled a screen.
   */
  saveScreen() {
    const shell = this.shells[this.active];
    if (!shell) return;
    try {
      const folder =
        process.env.TOKIWA_CAPTURE_DIR ??
        join(homedir(), ".local", "state", "tokiwa", "captures");
      mkdirSync(folder, { recursive: true, mode: 0o700 });
      const screen = shell.terminal.screen();
      const now = new Date();
      const file = join(
        folder,
        `${now.toISOString().replace(/[:.]/g, "-")}-${shell.name}.txt`,
      );
      writeFileSync(
        file,
        [
          `view: ${shell.name}`,
          `saved: ${now.toISOString()}`,
          `emulator: ${screen.columns}x${screen.rows}, cursor ${screen.cursor.x},${screen.cursor.y}`,
          `pane: ${shell.terminal.width}x${shell.terminal.height}`,
          "",
          ...screen.lines,
        ].join("\n") + "\n",
        { mode: 0o600 },
      );
      this.notify(`saved the screen to ${file.replace(homedir(), "~")}`);
    } catch (e) {
      this.notify(`the screen was not saved · ${String(e)}`, true);
    }
  }
  /** The session that Session keys act on: the selected row in the list, else the active view. */
  targetRef(): SessionRef | undefined {
    if (this.listHasFocus()) {
      const row = this.sessionRows()[this.listSelection];
      return row?.ref ?? row?.shell?.remote;
    }
    return this.shells[this.active]?.remote;
  }
  targetShell(): Shell | undefined {
    if (this.listHasFocus())
      return this.sessionRows()[this.listSelection]?.shell;
    return this.shells[this.active];
  }
  /**
   * Start the app's own selection in a terminal only while its program does not report the mouse.
   * A program that reports the mouse, such as Claude Code, Codex or tmux with mouse on, owns a drag
   * and draws its own selection; Shift+drag in Ghostty still selects the screen natively.
   */
  selectOnlyUntracked(terminal: EmbeddedTerminalRenderable) {
    const start = terminal.shouldStartSelection.bind(terminal);
    terminal.shouldStartSelection = (x, y) => {
      const shell = this.shells.find((s) => s.terminal === terminal);
      return !shell?.adapter.mouseTracking && start(x, y);
    };
  }
  /** A program wrote to the clipboard, for example after its own selection: copy it on this Mac. */
  programCopied(text: string) {
    if (!text) return;
    this.lastSelection = text;
    this.copy(text, true);
  }
  /**
   * A program on the workstation asked to open a link, through `tokiwa-open`. Right after the
   * owner typed or clicked in its view, for example on the link, it opens in the Mac's browser.
   * Otherwise nothing opens: the footer names the link and offers open and copy, so a program
   * that runs alone cannot open pages in the signed-in browser.
   */
  programOpened(url: string, shell: Shell | undefined) {
    const name = shell?.remoteName ?? shell?.name ?? "a session";
    let link: URL;
    try {
      link = new URL(url);
    } catch {
      return;
    }
    if (!/^https?:$/.test(link.protocol) || url.length > 4096) return;
    const shown = (link.host + link.pathname).replace(/\/$/, "");
    const asked =
      shell?.lastInput !== undefined && this.now() - shell.lastInput < 5000;
    this.record("link-request", { session: name, host: link.host, asked });
    const open = () => {
      try {
        (this.options.openLink ?? openInBrowser)(link.href);
        this.notify(`opened ${shown} in your browser`);
      } catch (e) {
        this.notify(`the link did not open · ${String(e)}`, true);
      }
    };
    if (asked) open();
    else
      this.notify(
        `${name} asked to open ${shown}`,
        false,
        [
          { label: "open", run: open },
          { label: "copy", run: () => setTimeout(() => this.copy(link.href)) },
        ],
        15000,
      );
  }
  /** Copy text to the clipboard. An automatic copy that fails only says so in the footer. */
  copy(text: string, automatic = false) {
    let copied = false;
    try {
      copied = this.renderer.copyToClipboardOSC52(text);
    } catch {
      // The renderer refuses a clipboard write in some phases; report it as a failed copy.
    }
    this.record("clipboard-copy", { characters: text.length, copied });
    if (!copied && automatic)
      this.notify("copy failed · the terminal did not accept it", true);
    else if (!copied) {
      this.notify("copy failed · the terminal did not accept it", true);
      this.updateActivity();
    } else
      this.notify(`copied ${text.length.toLocaleString("en-US")} characters`);
  }
  box(parent: any, id: string, opts: any = {}) {
    const n = new BoxRenderable(this.renderer, { id, ...opts });
    parent.add(n);
    return n;
  }
  text(parent: any, id: string, content: string, opts: any = {}) {
    const n = new TextRenderable(this.renderer, {
      id,
      content,
      fg: theme.fg,
      ...opts,
    });
    parent.add(n);
    return n;
  }
  record(event: string, detail: object = {}) {
    this.events.push({ event, at: new Date().toISOString(), ...detail });
    this.events = this.events.slice(-2000);
    if (this.options.receipt)
      writeFileSync(this.options.receipt, JSON.stringify(this.events, null, 2));
  }
  /** The view whose shield holds a press until its release. */
  shieldHeld?: string;
  /** Give the keyboard to the terminal of a view, as a click on its pane does. */
  focusPaneOf(name: string) {
    if (this.ending && !this.ending.busy) this.cancelEnd();
    const i = this.shells.findIndex((s) => s.name === name);
    if (i < 0) return;
    const shell = this.shells[i];
    if (i === this.active && !this.listFocused && shell.terminal.focused)
      return;
    this.active = i;
    this.listFocused = false;
    this.show("shell");
  }
  makePane(name: string) {
    // The handlers find the session through its view, so that a renamed session keeps working.
    const current = () =>
      this.shells.find((s) => s.pane === pane)?.name ?? name;
    const pane = this.box(this.shellPane, `pane-${name}`, {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 1,
      minHeight: 1,
      visible: false,
      borderColor: theme.line,
      // A click on the pane or its title moves the keyboard to that terminal.
      onMouseDown: () => this.focusPaneOf(current()),
    });
    const head = this.box(pane, `head-${name}`, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
    });
    const title = this.text(head, `title-${name}`, name, {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      fg: theme.muted,
      wrapMode: "none",
      truncate: true,
      // The title is a control: a click selects no text.
      selectable: false,
    });
    // While the pointer is over the view of a remote session, × at the end of its title ends the
    // session after the usual confirmation, which also names its child shells.
    const close = this.text(head, `close-${name}`, " × ", {
      height: 1,
      flexShrink: 0,
      fg: theme.muted,
      selectable: false,
      visible: false,
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation();
        const shell = this.shells.find((s) => s.pane === pane);
        if (shell?.remote) this.askEnd(shell.remote);
        else if (shell && this.isLocal(shell)) this.askClose(shell);
      },
    });
    this.hoverable(pane, `pane:${name}`, (on) => {
      const shell = this.shells.find((s) => s.pane === pane);
      close.visible =
        on &&
        !!shell &&
        (this.isLocal(shell) || (!!shell.remote && !shell.exited));
    });
    // While the terminal lacks the keyboard, this layer takes the click, so a click that only
    // focuses never reaches the program (for example an option in a Claude Code menu).
    const shield = this.box(pane, `shield-${name}`, {
      position: "absolute",
      top: 1,
      left: 0,
      right: 0,
      bottom: 0,
      zIndex: 5,
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation();
        event.preventDefault?.();
        // Keep the layer until the button comes up, so the release does not reach the program.
        this.shieldHeld = current();
        this.focusPaneOf(current());
      },
      onMouseDrag: (event: MouseEvent) => event.stopPropagation(),
      onMouseUp: (event: MouseEvent) => {
        event.stopPropagation();
        if (this.shieldHeld !== current()) return;
        this.shieldHeld = undefined;
        this.show("shell");
      },
    });
    return { pane, title, shield };
  }
  /** Find the control of a renderable or of its nearest parent that is a control. */
  hoverKeyOf(node: Renderable | null | undefined) {
    for (let n = node; n; n = n.parent as Renderable | null)
      if (this.hoverKeys.has(n)) return this.hoverKeys.get(n)!;
    return "";
  }
  /** Make a renderable a control that `paint` highlights while the pointer is over it. */
  hoverable(node: Renderable, key: string, paint: (on: boolean) => void) {
    this.hoverKeys.set(node, key);
    this.hoverTargets.set(key, { node, paint });
    paint(this.hover === key);
  }
  setHover(key: string) {
    if (key === this.hover || this.disposed) return;
    const previous = this.hover;
    this.hover = key;
    for (const [k, on] of [
      [previous, false],
      [key, true],
    ] as const) {
      const target = this.hoverTargets.get(k);
      if (target && !target.node.isDestroyed) target.paint(on);
    }
    // The footer explains the state of the session row under the pointer.
    if (previous.startsWith("row:") || key.startsWith("row:"))
      this.drawFooter();
  }
  layoutPanes() {
    const active = this.shells[this.active];
    const pair = this.pair?.includes(active) ? this.pair : undefined;
    const layout = paneLayout(this.renderer.width, this.renderer.height);
    this.shellPane.flexDirection = layout === "side" ? "row" : "column";
    this.shellPane.gap = 0;
    const focusing =
      this.view === "shell" &&
      !this.palette &&
      !this.sheetOpen &&
      !this.listFocused &&
      !active?.exited;
    for (const s of this.shells) {
      s.pane.visible =
        this.view === "shell" &&
        (s === active || (!!pair?.includes(s) && layout !== "single"));
      s.terminal.visible = s.pane.visible;
      s.pane.width = layout === "side" ? undefined : "100%";
      s.pane.height = undefined;
      s.pane.flexGrow = 1;
      if (this.ending && s.remote?.name === this.ending.ref.name)
        s.title.content = styled(this.endingSpans());
      else if (this.closing?.shell === s)
        s.title.content = styled(this.closingSpans());
      else
        s.title.content = new StyledText([
          {
            __isChunk: true,
            text: s.name,
            fg: RGBA.fromHex(s === active ? theme.cpu : theme.fg),
            attributes: s === active ? TextAttributes.BOLD : 0,
          },
          {
            __isChunk: true,
            // The project, unless it only repeats the session name.
            text: this.rowTitle(s) === s.name ? "" : `  ${this.rowTitle(s)}`,
            fg: RGBA.fromHex(theme.muted),
          },
          {
            __isChunk: true,
            text:
              s.remote && isBackground(s.remote)
                ? "  view only · ctrl+k d leaves"
                : "",
            fg: RGBA.fromHex(theme.warning),
          },
        ]);
      s.terminal.blur();
      s.shield.visible =
        s.pane.visible &&
        (!(s === active && focusing) || this.shieldHeld === s.name);
    }
    if (this.pendingPane) {
      const pending = this.pendingShell!;
      this.pendingPane.visible =
        this.view === "shell" &&
        pending.source === active &&
        layout !== "single";
      this.pendingPane.width = layout === "side" ? undefined : "100%";
    }
    this.drawPending();
    // One line parts the views, and the list from the first view beside it: each view's left
    // edge. The view whose terminal has the keyboard lights its edge in the accent colour,
    // brighter for a moment when it takes the keyboard. Stacked views part with a rule at the
    // top of the second. The pane of a starting shell counts as a view.
    const beside = this.splitLayout() && this.view === "shell";
    const focused = active && focusing ? active : undefined;
    if (focused?.name !== this.edgeFocus) {
      this.edgeFocus = focused?.name;
      this.edgeGlowUntil = focused ? this.now() + 500 : 0;
      if (focused)
        setTimeout(() => {
          if (!this.disposed) this.layoutPanes();
        }, 520);
    }
    let first = true;
    for (const child of this.shellPane.getChildren() as BoxRenderable[]) {
      if (child === this.emptyBox) continue;
      const rule = child.visible && !first;
      if (child.visible) first = false;
      const shell = this.shells.find((s) => s.pane === child);
      if (!shell) {
        child.border = rule ? [layout === "side" ? "left" : "top"] : [];
        child.paddingLeft = rule && layout === "side" ? 1 : 0;
        continue;
      }
      const lit = shell === focused;
      child.border = rule && layout === "stack" ? ["top", "left"] : ["left"];
      // A line where it parts the view from the list or from another view, or where it is lit.
      const parts = (layout === "side" && rule) || (!rule && beside);
      child.customBorderChars = {
        ...PANE_EDGE,
        vertical: parts || lit ? "│" : " ",
      };
      child.borderColor = lit
        ? this.now() < this.edgeGlowUntil
          ? theme.cpu
          : theme.edge
        : theme.line;
      child.paddingLeft = 1;
    }
    this.emptyBox.visible = this.view === "shell" && !active;
    if (
      this.view === "shell" &&
      !this.palette &&
      !this.sheetOpen &&
      !this.listFocused &&
      !active?.exited
    )
      active?.terminal.focus();
  }
  focusOther() {
    if (!this.pair) return;
    this.active = this.shells.indexOf(
      this.pair[this.shells[this.active] === this.pair[0] ? 1 : 0],
    );
    this.listFocused = false;
    this.show("shell");
    this.record("pane-focus", { name: this.shells[this.active]?.name });
  }
  async shellHere() {
    const source = this.shells[this.active];
    if (!source || this.auxiliaryPending || this.disposed) return;
    if (this.pair?.includes(source)) {
      this.focusOther();
      return;
    }
    if (this.shells.length >= 4) {
      this.notify("Close a terminal view before opening another shell.", true);
      return;
    }
    if (source.remoteName && !source.remote) {
      this.notify(
        "The remote shell identity is not verified. Refresh its connection first.",
        true,
      );
      return;
    }
    this.auxiliaryPending = true;
    const name = `shell-${crypto.randomUUID().slice(0, 8)}`;
    this.startPending(source);
    let shell: Shell | undefined;
    try {
      if (source.remote) {
        const prepared = await this.backend.shellCommand(source.remote, name);
        if (this.disposed) return;
        shell = this.startShell(name, true, homedir(), prepared.command);
        if (!shell) return;
        shell.cwd = prepared.source.cwd;
        // Keep the new shell unfocused until its identity is verified.
        // Observe the newly created session. Do not retry the creation command.
        for (
          let attempt = 0;
          attempt < 6 && !this.disposed && !shell.exited;
          attempt++
        ) {
          await Bun.sleep(2000);
          const found = (await this.backend.sessions()).find(
            (s) => s.name === name,
          );
          if (found) {
            shell.remote = found;
            shell.cwd = found.cwd;
            break;
          }
        }
        if (!shell.remote && !this.disposed)
          throw new Error(
            `The new shell identity is unverified: ${name}. No second shell was created.`,
          );
      } else {
        shell = this.startShell(name, false, source.cwd);
        if (!shell) return;
        this.pair = [source, shell];
        this.active = this.shells.indexOf(shell);
        this.show("shell");
      }
      if (this.disposed) return;
      this.pair = [source, shell];
      if (this.shells[this.active] === source && !this.palette) {
        this.active = this.shells.indexOf(shell);
        this.show("shell");
      }
      this.record("auxiliary-open", {
        source: source.name,
        name,
        cwd: shell.cwd,
        remote: !!source.remote,
        pid: shell.child.pid,
      });
      this.actionSucceeded("shell here");
    } catch (e) {
      // A shell that failed before the pair took it has no place in the workspace: close its view.
      if (shell && this.pair?.[1] !== shell) this.discardView(shell);
      this.actionFailed("shell here", e);
      this.updateActivity();
    } finally {
      this.auxiliaryPending = false;
      this.endPending();
    }
  }
  /**
   * Close the view of a shell that never joined the workspace. Only its local transport closes;
   * the source view keeps the keyboard.
   */
  discardView(shell: Shell) {
    if (!this.shells.includes(shell)) return;
    const focused = this.shells[this.active];
    shell.adapter.closeTransport();
    shell.pane.destroyRecursively();
    this.shells = this.shells.filter((s) => s !== shell);
    if (this.pair?.includes(shell)) this.pair = undefined;
    this.active = Math.max(
      0,
      this.shells.indexOf(focused === shell ? this.shells[0] : focused),
    );
    this.show("shell");
  }
  /** Close the view of a transport that ended, and return to the list from it. */
  closeEndedView(shell: Shell, notice?: string) {
    const front =
      this.shells[this.active] === shell &&
      this.view === "shell" &&
      !this.palette &&
      !this.sheetOpen;
    // A transport ends some seconds after a detach. A person who is in the list by then keeps
    // their row; the keyboard moves to the row of this view only from its terminal.
    const row = this.listFocused
      ? this.sessionRows()[this.listSelection]?.name
      : (shell.remote?.name ?? shell.name);
    this.discardView(shell);
    if (notice) this.notify(notice);
    if (front) {
      this.focusSessions();
      const index = this.sessionRows().findIndex((r) => r.name === row);
      if (index >= 0) this.listSelection = index;
      this.drawSessions();
    }
    void this.refreshSessions();
  }
  /**
   * Hold the place of a new shell while it starts, so a press of `n` shows at once that the
   * shell is coming. A remote shell takes some seconds: the host creates the session and the
   * app verifies its identity before the view shows it.
   */
  startPending(source: Shell) {
    this.pendingShell = {
      source,
      where: this.rowTitle(source),
      since: Date.now(),
    };
    this.pendingPane = this.box(this.shellPane, "pending-pane", {
      flexDirection: "column",
      flexGrow: 1,
      flexBasis: 0,
      minWidth: 1,
      minHeight: 1,
      borderColor: theme.line,
    });
    this.text(this.pendingPane, "pending-title", "new shell", {
      height: 1,
      fg: theme.muted,
      selectable: false,
    });
    this.pendingText = this.text(this.pendingPane, "pending-text", "", {
      wrapMode: "word",
      selectable: false,
    });
    this.layoutPanes();
  }
  endPending() {
    this.pendingShell = undefined;
    this.pendingPane?.destroyRecursively();
    this.pendingPane = undefined;
    this.pendingText = undefined;
    this.layoutPanes();
  }
  /**
   * Say that the shell is starting and for how long, in its pane; in a single view, where the
   * pane does not show, in the title of the source view.
   */
  drawPending() {
    const pending = this.pendingShell;
    if (!pending || this.disposed) return;
    const seconds = Math.floor((Date.now() - pending.since) / 1000);
    const time = seconds ? ` · ${seconds}s` : "";
    const text = `opening a shell in ${pending.where}${time}`;
    if (this.pendingPane?.visible && this.pendingText) {
      this.pendingText.content = new StyledText([
        {
          __isChunk: true,
          text: "● ",
          fg: RGBA.fromHex(throbColor(theme.cpu, Date.now(), this.animate)),
        },
        { __isChunk: true, text, fg: RGBA.fromHex(theme.muted) },
      ]);
      return;
    }
    const title = pending.source.title;
    if (title.isDestroyed) return;
    title.content = new StyledText([
      ...(title.content as StyledText).chunks.filter(
        (chunk) => !chunk.text.startsWith("  · opening"),
      ),
      // The title already names the directory.
      {
        __isChunk: true,
        text: `  · opening a shell${time}`,
        fg: RGBA.fromHex(theme.muted),
      },
    ]);
  }
  closeAuxiliary() {
    if (!this.pair) return;
    const [source, auxiliary] = this.pair;
    auxiliary.adapter.closeTransport();
    // Closing the view closes only its local transport. Remote state remains owned by the backend.
    auxiliary.pane.destroyRecursively();
    this.shells = this.shells.filter((s) => s !== auxiliary);
    this.pair = undefined;
    this.active = Math.max(0, this.shells.indexOf(source));
    this.show("shell");
    this.record("auxiliary-close", {
      name: auxiliary.name,
      remoteRetained: auxiliary.adapter.kind === "remote",
    });
  }
  async popOut() {
    const ref = this.shells[this.active]?.remote;
    if (!ref || this.auxiliaryPending) return;
    this.auxiliaryPending = true;
    const name = `shell-${crypto.randomUUID().slice(0, 8)}`;
    try {
      const prepared = await this.backend.shellCommand(ref, name);
      const terminal = await openGhosttyWindow(prepared.command);
      this.record("remote-popout", {
        name,
        source: ref.name,
        terminal,
        cwd: prepared.source.cwd,
      });
      this.actionSucceeded("open in Ghostty");
    } catch (e) {
      this.actionFailed("open in Ghostty", e);
      this.updateActivity();
    } finally {
      this.auxiliaryPending = false;
    }
  }

  /** Keep the time and the plain end of a terminal's output. */
  noteOutput(shell: Shell, bytes: Uint8Array) {
    shell.lastOutput = Date.now();
    shell.startupOutput = (
      (shell.startupOutput ?? "") + Buffer.from(bytes).toString()
    )
      .slice(-4096)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
  }

  startShell(
    label?: string,
    remote = false,
    cwd = homedir(),
    command?: string[],
  ) {
    if (this.shells.length >= 4) return;
    const name = label ?? `shell-${this.shells.length + 1}`;
    if (this.shells.some((s) => s.name === name)) return;
    const { pane, title, shield } = this.makePane(name);
    const terminal = new EmbeddedTerminalRenderable(this.renderer, {
      id: name,
      width: "100%",
      height: 1,
      minHeight: 1,
      flexGrow: 1,
      cols: 80,
      rows: 24,
      maxScrollback: 100000,
      transparentBackground: true,
      visible: false,
    });
    if (remote) themeRemoteStatus(terminal, theme.muted, theme.surface);
    pane.add(terminal);
    const adapter = new PtyAdapter(
      remote ? "remote" : "local",
      command ?? localShell,
      {
        data: (bytes) => {
          terminal.write(bytes);
          const s = this.shells.find((s) => s.terminal === terminal);
          if (s) {
            this.noteOutput(s, bytes);
          }
        },
        exit: (code) => {
          const s = this.shells.find((s) => s.terminal === terminal);
          if (s) s.exited = true;
          this.record("shell-exit", { name, code });
          this.updateActivity();
        },
        clipboard: (text) => this.programCopied(text),
        open: (url) =>
          this.programOpened(
            url,
            this.shells.find((s) => s.terminal === terminal),
          ),
      },
      cwd,
    );
    this.selectOnlyUntracked(terminal);
    const child = adapter.child;
    const shell: Shell = {
      terminal,
      pane,
      title,
      shield,
      cwd,
      remoteName: remote ? name : undefined,
      adapter,
      child,
      name,
      lastOutput: Date.now(),
      exited: false,
    };
    this.shells.push(shell);
    terminal.onData = (data, source) => {
      if (shell.exited) return;
      if (source === "response") adapter.reply(data);
      else {
        shell.lastInput = this.now();
        adapter.write(data);
      }
    };
    terminal.onTerminalResize = (cols, rows) => {
      adapter.resize(cols, rows);
      this.record("pty-resize", { name, cols, rows });
    };
    child.exited.then((code) => {
      shell.exited = true;
      this.record("shell-exit", { name, code });
      this.afterExit(shell);
    });
    this.record("shell-start", {
      name,
      pid: child.pid,
      kind: adapter.kind,
      cwd,
    });
    return shell;
  }
  /**
   * The failure of one source that its own view shows as a line at its top: a read that failed for
   * its own reason. While a failure of the whole link shows the band, the views show no line.
   */
  viewFailure(source: "sessions" | "health"): Failure | undefined {
    if (this.currentError()?.scope === "global") return undefined;
    const failure = this.sources[source].failure;
    return failure?.kind === "failed" ? failure : undefined;
  }
  /**
   * The amber line of a failed source, with its keys at the right edge of `width` cells. A title
   * that does not leave room for the keys wraps, and the keys take the next line.
   */
  errorLine(failure: Failure, width: number): Span[][] {
    const keys = "u retry · e details";
    const title = `▲ ${failure.title}`;
    if (title.length + 2 + keys.length <= width)
      return [
        [
          { text: title.padEnd(width - keys.length), tone: "warning" },
          { text: keys, tone: "dim" },
        ],
      ];
    return [
      ...wrapText(title, width).map((text): Span[] => [
        { text, tone: "warning" },
      ]),
      [{ text: keys, tone: "dim" }],
    ];
  }
  /**
   * True when the failure shown offers a retry in the view of `source`: a failure of the whole
   * link in every view, a failure of one source only in the view that shows it.
   */
  retryOffered(source: "sessions" | "health") {
    const error = this.currentError();
    if (!error) return false;
    if (error.scope === "global") return error.recovery === "retry";
    return this.viewFailure(source) !== undefined;
  }
  /** The one failure that every view, the header and the band read. */
  currentError(): ErrorState | undefined {
    return errorState(this.sources, this.now());
  }
  signInExpired() {
    return this.currentError()?.kind === "signed-out";
  }
  /** The freshness and the last good read time (seconds) of one source, for a receipt event. */
  receiptFreshness(source: Source) {
    const status = this.sources[source];
    return {
      freshness: status.freshness(this.now()),
      read_at: status.okAt / 1000,
    };
  }
  /** Record a failed read of one source and return its classified failure. */
  readFailed(source: Source, error: unknown, started?: number): Failure {
    const failure = classify(source, error, this.now());
    this.sources[source].fail(failure);
    // Only a read that started after the sign-in tests the new credentials; an older read that
    // fails now says nothing about them. A read with no known start counts as older.
    if (
      this.afterSignIn === "refreshing" &&
      started !== undefined &&
      started >= this.signInDoneAt &&
      this.currentError()?.scope === "global"
    )
      this.afterSignIn = "failed";
    // The refresh note belongs to an expired sign-in only; another problem ends it.
    const kind = this.currentError()?.kind;
    if (this.afterSignIn && kind && kind !== "signed-out") this.afterSignIn = undefined;
    return failure;
  }
  /** A read of one source succeeded: its failure ends. */
  readSucceeded(source: Source) {
    const wasGlobal = this.currentError()?.scope === "global";
    this.sources[source].succeed(this.now());
    if (this.currentError()?.scope !== "global") this.afterSignIn = undefined;
    // One good read shows that the link works: the other sources read at once.
    if (wasGlobal && this.currentError()?.scope !== "global") this.recover();
  }
  /**
   * Read each source that is not live, without a wait for its timer: the sessions at once, Health
   * at once, and spend in that Health read. A notice about a failure of the link ends, and so does
   * the details box. Each source stays `last known` until its own read succeeds.
   */
  recover() {
    if (this.disposed) return;
    const now = this.now();
    if (this.footerNotice?.cause) {
      this.footerNotice = undefined;
      this.footerSignature = "";
      this.drawFooter();
    }
    this.detailsOpen = false;
    if (this.sources.spend.freshness(now) !== "live") this.spendAt = 0;
    if (this.sources.health.freshness(now) !== "live" && !this.sampling) {
      clearTimeout(this.sampleTimer);
      void this.sampleHealth();
    }
    if (this.sources.sessions.freshness(now) !== "live")
      void (async () => {
        while (this.sessionsLoading && !this.disposed) await Bun.sleep(100);
        if (
          !this.disposed &&
          this.sources.sessions.freshness(this.now()) !== "live"
        )
          await this.refreshSessions();
      })();
    this.drawProblem();
  }
  /** Rows that the band takes under the header. */
  bandRows = 0;
  /**
   * The second row of the band, by kind. Each kind lists its wording from the fullest to the
   * shortest; the row takes the first that fits `room` cells, so the age of the last good read
   * stays whole. Only the shortest wording is cut, and then at a word boundary.
   */
  bandSubText(state: ErrorState, room = Infinity) {
    const read = state.lastSuccess
      ? syncedText(state.lastSuccess, this.now())
      : undefined;
    const synced = read ? `Last synced ${read}.` : "Nothing was read yet.";
    if (state.scope === "global" && state.kind === "signed-out" && this.afterSignIn) {
      const lead = this.afterSignIn === "refreshing"
        ? "Signed in. Reading the workstation again."
        : "The refresh after sign-in failed.";
      const fits = [`${lead} ${synced}`, lead].find((text) => text.length <= room);
      return fits ?? lead.slice(0, Math.max(0, room - 1)) + "…";
    }
    const wording: string[] = (() => {
      switch (state.kind) {
        case "signed-out":
          return [`Live status unavailable. ${synced}`, synced];
        case "offline":
          return read
            ? [
                `Showing the last known state from ${read}. Retrying every 30 s.`,
                `Last known state from ${read}. Retrying every 30 s.`,
                `Showing the last known state from ${read}.`,
                synced,
              ]
            : ["Nothing was read yet. Retrying every 30 s.", synced];
        case "stopped":
          return [`Start it in AWS, then press u. ${synced}`, synced];
        case "not-ready":
          return [`Tokiwa retries every 30 s. ${synced}`, synced];
        default:
          return [state.explanation];
      }
    })();
    const fits = wording.find((text) => text.length <= room);
    if (fits) return fits;
    const last = wording[wording.length - 1];
    const cut = last.slice(0, Math.max(0, room - 1));
    const word = cut.lastIndexOf(" ");
    return `${(word > 0 && last[cut.length] !== " " ? cut.slice(0, word) : cut).trimEnd()}…`;
  }
  /** The lines of the details box: the facts, one row per failed source, then the launcher text. */
  detailLines(state: ErrorState, inner: number) {
    const label = (name: string) => name.padEnd(14);
    const names: Record<Source, string> = {
      sessions: "Workspace",
      health: "Health",
      spend: "Spend",
    };
    // The profile and the command help when the built-in sign-in fails.
    // Read only while the box shows: drawProblem runs several times a second.
    const profile = state.recovery === "sign-in" && this.detailsOpen ? awsProfile() : "";
    const recovery = {
      "sign-in": profile
        ? `l signs in, or run aws sso login --profile ${profile}`
        : "l runs tokiwa login in a local view",
      retry: "u reads again",
      none: "Fix it outside the app. Tokiwa reads again every 30 s",
    }[state.recovery];
    const facts = [
      [
        "Last synced",
        state.lastSuccess
          ? syncedText(state.lastSuccess, this.now())
          : "nothing was read yet",
      ],
      ["Affected", state.affected.map((s) => names[s]).join(", ")],
      ...(profile ? [["Profile", profile]] : []),
      ["Recovery", recovery],
    ].flatMap(([key, value]) =>
      wrapText(value, Math.max(8, inner - 14)).map(
        (line, i) => (i ? " ".repeat(14) : label(key)) + line,
      ),
    );
    const rows = state.diagnostics.map((f) => {
      const call = f.command
        ? f.code !== null
          ? `${f.command} exit ${f.code}`
          : f.command
        : "launcher";
      return `${label(f.source)}${call} · ${f.category ?? f.kind} · ${timeOfDay(f.at)}`;
    });
    // The cause is usually last, so the box keeps the last six lines of the launcher text.
    // Each distinct text once: both reads often fail with the same output.
    const text = [...new Set(state.diagnostics.map((f) => f.detail))]
      .flatMap((block) => block.split("\n"))
      .flatMap((line) => wrapText(line, inner))
      .filter(Boolean)
      .slice(-6);
    return [
      ...facts,
      ...(rows.length ? ["", ...rows] : []),
      ...(text.length ? ["", ...text] : []),
    ];
  }
  /**
   * Name the current global failure in the band under the header: its cause in plain words, then
   * what it means and the age of the last good read. A failure of one source has no band; its
   * view shows one line. The launcher text and the diagnostics stay behind e.
   */
  drawProblem() {
    if (!this.band) return;
    const state = this.currentError();
    this.logFailures();
    const rows = this.bandRows;
    const global = state?.scope === "global";
    this.band.visible = !!state && (global || this.detailsOpen);
    if (!state) {
      this.detailsOpen = false;
      this.bandDetail.visible = false;
      this.bandRows = 0;
    } else {
      const signing = state.kind === "signed-out" && this.signingIn();
      this.bandRow.visible = global;
      this.bandSub.visible = global && !signing;
      this.bandTitle.fg =
        state.kind === "setup" ? theme.critical : theme.warning;
      const refreshing =
        global && state.kind === "signed-out" && this.afterSignIn === "refreshing";
      this.bandTitle.content = signing
        ? "▲ Signing in… finish in the browser"
        : refreshing
          ? "▲ Refreshing…"
          : `▲ ${state.title}`;
      // Indented two cells under the title, which follows the ▲ glyph and a space.
      this.bandSub.content = `  ${this.bandSubText(
        state,
        this.renderer.width - 2 * (this.renderer.width < 70 ? 1 : 2) - 2,
      )}`;
      const action =
        state.recovery === "retry"
          ? "u retry"
          : state.recovery === "sign-in"
            ? signing
              ? "l shows the sign-in"
              : "l sign in"
            : "";
      this.bandAction =
        action && state.recovery !== "none" ? state.recovery : undefined;
      this.bandActionWidth = action.length;
      const keys = `${action ? `${action} · ` : ""}${this.detailsOpen ? "e hides details" : "e details"}`;
      this.bandKeys.content = keys;
      this.bandKeys.width = keys.length;
      const lines = this.detailLines(
        state,
        Math.max(20, this.renderer.width - 8),
      );
      this.bandDetail.visible = this.detailsOpen;
      this.bandDetailText.content = lines.join("\n");
      this.bandDetailText.height = lines.length;
      this.bandRows =
        (global ? (signing ? 1 : 2) : 0) +
        (this.detailsOpen ? lines.length + 2 : 0);
    }
    if (rows !== this.bandRows && this.view === "health") this.drawHealth();
  }
  toggleDetails() {
    if (!this.currentError()) return;
    this.detailsOpen = !this.detailsOpen;
    this.drawProblem();
  }
  /**
   * Write each new failure, with its raw output, to the error log. A repeated failure is written
   * once. The log keeps one older file when it passes 1 MB.
   */
  logFailures() {
    const failures = (["sessions", "health"] as const).flatMap(
      (source) => this.sources[source].failure ?? [],
    );
    const file =
      process.env.TOKIWA_ERROR_LOG ??
      join(homedir(), ".local", "state", "tokiwa", "errors.log");
    for (const f of failures) {
      const { source } = f;
      const header = [
        source,
        f.kind,
        f.command && `command=${f.command}`,
        f.code !== null && `exit=${f.code}`,
        f.category && `category=${f.category}`,
      ]
        .filter(Boolean)
        .join(" ");
      const raw = f.raw.trimEnd() || f.summary;
      const key = `${header}\n${raw}`;
      if (this.logged[source] === key || this.options.spawn === false) continue;
      this.logged[source] = key;
      try {
        mkdirSync(dirname(file), { recursive: true });
        try {
          if (statSync(file).size > 1 << 20) renameSync(file, `${file}.1`);
        } catch {}
        appendFileSync(
          file,
          `${new Date().toISOString()} ${header}\n${raw}\n\n`,
        );
      } catch {}
    }
    for (const source of Object.keys(this.logged))
      if (!failures.some((f) => f.source === source))
        delete this.logged[source];
  }
  /**
   * A click at `column` of the band's key hints: the recovery hint (sign in or retry) runs its action;
   * the rest opens or closes the details, as a click elsewhere on the band does.
   */
  clickBandKey(column: number) {
    if (this.bandAction && column < this.bandActionWidth) {
      // The sheet would cover the sign-in view; it does nothing when no sheet is open.
      this.closeSheet();
      if (this.bandAction === "sign-in") this.signIn();
      else this.runAction("refresh");
      return;
    }
    this.toggleDetails();
  }
  signingIn() {
    return !!this.signInShell && !this.signInShell.exited;
  }
  /**
   * Run the AWS sign-in in a local view. The browser opens on this Mac. After a success the view
   * closes and the sessions are read again; after a failure the view stays.
   */
  signIn() {
    if (this.signingIn()) {
      this.active = this.shells.indexOf(this.signInShell!);
      this.listFocused = false;
      this.show("shell");
      return;
    }
    if (this.signInShell) this.discardView(this.signInShell);
    const shell = this.startShell(
      "aws-sign-in",
      false,
      localDirectory,
      this.backend.loginCommand(),
    );
    if (!shell) {
      this.notify("Close a terminal view before you sign in.", true);
      return;
    }
    this.signInShell = shell;
    this.afterSignIn = undefined;
    this.active = this.shells.indexOf(shell);
    this.listFocused = false;
    this.show("shell");
    this.drawHeader();
    void shell.child.exited.then(async (code) => {
      if (this.disposed || this.signInShell !== shell) return;
      if (code !== 0) {
        this.drawHeader();
        return this.drawSessions();
      }
      this.signInShell = undefined;
      this.discardView(shell);
      // The stale warning stays until a fresh read succeeds; until then the band says Refreshing….
      this.signInDoneAt = this.now();
      this.afterSignIn = this.currentError()?.kind === "signed-out" ? "refreshing" : undefined;
      this.drawProblem();
      this.recover();
    });
  }
  /**
   * Read the session snapshot through the launcher. One read runs at a time. While the app runs
   * with its processes, the next read follows 5 seconds after the first and then every 30 seconds
   * while the workspace is in view.
   */
  async refreshSessions() {
    if (this.sessionsLoading || this.disposed) return;
    this.sessionsLoading = true;
    clearTimeout(this.sessionTimer);
    // After a period without a live read the next read has no earlier snapshot to compare with.
    const wasLive = this.sources.sessions.freshness(this.now()) === "live";
    // The next read follows soon only after a good read that follows a gap (or the first one).
    let second = false;
    const started = this.now();
    const selected = this.sessionRows()[this.listSelection]?.name;
    this.drawHeader();
    try {
      const rows = await this.backend.sessions();
      if (this.disposed) return;
      this.previousSessions = wasLive
        ? new Map(this.remoteSessions.map((r) => [r.name, r]))
        : new Map();
      this.remoteSessions = this.keepCreated(rows, started);
      // A seen bell stays hidden until the host reports the session without a bell.
      for (const [name, identity] of this.acknowledged) {
        const ref = rows.find((r) => r.name === name);
        if (!ref?.bell || ref.identity !== identity)
          this.acknowledged.delete(name);
      }
      for (const [name, at] of this.attentionSeen) {
        const ref = rows.find((r) => r.name === name);
        if (ref?.attention !== at) this.attentionSeen.delete(name);
      }
      second = !this.sessionsRead || !wasLive;
      this.sessionsRead = true;
      this.readSucceeded("sessions");
      this.record("remote-sessions-refreshed", {
        count: rows.length,
        ...this.receiptFreshness("sessions"),
      });
    } catch (e) {
      if (this.disposed) return;
      const failure = this.readFailed("sessions", e, started);
      this.record("remote-sessions-error", {
        error: failure.detail || failure.summary,
        ...this.receiptFreshness("sessions"),
      });
    } finally {
      this.sessionsLoading = false;
    }
    const index = this.sessionRows().findIndex((r) => r.name === selected);
    if (index >= 0) this.listSelection = index;
    // Update the current view without reclaiming keyboard focus after I/O.
    this.drawSessions();
    this.drawHeader();
    this.drawFooter();
    if (this.palette) this.drawActions();
    if (this.options.spawn !== false)
      this.sessionTimer = setTimeout(
        () => {
          if (this.view === "shell") void this.refreshSessions();
          else this.sessionTimer = undefined;
        },
        second ? SESSIONS_SECOND_READ_MS : SESSIONS_REFRESH_MS,
      );
  }
  /**
   * The owner attached this session and so saw its bell. tmux clears the flag only for the window
   * that the new client views, so the list hides the bell itself.
   */
  acknowledge(name: string) {
    const ref = this.remoteSessions.find((r) => r.name === name);
    if (ref?.bell) this.acknowledged.set(name, ref.identity);
    if (ref?.attention) this.attentionSeen.set(name, ref.attention);
  }
  /** Open the connection card, or close it when it is open. */
  toggleConnection() {
    if (!this.connectionCard) return;
    const open = !this.connectionCard.visible;
    if (open) {
      // Only a running Tokiwa probes; a test or a capture shows the tries it has.
      if (
        this.probeTimer &&
        (!this.pings.length || this.now() - this.pings.at(-1)!.at > 5000)
      )
        void this.probe();
      this.drawConnection();
    }
    this.connectionCard.visible = open;
  }
  /** Name the state of the EC2 host from the last session and Health reads. */
  /**
   * The link from this Mac to the workstation, for example `my-mac → EC2 · connected`:
   * connecting before the first read, connected after a read in the last minutes, reconnecting
   * when the last good read is old, offline when the last read failed.
   */
  hostLabel(withDevice = true) {
    const link = withDevice ? `${this.device} → EC2` : "EC2";
    const state = this.hostState();
    return state ? `${link} · ${state}` : link;
  }
  /** The state of the link, or an empty string before the first read starts. */
  hostState() {
    // Connectivity first, then the workstation. A failure of one source changes neither.
    const state = this.currentError();
    if (state?.scope === "global" && state.link) {
      const word = {
        "signed-out": "signed out",
        offline: "offline",
        stopped: "stopped",
        "not-ready": "not ready",
      }[state.link as string];
      if (word) return word;
    }
    const { sessions, health } = this.sources;
    const ok = Math.max(sessions.okAt, health.okAt);
    if (!ok)
      return !sessions.failAt &&
        !health.failAt &&
        (this.sessionsLoading || this.sampling)
        ? "connecting"
        : "";
    if (this.now() - ok > HOST_STALE_MS) return "reconnecting";
    return "connected";
  }
  /**
   * Try once to reach AWS Session Manager, the path of every session, and keep the last 20
   * tries for the connection card. A try that fails or takes over 3 s is lost.
   */
  async probe() {
    let ms: number | null = null;
    try {
      ms = await (this.options.probe ?? reachAws)();
    } catch {
      ms = null;
    }
    if (this.disposed) return;
    this.pings = [...this.pings, { at: this.now(), ms }].slice(-20);
    if (this.connectionCard?.visible) this.drawConnection();
  }
  /**
   * The breadcrumb. Until the first read of the workstation ends, its diamond cycles through
   * ◇ ◈ ◆ ◈ in a pulsing accent; then it settles. Reduced motion keeps it still.
   */
  drawLocation() {
    if (this.disposed) return;
    const settled =
      !this.animate ||
      this.options.spawn === false ||
      this.sessionsRead ||
      this.sources.sessions.failAt > 0 ||
      this.sources.health.failAt > 0;
    const frames = ["◇", "◈", "◆", "◈"];
    const glyph = settled
      ? "◇"
      : frames[Math.floor(Date.now() / 160) % frames.length];
    this.location.content = new StyledText([
      {
        __isChunk: true,
        text: glyph,
        fg: RGBA.fromHex(
          settled ? theme.fg : throbColor(theme.cpu, Date.now(), true),
        ),
        attributes: TextAttributes.BOLD,
      },
      {
        __isChunk: true,
        text: ` tokiwa  /  ${this.view === "health" ? "Health" : "Workspace"}`,
        fg: RGBA.fromHex(theme.fg),
        attributes: TextAttributes.BOLD,
      },
    ]);
    if (settled && this.startupTimer) {
      clearInterval(this.startupTimer);
      this.startupTimer = undefined;
    } else if (!settled && !this.startupTimer)
      this.startupTimer = setInterval(() => this.drawLocation(), 160);
  }
  /** Fill the connection card: ping and loss to AWS, and the sessions. */
  drawConnection() {
    if (!this.connectionText || this.disposed) return;
    const tries = this.pings;
    const times = tries.flatMap((t) => (t.ms === null ? [] : [t.ms]));
    const ms = (n: number) => `${Math.round(n)} ms`;
    const last = tries.at(-1);
    const average = times.length
      ? times.reduce((a, b) => a + b, 0) / times.length
      : 0;
    // Jitter: the mean change between one try and the next.
    const jitter =
      times.length > 1
        ? times.slice(1).reduce((n, t, k) => n + Math.abs(t - times[k]), 0) /
          (times.length - 1)
        : 0;
    const lost = tries.length - times.length;
    const here = this.shells.filter((s) => s.remote && !s.exited).length;
    const rows: [string, string][] = [
      [
        "ping",
        !last
          ? "measuring…"
          : last.ms === null
            ? `lost · avg ${times.length ? ms(average) : "—"}`
            : `${ms(last.ms)}  avg ${ms(average)} · jitter ${ms(jitter)}`,
      ],
      [
        "loss",
        tries.length
          ? `${Math.round((100 * lost) / tries.length)} % (${lost} of the last ${tries.length} tries)`
          : "measuring…",
      ],
      [
        "sessions",
        `${here} open here · ${this.remoteSessions.length} on the workstation`,
      ],
    ];
    const spans: Span[] = [
      { text: "Connection\n", tone: "title" },
      { text: `${this.hostLabel()}\n\n`, tone: "dim" },
      ...rows.flatMap(([k, v], n): Span[] => [
        { text: k.padEnd(11), tone: "dim" },
        { text: `${v}${n < rows.length - 1 ? "\n" : ""}`, tone: "value" },
      ]),
    ];
    this.connectionText.content = styled(spans);
    const lines = spans
      .map((sp) => sp.text)
      .join("")
      .split("\n");
    this.connectionText.height = lines.length;
    this.connectionText.width = Math.max(...lines.map((l) => l.length));
  }
  /**
   * The link to the workstation as a dot and a word: ● connected, ◐ reconnecting, ○ signed out
   * or offline, ◌ before the first read. Connected needs no word. Health names this Mac.
   */
  /** The title that the terminal last got; a redraw writes the title only when it changes. */
  terminalTitle?: string;
  /** Name the session in the pane in the terminal's tab, for example `web-lead · tokiwa`. */
  drawTitle() {
    const shell = this.shells[this.active];
    const name = shell?.remoteName ?? shell?.name;
    const title = name ? `${name} · tokiwa` : "tokiwa";
    if (title === this.terminalTitle) return;
    // The renderer refuses a title outside its running phase; the next redraw tries again.
    if (this.setTitle(title)) this.terminalTitle = title;
  }
  setTitle(title: string) {
    try {
      this.renderer.setTerminalTitle(title);
      return true;
    } catch {
      return false;
    }
  }
  drawHeader() {
    if (this.disposed) return;
    this.drawLocation();
    this.drawTitle();
    const state = this.hostState();
    const glyph =
      state === "connected"
        ? "●"
        : state === "reconnecting"
          ? "◐"
          : /signed out|offline|stopped|not ready/.test(state)
            ? "○"
            : "◌";
    const word = state && state !== "connected" ? ` · ${state}` : "";
    const warn = /offline|reconnecting|signed out|stopped|not ready/.test(
      state,
    );
    this.source.content = new StyledText([
      {
        __isChunk: true,
        text: glyph,
        fg: RGBA.fromHex(
          warn
            ? theme.warning
            : state === "connected"
              ? theme.cpu
              : theme.muted,
        ),
      },
      {
        __isChunk: true,
        text: ` EC2${word}`,
        fg: RGBA.fromHex(warn ? theme.warning : theme.muted),
      },
    ]);
    this.source.width = 1 + ` EC2${word}`.length;
    this.drawProblem();
  }
  confirmOperation(ref: SessionRef, operation: "project") {
    this.askOperation({ operation, ref });
  }
  /** After a rename, the open view of the session takes the new name. */
  renamedSession(from: string, to: string) {
    for (const shell of this.shells)
      if (shell.remote?.name === from || shell.remoteName === from) {
        shell.name = to;
        shell.remoteName = to;
        if (shell.remote) shell.remote = { ...shell.remote, name: to };
      }
    const seen = this.acknowledged.get(from);
    if (seen !== undefined) {
      this.acknowledged.delete(from);
      this.acknowledged.set(to, seen);
    }
    this.layoutPanes();
    this.drawSessions();
  }
  /** Ask "end this session?" in its row and title: enter ends, s keeps its shells, esc keeps it. */
  askEnd(ref: SessionRef) {
    const id = ref.identity.split(":")[1];
    this.ending = {
      ref,
      children: this.remoteSessions.filter((r) => r.parent === id),
    };
    this.redrawEnding();
  }
  cancelEnd() {
    this.ending = undefined;
    this.redrawEnding();
  }
  redrawEnding() {
    this.drawSessions();
    this.layoutPanes();
    this.drawFooter();
    if (this.palette) this.drawActions();
  }
  /** End the asked session, and its shells unless `keepShells`. Folders and history stay. */
  async endSession(keepShells: boolean) {
    const pending = this.ending;
    if (!pending || pending.busy) return;
    pending.busy = `ending ${pending.ref.name}…`;
    this.redrawEnding();
    try {
      await this.backend.end(pending.ref, pending.ref.name);
      if (!keepShells)
        for (const child of pending.children)
          await this.backend.end(child, child.name);
      this.record("remote-operation", { operation: "end", keepShells });
      this.notify(
        `ended ${pending.ref.name}${!keepShells && pending.children.length ? ` and ${pending.children.length} shell${pending.children.length === 1 ? "" : "s"}` : ""}`,
      );
    } catch (e) {
      this.actionFailed(`end ${pending.ref.name}`, e);
    }
    if (this.ending === pending) this.ending = undefined;
    await this.refreshSessions();
    this.redrawEnding();
  }
  isLocal(shell: Shell) {
    return !shell.remote && !shell.remoteName;
  }
  /** Close a local shell. While a program runs in it, ask first. */
  askClose(shell: Shell) {
    const program = shell.exited
      ? undefined
      : foregroundProgram(shell.child.pid);
    if (program) {
      this.closing = { shell, program, quit: false };
      this.redrawEnding();
    } else this.closeLocal(shell);
  }
  closeLocal(shell: Shell) {
    this.closing = undefined;
    this.closeEndedView(shell, `closed ${shell.name}`);
    this.redrawEnding();
  }
  /** Quit. While a program runs in a local shell, ask first: quitting ends the local shells. */
  askQuit() {
    const busy = this.shells
      .filter((s) => this.isLocal(s) && !s.exited)
      .flatMap((shell) => {
        const program = foregroundProgram(shell.child.pid);
        return program ? [{ shell, program }] : [];
      });
    if (!busy.length) return this.close();
    const more = busy.length > 1 ? ` and ${busy.length - 1} more` : "";
    this.closing = {
      shell: busy[0].shell,
      program: `${busy[0].program}${more}`,
      quit: true,
    };
    this.redrawEnding();
  }
  answerClose(yes: boolean) {
    const asked = this.closing;
    this.closing = undefined;
    if (asked && yes) {
      if (asked.quit) return this.close();
      this.closeLocal(asked.shell);
    }
    this.redrawEnding();
  }
  /** The question of a local shell as spans, with each answer a control. */
  closingSpans(): { text: string; tone: Tone; run?: () => void }[] {
    const c = this.closing!;
    const plural = /\d more$/.test(c.program) ? "are" : "is";
    return [
      {
        text: `${c.quit ? "quit" : "close"}? ${c.program} ${plural} still running  `,
        tone: "warning",
      },
      {
        text: c.quit ? "enter quits" : "enter closes",
        tone: "value",
        run: () => this.answerClose(true),
      },
      { text: " · ", tone: "dim" },
      { text: "esc keeps", tone: "value", run: () => this.answerClose(false) },
    ];
  }
  /** Open the list of background sessions. */
  openBackground() {
    if (this.palette) this.dismiss();
    this.picker = true;
    this.openPalette();
  }
  /** The background list as search rows: a session and the program that runs in it. */
  backgroundChoices() {
    const items = this.backgroundRows().map((row): SearchItem => ({
      label: row.name,
      detail: row.ref?.activity?.[0]?.command ?? "",
      category: "Sessions",
      run: () => this.openRow(row, "keyboard"),
    }));
    return {
      items,
      rows: items.map((item, index): SearchRow => ({
        kind: "item",
        item,
        index,
      })),
    };
  }
  /** Ask to end a project: its sessions end, and a named project is forgotten. */
  askEndProject(path: string) {
    this.endingProject = { path, refs: this.projectSessions(path) };
    this.redrawEnding();
  }
  cancelEndProject() {
    this.endingProject = undefined;
    this.redrawEnding();
  }
  async endProject() {
    const pending = this.endingProject;
    if (!pending || pending.busy) return;
    pending.busy = `ending ${pending.refs.length} session${pending.refs.length === 1 ? "" : "s"}…`;
    this.redrawEnding();
    try {
      for (const ref of pending.refs) await this.backend.end(ref, ref.name);
      if (!pending.path.startsWith("/"))
        await this.backend.forgetProject(pending.path);
      this.record("remote-operation", { operation: "end-project" });
      this.notify(`ended ${projectTitle(pending.path)}`);
    } catch (e) {
      this.actionFailed(`end ${projectTitle(pending.path)}`, e);
    }
    if (this.endingProject === pending) this.endingProject = undefined;
    await this.refreshSessions();
    this.redrawEnding();
  }
  /** The question of an ending project as spans, with each answer a control. */
  endingProjectSpans(): { text: string; tone: Tone; run?: () => void }[] {
    const e = this.endingProject!;
    if (e.busy) return [{ text: e.busy, tone: "dim" }];
    const names = e.refs.slice(0, 3).map((r) => r.name);
    const more = e.refs.length - names.length;
    const what = !e.refs.length
      ? "forget this project?"
      : `end ${names.join(", ")}${more ? ` and ${more} more` : ""}?`;
    return [
      { text: `${what}  `, tone: "warning" },
      {
        text: e.refs.length ? "enter ends" : "enter forgets",
        tone: "value",
        run: () => void this.endProject(),
      },
      { text: " · ", tone: "dim" },
      { text: "esc keeps", tone: "value", run: () => this.cancelEndProject() },
    ];
  }
  /** The question of an ending session as spans, with each answer a control. */
  endingSpans(): { text: string; tone: Tone; run?: () => void }[] {
    const e = this.ending!;
    if (e.busy) return [{ text: e.busy, tone: "dim" }];
    const n = e.children.length;
    const shells = n ? ` and ${n} shell${n === 1 ? "" : "s"}` : "";
    return [
      { text: `end ${e.ref.name}${shells}?  `, tone: "warning" },
      {
        text: n ? "enter ends all" : "enter ends",
        tone: "value",
        run: () => void this.endSession(false),
      },
      ...(n
        ? [
            { text: " · ", tone: "dim" as Tone },
            {
              text: "s keeps the shells",
              tone: "value" as Tone,
              run: () => void this.endSession(true),
            },
          ]
        : []),
      { text: " · ", tone: "dim" },
      { text: "esc keeps", tone: "value", run: () => this.cancelEnd() },
    ];
  }
  /** Open the search box as a prompt for one operation. */
  askOperation(op: Operation) {
    if (this.palette) this.dismiss();
    this.ownFolder = true;
    this.paletteTitle = this.operationText(op).title;
    this.openPalette();
    this.confirm = op;
    this.confirmStatus = undefined;
    this.quickArmed = false;
    this.search!.placeholder = this.operationText(op).placeholder;
    if (op.operation === "rename-session") this.search!.value = op.ref.name;
    if (op.operation === "rename-project")
      this.search!.value = projectTitle(op.path).split("/").at(-1) ?? "";
    this.drawActions();
    this.drawFooter();
  }
  /** The placeholder of the prompt and the line under it, in plain words. */
  operationText(op: Operation): {
    title?: string;
    placeholder: string;
    hint: string;
  } {
    const shells = (n: number) => (n === 1 ? "1 shell" : `${n} shells`);
    switch (op.operation) {
      case "project":
        return {
          placeholder: `Move ${op.ref.name} to project, for example studio/api`,
          hint: "Press enter to move it; its folder and processes stay",
        };
      case "new-session": {
        const name = this.search?.value.trim() || this.suggestName(op.path);
        // The last two names of the folder fit the prompt; the footer offers tab.
        return {
          title: `New session in ${projectTitle(op.path)}`,
          placeholder: `name, or enter for ${this.suggestName(op.path)}`,
          hint: `It starts in ${projectTitle(this.ownFolder ? `${op.dir}/${name}` : op.dir)}`,
        };
      }
      case "new-project": {
        // The folder takes the last name of the project, and the first session takes it too.
        const last = (this.search?.value ?? "")
          .split("/")
          .filter(Boolean)
          .at(-1);
        return {
          placeholder: "New project, for example inbox or studio/inbox",
          hint: !last
            ? "It starts in a new folder in workbench/"
            : `It starts in ${this.ownFolder ? `${last}/${last}` : `workbench/${last}`}`,
        };
      }
      case "rename-session":
        return {
          placeholder: `Rename ${op.ref.name}`,
          hint: "Press enter to rename; the session keeps running",
        };
      case "rename-project":
        return {
          placeholder: `Rename ${projectTitle(op.path)}`,
          hint: "Press enter to rename; sessions, folders and history stay",
        };
    }
  }
  /** A free session name for a project: its last name, then -2, -3 and so on. */
  suggestName(path: string) {
    const base =
      (path.split("/").at(-1) ?? "session")
        .replace(/[^A-Za-z0-9_-]/g, "-")
        .slice(0, 40) || "session";
    const taken = new Set([
      ...this.remoteSessions.map((r) => r.name),
      ...this.starting.keys(),
    ]);
    for (let n = 1; ; n++) {
      const name = n === 1 ? base : `${base}-${n}`;
      if (!taken.has(name)) return name;
    }
  }
  async completeOperation() {
    const pending = this.confirm;
    // An operation that runs ignores a second enter.
    if (!pending || (this.confirmStatus && !this.confirmStatus.failed)) return;
    const value = (this.search?.value ?? "").trim();
    const working = (text: string) => {
      this.confirmStatus = { text, failed: false };
      this.drawActions();
    };
    try {
      // A new session starts behind the list: the prompt closes at once.
      if (
        pending.operation === "new-session" ||
        pending.operation === "new-project"
      ) {
        const path =
          pending.operation === "new-session"
            ? pending.path
            : projectName(value);
        const name =
          pending.operation === "new-session"
            ? sessionName(value || this.suggestName(path))
            : this.suggestName(path);
        if (
          this.remoteSessions.some((r) => r.name === name) ||
          this.starting.has(name)
        )
          throw new Error("A session with this name exists.");
        this.dismiss();
        void this.startSession(
          name,
          pending.operation === "new-session"
            ? { dir: pending.dir }
            : { folder: path.split("/").at(-1)! },
          path,
          this.ownFolder ? name : undefined,
        );
        return;
      }
      switch (pending.operation) {
        case "project":
          working("Moving the session…");
          await this.backend.setProject(pending.ref, value);
          break;
        case "rename-session": {
          if (value === pending.ref.name) break;
          working(`Renaming to ${value}…`);
          await this.backend.renameSession(pending.ref, value);
          this.renamedSession(pending.ref.name, value);
          break;
        }
        case "rename-project": {
          // The new last name; a nested project stays where it is.
          const name = projectName(value);
          if (name.includes("/")) throw new Error("Use one name, without /.");
          const parent =
            pending.path.startsWith("/") || !pending.path.includes("/")
              ? ""
              : pending.path.slice(0, pending.path.lastIndexOf("/"));
          const to = parent ? `${parent}/${name}` : name;
          working(`Renaming to ${to}…`);
          await this.backend.moveProject(pending.path, to);
          const at = this.projectOrder.indexOf(pending.path);
          if (at >= 0) this.placeProject(to, this.projectOrder[at + 1] ?? null);
          break;
        }
      }
      this.dismiss();
      this.record("remote-operation", { operation: pending.operation });
      await this.refreshSessions();
    } catch (e) {
      const label = this.operationLabel(pending, value);
      if (this.confirm === pending) {
        this.confirmStatus = { text: this.actionText(label, e), failed: true };
        this.drawActions();
      }
      this.actionFailed(label, e);
      this.updateActivity();
    }
  }
  /**
   * Add the sessions that this app created after the read began to the rows of that read. A read
   * that began later, or that lists the session, ends the hold.
   */
  keepCreated(rows: SessionRef[], started: number) {
    const kept = [...rows];
    for (const [name, made] of this.created) {
      if (started > made.at || rows.some((r) => r.name === name))
        this.created.delete(name);
      else kept.push(made.ref);
    }
    return kept;
  }
  /**
   * Create a session without holding the prompt. Its row says starting until the workstation
   * answers. The session then opens in the pane, unless the owner pressed a key or opened another
   * view meanwhile: then the footer says that it is ready.
   */
  async startSession(
    name: string,
    where: { dir: string } | { folder: string },
    project: string,
    subfolder?: string,
  ) {
    this.starting.set(name, project);
    const inputs = this.inputs;
    const active = this.shells[this.active];
    this.drawSessions();
    this.drawFooter();
    try {
      const identity = await this.backend.create(
        name,
        where,
        project,
        subfolder,
      );
      this.record("remote-operation", { operation: "create" });
      if (this.disposed) return;
      // The identity from the workstation is enough to attach; the launcher checks it again.
      const known: SessionRef | undefined = identity
        ? {
            name,
            identity,
            project,
            cwd:
              "dir" in where
                ? subfolder
                  ? `${where.dir}/${subfolder}`
                  : where.dir
                : "",
            clients: 0,
            parent: "",
            managed: true,
            activity: [],
          }
        : undefined;
      if (known) {
        this.created.set(name, { ref: known, at: this.now() });
        this.remoteSessions = this.keepCreated(this.remoteSessions, 0);
      }
      if (!known) await this.refreshSessions();
      this.starting.delete(name);
      const free =
        this.inputs === inputs &&
        this.shells[this.active] === active &&
        !this.palette &&
        !this.sheetOpen;
      if (free)
        await this.attachRemote(
          name,
          known
            ? undefined
            : this.remoteSessions.find((r) => r.name === name)?.identity,
          false,
          true,
          known,
        );
      else {
        this.drawSessions();
        this.notify(
          `${name} is ready`,
          false,
          [{ label: "attach", run: () => void this.attachRemote(name) }],
          8000,
        );
      }
      this.actionSucceeded(`create ${name}`);
      if (known) void this.refreshSessions();
    } catch (e) {
      this.starting.delete(name);
      if (this.disposed) return;
      this.drawSessions();
      this.actionFailed(`create ${name}`, e);
    }
  }
  /**
   * Attach a remote session. A fresh attach also reopens the session's newest child shell beside
   * it (see `openChildBeside`); `withChild` is false for that child itself. `known` is a session
   * that the workstation just created: the attach needs no read of the list to find it.
   */
  async attachRemote(
    name: string,
    expected?: string,
    reconnect = false,
    withChild = true,
    known?: SessionRef,
    focus = true,
  ) {
    if (this.remotePending.has(name)) return;
    this.remotePending.add(name);
    let opened: Shell | undefined;
    let previousView = this.view,
      previousActive = this.active;
    try {
      let shell = this.shells.find((s) => s.remote?.name === name);
      if (shell && !shell.exited && !reconnect) {
        if (expected && shell.remote?.identity !== expected)
          throw new Error(
            "The session identity changed. Selection was refused.",
          );
        this.acknowledge(name);
        this.active = this.shells.indexOf(shell);
        if (!this.palette) this.show("shell");
        return;
      }
      const ref = known ?? (await this.backend.resolve(name, expected));
      if (shell?.remote && shell.remote.identity !== ref.identity) {
        if (!shell.exited || reconnect)
          throw new Error("The session identity changed. Open a new view.");
        // The ended view shows a session that is gone, so nothing in it is lost.
        const unmoved =
          this.view === previousView && this.active === previousActive;
        const current = this.view;
        this.discardView(shell);
        shell = undefined;
        // The discard moves the view itself; a person who moved it during the read keeps their place.
        if (unmoved) [previousView, previousActive] = [this.view, this.active];
        else {
          previousActive = -1;
          if (this.view !== current) this.show(current);
        }
      }
      if (!shell && this.shells.length >= 4)
        throw new Error("Tokiwa supports four terminal views.");
      if (shell && reconnect) {
        shell.adapter.closeTransport();
        await Promise.race([
          shell.child.exited,
          Bun.sleep(5000).then(() => {
            throw new Error(
              "The previous transport did not close. No new connection was started.",
            );
          }),
        ]);
        shell.exited = true;
      }
      if (shell && !shell.exited) {
        this.active = this.shells.indexOf(shell);
        this.show("shell");
        return;
      }
      if (this.disposed) return;
      const frame = shell
        ? { pane: shell.pane, title: shell.title, shield: shell.shield }
        : this.makePane(name);
      const terminal =
        shell?.terminal ??
        new EmbeddedTerminalRenderable(this.renderer, {
          id: `remote-${name}`,
          width: "100%",
          height: 1,
          minHeight: 1,
          flexGrow: 1,
          cols: 80,
          rows: 24,
          maxScrollback: 100000,
          transparentBackground: true,
          visible: false,
        });
      themeRemoteStatus(terminal, theme.muted, theme.surface);
      if (!shell) frame.pane.add(terminal);
      terminal.write("\x1b[2J\x1b[H");
      const adapter = new PtyAdapter(
        "remote",
        isBackground(ref)
          ? this.backend.viewCommand(ref)
          : this.backend.attachCommand(ref),
        {
          data: (bytes) => {
            terminal.write(bytes);
            if (shell) this.noteOutput(shell, bytes);
          },
          exit: (code) => {
            if (shell?.adapter === adapter) shell.exited = true;
            this.record("transport-exit", { name, code });
            if (shell?.adapter === adapter) this.afterExit(shell);
            else this.updateActivity();
          },
          clipboard: (text) => this.programCopied(text),
          open: (url) =>
            this.programOpened(
              url,
              this.shells.find((s) => s.adapter === adapter),
            ),
        },
        homedir(),
      );
      if (!shell) this.selectOnlyUntracked(terminal);
      if (shell) {
        shell.adapter.closeTransport();
        Object.assign(shell, {
          adapter,
          child: adapter.child,
          detaching: false,
          startupOutput: "",
          remote: ref,
          exited: false,
        });
      } else {
        shell = {
          name,
          terminal,
          pane: frame.pane,
          title: frame.title,
          shield: frame.shield,
          cwd: ref.cwd,
          remoteName: name,
          adapter,
          child: adapter.child,
          remote: ref,
          lastOutput: 0,
          exited: false,
        };
        this.shells.push(shell);
      }
      terminal.onData = (data, source) => {
        if (source === "response") return adapter.reply(data);
        const s = this.shells.find((s) => s.adapter === adapter);
        if (s) s.lastInput = this.now();
        adapter.write(data);
      };
      terminal.onTerminalResize = (cols, rows) => adapter.resize(cols, rows);
      adapter.resize(terminal.screen().columns, terminal.screen().rows);
      this.acknowledge(name);
      if (
        focus &&
        !this.palette &&
        this.view === previousView &&
        this.active === previousActive
      ) {
        this.active = this.shells.indexOf(shell);
        this.show("shell");
      }
      if (this.pair?.some((s) => s.remote?.name === name)) this.layoutPanes();
      this.record("remote-transport-started", {
        name,
        identity: ref.identity,
        pid: adapter.child.pid,
      });
      this.actionSucceeded(`attach ${name}`);
      if (withChild && !reconnect) opened = shell;
    } catch (e) {
      this.record("remote-error", { name, error: String(e) });
      this.actionFailed(`attach ${name}`, e);
      this.updateActivity();
    } finally {
      this.remotePending.delete(name);
    }
    if (opened) await this.openChildBeside(opened);
  }
  /**
   * Reopen the newest child shell of a session (one made with Shell here) beside it, as when the
   * shell was made. The session keeps the keyboard. Nothing opens in a window too small for two
   * views, with four views open, when the session is already paired, or for an ended child.
   * The other children and the child's own children stay in the list.
   */
  async openChildBeside(parent: Shell) {
    const id = parent.remote?.identity.split(":")[1];
    if (!id || this.pair?.includes(parent) || this.disposed) return;
    if (paneLayout(this.renderer.width, this.renderer.height) === "single")
      return;
    const created = (r: SessionRef) => Number(r.identity.split(":")[2]) || 0;
    const child = this.remoteSessions
      .filter(
        (r) =>
          r.parent === id &&
          !(r.activity?.length && r.activity.every((a) => a.dead)),
      )
      .sort((a, b) => created(b) - created(a))[0];
    if (!child) return;
    const open = () =>
      this.shells.find((s) => s.remote?.name === child.name && !s.exited);
    if (!open()) {
      if (this.shells.length >= 4) return;
      // The child takes the keyboard only from its session in front, not from Health or the search.
      const front =
        this.view === "shell" && this.shells[this.active] === parent;
      await this.attachRemote(
        child.name,
        child.identity,
        false,
        false,
        undefined,
        front,
      );
    }
    const shell = open();
    if (!shell || this.disposed || parent.exited) return;
    if (!this.shells.includes(parent)) return;
    this.pair = [parent, shell];
    this.record("child-reopened", { parent: parent.name, child: child.name });
    // The child's attach took the keyboard only if nothing else did meanwhile; give it back.
    if (this.shells[this.active] === shell) {
      this.active = this.shells.indexOf(parent);
      if (!this.palette) this.show("shell");
    } else this.layoutPanes();
  }
  async sampleHealth() {
    if (this.sampling || this.disposed || this.history.stopped) return;
    this.sampling = true;
    let readFailed = false;
    const started = this.now();
    await this.history.sample(async () => {
      try {
        return await this.backend.health();
      } catch (e) {
        readFailed = true;
        this.readFailed("health", e, started);
        throw e;
      }
    });
    if (this.history.gap) {
      // A sample that the history rejects (a stale timestamp) never failed in the wrapper above.
      if (!readFailed) this.readFailed("health", this.history.error, started);
    } else this.readSucceeded("health");
    if (!this.disposed && this.now() - this.spendAt >= SPEND_REFRESH_MS) {
      this.spendAt = this.now();
      const spendStarted = this.now();
      try {
        this.spend = await this.backend.spend();
        this.spendError = "";
        this.readSucceeded("spend");
      } catch (e) {
        this.readFailed("spend", e, spendStarted);
        // The last reading stays; `sources.spend` says that it is not current.
        this.spendError = spendFailure(e);
      }
    }
    this.sampling = false;
    if (!this.disposed) {
      this.drawHeader();
      this.drawFooter();
      this.drawHealth();
      // The list line follows the failure of the whole link, which a Health read can change.
      if (this.view === "shell" && this.listSignature !== this.rowSignature())
        this.drawSessions();
      this.record("health-sample", {
        status: this.history.status(),
        count: this.history.samples.length,
        sample: this.history.samples.at(-1),
        error: this.history.error,
        spend_error: this.spendError,
        ...this.receiptFreshness("health"),
      });
      if (!this.history.stopped)
        this.sampleTimer = setTimeout(() => void this.sampleHealth(), 30000);
    }
  }
  drawHealth() {
    if (this.disposed) return;
    const width = Math.min(
      116,
      this.renderer.width - (this.renderer.width < 70 ? 2 : 4),
    );
    // Header, navigation and footer take five rows, and the problem band its own. As in the
    // sheet, the blank row above the view goes first when the view does not fit, then the blank
    // lines between sections.
    // A failed read of Health alone shows as a line and a blank row above the sections.
    const failed = this.viewFailure("health");
    const top: Span[][] = failed
      ? [
          ...this.errorLine(failed, Math.max(20, width)),
          [{ text: "", tone: "value" }],
        ]
      : [];
    const room = this.renderer.height - 5 - this.bandRows - top.length;
    // A failed read leaves the last readings in a quieter colour until a read succeeds.
    const stale = this.history.gap && !!this.history.error;
    // A recorded reading is the reading itself; a sample past its limit or a failed read is old.
    const status = this.history.status(this.now() / 1000);
    const recorded = status === "recorded";
    const read = this.sources.health.freshness(this.now());
    const healthFreshness: Freshness =
      recorded || (read === "live" && status !== "stale")
        ? "live"
        : read === "live"
          ? "last-known"
          : read;
    const spendFreshness: Freshness = recorded
      ? "live"
      : this.sources.spend.freshness(this.now());
    const layout = (height: number) =>
      healthLines(
        {
          now: this.now(),
          sample: this.history.samples.at(-1),
          status: this.history.status(this.now() / 1000),
          // After a successful read the error holds only the host's partial-sample notes.
          error: this.history.gap ? this.history.error : "",
          spend: this.spend,
          spendError: this.spendError,
          config: this.healthConfig,
          configError: this.healthConfigError,
          device: this.device,
          healthFreshness,
          spendFreshness,
          spendReadAt: this.sources.spend.okAt || undefined,
          // A source stays `not read` until its own read succeeds, whatever another source reads.
          globalFailure: this.currentError()?.scope === "global",
        },
        Math.max(20, width),
        height,
      );
    let lines = layout(room - 1);
    const padding = lines.length <= room - 1 ? 1 : 0;
    if (!padding) lines = layout(room);
    lines = [...top, ...lines];
    this.healthScroll.paddingTop = padding;
    const height = room - padding;
    this.healthText.content = new StyledText(
      lines.flatMap((line, i) => [
        ...(i ? [{ __isChunk: true as const, text: "\n" }] : []),
        ...line.map((span) => ({
          __isChunk: true as const,
          text: span.text,
          fg: RGBA.fromHex(
            stale && span.tone !== "title" && span.tone !== "warning"
              ? tones.dim
              : tones[span.tone],
          ),
          ...(span.tone === "title" ? { attributes: TextAttributes.BOLD } : {}),
        })),
      ]),
    );
    const overflow = lines.length > height + top.length;
    if (overflow !== this.healthOverflow) {
      this.healthOverflow = overflow;
      this.drawFooter();
    }
  }
  /**
   * Draw the footer: one line of controls for the current context, with a message at its right. The
   * message is a notice or, while the pointer is over a session row, the state of that row.
   */
  drawFooter() {
    if (this.disposed || !this.footer) return;
    const room = this.renderer.width - 2 * (this.renderer.width < 70 ? 1 : 2);
    const row =
      this.hover.startsWith("row:") && this.listView()
        ? this.sessionRows().find((r) => `row:${r.name}` === this.hover)
        : undefined;
    const context = this.footerContext();
    const notice =
      this.footerNotice && Date.now() < this.footerNotice.until
        ? this.footerNotice
        : undefined;
    const status = row ? this.rowStatus(row) : undefined;
    const noticeTexts = notice
      ? noticeForms(notice.text, notice.failed || !!notice.actions?.length)
      : [];
    const actionCells = (notice?.actions ?? []).reduce(
      (n, action) => n + SEPARATOR.length + action.label.length,
      0,
    );
    // A notice reports what just happened, so the state of the row under the pointer waits for it.
    const guides =
      !notice && row && status
        ? stateGuides(
            row.name,
            status.state,
            status.others,
            dimNeedsYou(status.state, row),
          )
        : [];
    const fit = fitFooter(
      context.hints,
      notice
        ? noticeTexts.map((text) => text.length + actionCells)
        : guides.map(spanCells),
      room,
      context.order,
      // The row itself names its state, so its explanation never hides the controls.
      !notice,
    );
    this.footerShown = fit.takesLine ? [] : fit.hints;
    const signature = JSON.stringify([
      room,
      context.order,
      fit.keys,
      fit.takesLine,
      fit.hints.map((h) => [h.id, h.key, h.label]),
      notice ? [noticeTexts[fit.form], notice.failed] : null,
      notice?.actions?.map((action) => action.label),
      guides.length ? [row?.name, status, guides[fit.form]] : null,
    ]);
    if (signature === this.footerSignature) return;
    this.footerSignature = signature;
    for (const child of this.footer.getChildren()) child.destroyRecursively();
    const part = (parent: any, id: string, spans: Span[]) =>
      this.text(parent, id, "", {
        height: 1,
        flexShrink: 0,
        wrapMode: "none",
        truncate: true,
        // The footer starts no text selection.
        selectable: false,
        content: styled(spans),
      });
    const drawMessage = () => {
      if (!notice) {
        if (guides.length)
          part(this.footer, "footer-state", guides[fit.form]);
        return;
      }
      part(this.footer, "footer-notice", [
        {
          text: noticeTexts[fit.form],
          tone: notice.failed ? "warning" : "dim",
        },
      ]);
      // A notice can offer controls, for example open and copy for a link.
      notice.actions?.forEach((action, i) => {
        part(this.footer, `footer-notice-gap-${i}`, [
          { text: SEPARATOR, tone: "dim" },
        ]);
        const control = this.box(this.footer, `footer-notice-${i}`, {
          height: 1,
          flexShrink: 0,
          onMouseDown: (event: MouseEvent) => {
            event.preventDefault();
            event.stopPropagation();
            this.record("action", { label: action.label, method: "notice" });
            this.footerNotice = undefined;
            this.footerSignature = "";
            action.run();
            this.drawFooter();
          },
        });
        part(control, `footer-notice-${i}-text`, [
          { text: action.label, tone: "title" },
        ]);
        this.hoverable(control, `footer:notice-${i}`, (on) => {
          control.backgroundColor = on ? theme.hover : "transparent";
        });
      });
    };
    if (fit.takesLine) {
      drawMessage();
      return;
    }
    const hasMessage = fit.form >= 0;
    const endControl = fit.hints.some((h) => h.end);
    fit.hints.forEach((hint, i) => {
      if (hint.end) {
        this.box(this.footer, "footer-spacer", { height: 1, flexGrow: 1 });
        if (hasMessage) {
          drawMessage();
          part(this.footer, "footer-message-gap", [
            { text: SEPARATOR, tone: "dim" },
          ]);
        }
      } else if (i)
        part(this.footer, `footer-gap-${i}`, [
          { text: SEPARATOR, tone: "dim" },
        ]);
      const key = fit.keys ? hint.key : "";
      const order = hint.end ? "label-first" : context.order;
      // A control shows its label in the text colour and its key dim; other hints are dim.
      const spans: Span[] = !hint.run
        ? [{ text: hintText(hint, fit.keys, order), tone: "dim" }]
        : order === "key-first"
          ? [
              { text: key && `${key} `, tone: "dim" },
              { text: hint.label, tone: "value" },
            ]
          : [
              { text: hint.label, tone: "value" },
              { text: key && ` ${key}`, tone: "dim" },
            ];
      const control = this.box(this.footer, `footer-${hint.id}`, {
        height: 1,
        flexShrink: 0,
        flexDirection: "row",
        onMouseDown: hint.run
          ? (event: MouseEvent) => {
              // Keep the keyboard where it is and the terminal selection, for Copy.
              event.preventDefault();
              event.stopPropagation();
              this.record("action", { label: hint.label, method: "footer" });
              this.footerShown.find((h) => h.id === hint.id)?.run?.();
            }
          : undefined,
      });
      part(
        control,
        `footer-${hint.id}-text`,
        spans.filter((s) => s.text),
      );
      if (hint.run)
        this.hoverable(control, `footer:${hint.id}`, (on) => {
          control.backgroundColor = on ? theme.hover : "transparent";
        });
    });
    if (hasMessage && !endControl) {
      this.box(this.footer, "footer-spacer", { height: 1, flexGrow: 1 });
      drawMessage();
    }
  }
  /** True when the workspace with its session list is the view under the pointer. */
  listView() {
    return (
      this.view === "shell" &&
      !this.palette &&
      !this.sheetOpen &&
      this.sessionList.visible
    );
  }
  /**
   * The footer hints of the current context. Inside a terminal the keys are the chords that reach
   * the app, so the label comes first and its key follows, dim.
   */
  footerContext(): { order: HintOrder; hints: Hint[] } {
    const keyFirst = (hints: Hint[]) => ({
      order: "key-first" as const,
      hints,
    });
    const shortcuts = hint("shortcuts", "?", "shortcuts", 9, () =>
      this.openSheet(),
    );
    if (this.sheetOpen)
      return keyFirst([
        ...(this.sheetOverflow ? [hint("scroll", "↑↓", "scroll", 1)] : []),
        hint("close", "esc", "close", 9, () => this.closeSheet()),
      ]);
    if (this.picker) return keyFirst(this.pickerHints());
    if (this.palette)
      return keyFirst(
        this.confirm
          ? [
              hint(
                "confirm",
                "enter",
                "confirm",
                5,
                () => void this.completeOperation(),
              ),
              ...(this.choosesFolder()
                ? [
                    hint(
                      "folder",
                      "tab",
                      this.ownFolder ? "project folder" : "own folder",
                      3,
                      () => this.toggleOwnFolder(),
                    ),
                  ]
                : []),
              hint("cancel", "esc", "cancel", 9, () => this.dismiss()),
            ]
          : [
              hint("select", "↑↓", "select", 1),
              hint("open", "enter", "open", 5, () => this.choose()),
              hint("close", "esc", "close", 9, () => this.dismiss()),
            ],
      );
    if (this.view === "health")
      return keyFirst([
        ...(this.signInExpired()
          ? [hint("sign-in", "l", "sign in", 8, () => this.signIn())]
          : this.retryOffered("health")
            ? [hint("retry", "u", "retry", 8, () => this.runAction("refresh"))]
            : []),
        ...(this.healthOverflow ? [hint("scroll", "↑↓", "scroll", 1)] : []),
        hint("sessions", "w", "sessions", 5, () => this.leaveHealth()),
        shortcuts,
      ]);
    const active = this.shells[this.active];
    const background = this.backgroundRows().length;
    if (!this.listHasFocus())
      return {
        order: "label-first",
        hints: [
          ...(this.remoteInPane()
            ? [hint("detach", "ctrl+k d", "detach", 6, () => this.detachPane())]
            : []),
          hint("focus", "ctrl+k z", "focus", 2, () => this.toggleFocus()),
          hint("sessions", "ctrl+k w", "sessions", 5, () =>
            this.focusSessions(),
          ),
          { ...shortcuts, key: "ctrl+k ?" },
        ],
      };
    return keyFirst([
      ...(this.signInExpired()
        ? [hint("sign-in", "l", "sign in", 8, () => this.signIn())]
        : this.retryOffered("sessions")
          ? [hint("retry", "u", "retry", 8, () => this.runAction("refresh"))]
          : []),
      ...(this.sessionRows().length
        ? [
            hint("select", "↑↓", "select", 1),
            hint("attach", "enter", "attach", 5, () => this.attachSelected()),
            ...(this.targetShell() && this.isLocal(this.targetShell()!)
              ? [hint("end", "x", "close", 6, () => this.runAction("end"))]
              : []),
            ...(this.targetShell()?.exited && this.targetShell()?.remote
              ? [
                  hint("detach", "d", "close view", 6, () =>
                    this.runAction("detach"),
                  ),
                ]
              : []),
          ]
        : [
            ...(this.retryOffered("sessions") || this.signInExpired()
              ? []
              : [
                  hint(
                    "refresh",
                    "u",
                    "refresh",
                    3,
                    () => void this.refreshSessions(),
                  ),
                ]),
            hint("local-shell", "t", "local shell", 4, () =>
              this.runAction("local-shell"),
            ),
          ]),
      ...(active
        ? [
            hint("terminal", "esc", "terminal", 4, () =>
              this.returnToTerminal(),
            ),
            hint("focus", "z", "focus", 2, () => this.toggleFocus()),
          ]
        : []),
      shortcuts,
      hint("quit", "q", "quit", 8.5, () => this.runAction("quit")),
      ...(background
        ? [
            {
              ...hint("background", "b", `${background} background`, 10, () =>
                this.openBackground(),
              ),
              end: true,
            },
          ]
        : []),
    ]);
  }
  /** The footer of the background list. While a session waits for an answer, the answers. */
  pickerHints() {
    if (this.ending?.busy) return [];
    if (this.ending)
      return [
        hint("end", "enter", "end", 5, () => void this.endSession(false)),
        ...(this.ending.children.length
          ? [
              hint(
                "keep-shells",
                "s",
                "keep the shells",
                4,
                () => void this.endSession(true),
              ),
            ]
          : []),
        hint("keep", "esc", "keep", 9, () => this.cancelEnd()),
      ];
    return [
      ...(this.filtered.length
        ? [
            hint("select", "↑↓", "select", 1),
            hint("view", "enter", "view", 5, () => this.choose()),
            hint("end", "x", "end", 4, () => this.endPicked()),
          ]
        : []),
      hint("close", "esc", "close", 9, () => this.dismiss()),
    ];
  }
  /** True while the prompt makes a session, so tab chooses its folder. */
  choosesFolder() {
    const op = this.confirm?.operation;
    return op === "new-session" || op === "new-project";
  }
  toggleOwnFolder() {
    this.ownFolder = !this.ownFolder;
    this.drawActions();
    this.drawFooter();
  }
  /** Ask to end the session under the selection of the background list. */
  endPicked() {
    const ref = this.backgroundRows()[this.selection]?.ref;
    if (ref) this.askEnd(ref);
  }
  /** True when the view in the pane is a remote session whose transport is open. */
  remoteInPane() {
    const shell = this.shells[this.active];
    return !!shell?.remote && !shell.exited;
  }
  /** Detach the remote session in the pane. Its process ends, and the keyboard goes to the list. */
  detachPane() {
    if (this.remoteInPane()) this.detach(this.shells[this.active]);
  }
  detach(shell: Shell) {
    shell.detaching = true;
    shell.adapter.detach();
  }
  /** Copy the current text selection, as Ctrl+Shift+C does. */
  copySelection() {
    const text =
      this.renderer.getSelection()?.getSelectedText() || this.lastSelection;
    if (text) this.copy(text);
    else this.notify("nothing selected · drag over text, then copy", true);
  }
  /** The label of a confirmed operation in its failure notice. */
  operationLabel(op: Operation, value: string) {
    switch (op.operation) {
      case "project":
        return `move ${op.ref.name}`;
      case "new-session":
        return `create ${value || "session"}`;
      case "new-project":
        return "new project";
      case "rename-project":
        return `rename ${projectTitle(op.path)}`;
      case "rename-session":
        return `rename ${op.ref.name}`;
    }
  }
  /** The notice text of a failed action: the label and the cause, or the plain message. */
  actionText(action: string, error: unknown) {
    const message =
      error instanceof Error ? error.message : String(error ?? "");
    if (
      !(error instanceof LauncherError) &&
      !/^(Launcher |The launcher)/.test(message)
    )
      return message.replace(/^Error: /, "");
    const failure = classify("sessions", error, this.now());
    return `${action} failed · ${failure.kind === "failed" ? failure.summary : failure.title}`;
  }
  /** Show a failed action as a notice. A failed snapshot also fails the session read. */
  actionFailed(action: string, error: unknown) {
    if (error instanceof LauncherError && error.command === "--snapshot")
      this.readFailed("sessions", error);
    const text = this.actionText(action, error);
    // The confirm box already shows this failure; the footer does not say it again.
    if (
      this.confirm &&
      this.confirmStatus?.failed &&
      this.confirmStatus.text === text
    )
      return;
    this.notify(text, true, undefined, 8000);
    if (this.footerNotice) {
      this.footerNotice.action = action;
      // A failure of the whole link ends with a recovery; a failure of one action does not.
      const message =
        error instanceof Error ? error.message : String(error ?? "");
      this.footerNotice.cause =
        (error instanceof LauncherError ||
          /^(Launcher |The launcher)/.test(message)) &&
        classify("sessions", error, this.now()).kind !== "failed";
    }
  }
  /** An action succeeded: a notice about its earlier failure ends. */
  actionSucceeded(action: string) {
    if (this.footerNotice?.action !== action) return;
    this.footerNotice = undefined;
    this.footerSignature = "";
    this.drawFooter();
  }
  /** Show a short message in the footer for a few seconds. */
  notify(
    text: string,
    failed = false,
    actions?: { label: string; run: () => void }[],
    ms = 3000,
  ) {
    this.footerNotice = { text, failed, until: Date.now() + ms, actions };
    this.footerSignature = "";
    this.drawFooter();
    setTimeout(() => {
      if (this.footerNotice && Date.now() >= this.footerNotice.until) {
        this.footerNotice = undefined;
        this.footerSignature = "";
        this.drawFooter();
      }
    }, ms + 100);
  }
  imagePasting = false;
  /** Cmd+V: send the clipboard image to the focused remote view as a path on the host. */
  async pasteImage() {
    const shell = this.shells[this.active];
    if (
      !shell?.remote ||
      shell.exited ||
      !shell.terminal.focused ||
      this.palette ||
      this.sheetOpen ||
      this.listHasFocus()
    )
      return;
    const ref = shell.remote;
    if (this.imagePasting) {
      this.notify("An image paste is already in progress.", true);
      return;
    }
    this.imagePasting = true;
    const pasting = "Pasting image…";
    const clearPasting = () => {
      if (this.footerNotice?.text !== pasting) return;
      this.footerNotice = undefined;
      this.footerSignature = "";
      this.drawFooter();
    };
    let dir: string | undefined;
    try {
      dir = mkdtempSync(join(tmpdir(), "tokiwa-paste-"));
      const file = await (this.options.readImage ?? readClipboardImage)(dir);
      if (!file) return;
      if (statSync(file).size > MAX_PASTE_IMAGE_BYTES) {
        this.notify("The image is larger than 10 MB. Nothing was pasted.", true);
        return;
      }
      this.notify(pasting, false, undefined, PASTE_NOTICE_MS);
      const path = await this.backend.pasteImage(ref, file);
      if (this.disposed || !this.shells.includes(shell) || shell.exited) {
        clearPasting();
        return;
      }
      shell.adapter.write(`\x1b[200~${path}\x1b[201~`);
      clearPasting();
    } catch (e) {
      const raw =
        e instanceof LauncherError && e.stderr.trim()
          ? e.stderr
          : e instanceof Error
            ? e.message
            : String(e);
      // Helper and launcher sentences already end in "Nothing was pasted."; launcher sentences start with "Tokiwa: ".
      const first = (raw.split("\n").find((line) => line.trim()) ?? "")
        .trim()
        .replace(/^Tokiwa: /, "")
        .replace(/\s*Nothing was pasted\.?$/, "")
        .replace(/[.\s]+$/, "");
      this.notify(`Image paste failed: ${first}. Nothing was pasted.`, true);
    } finally {
      this.imagePasting = false;
      if (dir) rmSync(dir, { recursive: true, force: true });
    }
  }
  attachSelected() {
    const row = this.sessionRows()[this.listSelection];
    if (row) this.openRow(row, "keyboard");
  }
  /** Leave the list for the terminal of the active view. */
  returnToTerminal() {
    if (!this.shells[this.active]) return;
    this.listFocused = false;
    this.show("shell");
  }
  runAction(id: string) {
    const action = this.actions.find((a) => a.id === id);
    if (action && (!action.available || action.available())) action.run();
  }

  updateActivity() {
    if (this.disposed) return;
    this.drawHeader();
    // Redraw the list only when a row changes. Activity changes at most every 320 ms.
    if (this.view === "shell" && this.listSignature !== this.rowSignature())
      this.drawSessions();
    // The output glyphs throb in place: a redraw would drop a text selection in the list.
    const throb = throbColor(theme.cpu, Date.now(), this.animate);
    for (const glyph of this.listGlyphs)
      if (
        (glyph.state === "output" || glyph.state === "starting") &&
        !glyph.text.isDestroyed
      )
        glyph.text.fg = throb;
    this.drawNavStatus(throb);
    this.drawPending();
  }
  /** Show the strip of the other sessions in focus mode; the row shows no error. */
  drawNavStatus(throb = throbColor(theme.cpu, Date.now(), this.animate)) {
    const shown =
      this.focusMode && this.view === "shell" && !this.sessionList.visible;
    // Workspace and Health take 19 cells with their gaps.
    const room =
      this.renderer.width - 2 * (this.renderer.width < 70 ? 1 : 2) - 19;
    const strip = shown
      ? focusStrip(
          this.sessionRows()
            .filter((row) => !row.shell?.pane.visible)
            .map((row) => {
              const agent = row.ref?.frozen ? undefined : row.ref?.agent?.state;
              // A rate limit or an error stops an agent until a person acts.
              const stopped = agent === "limited" || agent === "error";
              const needs =
                this.rowStatus(row).state === "needs-you" || stopped;
              return {
                name: row.name,
                needs,
                stale: dimNeedsYou("needs-you", row),
                word: agent === "waiting" || stopped ? agent : "",
                agent,
              };
            }),
          room,
        )
      : [];
    // The strip stands at the right end of the row, quieter than the navigation: glyphs keep
    // their colour, names and counts are dim.
    const length = strip.reduce((n, span) => n + span.text.length, 0);
    const lead = strip.length ? Math.max(0, room - length - 1) : 0;
    this.navStatus.content = new StyledText([
      {
        __isChunk: true as const,
        text: " ".repeat(lead),
        fg: RGBA.fromHex(theme.muted),
      },
      ...strip.map((span) => ({
        __isChunk: true as const,
        text: span.text,
        fg: RGBA.fromHex(
          span.text === STATUS_GLYPH.output && span.tone === "accent"
            ? throb
            : span.tone === "value"
              ? theme.muted
              : tones[span.tone],
        ),
      })),
    ]);
  }
  /**
   * Turn focus mode on or off. Focus mode hides the session list beside the terminal, so the
   * terminal takes the full width; the top bar then shows the other sessions. The resize reaches
   * the PTY, and a remote transport asks tmux to redraw when the size settles.
   */
  toggleFocus() {
    this.focusMode = !this.focusMode;
    if (this.focusMode && this.shells[this.active]) this.listFocused = false;
    this.record("focus-mode", { on: this.focusMode });
    this.show("shell");
  }
  /** True when the keyboard is in the session list: the workspace shows no focused terminal. */
  listHasFocus() {
    return (
      this.view === "shell" &&
      !this.palette &&
      !this.sheetOpen &&
      (this.listFocused ||
        !this.shells[this.active] ||
        this.shells[this.active].exited)
    );
  }
  terminalFocused() {
    return this.shells.some((s) => s.terminal.focused);
  }
  /**
   * After a view's process ends (exit, detach or a dropped connection): when it is the view in the
   * workspace, the keyboard goes to the session list on its row, so the arrow keys work again.
   */
  afterExit(shell: Shell) {
    shell.endedAt = this.now();
    const remote = !!shell.remote || !!shell.remoteName;
    const end = shell.detaching
      ? "detached"
      : transportEnd(shell.startupOutput ?? "");
    if (remote && end && !this.disposed) {
      const name = shell.remote?.name ?? shell.name;
      this.closeEndedView(
        shell,
        end === "detached"
          ? `detached ${name} · it keeps running`
          : `${name} ended`,
      );
      return;
    }
    this.updateActivity();
    if (
      this.disposed ||
      this.shells[this.active] !== shell ||
      this.view !== "shell"
    )
      return;
    if (this.palette || this.sheetOpen) return;
    if (!this.listFocused) this.focusSessions();
  }
  /**
   * The `w` action. From Health it returns to the terminal that had the keyboard when Health
   * opened, if that view still runs. Anywhere else it gives the keyboard to the session list.
   */
  leaveHealth() {
    const from = this.healthFrom;
    this.healthFrom = undefined;
    if (
      this.view === "health" &&
      from &&
      this.shells.includes(from) &&
      !from.exited
    ) {
      this.active = this.shells.indexOf(from);
      this.returnToTerminal();
      return;
    }
    this.focusSessions();
  }
  /** Open the workspace with the keyboard in the session list, on the row of the active view. */
  focusSessions() {
    if (this.ending && !this.ending.busy) this.cancelEnd();
    this.listFocused = true;
    const active = this.shells[this.active];
    const index = this.sessionRows().findIndex((r) => r.shell === active);
    if (active && index >= 0) this.listSelection = index;
    this.shells.forEach((s) => s.terminal.blur());
    this.show("shell");
  }

  /** The group title of a view: its project directory, or the local group. */
  rowTitle(shell: Shell) {
    if (shell.remote) return projectTitle(shell.remote.project);
    return shell.remoteName ? projectTitle(shell.cwd) : groups.name;
  }
  /** The remote sessions and their views. A new remote shell is here before the next snapshot. */
  remoteRows(): SessionRow[] {
    const named = (s: Shell) => s.remote?.name ?? s.remoteName;
    const freshness = this.sources.sessions.freshness(this.now());
    const readAt = this.sources.sessions.okAt;
    const remote: SessionRow[] = this.remoteSessions.map((ref) => ({
      freshness,
      readAt,
      name: ref.name,
      project: ref.project,
      title: projectTitle(ref.project),
      id: ref.identity.split(":")[1],
      parent: ref.parent || undefined,
      ref,
      shell: this.shells.find((s) => named(s) === ref.name),
    }));
    for (const shell of this.shells)
      if (named(shell) && !remote.some((r) => r.shell === shell))
        remote.push({
          name: shell.name,
          project: shell.remote?.project ?? shell.cwd,
          title: this.rowTitle(shell),
          ref: shell.remote,
          shell,
        });
    for (const [name, project] of this.starting)
      if (!remote.some((r) => r.name === name))
        remote.push({
          name,
          project,
          title: projectTitle(project),
          starting: true,
        });
    return remote;
  }
  /** The sessions of the background list. */
  backgroundRows() {
    return this.remoteRows().filter((r) => r.ref && isBackground(r.ref));
  }
  /**
   * List the session list in display order: a tree of projects with their sessions and attached
   * views (see `projectTree`), then the local shells. A background session has a row only while
   * a view of it is open, so that the list shows what the pane shows.
   */
  sessionTree(): TreeEntry<SessionRow>[] {
    const named = (s: Shell) => s.remote?.name ?? s.remoteName;
    const remote = this.remoteRows().filter(
      (r) => r.shell || !r.ref || !isBackground(r.ref),
    );
    const local = this.shells
      .filter((s) => !named(s))
      .map((shell): SessionRow => ({
        name: shell.name,
        project: "",
        title: groups.name,
        shell,
      }));
    const tree = projectTree(
      remote,
      Object.keys(this.backend.projects),
      this.projectOrder,
    );
    if (local.length)
      tree.push(
        {
          kind: "project",
          path: "",
          title: groups.name,
          depth: 0,
          saved: false,
        },
        ...local.map((item) => ({
          kind: "session" as const,
          item,
          depth: 0,
          child: false,
        })),
      );
    return tree;
  }
  sessionRows(): SessionRow[] {
    return this.sessionTree().flatMap((e) =>
      e.kind === "session" ? [e.item] : [],
    );
  }
  /** Observe one row: the transport of an attached view, else the snapshot screens. */
  rowActivity(row: SessionRow) {
    // A dropped view says so for a while. Then the row shows the session on the host.
    const faded =
      row.shell?.exited &&
      !!row.ref &&
      this.now() - (row.shell.endedAt ?? this.now()) > DISCONNECT_NOTICE_MS;
    if (row.shell && !faded) {
      const state = activity(
        !!row.shell.remoteName || !!row.shell.remote,
        !row.shell.exited,
        row.shell.lastOutput,
      );
      if (state !== "unknown" || !row.ref) return state;
    }
    // A snapshot that is not live says nothing about what the session does now.
    if (row.freshness && row.freshness !== "live") return "unknown";
    return row.ref
      ? snapshotActivity(row.ref, this.previousSessions.get(row.name))
      : "unknown";
  }
  /** True when the snapshot reports a bell that the owner has not seen by attaching. */
  needsYou(row: SessionRow) {
    const ref = row.ref;
    if (!ref) return false;
    const bell = !!ref.bell && this.acknowledged.get(ref.name) !== ref.identity;
    const asked =
      !!ref.attention && this.attentionSeen.get(ref.name) !== ref.attention;
    // An agent that waits on a question or an approval needs you until it moves on.
    const waiting = ref.agent?.state === "waiting" && !ref.frozen;
    return bell || asked || waiting;
  }
  /**
   * The status of one row: its glyph state, the word of a state that needs an action (or
   * `attaching` while this app attaches it), and the clients attached elsewhere. The client
   * count of the snapshot includes this app's own client while its transport is open.
   */
  rowStatus(row: SessionRow) {
    if (row.starting)
      return { state: "starting" as RowState, word: "starting", others: 0 };
    const state = rowState(this.rowActivity(row), this.needsYou(row));
    const own =
      row.shell?.remote?.name === row.name && !row.shell.exited ? 1 : 0;
    return {
      state,
      word:
        row.ref && this.remotePending.has(row.name)
          ? "attaching"
          : this.rowWord(row, state),
      others: Math.max(0, (row.ref?.clients ?? 0) - own),
    };
  }
  /**
   * The word after a row's name: a state that needs an action, else frozen, else the state that
   * its agent reported, else shell for a session that runs only a shell.
   */
  rowWord(row: SessionRow, state: RowState) {
    const ref = row.ref;
    if (state === "needs-you" && ref?.agent?.state === "waiting" && !ref.frozen)
      return "waiting";
    if (STATUS_WORD[state]) return STATUS_WORD[state];
    if (ref?.frozen) return "frozen";
    if (ref?.agent) return ref.agent.state;
    return ref && runsOnlyShell(ref) ? "shell" : "";
  }
  rowSignature() {
    return JSON.stringify([
      this.renderer.width,
      this.listSelection,
      this.listHasFocus(),
      this.active,
      this.focusMode,
      this.sessionsLoading,
      this.sources.sessions.failure?.at,
      // The line at the top of the list shows only while no failure of the whole link does.
      this.viewFailure("sessions")?.at,
      this.currentError()?.scope,
      this.sessionRows().map((r) => [r.name, this.rowStatus(r)]),
    ]);
  }
  /**
   * The list stands beside the terminal at 100 columns and wider in the workspace layout. It
   * fills the width in turn with the terminal when it is narrow, in the terminal layout and in
   * focus mode.
   */
  splitLayout() {
    return (
      this.options.layout !== "terminal" &&
      this.renderer.width >= 100 &&
      !this.focusMode
    );
  }
  drawSessions() {
    if (!this.sessionList || this.disposed) return;
    const split = this.splitLayout();
    const showList = this.view === "shell" && (split || this.listHasFocus());
    this.sessionList.visible = showList;
    this.shellPane.visible =
      this.view === "shell" && (split || !this.listHasFocus());
    const listWidth = split
      ? Math.min(44, Math.max(36, Math.round(this.renderer.width * 0.28)))
      : this.renderer.width - 2 * (this.renderer.width < 70 ? 1 : 2);
    this.sessionList.width = split ? listWidth : "100%";
    // Beside a view, the view's left edge parts it from the list; the list draws no line itself.
    const viewBeside =
      this.shells.some((s) => s.pane.visible) || !!this.pendingPane?.visible;
    this.sessionList.border = split && !viewBeside ? ["right"] : [];
    this.shellPane.paddingLeft = split ? 1 : 0;
    this.listSignature = this.rowSignature();
    this.drawEmptyState();
    if (!showList) return;
    for (const child of this.sessionScroll.getChildren())
      child.destroyRecursively();
    // The right padding and, beside the terminal, the border take one cell each.
    const inner = listWidth - (split ? 2 : 1);
    const rows = this.sessionRows();
    this.listSelection = Math.max(
      0,
      Math.min(rows.length - 1, this.listSelection),
    );
    // Only a session name takes a text selection; a click elsewhere in the list selects no text.
    const line = (id: string, spans: Span[], opts: any = {}) =>
      this.text(this.sessionScroll, id, "", {
        height: 1,
        wrapMode: "none",
        selectable: false,
        ...opts,
        content: styled(spans),
      });
    // A failed read of the sessions alone shows as a line at the top of the list.
    const failed = this.viewFailure("sessions");
    if (failed) {
      this.errorLine(failed, inner).forEach((spans, i) =>
        line(`list-error-${i}`, spans),
      );
      line("list-error-gap", [{ text: "", tone: "dim" }]);
    }
    if (!rows.length) {
      // The band or the line above names the cause. The list adds a key only when neither names
      // one: not when its own line says `u retry`, and not for a `setup` failure, which has no key.
      const key = this.signInExpired()
        ? "l signs in"
        : failed || this.currentError()?.recovery === "none"
          ? ""
          : "u reads them again";
      const reason = this.sources.sessions.failure
        ? [
            { text: "No sessions read", tone: "dim" as const },
            ...(key
              ? [
                  { text: "", tone: "dim" as const },
                  { text: key, tone: "dim" as const },
                ]
              : []),
          ]
        : this.sessionsRead
          ? [
              { text: "No sessions on EC2", tone: "title" as const },
              { text: "t opens a local shell", tone: "dim" as const },
            ]
          : [
              {
                text:
                  this.options.spawn === false
                    ? "No sessions read"
                    : "Reading sessions…",
                tone: "dim" as const,
              },
            ];
      reason.forEach((span, i) => line(`list-status-${i}`, [span]));
      return;
    }
    const tree = this.sessionTree();
    const focus = this.listHasFocus();
    // The cells before a session's glyph: two per project level, two more for a child.
    const indentOf = (e: TreeEntry<SessionRow>) =>
      e.kind === "session" ? 2 * e.depth + (e.child ? 2 : 0) : 0;
    const deepest = Math.max(0, ...tree.map(indentOf));
    // Each row: a bar column, a glyph column, the name with the superscript count of other
    // clients, then a word for a state that needs an action. Names give way first.
    const statuses = rows.map((r) => this.rowStatus(r));
    const wordRoom = Math.max(
      0,
      ...statuses.map((s) => (s.word ? s.word.length + 2 : 0)),
    );
    const nameColumn = Math.max(
      6,
      Math.min(
        Math.max(
          ...rows.map(
            (r, i) => r.name.length + superscript(statuses[i].others).length,
          ),
        ),
        inner - 4 - wordRoom - deepest,
      ),
    );
    this.listGlyphs = [];
    const throb = throbColor(theme.cpu, Date.now(), this.animate);
    let top = 0;
    // A title is old only when its own rows come from the session snapshot.
    this.snapshotProjects.clear();
    let owner = "";
    for (const entry of tree) {
      if (entry.kind === "project") {
        if (entry.depth === 0) owner = entry.path;
      } else if (entry.item.freshness) this.snapshotProjects.add(owner);
    }
    tree.forEach((entry, g) => {
      if (entry.kind === "project") {
        if (entry.depth === 0 && top++)
          this.drawGap(`group-gap-${g}`, entry.path, inner);
        this.drawProjectTitle(entry, g);
        if (this.endingProject?.path === entry.path) {
          // The question and its answers take a line each: the list can be narrow.
          const [question, ...answers] = this.endingProjectSpans();
          [[question], answers].forEach((spans, l) => {
            if (!spans.length) return;
            const line = this.box(this.sessionScroll, `project-ask-${g}-${l}`, {
              height: 1,
              flexShrink: 0,
              flexDirection: "row",
              paddingLeft: 2 + entry.depth * 2,
            });
            spans.forEach((span, k) =>
              this.text(line, `project-ask-${g}-${l}-${k}`, "", {
                height: 1,
                flexShrink: 0,
                wrapMode: "none",
                selectable: false,
                content: styled([span]),
                onMouseDown: span.run
                  ? (event: MouseEvent) => {
                      event.stopPropagation();
                      span.run!();
                    }
                  : undefined,
              }),
            );
          });
        }
        return;
      }
      const row = entry.item;
      {
        const i = rows.findIndex(
          (r) => r.name === row.name && r.shell === row.shell,
        );
        const { state, word, others } = statuses[i];
        const text = sessionRowText(
          row.name,
          word,
          others,
          nameColumn + (word ? word.length + 2 : 0),
        );
        const selected = i === this.listSelection && focus;
        // The session in the pane: a bar before its glyph and an accent name.
        const current = row.shell === this.shells[this.active] && !!row.shell;
        const pad = nameColumn - text.name.length - text.count.length;
        const detail: Span[] = [
          { text: text.count, tone: "dim" },
          { text: " ".repeat(pad + (word ? 2 : 0)), tone: "value" },
          // A limit or an error stops an agent, so its word stands out.
          {
            text: text.word,
            tone: word === "limited" || word === "error" ? "warning" : "dim",
          },
        ];
        const weight = selected || current ? TextAttributes.BOLD : 0;
        const item = this.box(this.sessionScroll, `list-${i}`, {
          height: 1,
          flexDirection: "row",
          flexShrink: 0,
          backgroundColor: selected ? theme.selected : undefined,
          onMouseDown: (event: MouseEvent) => {
            // The sidebar does not take the keyboard.
            event.stopPropagation();
            this.dropped = false;
            // A second press on the same row within 400 ms renames the session; the first
            // press has attached it already.
            const now = Date.now();
            const twice =
              this.lastRowPress.name === row.name &&
              now - this.lastRowPress.at < 400;
            this.lastRowPress = { name: twice ? "" : row.name, at: now };
            if (twice && row.ref) {
              this.dropped = true;
              this.askOperation({ operation: "rename-session", ref: row.ref });
            }
          },
          onMouseUp: (event: MouseEvent) => {
            // A release attaches the session, unless it ended a drag on a project.
            event.stopPropagation();
            setTimeout(() => {
              if (this.dropped || this.disposed) return;
              this.listSelection = i;
              this.openRow(row, "mouse");
            }, 0);
          },
        });
        if (row.ref)
          this.dragItems.set(item, { kind: "session", ref: row.ref });
        this.hoverable(item, `row:${row.name}`, (on) => {
          if (!selected)
            item.backgroundColor = on ? theme.hover : "transparent";
          const close = this.rowClose.get(row.name);
          if (close && !close.isDestroyed) close.visible = on;
        });
        const part = (id: string, spans: Span[], selectable = false) =>
          this.text(item, `list-${i}-${id}`, "", {
            height: 1,
            flexShrink: 0,
            wrapMode: "none",
            selectable,
            content: styled(spans, weight),
          });
        // The selection band carries a marker too, so it reads without colour. It takes the place
        // of the bar; the accent name still marks the session in the pane.
        part("marker", [
          {
            text: selected ? "› " : current ? "▎ " : "  ",
            // While the terminal has the keyboard, its own edge is lit and this bar dims.
            tone:
              current && !selected && this.terminalFocused() ? "dim" : "accent",
          },
          { text: "  ".repeat(entry.depth), tone: "value" },
          { text: entry.child ? "└ " : "", tone: "dim" },
        ]);
        const glyph = this.text(
          item,
          `list-${i}-glyph`,
          `${STATUS_GLYPH[state]} `,
          {
            height: 1,
            flexShrink: 0,
            wrapMode: "none",
            selectable: false,
            fg:
              state === "output" || state === "starting"
                ? throb
                : // A stale row with no connected view asks for nothing now: its title says
                  // `last known`, so the glyph stays dim, not amber.
                  dimNeedsYou(state, row)
                  ? tones.dim
                  : tones[STATUS_TONE[state]],
          },
        );
        this.listGlyphs.push({ text: glyph, state });
        const asking =
          this.ending && row.ref && this.ending.ref.name === row.ref.name
            ? this.endingSpans()
            : row.shell && this.closing?.shell === row.shell
              ? this.closingSpans()
              : undefined;
        if (asking) {
          // The row asks "end it?"; each answer is a control.
          asking.forEach((span, k) =>
            this.text(item, `list-${i}-end-${k}`, "", {
              height: 1,
              flexShrink: 0,
              wrapMode: "none",
              selectable: false,
              content: styled([span]),
              onMouseDown: span.run
                ? (event: MouseEvent) => {
                    event.stopPropagation();
                    this.dropped = true;
                    span.run!();
                  }
                : undefined,
            }),
          );
          return;
        }
        // A name takes no text selection, so a drag that starts on it moves the session.
        part("name", [{ text: text.name, tone: current ? "accent" : "value" }]);
        part("detail", detail);
        if (row.ref || (row.shell && this.isLocal(row.shell))) {
          // × at the end of the row, under the pointer: ask to end the session.
          this.box(item, `list-${i}-space`, { flexGrow: 1, height: 1 });
          const close = this.text(item, `list-${i}-end`, " × ", {
            height: 1,
            flexShrink: 0,
            fg: theme.muted,
            selectable: false,
            visible: this.hover === `row:${row.name}`,
            onMouseDown: (event: MouseEvent) => {
              event.stopPropagation();
              this.dropped = true;
              if (row.ref) this.askEnd(row.ref);
              else this.askClose(row.shell!);
            },
          });
          this.rowClose.set(row.name, close);
        }
      }
    });
    // After the projects: a new project, a folder in workbench/ with a first session.
    if (
      this.remoteSessions.length ||
      Object.keys(this.backend.projects).length
    ) {
      this.drawGap("new-project-gap", null, inner);
      const add = this.box(this.sessionScroll, "new-project", {
        height: 1,
        flexShrink: 0,
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation();
          this.askOperation({ operation: "new-project" });
        },
      });
      const label = this.text(add, "new-project-label", "+ new project", {
        height: 1,
        wrapMode: "none",
        selectable: false,
        fg: theme.muted,
      });
      this.hoverable(add, "list:new-project", (on) => {
        label.fg = on ? theme.fg : theme.muted;
        add.backgroundColor = on ? theme.hover : "transparent";
      });
    }
    this.sessionScroll.scrollChildIntoView(`list-${this.listSelection}`);
  }
  /**
   * Draw a project title in the session list. Under the pointer it shows + (a new session in the
   * project) and × (end the project). A session or a project dropped on it moves into it; the
   * title can itself be dragged onto another project.
   */
  drawProjectTitle(entry: TreeProject, g: number) {
    const local = entry.path === "" && !this.remoteSessions.length;
    const box = this.box(this.sessionScroll, `group-${g}`, {
      height: 1,
      flexDirection: "row",
      flexShrink: 0,
      // A press makes the title the source of a drag. A release that is not a drop gives the
      // keyboard to the list, as a click elsewhere in the sidebar does.
      onMouseDown: (event: MouseEvent) => {
        event.stopPropagation();
        this.dropped = false;
        // A second press on the same title within 400 ms renames the project.
        const now = Date.now();
        const twice =
          this.lastTitlePress.path === entry.path &&
          now - this.lastTitlePress.at < 400;
        this.lastTitlePress = { path: twice ? "" : entry.path, at: now };
        if (twice && entry.path && !local) {
          this.dropped = true;
          this.askOperation({ operation: "rename-project", path: entry.path });
        }
      },
      onMouseDrag: () => {
        if (entry.path) this.dragging = entry.path;
      },
      onMouseUp: (event: MouseEvent) => {
        event.stopPropagation();
        setTimeout(() => {
          this.dragging = undefined;
          if (!this.dropped && !this.disposed) this.focusSessions();
        }, 0);
      },
      onMouseDrop: (event: MouseEvent) => this.dropOn(entry.path, event),
    });
    this.text(box, `group-${g}-title`, "", {
      height: 1,
      flexGrow: 1,
      flexShrink: 1,
      wrapMode: "none",
      truncate: true,
      selectable: false,
      content: styled([
        { text: "  ".repeat(entry.depth), tone: "value" },
        { text: entry.title, tone: "title" },
        // Only a top-level title: the project's rows hold values from an old snapshot.
        ...(entry.depth === 0 &&
        this.snapshotProjects.has(entry.path) &&
        this.sources.sessions.freshness(this.now()) !== "live" &&
        // A read in progress hides the mark only while the data is stale by age. After a
        // failure the data stays old until a read succeeds, so the mark stays.
        (!this.sessionsLoading ||
          this.sources.sessions.failAt > this.sources.sessions.okAt)
          ? [{ text: " · last known", tone: "dim" as const }]
          : []),
      ]),
    });
    if (entry.path === "" || local) return;
    this.dragItems.set(box, {
      kind: "project",
      path: entry.path,
      title: entry.title,
    });
    const control = (id: string, glyph: string, run: () => void) =>
      this.text(box, `group-${g}-${id}`, ` ${glyph} `, {
        height: 1,
        flexShrink: 0,
        fg: theme.muted,
        selectable: false,
        visible: false,
        onMouseDown: (event: MouseEvent) => {
          event.stopPropagation();
          run();
        },
      });
    const add = control("new", "+", () =>
      this.askOperation({
        operation: "new-session",
        path: entry.path,
        dir: this.projectDir(entry.path),
      }),
    );
    const end = control("end", "×", () => this.askEndProject(entry.path));
    this.hoverable(box, `project:${entry.path}`, (on) => {
      add.visible = on;
      end.visible = on;
      box.backgroundColor = on ? theme.hover : "transparent";
    });
  }
  /**
   * A blank line between top-level projects. While a project is dragged, the line under the
   * pointer shows where it lands; a drop places it before `before`, or last when null.
   */
  drawGap(id: string, before: string | null, width: number) {
    const gap = this.box(this.sessionScroll, id, {
      height: 1,
      flexShrink: 0,
      onMouseDrop: (event: MouseEvent) => void this.reorder(event, before),
    });
    const rule = this.text(gap, `${id}-rule`, "", {
      height: 1,
      wrapMode: "none",
      selectable: false,
      fg: theme.cpu,
    });
    this.hoverable(gap, `gap:${id}`, (on) => {
      rule.content =
        on && this.dragging ? "─".repeat(Math.max(4, width - 2)) : "";
    });
  }
  /** The first top-level project in the list, or null when there is none. */
  firstProject() {
    const first = this.sessionTree().find(
      (e) => e.kind === "project" && e.depth === 0 && e.path,
    );
    return first?.kind === "project" ? first.path : null;
  }
  /** Place a dropped project among the top-level projects; a nested one becomes top-level. */
  async reorder(event: MouseEvent, before: string | null) {
    let source: any = event.source;
    let item = undefined;
    while (source && !(item = this.dragItems.get(source)))
      source = source.parent;
    this.dragging = undefined;
    if (!item || item.kind !== "project") return;
    this.dropped = true;
    event.stopPropagation();
    let path = item.path;
    try {
      if (!path.startsWith("/") && path.includes("/")) {
        const top = path.split("/").at(-1)!;
        await this.backend.moveProject(path, top);
        path = top;
      }
      this.placeProject(path, before);
      await this.refreshSessions();
    } catch (e) {
      this.actionFailed(`move ${item.title}`, e);
    }
  }
  /** Save `path` before `before` (or last) in the order of the top-level projects. */
  placeProject(path: string, before: string | null) {
    const shown = this.sessionTree()
      .filter((e) => e.kind === "project" && e.depth === 0 && e.path)
      .map((e) => (e.kind === "project" ? e.path : ""));
    const order = shown.filter((p) => p !== path);
    const at = before === null ? -1 : order.indexOf(before);
    order.splice(at < 0 ? order.length : at, 0, path);
    this.projectOrder = order;
    if (this.orderFile)
      try {
        mkdirSync(dirname(this.orderFile), { recursive: true, mode: 0o700 });
        writeFileSync(
          this.orderFile,
          JSON.stringify({ order }, null, 1) + "\n",
          {
            mode: 0o600,
          },
        );
      } catch (e) {
        this.notify(
          `the order was not saved: ${String(e).replace(/^Error: /, "")}`,
          true,
        );
      }
    this.drawSessions();
  }
  /** The sessions of a project and of the projects inside it. */
  projectSessions(path: string) {
    return this.remoteSessions.filter(
      (r) => r.project === path || r.project.startsWith(path + "/"),
    );
  }
  /** The folder for a new session in a project: the saved one, else that of one of its sessions. */
  projectDir(path: string) {
    if (path.startsWith("/")) return path;
    return (
      this.backend.projects[path]?.dir ??
      this.projectSessions(path)[0]?.cwd ??
      Object.entries(this.backend.projects).find(([p]) =>
        p.startsWith(path + "/"),
      )?.[1].dir ??
      ""
    );
  }
  /**
   * Move what was dropped on a project: a session into the project, or a project inside it. A
   * drop on the Workspace title (`target` empty) makes a project top-level. Only labels change.
   */
  async dropOn(target: string, event: MouseEvent) {
    let source: any = event.source;
    let item = undefined;
    while (source && !(item = this.dragItems.get(source)))
      source = source.parent;
    if (!item) return;
    this.dropped = true;
    event.stopPropagation();
    const last =
      (item.kind === "project" ? item.title : "").split("/").at(-1) ?? "";
    try {
      if (item.kind === "session") {
        if (!target || item.ref.project === target) return;
        await this.backend.setProject(item.ref, target);
        this.notify(`moved ${item.ref.name} to ${projectTitle(target)}`);
      } else {
        if (target.startsWith("/"))
          throw new Error("A project nests only inside a named project.");
        const to = target ? `${target}/${last}` : last;
        // A top-level project dropped on Workspace only moves first.
        if (!target && to === item.path) {
          this.placeProject(to, this.firstProject());
          return;
        }
        if (
          to === item.path ||
          target === item.path ||
          target.startsWith(item.path + "/")
        )
          return;
        await this.backend.moveProject(item.path, to);
        this.notify(`moved ${item.title} to ${to}`);
        // On Workspace, the project also goes first.
        if (!target) this.placeProject(to, this.firstProject());
      }
      await this.refreshSessions();
    } catch (e) {
      this.actionFailed(
        `move ${item.kind === "session" ? item.ref.name : item.title}`,
        e,
      );
    }
  }
  /** Explain the empty right pane: how to attach a session. */
  drawEmptyState() {
    const rows = this.sessionRows().length;
    this.emptyState.content = styled([
      { text: "No session attached", tone: "title" },
      { text: "\n\n", tone: "value" },
      {
        text: rows
          ? "Select a session and press enter to attach it here."
          : "The session list is empty.",
        tone: "dim",
      },
      { text: "\n", tone: "value" },
      {
        text: this.signInExpired()
          ? "l signs in · t opens a local shell"
          : "t opens a local shell · ? shortcuts",
        tone: "dim",
      },
    ]);
  }
  /** Attach the session of a row, or bring an attached view forward. */
  openRow(row: SessionRow, method: "keyboard" | "mouse") {
    // A session that the workstation still creates opens by itself when it is ready.
    if (row.starting) return;
    if (this.ending && !this.ending.busy) this.cancelEnd();
    this.listFocused = false;
    this.record("session-select", { name: row.name, method });
    if (row.ref) {
      void this.attachRemote(row.ref.name, row.ref.identity);
      if (row.shell) this.show("shell");
      return;
    }
    if (row.shell) {
      this.active = this.shells.indexOf(row.shell);
      this.show("shell");
    }
  }

  /** The terminal that had the keyboard when Health opened from the workspace, if any. */
  healthFrom?: Shell;
  show(view: "health" | "shell") {
    if (view === "health" && this.view === "shell")
      this.healthFrom = this.listHasFocus() ? undefined : this.shells[this.active];
    this.view = view;
    // Session reads pause while Health is in view and resume with the workspace.
    if (
      view === "shell" &&
      this.options.spawn !== false &&
      !this.sessionsLoading &&
      !this.sessionTimer
    )
      void this.refreshSessions();
    this.body.visible = !this.sheetOpen;
    this.health.visible = view === "health";
    this.workspace.visible = view === "shell";
    this.body.maxWidth = view === "health" ? 116 : this.renderer.width;
    // In focus mode a blank line parts the navigation and its strip from the view.
    this.body.paddingTop = this.focusMode && view === "shell" ? 1 : 0;
    this.drawLocation();
    this.layoutPanes();
    this.drawSessions();
    this.drawFooter();
    (this.root.findDescendantById("health-nav") as TextRenderable).fg =
      view === "health" ? theme.cpu : theme.muted;
    (this.root.findDescendantById("shell-nav") as TextRenderable).fg =
      view === "shell" ? theme.cpu : theme.muted;
    this.updateActivity();
    this.record("view", { view });
  }
  /** Show the keyboard shortcuts sheet in place of the body. A focused terminal never opens it. */
  openSheet() {
    if (this.palette) this.dismiss();
    this.sheetOpen = true;
    this.shells.forEach((s) => s.terminal.blur());
    this.body.visible = false;
    this.sheet.visible = true;
    this.drawSheet();
    this.sheet.scrollTo(0);
    this.drawFooter();
    this.updateActivity();
    this.record("shortcuts-open");
  }
  closeSheet() {
    if (!this.sheetOpen) return;
    this.sheetOpen = false;
    this.sheet.visible = false;
    this.show(this.view);
    this.record("shortcuts-close");
  }
  drawSheet() {
    if (!this.sheetOpen) return;
    const width = this.renderer.width - 2 * (this.renderer.width < 70 ? 1 : 2);
    // Header, navigation and footer take five rows; a blank row above the sheet goes first.
    const room = this.renderer.height - 5;
    let lines = shortcutLines(width, room - 1);
    this.sheet.paddingTop = lines.length < room ? 1 : 0;
    const height = room - (this.sheet.paddingTop ? 1 : 0);
    if (!this.sheet.paddingTop) lines = shortcutLines(width, height);
    this.sheetRows = lines;
    this.paintSheet();
    this.sheetOverflow = lines.length > height;
    this.sheetLines = lines.length;
  }
  /** Draw the sheet lines; the row under the pointer has the hover band. */
  paintSheet() {
    const band = RGBA.fromHex(theme.hover);
    this.sheetText.content = new StyledText(
      this.sheetRows.flatMap((line, i) => [
        ...(i ? [{ __isChunk: true as const, text: "\n" }] : []),
        ...line.map((span) => ({
          __isChunk: true as const,
          text: span.text,
          fg: RGBA.fromHex(tones[span.tone]),
          ...(span.binding &&
          this.sheetAction(span.binding) === this.sheetHover &&
          this.sheetHover
            ? { bg: band }
            : {}),
          attributes: span.tone === "title" ? TextAttributes.BOLD : 0,
        })),
      ]),
    );
  }
  /**
   * The action of a sheet binding when it applies now, or "". The Ctrl+K quick keys run the
   * action of their plain key; bindings that only move inside a view (select, scroll) have none.
   */
  sheetAction(binding: string) {
    const id = binding.replace(/^quick-/, "");
    // The sheet is open already.
    if (id === "shortcuts") return "";
    const action = this.actions.find((a) => a.id === id);
    return action && (!action.available || action.available()) ? id : "";
  }
  /** The action of the sheet row at a screen cell, or "". */
  sheetActionAt(x: number, y: number) {
    const line = this.sheetRows[y - this.sheetText.y];
    return line ? this.sheetAction(bindingAt(line, x - this.sheetText.x)) : "";
  }
  openPalette() {
    this.listFocused = this.listHasFocus();
    if (this.palette) {
      this.dismiss();
      return;
    }
    this.clipboardSelection =
      this.renderer.getSelection()?.getSelectedText() ?? "";
    this.shells.forEach((s) => s.terminal.blur());

    this.palette = this.box(this.root, "overlay", {
      position: "absolute",
      left: 0,
      top: 2,
      width: "100%",
      height: Math.max(8, this.renderer.height - 4),
      alignItems: "center",
      justifyContent: "flex-start",
      zIndex: 10,
      // The search covers the view below it, so no partial line shows beside the panel.
      backgroundColor: theme.bg,
    });
    const panel = this.box(this.palette, "palette", {
      width: this.searchWidth(),
      maxWidth: "94%",
      flexDirection: "column",
      backgroundColor: theme.surface,
      paddingTop: 1,
      paddingBottom: 1,
    });
    const searchArea = this.box(panel, "search-area", {
      flexDirection: "column",
      flexShrink: 0,
      borderColor: theme.line,
      paddingLeft: 2,
      paddingRight: 2,
    });
    const title = this.picker ? "Background sessions" : this.paletteTitle;
    if (title)
      this.text(searchArea, "palette-title", title, {
        height: 1,
        fg: theme.muted,
        selectable: false,
        wrapMode: "none",
        truncate: true,
      });
    if (!this.picker) {
      const inputRow = this.box(searchArea, "search-row", {
        height: 1,
        flexDirection: "row",
      });
      this.text(inputRow, "search-prompt", "› ", {
        fg: theme.cpu,
        width: 2,
        flexShrink: 0,
        selectable: false,
      });
      this.search = new InputRenderable(this.renderer, {
        id: "search",
        placeholder: "Search sessions and actions",
        flexGrow: 1,
        backgroundColor: theme.surface,
        focusedBackgroundColor: theme.surface,
        textColor: theme.fg,
        placeholderColor: theme.muted,
      });
      inputRow.add(this.search);
    }
    // Until the first keystroke, a quick key runs at once; any other key starts a search.
    this.quickArmed = !this.confirm && !this.picker;
    this.choices = new ScrollBoxRenderable(this.renderer, {
      id: "choices",
      maxHeight: Math.max(3, this.renderer.height - 9),
      flexDirection: "column",
    });
    panel.add(this.choices);
    this.selection = 0;
    this.search?.on(InputRenderableEvents.INPUT, () => {
      this.selection = 0;
      this.drawActions();
    });
    this.drawActions();
    this.search?.focus();
    this.drawFooter();
    this.updateActivity();
    this.record("palette-open");
  }
  /** The search is 56 cells wide and fills the width of a narrow window. */
  searchWidth() {
    return this.renderer.width < 70
      ? this.renderer.width - 2
      : Math.min(56, this.renderer.width - 4);
  }
  /** The quick keys that apply now: Detach and Focus need a view in the pane. */
  quickKeys(): QuickKey[] {
    return QUICK_KEYS.filter((q) =>
      q.id === "detach"
        ? this.remoteInPane()
        : q.id === "focus"
          ? !!this.shells[this.active]
          : true,
    );
  }
  runQuickKey(quick: QuickKey) {
    this.dismiss();
    this.record("action", { label: quick.label, method: "quick-key" });
    if (quick.id === "detach") this.detachPane();
    else this.runAction(quick.id);
  }
  /** List what the search can reach: the sessions and the actions that apply now. */
  searchItems(): { sessions: SearchItem[]; actions: SearchItem[] } {
    const rows = this.sessionRows();
    const hidden = this.backgroundRows().filter(
      (row) => !rows.some((r) => r.name === row.name),
    );
    const sessions = [...rows, ...hidden].map((row): SearchItem => ({
      label: row.name,
      detail: row.title,
      category: "Sessions",
      run: () => this.openRow(row, "keyboard"),
    }));
    const actions = this.actions
      .filter((a) => !a.available || a.available())
      .map((a): SearchItem => ({
        id: a.id,
        label: a.label,
        detail: binding(a.id)?.key ?? "",
        category: ACTION_CATEGORY[a.id] ?? "Tokiwa",
        run: a.run,
      }));
    return { sessions, actions };
  }
  /**
   * Draw the search. An empty input lists the common actions by category; the key at the right of an
   * action runs it at once as the first keystroke (a quick key). Typed text lists the matching
   * sessions and actions, with each action's key outside a terminal.
   */
  drawActions() {
    if (!this.choices || !this.palette || this.disposed) return;
    for (const child of this.choices.getChildren()) child.destroyRecursively();
    const query = this.search?.value ?? "";
    const { sessions, actions } = this.searchItems();
    const result = this.picker
      ? this.backgroundChoices()
      : this.confirm
        ? { items: [], rows: [] }
        : searchRows(query, sessions, actions);
    this.filtered = result.items;
    this.searchList = result.rows;
    this.selection = Math.min(
      this.selection,
      Math.max(0, this.filtered.length - 1),
    );
    // While the quick keys are armed, an action shows only a key that runs it now, in the accent
    // colour. Other keys would start a search, so they show no key here (the sheet lists them).
    const armed =
      this.quickArmed && !query
        ? new Map<string, string>(this.quickKeys().map((q) => [q.id, q.key]))
        : undefined;
    // A category title draws its own rule; a flat list sits below the rule of the input.
    const titled = this.searchList[0]?.kind === "title";
    const area = this.palette.findDescendantById(
      "search-area",
    ) as BoxRenderable;
    area.border = titled ? [] : ["bottom"];
    area.height =
      (this.picker || this.paletteTitle ? 1 : 0) +
      (this.search ? 1 : 0) +
      (titled ? 0 : 1);
    const question = this.picker && !!this.ending;
    this.choices.height = Math.min(
      (this.searchList.length || 1) + (question ? 1 : 0),
      Math.max(3, this.renderer.height - 9),
    );
    this.choices.flexGrow = 0;
    const inner = this.searchWidth() - 4;
    this.searchList.forEach((entry, r) => {
      if (entry.kind === "title") {
        const rule = Math.max(0, inner - entry.text.length - 1);
        const title = this.box(this.choices, `category-${r}`, {
          height: 1,
          flexShrink: 0,
          paddingLeft: 2,
          paddingRight: 2,
        });
        this.text(title, `category-${r}-text`, "", {
          height: 1,
          wrapMode: "none",
          selectable: false,
          content: new StyledText([
            {
              __isChunk: true,
              text: `${entry.text} `,
              fg: RGBA.fromHex(theme.muted),
            },
            {
              __isChunk: true,
              text: "─".repeat(rule),
              fg: RGBA.fromHex(theme.track),
            },
          ]),
        });
        return;
      }
      const i = entry.index;
      const a = entry.item;
      const selected = i === this.selection;
      const row = this.box(this.choices, `action-${i}`, {
        height: 1,
        flexDirection: "row",
        gap: 2,
        // Items under a category title indent two more cells than the title.
        paddingLeft: titled ? 4 : 2,
        paddingRight: 2,
        backgroundColor: selected ? theme.selected : theme.surface,
        onMouseDown: () => this.choose(i),
      });
      this.hoverable(row, `search:${i}`, (on) => {
        if (!selected) row.backgroundColor = on ? theme.hover : theme.surface;
      });
      this.text(row, `label-${i}`, a.label, {
        flexGrow: 1,
        minWidth: 0,
        wrapMode: "none",
        truncate: true,
        selectable: false,
        attributes: selected ? TextAttributes.BOLD : 0,
      });
      const quickKey = armed && a.id ? armed.get(a.id) : undefined;
      const detail =
        armed && a.category !== "Sessions" ? (quickKey ?? "") : a.detail;
      this.text(row, `detail-${i}`, detail, {
        flexShrink: 0,
        maxWidth: "50%",
        wrapMode: "none",
        truncate: true,
        selectable: false,
        fg: quickKey ? theme.cpu : theme.muted,
      });
    });
    if (this.filtered.length) {
      // Keep the category title of the first item in view.
      if (this.selection === 0) this.choices.scrollTop = 0;
      this.choices.scrollChildIntoView(`action-${this.selection}`);
    } else
      this.text(
        this.choices,
        "empty",
        this.confirmStatus
          ? this.confirmStatus.text
          : this.confirm
            ? this.operationText(this.confirm).hint
            : this.picker
              ? "No background sessions"
              : "No matching session or action",
        {
          fg: this.confirmStatus?.failed ? theme.critical : theme.muted,
          height: 1,
          paddingLeft: 2,
          wrapMode: "none",
          truncate: true,
        },
      );
    if (question)
      this.text(this.choices, "picker-question", "", {
        height: 1,
        wrapMode: "none",
        truncate: true,
        selectable: false,
        content: styled([{ text: "  ", tone: "dim" }, ...this.endingSpans()]),
      });
  }
  choose(index = this.selection) {
    const action = this.filtered[index];
    if (action) {
      this.dismiss();
      this.record("action", { label: action.label });
      action.run();
    }
  }
  dismiss() {
    this.palette?.destroyRecursively();
    this.picker = false;
    this.paletteTitle = undefined;
    this.confirm = undefined;
    this.confirmStatus = undefined;
    this.palette = undefined;
    this.search = undefined;
    this.choices = undefined;
    this.quickArmed = false;
    this.show(this.view);
    this.record("palette-close");
  }
  key = (key: KeyEvent) => {
    this.inputs++;
    const stop = () => {
      key.preventDefault();
      key.stopPropagation();
    };
    if (this.connectionCard?.visible && key.name === "escape") {
      this.connectionCard.visible = false;
      return stop();
    }
    // A project waits for the answer to "end it?": enter ends it, esc keeps it.
    if (this.endingProject) {
      if (this.endingProject.busy) return stop();
      if (key.name === "return" || key.name === "escape") {
        stop();
        if (key.name === "return") void this.endProject();
        else this.cancelEndProject();
        return;
      }
      this.cancelEndProject();
    }
    // A local shell waits for an answer: enter closes it, or quits; esc keeps it.
    if (this.closing) {
      if (key.name === "return" || key.name === "escape") {
        stop();
        this.answerClose(key.name === "return");
        return;
      }
      this.answerClose(false);
    }
    // A session waits for the answer to "end it?": enter ends, s keeps its shells, esc keeps it.
    if (this.ending) {
      // While it ends, keys wait: a second enter does not end it twice.
      if (this.ending.busy) return stop();
      const answer =
        key.name === "return" ||
        key.name === "escape" ||
        (key.name === "s" && this.ending.children.length > 0);
      if (answer) {
        stop();
        if (key.name === "return") void this.endSession(false);
        else if (key.name === "s") void this.endSession(true);
        else this.cancelEnd();
        return;
      }
      // Any other key means the question was not meant: it goes away, and the key goes on
      // to where it was typed, for example the terminal.
      this.cancelEnd();
    }
    // Cmd+C reaches the app when Ghostty passes it on (`performable:super+c=copy_to_clipboard`).
    if (
      (key.ctrl && key.shift && key.name === "c") ||
      (key.super && key.name === "c")
    ) {
      stop();
      this.copySelection();
      return;
    }
    // Cmd+V reaches the app only when the clipboard holds no text (see docs/interface.md).
    if (key.super && key.name === "v") {
      stop();
      void this.pasteImage();
      return;
    }
    if (key.ctrl && key.name === "k") {
      stop();
      if (this.sheetOpen) this.closeSheet();
      this.openPalette();
      return;
    }
    if (this.sheetOpen) {
      stop();
      if (
        key.name === "escape" ||
        key.sequence === "?" ||
        (key.ctrl && key.name === "c")
      )
        this.closeSheet();
      else {
        const step = { up: -1, down: 1, pageup: -10, pagedown: 10 }[
          key.name as "up"
        ];
        if (step) this.sheet.scrollBy(step);
      }
      return;
    }
    if (this.palette) {
      // On an empty input the first keystroke runs a quick key at once; any other key ends the
      // quick keys, and from then on every key is search text.
      if (this.quickArmed && key.name !== "escape") {
        this.quickArmed = false;
        const quick = !this.search?.value ? quickKey(key) : undefined;
        if (quick && this.quickKeys().includes(quick)) {
          stop();
          this.runQuickKey(quick);
          return;
        }
        this.drawActions();
      }
      if (key.ctrl && key.name === "c") {
        stop();
        this.dismiss();
        return;
      }
      if (key.name === "tab" && this.choosesFolder()) {
        stop();
        this.toggleOwnFolder();
        return;
      }
      if (
        this.picker &&
        !key.ctrl &&
        !key.meta &&
        ["b", "x"].includes(key.name)
      ) {
        stop();
        if (key.name === "b") this.dismiss();
        else this.endPicked();
        return;
      }
      if (["escape", "up", "down", "return"].includes(key.name)) {
        stop();
        if (key.name === "escape") this.dismiss();
        else if (key.name === "return") {
          if (this.confirm) void this.completeOperation();
          else this.choose();
        } else {
          this.selection =
            (this.selection +
              (key.name === "down" ? 1 : -1) +
              this.filtered.length) %
            Math.max(1, this.filtered.length);
          this.drawActions();
        }
      }
      return;
    }
    // A focused terminal receives every other key, including ? and Escape.
    if (this.terminalFocused()) return;
    if (this.listHasFocus()) {
      const rows = this.sessionRows();
      if (key.name === "down" || key.name === "up") {
        stop();
        if (rows.length) {
          this.listSelection =
            (this.listSelection +
              (key.name === "down" ? 1 : -1) +
              rows.length) %
            rows.length;
          this.drawSessions();
        }
        return;
      }
      if (key.name === "return") {
        stop();
        if (rows[this.listSelection])
          this.openRow(rows[this.listSelection], "keyboard");
        return;
      }
      if (key.name === "escape" || (key.ctrl && key.name === "c")) {
        stop();
        if (this.shells[this.active]) {
          this.listFocused = false;
          this.show("shell");
        }
        return;
      }
    }
    if (this.view === "health") {
      const step = { up: -1, down: 1, pageup: -10, pagedown: 10 }[
        key.name as "up"
      ];
      if (step) {
        stop();
        this.healthScroll.scrollBy(step);
        return;
      }
    }
    const found = directKey(key);
    const action = found && this.actions.find((a) => a.id === found.id);
    if (action && (!action.available || action.available())) {
      stop();
      this.record("action", { label: action.label, method: "key" });
      action.run();
    }
  };
  resize = () => {
    this.drawHeader();
    if (this.workspace) {
      this.body.maxWidth = this.view === "health" ? 116 : this.renderer.width;
      this.drawSessions();
      this.layoutPanes();
    }
    if (this.palette && this.choices) {
      this.choices.maxHeight = Math.max(3, this.renderer.height - 9);
      const panel = this.palette.findDescendantById("palette") as BoxRenderable;
      panel.width = this.searchWidth();
      this.palette.top = 2;
      this.palette.height = Math.max(8, this.renderer.height - 4);
      this.drawActions();
    }
    this.root.paddingLeft = this.root.paddingRight =
      this.renderer.width < 70 ? 1 : 2;
    this.drawHealth();
    this.drawSheet();
    this.drawHeader();
    this.drawFooter();
    this.record("resize", {
      width: this.renderer.width,
      height: this.renderer.height,
    });
  };
  cleanup() {
    if (this.disposed) return;
    this.disposed = true;
    clearInterval(this.timer);
    clearInterval(this.healthTimer);
    clearInterval(this.startupTimer);
    clearTimeout(this.sampleTimer);
    clearTimeout(this.sessionTimer);
    this.history.stopped = true;
    this.backend.close();
    this.renderer.keyInput.off("keypress", this.key);
    this.renderer.off("resize", this.resize);
    for (const s of this.shells) s.adapter.closeTransport();
    // An empty title gives the tab back to the terminal's own title.
    this.setTitle("");
    this.record("closed");
  }
  close() {
    this.renderer.destroy();
  }
}
/** Make styled text from spans in the tones of the Health view. */
function styled(spans: Span[], attributes = 0) {
  return new StyledText(
    spans.map((span) => ({
      __isChunk: true as const,
      text: span.text,
      fg: RGBA.fromHex(tones[span.tone]),
      attributes: span.tone === "title" ? TextAttributes.BOLD : attributes,
    })),
  );
}
/** Say why the spend inventory is missing. An older launcher rejects the command with usage text and exit 2. */
function spendFailure(error: unknown) {
  const message = String((error as Error)?.message ?? error);
  if (/^Launcher spend exited 2:/.test(message))
    return "the launcher has no spend command; install the updated launcher";
  return message
    .replace(/^Launcher spend exited \d+: /, "")
    .replace(/^Tokiwa: /, "")
    .slice(0, 300);
}
/** Parse the command line. `--live-health` remains accepted; sampling is the default. */
export function runOptions(argv: string[]) {
  const value = (name: string) => {
    const index = argv.indexOf(name);
    return index < 0 ? undefined : (argv[index + 1] ?? "");
  };
  const remote = value("--attach");
  if (
    remote !== undefined &&
    (!remote || !/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,47}$/.test(remote))
  )
    throw new Error("Use an existing session name.");
  const layout = value("--layout") ?? "workspace";
  if (layout !== "terminal" && layout !== "workspace")
    throw new Error("Use terminal or workspace layout.");
  const snapshot = value("--snapshot");
  if (snapshot !== undefined && !snapshot)
    throw new Error("Use --snapshot with a Health reading file.");
  const minutes = value("--deadline");
  if (
    minutes !== undefined &&
    (!/^\d{1,4}$/.test(minutes) || +minutes < 1 || +minutes > 1440)
  )
    throw new Error("Use --deadline with 1 to 1440 minutes.");
  return {
    remote,
    layout: layout as "terminal" | "workspace",
    receipt: value("--receipt"),
    deadline: minutes === undefined ? undefined : +minutes,
    ...(snapshot === undefined ? {} : { snapshot }),
  };
}
/** Start Health sampling and, for proof runs only, a close deadline in minutes. */
export function launch(app: App, deadline?: number) {
  if (!app.history.recorded) void app.sampleHealth();
  if (deadline === undefined) return undefined;
  const timer = setTimeout(() => app.close(), deadline * 60 * 1000);
  app.renderer.on("destroy", () => clearTimeout(timer));
  return timer;
}
if (import.meta.main) {
  const options = runOptions(process.argv.slice(2));
  const renderer = await createCliRenderer({
    exitOnCtrlC: false,
    targetFps: 30,
    useMouse: true,
  });
  const app = new App(renderer, options);
  // A launcher call in progress keeps a pipe open, and the app must not wait for it to quit.
  renderer.on("destroy", () => setTimeout(() => process.exit(0), 0));
  launch(app, options.deadline);
}
