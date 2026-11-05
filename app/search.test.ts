import { test, expect } from "bun:test";
import { matchRank, searchRows, type SearchItem } from "./search";

const item = (label: string, category: SearchItem["category"], id?: string) =>
  ({ label, detail: "", run: () => {}, category, id }) as SearchItem;
const sessions = ["coder-lead", "setup", "setup2"].map((n) =>
  item(n, "Sessions"),
);
const actions = [
  item("Detach", "Session", "detach"),
  item("Reconnect", "Session", "reconnect"),
  item("End session", "Session", "end"),
  item("Sessions", "Go to", "sessions"),
  item("Refresh sessions", "Tokiwa", "refresh"),
  item("Quit", "Tokiwa", "quit"),
];

test("a label that starts with the text ranks before a word match, then a match inside a word", () => {
  expect(matchRank("Sessions", "se")).toBe(0);
  expect(matchRank("End session", "se")).toBe(1);
  expect(matchRank("coder-lead", "lead")).toBe(1);
  expect(matchRank("Close", "lo")).toBe(2);
  expect(matchRank("Quit", "x")).toBeUndefined();
});

test("the empty search lists common actions by category and no sessions", () => {
  const { items, rows } = searchRows("", sessions, actions);
  expect(items.map((i) => i.label)).toEqual([
    "Detach",
    "Reconnect",
    "Sessions",
    "Quit",
  ]);
  expect(rows.flatMap((r) => (r.kind === "title" ? [r.text] : []))).toEqual([
    "Session",
    "Go to",
    "Tokiwa",
  ]);
});

test("typed text lists sessions first, ranked, and titles only for several categories", () => {
  const { items, rows } = searchRows("se", sessions, actions);
  expect(items.map((i) => i.label)).toEqual([
    "setup",
    "setup2",
    "End session",
    "Sessions",
    "Refresh sessions",
  ]);
  expect(rows[0]).toEqual({ kind: "title", text: "Sessions" });
  const flat = searchRows("setup", sessions, actions);
  expect(flat.rows.every((r) => r.kind === "item")).toBe(true);
});
