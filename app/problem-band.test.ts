import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { readFileSync } from "node:fs";
import { RGBA } from "@opentui/core";
import { App, theme } from "./app";
import { BackendClient, LauncherError } from "./backend";
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

async function open(
  message: string | undefined,
  login = "exit 0",
  now?: () => number,
) {
  const t = await createTestRenderer({ width: 110, height: 32 });
  const state = {
    message,
    /** A failure for one launcher call; it comes before `message`. */
    error: undefined as ((args: string[]) => Error | undefined) | undefined,
    commands: [] as string[][],
  };
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    state.commands.push(args);
    const error = state.error?.(args);
    if (error) throw error;
    if (state.message) throw new Error(state.message);
    if (args[0] === "health")
      return JSON.stringify({
        ...fixtureSample,
        sampled_at: Date.now() / 1000,
      });
    return JSON.stringify({ sessions: landingSessions });
  });
  backend.loginCommand = () => ["/bin/sh", "-c", login];
  // Spend reads through the launcher too: it fails when the link fails.
  backend.spend = async () => {
    const error = state.error?.(["spend"]);
    if (error) throw error;
    if (state.message) throw new Error(state.message);
    return fixtureSpend;
  };
  const app = new App(t.renderer, { backend, ...(now ? { now } : {}) });
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
const AUTH_TEXT =
  NOISE +
  "Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";
/** A launcher failure with the category line that a current launcher gives. */
const launcherFailure =
  (stderr: string, category?: "auth" | "unreachable") => (args: string[]) =>
    new LauncherError(
      `Launcher ${args[0]} exited 1: ${stderr}`,
      args[0],
      "exit",
      1,
      stderr,
      category,
    );
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
    await until(() => app.shells.length === 0 && !app.sources.sessions.failure);
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

test("another failure names its first meaningful line at the top of the list and offers a retry", async () => {
  const { t, app } = await open(
    "Launcher --snapshot exited 255: " + NOISE + "ssh: unexpected reply",
  );
  try {
    const frame = t.captureCharFrame();
    // The split list is narrow: the title wraps and the keys take the next line.
    expect(frame).toContain("▲ Sessions read failed: ssh:");
    expect(frame).toContain("unexpected reply");
    expect(frame).toContain("u retry · e details");
    // A component failure never changes the header.
    expect(headerLine(frame)).not.toContain("offline");
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
    // A failure counts only when it is later than the success, so the two must not share a millisecond.
    await pause(5);
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
    expect(frame).toContain("· last known");
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

test("each new failure is written to the error log with its source, command, exit code and raw message", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    const log = readFileSync(process.env.TOKIWA_ERROR_LOG!, "utf8");
    expect(log).toContain("Tokiwa: AWS authentication failed");
    expect(log).toContain("sessions signed-out command=--snapshot exit=1");
    expect(log).toContain("Launcher --snapshot exited 1:");
    expect(log).toContain("getcwd");
  } finally {
    await close(t, app);
  }
});

test("a read that succeeds after an expired sign-in starts the other read at once", async () => {
  const { t, app, state } = await open(EXPIRED);
  try {
    expect(app.sources.sessions.failure).toBeDefined();
    const reads = state.commands.length;
    state.message = undefined;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    // The Health read proves the sign-in works, so the session read does not wait 30 seconds.
    await until(
      () => !app.sources.sessions.failure && state.commands.length > reads + 1,
    );
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("▲");
  } finally {
    await close(t, app);
  }
});

test("the details show one copy of a failure that both reads report", async () => {
  const { t, app, state } = await open(undefined);
  try {
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.toggleDetails();
    await pause();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame.split("Tokiwa: AWS authentication failed").length - 1).toBe(1);
    expect(frame).toContain("sessions      --snapshot exit 1 · auth");
    expect(frame).toContain("health        health exit 1 · auth");
    expect(frame).toContain(
      "Recovery      l runs tokiwa login in a local view",
    );
    expect(frame).toContain("Last synced");
    expect(frame).toContain("Affected      Workspace, Health, Spend");
    expect(frame).not.toContain("Launcher");
    expect(frame).not.toContain("getcwd");
  } finally {
    await close(t, app);
  }
});

test("the band title has one period", async () => {
  const { t, app } = await open(undefined);
  try {
    app.readFailed(
      "sessions",
      new LauncherError(
        "The launcher exceeded 90 seconds.",
        "--snapshot",
        "timeout",
        null,
        "",
      ),
    );
    app.drawProblem();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ AWS cannot be reached from this Mac");
    expect(frame).not.toContain("this Mac.");
    expect(frame).not.toContain("..");
  } finally {
    await close(t, app);
  }
});

test("a failure with empty stderr still reads as a failed read", async () => {
  const { t, app } = await open("Launcher --snapshot exited 255: ");
  try {
    expect(app.sources.sessions.failure?.detail).toBe("");
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ Sessions read failed");
    expect(frame).toContain("No sessions read");
    expect(frame).not.toContain("No sessions on EC2");
  } finally {
    await close(t, app);
  }
});

test("a later, different Health failure replaces the earlier one", async () => {
  const { t, app, state } = await open(undefined);
  try {
    state.message = "Tokiwa: AWS authentication failed.";
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.sources.health.failure?.kind).toBe("signed-out");
    state.message = undefined;
    // A sample with an old timestamp is rejected by the history, outside the read.
    app.backend.health = async () => ({ ...fixtureSample, sampled_at: 1 });
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.sources.health.failure?.kind).toBe("failed");
    expect(app.sources.health.failure?.detail).toContain("stale");
  } finally {
    await close(t, app);
  }
});

test("a failed attach shows a notice, not an error in the navigation row", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    await app.attachRemote("worker-c");
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    const nav = lines.find((l) => l.startsWith("  Workspace  Health"))!;
    expect(nav.trim()).toBe("Workspace  Health");
    expect(lines.at(-1)! + lines.at(-2)!).toContain(
      "attach worker-c failed · AWS sign-in expired",
    );
    const frame = lines.join("\n");
    expect(frame).not.toContain("Launcher");
    expect(frame).not.toContain("Error:");
  } finally {
    await close(t, app);
  }
});

test("a failed read shows a two-row band with the age of the last good read", async () => {
  const start = new Date(2026, 10, 13, 21, 20).getTime();
  let clock = start;
  const { t, app, state } = await open(undefined, "exit 0", () => clock);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.sources.sessions.okAt).toBe(start);
    expect(app.sources.health.okAt).toBe(start);
    clock = start + 41 * 3600_000;
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    const lines = frame.split("\n");
    expect(lines[2]).toContain("▲ AWS sign-in expired");
    expect(lines[2].trimEnd().endsWith("l sign in · e details")).toBe(true);
    expect(lines[3].trim()).toBe(
      "Live status unavailable. Last synced Nov 13 21:20 · 41h ago.",
    );
    expect(headerLine(frame)).toContain("○ EC2 · signed out");
    expect(frame).not.toContain("Launcher");
    expect(frame).not.toContain("Error:");
    expect(frame).not.toContain("Tokiwa: AWS authentication failed");
  } finally {
    await close(t, app);
  }
});

test("a component failure leaves the header connected and shows no band", async () => {
  const { t, app, state } = await open(undefined);
  try {
    state.error = (args) =>
      args[0] === "health"
        ? new Error("The health response is invalid.")
        : undefined;
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    let lines = t.captureCharFrame().split("\n");
    expect(headerLine(lines.join("\n"))).toContain("● EC2");
    expect(lines.slice(2).some((l) => l.trimStart().startsWith("▲"))).toBe(
      false,
    );
    app.show("health");
    await pause();
    await t.renderOnce();
    lines = t.captureCharFrame().split("\n");
    const nav = lines.findIndex((l) => l.startsWith("  Workspace  Health"));
    const first = lines.slice(nav + 1).find((l) => l.trim())!;
    expect(first.trimStart()).toStartWith(
      "▲ Health read failed: the health response is invalid",
    );
    expect(first.trimEnd().endsWith("u retry · e details")).toBe(true);
    expect(headerLine(lines.join("\n"))).toContain("● EC2");
    expect(lines.at(-2)! + lines.at(-1)!).toContain("u retry · ");
  } finally {
    await close(t, app);
  }
});

test("a stopped workstation is a workstation state, not a link state", async () => {
  const { t, app } = await open(
    "The host is stopped. No restart was requested.",
  );
  try {
    const frame = t.captureCharFrame();
    expect(headerLine(frame)).toContain("○ EC2 · stopped");
    expect(frame.split("\n")[2]).toContain("▲ The workstation is stopped");
    expect(frame.split("\n")[3]).toContain("Start it in AWS, then press u.");
  } finally {
    await close(t, app);
  }
});

test("the footer offers u retry for an offline failure", async () => {
  const { t, app, state } = await open(undefined);
  try {
    state.error = (args) =>
      new LauncherError(
        "The launcher exceeded 90 seconds.",
        args[0],
        "timeout",
        null,
        "",
      );
    await app.refreshSessions();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(headerLine(frame)).toContain("○ EC2 · offline");
    const footer = frame
      .split("\n")
      .filter((l) => l.trim())
      .at(-1)!;
    expect(footer.trimStart()).toStartWith("u retry · ");
    expect(frame.split("\n")[3]).toContain("Showing the last known state from");
    expect(frame.split("\n")[3]).toContain("Retrying every 30 s.");
  } finally {
    await close(t, app);
  }
});

test("a setup failure uses the critical tone and offers no key", async () => {
  const { t, app, state } = await open(undefined);
  try {
    state.error = (args) =>
      new LauncherError(
        "Launcher could not start: spawn tokiwa ENOENT",
        args[0],
        "spawn",
        null,
        "spawn tokiwa ENOENT",
      );
    await app.refreshSessions();
    await t.renderOnce();
    const lines = t.captureCharFrame().split("\n");
    expect(lines[2]).toContain("▲ The launcher is not installed");
    expect(lines[2]).toContain("e details");
    expect(lines[2]).not.toContain("l sign in");
    expect(lines[2]).not.toContain("u retry");
    expect(lines[3]).toContain("Install it");
    expect(app.bandTitle.fg.toString()).not.toBe(
      RGBA.fromHex(theme.warning).toString(),
    );
  } finally {
    await close(t, app);
  }
});

test("while the confirm box shows a failure, the footer notice does not repeat it", async () => {
  const { t, app, state } = await open(undefined);
  try {
    const ref = app.remoteSessions[0];
    app.askOperation({ operation: "rename-session", ref });
    app.backend.renameSession = async () => {
      throw launcherFailure(AUTH_TEXT, "auth")(["rename"]);
    };
    await t.mockInput.typeText("renamed");
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.completeOperation();
    await pause();
    await t.renderOnce();
    expect(app.confirmStatus).toEqual({
      text: "rename worker-a failed · AWS sign-in expired".replace(
        "worker-a",
        ref.name,
      ),
      failed: true,
    });
    expect(app.footerNotice).toBeUndefined();
    // Another failed action still shows its notice.
    app.actionFailed("end project-a", new Error("The end did not work."));
    expect(app.footerNotice?.text).toBe("The end did not work.");
  } finally {
    await close(t, app);
  }
});
