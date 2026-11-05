import { test, expect } from "bun:test";
import { KEYMAP, directKey, quickKey, shortcutLines } from "./shortcuts";
import { lineText, type Span } from "./health-view";

const text = (lines: Span[][]) => lines.map(lineText).join("\n");

test("direct keys never collide", () => {
  const direct = KEYMAP.filter((b) => b.direct).map((b) => b.key);
  expect(new Set(direct).size).toBe(direct.length);
  for (const key of direct) expect(key.length).toBe(1);
});

test("the sheet groups match the reference: Workspace, Session, Terminal, Health", () => {
  const groups = [...new Set(KEYMAP.map((b) => b.group))];
  expect(groups.slice(0, 4)).toEqual([
    "Workspace",
    "Session",
    "Terminal",
    "Health",
  ]);
});

test("a direct key finds its binding only without Ctrl or Alt", () => {
  expect(directKey({ name: "h", sequence: "h" })?.id).toBe("health");
  expect(directKey({ name: "h", sequence: "H", shift: true })?.id).toBe(
    "health",
  );
  expect(directKey({ name: "h", sequence: "h", ctrl: true })).toBeUndefined();
  expect(directKey({ name: "h", sequence: "h", meta: true })).toBeUndefined();
  expect(directKey({ name: "?", sequence: "?", shift: true })?.id).toBe(
    "shortcuts",
  );
  expect(directKey({ name: "]", sequence: "]" })?.id).toBe("other-pane");
});

test("the sheet lists every key and fits each width", () => {
  for (const [width, columns] of [
    [152, 4],
    [96, 2],
    [58, 2],
  ] as const) {
    const lines = shortcutLines(width);
    const all = text(lines);
    expect(lineText(lines[0]).trim()).toBe("Keyboard shortcuts");
    for (const b of KEYMAP) {
      expect(all).toContain(b.key);
      expect(all).toContain(b.label);
    }
    for (const line of lines)
      expect(lineText(line).length).toBeLessThanOrEqual(width);
    // The group titles of one row of columns share a line.
    const titles = lines.find((line) => lineText(line).includes("Workspace"))!;
    expect(
      ["Workspace", "Session", "Terminal", "Health"].filter((t) =>
        lineText(titles).includes(t),
      ).length,
    ).toBe(columns);
  }
});

test("z turns focus mode on and off outside a terminal", () => {
  const focus = KEYMAP.find((b) => b.id === "focus")!;
  expect(focus).toMatchObject({ group: "Workspace", key: "z", label: "Focus" });
  expect(directKey({ name: "z", sequence: "z" })?.id).toBe("focus");
});

test("the Status group is a column of the sheet: each glyph in the tone of its state", () => {
  for (const width of [152, 96, 58]) {
    const lines = shortcutLines(width).map(lineText);
    // The title shares a line with other group titles or starts a row of columns, like a key group.
    expect(lines.some((line) => /(^|  )Status(  |$)/.test(line.trim()))).toBe(
      true,
    );
    const all = lines.join("\n");
    for (const row of [
      "◆  output",
      "◇  quiet",
      "◈  needs you",
      "○  disconnected",
      "·  exited",
      "¹  other clients",
    ])
      expect(all).toContain(row);
    // No separate legend line and no note under the columns.
    expect(all).not.toContain("◆ output  ◇ quiet");
    expect(all).not.toContain("ctrl+k searches");
  }
  const spans = shortcutLines(152).flat();
  const tone = (text: string) =>
    spans.find((s) => s.text.trim() === text)?.tone;
  expect(tone("◆")).toBe("accent");
  expect(tone("◈")).toBe("warning");
  expect(tone("○")).toBe("warning");
  expect(tone("◇")).toBe("dim");
  expect(tone("needs you")).toBe("value");
});

test("keys use the accent tone and actions the normal text tone", () => {
  const lines = shortcutLines(152);
  const row = lines.find((line) => lineText(line).includes("Health"))!;
  expect(row.find((s) => s.text.includes("Workspace"))?.tone).toBe("title");
  const quit = lines.find((line) => lineText(line).includes("Quit"))!;
  expect(quit.find((s) => s.text.trim() === "q")?.tone).toBe("accent");
  expect(quit.find((s) => s.text.trim() === "Quit")?.tone).toBe("value");
  expect(lines.flat().find((s) => s.text === "Status")?.tone).toBe("title");
});

test("the sheet lists the quick keys of the search under Terminal", () => {
  const terminal = KEYMAP.filter((b) => b.group === "Terminal");
  expect(terminal.map((b) => `${b.key}  ${b.label}`)).toEqual(
    expect.arrayContaining([
      "ctrl+k d  Detach",
      "ctrl+k z  Focus",
      "ctrl+k w  Sessions",
      "ctrl+k ?  Shortcuts",
    ]),
  );
  expect(text(shortcutLines(152))).toMatch(/ctrl\+k d +Detach/);
});

test("a quick key matches only without Shift, Ctrl or Alt; ? is its own character", () => {
  expect(quickKey({ sequence: "d" })?.id).toBe("detach");
  expect(quickKey({ sequence: "D", shift: true })).toBeUndefined();
  expect(quickKey({ sequence: "d", shift: true })).toBeUndefined();
  expect(quickKey({ sequence: "d", ctrl: true })).toBeUndefined();
  expect(quickKey({ sequence: "d", option: true })).toBeUndefined();
  expect(quickKey({ sequence: "?", shift: true })?.id).toBe("shortcuts");
  expect(quickKey({ sequence: "x" })).toBeUndefined();
});
