import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";

const pause = (ms = 80) => Bun.sleep(ms);

async function open() {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  app.close = () => {};
  const shell = app.startShell("shell-1", false, "/tmp")!;
  app.returnToTerminal();
  await t.renderOnce();
  const key = async (name: string, ctrl = false) => {
    t.mockInput.pressKey(name, ctrl ? { ctrl: true } : undefined);
    await pause();
    await t.renderOnce();
  };
  /** Open Health from a terminal that has the keyboard (the search) or from the list (h). */
  const openHealth = async () => {
    if (app.listHasFocus()) await key("h");
    else {
      await key("k", true);
      await t.mockInput.typeText("health");
      await pause();
      t.mockInput.pressEnter();
      await pause();
      await t.renderOnce();
    }
    expect(app.view).toBe("health");
  };
  const finish = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  return { t, app, shell, key, openHealth, finish };
}

test("w from Health returns to the terminal that had the keyboard", async () => {
  const { app, shell, key, openHealth, finish } = await open();
  try {
    expect(app.listHasFocus()).toBe(false);
    await openHealth();
    await key("w");
    expect(app.view).toBe("shell");
    expect(app.listHasFocus()).toBe(false);
    expect(shell.terminal.focused).toBe(true);
  } finally {
    await finish();
  }
});

test("w from Health keeps focus mode", async () => {
  const { app, shell, key, openHealth, finish } = await open();
  try {
    app.toggleFocus();
    await pause();
    expect(app.focusMode).toBe(true);
    expect(app.listHasFocus()).toBe(false);
    await openHealth();
    await key("w");
    expect(app.focusMode).toBe(true);
    expect(app.view).toBe("shell");
    expect(app.listHasFocus()).toBe(false);
    expect(shell.terminal.focused).toBe(true);
  } finally {
    await finish();
  }
});

test("w from Health returns to the list when the list had the keyboard", async () => {
  const { app, key, openHealth, finish } = await open();
  try {
    app.focusSessions();
    await pause();
    expect(app.listHasFocus()).toBe(true);
    await openHealth();
    await key("w");
    expect(app.view).toBe("shell");
    expect(app.listHasFocus()).toBe(true);
  } finally {
    await finish();
  }
});

test("w from Health goes to the list when the terminal exited meanwhile", async () => {
  const { app, shell, key, openHealth, finish } = await open();
  try {
    await openHealth();
    shell.exited = true;
    await key("w");
    expect(app.view).toBe("shell");
    expect(app.listHasFocus()).toBe(true);
  } finally {
    await finish();
  }
});

test("a second w after the return reaches the list", async () => {
  const { app, key, openHealth, finish } = await open();
  try {
    await openHealth();
    await key("w");
    expect(app.listHasFocus()).toBe(false);
    await key("k", true);
    await key("w");
    expect(app.listHasFocus()).toBe(true);
  } finally {
    await finish();
  }
});

test("clicks on Health and then Workspace return to the focused terminal in focus mode", async () => {
  const { t, app, shell, finish } = await open();
  try {
    app.toggleFocus();
    await pause();
    expect(app.listHasFocus()).toBe(false);
    const nav = (label: string) => {
      const lines = t.captureCharFrame().split("\n");
      const y = lines.findIndex((l) => /Workspace +Health/.test(l));
      return { x: lines[y].indexOf(label) + 1, y };
    };
    const click = async (label: string) => {
      const at = nav(label);
      await t.mockMouse.click(at.x, at.y);
      await pause();
      await t.renderOnce();
    };
    await click("Health");
    expect(app.view).toBe("health");
    await click("Workspace");
    expect(app.view).toBe("shell");
    expect(app.focusMode).toBe(true);
    expect(app.listHasFocus()).toBe(false);
    expect(shell.terminal.focused).toBe(true);
    // In the workspace, a click on Workspace still gives the keyboard to the list.
    await click("Workspace");
    expect(app.listHasFocus()).toBe(true);
  } finally {
    await finish();
  }
});
