import { test, expect } from "bun:test";
import { createTestRenderer } from "@opentui/core/testing";
import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ImageRenderable } from "@opentui/core";
import { App, launch, runOptions } from "./app";
import { fixtureNow, fixtureSample, fixtureSpend } from "./health-fixture";

const scratch = () => mkdtempSync(join(tmpdir(), "health-app-"));
const fresh = () => ({ ...fixtureSample, sampled_at: Date.now() / 1000 });

test("Health shows text sections and no image", async () => {
  const t = await createTestRenderer({ width: 100, height: 40 });
  const app = new App(t.renderer, {
    spawn: false,
    now: () => fixtureNow,
    healthConfig: "/nonexistent/health.json",
  });
  try {
    app.history.load(fixtureSample);
    app.spend = fixtureSpend;
    app.drawHealth();
    await t.renderOnce();
    const frame = t.captureCharFrame();
    for (const text of [
      "Workstation",
      "Spend (estimate)",
      "Workbench limits",
      "25% of 6 cores",
      "Storage",
      "Network · ens5",
      "Sampled",
    ])
      expect(frame).toContain(text);
    const images: unknown[] = [];
    const walk = (node: any) => {
      if (node instanceof ImageRenderable) images.push(node);
      node.getChildren?.().forEach(walk);
    };
    walk(app.health);
    expect(images).toHaveLength(0);
  } finally {
    await t.dispose();
  }
});

test("an invalid configuration file shows its error line", async () => {
  const path = join(scratch(), "health.json");
  writeFileSync(path, '{"budget_usd": "many"}');
  const t = await createTestRenderer({ width: 100, height: 40 });
  const app = new App(t.renderer, { spawn: false, healthConfig: path });
  try {
    app.drawHealth();
    await t.renderOnce();
    const frame = t.captureCharFrame().replace(/\s+/g, " ");
    expect(frame).toContain(
      "health.json: budget_usd must be a positive number",
    );
  } finally {
    await t.dispose();
  }
});

test("a recorded snapshot loads into Health and does not sample", async () => {
  const path = join(scratch(), "sample.json");
  writeFileSync(path, JSON.stringify(fixtureSample));
  const t = await createTestRenderer({ width: 100, height: 30 });
  const app = new App(t.renderer, { spawn: false, snapshot: path });
  let calls = 0;
  app.backend.health = async () => {
    calls++;
    return fresh();
  };
  try {
    launch(app);
    await Bun.sleep(20);
    expect(calls).toBe(0);
    expect(app.history.status()).toBe("recorded");
    expect(app.history.samples[0].sampled_at).toBe(fixtureSample.sampled_at);
  } finally {
    await t.dispose();
  }
});

test("launch samples Health by default and sets no deadline", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  let health = 0;
  let spend = 0;
  app.backend.health = async () => {
    health++;
    return fresh();
  };
  app.backend.spend = async () => {
    spend++;
    return fixtureSpend;
  };
  try {
    expect(launch(app)).toBeUndefined();
    await Bun.sleep(50);
    expect(health).toBe(1);
    expect(spend).toBe(1);
    expect(app.sampleTimer).toBeDefined();
  } finally {
    await t.dispose();
  }
  expect(app.history.stopped).toBe(true);
});

test("a proof deadline closes the app", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  app.backend.health = async () => fresh();
  app.backend.spend = async () => fixtureSpend;
  let closed = false;
  app.close = () => {
    closed = true;
  };
  try {
    expect(launch(app, 0.001)).toBeDefined();
    await Bun.sleep(150);
    expect(closed).toBe(true);
  } finally {
    await t.dispose();
  }
});

test("options accept --live-health as a no-op and validate --deadline", () => {
  expect(runOptions(["--live-health"])).toEqual({
    layout: "workspace",
    remote: undefined,
    receipt: undefined,
    deadline: undefined,
  });
  expect(
    runOptions(["--deadline", "45", "--layout", "terminal"]).deadline,
  ).toBe(45);
  for (const value of ["0", "-1", "x", "", "100000"])
    expect(() => runOptions(["--deadline", value])).toThrow("--deadline");
  expect(runOptions(["--snapshot", "/tmp/reading.json"]).snapshot).toBe(
    "/tmp/reading.json",
  );
  expect(() => runOptions(["--snapshot", ""])).toThrow("--snapshot");
});

test("Health sampling reads spend once per interval", async () => {
  const t = await createTestRenderer({ width: 80, height: 24 });
  const app = new App(t.renderer, { spawn: false });
  let spend = 0;
  app.backend.health = async () => fresh();
  app.backend.spend = async () => {
    spend++;
    return fixtureSpend;
  };
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    await Bun.sleep(5);
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    expect(spend).toBe(1);
    expect(app.history.samples).toHaveLength(2);
    expect(app.history.error).toBe("");
  } finally {
    await t.dispose();
  }
});

test("a failed spend read shows its reason and the launcher age", async () => {
  const t = await createTestRenderer({ width: 100, height: 40 });
  const app = new App(t.renderer, { spawn: false });
  app.backend.health = async () => fresh();
  app.backend.spend = async () => {
    throw new Error("Launcher spend exited 2: Usage: tokiwa [dashboard]");
  };
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.drawHealth();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain(
      "not available (the launcher has no spend command",
    );
  } finally {
    await t.dispose();
  }
});

test("arrow keys scroll Health when it does not fit", async () => {
  const t = await createTestRenderer({ width: 62, height: 24 });
  const app = new App(t.renderer, {
    spawn: false,
    now: () => fixtureNow,
  });
  try {
    app.history.load(fixtureSample);
    app.spend = fixtureSpend;
    app.show("health");
    app.drawHealth();
    await t.renderOnce();
    expect(t.captureCharFrame()).toContain("scroll");
    const before = app.healthScroll.scrollTop;
    t.mockInput.pressArrow("down");
    await t.renderOnce();
    expect(app.healthScroll.scrollTop).toBeGreaterThan(before);
  } finally {
    await t.dispose();
  }
});

test("only a failed read is reported as a failed read", async () => {
  const t = await createTestRenderer({ width: 100, height: 40 });
  const app = new App(t.renderer, { spawn: false });
  let fail = false;
  app.backend.health = async () => {
    if (fail) throw new Error("offline");
    return { ...fresh(), errors: ["Containers limits: OSError"] };
  };
  app.backend.spend = async () => fixtureSpend;
  try {
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.drawHealth();
    await t.renderOnce();
    expect(t.captureCharFrame()).not.toContain("Last read failed");
    fail = true;
    await app.sampleHealth();
    clearTimeout(app.sampleTimer);
    app.drawHealth();
    await t.renderOnce();
    // The band under the header names the failed read; the readings stay and are stale.
    const frame = t.captureCharFrame();
    expect(frame).toContain("▲ offline.");
    expect(frame).toContain("· stale");
    expect(frame).not.toContain("Last read failed");
  } finally {
    await t.dispose();
  }
});
