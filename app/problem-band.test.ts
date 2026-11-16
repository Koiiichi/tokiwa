import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { readFileSync } from "node:fs";
import { RGBA } from "@opentui/core";
import { App, theme } from "./app";
import { BackendClient, LauncherError } from "./backend";
import { fixtureSpend } from "./health-fixture";
import { fixtureSample } from "./health-fixture";
import { landingSessions } from "./landing-fixture";
import type { ProblemKind } from "./problem";

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
  width = 110,
) {
  const t = await createTestRenderer({ width, height: 32 });
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
  const { t, app, state } = await open(undefined);
  try {
    // Sessions and Health fail with the stopped host; a spend read still works.
    state.error = (args) =>
      args[0] === "spend"
        ? undefined
        : new Error("The host is stopped. No restart was requested.");
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    // The Health sample already read spend; make sure that it did after the failures.
    await pause(5);
    app.sources.spend.succeed(app.now());
    app.drawHeader();
    await t.renderOnce();
    let frame = t.captureCharFrame();
    expect(app.sources.spend.okAt).toBeGreaterThan(app.sources.health.failAt);
    expect(headerLine(frame)).toContain("○ EC2 · stopped");
    expect(frame.split("\n")[2]).toContain("▲ The workstation is stopped");
    expect(frame.split("\n")[3]).toContain("Start it in AWS, then press u.");
    // A later Health read clears it.
    await pause(5);
    state.error = undefined;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    frame = t.captureCharFrame();
    expect(headerLine(frame)).toContain("● EC2");
    expect(frame).not.toContain("▲");
  } finally {
    await close(t, app);
  }
});

test("a spend read clears a signed-out band", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await pause(5);
    state.error = (args) =>
      args[0] === "spend"
        ? undefined
        : launcherFailure(AUTH_TEXT, "auth")(args);
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await pause(5);
    app.sources.spend.succeed(app.now());
    app.drawHeader();
    await t.renderOnce();
    expect(app.currentError()).toBeUndefined();
    expect(headerLine(t.captureCharFrame())).toContain("● EC2");
  } finally {
    await close(t, app);
  }
});

test("a component line in the list gives way to a global band and returns when it clears", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await pause(5);
    state.error = (args) =>
      args[0] === "--snapshot" ? new Error("ssh: unexpected reply") : undefined;
    await app.refreshSessions();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("▲ Sessions read failed");
    // A Health failure of the whole link follows; no list redraw is asked for.
    state.error = (args) =>
      args[0] === "--snapshot"
        ? new Error("ssh: unexpected reply")
        : launcherFailure(AUTH_TEXT, "auth")(args);
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    let frame = t.captureCharFrame();
    expect(frame).toContain("▲ AWS sign-in expired");
    expect(frame).not.toContain("▲ Sessions read failed");
    // The link works again through Health; the sessions read still fails for its own reason.
    await pause(5);
    state.error = (args) =>
      args[0] === "--snapshot" ? new Error("ssh: unexpected reply") : undefined;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    frame = t.captureCharFrame();
    expect(frame).not.toContain("▲ AWS sign-in expired");
    expect(frame).toContain("▲ Sessions read failed");
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
    expect(lines[3]).toContain("Fix it outside the app");
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

const timeout = (args: string[]) =>
  new LauncherError(
    "The launcher exceeded 90 seconds.",
    args[0],
    "timeout",
    null,
    "",
  );
const notInstalled = (args: string[]) =>
  new LauncherError(
    "Launcher could not start: spawn tokiwa ENOENT",
    args[0],
    "spawn",
    null,
    "spawn tokiwa ENOENT",
  );

test("a success from the timer recovers without a sign-in view", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await pause(5);
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.refreshSessions();
    expect(app.currentError()?.kind).toBe("signed-out");
    state.error = undefined;
    const reads = state.commands.length;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await until(() =>
      state.commands.slice(reads).some((c) => c[0] === "--snapshot"),
    );
    await until(() => !app.currentError());
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("▲");
    expect(app.shells).toHaveLength(0);
  } finally {
    await close(t, app);
  }
});

test("after an offline failure, a Health success starts a session read", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await pause(5);
    state.error = timeout;
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.currentError()?.kind).toBe("offline");
    await pause(5);
    state.error = (args) => (args[0] === "health" ? undefined : timeout(args));
    const reads = state.commands.length;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await until(() =>
      state.commands.slice(reads).some((c) => c[0] === "--snapshot"),
    );
  } finally {
    await close(t, app);
  }
});

test("u resets the spend timer when spend is not live", async () => {
  const { t, app, state } = await open(undefined);
  try {
    let spends = 0;
    state.error = (args) => {
      if (args[0] !== "spend") return undefined;
      spends++;
      return new Error("Launcher spend exited 1: boom");
    };
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(spends).toBe(1);
    expect(app.sources.spend.freshness(app.now())).not.toBe("live");
    await t.mockInput.typeText("u");
    await pause();
    // The next Health read reads spend again, without a wait for the spend timer.
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(spends).toBe(2);
    clearTimeout(app.sampleTimer);
  } finally {
    await close(t, app);
  }
});

test("a failure notice clears when the same action succeeds on a retry", async () => {
  const { t, app } = await open(undefined);
  try {
    app.actionFailed("attach worker-c", new Error("no route"));
    expect(app.footerNotice?.failed).toBe(true);
    app.actionSucceeded("create other");
    expect(app.footerNotice).toBeDefined();
    app.actionSucceeded("attach worker-c");
    expect(app.footerNotice).toBeUndefined();
  } finally {
    await close(t, app);
  }
});

test("the header word comes from connectivity even when a setup failure is also active", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await pause(5);
    state.error = (args) =>
      args[0] === "--snapshot" ? notInstalled(args) : timeout(args);
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await t.renderOnce();
    const frame = t.captureCharFrame();
    expect(app.currentError()?.kind).toBe("setup");
    expect(headerLine(frame)).toContain("○ EC2 · offline");
    expect(frame).toContain("▲ The launcher is not installed");
  } finally {
    await close(t, app);
  }
});

test("the Health footer offers the sign-in key while signed out", async () => {
  const { t, app } = await open(EXPIRED);
  try {
    app.show("health");
    await pause();
    await t.renderOnce();
    const footer = t
      .captureCharFrame()
      .split("\n")
      .filter((l) => l.trim())
      .at(-1)!;
    expect(footer.trimStart()).toStartWith("l sign in · w sessions");
  } finally {
    await close(t, app);
  }
});

test("an empty list does not repeat a recovery path that another line names", async () => {
  const component = await open(
    "Launcher --snapshot exited 255: ssh: unexpected reply",
  );
  try {
    const frame = component.t.captureCharFrame();
    expect(frame).toContain("u retry · e details");
    expect(frame).toContain("No sessions read");
    expect(frame).not.toContain("u reads them again");
  } finally {
    await close(component.t, component.app);
  }
  const setup = await open(undefined);
  try {
    setup.state.error = notInstalled;
    await setup.app.refreshSessions();
    setup.app.remoteSessions = [];
    setup.app.drawSessions();
    await setup.t.renderOnce();
    const frame = setup.t.captureCharFrame();
    expect(frame).toContain("No sessions read");
    expect(frame).not.toContain("u reads them again");
    setup.app.toggleDetails();
    await setup.t.renderOnce();
    const details = setup.t.captureCharFrame();
    expect(details).not.toContain("then press u");
    expect(details).toContain("Fix it outside the app");
  } finally {
    await close(setup.t, setup.app);
  }
  const offline = await open(undefined);
  try {
    offline.state.error = timeout;
    await offline.app.refreshSessions();
    offline.app.remoteSessions = [];
    offline.app.drawSessions();
    await offline.t.renderOnce();
    expect(offline.t.captureCharFrame()).toContain("u reads them again");
  } finally {
    await close(offline.t, offline.app);
  }
});

test("a stale row that needs you draws its glyph and word dim, not amber", async () => {
  const start = new Date(2026, 10, 13, 21, 20).getTime();
  let clock = start;
  const { t, app, state } = await open(undefined, "exit 0", () => clock);
  try {
    app.drawSessions();
    const live = app.listGlyphs.find((g) => g.state === "needs-you")!;
    expect(live).toBeDefined();
    expect(String(live.text.fg)).toBe(String(RGBA.fromHex(theme.warning)));
    clock = start + 41 * 3600_000;
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.refreshSessions();
    app.drawSessions();
    await t.renderOnce();
    const stale = app.listGlyphs.find((g) => g.state === "needs-you")!;
    expect(stale).toBeDefined();
    expect(String(stale.text.fg)).toBe(String(RGBA.fromHex(theme.muted)));
    expect(t.captureCharFrame()).toContain("◈");
  } finally {
    await close(t, app);
  }
});

test("a spend success while the workstation is stopped keeps the details and the cause notice", async () => {
  const { t, app, state } = await open(undefined);
  try {
    await pause(5);
    state.error = (args) =>
      args[0] === "spend"
        ? undefined
        : new Error("The host is stopped. No restart was requested.");
    await app.refreshSessions();
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(app.currentError()?.kind).toBe("stopped");
    await t.mockInput.typeText("e");
    await pause();
    expect(app.detailsOpen).toBe(true);
    app.notify("Start failed", true, undefined, 8000);
    app.footerNotice!.cause = true;
    const before = state.commands.length;
    await pause(5);
    app.readSucceeded("spend");
    await pause();
    expect(app.currentError()?.kind).toBe("stopped");
    expect(app.detailsOpen).toBe(true);
    expect(app.footerNotice?.cause).toBe(true);
    expect(state.commands.length).toBe(before);
  } finally {
    await close(t, app);
  }
});

test("a project title keeps last known during a session read while the data is stale from a failure", async () => {
  const start = new Date(2026, 10, 13, 21, 20).getTime();
  let clock = start;
  const { t, app, state } = await open(undefined, "exit 0", () => clock);
  try {
    clock = start + 60_000;
    state.error = launcherFailure(AUTH_TEXT, "auth");
    await app.refreshSessions();
    // A read that has not returned yet.
    app.sessionsLoading = true;
    app.drawSessions();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("· last known");
    // Stale by age only: the read in progress hides the mark.
    app.sessionsLoading = false;
    state.error = undefined;
    await app.refreshSessions();
    clock = start + 5 * 60_000;
    app.sessionsLoading = true;
    app.drawSessions();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("· last known");
  } finally {
    app.sessionsLoading = false;
    await close(t, app);
  }
});

test("at 62 columns the second band row keeps the age whole and cuts no word", async () => {
  const start = new Date(2026, 10, 13, 21, 20).getTime();
  const cases: [ProblemKind, (a: string[]) => Error | undefined, number][] = [
    ["signed-out", launcherFailure(AUTH_TEXT, "auth"), 41 * 3600_000],
    [
      "offline",
      (args) =>
        new LauncherError(
          "The launcher exceeded 90 seconds.",
          args[0],
          "timeout",
          null,
          "",
        ),
      6 * 60_000,
    ],
    [
      "stopped",
      () =>
        new Error(
          "Launcher --snapshot exited 1: Tokiwa: The host is stopped. No restart was requested.",
        ),
      6 * 60_000,
    ],
  ];
  for (const [kind, error, later] of cases) {
    let clock = start;
    const { t, app, state } = await open(undefined, "exit 0", () => clock, 62);
    try {
      clock = start + later;
      state.error = error;
      await app.refreshSessions();
      await app.sampleHealth();
      clearTimeout(app.sampleTimer);
      await t.renderOnce();
      expect(app.currentError()?.kind).toBe(kind);
      const sub = t.captureCharFrame().split("\n")[3];
      expect(sub).not.toContain("...");
      expect(sub).not.toContain("…");
      expect(sub).toMatch(/ · \d+(m|h) ago\./);
    } finally {
      await close(t, app);
    }
  }
});

test("the footer offers u retry only in the view whose source failed", async () => {
  const footer = (frame: string) => {
    const lines = frame.split("\n").filter((l) => l.trim());
    return lines.at(-1)!;
  };
  for (const failing of ["health", "sessions"] as const) {
    const { t, app, state } = await open(undefined);
    try {
      state.error = (args) =>
        (failing === "health" ? args[0] === "health" : args[0] === "--snapshot")
          ? new Error(
              "Launcher " + args[0] + " exited 255: ssh: unexpected reply",
            )
          : undefined;
      await app.refreshSessions();
      await app.sampleHealth();
      clearTimeout(app.sampleTimer);
      expect(app.currentError()?.scope).toBe("component");
      const frames = {} as Record<"health" | "sessions", string>;
      for (const view of ["health", "sessions"] as const) {
        if (view === "health") app.show("health");
        else app.show("shell");
        app.drawFooter();
        await pause();
        await t.renderOnce();
        frames[view] = footer(t.captureCharFrame());
      }
      for (const view of ["health", "sessions"] as const) {
        if (view === failing) expect(frames[view]).toContain("u retry");
        else expect(frames[view]).not.toContain("u retry");
      }
    } finally {
      await close(t, app);
    }
  }
});

/** The colour of the first `◈` in styled content, or undefined when there is none. */
function glyphColour(content: any) {
  const chunk = content.chunks.find((c: any) => c.text.includes("◈"));
  return chunk && String(chunk.fg);
}

/** Open a stale snapshot (41 hours old) after a live one; the clock is the test's. */
async function staleOpen() {
  const start = new Date(2026, 10, 13, 21, 20).getTime();
  let clock = start;
  const opened = await open(undefined, "exit 0", () => clock);
  const stale = async () => {
    clock = start + 41 * 3600_000;
    opened.state.error = launcherFailure(AUTH_TEXT, "auth");
    await opened.app.refreshSessions();
    opened.app.drawSessions();
    await opened.t.renderOnce();
  };
  opened.app.drawSessions();
  return { ...opened, stale };
}

test("the footer legend draws the needs-you glyph amber while live and dim when stale", async () => {
  const { t, app, stale } = await staleOpen();
  try {
    const row = app.sessionRows().find((r: any) => app.rowStatus(r).state === "needs-you")!;
    expect(row).toBeDefined();
    const colour = () => {
      app.hover = `row:${row.name}`;
      app.footerSignature = "";
      app.drawFooter();
      const part: any = app.footer.getChildren().find((c) => c.id === "footer-state")!;
      return glyphColour(part.content);
    };
    expect(colour()).toBe(String(RGBA.fromHex(theme.warning)));
    await stale();
    expect(app.rowStatus(app.sessionRows().find((r: any) => r.name === row.name)!).state).toBe("needs-you");
    expect(colour()).toBe(String(RGBA.fromHex(theme.muted)));
  } finally {
    await close(t, app);
  }
});

test("the focus strip draws the needs-you glyph amber while live and dim when stale", async () => {
  const { t, app, stale } = await staleOpen();
  try {
    app.focusMode = true;
    app.view = "shell";
    const colour = () => {
      // A stale read opens the list; the owner can hide it again, and the strip then shows.
      app.sessionList.visible = false;
      app.drawNavStatus();
      return glyphColour(app.navStatus.content);
    };
    expect(colour()).toBe(String(RGBA.fromHex(theme.warning)));
    await stale();
    expect(colour()).toBe(String(RGBA.fromHex(theme.muted)));
  } finally {
    await close(t, app);
  }
});
