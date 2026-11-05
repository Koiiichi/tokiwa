import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient, type SessionRef } from "./backend";
import { landingPrevious, landingSessions } from "./landing-fixture";

const pause = (ms = 80) => Bun.sleep(ms);

/**
 * The workspace after two snapshot reads, with the keyboard in the list. `snapshot.current`
 * answers later reads. An attached session gets a transport that stays open and prints nothing,
 * or the command in `transports`.
 */
async function workspace(width = 120, height = 30) {
  const t = await createTestRenderer({ width, height });
  const snapshot = { current: landingSessions };
  const reads = [landingPrevious];
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify({ sessions: reads.shift() ?? snapshot.current }),
  );
  const transports: Record<string, string[]> = {};
  backend.attachCommand = (ref) => transports[ref.name] ?? ["/bin/sleep", "30"];
  const app = new App(t.renderer, { backend, spawn: false });
  await app.refreshSessions();
  await app.refreshSessions();
  app.focusSessions();
  await t.renderOnce();
  const frame = () => t.captureCharFrame().split("\n");
  const row = (name: string) =>
    frame().find((line) => new RegExp(`[◆◇◈○·] ${name}\\b`).test(line)) ?? "";
  /** Attach a session from the list with Enter, as the owner does. */
  const attach = async (name: string) => {
    app.focusSessions();
    app.listSelection = app.sessionRows().findIndex((r) => r.name === name);
    t.mockInput.pressEnter();
    for (let i = 0; i < 50 && app.remotePending.size === 0; i++) await pause(5);
    for (let i = 0; i < 50 && app.remotePending.size; i++) await pause(20);
    await pause();
    await t.renderOnce();
  };
  const dispose = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  return { t, app, snapshot, transports, frame, row, attach, dispose };
}

const withBell = (name: string, bell: boolean): SessionRef[] =>
  landingSessions.map((s) => (s.name === name ? { ...s, bell } : s));

test("each row has one status glyph before its name and a word only for an action", async () => {
  const w = await workspace();
  try {
    expect(w.row("web-lead")).toContain("◆ web-lead¹");
    expect(w.row("setup2")).toContain("◆ setup2");
    expect(w.row("claude-test")).toContain("◇ claude-test");
    expect(w.row("tools")).toContain("◇ tools¹");
    expect(w.row("coder-lead")).toMatch(/◈ coder-lead +needs you/);
    expect(w.row("nightly")).toMatch(/· nightly +exited/);
    const list = w.frame().join("\n");
    for (const word of ["output", "quiet", "client"])
      expect(list).not.toContain(word);
    // The top bar carries no session status.
    expect(w.frame()[2].trim()).toBe("Workspace  Health");
  } finally {
    await w.dispose();
  }
});

test("the session in the pane has a left bar, and its own client is not counted", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    expect(w.app.shells[0].terminal.focused).toBe(true);
    const line = w.row("web-lead");
    expect(line).toMatch(/^ *▎ [◆◇] web-lead /);
    expect(line).not.toContain("¹");
    // Other rows keep an empty bar column.
    expect(w.row("tools")).toMatch(/^ {4}◇ tools¹/);
    expect(w.frame()[2].trim()).toBe("Workspace  Health");
  } finally {
    await w.dispose();
  }
});

test("attaching a session clears its needs-you state until the bell rings again", async () => {
  const w = await workspace();
  try {
    expect(w.row("coder-lead")).toContain("needs you");
    await w.attach("coder-lead");
    // The snapshot still reports the bell, for example from another window of the session.
    await w.app.refreshSessions();
    await w.t.renderOnce();
    expect(w.row("coder-lead")).not.toContain("needs you");
    expect(w.row("coder-lead")).not.toContain("◈");
    // A read without the bell, then a new bell.
    w.snapshot.current = withBell("coder-lead", false);
    await w.app.refreshSessions();
    w.snapshot.current = withBell("coder-lead", true);
    await w.app.refreshSessions();
    await w.t.renderOnce();
    expect(w.row("coder-lead")).toMatch(/◈ coder-lead +needs you/);
  } finally {
    await w.dispose();
  }
});

test("a transport that ends shows the session as disconnected", async () => {
  const w = await workspace();
  w.transports.setup = ["/bin/sh", "-c", "exit 0"];
  try {
    await w.attach("setup");
    for (let i = 0; i < 50 && !w.app.shells[0].exited; i++) await pause(20);
    w.app.updateActivity();
    await w.t.renderOnce();
    expect(w.row("setup")).toMatch(/○ setup +disconnected/);
  } finally {
    await w.dispose();
  }
});

test("the output glyph throbs in colour, and reduced motion keeps it still", async () => {
  const w = await workspace();
  try {
    const colours = async () => {
      const seen = new Set<string>();
      for (let i = 0; i < 5; i++) {
        w.app.updateActivity();
        const glyph = w.app.listGlyphs.find((g) => g.state === "output")!;
        seen.add(String(glyph.text.fg));
        await pause(330);
      }
      return seen.size;
    };
    expect(await colours()).toBeGreaterThan(1);
    w.app.animate = false;
    expect(await colours()).toBe(1);
  } finally {
    await w.dispose();
  }
}, 10000);

test("focus mode gives the terminal the full width and shows the other sessions in the top bar", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const shell = w.app.shells[0];
    const sizes: number[] = [];
    const resize = shell.adapter.resize.bind(shell.adapter);
    shell.adapter.resize = (cols, rows) => {
      sizes.push(cols);
      resize(cols, rows);
    };
    const narrow = shell.terminal.width;
    // Inside a terminal, the search reaches Focus.
    const searchFocus = async () => {
      w.t.mockInput.pressKey("k", { ctrl: true });
      await pause();
      await w.t.mockInput.typeText("focus");
      await pause();
      expect(w.app.filtered.map((a) => a.label)).toEqual(["Focus"]);
      w.t.mockInput.pressEnter();
      await pause();
      await w.t.renderOnce();
      await w.t.renderOnce();
    };
    await searchFocus();
    expect(w.app.focusMode).toBe(true);
    expect(w.app.sessionList.visible).toBe(false);
    expect(shell.terminal.focused).toBe(true);
    expect(shell.terminal.width).toBeGreaterThan(narrow + 30);
    expect(sizes.at(-1)).toBe(shell.terminal.width);
    // The strip stands at the right end of the navigation row.
    expect(w.frame()[2]).toMatch(
      /Workspace {2}Health {4,}◆ setup2 · ◈ coder-lead · 3 quiet · 1 exited {0,4}$/,
    );
    await searchFocus();
    expect(w.app.focusMode).toBe(false);
    expect(w.app.sessionList.visible).toBe(true);
    expect(shell.terminal.focused).toBe(true);
    expect(shell.terminal.width).toBe(narrow);
    expect(sizes.at(-1)).toBe(narrow);
    expect(w.frame()[2].trim()).toBe("Workspace  Health");
    // Outside a terminal, z turns focus mode on and off.
    w.app.focusSessions();
    await w.t.mockInput.typeText("z");
    await pause();
    expect(w.app.focusMode).toBe(true);
    expect(shell.terminal.focused).toBe(true);
    // The Workspace item brings the list back over the full width; z restores the sidebar.
    w.app.focusSessions();
    await w.t.renderOnce();
    expect(w.app.sessionList.visible).toBe(true);
    expect(w.app.shellPane.visible).toBe(false);
    await w.t.mockInput.typeText("z");
    await pause();
    await w.t.renderOnce();
    expect(w.app.focusMode).toBe(false);
    expect(w.app.sessionList.visible).toBe(true);
    expect(w.app.shellPane.visible).toBe(true);
  } finally {
    await w.dispose();
  }
});

test("× on the title of a session's view asks to end the session, as × on its row does", async () => {
  const w = await workspace();
  try {
    await w.attach("web-lead");
    const title = w.app.shells[0].title;
    await w.t.mockMouse.moveTo(title.x + 1, title.y);
    await w.t.renderOnce();
    const line = w.frame()[title.y];
    const close = line.lastIndexOf("×");
    expect(close).toBeGreaterThan(title.x);
    await w.t.mockMouse.click(close, title.y);
    await w.t.renderOnce();
    expect(w.app.ending?.ref.name).toBe("web-lead");
    expect(w.app.confirm).toBeUndefined();
  } finally {
    await w.dispose();
  }
});
