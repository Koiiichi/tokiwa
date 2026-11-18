import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { App } from "./app";
import { BackendClient } from "./backend";
import { landingSessions } from "./landing-fixture";
import { fixtureSample, fixtureSpend } from "./health-fixture";

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

test("an expired sign-in offers the sign-in key in the band, the list, the pane and the footer", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ AWS sign-in expired");
    expect(frame).toContain("l sign in · e details");
    expect(frame).toContain("l signs in");
    expect(frame).toContain("l signs in · t opens a local shell");
    expect(frame).not.toContain("Sessions not available");
  } finally {
    await close(t, app);
  }
});

test("another read failure keeps its message, and the sign-in key does nothing", async () => {
  const { t, app } = await open("Launcher --snapshot exited 255: timeout");
  try {
    expect(t.captureCharFrame()).toContain("▲ Sessions read failed: timeout");
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
    await until(() => app.shells.length === 0 && !app.sources.sessions.failure);
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
    expect(t.captureCharFrame()).toContain("▲ AWS sign-in expired");
    expect(t.captureCharFrame()).toContain("l sign in · e details");
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
    expect(t.captureCharFrame()).not.toContain("sign-in expired");
    state.message = EXPIRED;
    await app.refreshSessions();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ AWS sign-in expired");
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

/** An app with Health and spend that the test can fail, hold and count. */
async function openWithHealth() {
  const t = await createTestRenderer({ width: 100, height: 30 });
  const state = {
    message: undefined as string | undefined,
    hold: undefined as Promise<void> | undefined,
    commands: [] as string[][],
    spends: 0,
  };
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    state.commands.push(args);
    if (state.message) throw new Error(state.message);
    if (args[0] === "health") {
      await state.hold;
      return JSON.stringify({ ...fixtureSample, sampled_at: Date.now() / 1000 });
    }
    return JSON.stringify({ sessions: landingSessions });
  });
  backend.loginCommand = () => ["/bin/sh", "-c", "exit 0"];
  backend.spend = async () => {
    state.spends++;
    if (state.message) throw new Error(state.message);
    return fixtureSpend;
  };
  const app = new App(t.renderer, { backend });
  await pause();
  await app.sampleHealth();
  clearTimeout(app.sampleTimer);
  await t.renderOnce();
  return { t, app, state };
}

test("after a sign-in, every source is read again and each stays last known until it succeeds", async () => {
  const { t, app, state } = await openWithHealth();
  try {
    await pause(5);
    state.message = EXPIRED;
    // The spend read is due, so that it fails with the others and is `last known`.
    app.spendAt = 0;
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.currentError()?.kind).toBe("signed-out");
    state.message = undefined;
    let release = () => {};
    state.hold = new Promise<void>((resolve) => (release = resolve));
    const spends = state.spends;
    await t.mockInput.typeText("l");
    await until(() => !app.currentError());
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("sign-in expired");
    const now = app.now();
    expect(app.sources.sessions.freshness(now)).toBe("live");
    expect(app.sources.health.freshness(now)).toBe("last-known");
    release();
    await until(() => app.sources.health.freshness(app.now()) === "live");
    await until(() => state.spends > spends);
    clearTimeout(app.sampleTimer);
  } finally {
    await close(t, app);
  }
});

test("a recovery clears a notice about the cause", async () => {
  const { t, app, state } = await openWithHealth();
  try {
    await pause(5);
    state.message = EXPIRED;
    await app.refreshSessions();
    await app.attachRemote("worker-c");
    expect(app.footerNotice?.text).toContain("AWS sign-in expired");
    state.message = undefined;
    await t.mockInput.typeText("l");
    await until(() => !!app.footerNotice === false);
    expect(app.footerNotice).toBeUndefined();
    clearTimeout(app.sampleTimer);
  } finally {
    await close(t, app);
  }
});

/** The cell of `text` in the frame: its column and its row. */
function cell(frame: string, text: string) {
  const rows = frame.split("\n");
  const y = rows.findIndex((row) => row.includes(text));
  expect(y).toBeGreaterThanOrEqual(0);
  return { x: rows[y].indexOf(text), y };
}

test("a click on the sign-in hint of the band signs in while a terminal view has the focus", async () => {
  const { t, app } = await open(EXPIRED, "sleep 0.3");
  try {
    app.startShell("shell-0");
    app.focusPaneOf("shell-0");
    await pause();
    await t.renderOnce();
    expect(app.shells[0].terminal.focused).toBe(true);
    const at = cell(t.captureCharFrame(), "l sign in · e details");
    await t.mockMouse.click(at.x + 2, at.y);
    await pause();
    expect(app.shells.map((s) => s.name)).toContain("aws-sign-in");
  } finally {
    await close(t, app);
  }
});

test("a click on the details hint of the band opens the details and does not sign in", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const frame = t.captureCharFrame();
    const at = cell(frame, "e details");
    await t.mockMouse.click(at.x + 2, at.y);
    await pause();
    await t.renderOnce();
    expect(app.detailsOpen).toBe(true);
    expect(app.shells).toHaveLength(0);
  } finally {
    await close(t, app);
  }
});

test("a click on the sign-in hint closes the shortcuts sheet, so the sign-in view shows", async () => {
  const { t, app } = await open(EXPIRED, "sleep 0.3");
  try {
    app.openSheet();
    await t.renderOnce();
    const at = cell(t.captureCharFrame(), "l sign in · e details");
    await t.mockMouse.click(at.x + 2, at.y);
    await pause();
    expect(app.sheetOpen).toBe(false);
    expect(app.shells.map((s) => s.name)).toContain("aws-sign-in");
  } finally {
    await close(t, app);
  }
});
