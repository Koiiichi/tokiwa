import { test, expect } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";
import { KEYMAP } from "./shortcuts";
import { landingSessions } from "./landing-fixture";

const pause = (ms = 60) => Bun.sleep(ms);
/** A backend that answers `--snapshot` with the fixed sessions and records each call. */
function fixtureBackend(fail = false) {
  const calls: string[][] = [];
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    calls.push(args);
    if (fail) throw new Error("Launcher --snapshot exited 255: timeout");
    return JSON.stringify({ sessions: landingSessions });
  });
  return { backend, calls };
}
async function landing(width = 100, height = 30, fail = false) {
  const t = await createTestRenderer({ width, height });
  const { backend, calls } = fixtureBackend(fail);
  const app = new App(t.renderer, { backend });
  await pause();
  await t.renderOnce();
  return { t, app, calls };
}

test("the app starts on the remote sessions grouped by project, without a local shell", async () => {
  const { t, app, calls } = await landing();
  try {
    expect(calls).toEqual([["--snapshot"]]);
    expect(app.shells).toHaveLength(0);
    const frame = t.captureCharFrame();
    for (const text of [
      "service-a-wt/fix-pr",
      "web-lead",
      "coder-lead",
      "workspaces/workbench",
      "claude-test",
      "setup2",
      "tools¹",
      "web-lead¹",
      "◈ coder-lead",
      "needs you",
      "EC2 · connected",
      "No session attached",
      "? shortcuts",
    ])
      expect(frame).toContain(text);
    expect(frame.indexOf("coder-lead")).toBeLessThan(frame.indexOf("web-lead"));
    expect(frame).not.toMatch(/prototype|candidate|Local\b/);
  } finally {
    await t.dispose();
  }
});

test("arrow keys select a session and Enter attaches it with its identity", async () => {
  const { t, app } = await landing();
  const attached: unknown[][] = [];
  app.attachRemote = async (...args) => {
    attached.push(args);
  };
  try {
    t.mockInput.pressArrow("down");
    await pause();
    t.mockInput.pressEnter();
    await pause();
    const api = landingSessions.find((s) => s.name === "web-lead")!;
    expect(attached).toEqual([["web-lead", api.identity]]);
  } finally {
    await t.dispose();
  }
});

test("a failed session read names the reason and the header shows the host unreachable", async () => {
  const { t } = await landing(100, 30, true);
  try {
    const frame = t.captureCharFrame();
    expect(frame).toContain("EC2 · offline");
    expect(frame).toContain("Sessions not available");
    expect(frame).toContain("timeout");
  } finally {
    await t.dispose();
  }
});

test("? opens the shortcuts sheet outside a terminal; Escape and ? close it", async () => {
  const { t, app } = await landing(156, 40);
  try {
    await t.mockInput.typeText("?");
    await pause();
    await t.renderOnce();
    expect(app.sheetOpen).toBe(true);
    const frame = t.captureCharFrame();
    for (const text of [
      "Keyboard shortcuts",
      "Workspace",
      "Session",
      "Terminal",
      "Health",
    ])
      expect(frame).toContain(text);
    t.mockInput.pressEscape();
    await pause();
    expect(app.sheetOpen).toBe(false);
    await t.mockInput.typeText("?");
    await pause();
    await t.mockInput.typeText("?");
    await pause();
    expect(app.sheetOpen).toBe(false);
  } finally {
    await t.dispose();
  }
});

test("inside a terminal ? reaches the program and Ctrl+K search lists Keyboard shortcuts", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  try {
    const shell = app.startShell("fixture")!;
    app.show("shell");
    await pause();
    expect(shell.terminal.focused).toBe(true);
    const sent: string[] = [];
    const write = shell.adapter.write.bind(shell.adapter);
    shell.adapter.write = (data) => {
      sent.push(Buffer.from(data).toString());
      write(data);
    };
    await t.mockInput.typeText("?");
    await pause();
    expect(app.sheetOpen).toBe(false);
    expect(sent.join("")).toContain("?");
    t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await t.mockInput.typeText("keyboard");
    await pause();
    expect(app.filtered.map((a) => a.label)).toEqual(["Keyboard shortcuts"]);
    t.mockInput.pressEnter();
    await pause();
    expect(app.sheetOpen).toBe(true);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("Ctrl+K search filters sessions and actions by name and has no headings or hints", async () => {
  const { t, app } = await landing();
  const attached: unknown[][] = [];
  app.attachRemote = async (...args) => {
    attached.push(args);
  };
  try {
    t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await t.mockInput.typeText("lead");
    await pause();
    await t.renderOnce();
    expect(app.filtered.map((a) => a.label)).toEqual([
      "coder-lead",
      "web-lead",
    ]);
    const frame = t.captureCharFrame();
    expect(frame).not.toMatch(/\[[A-Z]\]/);
    expect(frame).not.toContain("Remote sessions");
    t.mockInput.pressArrow("down");
    t.mockInput.pressEnter();
    await pause();
    expect(attached[0][0]).toBe("web-lead");
    expect(app.palette).toBeUndefined();
  } finally {
    await t.dispose();
  }
});

test("every action has a key in the sheet and the layout comparison is gone", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  try {
    // The two diagnostics of a garbled screen are in the search only.
    const searchOnly = [
      "repaint",
      "save-screen",
      "new-project",
      "new-session",
      "end-project",
      "rename-session",
    ];
    for (const action of app.actions) {
      if (searchOnly.includes(action.id)) continue;
      const binding = KEYMAP.find((b) => b.id === action.id);
      expect(binding).toBeDefined();
      expect(action.label).toBe(binding!.label);
    }
    expect(app.actions.map((a) => a.label).join(" ")).not.toMatch(/layout/i);
    expect(app.actions.find((a) => a.id === "quit")!.label).toBe("Quit");
  } finally {
    await t.dispose();
  }
});

test("no user-visible string in the app says prototype or candidate", () => {
  const source = readFileSync(join(import.meta.dir, "app.ts"), "utf8");
  const strings = source.match(/(["'`])(?:(?!\1)[^\\\n]|\\.)*\1/g) ?? [];
  expect(strings.filter((s) => /prototype|candidate/i.test(s))).toEqual([]);
  const groups = readFileSync(join(import.meta.dir, "projects.json"), "utf8");
  expect(groups).not.toMatch(/prototype/i);
});

test("a local shell starts only from its key", async () => {
  const { t, app } = await landing();
  try {
    expect(app.shells).toHaveLength(0);
    await t.mockInput.typeText("t");
    await pause();
    expect(app.shells).toHaveLength(1);
    expect(app.shells[0].remote).toBeUndefined();
    expect(app.shells[0].terminal.focused).toBe(true);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("at narrow widths the list fills the width and an attached terminal replaces it", async () => {
  const { t, app } = await landing(62, 24);
  try {
    expect(app.sessionList.visible).toBe(true);
    expect(app.shellPane.visible).toBe(false);
    const frame = t.captureCharFrame();
    expect(frame).toContain("service-a-wt/fix-pr");
    expect(frame).toContain("web-lead");
    await t.mockInput.typeText("t");
    await pause();
    await t.renderOnce();
    expect(app.sessionList.visible).toBe(false);
    expect(app.shellPane.visible).toBe(true);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("a second snapshot shows which sessions have output", async () => {
  const { t, app } = await landing();
  try {
    await app.refreshSessions();
    await t.renderOnce();
    // The fixture returns the same screens twice, so every session is quiet.
    const frame = t.captureCharFrame();
    expect(frame).toContain("◇ web-lead¹");
    expect(frame).toContain("◇ setup2");
    // No row shows output.
    expect(frame).not.toMatch(/◆ [a-z]/);
  } finally {
    await t.dispose();
  }
});

test("session reads pause in Health and resume with the workspace", async () => {
  const { t, app, calls } = await landing();
  try {
    await t.mockInput.typeText("h");
    await pause();
    // The scheduled read finds Health in view and stops the chain.
    clearTimeout(app.sessionTimer);
    app.sessionTimer = undefined;
    await t.mockInput.typeText("w");
    await pause();
    expect(calls).toHaveLength(2);
    expect(app.listHasFocus()).toBe(true);
  } finally {
    await t.dispose();
  }
});

/** The cell of a session name in the list, and the selected text of the renderer. */
function listCell(t: Awaited<ReturnType<typeof landing>>["t"], name: string) {
  const frame = t.captureCharFrame().split("\n");
  const y = frame.findIndex((line) =>
    new RegExp(` ${name}(?![\\w-])`).test(line),
  );
  return { x: frame[y].indexOf(name), y };
}
const selectedText = (t: Awaited<ReturnType<typeof landing>>["t"]) =>
  t.renderer.getSelection()?.getSelectedText() ?? "";

test("a click on a session row selects the session and selects no text", async () => {
  const { t, app } = await landing();
  const attached: unknown[][] = [];
  app.attachRemote = async (...args) => {
    attached.push(args);
  };
  try {
    const { x, y } = listCell(t, "web-lead");
    // A pointer moves a cell or two while the button is down; that is still a click.
    await t.mockMouse.pressDown(x + 2, y);
    await t.mockMouse.moveTo(x + 3, y + 1);
    await t.mockMouse.release(x + 3, y + 1);
    await Bun.sleep(5);
    await t.renderOnce();
    expect(attached.map((a) => a[0])).toEqual(["web-lead"]);
    expect(selectedText(t)).toBe("");
  } finally {
    await t.dispose();
  }
});

test("a session dropped on a project moves into it; a dropped project nests; the row opens nothing", async () => {
  const { t, app } = await landing();
  const attached: unknown[] = [];
  app.attachRemote = async (name) => void attached.push(name);
  const moved: unknown[][] = [];
  app.backend.setProject = async (ref, project) => {
    moved.push(["session", ref.name, project]);
    return "ok";
  };
  app.backend.moveProject = async (from, to) => {
    moved.push(["project", from, to]);
    return "ok";
  };
  app.refreshSessions = async () => {};
  try {
    const frame = () => t.captureCharFrame().split("\n");
    const at = (label: string) => {
      const y = frame().findIndex((l) => l.includes(label));
      return { x: frame()[y].indexOf(label) + 1, y };
    };
    const session = at("web-lead");
    const title = at("workspaces/workbench");
    // A drag from the name of a session to a project title moves it; nothing is selected or opened.
    await t.mockMouse.drag(session.x, session.y, title.x, title.y);
    await Bun.sleep(5);
    expect(moved).toEqual([
      [
        "session",
        "web-lead",
        app.remoteSessions.find((r) => r.name === "setup")!.project,
      ],
    ]);
    expect(attached).toEqual([]);
    expect(selectedText(t)).toBe("");
    // A project title dragged onto Workspace becomes a top-level project of that name.
    const project = at("service-a-wt/fix-pr");
    const nav = at("Workspace  Health");
    await t.mockMouse.drag(project.x, project.y, nav.x, nav.y);
    await Bun.sleep(5);
    expect(moved.at(-1)).toEqual([
      "project",
      app.remoteSessions.find((r) => r.name === "web-lead")!.project,
      "fix-pr",
    ]);
    expect(attached).toEqual([]);
  } finally {
    await t.dispose();
  }
});

test("a click on a navigation item or a pane title selects no text", async () => {
  const { t, app } = await landing(120, 30);
  try {
    const shell = app.startShell("fixture")!;
    app.show("shell");
    await pause();
    await t.renderOnce();
    const at = (text: string) => {
      const frame = t.captureCharFrame().split("\n");
      const y = frame.findIndex((line) => line.includes(text));
      return { x: frame[y].indexOf(text), y };
    };
    // A pointer that moves a cell while the button is down is still a click.
    const click = async (x: number, y: number) => {
      await t.mockMouse.pressDown(x + 1, y);
      await t.mockMouse.moveTo(x + 2, y);
      await t.mockMouse.release(x + 2, y);
      await t.renderOnce();
    };
    const title = at("fixture  local");
    await click(title.x, title.y);
    expect(selectedText(t)).toBe("");
    const health = at("Workspace  Health");
    await click(health.x + "Workspace  ".length, health.y);
    expect(app.view).toBe("health");
    expect(selectedText(t)).toBe("");
    await click(health.x, health.y);
    expect(app.view).toBe("shell");
    expect(selectedText(t)).toBe("");
    expect(shell.exited).toBe(false);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});

test("tests cannot run the installed launcher", async () => {
  await expect(new BackendClient().sessions()).rejects.toThrow(
    "Tests do not run the launcher",
  );
});

test("when the visible view's transport ends, the arrow keys move in the session list", async () => {
  const { t, app } = await landing();
  try {
    const shell = app.startShell("fixture")!;
    // As after an attach: the keyboard is in the terminal, not the list.
    app.listFocused = false;
    app.show("shell");
    await pause();
    expect(shell.terminal.focused).toBe(true);
    // Ending the process is what a detach or a dropped connection does to the transport.
    shell.adapter.write("exit\r");
    const deadline = Date.now() + 5000;
    while (!shell.exited && Date.now() < deadline) await pause(50);
    await pause();
    await t.renderOnce();
    expect(shell.exited).toBe(true);
    expect(shell.terminal.focused).toBe(false);
    expect(app.listHasFocus()).toBe(true);
    const before = app.listSelection;
    t.mockInput.pressArrow("down");
    await pause();
    expect(app.listSelection).not.toBe(before);
  } finally {
    await t.dispose();
  }
}, 15000);

test("a hidden session stays out of the list and the search", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const bridge = {
    ...landingSessions[0],
    name: "peermesh-bridge",
    identity: "9:$99:9",
    project: "/var/hidden-project",
    cwd: "/var/hidden-project",
  };
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify({ sessions: [...landingSessions, bridge] }),
  );
  const app = new App(t.renderer, { backend });
  try {
    await pause();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("web-lead");
    expect(frame).not.toContain("peermesh-bridge");
    expect(frame).not.toContain("hidden-project");
    expect(app.remoteSessions.map((s) => s.name)).not.toContain(
      "peermesh-bridge",
    );
  } finally {
    await t.dispose();
  }
});
