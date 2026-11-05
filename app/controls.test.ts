/**
 * Mouse and quick-key controls: the sidebar takes the keyboard on a click, rows and footer
 * controls highlight under the pointer, the footer controls run their actions, and the search
 * runs a quick key on its first keystroke.
 */
import { test, expect } from "bun:test";
import { RGBA, type Renderable } from "@opentui/core";
import { createTestRenderer } from "@opentui/core/testing";
import { App, theme } from "./app";
import { BackendClient } from "./backend";
import { landingPrevious, landingSessions } from "./landing-fixture";

const pause = (ms = 80) => Bun.sleep(ms);

/** The workspace after two snapshot reads, with the keyboard in the list. */
async function workspace(width = 120, height = 30) {
  const t = await createTestRenderer({ width, height });
  const reads = [landingPrevious];
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify({ sessions: reads.shift() ?? landingSessions }),
  );
  backend.attachCommand = () => ["/bin/sleep", "30"];
  const app = new App(t.renderer, { backend, spawn: false });
  await app.refreshSessions();
  await app.refreshSessions();
  app.focusSessions();
  await t.renderOnce();
  const lines = () => t.captureCharFrame().split("\n");
  /** The first cell of a text in the frame. */
  const at = (text: string, from = 0) => {
    const frame = lines();
    const y = frame.findIndex((line, i) => i >= from && line.includes(text));
    if (y < 0) throw new Error(`${text} is not in the frame`);
    return { x: frame[y].indexOf(text), y };
  };
  const attach = async (name: string) => {
    app.focusSessions();
    app.listSelection = app.sessionRows().findIndex((r) => r.name === name);
    t.mockInput.pressEnter();
    for (let i = 0; i < 50 && app.remotePending.size === 0; i++) await pause(5);
    for (let i = 0; i < 50 && app.remotePending.size; i++) await pause(20);
    await pause();
    await t.renderOnce();
  };
  const click = async (x: number, y: number) => {
    await t.mockMouse.click(x, y);
    await pause(20);
    await t.renderOnce();
  };
  const dispose = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  return { t, app, lines, at, attach, click, dispose };
}
type Workspace = Awaited<ReturnType<typeof workspace>>;
const selectedText = (w: Workspace) =>
  w.t.renderer.getSelection()?.getSelectedText() ?? "";
const colour = (value: unknown) => String(value);
const hoverColour = colour(RGBA.fromHex(theme.hover));
const background = (w: Workspace, id: string) =>
  colour(
    (
      w.app.root.findDescendantById(id) as Renderable & {
        backgroundColor: unknown;
      }
    )?.backgroundColor,
  );
/** The footer line: the last row of the frame. */
const footer = (w: Workspace) => w.lines().at(-2)!.trim();

test("a click on blank sidebar space gives the keyboard to the list; a click on the terminal gives it back", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const shell = w.app.shells[0];
    expect(shell.terminal.focused).toBe(true);
    // Below the last row of the list.
    await w.click(4, w.t.renderer.height - 4);
    expect(w.app.listHasFocus()).toBe(true);
    expect(shell.terminal.focused).toBe(false);
    expect(shell.exited).toBe(false);
    const rows = w.app.sessionRows();
    expect(rows[w.app.listSelection].name).toBe("web-lead");
    expect(selectedText(w)).toBe("");
    // The arrow keys now move in the list.
    w.t.mockInput.pressArrow("down");
    await pause();
    expect(rows[w.app.listSelection].name).not.toBe("web-lead");
    // A click on the terminal pane gives the keyboard back to the terminal.
    await w.click(80, 12);
    expect(w.app.listHasFocus()).toBe(false);
    expect(shell.terminal.focused).toBe(true);
    // A click on a group title also gives the keyboard to the list.
    const title = w.at("workspaces/workbench");
    await w.click(title.x + 2, title.y);
    expect(w.app.listHasFocus()).toBe(true);
    expect(selectedText(w)).toBe("");
  } finally {
    await w.dispose();
  }
});

test("a session row highlights under the pointer and the highlight follows it", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const index = (name: string) =>
      w.app.sessionRows().findIndex((r) => r.name === name);
    const tools = w.at(" tools");
    await w.t.mockMouse.moveTo(tools.x + 3, tools.y);
    await w.t.renderOnce();
    expect(background(w, `list-${index("tools")}`)).toBe(hoverColour);
    const setup = w.at(" setup2");
    await w.t.mockMouse.moveTo(setup.x + 3, setup.y);
    await w.t.renderOnce();
    expect(background(w, `list-${index("setup2")}`)).toBe(hoverColour);
    expect(background(w, `list-${index("tools")}`)).not.toBe(hoverColour);
    // The pointer leaves the row: the highlight goes. No text selection starts.
    await w.t.mockMouse.moveTo(4, w.t.renderer.height - 4);
    await w.t.renderOnce();
    expect(background(w, `list-${index("setup2")}`)).not.toBe(hoverColour);
    expect(selectedText(w)).toBe("");
    // A click on a row still attaches it.
    const tools2 = w.at(" tools");
    await w.click(tools2.x + 3, tools2.y);
    for (let i = 0; i < 50 && w.app.remotePending.size; i++) await pause(20);
    expect(w.app.shells.some((s) => s.name === "tools")).toBe(true);
  } finally {
    await w.dispose();
  }
});

test("the footer shows the controls of a remote terminal, and keys go first when it is narrow", async () => {
  for (const [width, expected] of [
    [
      156,
      "detach ctrl+k d · focus ctrl+k z · sessions ctrl+k w · shortcuts ctrl+k ?",
    ],
    [62, "detach · focus · sessions · shortcuts"],
  ] as const) {
    const w = await workspace(width, 30);
    try {
      await w.attach("web-lead");
      expect(w.app.shells[0].terminal.focused).toBe(true);
      expect(footer(w)).toBe(expected);
    } finally {
      await w.dispose();
    }
  }
});

test("the footer of the list and of Health", async () => {
  const w = await workspace();
  try {
    expect(footer(w)).toBe("↑↓ select · enter attach · ? shortcuts");
    await w.attach("web-lead");
    w.app.focusSessions();
    await w.t.renderOnce();
    expect(footer(w)).toBe(
      "↑↓ select · enter attach · esc terminal · z focus · ? shortcuts",
    );
    w.app.show("health");
    await w.t.renderOnce();
    expect(footer(w)).toMatch(/^(↑↓ scroll · )?w sessions · \? shortcuts$/);
  } finally {
    await w.dispose();
  }
});

test("a footer control highlights under the pointer and runs its action on a click", async () => {
  const w = await workspace();
  const copied: string[] = [];
  w.app.copy = (text) => void copied.push(text);
  try {
    await w.attach("web-lead");
    const shell = w.app.shells[0];
    const y = w.t.renderer.height - 1;
    const control = (label: string) => w.lines()[y].indexOf(label);
    await w.t.mockMouse.moveTo(control("sessions") + 1, y);
    await w.t.renderOnce();
    expect(w.app.hover).toBe("footer:sessions");
    expect(background(w, "footer-sessions")).toBe(hoverColour);
    // A drag on the footer selects no text.
    await w.t.mockMouse.drag(control("detach"), y, control("shortcuts"), y);
    await w.t.renderOnce();
    expect(selectedText(w)).toBe("");
    expect(copied).toEqual([]);
    await w.click(control("focus") + 1, y);
    expect(w.app.focusMode).toBe(true);
    await w.click(control("focus") + 1, y);
    expect(w.app.focusMode).toBe(false);
    await w.click(control("sessions") + 1, y);
    expect(w.app.listHasFocus()).toBe(true);
    expect(shell.exited).toBe(false);
    await w.click(control("shortcuts") + 1, y);
    expect(w.app.sheetOpen).toBe(true);
  } finally {
    await w.dispose();
  }
});

test("Ctrl+K shows the quick keys; the first keystroke runs one at once", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const shell = w.app.shells[0];
    const detached: number[] = [];
    shell.adapter.detach = () => void detached.push(1);
    const open = async () => {
      w.t.mockInput.pressKey("k", { ctrl: true });
      await pause();
      await w.t.renderOnce();
    };
    await open();
    // No separate quick-key row: each action that runs at once shows its key at the right.
    const frame = w.lines();
    expect(frame.join("\n")).not.toContain("d detach · z focus");
    expect(frame.find((l) => l.includes("Detach"))).toMatch(/Detach +d /);
    expect(frame.find((l) => l.includes("Focus"))).toMatch(/Focus +z /);
    expect(frame.find((l) => l.includes("Keyboard shortcuts"))).toMatch(
      /shortcuts +\? /,
    );
    await w.t.mockInput.typeText("z");
    await pause();
    expect(w.app.palette).toBeUndefined();
    expect(w.app.focusMode).toBe(true);
    expect(shell.terminal.focused).toBe(true);
    await open();
    await w.t.mockInput.typeText("z");
    await pause();
    expect(w.app.focusMode).toBe(false);
    await open();
    await w.t.mockInput.typeText("d");
    await pause();
    expect(detached).toEqual([1]);
    expect(w.app.palette).toBeUndefined();
    await open();
    await w.t.mockInput.typeText("?");
    await pause();
    expect(w.app.sheetOpen).toBe(true);
    w.app.closeSheet();
    await open();
    await w.t.mockInput.typeText("w");
    await pause();
    expect(w.app.listHasFocus()).toBe(true);
  } finally {
    await w.dispose();
  }
});

test("any other first keystroke starts a search, and then every key is search text", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const shell = w.app.shells[0];
    const detached: number[] = [];
    shell.adapter.detach = () => void detached.push(1);
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await w.t.mockInput.typeText("xz");
    await pause();
    await w.t.renderOnce();
    expect(w.app.search?.value).toBe("xz");
    expect(w.app.focusMode).toBe(false);
    expect(w.t.captureCharFrame()).not.toContain("d detach · z focus");
    // Emptying the input does not bring the quick keys back.
    w.t.mockInput.pressBackspace();
    w.t.mockInput.pressBackspace();
    await w.t.mockInput.typeText("d");
    await pause();
    expect(w.app.search?.value).toBe("d");
    expect(detached).toEqual([]);
    w.t.mockInput.pressEscape();
    await pause();
    expect(w.app.palette).toBeUndefined();
    // Shift is not a quick key.
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    w.t.mockInput.pressKey("D", { shift: true });
    await pause();
    expect(w.app.palette).toBeDefined();
    expect(detached).toEqual([]);
  } finally {
    await w.dispose();
  }
});

test("without a remote view in the pane the quick keys leave out detach and focus", async () => {
  const w = await workspace();
  try {
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await w.t.renderOnce();
    const frame = w.lines().join("\n");
    expect(frame).not.toContain("Detach");
    expect(frame).toMatch(/Sessions +w /);
    await w.t.mockInput.typeText("d");
    await pause();
    expect(w.app.palette).toBeDefined();
    expect(w.app.search?.value).toBe("d");
  } finally {
    await w.dispose();
  }
});

test("the empty search lists common actions by category and no sessions", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await w.t.renderOnce();
    const labels = w.app.filtered.map((a) => a.label);
    expect(labels).toEqual([
      "Detach",
      "Reconnect",
      "Focus",
      "Sessions",
      "Health",
      "Shell here",
      "New local shell",
      "Keyboard shortcuts",
      "Quit",
    ]);
    const frame = w.lines();
    for (const title of ["Session", "Go to", "Terminal", "Tokiwa"])
      expect(frame.some((line) => line.includes(`${title} ───`))).toBe(true);
    for (const name of ["coder-lead", "claude-test", "setup2"])
      expect(frame.join("\n")).not.toContain(name);
    // Only a key that runs at once shows at the right; Reconnect has none in the search.
    expect(frame.find((l) => l.includes("Reconnect"))).toMatch(/Reconnect\s*$/);
    expect(frame.find((l) => l.includes("Sessions"))).toMatch(/Sessions +w /);
  } finally {
    await w.dispose();
  }
});

test("typed text lists matching sessions first, by category only when several match", async () => {
  const w = await workspace();
  try {
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await w.t.mockInput.typeText("se");
    await pause();
    await w.t.renderOnce();
    const labels = w.app.filtered.map((a) => a.label);
    expect(labels.slice(0, 2)).toEqual(["setup", "setup2"]);
    expect(labels).toContain("Refresh sessions");
    expect(labels).not.toContain("coder-lead");
    const frame = w.lines().join("\n");
    expect(frame).toContain("Sessions ───");
    expect(frame).toMatch(/setup2 +workspaces\/workbench/);
    // One category: a flat list without titles.
    w.app.search!.value = "";
    await w.t.mockInput.typeText("lead");
    await pause();
    await w.t.renderOnce();
    expect(w.app.filtered.map((a) => a.label)).toEqual([
      "coder-lead",
      "web-lead",
    ]);
    expect(w.t.captureCharFrame()).not.toContain("Sessions ───");
  } finally {
    await w.dispose();
  }
});

test("arrow keys skip the category titles and the mouse runs an item", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    // Focus is the last item of Session; one press reaches Sessions under Go to.
    for (let i = 0; i < 3; i++) w.t.mockInput.pressArrow("down");
    await pause();
    await w.t.renderOnce();
    expect(w.app.filtered[w.app.selection].label).toBe("Sessions");
    const selected = w
      .lines()
      .find((l) => l.includes("Sessions") && l.includes(" w"))!;
    expect(selected).toContain("Sessions");
    w.t.mockInput.pressArrow("up");
    await pause();
    expect(w.app.filtered[w.app.selection].label).toBe("Focus");
    // The pointer highlights an item and a click runs it.
    const health = w.at("Health", 4);
    await w.t.mockMouse.moveTo(health.x + 1, health.y);
    await w.t.renderOnce();
    expect(w.app.hover).toMatch(/^search:/);
    await w.click(health.x + 1, health.y);
    expect(w.app.palette).toBeUndefined();
    expect(w.app.view).toBe("health");
  } finally {
    await w.dispose();
  }
});

test("the footer explains the state of the session row under the pointer", async () => {
  const w = await workspace();
  try {
    const codex = w.at(" coder-lead");
    await w.t.mockMouse.moveTo(codex.x + 3, codex.y);
    await w.t.renderOnce();
    expect(footer(w)).toBe(
      "◈ needs you · coder-lead rang the bell while no client viewed it",
    );
    const tools = w.at(" tools");
    await w.t.mockMouse.moveTo(tools.x + 3, tools.y);
    await w.t.renderOnce();
    expect(footer(w)).toBe(
      "◇ quiet · the screen of tools did not change since the last read · ¹ 1 other client is attached",
    );
    // The pointer leaves the row: the footer returns to its hints.
    await w.t.mockMouse.moveTo(4, w.t.renderer.height - 4);
    await w.t.renderOnce();
    expect(footer(w)).toBe("↑↓ select · enter attach · ? shortcuts");
  } finally {
    await w.dispose();
  }
});

test("the list shows no glyph guide; the ? sheet has the Status group", async () => {
  const w = await workspace(120, 30);
  try {
    expect(w.t.captureCharFrame()).not.toContain("what these mean");
    w.t.mockInput.pressKey("?");
    await pause();
    await w.t.renderOnce();
    expect(w.app.sheetOpen).toBe(true);
    const frame = w.t.captureCharFrame();
    expect(frame).toContain("Status");
    expect(frame).toContain("◆  output");
    expect(frame).toContain("◈  needs you");
  } finally {
    await w.dispose();
  }
});

test("a sheet row whose action applies is a control: it highlights and a click runs it", async () => {
  const w = await workspace(156, 40);
  try {
    w.t.mockInput.pressKey("?");
    await pause();
    await w.t.renderOnce();
    const health = w.at("h  Health");
    await w.t.mockMouse.moveTo(health.x + 4, health.y);
    await w.t.renderOnce();
    expect(w.app.sheetHover).toBe("health");
    // A row that only moves inside a view is not a control, nor is the open sheet itself.
    for (const text of [
      "Scroll a page",
      "Keyboard shortcuts",
      "Select session",
    ]) {
      const at = w.at(text, health.y - 2);
      await w.t.mockMouse.moveTo(at.x + 1, at.y);
      await w.t.renderOnce();
      expect(w.app.sheetHover).toBe("");
      await w.click(at.x + 1, at.y);
      expect(w.app.sheetOpen).toBe(true);
    }
    await w.click(health.x + 4, health.y);
    expect(w.app.sheetOpen).toBe(false);
    expect(w.app.view).toBe("health");
  } finally {
    await w.dispose();
  }
});

test("a click on Health or Workspace in the top bar closes the sheet and shows that view", async () => {
  const w = await workspace(156, 40);
  try {
    for (const [item, view] of [
      ["Health", "health"],
      ["Workspace", "shell"],
    ] as const) {
      w.t.mockInput.pressKey("?");
      await pause();
      await w.t.renderOnce();
      expect(w.app.sheetOpen).toBe(true);
      const nav = w.at(`${item}`, 2);
      await w.click(nav.x + 1, nav.y);
      expect(w.app.sheetOpen).toBe(false);
      expect(w.app.view).toBe(view);
      expect(w.t.captureCharFrame()).not.toContain("Keyboard shortcuts");
    }
  } finally {
    await w.dispose();
  }
});

test("a click on a row of a scrolled sheet runs the row under the pointer", async () => {
  const w = await workspace(62, 24);
  try {
    w.t.mockInput.pressKey("?");
    await pause();
    for (let i = 0; i < 3; i++) w.t.mockInput.pressArrow("down");
    await pause();
    await w.t.renderOnce();
    expect(w.app.sheet.scrollTop).toBeGreaterThan(0);
    const refresh = w.at("u  Refresh sessions");
    await w.t.mockMouse.moveTo(refresh.x + 4, refresh.y);
    await w.t.renderOnce();
    expect(w.app.sheetHover).toBe("refresh");
    const health = w.at("h  Health");
    await w.click(health.x + 4, health.y);
    expect(w.app.view).toBe("health");
  } finally {
    await w.dispose();
  }
});

test("the search covers the body down to the footer and the common actions fit at 62x24", async () => {
  const w = await workspace(62, 24);
  try {
    await w.attach("web-lead");
    w.t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await w.t.renderOnce();
    const frame = w.t.captureCharFrame();
    expect(frame).not.toContain("what these mean");
    // No scroll bar: every common action shows.
    expect(frame).not.toContain("█");
    expect(frame).toContain("Quit");
    // A category title starts where the input starts; its items indent two more cells.
    const input = w.at("› Search");
    expect(w.at("Session ─").x).toBe(input.x);
    expect(w.at("Detach").x).toBe(input.x + 2);
  } finally {
    await w.dispose();
  }
});

test("the first click on an unfocused terminal only focuses it and never reaches the program", async () => {
  const w = await workspace();
  try {
    // Like Claude Code, the program asks for mouse reports.
    w.app.backend.attachCommand = () => [
      "/bin/sh",
      "-c",
      "printf '\\033[?1000h\\033[?1002h\\033[?1006h'; sleep 30",
    ];
    await w.attach("web-lead");
    await pause(100);
    const shell = w.app.shells[0];
    const sent: string[] = [];
    const write = shell.adapter.write.bind(shell.adapter);
    shell.adapter.write = (data) => {
      sent.push(Buffer.from(data).toString("latin1"));
      write(data);
    };
    // The keyboard goes to the list, as after a click in the sidebar.
    w.app.focusSessions();
    await pause();
    await w.t.renderOnce();
    expect(shell.terminal.focused).toBe(false);
    expect(footer(w)).toContain("enter attach");
    // A click inside the terminal, below its title.
    await w.click(shell.pane.x + 6, shell.pane.y + 4);
    expect(shell.terminal.focused).toBe(true);
    expect(w.app.listHasFocus()).toBe(false);
    expect(footer(w)).toContain("detach");
    // Nothing went to the program: no mouse report and no other byte.
    expect(sent.map((s) => JSON.stringify(s))).toEqual([]);
    // Once the terminal has the keyboard, a click reaches the program as usual.
    await w.click(shell.pane.x + 6, shell.pane.y + 4);
    expect(sent.join("")).toMatch(/\x1b\[<0;\d+;\d+M/);
  } finally {
    await w.dispose();
  }
});

test("Save screen writes the emulator text and sizes to a private file; Repaint asks tmux for nothing", async () => {
  const { mkdtempSync, readdirSync, readFileSync, statSync, rmSync } =
    await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const folder = mkdtempSync(join(tmpdir(), "tokiwa-capture-"));
  const previous = process.env.TOKIWA_CAPTURE_DIR;
  process.env.TOKIWA_CAPTURE_DIR = join(folder, "captures");
  const w = await workspace(120, 30);
  try {
    const shell = w.app.startShell("cap", false, process.cwd(), [
      "/bin/sh",
      "-c",
      "printf 'LINE_ONE\\nLINE_TWO'; sleep 5",
    ])!;
    w.app.active = w.app.shells.indexOf(shell);
    w.app.show("shell");
    await pause(300);
    await w.t.renderOnce();
    w.app.runAction("save-screen");
    const [file] = readdirSync(process.env.TOKIWA_CAPTURE_DIR!);
    expect(file).toEndWith("-cap.txt");
    const path = join(process.env.TOKIWA_CAPTURE_DIR!, file);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(process.env.TOKIWA_CAPTURE_DIR!).mode & 0o777).toBe(0o700);
    const text = readFileSync(path, "utf8");
    expect(text).toContain("view: cap");
    expect(text).toMatch(/emulator: \d+x\d+/);
    expect(text).toContain("LINE_ONE\nLINE_TWO");
    await w.t.renderOnce();
    expect(footer(w)).toStartWith("saved the screen to");
    let sent = "";
    shell.adapter.write = (value) => void (sent += String(value));
    w.app.runAction("repaint");
    await w.t.renderOnce();
    expect(sent).toBe("");
    expect(footer(w)).toContain("tmux sent nothing");
  } finally {
    await w.dispose();
    if (previous === undefined) delete process.env.TOKIWA_CAPTURE_DIR;
    else process.env.TOKIWA_CAPTURE_DIR = previous;
    rmSync(folder, { recursive: true, force: true });
  }
});
