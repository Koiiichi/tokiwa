import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App, awsEndpoint } from "./app";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const pause = () => Bun.sleep(100);
// A bare test terminal sits over the app. The workspace pane holds only shells of the app.
const overlay = { position: "absolute", top: 4, left: 2, zIndex: 20 } as const;
test("search filters, selects and restores focus at narrow size", async () => {
  const t = await createTestRenderer({ width: 62, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  try {
    await t.renderOnce();
    t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Search sessions and actions");
    await t.mockInput.typeText("shell");
    await pause();
    await t.renderOnce();
    expect(app.filtered.map((a) => a.label)).toEqual([
      "New local shell",
      "Local shell group",
    ]);
    t.mockInput.pressEnter();
    await pause();
    await t.renderOnce();
    expect(app.view).toBe("shell");
    expect(app.palette).toBeUndefined();
    expect(app.shells[0].terminal.focused).toBe(true);
    t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    t.mockInput.pressEscape();
    await pause();
    expect(app.palette).toBeUndefined();
    t.resize(100, 40);
    await t.renderOnce();
    expect(app.renderer.width).toBe(100);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});
test("PTY accepts input, ANSI, Unicode, bracketed paste and resize", async () => {
  const t = await createTestRenderer({ width: 100, height: 32 });
  const app = new App(t.renderer, { spawn: false });
  const s = app.startShell()!;
  try {
    app.show("shell");
    await pause();
    await t.renderOnce();
    await t.mockInput.pasteBracketedText(
      "printf '\\033[32mPTY_OK\\033[0m 日本語\\n'",
    );
    t.mockInput.pressEnter();
    await Bun.sleep(250);
    await t.renderOnce();
    expect(s.terminal.screen().text).toContain("PTY_OK 日本語");
    t.resize(70, 24);
    await t.renderOnce();
    await pause();
    await t.mockInput.pasteBracketedText("stty size");
    t.mockInput.pressEnter();
    await pause();
    await t.renderOnce();
    expect(s.terminal.screen().text).toContain(
      `${s.terminal.screen().rows} ${s.terminal.screen().columns}`,
    );
    t.mockInput.pressKey("k", { ctrl: true });
    await pause();
    expect(app.palette).toBeDefined();
    t.mockInput.pressEscape();
    await pause();
    await t.mockInput.typeText("exit");
    t.mockInput.pressEnter();
    expect(await s.child.exited).toBe(0);
  } finally {
    await t.dispose();
  }
});

test("navigation shortcut does not leak into the shell", async () => {
  const t = await createTestRenderer({ width: 70, height: 25 });
  const app = new App(t.renderer, { spawn: false });
  const s = app.startShell()!;
  try {
    await pause();
    app.show("health");
    // w opens the session list and Escape returns to the terminal. Neither key reaches the shell.
    t.mockInput.pressKey("w");
    await pause();
    expect(app.listHasFocus()).toBe(true);
    t.mockInput.pressEscape();
    await pause();
    await t.renderOnce();
    await t.mockInput.pasteBracketedText("printf 'NO_LEAK_OK\\n'");
    t.mockInput.pressEnter();
    await pause();
    await t.renderOnce();
    expect(s.terminal.screen().text).toContain("NO_LEAK_OK");
    expect(s.terminal.screen().text).not.toContain("wprintf");
    await t.mockInput.typeText("exit");
    t.mockInput.pressEnter();
    await s.child.exited;
  } finally {
    await t.dispose();
  }
});

test("project group preserves independent shells and cleanup closes owned PTYs", async () => {
  const t = await createTestRenderer({ width: 80, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  const group = app.actions.find((a) => a.id === "local-group")!;
  group.run();
  group.run();
  expect(app.shells.map((s) => s.name)).toEqual(["build", "inspect"]);
  expect(app.shells[0].child.pid).not.toBe(app.shells[1].child.pid);
  await t.dispose();
  await Promise.all(app.shells.map((s) => s.child.exited));
  expect(app.shells.every((s) => s.exited)).toBe(true);
});

test("VT screen restore, query replies, focus and bracketed paste", async () => {
  const { EmbeddedTerminalRenderable } = await import("@opentui/core");
  const t = await createTestRenderer({ width: 40, height: 12 });
  const replies: string[] = [];
  const terminal = new EmbeddedTerminalRenderable(t.renderer, {
    width: 30,
    height: 8,
    onData: (data) => replies.push(new TextDecoder().decode(data)),
  });
  t.renderer.root.add(terminal);
  try {
    terminal.write("BASE");
    await t.renderOnce();
    terminal.write("\x1b[?1049h\x1b[H\x1b[2JALTERNATE");
    await t.renderOnce();
    expect(terminal.screen().text).toContain("ALTERNATE");
    terminal.write("\x1b[?1049l");
    await t.renderOnce();
    expect(terminal.screen().text).toContain("BASE");
    terminal.write("\x1b[6n");
    expect(replies.join("")).toMatch(/\x1b\[\d+;\d+R/);
    terminal.write("\x1b[?2004h");
    expect(
      new TextDecoder().decode(
        terminal.encodePaste(new TextEncoder().encode("paste")),
      ),
    ).toBe("\x1b[200~paste\x1b[201~");
    terminal.write("\x1b[?1004h");
    terminal.focus();
    terminal.blur();
    expect(replies.join("")).toContain("\x1b[I");
    expect(replies.join("")).toContain("\x1b[O");
  } finally {
    await t.dispose();
  }
});

test("open search resizes and keyboard selection remains visible", async () => {
  const t = await createTestRenderer({ width: 80, height: 35 });
  const app = new App(t.renderer, { spawn: false });
  try {
    app.openPalette();
    await t.renderOnce();
    t.resize(48, 18);
    await pause();
    await t.renderOnce();
    for (let i = 0; i < app.filtered.length - 1; i++)
      t.mockInput.pressArrow("down");
    await pause();
    await t.renderOnce();
    expect(app.filtered[app.selection].label).toBe("Quit");
    expect(t.captureCharFrame()).toContain("Quit");
    // The panel keeps its paddings and the input with the quick keys or its rule.
    expect(app.choices!.height).toBeLessThanOrEqual(18 - 9);
  } finally {
    await t.dispose();
  }
});

test("terminal selection reaches the clipboard encoder without shell input", async () => {
  const t = await createTestRenderer({
    width: 80,
    height: 24,
    kittyKeyboard: true,
  });
  const app = new App(t.renderer, { spawn: false });
  const { EmbeddedTerminalRenderable } = await import("@opentui/core");
  const terminal = new EmbeddedTerminalRenderable(t.renderer, {
    id: "copy-test",
    width: 30,
    height: 3,
    ...overlay,
  });
  app.root.add(terminal);
  app.show("shell");
  // Hide the workspace, so the selection holds only the text of the test terminal.
  app.workspace.visible = false;
  terminal.write("COPY_OK");
  terminal.focus();
  let copied = "";
  t.renderer.copyToClipboardOSC52 = (text: string) => {
    copied = text;
    return true;
  };
  try {
    await t.renderOnce();
    await t.mockMouse.drag(terminal.x, terminal.y, terminal.x + 6, terminal.y);
    await t.renderOnce();
    expect(t.renderer.getSelection()?.getSelectedText()).toBe("COPY_OK");
    t.mockInput.pressKey("c", { ctrl: true, shift: true });
    expect(copied).toBe("COPY_OK");
  } finally {
    await t.dispose();
  }
});

test("search preserves context and fits all required viewports", async () => {
  for (const [width, height] of [
    [140, 42],
    [80, 30],
    [62, 30],
    [48, 18],
  ]) {
    const t = await createTestRenderer({ width, height });
    const app = new App(t.renderer, { spawn: false });
    try {
      app.openPalette();
      await t.renderOnce();
      expect(app.health.visible).toBe(true);
      expect(app.palette!.width).toBeLessThanOrEqual(width);
      for (let i = 0; i < app.filtered.length - 1; i++)
        t.mockInput.pressArrow("down");
      await t.renderOnce();
      expect(t.captureCharFrame()).toContain("Quit");
      t.mockInput.pressEscape();
      expect(app.health.visible).toBe(true);
    } finally {
      await t.dispose();
    }
  }
});
test("ending asks: esc or any other key withdraws the question and ends nothing", async () => {
  const t = await createTestRenderer({ width: 80, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  const { BackendClient } = await import("./backend");
  const ref = {
    name: "fixture-a",
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 0,
  };
  const commands: string[][] = [];
  app.backend = new BackendClient("/launcher", async (args) => {
    commands.push(args);
    return JSON.stringify({ sessions: [ref] });
  });
  try {
    // Esc keeps the session; any other key withdraws the question and ends nothing.
    app.askEnd(ref);
    t.mockInput.pressEscape();
    await Bun.sleep(80);
    expect(app.ending).toBeUndefined();
    app.askEnd(ref);
    await t.mockInput.typeText("wrong");
    expect(app.ending).toBeUndefined();
    t.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(commands).toEqual([]);
  } finally {
    await t.dispose();
  }
});

test("late attach preserves modal focus and applies the terminal size", async () => {
  const t = await createTestRenderer({ width: 48, height: 18 });
  const app = new App(t.renderer, { spawn: false });
  const ref = {
    name: "fixture-a",
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 0,
  };
  let resolve!: (value: any) => void;
  app.backend.resolve = () => new Promise((r) => (resolve = r));
  app.backend.attachCommand = () => ["/bin/zsh", "-f"];
  try {
    const pending = app.attachRemote(ref.name);
    app.confirmOperation(ref, "project");
    resolve(ref);
    await pending;
    await t.renderOnce();
    expect(app.palette).toBeDefined();
    expect(app.shells[0].terminal.focused).toBe(false);
    expect(app.search?.focused).toBe(true);
    expect(app.shells).toHaveLength(1);
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
});
test("Health sampling has one in-flight request and does not reschedule after close", async () => {
  const t = await createTestRenderer({ width: 80, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  let calls = 0;
  let reject!: (error: Error) => void;
  app.backend.health = () => {
    calls++;
    return new Promise((_, r) => (reject = r));
  };
  const first = app.sampleHealth();
  await app.sampleHealth();
  expect(calls).toBe(1);
  await t.dispose();
  reject(new Error("offline"));
  await first;
  expect(app.sampleTimer).toBeUndefined();
  expect(app.history.events[0].error).toContain("offline");
});

test("both layouts preserve the focused shell across switches and Health at wide and narrow sizes", async () => {
  for (const layout of ["workspace", "terminal"] as const)
    for (const width of [140, 62, 48]) {
      const t = await createTestRenderer({ width, height: 24 });
      const app = new App(t.renderer, { spawn: false, layout });
      try {
        app.startShell("fixture-a");
        app.startShell("fixture-b");
        const pid = app.shells[0].child.pid;
        app.show("shell");
        app.focusSessions();
        await t.renderOnce();
        expect(app.sessionList.visible).toBe(true);
        // The list fills the width unless the workspace layout has room beside the terminal.
        expect(app.splitLayout()).toBe(layout === "workspace" && width >= 100);
        t.mockInput.pressArrow("down");
        t.mockInput.pressEnter();
        await Bun.sleep(50);
        expect(app.active).toBe(1);
        expect(app.shells[1].terminal.focused).toBe(true);
        app.show("health");
        expect(app.active).toBe(1);
        app.show("shell");
        expect(app.shells[1].terminal.focused).toBe(true);
        expect(app.shells[0].child.pid).toBe(pid);
        expect(app.shells[0].exited).toBe(false);
      } finally {
        const children = app.shells.map((s) => s.child.exited);
        await t.dispose();
        await Promise.all(children);
      }
    }
});

test("mouse wheel exposes earlier embedded-terminal scrollback", async () => {
  const { EmbeddedTerminalRenderable } = await import("@opentui/core");
  const t = await createTestRenderer({ width: 80, height: 20 });
  try {
    const term = new EmbeddedTerminalRenderable(t.renderer, {
      id: "scrollback",
      width: 80,
      height: 20,
      maxScrollback: 200,
    });
    t.renderer.root.add(term);
    term.write(
      Array.from(
        { length: 100 },
        (_, i) => `LINE_${String(i).padStart(3, "0")}\r\n`,
      ).join(""),
    );
    await t.renderOnce();
    const before = t.captureCharFrame();
    for (let i = 0; i < 10; i++) await t.mockMouse.scroll(5, 5, "up");
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toBe(before);
    expect(t.captureCharFrame()).toMatch(/LINE_0[0-6][0-9]/);
  } finally {
    await t.dispose();
  }
});

test("Reconnect action requests transport replacement rather than selecting the existing view", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  app.startShell("fixture");
  app.shells[0].remote = {
    name: "fixture",
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 1,
  };
  let args: unknown[] = [];
  app.attachRemote = async (...values) => {
    args = values;
  };
  try {
    app.actions.find((a) => a.id === "reconnect")!.run();
    expect(args).toEqual(["fixture", "1:$2:3", true]);
  } finally {
    await t.dispose();
  }
});

test("switching a connected remote terminal does not wait for an AWS snapshot", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  app.startShell("fixture");
  app.shells[0].remote = {
    name: "fixture",
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 1,
  };
  let calls = 0;
  app.backend.resolve = async () => {
    calls++;
    throw new Error("Network unavailable");
  };
  try {
    app.show("health");
    app.error = "Previous connection failed";
    await app.attachRemote("fixture", "1:$2:3");
    expect(calls).toBe(0);
    expect(app.view).toBe("shell");
    expect(app.shells).toHaveLength(1);
    expect(app.error).toBe("");
    app.show("health");
    await app.attachRemote("fixture", "1:$3:4");
    expect(app.view).toBe("health");
    expect(app.error).toContain("identity changed");
    expect(calls).toBe(0);
  } finally {
    await t.dispose();
  }
});

test("palette copy preserves terminal selection across search focus", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  const { EmbeddedTerminalRenderable } = await import("@opentui/core");
  const term = new EmbeddedTerminalRenderable(t.renderer, {
    id: "palette-copy",
    width: 30,
    height: 3,
    ...overlay,
  });
  app.root.add(term);
  app.show("shell");
  // Hide the workspace, so the selection holds only the text of the test terminal.
  app.workspace.visible = false;
  term.write("COPY_PALETTE 日本語");
  term.focus();
  let copied = "";
  t.renderer.copyToClipboardOSC52 = (text) => {
    copied = text;
    return true;
  };
  try {
    await t.renderOnce();
    await t.mockMouse.drag(term.x, term.y, term.x + 18, term.y);
    const selected = t.renderer.getSelection()?.getSelectedText();
    expect(selected).toBe("COPY_PALETTE 日本語");
    t.mockInput.pressKey("k", { ctrl: true });
    await t.mockInput.typeText("Copy selection");
    expect(app.filtered.some((a) => a.label === "Copy selection")).toBe(true);
    t.mockInput.pressEnter();
    expect(copied).toBe("COPY_PALETTE 日本語");
    expect(app.palette).toBeUndefined();
  } finally {
    await t.dispose();
  }
});

test("a delayed session refresh cannot take input from the terminal", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  app.startShell();
  let finish!: (refs: []) => void;
  app.backend.sessions = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    app.show("shell");
    const pending = app.refreshSessions();
    app.dismiss();
    finish([]);
    await pending;
    await t.renderOnce();
    expect(app.palette === undefined).toBe(true);
    expect(app.shells[0].terminal.focused).toBe(true);
    await t.mockInput.typeText("printf 'FOCUS_PRESERVED\\n'");
    t.mockInput.pressEnter();
    await Bun.sleep(150);
    await t.renderOnce();
    expect(app.shells[0].terminal.screen().text).toContain("FOCUS_PRESERVED");
  } finally {
    await t.dispose();
  }
});

test("session results preserve an open search query", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  let finish!: (refs: []) => void;
  app.backend.sessions = () =>
    new Promise((resolve) => {
      finish = resolve;
    });
  try {
    app.openPalette();
    const pending = app.refreshSessions();
    await t.mockInput.typeText("Health");
    finish([]);
    await pending;
    expect(app.search?.value).toBe("Health");
    expect(app.search?.focused).toBe(true);
    expect(app.filtered.map((a) => a.label)).toEqual(["Health"]);
  } finally {
    await t.dispose();
  }
});

test("ending a session shows progress, ignores a second enter and shows a failure", async () => {
  const t = await createTestRenderer({ width: 80, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  const { BackendClient } = await import("./backend");
  const ref = {
    name: "fixture-a",
    identity: "1:$2:3",
    cwd: "/work",
    project: "/work",
    clients: 0,
  };
  let release!: () => void;
  let fail = false;
  const ends: string[][] = [];
  app.backend = new BackendClient("/launcher", async (args) => {
    if (args[0] === "--end-confirmed") {
      ends.push(args);
      await new Promise<void>((r) => (release = r));
      if (fail)
        throw new Error("Launcher --end-confirmed exited 1: identity changed");
      return "";
    }
    return JSON.stringify({ sessions: [ref] });
  });
  try {
    app.remoteSessions = [ref];
    app.focusSessions();
    app.askEnd(ref);
    t.mockInput.pressEnter();
    await Bun.sleep(30);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("ending fixture-a");
    t.mockInput.pressEnter();
    await Bun.sleep(30);
    expect(ends).toHaveLength(1);
    fail = true;
    release();
    for (let i = 0; i < 50 && app.ending; i++) await Bun.sleep(10);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("identity changed");
  } finally {
    await t.dispose();
  }
});

test("copy uses the last finished selection after a click cleared it, and says so", async () => {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  const copied: string[] = [];
  t.renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text);
    return true;
  };
  try {
    // A drag ends: the renderer reports the finished selection, and it copies at once.
    t.renderer.emit("selection", {
      getSelectedText: () => "Step 4 is blocked",
    });
    await Bun.sleep(10);
    await t.renderOnce();
    expect(copied).toEqual(["Step 4 is blocked"]);
    expect(t.captureCharFrame()).toContain("copied 17 characters");
    // The click on the footer's copy has cleared the live selection; copy uses the last one.
    t.renderer.getSelection = () => null;
    app.copySelection();
    expect(copied).toEqual(["Step 4 is blocked", "Step 4 is blocked"]);
  } finally {
    await t.dispose();
  }
});

test("a program that reports the mouse owns a drag; its clipboard write and Cmd+C copy", async () => {
  const t = await createTestRenderer({
    width: 100,
    height: 30,
    kittyKeyboard: true,
  });
  const app = new App(t.renderer, { spawn: false });
  const copied: string[] = [];
  t.renderer.copyToClipboardOSC52 = (text: string) => {
    copied.push(text);
    return true;
  };
  const b64 = Buffer.from("from the program").toString("base64");
  const script = [
    "import os, sys, time",
    "os.write(1, b'\\x1b[?1000h\\x1b[?1002h\\x1b[?1006hTRACKED TEXT HERE')",
    "sys.stdin.buffer.raw.read(1)",
    `os.write(1, b'\\x1b]52;c;${b64}\\x07')`,
    "time.sleep(5)",
  ].join("\n");
  try {
    app.show("shell");
    const tracked = app.startShell("tracked", false, import.meta.dir, [
      "/usr/bin/python3",
      "-c",
      script,
    ])!;
    const deadline = Date.now() + 3000;
    while (
      !tracked.terminal.screen().text.includes("TRACKED") &&
      Date.now() < deadline
    ) {
      await Bun.sleep(20);
      await t.renderOnce();
    }
    expect(tracked.adapter.mouseTracking).toBe(true);
    const term = tracked.terminal;
    // The drag reaches the program as mouse reports; the app starts no selection of its own.
    await t.mockMouse.drag(term.x, term.y, term.x + 10, term.y);
    await Bun.sleep(20);
    expect(t.renderer.getSelection()?.getSelectedText() ?? "").toBe("");
    expect(copied).toEqual([]);
    // The program copies its own selection with OSC 52: it reaches this Mac's clipboard.
    tracked.adapter.write("x\r");
    const until = Date.now() + 3000;
    while (!copied.length && Date.now() < until) {
      await Bun.sleep(20);
      await t.renderOnce();
    }
    expect(copied).toEqual(["from the program"]);
    // Cmd+C copies the last copied text again.
    t.mockInput.pressKey("c", { super: true });
    expect(copied).toEqual(["from the program", "from the program"]);
  } finally {
    const exits = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.race([Promise.all(exits), Bun.sleep(3000)]);
  }
}, 20000);

test("a link that a program asks for opens after a click or key in its view; otherwise the footer offers it", async () => {
  const t = await createTestRenderer({ width: 120, height: 30 });
  const opened: string[] = [];
  const app = new App(t.renderer, {
    spawn: false,
    openLink: (url) => opened.push(url),
  });
  const request = (url: string) =>
    `os.write(1, b'\\x1b]7717;open;${Buffer.from(url).toString("base64")}\\x07')`;
  const script = (wait: boolean, url: string) =>
    [
      "import os, sys, time",
      "os.write(1, b'READY')",
      ...(wait ? ["sys.stdin.buffer.raw.read(1)"] : ["time.sleep(0.2)"]),
      request(url),
      "time.sleep(5)",
    ].join("\n");
  const footer = () => t.captureCharFrame().split("\n").at(-2)!;
  const until = async (done: () => boolean) => {
    const deadline = Date.now() + 3000;
    while (!done() && Date.now() < deadline) {
      await Bun.sleep(20);
      await t.renderOnce();
    }
  };
  try {
    app.show("shell");
    // The owner clicks the link: the program reads the click and asks to open it.
    const clicked = app.startShell("clicked", false, import.meta.dir, [
      "/usr/bin/python3",
      "-c",
      script(true, "https://github.com/openai/codex/releases/latest"),
    ])!;
    await until(() => clicked.terminal.screen().text.includes("READY"));
    clicked.terminal.onData!(Buffer.from("x\r"), "input");
    await until(() => opened.length > 0);
    expect(opened).toEqual(["https://github.com/openai/codex/releases/latest"]);
    expect(footer()).toContain(
      "opened github.com/openai/codex/releases/latest in your browser",
    );
    // A request without the owner's input opens nothing; the footer offers open and copy.
    app.startShell("alone", false, import.meta.dir, [
      "/usr/bin/python3",
      "-c",
      script(false, "https://example.com/page"),
    ]);
    await until(() => footer().includes("asked to open"));
    expect(footer()).toMatch(
      /alone asked to open example\.com\/page · open · copy/,
    );
    expect(opened).toHaveLength(1);
    const line = t.captureCharFrame().split("\n").length - 2;
    const x = footer().indexOf("· open") + 2;
    await t.mockMouse.click(x, line);
    expect(opened).toEqual([
      "https://github.com/openai/codex/releases/latest",
      "https://example.com/page",
    ]);
    // Only web links: a file link is dropped.
    app.programOpened("file:///etc/passwd", app.shells[0]);
    expect(opened).toHaveLength(2);
  } finally {
    const exits = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.race([Promise.all(exits), Bun.sleep(3000)]);
  }
}, 20000);

test("the connection card times the Session Manager endpoint of the region in host.env", () => {
  const dir = mkdtempSync(join(tmpdir(), "tokiwa-host-"));
  const file = join(dir, "host.env");
  writeFileSync(file, "# host\ninstance=i-0123456789abcdef0\nregion=eu-west-2\n");
  expect(awsEndpoint(file).host).toBe("ssm.eu-west-2.amazonaws.com");
  writeFileSync(file, "region=not a region\n");
  expect(awsEndpoint(file).host).toBe("ssm.us-east-1.amazonaws.com");
  expect(awsEndpoint(join(dir, "missing")).host).toBe("ssm.us-east-1.amazonaws.com");
});
