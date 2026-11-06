import { RGBA } from "@opentui/core";
import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, theme } from "./app";
import { BackendClient } from "./backend";
import { paneLayout, throbColor } from "./workspace";
import { STATUS_GLYPH } from "./sessions";
const pause = () => Bun.sleep(120);
const ref = {
  name: "fixture",
  identity: "1:$2:3",
  cwd: "/srv/development/state/workspaces/project",
  project: "/srv/development/state/workspaces/project",
  clients: 0,
};
test("each row state has one glyph of one cell, and only output throbs", () => {
  expect(
    (["output", "quiet", "needs-you", "disconnected", "exited"] as const).map(
      (state) => STATUS_GLYPH[state],
    ),
  ).toEqual(["◆", "◇", "◈", "○", "·"]);
  for (const glyph of Object.values(STATUS_GLYPH))
    expect([...glyph].length).toBe(1);
  // The throb changes the colour of ◆, never its shape.
  const frames = [0, 320, 640, 960].map((at) => throbColor("#74c9ad", at));
  expect(new Set(frames).size).toBeGreaterThan(1);
  expect(frames[0]).toBe("#74c9ad");
  // Reduced motion keeps the accent colour.
  for (const at of [0, 320, 640, 960])
    expect(throbColor("#74c9ad", at, false)).toBe("#74c9ad");
});
test("remote shell creation uses existing launcher and rejects collisions", async () => {
  let rows = [ref];
  const backend = new BackendClient("/launcher", async () =>
    JSON.stringify({ sessions: rows }),
  );
  expect((await backend.shellCommand(ref, "new-shell")).command).toEqual([
    "/launcher",
    "new",
    "new-shell",
    "--from",
    "fixture",
  ]);
  rows = [...rows, { ...ref, name: "new-shell" }];
  await expect(backend.shellCommand(ref, "new-shell")).rejects.toThrow(
    "already exists",
  );
  rows = [{ ...ref, identity: "1:$4:5" }];
  await expect(backend.shellCommand(ref, "other")).rejects.toThrow(
    "identity changed",
  );
});
test("auxiliary PTY preserves source, focus, input and narrow layout", async () => {
  const t = await createTestRenderer({ width: 140, height: 38 });
  const app = new App(t.renderer, { spawn: false, layout: "workspace" });
  const source = app.startShell()!;
  app.show("shell");
  try {
    await pause();
    await app.shellHere();
    await t.renderOnce();
    await pause();
    const auxiliary = app.shells[1];
    expect(auxiliary.child.pid).not.toBe(source.child.pid);
    expect(auxiliary.cwd).toBe(source.cwd);
    expect(source.pane.visible).toBe(true);
    expect(auxiliary.pane.visible).toBe(true);
    await t.mockInput.pasteBracketedText("printf 'AUX_ONLY\\n'");
    t.mockInput.pressEnter();
    await pause();
    expect(auxiliary.terminal.screen().text).toContain("AUX_ONLY");
    expect(source.terminal.screen().text).not.toContain("AUX_ONLY");
    app.focusOther();
    await t.renderOnce();
    await t.mockInput.pasteBracketedText("printf 'SOURCE_ONLY\\n'");
    t.mockInput.pressEnter();
    await pause();
    expect(source.terminal.screen().text).toContain("SOURCE_ONLY");
    expect(auxiliary.terminal.screen().text).not.toContain("SOURCE_ONLY");
    for (const [width, height] of [
      [85, 34],
      [62, 24],
      [48, 18],
    ]) {
      t.resize(width, height);
      await t.renderOnce();
      await pause();
      expect(app.shells[app.active]).toBe(source);
      expect(auxiliary.pane.visible).toBe(
        paneLayout(width, height) !== "single",
      );
      expect(source.terminal.screen().columns).toBeGreaterThan(10);
    }
    app.closeAuxiliary();
    await pause();
    expect(app.shells).toEqual([source]);
    expect(source.exited).toBe(false);
    expect(source.terminal.screen().text).toContain("SOURCE_ONLY");
    expect(await auxiliary.child.exited).toBeDefined();
  } finally {
    await t.dispose();
  }
});
test("Ghostty command quoting preserves literal shell metacharacters", async () => {
  const { shellQuote } = await import("./ghostty");
  const value = "space ' quote $(printf injected); $HOME";
  const child = Bun.spawn(
    ["/bin/sh", "-c", 'printf "%s" ' + shellQuote(value)],
    { stdout: "pipe" },
  );
  expect(await new Response(child.stdout).text()).toBe(value);
  expect(await child.exited).toBe(0);
});

test("Shell here opens a verified shell in the folder of the session and sends no input", async () => {
  const t = await createTestRenderer({ width: 120, height: 32 });
  const app = new App(t.renderer, { spawn: false });
  const source = app.startShell()!;
  app.show("shell");
  source.remote = ref;
  let newName = "";
  let newShell: any;
  app.backend.shellCommand = async (_ref, name) => {
    newName = name;
    return {
      command: ["/bin/sh", "-c", "printf 'bash-5.2$ '; exec /bin/cat"],
      source: ref,
    };
  };
  app.backend.sessions = async () => [
    { ...ref, name: newName, identity: "1:$8:9" },
  ];
  const originalStart = app.startShell.bind(app);
  let sent = "";
  app.startShell = (...args) => {
    const shell = originalStart(...args)!;
    newShell = shell;
    shell.adapter.write = (value) => {
      sent += String(value);
    };
    return shell;
  };
  try {
    await app.shellHere();
    expect(sent).toBe("");
    expect(source.remote.cwd).toBe(ref.cwd);
    expect(app.shells[app.active]).toBe(newShell);
    expect(newShell.remote.identity).toBe("1:$8:9");
    expect(newShell.cwd).toBe(ref.cwd);
    expect(source.terminal.screen().text).not.toContain("cd --");
  } finally {
    await t.dispose();
  }
});

test("Shell here holds the place of the new shell while it starts, then a faint line parts the views", async () => {
  const t = await createTestRenderer({ width: 120, height: 32 });
  const app = new App(t.renderer, { spawn: false });
  const source = app.startShell()!;
  app.show("shell");
  source.remote = ref;
  let newName = "";
  let release = () => {};
  const ready = new Promise<void>((resolve) => (release = resolve));
  app.backend.shellCommand = async (_ref, name) => {
    newName = name;
    // The host takes some time to create the session.
    await ready;
    return {
      command: ["/bin/sh", "-c", "printf 'bash-5.2$ '; exec /bin/cat"],
      source: ref,
    };
  };
  app.backend.sessions = async () => [
    { ...ref, name: newName, identity: "1:$8:9" },
  ];
  try {
    const opening = app.shellHere();
    await Bun.sleep(20);
    await t.renderOnce();
    let frame = t.captureCharFrame();
    expect(frame).toContain("new shell");
    expect(frame).toContain("opening a shell in workspaces/");
    expect(app.pendingPane?.visible).toBe(true);
    // The pane of the starting shell already has the rule at its left side.
    expect(app.pendingPane?.border).toEqual(["left"]);
    release();
    await opening;
    await t.renderOnce();
    frame = t.captureCharFrame();
    expect(app.pendingPane).toBeUndefined();
    expect(frame).not.toContain("opening a shell");
    const [first, second] = app.pair!;
    // Each view has a left edge; the one whose terminal has the keyboard is an accent bar,
    // and the rule between two views is a faint line.
    expect(first.pane.border).toEqual(["left"]);
    expect(second.pane.border).toEqual(["left"]);
    const edge = (shell: typeof first) =>
      frame.split("\n")[shell.pane.y + 2][shell.pane.x];
    const lit = app.shells[app.active];
    const other = lit === first ? second : first;
    // One line parts the list and the views; the lit edge has the accent colour.
    expect(edge(lit)).toBe("│");
    expect(edge(other)).toBe("│");
    expect(app.sessionList.border).toEqual([]);
    const hex = (c: unknown) => RGBA.fromHex(String(c)).toString();
    expect([hex(theme.cpu), hex(theme.edge)]).toContain(
      String(lit.pane.borderColor),
    );
    expect(String(other.pane.borderColor)).toBe(hex(theme.line));
    // Stacked views part with a rule at the top of the second.
    t.resize(90, 32);
    await t.renderOnce();
    expect(second.pane.border).toEqual(["top", "left"]);
  } finally {
    await t.dispose();
  }
});

test("in a single view the title of the source says that a shell is starting", async () => {
  const t = await createTestRenderer({ width: 70, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  const source = app.startShell()!;
  app.show("shell");
  source.remote = ref;
  let release = () => {};
  const ready = new Promise<void>((resolve) => (release = resolve));
  app.backend.shellCommand = async () => {
    await ready;
    throw new Error("stopped by the test");
  };
  try {
    const opening = app.shellHere();
    await Bun.sleep(20);
    app.updateActivity();
    await t.renderOnce();
    expect(app.pendingPane?.visible).toBe(false);
    expect(t.captureCharFrame()).toContain(
      "workspaces/project  · opening a shell",
    );
    release();
    await opening;
    app.layoutPanes();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("opening a shell");
  } finally {
    await t.dispose();
  }
});

test("Shell here removes the view of a new shell that it could not verify", async () => {
  const t = await createTestRenderer({ width: 120, height: 32 });
  const app = new App(t.renderer, { spawn: false });
  const source = app.startShell()!;
  app.show("shell");
  source.remote = ref;
  app.backend.shellCommand = async () => ({
    command: ["/bin/sh", "-c", "printf 'bash-5.2$ '; exec /bin/cat"],
    source: ref,
  });
  app.backend.sessions = async () => {
    throw new Error("The session list failed.");
  };
  let started: ReturnType<typeof app.startShell>;
  const originalStart = app.startShell.bind(app);
  app.startShell = (...args) => (started = originalStart(...args));
  try {
    await app.shellHere();
    expect(started).toBeDefined();
    expect(app.error).toContain("The session list failed.");
    // Only the source view stays, and it keeps the keyboard.
    expect(app.shells).toEqual([source]);
    expect(app.shells[app.active]).toBe(source);
    expect(app.pair).toBeUndefined();
    expect(started!.pane.isDestroyed).toBe(true);
  } finally {
    await t.dispose();
  }
});
