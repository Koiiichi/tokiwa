/** Capture the Health view as text with the test renderer and the fixed fixture reading. */
import { createTestRenderer } from "@opentui/core/testing";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { App } from "./app";
import {
  fixtureConfig,
  fixtureNow,
  fixtureSample,
  fixtureSpend,
} from "./health-fixture";

export const captureSizes = [
  [156, 40],
  [100, 30],
  [62, 24],
] as const;

export async function captureHealth(width: number, height: number) {
  const t = await createTestRenderer({ width, height });
  const app = new App(t.renderer, {
    spawn: false,
    now: () => fixtureNow,
    healthConfig: "/nonexistent/health.json",
  });
  app.healthConfig = fixtureConfig;
  try {
    app.history.samples.push(fixtureSample);
    app.history.attempts = 1;
    app.spend = fixtureSpend;
    app.show("health");
    app.hostOk = fixtureNow;
    app.drawHeader();
    app.drawFooter();
    app.drawHealth();
    await t.renderOnce();
    return t.captureCharFrame();
  } finally {
    await t.dispose();
  }
}

if (import.meta.main) {
  // The same folder as Save screen in the app.
  const out = join(
    process.env.TOKIWA_CAPTURE_DIR ??
      join(homedir(), ".local", "state", "tokiwa", "captures"),
    "health-usage",
  );
  mkdirSync(out, { recursive: true });
  for (const [width, height] of captureSizes) {
    const frame = await captureHealth(width, height);
    writeFileSync(join(out, `health-${width}x${height}.txt`), frame);
    console.log(`health-${width}x${height}.txt`);
  }
}
