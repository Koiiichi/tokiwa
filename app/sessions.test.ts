import { test, expect } from "bun:test";
import {
  focusStrip,
  groupSessions,
  projectTree,
  projectTitle,
  rowState,
  snapshotActivity,
  sessionRowText,
  superscript,
  stateGuide,
} from "./sessions";
import { lineText } from "./health-view";
import { landingPrevious, landingSessions } from "./landing-fixture";

test("the group title is the last two parts of the project directory", () => {
  expect(
    projectTitle("/srv/development/state/workspaces/service-a-wt/fix-pr"),
  ).toBe("service-a-wt/fix-pr");
  expect(projectTitle("/workbench/")).toBe("workbench");
  expect(projectTitle("")).toBe("Ungrouped");
});

test("sessions group by project directory, then by name", () => {
  const groups = groupSessions(landingSessions);
  expect(groups.map((g) => g.title)).toEqual([
    "service-a-wt/fix-pr",
    "workspaces/workbench",
  ]);
  expect(groups.map((g) => g.items.map((s) => s.name))).toEqual([
    ["coder-lead", "web-lead"],
    ["claude-test", "nightly", "setup", "setup2", "tools"],
  ]);
});

test("an empty project groups as Ungrouped", () => {
  const groups = groupSessions([
    { ...landingSessions[0], name: "loose", project: "" },
  ]);
  expect(groups[0].title).toBe("Ungrouped");
});

test("activity compares pane screens with the previous snapshot", () => {
  const previous = new Map(landingPrevious.map((s) => [s.name, s]));
  const byName = (name: string) =>
    landingSessions.find((s) => s.name === name)!;
  expect(snapshotActivity(byName("web-lead"), previous.get("web-lead"))).toBe(
    "output",
  );
  expect(
    snapshotActivity(byName("coder-lead"), previous.get("coder-lead")),
  ).toBe("quiet");
  // Without an earlier snapshot the view cannot observe output.
  expect(snapshotActivity(byName("coder-lead"), undefined)).toBe("unknown");
  // A different identity is a different session.
  expect(
    snapshotActivity(byName("web-lead"), {
      ...previous.get("web-lead")!,
      identity: "9:$9:9",
    }),
  ).toBe("unknown");
  expect(
    snapshotActivity(
      {
        ...byName("tools"),
        activity: [{ ...byName("tools").activity![0], dead: true }],
      },
      previous.get("tools"),
    ),
  ).toBe("exited");
  expect(
    snapshotActivity({ ...byName("tools"), activity_partial: true }, undefined),
  ).toBe("partial");
});

test("a row state puts an ended process first, then the bell, then the transport", () => {
  expect(rowState("output", false)).toBe("output");
  expect(rowState("quiet", false)).toBe("quiet");
  expect(rowState("quiet", true)).toBe("needs-you");
  expect(rowState("output", true)).toBe("needs-you");
  expect(rowState("disconnected", true)).toBe("needs-you");
  expect(rowState("disconnected", false)).toBe("disconnected");
  expect(rowState("exited", true)).toBe("exited");
  // Without an observation the row claims nothing.
  expect(rowState("unknown", false)).toBe("unknown");
  expect(rowState("partial", false)).toBe("unknown");
});

test("the client count is a superscript digit, and 9+ above nine", () => {
  expect(superscript(0)).toBe("");
  expect([1, 2, 3, 4, 9].map(superscript)).toEqual(["¹", "²", "³", "⁴", "⁹"]);
  expect(superscript(10)).toBe("⁹⁺");
  expect(superscript(42)).toBe("⁹⁺");
});

test("a session row shows the name, the count of other clients and a word for an action", () => {
  expect(sessionRowText("web-lead", "", 0, 40)).toEqual({
    name: "web-lead",
    count: "",
    word: "",
  });
  expect(sessionRowText("tools", "", 1, 40)).toEqual({
    name: "tools",
    count: "¹",
    word: "",
  });
  expect(sessionRowText("coder-lead", "needs you", 2, 40)).toEqual({
    name: "coder-lead",
    count: "²",
    word: "needs you",
  });
  // A narrow row shortens the name and keeps the count and the word.
  const narrow = sessionRowText(
    "a-very-long-session-name",
    "disconnected",
    3,
    24,
  );
  expect(narrow.word).toBe("disconnected");
  expect(narrow.count).toBe("³");
  expect(
    narrow.name.length + narrow.count.length + 2 + narrow.word.length,
  ).toBeLessThanOrEqual(24);
  expect(narrow.name.endsWith("…")).toBe(true);
});

test("the focus strip names only the sessions that need you and counts the working agents", () => {
  const rows = [
    { name: "coder-lead", needs: true, word: "waiting" },
    { name: "web-lead", needs: false, agent: "working" },
    { name: "api-lead", needs: false, agent: "working" },
    { name: "spare", needs: false, agent: "idle" },
    { name: "tools", needs: false },
  ];
  const strip = focusStrip(rows, 80);
  expect(lineText(strip)).toBe("◈ coder-lead waiting · 2 working");
  expect(strip.find((s) => s.text === "◈")?.tone).toBe("warning");
  // A rate limit or an error stops an agent, so it needs you as well.
  expect(
    lineText(
      focusStrip(
        [
          { name: "a", needs: true, word: "limited" },
          { name: "b", needs: true, word: "" },
        ],
        80,
      ),
    ),
  ).toBe("◈ a limited · ◈ b");
  // Nothing to say gives an empty strip; quiet sessions are not counted.
  expect(focusStrip([{ name: "tools", needs: false }], 80)).toEqual([]);
  expect(lineText(focusStrip(rows.slice(1), 80))).toBe("2 working");
  // A narrow strip drops the count first, then joins the names after the first as a number.
  const many = [
    { name: "coder-lead", needs: true, word: "waiting" },
    { name: "review-lead", needs: true, word: "error" },
    { name: "web-lead", needs: false, agent: "working" },
  ];
  expect(lineText(focusStrip(many, 60))).toBe(
    "◈ coder-lead waiting · ◈ review-lead error · 1 working",
  );
  expect(lineText(focusStrip(many, 44))).toBe(
    "◈ coder-lead waiting · ◈ review-lead error",
  );
  expect(lineText(focusStrip(many, 30))).toBe("◈ coder-lead waiting · 1 more");
  expect(focusStrip([], 80)).toEqual([]);
});

test("the state guide explains a row in plain words, with its glyph and other clients", () => {
  expect(lineText(stateGuide("coder-lead", "needs-you", 0))).toBe(
    "◈ needs you · coder-lead asked for a person, or rang the bell while no client viewed it",
  );
  expect(lineText(stateGuide("setup", "disconnected", 0))).toBe(
    "○ disconnected · this app's view ended; enter reconnects",
  );
  expect(lineText(stateGuide("tools", "quiet", 1))).toBe(
    "◇ quiet · the screen of tools did not change since the last read · ¹ 1 other client is attached",
  );
  expect(stateGuide("tools", "needs-you", 0)[0].tone).toBe("warning");
  expect(lineText(stateGuide("x", "unknown", 2))).toContain(
    "² 2 other clients are attached",
  );
});

test("the state guide shortens to fit the width: the client count goes first", () => {
  expect(lineText(stateGuide("tools", "quiet", 1, 70))).toBe(
    "◇ quiet · the screen of tools did not change since the last read",
  );
  expect(lineText(stateGuide("coder-lead", "needs-you", 0, 60))).toBe(
    "◈ needs you · coder-lead is waiting for a person",
  );
  expect(lineText(stateGuide("setup", "disconnected", 0, 40))).toBe(
    "○ disconnected · enter reconnects",
  );
});

test("the tree nests projects by name path and lists a child session under its parent", () => {
  const rows = [
    { name: "codex", project: "studio/api", id: "$1" },
    { name: "claude-a", project: "studio/api", id: "$2" },
    { name: "shell-1", project: "studio/api", id: "$3", parent: "$2" },
    { name: "notes", project: "inbox", id: "$4" },
    { name: "old", project: "/srv/state/workspaces/workbench", id: "$5" },
    { name: "orphan", project: "inbox", id: "$6", parent: "$99" },
  ];
  const tree = projectTree(rows, ["studio/api/empty", "api-x"]);
  const shown = tree.map((e) =>
    e.kind === "project"
      ? `${"  ".repeat(e.depth)}[${e.title}]`
      : `${"  ".repeat(e.depth)}${e.child ? "└ " : ""}${e.item.name}`,
  );
  expect(shown).toEqual([
    "[api-x]",
    "[inbox]",
    "notes",
    "orphan",
    "[studio]",
    "  [api]",
    "  claude-a",
    "  └ shell-1",
    "  codex",
    "    [empty]",
    "[workspaces/workbench]",
    "old",
  ]);
  const api = tree.find((e) => e.kind === "project" && e.title === "api");
  expect(api).toMatchObject({ path: "studio/api", saved: false });
  expect(
    tree.find((e) => e.kind === "project" && e.title === "empty"),
  ).toMatchObject({ saved: true });
});

test("top-level projects follow the saved order, then the rest by name", () => {
  const rows = [
    { name: "a", project: "inbox" },
    { name: "b", project: "studio/api" },
    { name: "c", project: "/srv/state/workspaces/workbench" },
    { name: "d", project: "alpha" },
  ];
  const titles = (order: string[]) =>
    projectTree(rows, [], order)
      .filter((e) => e.kind === "project" && e.depth === 0)
      .map((e) => (e.kind === "project" ? e.title : ""));
  expect(titles([])).toEqual([
    "alpha",
    "inbox",
    "studio",
    "workspaces/workbench",
  ]);
  expect(titles(["/srv/state/workspaces/workbench", "studio"])).toEqual([
    "workspaces/workbench",
    "studio",
    "alpha",
    "inbox",
  ]);
});
