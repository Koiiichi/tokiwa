/** The key map and the keyboard shortcuts sheet. The sheet uses the plain-text style of Health. */
import type { Span, Tone } from "./health-view";
import { LEGEND } from "./sessions";

export type Group = "Workspace" | "Session" | "Terminal" | "Health";
export interface Binding {
  /** The action that app.ts runs for this binding, or a name for a navigation key. */
  id: string;
  group: Group;
  key: string;
  label: string;
  /**
   * A direct key runs its action with one key press when the focus is not inside a terminal.
   * A focused terminal receives every key except Ctrl+K and Ctrl+Shift+C.
   */
  direct?: boolean;
}

export const KEYMAP: Binding[] = [
  {
    id: "sessions",
    group: "Workspace",
    key: "w",
    label: "Sessions",
    direct: true,
  },
  { id: "health", group: "Workspace", key: "h", label: "Health", direct: true },
  { id: "focus", group: "Workspace", key: "z", label: "Focus", direct: true },
  {
    id: "refresh",
    group: "Workspace",
    key: "u",
    label: "Refresh sessions",
    direct: true,
  },
  {
    id: "sign-in",
    group: "Workspace",
    key: "l",
    label: "Sign in to AWS",
    direct: true,
  },
  {
    id: "local-shell",
    group: "Workspace",
    key: "t",
    label: "New local shell",
    direct: true,
  },
  {
    id: "local-group",
    group: "Workspace",
    key: "g",
    label: "Local shell group",
    direct: true,
  },
  {
    id: "background",
    group: "Workspace",
    key: "b",
    label: "Background sessions",
    direct: true,
  },
  {
    id: "shortcuts",
    group: "Workspace",
    key: "?",
    label: "Keyboard shortcuts",
    direct: true,
  },
  { id: "quit", group: "Workspace", key: "q", label: "Quit", direct: true },
  { id: "select", group: "Session", key: "↑ ↓", label: "Select session" },
  { id: "attach", group: "Session", key: "enter", label: "Attach" },
  { id: "back", group: "Session", key: "esc", label: "Back to terminal" },
  {
    id: "reconnect",
    group: "Session",
    key: "r",
    label: "Reconnect",
    direct: true,
  },
  { id: "detach", group: "Session", key: "d", label: "Detach", direct: true },
  {
    id: "project",
    group: "Session",
    key: "p",
    label: "Move to project",
    direct: true,
  },
  { id: "end", group: "Session", key: "x", label: "End session", direct: true },
  { id: "search", group: "Terminal", key: "ctrl+k", label: "Search" },
  {
    id: "copy",
    group: "Terminal",
    key: "ctrl+shift+c",
    label: "Copy selection",
  },
  // tmux's own key: it reaches tmux from inside the terminal as well.
  {
    id: "redraw",
    group: "Terminal",
    key: "ctrl+b r",
    label: "Redraw terminal",
  },
  // The quick keys: on an empty search, the first keystroke runs one at once.
  { id: "quick-detach", group: "Terminal", key: "ctrl+k d", label: "Detach" },
  { id: "quick-focus", group: "Terminal", key: "ctrl+k z", label: "Focus" },
  {
    id: "quick-sessions",
    group: "Terminal",
    key: "ctrl+k w",
    label: "Sessions",
  },
  {
    id: "quick-shortcuts",
    group: "Terminal",
    key: "ctrl+k ?",
    label: "Shortcuts",
  },
  {
    id: "shell-here",
    group: "Terminal",
    key: "n",
    label: "Shell here",
    direct: true,
  },
  {
    id: "other-pane",
    group: "Terminal",
    key: "]",
    label: "Other pane",
    direct: true,
  },
  {
    id: "close-pane",
    group: "Terminal",
    key: "c",
    label: "Close pane",
    direct: true,
  },
  {
    id: "ghostty",
    group: "Terminal",
    key: "o",
    label: "Open in Ghostty",
    direct: true,
  },
  { id: "scroll", group: "Health", key: "↑ ↓", label: "Scroll" },
  { id: "page", group: "Health", key: "pgup pgdn", label: "Scroll a page" },
];

/**
 * The quick keys of the search. On an empty input, the first keystroke runs one at once; any other
 * first keystroke starts a search. `id` names the action that the key runs.
 */
export const QUICK_KEYS = [
  { key: "d", id: "detach", label: "detach" },
  { key: "z", id: "focus", label: "focus" },
  { key: "w", id: "sessions", label: "sessions" },
  { key: "?", id: "shortcuts", label: "shortcuts" },
] as const;
export type QuickKey = (typeof QUICK_KEYS)[number];

/** Find the quick key of a key press. Shift (except for `?`), Ctrl, Alt and Meta never match. */
export function quickKey(key: {
  sequence: string;
  ctrl?: boolean;
  meta?: boolean;
  option?: boolean;
  shift?: boolean;
}): QuickKey | undefined {
  if (key.ctrl || key.meta || key.option) return undefined;
  return QUICK_KEYS.find(
    (q) => key.sequence === q.key && (q.key === "?" || !key.shift),
  );
}

/** Find the direct binding of a key press. Ctrl and Alt combinations are never direct keys. */
export function directKey(key: {
  name: string;
  sequence: string;
  ctrl?: boolean;
  meta?: boolean;
  shift?: boolean;
}) {
  if (key.ctrl || key.meta) return undefined;
  return KEYMAP.find(
    (b) =>
      b.direct &&
      (/^[a-z]$/.test(b.key) ? key.name === b.key : key.sequence === b.key),
  );
}

const GAP = 3;
const KEY_GAP = 2;

/** Lay out one group: a bold title, then rows of key and action. Keys align within the group. */
function groupBlock(group: Group) {
  const rows = KEYMAP.filter((b) => b.group === group);
  const keyWidth = Math.max(...rows.map((b) => b.key.length));
  const lines: Span[][] = [
    [{ text: group, tone: "title" }],
    ...rows.map((b): Span[] => [
      { text: b.key.padEnd(keyWidth + KEY_GAP), tone: "accent", binding: b.id },
      { text: b.label, tone: "value", binding: b.id },
    ]),
  ];
  return {
    lines,
    width: keyWidth + KEY_GAP + Math.max(...rows.map((b) => b.label.length)),
  };
}

/** Split blocks, in order, into `n` columns with the smallest tallest column. */
function partition<T>(items: T[], n: number, height: (column: T[]) => number) {
  if (n === 1) return [items];
  let best: T[][] = [];
  let bestHeight = Infinity;
  for (let i = 1; i <= items.length - n + 1; i++) {
    const rest = partition(items.slice(i), n - 1, height);
    const columns = [items.slice(0, i), ...rest];
    const tallest = Math.max(...columns.map(height));
    if (tallest < bestHeight) {
      best = columns;
      bestHeight = tallest;
    }
  }
  return best;
}

/** Lay out the Status group: each glyph in the tone of its state, then its meaning. */
function statusBlock() {
  const width = Math.max(...LEGEND.map((item) => item.glyph.length));
  const lines: Span[][] = [
    [{ text: "Status", tone: "title" }],
    ...LEGEND.map((item): Span[] => [
      { text: item.glyph.padEnd(width + KEY_GAP), tone: item.tone },
      { text: item.label, tone: "value" },
    ]),
  ];
  return {
    lines,
    width:
      width + KEY_GAP + Math.max(...LEGEND.map((item) => item.label.length)),
  };
}

/** The binding of the sheet cell at a column of a line, or "" for a cell that shows no binding. */
export function bindingAt(line: Span[], column: number) {
  let start = 0;
  for (const span of line) {
    if (column >= start && column < start + span.text.length)
      return span.binding ?? "";
    start += span.text.length;
  }
  return "";
}

/**
 * Lay out the keyboard shortcuts sheet for a width in cells: a title and up to four columns of
 * key groups. The Status group, with the meaning of each glyph, goes under the shortest column.
 * Blank lines go first when `height` is short.
 */
export function shortcutLines(width: number, height = Infinity): Span[][] {
  const groups = [...new Set(KEYMAP.map((b) => b.group))].map(groupBlock);
  const status = statusBlock();
  const blank: Span[] = [{ text: "", tone: "value" }];
  const build = (spaced: boolean) => {
    const stack = (column: typeof groups) =>
      column.flatMap((g, i) => (i && spaced ? [blank, ...g.lines] : g.lines));
    let columns: (typeof groups)[] = [groups];
    // Four columns, as in the reference, then two, then one. Three columns break the rows apart.
    for (const n of [4, 2, 1]) {
      columns = partition(groups, n, (c) => stack(c).length);
      // The Status group goes under the shortest column, so the key groups keep their places.
      const shortest = columns.reduce((best, c) =>
        stack(c).length < stack(best).length ? c : best,
      );
      columns = columns.map((c) => (c === shortest ? [...c, status] : c));
      const total =
        columns.reduce(
          (sum, c) => sum + Math.max(...c.map((g) => g.width)),
          0,
        ) +
        GAP * (columns.length - 1);
      if (total <= width) break;
    }
    const stacks = columns.map((c) => ({
      lines: stack(c),
      width: Math.max(...c.map((g) => g.width)),
    }));
    const rows = Math.max(...stacks.map((s) => s.lines.length));
    const body: Span[][] = [];
    for (let r = 0; r < rows; r++) {
      const line: Span[] = [];
      stacks.forEach((s, i) => {
        const cell = s.lines[r] ?? [];
        const used = cell.reduce((n, span) => n + span.text.length, 0);
        line.push(...cell);
        if (i < stacks.length - 1)
          line.push({ text: " ".repeat(s.width - used + GAP), tone: "value" });
      });
      body.push(line);
    }
    return body;
  };
  const title: Span[] = [{ text: "Keyboard shortcuts", tone: "title" }];
  const roomy = [title, blank, ...build(true)];
  if (roomy.length <= height) return roomy;
  const spaced = [title, ...build(true)];
  if (spaced.length <= height) return spaced;
  return [title, ...build(false)];
}
