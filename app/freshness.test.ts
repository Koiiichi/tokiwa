import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { App } from "./app";
import { BackendClient } from "./backend";
import { fixtureSample, fixtureSpend } from "./health-fixture";
import { landingPrevious, landingSessions } from "./landing-fixture";
import { SourceStatus } from "./state";
import type { Failure } from "./problem";

const pause = (ms = 80) => Bun.sleep(ms);
const AUTH =
  "Launcher --snapshot exited 1: Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";
const failure = (at: number): Failure => ({
  source: "sessions",
  kind: "signed-out",
  title: "AWS sign-in expired",
  summary: "",
  explanation: "",
  command: "--snapshot",
  code: 1,
  detail: "",
  raw: "",
  at,
});

/** An app after two good session reads at 10 s and 20 s. The clock and the runner are test-controlled. */
async function open(options: { receipt?: string } = {}) {
  const t = await createTestRenderer({ width: 120, height: 30 });
  const clock = { at: 10_000 };
  const mode = { fail: false, sessions: landingSessions };
  const reads = [landingPrevious];
  const backend = new BackendClient("/fixture/tokiwa", async () => {
    if (mode.fail) throw new Error(AUTH);
    return JSON.stringify({ sessions: reads.shift() ?? mode.sessions });
  });
  backend.attachCommand = () => ["/bin/sleep", "30"];
  backend.spend = async () => {
    if (mode.fail) throw new Error(AUTH);
    return fixtureSpend;
  };
  const app = new App(t.renderer, {
    backend,
    spawn: false,
    now: () => clock.at,
    ...options,
  });
  await app.refreshSessions();
  clock.at = 20_000;
  await app.refreshSessions();
  const close = async () => {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  };
  return { t, app, clock, mode, backend, close };
}
const state = (app: App, name: string) => {
  const row = app.sessionRows().find((r) => r.name === name)!;
  return app.rowStatus(row).state;
};

test("a source is unavailable before its first success, live after it, and last known after a failure or the limit", () => {
  const s = new SourceStatus(90_000);
  expect(s.freshness(0)).toBe("unavailable");
  s.succeed(1000);
  expect(s.freshness(2000)).toBe("live");
  expect(s.freshness(92_000)).toBe("last-known");
  s.fail(failure(3000));
  expect(s.freshness(3500)).toBe("last-known");
  expect(s.failure?.at).toBe(3000);
  s.succeed(4000);
  expect(s.freshness(4500)).toBe("live");
  expect(s.failure).toBeUndefined();
  // A source that never succeeded stays unavailable after a failure.
  const never = new SourceStatus(90_000);
  never.fail(failure(5));
  expect(never.freshness(6)).toBe("unavailable");
});

test("snapshot rows carry their freshness and read time", async () => {
  const w = await open();
  try {
    for (const row of w.app.sessionRows().filter((r) => r.ref)) {
      expect(row.freshness).toBe("live");
      expect(row.readAt).toBe(20_000);
    }
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    const rows = w.app.sessionRows().filter((r) => r.ref);
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) {
      expect(row.freshness).toBe("last-known");
      expect(row.readAt).toBe(20_000);
    }
  } finally {
    await w.close();
  }
});

test("a stale snapshot row has no activity, but a bell stays", async () => {
  const w = await open();
  try {
    expect(state(w.app, "web-lead")).toBe("output");
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    expect(state(w.app, "web-lead")).toBe("unknown");
    expect(state(w.app, "claude-test")).toBe("unknown");
    expect(state(w.app, "coder-lead")).toBe("needs-you");
  } finally {
    await w.close();
  }
});

test("a row with a connected view keeps its own activity while the snapshot is stale", async () => {
  const w = await open();
  try {
    w.backend.attachCommand = () => [
      "/bin/sh",
      "-c",
      "echo output; sleep 30",
    ];
    w.app.focusSessions();
    w.app.listSelection = w.app
      .sessionRows()
      .findIndex((r) => r.name === "claude-test");
    w.t.mockInput.pressEnter();
    for (let i = 0; i < 50 && w.app.remotePending.size === 0; i++) await pause(5);
    for (let i = 0; i < 50 && w.app.remotePending.size; i++) await pause(20);
    await pause(300);
    expect(w.app.shells.length).toBe(1);
    // The transport itself reports output, with no help from the snapshot.
    expect(
      w.app.rowActivity(
        w.app.sessionRows().find((r) => r.name === "claude-test")!,
      ),
    ).not.toBe("unknown");
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    const own = w.app.rowActivity(
      w.app.sessionRows().find((r) => r.name === "claude-test")!,
    );
    expect(own).not.toBe("unknown");
    expect(state(w.app, "claude-test")).not.toBe("unknown");
    expect(state(w.app, "web-lead")).toBe("unknown");
    expect(state(w.app, "setup")).toBe("unknown");
  } finally {
    await w.close();
  }
});

test("the first live read after a stale period shows no output glyph", async () => {
  const w = await open();
  try {
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    w.mode.fail = false;
    w.clock.at = 40_000;
    await w.app.refreshSessions();
    // The screens changed since the last good read, but the app dropped that reading.
    expect(w.app.sources.sessions.freshness(40_000)).toBe("live");
    expect(state(w.app, "web-lead")).toBe("unknown");
    expect(state(w.app, "claude-test")).toBe("unknown");
    // The second read shows output again.
    w.mode.sessions = landingPrevious;
    w.clock.at = 45_000;
    await w.app.refreshSessions();
    expect(state(w.app, "web-lead")).toBe("output");
  } finally {
    await w.close();
  }
});

/** Delays of the timers that the session read sets, with one read per step of the script. */
async function timerDelays(script: Array<{ at: number; fail: boolean }>) {
  const t = await createTestRenderer({ width: 120, height: 30 });
  const clock = { at: 10_000 };
  const mode = { fail: false };
  const backend = new BackendClient("/fixture/tokiwa", async () => {
    if (mode.fail) throw new Error(AUTH);
    return JSON.stringify({ sessions: landingSessions });
  });
  // The app starts its own timers: wait until its start-up read is done, then take them over.
  const app = new App(t.renderer, { backend, now: () => clock.at });
  const real = globalThis.setTimeout;
  const delays: number[] = [];
  const freshness: string[] = [];
  try {
    for (let i = 0; i < 100 && !app.sessionsRead; i++) await pause(20);
    expect(app.sessionsRead).toBe(true);
    clearTimeout(app.sessionTimer);
    globalThis.setTimeout = ((fn: () => void, ms?: number) => {
      if (ms === 5000 || ms === 30_000) delays.push(ms);
      return real(fn, ms);
    }) as typeof setTimeout;
    for (const step of script) {
      mode.fail = step.fail;
      clock.at = step.at;
      freshness.push(app.sources.sessions.freshness(clock.at));
      await app.refreshSessions();
      clearTimeout(app.sessionTimer);
    }
    return { delays, freshness };
  } finally {
    globalThis.setTimeout = real;
    clearTimeout(app.sessionTimer);
    await t.dispose();
  }
}

test("the read after a good read that follows a stale period is scheduled 5 s later", async () => {
  const { delays, freshness } = await timerDelays([
    { at: 20_000, fail: false },
    { at: 30_000, fail: true },
    { at: 40_000, fail: false },
  ]);
  // Before the recovery read the source is last known; only that read uses 5 s.
  expect(freshness[2]).toBe("last-known");
  expect(delays.at(-1)).toBe(5000);
});

test("failed reads during an outage are scheduled every 30 s", async () => {
  const { delays } = await timerDelays([
    { at: 20_000, fail: false },
    { at: 30_000, fail: true },
    { at: 35_000, fail: true },
    { at: 40_000, fail: true },
  ]);
  expect(delays.slice(1)).toEqual([30_000, 30_000, 30_000]);
});

test("a rejected Health sample leaves the last good read time unchanged", async () => {
  const w = await open();
  try {
    w.app.backend.health = async () => ({
      ...fixtureSample,
      sampled_at: Date.now() / 1000,
    });
    await w.app.sampleHealth();
    clearTimeout(w.app.sampleTimer);
    expect(w.app.sources.health.okAt).toBe(20_000);
    w.clock.at = 50_000;
    w.app.backend.health = async () => ({ ...fixtureSample, sampled_at: 1 });
    await w.app.sampleHealth();
    clearTimeout(w.app.sampleTimer);
    expect(w.app.sources.health.okAt).toBe(20_000);
    expect(w.app.sources.health.failure?.detail).toContain("stale");
    expect(w.app.sources.health.freshness(50_000)).toBe("last-known");
  } finally {
    await w.close();
  }
});

test("a failed spend read keeps the last reading", async () => {
  const w = await open();
  try {
    w.app.spendAt = -1_000_000_000;
    await w.app.sampleHealth();
    clearTimeout(w.app.sampleTimer);
    expect(w.app.spend).toEqual(fixtureSpend);
    expect(w.app.sources.spend.freshness(w.clock.at)).toBe("live");
    w.mode.fail = true;
    w.app.spendAt = -1_000_000_000;
    w.clock.at = 50_000;
    await w.app.sampleHealth();
    clearTimeout(w.app.sampleTimer);
    expect(w.app.spend).toEqual(fixtureSpend);
    expect(w.app.spendError).not.toBe("");
    expect(w.app.sources.spend.freshness(w.clock.at)).toBe("last-known");
  } finally {
    await w.close();
  }
});

test("receipt events carry freshness and read time", async () => {
  const receipt = join(mkdtempSync(join(tmpdir(), "tokiwa-")), "receipt.json");
  const w = await open({ receipt });
  try {
    const read = () =>
      JSON.parse(readFileSync(receipt, "utf8")) as Array<
        Record<string, unknown>
      >;
    const good = read().filter((e) => e.event === "remote-sessions-refreshed");
    expect(good.at(-1)?.freshness).toBe("live");
    expect(good.at(-1)?.read_at).toBe(20);
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    const failed = read().filter((e) => e.event === "remote-sessions-error");
    expect(failed.at(-1)?.freshness).toBe("last-known");
    expect(failed.at(-1)?.read_at).toBe(20);
    await w.app.sampleHealth();
    clearTimeout(w.app.sampleTimer);
    const health = read().filter((e) => e.event === "health-sample");
    expect(health.at(-1)).toHaveProperty("freshness");
    expect(health.at(-1)).toHaveProperty("read_at");
  } finally {
    await w.close();
  }
});

test("stale project titles say last known", async () => {
  const w = await open();
  try {
    w.app.show("shell");
    const frame = async () => {
      await w.t.renderOnce();
      return w.t.captureCharFrame();
    };
    expect(await frame()).not.toContain("· last known");
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    expect(await frame()).toContain("workspaces/workbench · last known");
    w.mode.fail = false;
    w.clock.at = 40_000;
    await w.app.refreshSessions();
    expect(await frame()).not.toContain("workspaces/workbench · last known");
  } finally {
    await w.close();
  }
});

test("only a project with snapshot rows says last known, not a local group", async () => {
  const w = await open();
  try {
    w.app.show("shell");
    await w.t.mockInput.typeText("t");
    await pause();
    expect(w.app.shells.filter((s) => !s.remote)).toHaveLength(1);
    w.mode.fail = true;
    w.clock.at = 30_000;
    await w.app.refreshSessions();
    await w.t.renderOnce();
    const frame = w.t.captureCharFrame();
    const local = w.app
      .sessionTree()
      .find((e) => e.kind === "project" && e.path === "")!;
    expect(local.kind === "project" && frame).toContain(
      local.kind === "project" ? local.title : "",
    );
    expect(frame).toContain("workspaces/workbench · last known");
    expect(frame).not.toContain(
      `${local.kind === "project" ? local.title : ""} · last known`,
    );
  } finally {
    await w.close();
  }
});
