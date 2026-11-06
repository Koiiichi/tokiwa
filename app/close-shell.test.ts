import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { foregroundProgram } from "./pty";

const pause = (ms = 60) => Bun.sleep(ms);
async function open() {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false });
  let quit = 0;
  app.close = () => void quit++;
  const shell = app.startShell("shell-1", false, "/tmp")!;
  const finish = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  /** Run a program in the shell and wait until it has the terminal. */
  const run = async (command: string, name: string) => {
    await pause(150);
    shell.adapter.write(`${command}\r`);
    for (let i = 0; i < 100 && foregroundProgram(shell.child.pid) !== name; i++)
      await pause(20);
    expect(foregroundProgram(shell.child.pid)).toBe(name);
  };
  const list = async () => {
    app.focusSessions();
    await t.renderOnce();
  };
  return { t, app, shell, finish, run, list, quits: () => quit };
}

test("an idle shell has no foreground program", async () => {
  const { shell, finish } = await open();
  try {
    await pause(150);
    expect(foregroundProgram(shell.child.pid)).toBeUndefined();
  } finally {
    await finish();
  }
});

test("x closes an idle local shell at once", async () => {
  const { t, app, shell, finish, list } = await open();
  const ended = shell.child.exited;
  try {
    await pause(150);
    await list();
    await t.mockInput.typeText("x");
    await pause();
    expect(app.shells).toEqual([]);
    expect(await ended).toBeDefined();
  } finally {
    await finish();
  }
});

test("the row and the footer offer the close", async () => {
  const { t, app, finish, list } = await open();
  try {
    await list();
    expect(t.captureCharFrame()).toContain("x close");
    expect(app.rowClose.has("shell-1")).toBe(true);
  } finally {
    await finish();
  }
});

test("x asks first while a program runs, and esc keeps the shell", async () => {
  const { t, app, finish, run, list } = await open();
  try {
    await run("sleep 30", "sleep");
    await list();
    await t.mockInput.typeText("x");
    await pause();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("close? sleep is still running");
    expect(frame).toContain("enter closes");
    expect(app.shells).toHaveLength(1);
    t.mockInput.pressEscape();
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("still running");
    expect(app.shells).toHaveLength(1);
  } finally {
    await finish();
  }
});

test("enter closes a shell with a running program", async () => {
  const { t, app, shell, finish, run, list } = await open();
  const ended = shell.child.exited;
  try {
    await run("sleep 30", "sleep");
    await list();
    await t.mockInput.typeText("x");
    await pause();
    t.mockInput.pressEnter();
    await pause();
    expect(app.shells).toEqual([]);
    expect(await ended).toBeDefined();
  } finally {
    await finish();
  }
});

test("a shell that exited closes without a question", async () => {
  const { t, app, shell, finish, list } = await open();
  try {
    await pause(150);
    shell.adapter.write("exit\r");
    await shell.child.exited;
    await pause();
    await list();
    await t.mockInput.typeText("x");
    await pause();
    expect(app.shells).toEqual([]);
  } finally {
    await finish();
  }
});

test("q quits at once when no program runs", async () => {
  const { t, finish, list, quits } = await open();
  try {
    await pause(150);
    await list();
    await t.mockInput.typeText("q");
    await pause();
    expect(quits()).toBe(1);
  } finally {
    await finish();
  }
});

test("q asks first while a program runs", async () => {
  const { t, finish, run, list, quits } = await open();
  try {
    await run("sleep 30", "sleep");
    await list();
    await t.mockInput.typeText("q");
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("quit? sleep is still running");
    expect(quits()).toBe(0);
    t.mockInput.pressEscape();
    await pause();
    expect(quits()).toBe(0);
    await t.mockInput.typeText("q");
    await pause();
    t.mockInput.pressEnter();
    await pause();
    expect(quits()).toBe(1);
  } finally {
    await finish();
  }
});
