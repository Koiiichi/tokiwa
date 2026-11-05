import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";
import { landingSessions } from "./landing-fixture";

const EXPIRED =
  "Launcher --snapshot exited 1: Tokiwa: AWS authentication failed. Run aws sso login --profile work.";
const pause = (ms = 60) => Bun.sleep(ms);

async function open(message: string | undefined, login = "exit 0") {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const state = { message, commands: [] as string[][] };
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    state.commands.push(args);
    if (state.message) throw new Error(state.message);
    return JSON.stringify({ sessions: landingSessions });
  });
  backend.loginCommand = () => ["/bin/sh", "-c", login];
  const app = new App(t.renderer, { backend });
  await pause();
  await t.renderOnce();
  return { t, app, state };
}
async function until(check: () => boolean) {
  for (let i = 0; i < 100 && !check(); i++) await pause(20);
  expect(check()).toBe(true);
}
async function close(t: { dispose(): Promise<void> | void }, app: App) {
  const children = app.shells.map((s) => s.child.exited);
  await t.dispose();
  await Promise.all(children);
}

test("an expired sign-in offers the sign-in key in the list, the pane and the footer", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const frame = t.captureCharFrame();
    expect(frame).toContain("AWS sign-in expired");
    expect(frame).toContain("l signs in");
    expect(frame).toContain("u reads them again");
    expect(frame).toContain("l signs in · t opens a local shell");
    expect(frame).toContain("sign in");
    expect(frame).not.toContain("Sessions not available");
  } finally {
    await close(t, app);
  }
});

test("another read failure keeps its message, and the sign-in key does nothing", async () => {
  const { t, app } = await open("Launcher --snapshot exited 255: timeout");
  try {
    expect(t.captureCharFrame()).toContain("Sessions not available");
    await t.mockInput.typeText("l");
    await pause();
    expect(app.shells).toHaveLength(0);
  } finally {
    await close(t, app);
  }
});

test("the sign-in runs in a view that closes after success, and the sessions return", async () => {
  const { t, app, state } = await open(EXPIRED, "sleep 0.3");
  try {
    await t.mockInput.typeText("l");
    await pause();
    expect(app.shells.map((s) => s.name)).toEqual(["aws-sign-in"]);
    expect(app.shells[0].terminal.focused).toBe(true);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Signing in…");
    state.message = undefined;
    await until(() => app.shells.length === 0 && !app.sessionsError);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("web-lead");
    expect(frame).not.toContain("sign-in expired");
  } finally {
    await close(t, app);
  }
});

test("a failed sign-in keeps its view, and the key starts it again", async () => {
  const { t, app } = await open(EXPIRED, "echo denied; exit 1");
  try {
    await t.mockInput.typeText("l");
    await until(() => app.shells[0]?.exited === true);
    await pause();
    expect(app.shells).toHaveLength(1);
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("denied");
    expect(t.captureCharFrame()).toContain("Sign-in expired · l signs in");
    const first = app.shells[0];
    await t.mockInput.typeText("l");
    await pause();
    expect(app.shells).toHaveLength(1);
    expect(app.shells[0]).not.toBe(first);
  } finally {
    await close(t, app);
  }
});

test("a list that has sessions also offers the sign-in when a read expires", async () => {
  const { t, app, state } = await open(undefined);
  try {
    expect(t.captureCharFrame()).not.toContain("Sign-in expired");
    state.message = EXPIRED;
    await app.refreshSessions();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("Sign-in expired · l signs in");
    expect(frame).toContain("web-lead");
    expect(frame).not.toContain("Last read failed");
  } finally {
    await close(t, app);
  }
});

test("with four views open the sign-in asks to close one", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    for (let i = 0; i < 4; i++) app.startShell(`shell-${i}`, false);
    await app.focusSessions();
    await t.mockInput.typeText("l");
    await pause();
    await t.renderOnce();
    expect(app.shells).toHaveLength(4);
    expect(t.captureCharFrame()).toContain("Close a terminal view");
  } finally {
    await close(t, app);
  }
});
