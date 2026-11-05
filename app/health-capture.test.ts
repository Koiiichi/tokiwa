import { test, expect } from "bun:test";
import { captureHealth, captureSizes } from "./health-capture";

const bar = (frame: string, label: string) =>
  (
    frame.split("\n").find((line) => line.trimStart().startsWith(label)) ?? ""
  ).replace(/[^━╸]/g, "").length;

test("Health text captures stay readable at 156x40, 100x30 and 62x24", async () => {
  const frames = new Map<number, string>();
  for (const [width, height] of captureSizes) {
    const frame = await captureHealth(width, height);
    frames.set(width, frame);
    for (const text of [
      "Workstation",
      "Authorization:",
      "Spend (estimate)",
      "Spent so far:   $110.91 of $350 budget",
      "Forecast:       $254.03 by Dec 22 · 73% of budget",
      "Month to date:  $110.91",
      "Workbench limits",
      "Memory",
    ])
      expect(frame).toContain(text);
    expect(frame).not.toContain("…");
  }
  // The fixed sample fits at the two larger sizes; the smallest scrolls.
  for (const width of [156, 100])
    for (const text of ["State disk", "Received:", "Sampled"])
      expect(frames.get(width)).toContain(text);
  expect(frames.get(62)).toContain("↑↓ scroll");
  expect(bar(frames.get(62)!, "Memory")).toBeLessThan(
    bar(frames.get(156)!, "Memory"),
  );
});
