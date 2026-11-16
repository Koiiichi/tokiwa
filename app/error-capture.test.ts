import { test, expect } from "bun:test";
import { captureSizes } from "./health-capture";
import { captureErrorScene } from "./error-capture";

const AUTH = "AWS authentication failed";
const count = (text: string, part: string) => text.split(part).length - 1;
const header = (frame: string) => frame.split("\n")[0];
const navIndex = (lines: string[]) =>
  lines.findIndex((l) => l.trim() === "Workspace  Health");

for (const [width, height] of captureSizes) {
  const size = `${width}x${height}`;

  test(`the four error states draw as designed at ${size}`, async () => {
    const draw = (
      scene: Parameters<typeof captureErrorScene>[0],
      view: "workspace" | "health",
    ) => captureErrorScene(scene, view, width, height);
    const frames: string[] = [];

    const authWork = await draw("auth-expired", "workspace");
    frames.push(authWork);
    for (const part of [
      "○ EC2 · signed out",
      "▲ AWS sign-in expired",
      "l sign in · e details",
      // The 62-column band shortens this line in the middle (see the task report).
      width < 70
        ? "Live status unavailable."
        : "Live status unavailable. Last synced",
      "· 41h ago",
      "project-a · last known",
      "◈ worker-b",
    ])
      expect(authWork).toContain(part);
    expect(
      authWork.split("\n").some((l) => l.trim() === "Workspace  Health"),
    ).toBe(true);
    for (const part of [
      "Launcher",
      "Error:",
      "tokiwa-error",
      "◆",
      "not available",
    ])
      expect(authWork).not.toContain(part);
    expect(count(authWork, AUTH)).toBe(0);

    const authHealth = await draw("auth-expired", "health");
    frames.push(authHealth);
    expect(authHealth).toContain("Workbench limits · last known");
    expect(authHealth).toContain("Spend (estimate · last known)");
    expect(authHealth).not.toContain("not available");
    for (const frame of [authWork, authHealth]) {
      expect(frame).not.toContain("stopped");
      expect(frame).not.toContain("not ready");
    }
    // The "Sampled" line is the footer of the view. A short window drops it.
    const sampled = authHealth
      .split("\n")
      .find((l) => l.trim().startsWith("Sampled"));
    if (height >= 40) expect(sampled).toBeDefined();
    if (sampled) expect(sampled).toContain("· last known");

    const net = await draw("network-failure", "workspace");
    const netHealth = await draw("network-failure", "health");
    frames.push(net, netHealth);
    for (const frame of [net, netHealth]) {
      expect(frame).not.toContain("stopped");
      expect(frame).not.toContain("not ready");
    }
    for (const part of [
      "○ EC2 · offline",
      "▲ AWS cannot be reached from this Mac",
      "u retry · e details",
      "Retrying every 30 s",
      "project-a · last known",
    ])
      expect(net).toContain(part);
    expect(net).not.toContain("signed out");
    expect(net).not.toContain("sign in");

    const compHealth = await draw("component-failure", "health");
    frames.push(compHealth);
    expect(header(compHealth)).toContain("● EC2");
    const lines = compHealth.split("\n");
    const nav = navIndex(lines);
    expect(nav).toBeGreaterThan(0);
    expect(lines.slice(0, nav).join("\n")).not.toContain("▲");
    expect(compHealth).toContain(
      "▲ Health read failed: the health response is invalid",
    );
    expect(compHealth).toContain("Workbench limits · last known");
    const compWork = await draw("component-failure", "workspace");
    frames.push(compWork);
    expect(header(compWork)).toContain("● EC2");
    expect(compWork).not.toContain("▲");
    expect(compWork).not.toContain("last known");

    const recWork = await draw("recovery", "workspace");
    frames.push(recWork);
    expect(header(recWork)).toContain("● EC2");
    expect(recWork).not.toContain("▲");
    expect(recWork).not.toContain("last known");
    expect(recWork).not.toContain("◆");
    const recHealth = await draw("recovery", "health");
    frames.push(recHealth);
    expect(recHealth).toContain("Workbench limits · last known");
    expect(recHealth).not.toContain("▲");

    for (const frame of frames) {
      for (const line of frame.split("\n"))
        expect(line.trimEnd().length).toBeLessThanOrEqual(width);
      expect(frame).not.toMatch(/worker-\w*…/);
    }
  });
}
