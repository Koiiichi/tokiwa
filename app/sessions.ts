/** Group and describe remote sessions for the workspace list. These are observations, not intent. */
import type { SessionRef } from "./backend";
import type { Activity } from "./state";
import type { Span, Tone } from "./health-view";

/** Name a project directory by its last two path parts, for example `service-a-wt/fix-pr`. */
export function projectTitle(project: string) {
  const parts = project.split("/").filter(Boolean);
  return parts.length ? parts.slice(-2).join("/") : "Ungrouped";
}

export interface SessionGroup<T> {
  project: string;
  title: string;
  items: T[];
}

/**
 * Group sessions by project directory: sort by project,
 * then by name, and start a group at each new project. An empty project groups as Ungrouped.
 */
export function groupSessions<T extends { name: string; project?: string }>(
  rows: T[],
): SessionGroup<T>[] {
  const sorted = [...rows].sort(
    (a, b) =>
      (a.project ?? "").localeCompare(b.project ?? "") ||
      a.name.localeCompare(b.name),
  );
  const groups: SessionGroup<T>[] = [];
  for (const row of sorted) {
    const project = row.project ?? "";
    if (groups.at(-1)?.project !== project)
      groups.push({ project, title: projectTitle(project), items: [] });
    groups.at(-1)!.items.push(row);
  }
  return groups;
}

/** A project in the session tree: a name path such as `studio/api`, or an old directory label. */
export interface TreeProject {
  kind: "project";
  path: string;
  title: string;
  depth: number;
  /** True when the workstation saved the project, so it shows also without sessions. */
  saved: boolean;
}
export interface TreeSession<T> {
  kind: "session";
  item: T;
  /** The depth of its project; a child session is listed one step further in. */
  depth: number;
  child: boolean;
}
export type TreeEntry<T> = TreeProject | TreeSession<T>;

/**
 * Order sessions as a tree of projects. A name path nests: `studio/api` lists under `studio`.
 * A label that starts with `/` is an old directory label: one top-level project titled by its
 * last two path parts. Saved projects show also without sessions. Inside a project, sessions
 * sort by name, and a session opened from another one (its `parent` is that session's `id`)
 * follows it as a child. Subprojects follow the sessions of their project.
 */
export function projectTree<
  T extends { name: string; project?: string; id?: string; parent?: string },
>(rows: T[], saved: string[] = [], order: string[] = []): TreeEntry<T>[] {
  const nodes = new Map<
    string,
    { key: string[]; title: string; depth: number; saved: boolean }
  >();
  const add = (path: string, isSaved: boolean) => {
    if (path.startsWith("/") || path === "") {
      const title = projectTitle(path);
      const node = nodes.get(path) ?? {
        key: [title],
        title,
        depth: 0,
        saved: false,
      };
      node.saved ||= isSaved;
      nodes.set(path, node);
      return;
    }
    const parts = path.split("/");
    parts.forEach((part, i) => {
      const at = parts.slice(0, i + 1).join("/");
      const node = nodes.get(at) ?? {
        key: parts.slice(0, i + 1),
        title: part,
        depth: i,
        saved: false,
      };
      if (i === parts.length - 1) node.saved ||= isSaved;
      nodes.set(at, node);
    });
  };
  for (const row of rows) add(row.project ?? "", false);
  for (const path of saved) add(path, true);
  // Top-level projects follow `order` first, then the rest by name; inside a project, by name.
  const rank = (path: string) => {
    const top = path.startsWith("/") ? path : path.split("/")[0];
    const at = order.indexOf(top);
    return at < 0 ? order.length : at;
  };
  const compare = (a: string[], b: string[]) => {
    for (let i = 0; i < Math.min(a.length, b.length); i++) {
      const c = a[i].localeCompare(b[i]);
      if (c) return c;
    }
    return a.length - b.length;
  };
  const entries: TreeEntry<T>[] = [];
  for (const [path, node] of [...nodes].sort(
    (a, b) => rank(a[0]) - rank(b[0]) || compare(a[1].key, b[1].key),
  )) {
    entries.push({
      kind: "project",
      path,
      title: node.title,
      depth: node.depth,
      saved: node.saved,
    });
    const members = rows
      .filter((r) => (r.project ?? "") === path)
      .sort((a, b) => a.name.localeCompare(b.name));
    const ids = new Set(members.map((m) => m.id).filter(Boolean));
    const place = (row: T, child: boolean) => {
      entries.push({ kind: "session", item: row, depth: node.depth, child });
      for (const kid of members)
        if (kid.parent && kid.parent === row.id && kid !== row)
          place(kid, true);
    };
    for (const row of members)
      if (!row.parent || !ids.has(row.parent)) place(row, false);
  }
  return entries;
}

/**
 * Observe the activity of a session that this view does not attach. A changed pane screen since
 * the previous snapshot of the same session is output. Without that snapshot, the state is unknown.
 */
export function snapshotActivity(
  current: SessionRef,
  previous: SessionRef | undefined,
): Activity {
  if (current.activity_partial) return "partial";
  const panes = current.activity ?? [];
  if (!panes.length) return "unknown";
  if (panes.every((p) => p.dead)) return "exited";
  if (!previous || previous.identity !== current.identity) return "unknown";
  const before = new Map(
    (previous.activity ?? []).map((p) => [p.pane, p.screen]),
  );
  if (!before.size) return "unknown";
  return panes.some(
    (p) => before.has(p.pane) && before.get(p.pane) !== p.screen,
  )
    ? "output"
    : "quiet";
}

/**
 * The status of a session row, shown as one glyph before its name. `needs-you` means that the
 * session rang the bell; `disconnected` means that the transport of this app ended; `unknown`
 * means that the view has no observation yet.
 */
export type RowState =
  "output" | "quiet" | "needs-you" | "disconnected" | "exited" | "unknown";

export const STATUS_GLYPH: Record<RowState, string> = {
  output: "◆",
  quiet: "◇",
  "needs-you": "◈",
  disconnected: "○",
  exited: "·",
  unknown: " ",
};
/** The tone of each glyph. The throb of output changes its colour in app.ts. */
export const STATUS_TONE: Record<RowState, Tone> = {
  output: "accent",
  quiet: "dim",
  "needs-you": "warning",
  disconnected: "warning",
  exited: "dim",
  unknown: "dim",
};
/** A dim word follows the name only for a state that needs an action. */
export const STATUS_WORD: Record<RowState, string> = {
  output: "",
  quiet: "",
  "needs-you": "needs you",
  disconnected: "disconnected",
  exited: "exited",
  unknown: "",
};
/** The glyphs in the order of the Status group of the shortcuts sheet. */
export const LEGEND: { glyph: string; label: string; tone: Tone }[] = [
  ...(["output", "quiet", "needs-you", "disconnected", "exited"] as const).map(
    (state) => ({
      glyph: STATUS_GLYPH[state],
      label: state === "needs-you" ? "needs you" : state,
      tone: STATUS_TONE[state],
    }),
  ),
  { glyph: "¹", label: "other clients", tone: "dim" },
];

/**
 * Combine an observation with the bell of the snapshot. A session whose processes ended cannot
 * answer, so `exited` comes first; a bell comes before the state of the transport.
 */
export function rowState(observed: Activity, needsYou: boolean): RowState {
  if (observed === "exited") return "exited";
  if (needsYou) return "needs-you";
  if (
    observed === "disconnected" ||
    observed === "output" ||
    observed === "quiet"
  )
    return observed;
  return "unknown";
}

const SUPERSCRIPT = "⁰¹²³⁴⁵⁶⁷⁸⁹";
/** Write a client count as one superscript digit, `⁹⁺` above nine and nothing for zero. */
export function superscript(count: number) {
  if (count <= 0) return "";
  return count > 9 ? "⁹⁺" : SUPERSCRIPT[count];
}

/**
 * Fit a session row into `width` cells: the name, the superscript count of the clients that are
 * attached elsewhere, then two spaces and the word of a state that needs an action. The name
 * gives way first.
 */
export function sessionRowText(
  name: string,
  word: string,
  clients: number,
  width: number,
) {
  const count = superscript(clients);
  const room = Math.max(4, width - count.length - (word ? word.length + 2 : 0));
  return {
    name: name.length > room ? name.slice(0, room - 1) + "…" : name,
    count,
    word,
  };
}

/**
 * Describe the sessions outside the pane in one line for focus mode: the sessions with output
 * and the sessions that need you by name, the rest counted by their state. When the line is
 * longer than `width`, the counts join as `N more`, and then the output names join them. The
 * names of sessions that need you stay.
 */
export function focusStrip(
  rows: { name: string; state: RowState }[],
  width: number,
): Span[] {
  const named = (state: RowState) =>
    rows
      .filter((r) => r.state === state)
      .map((r): Span[] => [
        { text: STATUS_GLYPH[state], tone: STATUS_TONE[state] },
        { text: ` ${r.name}`, tone: "value" },
      ]);
  const rest: RowState[] = ["quiet", "disconnected", "exited", "unknown"];
  const counted = rest.flatMap((state): Span[][] => {
    const n = rows.filter((r) => r.state === state).length;
    const word = state === "unknown" ? "other" : STATUS_WORD[state] || state;
    return n ? [[{ text: `${n} ${word}`, tone: "dim" }]] : [];
  });
  const more = (states: RowState[]): Span[][] => {
    const n = rows.filter((r) => states.includes(r.state)).length;
    return n ? [[{ text: `${n} more`, tone: "dim" }]] : [];
  };
  const join = (items: Span[][]) =>
    items.flatMap((item, i) =>
      i ? [{ text: " · ", tone: "dim" as Tone }, ...item] : item,
    );
  const cells = (spans: Span[]) => spans.reduce((n, s) => n + s.text.length, 0);
  const candidates = [
    [...named("output"), ...named("needs-you"), ...counted],
    [...named("output"), ...named("needs-you"), ...more(rest)],
    [...named("needs-you"), ...more(["output", ...rest])],
  ].map(join);
  return candidates.find((c) => cells(c) <= width) ?? candidates.at(-1)!;
}

/** What each state means, in a few plain words, for the footer under the pointer. */
const STATE_GUIDE: Record<RowState, (name: string) => string> = {
  output: (name) =>
    `output · the screen of ${name} changed in the last few seconds`,
  quiet: (name) =>
    `quiet · the screen of ${name} did not change since the last read`,
  "needs-you": (name) =>
    `needs you · ${name} rang the bell while no client viewed it`,
  disconnected: () => "disconnected · this app's view ended; enter reconnects",
  exited: (name) => `exited · every process of ${name} ended`,
  unknown: (name) =>
    `no reading yet · the next read shows whether ${name} changed`,
};

/** The short forms of the state guide, for a narrow footer. */
const STATE_SHORT: Record<RowState, (name: string) => string> = {
  output: () => "output · the screen changed",
  quiet: () => "quiet · no change since the last read",
  "needs-you": (name) => `needs you · ${name} rang the bell`,
  disconnected: () => "disconnected · enter reconnects",
  exited: () => "exited · every process ended",
  unknown: () => "no reading yet",
};

/**
 * Explain the state of a session row in one line of at most `width` cells: its glyph in the
 * colour of the state, then dim words, then the clients that are attached elsewhere. When the
 * line is too long, the client count goes first, then the long explanation.
 */
export function stateGuide(
  name: string,
  state: RowState,
  others: number,
  width = Infinity,
): Span[] {
  const glyph: Span[] =
    state === "unknown"
      ? []
      : [{ text: `${STATUS_GLYPH[state]} `, tone: STATUS_TONE[state] }];
  const clients: Span[] = others
    ? [
        {
          text: ` · ${superscript(others)} ${others} other ${others === 1 ? "client is" : "clients are"} attached`,
          tone: "dim",
        },
      ]
    : [];
  const candidates: Span[][] = [
    [...glyph, { text: STATE_GUIDE[state](name), tone: "dim" }, ...clients],
    [...glyph, { text: STATE_GUIDE[state](name), tone: "dim" }],
    [...glyph, { text: STATE_SHORT[state](name), tone: "dim" }],
  ];
  const cells = (spans: Span[]) => spans.reduce((n, s) => n + s.text.length, 0);
  return candidates.find((c) => cells(c) <= width) ?? candidates.at(-1)!;
}
