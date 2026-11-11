import { test, expect } from "bun:test";
import { captureScene } from "./review-capture";
import { captureHealth, captureSizes } from "./health-capture";

test("landing, focus, shortcuts and search captures stay readable at 156x40, 100x30 and 62x24", async () => {
  for (const [width, height] of captureSizes) {
    const landing = await captureScene("landing", width, height);
    for (const text of [
      "service-a-wt/fix-pr",
      "◈ coder-lead   needs you",
      // The session in the pane has the bar, or the selection marker while the list has focus.
      width < 100 ? "› ◆ web-lead" : "▎ ◆ web-lead",
      "workspaces/workbench",
      "◇ claude-test",
      "· nightly      exited",
      "○ setup        disconnected",
      "◆ setup2",
      "◇ tools¹",
      "● EC2",
    ])
      expect(landing).toContain(text);
    // No session name is shortened at these sizes, and the top bar carries no status.
    expect(landing).not.toContain("…");
    expect(landing.split("\n")[2].trim()).toBe("Workspace  Health");
    const focus = await captureScene("focus", width, height);
    // The strip names only the sessions that need you; output and quiet sessions are left out.
    expect(focus.split("\n")[2].trimEnd()).toMatch(/Health +◈ coder-lead$/);
    expect(focus).toContain("fixture terminal of web-lead");
    expect(focus).not.toContain("workspaces/workbench");
    const sheet = await captureScene("shortcuts", width, height);
    for (const text of [
      "Keyboard shortcuts",
      "Workspace",
      "Session",
      "Quit",
      "z  Focus",
    ])
      expect(sheet).toContain(text);
    // The Status group is a column of the sheet like the key groups; at 62x24 the sheet scrolls.
    if (width >= 100)
      for (const text of ["Status", "◆  output", "◈  needs you"])
        expect(sheet).toContain(text);
    const search = await captureScene("search", width, height);
    expect(search).toContain("setup2");
    expect(search).toContain("Refresh sessions");
    for (const frame of [landing, focus, sheet, search])
      for (const line of frame.split("\n"))
        expect(line.length).toBeLessThanOrEqual(width);
  }
}, 30000);

test("footer, search and hover captures stay readable at 156x40, 100x30 and 62x24", async () => {
  for (const [width, height] of captureSizes) {
    const last = (frame: string) => frame.split("\n").at(-2)!.trim();
    const terminal = await captureScene("terminal", width, height);
    expect(last(terminal)).toBe(
      width < 100
        ? "detach · focus · sessions · shortcuts"
        : "detach ctrl+k d · focus ctrl+k z · sessions ctrl+k w · shortcuts ctrl+k ?",
    );
    const list = await captureScene("list", width, height);
    expect(last(list)).toBe(
      width < 100
        ? "enter attach · esc terminal · z focus · ? shortcuts"
        : "↑↓ select · enter attach · esc terminal · z focus · ? shortcuts",
    );
    expect(list).not.toContain("what these mean");
    const empty = await captureScene("search-empty", width, height);
    for (const text of [
      "› Search sessions and actions",
      "Session ───",
      "Go to ───",
      "Terminal ───",
      "Tokiwa ───",
      "Quit",
    ])
      expect(empty).toContain(text);
    expect(empty).not.toContain("coder-lead");
    const typed = await captureScene("search", width, height);
    expect(typed).toContain("Sessions ───");
    expect(typed.indexOf("setup2")).toBeLessThan(typed.indexOf("Refresh"));
    const hover = await captureScene("hover", width, height);
    expect(last(hover)).toBe(
      width < 100
        ? "◈ needs you · coder-lead is waiting for a person"
        : "◈ needs you · coder-lead asked for a person, or rang the bell while no client viewed it",
    );
    const health = await captureHealth(width, height);
    expect(health).toContain("Spent so far:");
    for (const frame of [terminal, list, empty, typed, hover, health])
      for (const line of frame.split("\n"))
        expect(line.length).toBeLessThanOrEqual(width);
  }
}, 60000);
