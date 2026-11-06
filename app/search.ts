/** The lists of the Ctrl+K search: common actions by category when empty, matches when typed. */

export type Category = "Sessions" | "Session" | "Go to" | "Terminal" | "Tokiwa";

/** One result of the search: a session or an action. `id` names the action of an action. */
export interface SearchItem {
  label: string;
  detail: string;
  run: () => void;
  category: Category;
  id?: string;
}

/** A row of the result list: a category title with its rule, or an item. */
export type SearchRow =
  | { kind: "title"; text: Category }
  | { kind: "item"; item: SearchItem; index: number };

/** The category of each action. An action without a category goes under Tokiwa. */
export const ACTION_CATEGORY: Record<string, Category> = {
  detach: "Session",
  reconnect: "Session",
  focus: "Session",
  project: "Session",
  end: "Session",
  sessions: "Go to",
  health: "Go to",
  "other-pane": "Go to",
  copy: "Terminal",
  redraw: "Terminal",
  "shell-here": "Terminal",
  "local-shell": "Terminal",
  "local-group": "Terminal",
  "close-pane": "Terminal",
  ghostty: "Terminal",
  repaint: "Terminal",
  "save-screen": "Terminal",
  "new-project": "Session",
  "new-session": "Session",
  "end-project": "Session",
  "rename-session": "Session",
  shortcuts: "Tokiwa",
  refresh: "Tokiwa",
  quit: "Tokiwa",
};

/**
 * The common actions of the empty search, in order, at most three for each category. Only the
 * actions that apply now show. The shortcuts sheet keeps the full list.
 */
export const COMMON_ACTIONS = [
  "detach",
  "reconnect",
  "focus",
  "sessions",
  "health",
  "copy",
  "shell-here",
  "local-shell",
  "shortcuts",
  "quit",
];
const PER_CATEGORY = 3;
const ORDER: Category[] = [
  "Sessions",
  "Session",
  "Go to",
  "Terminal",
  "Tokiwa",
];

/**
 * Rank a label for a query: 0 when the label starts with it, 1 when a word of the label starts
 * with it, 2 when the label contains it elsewhere, and undefined when it does not match.
 */
export function matchRank(label: string, query: string) {
  const text = label.toLowerCase();
  const q = query.toLowerCase();
  const at = text.indexOf(q);
  if (at < 0) return undefined;
  if (at === 0) return 0;
  return new RegExp(`(^|[\\s/_.-])${escape(q)}`).test(text) ? 1 : 2;
}
const escape = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * List the search results. An empty query gives the common actions, grouped by category with
 * titles. A typed query gives every session and action that matches, best match first in each
 * category; sessions come first. Titles show only when more than one category matches.
 */
export function searchRows(
  query: string,
  sessions: SearchItem[],
  actions: SearchItem[],
): { items: SearchItem[]; rows: SearchRow[] } {
  let groups: { category: Category; items: SearchItem[] }[];
  if (!query) {
    groups = ORDER.map((category) => ({
      category,
      items: COMMON_ACTIONS.map((id) => actions.find((a) => a.id === id))
        .filter((a): a is SearchItem => a?.category === category)
        .slice(0, PER_CATEGORY),
    }));
  } else {
    const ranked = [...sessions, ...actions]
      .map((item, order) => ({
        item,
        order,
        rank: matchRank(item.label, query),
      }))
      .filter((r) => r.rank !== undefined)
      .sort((a, b) => a.rank! - b.rank! || a.order - b.order)
      .map((r) => r.item);
    groups = ORDER.map((category) => ({
      category,
      items: ranked.filter((item) => item.category === category),
    }));
  }
  groups = groups.filter((g) => g.items.length);
  const titled = !query || groups.length > 1;
  const items: SearchItem[] = [];
  const rows: SearchRow[] = [];
  for (const group of groups) {
    if (titled) rows.push({ kind: "title", text: group.category });
    for (const item of group.items) {
      rows.push({ kind: "item", item, index: items.length });
      items.push(item);
    }
  }
  return { items, rows };
}
