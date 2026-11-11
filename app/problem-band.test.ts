import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { readFileSync } from "node:fs";
import { App } from "./app";
import { BackendClient } from "./backend";
import { fixtureSpend } from "./health-fixture";
import { fixtureSample } from "./health-fixture";
import { landingSessions } from "./landing-fixture";

const NOISE =
  "shell-init: error retrieving current directory: getcwd: cannot access parent directories: No such file or directory\n";
const EXPIRED =
  "Launcher --snapshot exited 1: " +
  NOISE +
  "Tokiwa: AWS authentication failed. Run aws sso login --profile work.";
const pause = (ms = 60) => Bun.sleep(ms);

async function open(message: string | undefined, login = "exit 0") {
  const t = await createTestRenderer({ width: 110, height: 32 });
  const state = { message, commands: [] as string[][] };
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    state.commands.push(args);
    if (state.message) throw new Error(state.message);
    if (args[0] === "health")
      return JSON.stringify({
        ...fixtureSample,
        sampled_at: Date.now() / 1000,
      });
    return JSON.stringify({ sessions: landingSessions });
  });
  backend.loginCommand = () => ["/bin/sh", "-c", login];
  backend.spend = async () => fixtureSpend;
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
const headerLine = (frame: string) => frame.split("\n")[0];

test("a failed read shows one band under the header, with the cause and its key, and no raw text", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const frame = t.captureCharFrame();
    const lines = frame.split("\n");
    // The header, its rule, then the band.
    expect(lines[2]).toContain("▲ AWS sign-in expired");
    expect(lines[2]).toContain("l sign in · e details");
    expect(frame).not.toContain("getcwd");
    expect(frame).not.toContain("Tokiwa: AWS authentication failed");
    expect(frame).not.toContain("Last read failed");
    expect(frame).not.toContain("Sessions not available");
  } finally {
    await close(t, app);
  }
});

test("e opens the raw output under the band and closes it again", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    await t.mockInput.typeText("e");
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Tokiwa: AWS authentication failed");
    expect(t.captureCharFrame()).toContain("e hides details");
    await t.mockInput.typeText("e");
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain(
      "Tokiwa: AWS authentication failed",
    );
  } finally {
    await close(t, app);
  }
});

test("the header shows the link as a dot: hollow when signed out, full when connected", async () => {
  const { t, app, state } = await open(EXPIRED, "sleep 0.2");
  try {
    // The app reads Health at its start; that read fails too.
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    const before = state.commands.filter((c) => c[0] === "health").length;
    await t.renderOnce();
    expect(headerLine(t.captureCharFrame())).toContain("○ EC2 · signed out");
    expect(headerLine(t.captureCharFrame())).not.toContain("→");
    await t.mockInput.typeText("l");
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("Signing in… finish in the browser");
    state.message = undefined;
    await until(() => app.shells.length === 0 && !app.sessionsError);
    // The readings resume by themselves: Health is read again after the sign-in.
    await until(
      () => state.commands.filter((c) => c[0] === "health").length > before,
    );
    await until(() => !app.history.gap);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(headerLine(frame)).toContain("● EC2");
    expect(frame).not.toContain("▲");
  } finally {
    await close(t, app);
  }
});

test("another failure names its first meaningful line and offers a retry", async () => {
  const { t, app } = await open(
    "Launcher --snapshot exited 255: " + NOISE + "ssh: unexpected reply",
  );
  try {
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ ssh: unexpected reply");
    expect(frame).toContain("u retry · e details");
    expect(headerLine(frame)).toContain("○ EC2 · offline");
    // The sign-in key does nothing when the sign-in is not the cause.
    await t.mockInput.typeText("l");
    await pause();
    expect(app.shells).toHaveLength(0);
  } finally {
    await close(t, app);
  }
});

test("a failed Health read keeps the last readings, marks them stale and shows no raw text", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    state.message =
      "Launcher health exited 1: " +
      NOISE +
      "Tokiwa: AWS authentication failed.";
    clearTimeout(app.sampleTimer);
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.show("health");
    await pause();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ AWS sign-in expired");
    expect(frame).toContain("· stale");
    expect(frame).not.toContain("Last read failed");
    expect(frame).not.toContain("getcwd");
    expect(frame).toContain("Workstation");
  } finally {
    await close(t, app);
  }
});

test("Health names this Mac, which left the header", async () => {
  const { t, app } = await open(undefined);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.show("health");
    await pause();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain(`Workstation · from ${app.device}`);
  } finally {
    await close(t, app);
  }
});

test("each new failure is written to the error log with its raw output", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const log = readFileSync(process.env.TOKIWA_ERROR_LOG!, "utf8");
    expect(log).toContain("Tokiwa: AWS authentication failed");
    expect(log).toContain("getcwd");
  } finally {
    await close(t, app);
  }
});

test("a read that succeeds after an expired sign-in starts the other read at once", async () => {
  const { t, app, state } = await open(EXPIRED);
  try {
    expect(app.sessionsError).not.toBe("");
    const reads = state.commands.length;
    state.message = undefined;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    // The Health read proves the sign-in works, so the session read does not wait 30 seconds.
    await until(() => !app.sessionsError && state.commands.length > reads + 1);
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("▲");
  } finally {
    await close(t, app);
  }
});

test("the details show one copy of a failure that both reads report", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.toggleDetails();
    await pause();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame.split("Tokiwa: AWS authentication failed").length - 1).toBe(1);
  } finally {
    await close(t, app);
  }
});
