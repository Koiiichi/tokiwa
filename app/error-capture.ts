/**
 * Capture the four error states (an expired sign-in, a network failure, a failed component and a
 * recovery) as text with the test renderer and a fake backend. Every name and value is invented.
 */
import { createTestRenderer } from "@opentui/core/testing";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { App } from "./app";
import { BackendClient, LauncherError, type SessionRef } from "./backend";
import { captureSizes } from "./health-capture";
import {
  fixtureConfig,
  fixtureNow,
  fixtureSample,
  fixtureSpend,
} from "./health-fixture";

export type ErrorScene =
  "auth-expired" | "network-failure" | "component-failure" | "recovery";
export const errorScenes: ErrorScene[] = [
  "auth-expired",
  "network-failure",
  "component-failure",
  "recovery",
];

const HOUR = 3_600_000;
const AUTH_TEXT =
  "Tokiwa: AWS authentication failed. Run aws sso login --profile profile-a.";
const NET_TEXT =
  "Tokiwa: AWS cannot be reached from this Mac. Check the network, then retry.";
const screen = (seed: string) => seed.repeat(64).slice(0, 64);
const session = (
  name: string,
  project: string,
  id: number,
  bell = false,
): SessionRef => ({
  name,
  identity: `${1000 + id}:$${id}:${1767000000 + id}`,
  cwd: project,
  project,
  clients: 0,
  activity: [
    {
      pane: `%${id}`,
      dead: false,
      command: "node",
      screen: screen(String(id)),
    },
  ],
  bell,
});
const sessions = [
  session("worker-a", "project-a", 1),
  session("worker-b", "project-a", 2, true),
  session("worker-c", "project-a", 3),
  session("worker-d", "project-b", 4),
];
const failure = (
  command: string,
  text: string,
  category: "auth" | "unreachable",
) =>
  new LauncherError(
    `Launcher ${command} exited 1: ${text}`,
    command,
    "exit",
    1,
    text,
    category,
  );

/** The launcher's answers; `mode` changes after the clock jump. */
type Mode = "good" | "auth" | "network" | "health-invalid" | "snapshot-only";

/**
 * Render one scene. The app reads sessions twice, Health and spend once, all at the fixed start
 * time. The clock then jumps and the scene's failure begins. `recovery` follows the sign-in
 * scene with a good snapshot read while the Health read never returns.
 */
export async function captureErrorScene(
  scene: ErrorScene,
  view: "workspace" | "health",
  width: number,
  height: number,
): Promise<string> {
  const t = await createTestRenderer({ width, height });
  let clock = fixtureNow;
  let mode: Mode = "good";
  const backend = new BackendClient("/fixture/tokiwa", async (args) => {
    const command = String(args[0]);
    if (mode === "auth") throw failure(command, AUTH_TEXT, "auth");
    if (mode === "network") throw failure(command, NET_TEXT, "unreachable");
    if (command === "health") {
      if (mode === "health-invalid")
        throw new Error("The health response is invalid.");
      if (mode === "snapshot-only") return new Promise<string>(() => {});
      return JSON.stringify({ ...fixtureSample, sampled_at: clock / 1000 });
    }
    if (command === "spend") return JSON.stringify(fixtureSpend);
    return JSON.stringify({ sessions });
  });
  const app = new App(t.renderer, {
    spawn: false,
    backend,
    now: () => clock,
    probe: async () => 20,
    device: "mac-a",
    healthConfig: "/nonexistent/health.json",
  });
  app.animate = false;
  app.healthConfig = fixtureConfig;
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(20);
  };
  try {
    await app.refreshSessions();
    await app.refreshSessions();
    // The history checks a sample against the real time, so the good Health read is recorded
    // at the fixed start time instead of read through the launcher.
    app.history.samples.push({
      ...fixtureSample,
      sampled_at: fixtureNow / 1000,
    });
    app.history.attempts = 1;
    app.sources.health.succeed(fixtureNow);
    app.spend = await app.backend.spend();
    app.readSucceeded("spend");
    clock +=
      scene === "network-failure" || scene === "component-failure"
        ? 6 * 60_000
        : 41 * HOUR;
    const read = async () => {
      app.spendAt = 0;
      await app.refreshSessions();
      await app.sampleHealth();
      clearTimeout(app.sampleTimer);
    };
    if (scene === "auth-expired" || scene === "recovery") {
      mode = "auth";
      await read();
      await app.attachRemote("worker-c");
    } else if (scene === "network-failure") {
      mode = "network";
      await read();
    } else {
      mode = "health-invalid";
      await read();
    }
    if (scene === "recovery") {
      mode = "snapshot-only";
      app.recover();
      await until(() => !app.sources.sessions.failure);
      await Bun.sleep(60);
    }
    app.show(view === "health" ? "health" : "shell");
    app.drawHeader();
    app.drawFooter();
    app.drawProblem();
    if (view === "health") app.drawHealth();
    else app.drawSessions();
    await t.renderOnce();
    return t.captureCharFrame();
  } finally {
    await t.dispose();
  }
}

if (import.meta.main) {
  const out = join(
    process.env.TOKIWA_CAPTURE_DIR ??
      join(homedir(), ".local", "state", "tokiwa", "captures"),
    "error-states",
  );
  mkdirSync(out, { recursive: true });
  // The last-synced time is local time; a fixed zone keeps the saved frames the same everywhere.
  process.env.TZ = "UTC";
  for (const scene of errorScenes)
    for (const view of ["workspace", "health"] as const)
      for (const [width, height] of captureSizes) {
        const frame = await captureErrorScene(scene, view, width, height);
        const file = `${scene}-${view}-${width}x${height}.txt`;
        writeFileSync(join(out, file), frame);
        console.log(file);
      }
  process.exit(0);
}
