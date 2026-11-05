/**
 * Capture the landing view, focus mode, the shortcuts sheet, the search and the footer in each
 * context as text with the test renderer and the fixed session snapshots.
 */
import { createTestRenderer } from "@opentui/core/testing";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { App } from "./app";
import { BackendClient } from "./backend";
import { captureSizes } from "./health-capture";
import { fixtureNow } from "./health-fixture";
import { landingPrevious, landingSessions } from "./landing-fixture";

export type Scene =
  | "landing"
  | "focus"
  | "shortcuts"
  | "search"
  | "terminal"
  | "list"
  | "search-empty"
  | "hover";
/** The scenes of the mouse and quick-key review: the footer, the search and the row hover. */
export const controlScenes = [
  "terminal",
  "list",
  "search-empty",
  "search",
  "hover",
] as const;

// The terminal of the attached session. Every line is invented.
const paneText = [
  "fixture terminal of web-lead",
  "",
  "every line in this pane is invented for the capture",
];

/**
 * Render one scene. The backend answers two snapshot reads, so the list shows observed activity.
 * The landing and focus scenes attach two sessions with local stand-in transports: web-lead,
 * which stays in the pane, and setup, whose transport ends, so it shows as disconnected.
 */
export async function captureScene(
  scene: Scene,
  width: number,
  height: number,
) {
  const t = await createTestRenderer({ width, height });
  const reads = [landingPrevious, landingSessions];
  const backend = new BackendClient("/fixture/tokiwa", async () =>
    JSON.stringify({ sessions: reads.shift() ?? landingSessions }),
  );
  backend.attachCommand = (ref) =>
    ref.name === "setup"
      ? ["/bin/sh", "-c", "exit 0"]
      : [
          "/bin/sh",
          "-c",
          `printf '%s\\r\\n' ${paneText.map((l) => `'${l}'`).join(" ")}; exec sleep 30`,
        ];
  const app = new App(t.renderer, {
    spawn: false,
    backend,
    now: () => fixtureNow,
    device: "mac",
    healthConfig: "/nonexistent/health.json",
  });
  // A still frame: the output glyph does not throb.
  app.animate = false;
  const until = async (done: () => boolean) => {
    for (let i = 0; i < 100 && !done(); i++) await Bun.sleep(20);
  };
  try {
    await app.refreshSessions();
    await app.refreshSessions();
    const attached = ["landing", "focus", "terminal", "list", "search-empty"];
    if (attached.includes(scene)) {
      const ref = (name: string) =>
        landingSessions.find((s) => s.name === name)!;
      await app.attachRemote("setup", ref("setup").identity);
      await until(() => app.shells[0]?.exited);
      await app.attachRemote("web-lead", ref("web-lead").identity);
      const shell = app.shells[1];
      await until(() => shell.lastOutput > 0);
      await t.renderOnce();
      // The session in the pane shows output.
      shell.lastOutput = Date.now();
      if (scene === "focus") app.toggleFocus();
      // The list has the keyboard, on the row of the session in the pane.
      else if (scene === "list") app.focusSessions();
      // The terminal in the pane has the keyboard, as after an attach from the list.
      else if (scene === "terminal" || scene === "search-empty") {
        app.listFocused = false;
        app.show("shell");
      }
      // Below 100 columns the list and the terminal take the width in turn: show the list.
      else if (scene === "landing" && width < 100) app.focusSessions();
      app.updateActivity();
    } else app.focusSessions();
    if (scene === "shortcuts") app.openSheet();
    if (scene === "search-empty") app.openPalette();
    if (scene === "hover") {
      // The pointer rests on the row of coder-lead, which rang the bell.
      await t.renderOnce();
      const frame = t.captureCharFrame().split("\n");
      const y = frame.findIndex((line) => line.includes(" coder-lead"));
      await t.mockMouse.moveTo(frame[y].indexOf("coder-lead") + 2, y);
    }
    if (scene === "search") {
      app.openPalette();
      await t.mockInput.typeText("se");
      await Bun.sleep(20);
    }
    await t.renderOnce();
    await t.renderOnce();
    return t.captureCharFrame();
  } finally {
    const children = app.shells.map((s) => s.child.exited);
    await t.dispose();
    await Promise.all(children);
  }
}

if (import.meta.main) {
  // `bun review-capture.ts opentui-mouse-quickkeys` writes the scenes of that review.
  const review = process.argv[2] ?? "opentui-indicators-focus";
  const scenes =
    review === "opentui-mouse-quickkeys"
      ? controlScenes
      : (["landing", "focus", "shortcuts", "search"] as const);
  // The same folder as Save screen in the app.
  const out = join(
    process.env.TOKIWA_CAPTURE_DIR ??
      join(homedir(), ".local", "state", "tokiwa", "captures"),
    review,
  );
  mkdirSync(out, { recursive: true });
  for (const [width, height] of captureSizes) {
    for (const scene of scenes) {
      const name = `${scene}-${width}x${height}.txt`;
      writeFileSync(join(out, name), await captureScene(scene, width, height));
      console.log(name);
    }
  }
}
